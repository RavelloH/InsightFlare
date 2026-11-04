import {
  caseWhen,
  compileD1Query,
  constant,
  D1StatementBudgetError,
  isNull,
  lowerLogicalPlan,
  project,
  sort,
  union,
} from "@/lib/db";
import type { AnyExpression } from "@/lib/db/query/expression";
import type { LogicalQueryNode } from "@/lib/db/query/plan";
import { ADVANCED_FILTER_MAX_ACTIVITIES } from "@/lib/edge/analytics/engine/advanced-filter-activity-plan";
import {
  EVENT_QUALIFICATION_CONTROL_OUTPUT,
  type EventQualificationPlan,
} from "@/lib/edge/analytics/engine/event-qualified-source-plan";
import {
  EVENT_RECORD_PAGE_OUTPUT_ID,
  type EventRecordPageOptions,
} from "@/lib/edge/analytics/engine/event-record-page-plan";
import { buildEventRecordPageQualificationPlan } from "@/lib/edge/analytics/engine/event-record-page-qualification-plan";
import type { LogicalOutput } from "@/lib/edge/analytics/engine/logical/plan";
import {
  type DeferredEventRecordsQualification,
  isDeferredEventQualification,
} from "@/lib/edge/analytics/providers/d1/internal/advanced-filter-execution";
import { AnalyticsLogicalToDbLowerer } from "@/lib/edge/analytics/providers/d1/internal/analytics-relational-lowering";
import type { AnalyticsDbRelation } from "@/lib/edge/analytics/providers/d1/internal/analytics-relational-storage";
import type { EventQualificationAdmissionPolicy } from "@/lib/edge/analytics/providers/d1/internal/lowering/event-summary-admission";
import { currentD1Operation } from "@/lib/edge/observability/logger";
import type { Env } from "@/lib/edge/types";

import { queryD1CompiledAll } from "./core";
import {
  type AdvancedCountSqlFallbackReason,
  type D1ReadDiagnostics,
} from "./diagnostics";
import {
  assertEventRecordPageOutputContract,
  EVENT_RECORD_PAGE_OUTPUT_TYPES,
} from "./event-record-page-output";
import {
  type QualificationCompatibilityField,
  qualificationCompatibilityFieldsFromNumeric,
} from "./qualification-compatibility";
import {
  decodeQualificationControl,
  judgeQualificationControl,
} from "./qualification-program-runtime";

export interface EventRecordsQualificationCompilationEvidence {
  readonly statementTag: string;
  readonly sql: string;
  readonly bindings: readonly unknown[];
  readonly sqlBytes: number;
  readonly bindingCount: number;
  readonly groupWidth: number;
  readonly sharedRelationCount: number;
  readonly rootKind: string;
  readonly physicalScanKinds: readonly string[];
  readonly logicalPlan: EventQualificationPlan["plan"];
  readonly compatibilityFields: readonly QualificationCompatibilityField[];
}

export type EventRecordsQualificationExecution =
  | {
      readonly kind: "executed";
      readonly rows: readonly Record<string, unknown>[];
      readonly evidence: EventRecordsQualificationCompilationEvidence;
    }
  | {
      readonly kind: "fallback";
      readonly fallbackReason: AdvancedCountSqlFallbackReason;
    }
  | {
      readonly kind: "unavailable";
      readonly fallbackReason: AdvancedCountSqlFallbackReason;
    };

const RECORD_FIELDS = Object.keys(EVENT_RECORD_PAGE_OUTPUT_TYPES);
const CONTROL_BASE_FIELDS = [
  "rawCount",
  "nullActivityIdCount",
  "siteIdentityMismatchCount",
  "entityKind",
  "invalidIdentityCount",
  "duplicateIdentityCount",
] as const;

function abortIfNeeded(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
}

function exactOutput(
  outputs: readonly LogicalOutput[],
  outputId: string,
): LogicalOutput {
  const matches = outputs.filter((output) => output.id === outputId);
  if (matches.length !== 1)
    throw new Error(`event_records_qualification_output:${outputId}`);
  return matches[0]!;
}

function exactRowKeys(
  row: Record<string, unknown>,
  expected: readonly string[],
): boolean {
  const actual = Object.keys(row).sort();
  const required = [...expected].sort();
  return (
    actual.length === required.length &&
    actual.every((key, index) => key === required[index])
  );
}

