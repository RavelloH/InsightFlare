import { queryLegacyD1All } from "@/lib/edge/__tests__/legacy-d1-oracle";
import {
  createScopedFilterPlan,
  EMPTY_FILTER_DOCUMENT,
  type FilterDocument,
} from "@/lib/edge/analytics/contract";
import {
  compileScopedDatasetSql,
  executeObservationFilterOnScopedDataset,
  scopedDatasetFor,
  type ScopedDatasetSql,
} from "@/lib/edge/analytics/providers/d1/internal/__tests__/journey-list-parent-scoped-oracle";
import type { QueryWindow } from "@/lib/edge/analytics/providers/d1/internal/core-types";
import type { Env } from "@/lib/edge/types";

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

/** Preserve the exact parent SQL and bindings for test-only offline execution. */
export function compileGoalSummaryParentOracleStatement(
  siteId: string,
  window: QueryWindow,
  globalFilters: FilterDocument,
  goalFilter: FilterDocument,
  preparedDataset?: ScopedDatasetSql | null,
): { readonly sql: string; readonly bindings: Array<string | number | null> } {
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
  return {
    sql: `WITH
${dataset.ctes.trim()},
${goal.ctes.trim()}
SELECT
  (SELECT COUNT(*) FROM ${dataset.sessionRelation}) AS totalSessions,
  (SELECT COUNT(*) FROM ${goal.sessionRelation}) AS convertedSessions,
  (SELECT COUNT(*) FROM ${dataset.visitorRelation}) AS totalVisitors,
  (SELECT COUNT(*) FROM ${goal.visitorRelation}) AS convertedVisitors
`,
    bindings: [
      ...dataset.bindings.map((binding) => binding.value),
      ...goal.bindings.map((binding) => binding.value),
    ],
  };
}

/** Use the parent mapper for guarded and offline-oracle result paths. */
export function mapGoalSummaryParentOracleRow(
  row: Record<string, unknown>,
): GoalSummaryAggregateRow {
  return {
    totalSessions: countValue(row.totalSessions),
    convertedSessions: countValue(row.convertedSessions),
    totalVisitors: countValue(row.totalVisitors),
    convertedVisitors: countValue(row.convertedVisitors),
  };
}

/**
 * Execute Goal summary as one D1 statement.  The goal filter is already
 * parsed by the Goal codec before it reaches this engine.  Both global and
 * goal scopes stay in SQL; only the four scalar counts cross the worker
 * boundary.
 */
export async function queryGoalSummaryParentOracle(
  env: Env,
  siteId: string,
  window: QueryWindow,
  globalFilters: FilterDocument,
  goalFilter: FilterDocument,
  preparedDataset?: ScopedDatasetSql | null,
): Promise<GoalSummaryAggregateRow> {
  const statement = compileGoalSummaryParentOracleStatement(
    siteId,
    window,
    globalFilters,
    goalFilter,
    preparedDataset,
  );
  const rows = await queryLegacyD1All<Record<string, unknown>>(
    env,
    statement.sql,
    statement.bindings,
  );
  return mapGoalSummaryParentOracleRow(rows[0] ?? {});
}

/** Short alias for callers that use the operation name without the D1 suffix. */
