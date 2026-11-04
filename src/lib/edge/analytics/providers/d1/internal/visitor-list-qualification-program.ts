import { parseGoalFilter } from "@/lib/edge/analytics/contract";
import { JOURNEY_VISITOR_LIST_REPORT_OUTPUT } from "@/lib/edge/analytics/engine/journey-entity-list-report-plan";
import {
  buildJourneyVisitorFunnelListQualificationPlan,
  buildJourneyVisitorGoalListQualificationPlan,
  buildJourneyVisitorListQualificationPlan,
} from "@/lib/edge/analytics/engine/journey-visitor-list-qualification-plan";
import type { LogicalOutput } from "@/lib/edge/analytics/engine/logical/plan";
import { PAGE_DIMENSION_QUALIFICATION_CONTROL_OUTPUT } from "@/lib/edge/analytics/engine/page-dimension-qualification-plan";
import {
  deferredEventQualificationFromQuery,
  isDeferredEventQualification,
} from "@/lib/edge/analytics/providers/d1/internal/advanced-filter-execution";
import { queryD1CompiledAll } from "@/lib/edge/analytics/providers/d1/internal/core";
import { mapVisitors } from "@/lib/edge/analytics/providers/d1/internal/core-mappers";
import {
  type JourneyListAnalysis,
  type VisitorListCursor,
  visitorListPageFromRecords,
} from "@/lib/edge/analytics/providers/d1/internal/journey-list-queries";
import {
  decodeSiteVisitorListCursor,
  encodeSiteVisitorListCursor,
  type JourneySearchInput,
  resolveJourneyListAnalysis,
  type VisitorSort,
} from "@/lib/edge/analytics/providers/d1/operations/site-journeys";
import type { Env } from "@/lib/edge/types";

import type {
  AdvancedCountSqlFallbackReason,
  D1ReadDiagnostics,
} from "./diagnostics";
import { queryGoalDefinition } from "./goals";
import { InvalidCursorError } from "./pagination";
import type { QualificationEnvelopeCompilationEvidence } from "./qualification-program-envelope";
import { compileQualificationProgramEnvelope } from "./qualification-program-envelope";
import {
  decodeQualificationControl,
  executeQualificationQuery,
  judgeQualificationControl,
} from "./qualification-program-runtime";
import type {
  DeferredVisitorListQualification,
  VisitorListQualificationConfiguration,
} from "./visitor-list-qualification-request";
import {
  assertVisitorListQualificationRequest,
  deferredVisitorListQualificationFromQuery,
} from "./visitor-list-qualification-request";

const ERROR_PREFIX = "visitor_list_qualification";
const VISITOR_REPORT_FIELDS = [
  "visitorId",
  "sessionId",
  "userId",
  "userName",
  "firstSeenAt",
  "lastSeenAt",
  "views",
  "sessions",
  "events",
  "country",
  "region",
  "regionCode",
  "city",
  "referrerHost",
  "referrerUrl",
  "browser",
  "browserVersion",
  "os",
  "osVersion",
  "deviceType",
  "screenWidth",
  "screenHeight",
] as const;

export type VisitorListQualificationExecution =
  | {
      readonly kind: "executed";
      readonly result: {
        readonly items: ReturnType<typeof mapVisitors>;
        readonly pagination: {
          readonly limit: number;
          readonly returned: number;
          readonly hasMore: boolean;
          readonly nextCursor: string | null;
        };
      };
      readonly evidence: QualificationEnvelopeCompilationEvidence;
      readonly reportRowCount: number;
      readonly controlRowCount: 1;
    }
  | {
      readonly kind: "fallback" | "unavailable";
      readonly fallbackReason: AdvancedCountSqlFallbackReason;
      readonly resolvedAnalysis?: JourneyListAnalysis;
      readonly postFallbackError?: { readonly error: unknown };
    };