function scanKinds(root: LogicalQueryNode): string[] {
  const visited = new Set<LogicalQueryNode>();
  const kinds = new Set<string>();
  const pending: LogicalQueryNode[] = [root];
  while (pending.length > 0) {
    const node = pending.pop()!;
    if (visited.has(node)) continue;
    visited.add(node);
    if (node.kind === "scan") kinds.add(node.table.name);
    switch (node.kind) {
      case "scan":
      case "values-relation":
      case "json-scalar-array":
        break;
      case "filter":
      case "project":
      case "distinct":
      case "sort":
      case "limit":
      case "window":
      case "aggregate":
        pending.push(node.input.node);
        break;
      case "recursive-closure":
        pending.push(node.seed.node, node.candidates.node);
        break;
      case "join":
      case "semi-join":
      case "union":
        pending.push(node.left.node, node.right.node);
        break;
    }
  }
  return [...kinds].sort();
}

function controlNamesFor(qualification: EventQualificationPlan): string[] {
  const compatibilityFields = qualificationCompatibilityFieldsFromNumeric(
    qualification.numericCompatibilityFields,
  );
  return [
    ...CONTROL_BASE_FIELDS,
    ...compatibilityFields.map(({ outputName }) => outputName),
  ];
}

function verifyQualificationPlan(
  qualification: EventQualificationPlan,
  deferred: DeferredEventRecordsQualification,
): {
  readonly reportOutput: LogicalOutput;
  readonly controlsOutput: LogicalOutput;
  readonly controlNames: readonly string[];
  readonly compatibilityFields: readonly QualificationCompatibilityField[];
} {
  if (
    qualification.scope !== deferred.countInput.scope ||
    (qualification.scope !== "session" && qualification.scope !== "visitor") ||
    qualification.reportOutputIds.length !== 1 ||
    qualification.reportOutputIds[0] !== EVENT_RECORD_PAGE_OUTPUT_ID
  )
    throw new Error("event_records_qualification_plan_identity_invalid");
  assertEventRecordPageOutputContract(qualification.plan);
  const reportOutput = exactOutput(
    qualification.plan.outputs,
    EVENT_RECORD_PAGE_OUTPUT_ID,
  );
  const controlsOutput = exactOutput(
    qualification.plan.outputs,
    EVENT_QUALIFICATION_CONTROL_OUTPUT,
  );
  const compatibilityFields = qualificationCompatibilityFieldsFromNumeric(
    qualification.numericCompatibilityFields,
  );
  const controlNames = controlsOutput.fields.map(({ name }) => name);
  const expected = controlNamesFor(qualification);
  if (
    new Set(controlNames).size !== controlNames.length ||
    controlNames.length !== expected.length ||
    expected.some((name) => !controlNames.includes(name))
  )
    throw new Error("event_records_qualification_controls_invalid");
  if (
    reportOutput.fields.length !== RECORD_FIELDS.length ||
    reportOutput.fields.some(
      (field, index) => field.name !== RECORD_FIELDS[index],
    )
  )
    throw new Error("event_records_qualification_page_schema_invalid");
  return { reportOutput, controlsOutput, controlNames, compatibilityFields };
}

function taggedRows(input: {
  readonly report: AnalyticsDbRelation;
  readonly controls: AnalyticsDbRelation;
  readonly controlOutputId: string;
  readonly controlNames: readonly string[];
}) {
  const reportProjection: Record<string, AnyExpression> = {
    rowKind: constant("record"),
    outputId: constant(EVENT_RECORD_PAGE_OUTPUT_ID),
  };
  for (const field of RECORD_FIELDS) {
    const expression = input.report.columns[field];
    if (!expression)
      throw new Error(`event_records_qualification_report_field:${field}`);
    reportProjection[field] = expression;
  }
  for (const field of input.controlNames) {
    if (field in reportProjection)
      throw new Error(`event_records_qualification_control_name:${field}`);
    reportProjection[field] = constant(null);
  }

  const controlProjection: Record<string, AnyExpression> = {
    rowKind: constant("control"),
    outputId: constant(input.controlOutputId),
  };
  for (const field of RECORD_FIELDS) controlProjection[field] = constant(null);
  for (const field of input.controlNames) {
    const expression = input.controls.columns[field];
    if (!expression)
      throw new Error(`event_records_qualification_control_field:${field}`);
    controlProjection[field] = expression;
  }
  return union(
    project(input.report, reportProjection),
    project(input.controls, controlProjection),
    true,
  );
}

