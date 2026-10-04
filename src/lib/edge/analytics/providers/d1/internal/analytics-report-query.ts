import {
  caseWhen,
  compileD1Query,
  constant,
  isNull,
  lowerLogicalPlan,
  sort,
  union,
} from "@/lib/db";
import type { AnyExpression } from "@/lib/db/query/expression";
import type { SlotId } from "@/lib/edge/analytics/engine/logical/ids";
import type { ValidatedLogicalPlan } from "@/lib/edge/analytics/engine/logical/plan";
import type { LogicalOutput } from "@/lib/edge/analytics/engine/logical/plan";
import type { LogicalValueType } from "@/lib/edge/analytics/engine/logical/slots";
import { isSameLogicalValueType } from "@/lib/edge/analytics/engine/logical/slots";
import {
  AnalyticsLogicalToDbLowerer,
  type LoweredAnalyticsLogicalOutput,
} from "@/lib/edge/analytics/providers/d1/internal/analytics-relational-lowering";
import type { AnalyticsDbRelation } from "@/lib/edge/analytics/providers/d1/internal/analytics-relational-storage";
import { currentD1Operation } from "@/lib/edge/observability/logger";
import type { Env } from "@/lib/edge/types";

import { queryD1CompiledAll } from "./core";
import type { D1ReadDiagnostics } from "./diagnostics";

export interface AnalyticsReportOutputOrderKey {
  readonly field: string;
  readonly direction: "asc" | "desc";
  readonly nulls: "first" | "last";
}

export interface AnalyticsReportMultiOutputSelection {
  readonly outputIds: readonly string[];
  /** Output aliases in the requested Generic relation position order. */
  readonly fields: readonly string[];
  readonly orderBy: readonly AnalyticsReportOutputOrderKey[];
}

interface SelectedOutputField {
  readonly name: string;
  readonly slot: SlotId;
  readonly type: LogicalValueType;
  readonly nullable: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]) {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return (
    actual.length === expected.length &&
    actual.every((key, index) => key === expected[index])
  );
}

function validateMultiOutputSelection(
  selection: AnalyticsReportMultiOutputSelection,
): void {
  if (!isRecord(selection))
    throw new Error("analytics_report_multi_output_selection_invalid");
  if (!exactKeys(selection, ["outputIds", "fields", "orderBy"]))
    throw new Error("analytics_report_multi_output_selection_invalid");
  if (
    !Array.isArray(selection.outputIds) ||
    selection.outputIds.length === 0 ||
    selection.outputIds.some(
      (id) => typeof id !== "string" || id.trim().length === 0,
    )
  )
    throw new Error("analytics_report_multi_output_ids_invalid");
  if (new Set(selection.outputIds).size !== selection.outputIds.length)
    throw new Error("analytics_report_multi_output_ids_duplicate");
  if (
    !Array.isArray(selection.fields) ||
    selection.fields.length === 0 ||
    selection.fields.some(
      (field) =>
        typeof field !== "string" || !/^[A-Za-z_][A-Za-z0-9_]*$/u.test(field),
    )
  )
    throw new Error("analytics_report_multi_output_fields_invalid");
  if (new Set(selection.fields).size !== selection.fields.length)
    throw new Error("analytics_report_multi_output_fields_duplicate");
  if (
    !Array.isArray(selection.orderBy) ||
    selection.orderBy.some(
      (key) =>
        !isRecord(key) ||
        !exactKeys(key, ["field", "direction", "nulls"]) ||
        typeof key.field !== "string" ||
        !selection.fields.includes(key.field) ||
        (key.direction !== "asc" && key.direction !== "desc") ||
        (key.nulls !== "first" && key.nulls !== "last"),
    )
  )
    throw new Error("analytics_report_multi_output_order_invalid");
  const orderFields = selection.orderBy.map((key) => key.field);
  if (new Set(orderFields).size !== orderFields.length)
    throw new Error("analytics_report_multi_output_order_duplicate");
}

function selectedOutputFields(
  plan: ValidatedLogicalPlan,
  output: LogicalOutput,
  requestedFields: readonly string[],
): SelectedOutputField[] {
  const declaredNames = output.fields.map((field) => field.name);
  if (new Set(declaredNames).size !== declaredNames.length)
    throw new Error("analytics_report_multi_output_declared_fields_duplicate");
  const slots = new Map(plan.slots.map((slot) => [slot.id, slot] as const));
  return requestedFields.map((name) => {
    const matching = output.fields.filter((field) => field.name === name);
    if (matching.length !== 1)
      throw new Error(`analytics_report_multi_output_field_missing:${name}`);
    const logicalSlot = slots.get(matching[0]!.slot);
    if (!logicalSlot)
      throw new Error(`analytics_report_multi_output_slot_missing:${name}`);
    if (
      logicalSlot.type.kind !== "scalar" &&
      logicalSlot.type.kind !== "bucket"
    )
      throw new Error(
        `analytics_report_multi_output_entity_unsupported:${name}`,
      );
    return {
      name,
      slot: matching[0]!.slot,
      type: logicalSlot.type,
      nullable: logicalSlot.nullable,
    };
  });
}

