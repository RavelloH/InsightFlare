import { compileD1Query, lowerLogicalPlan } from "@/lib/db";
import type { ValidatedLogicalPlan } from "@/lib/edge/analytics/engine/logical/plan";
import { AnalyticsLogicalToDbLowerer } from "@/lib/edge/analytics/providers/d1/internal/analytics-relational-lowering";
import { currentD1Operation } from "@/lib/edge/observability/logger";
import type { Env } from "@/lib/edge/types";

import { queryD1CompiledAll } from "./core";

/** Executes one validated Analytics report output through the shared D1 path. */
export async function queryAnalyticsReportOutputRowsFromD1(
  env: Env,
  plan: ValidatedLogicalPlan,
  outputId: string,
  outputMissingMessage = `analytics_report_output_missing:${outputId}`,
): Promise<Record<string, unknown>[]> {
  const output = plan.outputs.find((candidate) => candidate.id === outputId);
  if (!output) throw new Error(outputMissingMessage);
  const siteIds = plan.context.subject.siteIds;
  const siteCount = Array.isArray(siteIds) ? siteIds.length : "invalid";
  if (
    !Array.isArray(siteIds) ||
    siteIds.length === 0 ||
    siteIds.some((siteId) => typeof siteId !== "string" || siteId.length === 0)
  )
    throw new Error(`analytics_report_site_subject_unsupported:${siteCount}`);
  const lowerer = new AnalyticsLogicalToDbLowerer(
    plan,
    siteIds.length === 1
      ? { siteId: siteIds[0]!, time: plan.context.time }
      : { siteIds, time: plan.context.time },
  );
  const lowered = lowerer.lower(output);
  const relation = lowerer.projectOutput(
    lowered,
    output.fields.map((field) => ({ name: field.name, slot: field.slot })),
  );
  const query = compileD1Query(lowerLogicalPlan(relation), {
    tag: currentD1Operation() ?? "analytics.query.all",
  });
  const rows = await queryD1CompiledAll<object>(env, query);
  return rows.map((row) => Object.fromEntries(Object.entries(row)));
}