function requestWindow(time: {
  readonly range: { readonly startMs: number; readonly endExclusiveMs: number };
  readonly capturedAtMs: number;
  readonly reportingTimeZone: string;
}) {
  return {
    startMs: time.range.startMs,
    endExclusiveMs: time.range.endExclusiveMs,
    nowMs: time.capturedAtMs,
    timeZone: time.reportingTimeZone,
  };
}

function exactOutput(outputs: readonly LogicalOutput[], outputId: string) {
  const matches = outputs.filter((output) => output.id === outputId);
  if (matches.length !== 1)
    throw new Error(`${ERROR_PREFIX}_output:${outputId}`);
  return matches[0]!;
}

function ownRecordRows(
  input: unknown,
  reportFields: readonly string[],
  controlFields: readonly string[],
): Record<string, unknown>[] {
  if (!Array.isArray(input))
    throw new Error(`${ERROR_PREFIX}_envelope_rows_invalid`);
  const expected = [
    "rowKind",
    "outputId",
    ...reportFields,
    ...controlFields,
  ].sort();
  return input.map((candidate) => {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate))
      throw new Error(`${ERROR_PREFIX}_envelope_row_invalid`);
    let keys: PropertyKey[];
    try {
      keys = Reflect.ownKeys(candidate);
    } catch {
      throw new Error(`${ERROR_PREFIX}_envelope_row_invalid`);
    }
    if (
      keys.length !== expected.length ||
      keys.some((key) => typeof key !== "string") ||
      [...keys].sort().some((key, index) => key !== expected[index])
    )
      throw new Error(`${ERROR_PREFIX}_envelope_row_schema_invalid`);
    const row: Record<string, unknown> = Object.create(null) as Record<
      string,
      unknown
    >;
    for (const key of expected) {
      const descriptor = Object.getOwnPropertyDescriptor(candidate, key);
      if (!descriptor || !descriptor.enumerable || !("value" in descriptor))
        throw new Error(`${ERROR_PREFIX}_envelope_row_schema_invalid`);
      row[key] = descriptor.value;
    }
    return row;
  });
}

function exactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
): boolean {
  const keys = Reflect.ownKeys(value);
  const required = [...expected].sort();
  return (
    keys.length === required.length &&
    keys.every((key) => typeof key === "string") &&
    [...keys].sort().every((key, index) => key === required[index]) &&
    keys.every((key) => {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      return descriptor?.enumerable === true && "value" in descriptor;
    })
  );
}

function configurationSort(
  configuration: VisitorListQualificationConfiguration,
): VisitorSort {
  return {
    field: configuration.sort.field,
    direction: configuration.sort.direction,
  };
}

function configurationCursorSort(
  configuration: VisitorListQualificationConfiguration,
) {
  return {
    field: configuration.sort.field,
    direction: configuration.sort.direction,
  } as const;
}

function listInput(input: {
  readonly env: Env;
  readonly siteId: string;
  readonly window: ReturnType<typeof requestWindow>;
  readonly filters: DeferredVisitorListQualification["qualification"]["filters"];
  readonly configuration: VisitorListQualificationConfiguration;
}): JourneySearchInput {
  return {
    env: input.env,
    siteId: input.siteId,
    window: input.window,
    filters: input.filters,
    search: input.configuration.search,
    page: input.configuration.page,
    audience: input.configuration.audience,
    ...(input.configuration.analysisContext
      ? { analysisContext: input.configuration.analysisContext }
      : {}),
  };
}

