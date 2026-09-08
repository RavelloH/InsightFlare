import type { GoalDefinition } from "@/lib/edge/analytics/contract";
import {
  type FilterDocument,
  parseGoalFilter,
  type ScopedDatasetSql,
} from "@/lib/edge/analytics/contract";
import type { QueryWindow } from "@/lib/edge/analytics/providers/d1/internal/core-types";
import {
  type GoalSummaryAggregateRow,
  queryGoalSummaryFromD1,
} from "@/lib/edge/analytics/providers/d1/internal/goal-summary";
import { queryGoalDefinition } from "@/lib/edge/analytics/providers/d1/internal/goals";
import type { Env } from "@/lib/edge/types";

export interface GoalMetricSummary {
  readonly total: number;
  readonly converted: number;
  readonly conversionRate: number;
}

export interface SiteGoalSummaryInput {
  readonly env: Env;
  readonly siteId: string;
  readonly goalId: string;
  readonly window: QueryWindow;
  readonly filters: FilterDocument;
  readonly scopedDataset?: ScopedDatasetSql;
}

export interface SiteGoalSummaryResult {
  readonly goal: GoalDefinition;
  readonly summary: {
    readonly sessions: GoalMetricSummary;
    readonly visitors: GoalMetricSummary;
  };
}

function metric(total: number, converted: number): GoalMetricSummary {
  const safeTotal = Number.isFinite(total) && total > 0 ? Math.floor(total) : 0;
  const safeConverted = Math.min(
    safeTotal,
    Number.isFinite(converted) && converted > 0 ? Math.floor(converted) : 0,
  );
  return {
    total: safeTotal,
    converted: safeConverted,
    conversionRate: safeTotal > 0 ? safeConverted / safeTotal : 0,
  };
}

function summary(
  goal: GoalDefinition,
  row: GoalSummaryAggregateRow,
): SiteGoalSummaryResult {
  return {
    goal,
    summary: {
      sessions: metric(row.totalSessions, row.convertedSessions),
      visitors: metric(row.totalVisitors, row.convertedVisitors),
    },
  };
}

/** Runtime provider boundary for the typed Goal summary operation. */
export async function readSiteGoalSummary(
  input: SiteGoalSummaryInput,
): Promise<SiteGoalSummaryResult | null> {
  const goal = await queryGoalDefinition(input.env, input.siteId, input.goalId);
  if (!goal) return null;
  const aggregate = await queryGoalSummaryFromD1(
    input.env,
    input.siteId,
    input.window,
    input.filters,
    parseGoalFilter(goal),
    input.scopedDataset,
  );
  return summary(goal, aggregate);
}