function createReportLowerer(
  plan: ValidatedLogicalPlan,
  errorPrefix: string,
): AnalyticsLogicalToDbLowerer {
  const siteIds = plan.context.subject.siteIds;
  const siteCount = Array.isArray(siteIds) ? siteIds.length : "invalid";
  if (
    !Array.isArray(siteIds) ||
    siteIds.length === 0 ||
    siteIds.some((siteId) => typeof siteId !== "string" || siteId.length === 0)
  )
    throw new Error(`${errorPrefix}_site_subject_unsupported:${siteCount}`);
  return new AnalyticsLogicalToDbLowerer(
    plan,
    siteIds.length === 1
      ? { siteId: siteIds[0]!, time: plan.context.time }
      : { siteIds, time: plan.context.time },
  );
}

function outputRelation(
  lowerer: AnalyticsLogicalToDbLowerer,
  lowered: LoweredAnalyticsLogicalOutput,
  fields: readonly { readonly name: string; readonly slot: SlotId }[],
): AnalyticsDbRelation {
  return lowerer.projectOutput(lowered, fields);
}

async function executeReportRelation(
  env: Env,
  relation: AnalyticsDbRelation,
  diagnostics?: D1ReadDiagnostics,
): Promise<Record<string, unknown>[]> {
  const query = compileD1Query(lowerLogicalPlan(relation), {
    tag: currentD1Operation() ?? "analytics.query.all",
  });
  const rows = await queryD1CompiledAll<object>(env, query, diagnostics);
  return rows.map((row) => Object.fromEntries(Object.entries(row)));
}

/** Executes one validated Analytics report output through the shared D1 path. */
export async function queryAnalyticsReportOutputRowsFromD1(
  env: Env,
  plan: ValidatedLogicalPlan,
  outputId: string,
  outputMissingMessage = `analytics_report_output_missing:${outputId}`,
  diagnostics?: D1ReadDiagnostics,
): Promise<Record<string, unknown>[]> {
  const output = plan.outputs.find((candidate) => candidate.id === outputId);
  if (!output) throw new Error(outputMissingMessage);
  const lowerer = createReportLowerer(plan, "analytics_report");
  return executeReportRelation(
    env,
    outputRelation(
      lowerer,
      lowerer.lower(output),
      output.fields.map((field) => ({ name: field.name, slot: field.slot })),
    ),
    diagnostics,
  );
}

/** Combines selected scalar/bucket report outputs into one UNION ALL query. */
export async function queryAnalyticsReportOutputSetRowsFromD1(
  env: Env,
  plan: ValidatedLogicalPlan,
  selection: AnalyticsReportMultiOutputSelection,
  diagnostics?: D1ReadDiagnostics,
): Promise<Record<string, unknown>[]> {
  validateMultiOutputSelection(selection);
  const outputs = selection.outputIds.map((outputId) => {
    const matches = plan.outputs.filter(
      (candidate) => candidate.id === outputId,
    );
    if (matches.length !== 1)
      throw new Error(`analytics_report_multi_output_missing:${outputId}`);
    return matches[0]!;
  });
  const outputSchemas = outputs.map((output) =>
    selectedOutputFields(plan, output, selection.fields),
  );
  const firstSchema = outputSchemas[0]!;
  for (const [outputIndex, schema] of outputSchemas.entries()) {
    for (const [fieldIndex, field] of schema.entries()) {
      const first = firstSchema[fieldIndex]!;
      if (
        field.name !== first.name ||
        !isSameLogicalValueType(field.type, first.type)
      )
        throw new Error(
          `analytics_report_multi_output_field_incompatible:${outputIndex}:${field.name}`,
        );
    }
  }

  const lowerer = createReportLowerer(plan, "analytics_report_multi_output");
  const loweredOutputs = lowerer.lowerMany(outputs);
  const branches = outputs.map((output, index) =>
    outputRelation(
      lowerer,
      loweredOutputs[index]!,
      outputSchemas[index]!.map(({ name, slot }) => ({ name, slot })),
    ),
  );
  let combined = branches[0]!;
  for (const branch of branches.slice(1))
    combined = union(combined, branch, true) as AnalyticsDbRelation;

  const sortKeys = selection.orderBy.flatMap((key) => {
    const expression = combined.columns[key.field] as AnyExpression | undefined;
    if (!expression)
      throw new Error(
        `analytics_report_multi_output_order_field_missing:${key.field}`,
      );
    const direction: "ASC" | "DESC" = key.direction === "asc" ? "ASC" : "DESC";
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
      { expression, direction },
    ];
  });
  return executeReportRelation(
    env,
    sortKeys.length > 0 ? sort(combined, sortKeys) : combined,
    diagnostics,
  );
}