async function compileProgram(input: {
  readonly query: Record<string, unknown>;
  readonly deferred: DeferredVisitorListQualification;
}) {
  const request = assertVisitorListQualificationRequest(
    input.deferred,
    input.query,
  );
  const qualification = request.qualification;
  if (
    !isDeferredEventQualification(qualification) ||
    qualification.operation !== "visitors" ||
    deferredEventQualificationFromQuery(input.query, "visitors") !==
      qualification ||
    deferredVisitorListQualificationFromQuery(input.query) !== request
  )
    throw new Error(`${ERROR_PREFIX}_request_invalid`);

  const analysisContext = request.configuration.analysisContext;
  const window = requestWindow(qualification.requestTime);
  const cursorInput = listInput({
    env: qualification.env,
    siteId: qualification.siteId,
    window,
    filters: qualification.filters,
    configuration: request.configuration,
  });
  let cursor: VisitorListCursor | null = null;
  let cursorError: InvalidCursorError | undefined;
  try {
    cursor = await decodeSiteVisitorListCursor(
      cursorInput,
      configurationCursorSort(request.configuration),
    );
  } catch (error) {
    if (!(error instanceof InvalidCursorError)) throw error;
    cursorError = error;
  }

  let resolvedAnalysis: JourneyListAnalysis | undefined;
  let postFallbackError: { readonly error: unknown } | undefined;
  if (analysisContext?.type === "goal") {
    if (qualification.signal?.aborted)
      throw new DOMException("Aborted", "AbortError");
    try {
      const goal = await queryGoalDefinition(
        qualification.env,
        qualification.siteId,
        analysisContext.goalId,
      );
      if (!goal) throw new Error("resource-not-found");
      resolvedAnalysis = { type: "goal", filter: parseGoalFilter(goal) };
    } catch (error) {
      if (qualification.signal?.aborted)
        throw new DOMException("Aborted", "AbortError");
      postFallbackError = { error };
    }
    if (qualification.signal?.aborted)
      throw new DOMException("Aborted", "AbortError");
  } else if (analysisContext?.type === "funnel") {
    if (qualification.signal?.aborted)
      throw new DOMException("Aborted", "AbortError");
    try {
      resolvedAnalysis = await resolveJourneyListAnalysis(
        cursorInput,
        "visitor",
      );
    } catch (error) {
      if (qualification.signal?.aborted)
        throw new DOMException("Aborted", "AbortError");
      postFallbackError = { error };
    }
    if (qualification.signal?.aborted)
      throw new DOMException("Aborted", "AbortError");
  }

  const planInput = {
    siteId: qualification.siteId,
    queryTime: qualification.requestTime,
    filters: qualification.filters,
    scopePlan: qualification.metadata.plan,
    count: qualification.countInput,
    limit: request.configuration.page.limit,
    sort: {
      key: request.configuration.sort.field,
      direction: request.configuration.sort.direction,
    },
    search: request.configuration.search,
    cursor,
  };
  const suppressReportRows = cursorError !== undefined || postFallbackError;
  const plan =
    resolvedAnalysis?.type === "goal"
      ? buildJourneyVisitorGoalListQualificationPlan({
          ...planInput,
          analysisFilter: resolvedAnalysis.filter,
          ...(suppressReportRows ? { suppressReportRows: true } : {}),
        })
      : resolvedAnalysis?.type === "funnel"
        ? buildJourneyVisitorFunnelListQualificationPlan({
            ...planInput,
            funnelAnalysis: {
              config: resolvedAnalysis.config,
              stepIndex: resolvedAnalysis.stepIndex,
              ...(resolvedAnalysis.outcome
                ? { outcome: resolvedAnalysis.outcome }
                : {}),
            },
            ...(suppressReportRows ? { suppressReportRows: true } : {}),
          })
        : buildJourneyVisitorListQualificationPlan({
            ...planInput,
            ...(suppressReportRows ? { suppressReportRows: true } : {}),
          });
  const report = exactOutput(
    plan.plan.outputs,
    JOURNEY_VISITOR_LIST_REPORT_OUTPUT,
  );
  const controls = exactOutput(
    plan.plan.outputs,
    PAGE_DIMENSION_QUALIFICATION_CONTROL_OUTPUT,
  );
  const ordering = [
    {
      outputId: JOURNEY_VISITOR_LIST_REPORT_OUTPUT,
      field: request.configuration.sort.field,
      direction: request.configuration.sort.direction,
      nulls: "last" as const,
    },
    ...(request.configuration.sort.field === "lastSeenAt"
      ? []
      : [
          {
            outputId: JOURNEY_VISITOR_LIST_REPORT_OUTPUT,
            field: "lastSeenAt",
            direction: "desc" as const,
            nulls: "last" as const,
          },
        ]),
    {
      outputId: JOURNEY_VISITOR_LIST_REPORT_OUTPUT,
      field: "visitorId",
      direction: "asc" as const,
      nulls: "last" as const,
    },
  ];
  const reportFields = report.fields.map(({ name }) => name);
  const compilation = compileQualificationProgramEnvelope({
    qualification: plan,
    siteId: qualification.siteId,
    reports: [
      { output: report, fields: reportFields, rowType: "visitor-list" },
    ],
    controlsOutput: controls,
    reportFields,
    controlFields: controls.fields.map(({ name }) => name),
    ordering,
    errorPrefix: ERROR_PREFIX,
    fallbackTag: "analytics.visitor_list_qualification",
    signal: qualification.signal,
  });
  return {
    request,
    qualification,
    cursorInput,
    cursorError,
    resolvedAnalysis,
    postFallbackError,
    compilation,
  };
}

