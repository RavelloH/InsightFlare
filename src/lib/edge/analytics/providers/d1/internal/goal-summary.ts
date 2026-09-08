import {
  createScopedFilterPlan,
  EMPTY_FILTER_DOCUMENT,
  type FilterDocument,
  type ScopedDatasetSql,
} from "@/lib/edge/analytics/contract";
import type { Env } from "@/lib/edge/types";

import { queryD1All } from "./core-sources";
import type { QueryWindow } from "./core-types";
import {
  compileScopedDatasetSql,
  executeObservationFilterOnScopedDataset,
  scopedDatasetFor,
} from "./scoped-dataset";

/** The one-row aggregate returned by the summary statement. */
export interface GoalSummaryAggregateRow {
  readonly totalSessions: number;
  readonly convertedSessions: number;
  readonly totalVisitors: number;
  readonly convertedVisitors: number;
}

/**
 * The base dataset is normally prepared by the typed-query application
 * service and attached to the query's filter metadata.  Keep the empty-filter
 * compatibility path identical to Funnel: only an unprepared empty document
 * may compile a new base dataset here.
 */
function baseGoalDataset(
  siteId: string,
  window: QueryWindow,
  globalFilters: FilterDocument,
  preparedDataset?: ScopedDatasetSql | null,
): ScopedDatasetSql {
  if (preparedDataset) return preparedDataset;

  const dataset = scopedDatasetFor(siteId, window, globalFilters);
  if (dataset) return dataset;
  if (globalFilters.root !== null) {
    throw new Error("scoped_dataset_required");
  }

  const plan = createScopedFilterPlan(
    "goal-summary",
    EMPTY_FILTER_DOCUMENT,
    "event",
  );
  if (!plan) throw new Error("goal_scope_unavailable");
  return compileScopedDatasetSql({
    filters: EMPTY_FILTER_DOCUMENT,
    plan,
    siteIds: [siteId],
    window,
  });
}

function countValue(value: unknown): number {
  const count = Number(value ?? 0);
  return Number.isFinite(count) && count > 0 ? Math.floor(count) : 0;
}

/**
 * Execute Goal summary as one D1 statement.  The goal filter is already
 * parsed by the Goal codec before it reaches this engine.  Both global and
 * goal scopes stay in SQL; only the four scalar counts cross the worker
 * boundary.
 */
export async function queryGoalSummaryFromD1(
  env: Env,
  siteId: string,
  window: QueryWindow,
  globalFilters: FilterDocument,
  goalFilter: FilterDocument,
  preparedDataset?: ScopedDatasetSql | null,
): Promise<GoalSummaryAggregateRow> {
  const dataset = baseGoalDataset(
    siteId,
    window,
    globalFilters,
    preparedDataset,
  );
  const goal = executeObservationFilterOnScopedDataset(
    dataset,
    goalFilter,
    "goal",
  );
  const rows = await queryD1All<Record<string, unknown>>(
    env,
    `WITH
${dataset.ctes.trim()},
${goal.ctes.trim()}
SELECT
  (SELECT COUNT(*) FROM ${dataset.sessionRelation}) AS totalSessions,
  (SELECT COUNT(*) FROM ${goal.sessionRelation}) AS convertedSessions,
  (SELECT COUNT(*) FROM ${dataset.visitorRelation}) AS totalVisitors,
  (SELECT COUNT(*) FROM ${goal.visitorRelation}) AS convertedVisitors
`,
    [
      ...dataset.bindings.map((binding) => binding.value),
      ...goal.bindings.map((binding) => binding.value),
    ],
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
