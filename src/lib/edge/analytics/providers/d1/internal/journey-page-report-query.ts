import type { ValidatedLogicalPlan } from "@/lib/edge/analytics/engine/logical/plan";
import type { Env } from "@/lib/edge/types";

import { queryAnalyticsReportOutputRowsFromD1 } from "./analytics-report-query";
import type { D1ReadDiagnostics } from "./diagnostics";

export async function queryJourneyPageReportRowsFromD1(
  env: Env,
  plan: ValidatedLogicalPlan,
  outputId: string,
  diagnostics?: D1ReadDiagnostics,
): Promise<Record<string, unknown>[]> {
  return queryAnalyticsReportOutputRowsFromD1(
    env,
    plan,
    outputId,
    `journey_page_report_output_missing:${outputId}`,
    diagnostics,
  );
}