async function decodeRows(input: {
  readonly rows: readonly Record<string, unknown>[];
  readonly request: DeferredVisitorListQualification;
  readonly qualification: DeferredVisitorListQualification["qualification"];
  readonly evidence: QualificationEnvelopeCompilationEvidence;
  readonly cursorInput: JourneySearchInput;
  readonly cursorError?: InvalidCursorError;
  readonly resolvedAnalysis?: JourneyListAnalysis;
  readonly postFallbackError?: { readonly error: unknown };
}): Promise<VisitorListQualificationExecution> {
  const {
    rows,
    request,
    qualification,
    evidence,
    cursorInput,
    cursorError,
    resolvedAnalysis,
    postFallbackError,
  } = input;
  const reportFields = evidence.outputDescriptors.find(
    ({ outputId }) => outputId === JOURNEY_VISITOR_LIST_REPORT_OUTPUT,
  )?.fields;
  if (
    !reportFields ||
    reportFields.length !== VISITOR_REPORT_FIELDS.length ||
    VISITOR_REPORT_FIELDS.some((field) => !reportFields.includes(field))
  )
    throw new Error(`${ERROR_PREFIX}_report_schema_invalid`);
  const expectedControlFields = [
    "rawCount",
    "nullActivityIdCount",
    "siteIdentityMismatchCount",
    "invalidIdentityCount",
    "duplicateIdentityCount",
    "entityKind",
    ...evidence.compatibilityFields.map(({ outputName }) => outputName),
  ];
  if (
    new Set(evidence.controlFields).size !== evidence.controlFields.length ||
    evidence.controlFields.length !== expectedControlFields.length ||
    expectedControlFields.some(
      (field) => !evidence.controlFields.includes(field),
    )
  )
    throw new Error(`${ERROR_PREFIX}_control_schema_invalid`);
  const expectedFields = [
    "rowKind",
    "outputId",
    ...reportFields,
    ...evidence.controlFields,
  ];
  if (rows.some((row) => row.rowKind !== "control" && row.rowKind !== "report"))
    throw new Error(`${ERROR_PREFIX}_envelope_kind_invalid`);
  const controlRows = rows.filter((row) => row.rowKind === "control");
  if (
    controlRows.length !== 1 ||
    controlRows[0]!.outputId !== evidence.controlOutputId ||
    !exactKeys(controlRows[0]!, expectedFields)
  )
    throw new Error(`${ERROR_PREFIX}_control_row_invalid`);
  const control = controlRows[0]!;
  const reportRows = rows.filter((row) => row.rowKind === "report");
  if (rows.length !== controlRows.length + reportRows.length)
    throw new Error(`${ERROR_PREFIX}_envelope_kind_invalid`);
  if (
    control.entityKind !== qualification.countInput.scope ||
    reportFields.some((field) => control[field] !== null)
  )
    throw new Error(`${ERROR_PREFIX}_control_kind_mismatch`);
  const visitorIds = new Set<string>();
  for (const row of reportRows) {
    if (
      row.outputId !== JOURNEY_VISITOR_LIST_REPORT_OUTPUT ||
      !exactKeys(row, expectedFields) ||
      evidence.controlFields.some((field) => row[field] !== null)
    )
      throw new Error(`${ERROR_PREFIX}_report_row_invalid`);
    if (
      typeof row.visitorId !== "string" ||
      row.visitorId.length === 0 ||
      visitorIds.has(row.visitorId)
    )
      throw new Error(`${ERROR_PREFIX}_report_identity_invalid`);
    visitorIds.add(row.visitorId);
  }
  const decodedControl = decodeQualificationControl({
    read: (field) => control[field],
    compatibilityFields: evidence.compatibilityFields,
    errorLabel: (field) => `${ERROR_PREFIX}_control_invalid:${field}`,
  });
  const judgment = judgeQualificationControl(decodedControl, {
    reportRowCount: reportRows.length,
    gateViolation: () => new Error(`${ERROR_PREFIX}_gate_violation`),
    invalidIdentity: () =>
      new Error("advanced_filter_count_combined_identity_invalid"),
    duplicateIdentity: () =>
      new Error("advanced_filter_count_combined_identity_repeated"),
  });
  if (judgment.kind === "fallback")
    return {
      kind: "fallback",
      fallbackReason: judgment.fallbackReason,
      ...(resolvedAnalysis ? { resolvedAnalysis } : {}),
      ...(postFallbackError ? { postFallbackError } : {}),
    };
  if (postFallbackError) throw postFallbackError.error;
  if (cursorError) throw cursorError;

  const validRows = reportRows.map((row) =>
    Object.fromEntries(reportFields.map((field) => [field, row[field]])),
  );
  const sort = configurationSort(request.configuration);
  const page = visitorListPageFromRecords(
    validRows,
    request.configuration.page.limit,
    {
      key: request.configuration.sort.field,
      direction: request.configuration.sort.direction,
    },
  );
  const nextCursor = await encodeSiteVisitorListCursor(
    cursorInput,
    sort,
    page.nextCursor,
  );
  const items = mapVisitors(page.rows);
  return {
    kind: "executed",
    result: {
      items,
      pagination: {
        limit: request.configuration.page.limit,
        returned: items.length,
        hasMore: page.nextCursor !== null,
        nextCursor,
      },
    },
    evidence,
    reportRowCount: items.length,
    controlRowCount: 1,
  };
}

