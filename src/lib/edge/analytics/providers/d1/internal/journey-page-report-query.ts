import { compileD1Query, lowerLogicalPlan } from "@/lib/db";
import type { ValidatedLogicalPlan } from "@/lib/edge/analytics/engine/logical/plan";
import { AnalyticsLogicalToDbLowerer } from "@/lib/edge/analytics/providers/d1/internal/analytics-relational-lowering";
import { currentD1Operation } from "@/lib/edge/observability/logger";
import type { Env } from "@/lib/edge/types";

import { queryD1CompiledAll } from "./core";

export async function queryJourneyPageReportRowsFromD1(
  env: Env,
  plan: ValidatedLogicalPlan,
  outputId: string,
): Promise<Record<string, unknown>[]> {
  const output = plan.outputs.find((candidate) => candidate.id === outputId);
  if (!output)
    throw new Error(`journey_page_report_output_missing:${outputId}`);
  const lowerer = new AnalyticsLogicalToDbLowerer(plan, {
    siteId: plan.context.subject.siteIds[0]!,
    time: plan.context.time,
  });
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