function orderedRows(
  relation: ReturnType<typeof taggedRows>,
  options: EventRecordPageOptions,
) {
  const primary =
    options.sort.key === "occurredAt"
      ? "occurredAt"
      : options.sort.key === "eventName"
        ? "eventName"
        : "pathname";
  const order = [
    { field: "rowKind", direction: "asc" as const, nulls: "last" as const },
    {
      field: primary,
      direction: options.sort.direction,
      nulls:
        options.sort.direction === "asc"
          ? ("first" as const)
          : ("last" as const),
    },
    ...(primary === "occurredAt"
      ? [
          {
            field: "eventId",
            direction: options.sort.direction,
            nulls:
              options.sort.direction === "asc"
                ? ("first" as const)
                : ("last" as const),
          },
          {
            field: "eventPk",
            direction: options.sort.direction,
            nulls:
              options.sort.direction === "asc"
                ? ("first" as const)
                : ("last" as const),
          },
        ]
      : [
          {
            field: "occurredAt",
            direction: "desc" as const,
            nulls: "last" as const,
          },
          {
            field: "eventId",
            direction: "desc" as const,
            nulls: "last" as const,
          },
          {
            field: "eventPk",
            direction: "desc" as const,
            nulls: "last" as const,
          },
        ]),
  ];
  const keys = order.flatMap((key) => {
    const expression = relation.columns[key.field];
    if (!expression)
      throw new Error(`event_records_qualification_order_field:${key.field}`);
    const nativeNulls = key.direction === "asc" ? "first" : "last";
    return [
      ...(key.nulls === nativeNulls
        ? []
        : [
            {
              expression: caseWhen(
                [
                  {
                    when: isNull(expression),
                    then: constant(key.nulls === "first" ? 0 : 1),
                  },
                ],
                constant(key.nulls === "first" ? 1 : 0),
              ),
              direction: "ASC" as const,
            },
          ]),
      {
        expression,
        direction:
          key.direction === "asc" ? ("ASC" as const) : ("DESC" as const),
      },
    ];
  });
  return sort(relation, keys);
}

function compileProgram(input: {
  readonly deferred: DeferredEventRecordsQualification;
  readonly options: EventRecordPageOptions;
  readonly cursorToken: string | null;
}):
  | {
      readonly kind: "compiled";
      readonly query: ReturnType<
        typeof compileD1Query<Record<string, unknown>>
      >;
      readonly evidence: EventRecordsQualificationCompilationEvidence;
      readonly qualification: EventQualificationPlan;
    }
  | {
      readonly kind: "unavailable";
      readonly fallbackReason: AdvancedCountSqlFallbackReason;
    } {
  const { deferred, options } = input;
  if (
    !isDeferredEventQualification(deferred) ||
    deferred.operation !== "event-records"
  )
    throw new Error("event_records_qualification_request_untrusted");
  const prepared = deferred.eventRecordsRequest;
  if (
    !prepared ||
    prepared.search !== options.search ||
    prepared.eventName !== options.eventName ||
    prepared.sort.field !== options.sort.key ||
    prepared.sort.direction !== options.sort.direction ||
    prepared.page.limit !== options.limit ||
    prepared.page.cursor !== (input.cursorToken ?? null)
  )
    throw new Error("event_records_qualification_request_mismatch");
  abortIfNeeded(deferred.signal);

  const qualification = buildEventRecordPageQualificationPlan({
    siteId: deferred.siteId,
    count: deferred.countInput,
    options,
  });
  const { reportOutput, controlsOutput, controlNames, compatibilityFields } =
    verifyQualificationPlan(qualification, deferred);
  const compatibilityControlNames = compatibilityFields.map(
    ({ outputName }) => outputName,
  );
  const policy: EventQualificationAdmissionPolicy = {
    eventSourceRelationId: qualification.eventSourceRelationId,
    reportSourceRelations: qualification.reportSourceRelations ?? [
      { relationId: qualification.eventSourceRelationId, entity: "event" },
    ],
    reportRelationIds: [reportOutput.relation],
    controlsRelationId: controlsOutput.relation,
    controlSlots: controlsOutput.fields.map(({ name, slot }) => ({
      name,
      slot,
    })),
    scope: qualification.scope,
    maximumActivities: ADVANCED_FILTER_MAX_ACTIVITIES,
    numericCompatibilityControlNames: compatibilityControlNames,
  };
  const lowerer = new AnalyticsLogicalToDbLowerer(
    qualification.plan,
    { siteId: deferred.siteId, time: qualification.plan.context.time },
    { eventQualificationAdmissionPolicy: policy },
  );
  const lowered = lowerer.lowerMany([reportOutput, controlsOutput]);
  const report = lowerer.projectOutput(
    lowered[0]!,
    reportOutput.fields.map(({ name, slot }) => ({ name, slot })),
  );
  const controls = lowerer.projectOutput(
    lowered[1]!,
    controlsOutput.fields.map(({ name, slot }) => ({ name, slot })),
  );
  const envelope = orderedRows(
    taggedRows({
      report,
      controls,
      controlOutputId: qualification.controlOutputId,
      controlNames,
    }),
    options,
  );
  const physical = lowerLogicalPlan(envelope);
  const grouped = lowerer.loweredRelationForPlan(
    qualification.groupedSummaryRelationId,
  );
  const groupedCandidates = physical.sharedRelations.filter(
    (relation) => relation.node === grouped?.node,
  );
  if (
    !grouped ||
    grouped.node.kind !== "aggregate" ||
    grouped.node.groups.length !== 2 ||
    grouped.fields.length > 16 ||
    groupedCandidates.length !== 1 ||
    groupedCandidates[0]!.materialization !== "materialized" ||
    groupedCandidates[0]!.fields.length > 16
  )
    return {
      kind: "unavailable",
      fallbackReason: {
        kind: "grouped-summary-unavailable",
        groupWidth: grouped?.fields.length ?? null,
      },
    };

  abortIfNeeded(deferred.signal);
  let query: ReturnType<typeof compileD1Query<Record<string, unknown>>>;
  try {
    query = compileD1Query(physical, {
      tag: currentD1Operation() ?? "analytics.event_records_qualification",
    }) as ReturnType<typeof compileD1Query<Record<string, unknown>>>;
  } catch (error) {
    if (!(error instanceof D1StatementBudgetError)) throw error;
    return {
      kind: "unavailable",
      fallbackReason: {
        kind: "compile-budget",
        item: error.item,
        actual: error.actual,
        limit: error.limit,
      },
    };
  }
  const evidence: EventRecordsQualificationCompilationEvidence = Object.freeze({
    statementTag:
      query.tag ??
      currentD1Operation() ??
      "analytics.event_records_qualification",
    sql: query.sql,
    bindings: Object.freeze([...(query.bindings ?? [])]),
    sqlBytes: new TextEncoder().encode(query.sql).byteLength,
    bindingCount: query.bindings?.length ?? 0,
    groupWidth: grouped.fields.length,
    sharedRelationCount: physical.sharedRelations.length,
    rootKind: physical.root.kind,
    physicalScanKinds: Object.freeze(scanKinds(physical.root)),
    logicalPlan: qualification.plan,
    compatibilityFields,
  });
  return { kind: "compiled", query, evidence, qualification };
}

