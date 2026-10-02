import type { ValidatedLogicalPlan } from "@/lib/edge/analytics/engine/logical/plan";
import type { Env } from "@/lib/edge/types";

import { queryAnalyticsReportOutputRowsFromD1 } from "./analytics-report-query";

/** Executes one Journey entity detail output through the shared typed D1 path. */
export async function queryJourneyEntityDetailRowsFromD1(
  env: Env,
  plan: ValidatedLogicalPlan,
  outputId: string,
): Promise<Record<string, unknown>[]> {
  return queryAnalyticsReportOutputRowsFromD1(
    env,
    plan,
    outputId,
    `journey_entity_detail_output_missing:${outputId}`,
  );
}
