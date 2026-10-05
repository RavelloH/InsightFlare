import type { FilterDocument } from "@/lib/edge/analytics/contract";
import {
  buildGoalSummaryReportPlan,
  GOAL_SUMMARY_REPORT_OUTPUT,
} from "@/lib/edge/analytics/engine/goal-observation-report-plan";
import type { Env } from "@/lib/edge/types";

import { queryAnalyticsReportOutputRowsFromD1 } from "./analytics-report-query";
import type { QueryWindow } from "./core-types";

/** The one-row aggregate returned by the summary statement. */
export interface GoalSummaryAggregateRow {
  readonly totalSessions: number;
  readonly convertedSessions: number;
  readonly totalVisitors: number;
  readonly convertedVisitors: number;
}

function countValue(value: unknown): number {
  const count = Number(value ?? 0);
  return Number.isFinite(count) && count > 0 ? Math.floor(count) : 0;
}

/** Execute Goal summary as one typed logical report output. */
export async function queryGoalSummaryFromD1(
  env: Env,
  siteId: string,
  window: QueryWindow,
  globalFilters: FilterDocument,
  goalFilter: FilterDocument,
): Promise<GoalSummaryAggregateRow> {
  const plan = buildGoalSummaryReportPlan({
    siteId,
    window,
    filters: globalFilters,
    goalFilter,
  });
  const rows = await queryAnalyticsReportOutputRowsFromD1(
    env,
    plan,
    GOAL_SUMMARY_REPORT_OUTPUT,
  );
  const row = rows[0] ?? {};
  return {
    totalSessions: countValue(row.totalSessions),
    convertedSessions: countValue(row.convertedSessions),
    totalVisitors: countValue(row.totalVisitors),
    convertedVisitors: countValue(row.convertedVisitors),
  };
}

/** Short alias for callers that use the operation name without the D1 suffix. */
export const queryGoalSummary = queryGoalSummaryFromD1;