export async function executeVisitorListQualificationProgram(input: {
  readonly query: Record<string, unknown>;
  readonly deferred: DeferredVisitorListQualification;
  readonly env: Env;
  readonly diagnostics?: D1ReadDiagnostics;
}): Promise<VisitorListQualificationExecution> {
  const {
    request,
    qualification,
    cursorInput,
    cursorError,
    resolvedAnalysis,
    postFallbackError,
    compilation,
  } = await compileProgram({ query: input.query, deferred: input.deferred });
  if (compilation.kind === "unavailable")
    return {
      ...compilation,
      ...(resolvedAnalysis ? { resolvedAnalysis } : {}),
      ...(postFallbackError ? { postFallbackError } : {}),
    };
  const rawRows = await executeQualificationQuery(qualification.signal, () =>
    queryD1CompiledAll<Record<string, unknown>>(
      input.env,
      compilation.query,
      input.diagnostics,
    ),
  );
  const reportFields = compilation.evidence.outputDescriptors.find(
    ({ outputId }) => outputId === JOURNEY_VISITOR_LIST_REPORT_OUTPUT,
  )?.fields;
  if (!reportFields) throw new Error(`${ERROR_PREFIX}_report_schema_invalid`);
  const rows = ownRecordRows(
    rawRows,
    reportFields,
    compilation.evidence.controlFields,
  );
  return decodeRows({
    rows,
    request,
    qualification,
    evidence: compilation.evidence,
    cursorInput,
    ...(cursorError ? { cursorError } : {}),
    ...(resolvedAnalysis ? { resolvedAnalysis } : {}),
    ...(postFallbackError ? { postFallbackError } : {}),
  });
}