function decodeRows(
  rows: readonly Record<string, unknown>[],
  deferred: DeferredEventRecordsQualification,
  evidence: EventRecordsQualificationCompilationEvidence,
  controlOutputId: string,
): EventRecordsQualificationExecution {
  const controlFields = [
    "rowKind",
    "outputId",
    ...RECORD_FIELDS,
    ...CONTROL_BASE_FIELDS,
    ...evidence.compatibilityFields.map(({ outputName }) => outputName),
  ];
  const controls = rows.filter((row) => row.rowKind === "control");
  if (
    controls.length !== 1 ||
    !exactRowKeys(controls[0]!, controlFields) ||
    controls[0]!.outputId !== controlOutputId
  )
    throw new Error("event_records_qualification_control_row_invalid");
  const control = controls[0]!;
  if (control.entityKind !== deferred.countInput.scope)
    throw new Error("event_records_qualification_control_scope_mismatch");
  const decodedControl = decodeQualificationControl({
    read: (field) => control[field],
    compatibilityFields: evidence.compatibilityFields,
    errorLabel: (field) =>
      "event_records_qualification_control_invalid:" + field,
  });
  const records = rows.filter((row) => row.rowKind === "record");
  if (rows.length !== controls.length + records.length)
    throw new Error("event_records_qualification_row_kind_invalid");
  for (const row of records)
    if (
      !exactRowKeys(row, controlFields) ||
      row.outputId !== EVENT_RECORD_PAGE_OUTPUT_ID
    )
      throw new Error("event_records_qualification_record_row_invalid");
  const judgment = judgeQualificationControl(decodedControl, {
    reportRowCount: records.length,
    gateViolation: () =>
      new Error("event_records_qualification_gate_violation"),
    invalidIdentity: () =>
      new Error("event_records_qualification_identity_invalid"),
    duplicateIdentity: () =>
      new Error("event_records_qualification_identity_duplicated"),
  });
  if (judgment.kind === "fallback")
    return {
      kind: "fallback",
      fallbackReason: judgment.fallbackReason,
    };
  return {
    kind: "executed",
    rows: Object.freeze(records),
    evidence,
  };
}

export async function executeEventRecordsQualificationProgram(input: {
  readonly env: Env;
  readonly deferred: DeferredEventRecordsQualification;
  readonly options: EventRecordPageOptions;
  readonly cursorToken: string | null;
  readonly diagnostics?: D1ReadDiagnostics;
}): Promise<EventRecordsQualificationExecution> {
  const result = compileProgram(input);
  if (result.kind === "unavailable") return result;
  input.diagnostics?.onEventRecordsQualificationCompile?.(result.evidence);
  abortIfNeeded(input.deferred.signal);
  const rows = await queryD1CompiledAll(
    input.env,
    result.query,
    input.diagnostics,
  );
  abortIfNeeded(input.deferred.signal);
  const { qualification } = result;
  return decodeRows(
    rows,
    input.deferred,
    result.evidence,
    qualification.controlOutputId,
  );
}
