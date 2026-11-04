import type {
  FilterDocument,
  OverviewTableMetric,
  OverviewTableSortBy,
  QueryAudience,
  SortDirection,
} from "@/lib/edge/analytics/contract";
import {
  buildComparisonPagePlan,
  type ComparisonDimensionCursor,
} from "@/lib/edge/analytics/engine/comparison-report-plan";
import type { PageDimensionSelection } from "@/lib/edge/analytics/engine/dimension-report-plan";
export type { ComparisonDimensionCursor } from "@/lib/edge/analytics/engine/comparison-report-plan";
import type { Env } from "@/lib/edge/types";

import { queryAnalyticsReportOutputRowsFromD1 } from "./analytics-report-query";
import { buildComparisonDimensionRollupPlan } from "./comparison-dimension-source";
import {
  comparisonCursorBinding,
  type ComparisonDimensionPage,
  comparisonPageFromRows,
} from "./comparison-page-result";
import { comparisonSessionPathCursorExpression } from "./comparison-report-family";
import { buildComparisonSessionPathPlan } from "./comparison-session-path-source";
import type { QueryWindow } from "./core-types";
import type { D1ReadDiagnostics } from "./diagnostics";
import { decodePageCursor, hasExactKeys } from "./pagination";

function decodeComparisonCursor(
  value: unknown,
): ComparisonDimensionCursor | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const candidate = value as Record<string, unknown>;
  return hasExactKeys(candidate, [
    "sortClass",
    "primary",
    "secondary",
    "key",
  ]) &&
    typeof candidate.sortClass === "number" &&
    Number.isFinite(candidate.sortClass) &&
    typeof candidate.primary === "number" &&
    Number.isFinite(candidate.primary) &&
    typeof candidate.secondary === "number" &&
    Number.isFinite(candidate.secondary) &&
    typeof candidate.key === "string"
    ? (candidate as unknown as ComparisonDimensionCursor)
    : null;
}

export async function decodeComparisonDimensionCursor(
  env: Env,
  siteId: string,
  current: QueryWindow,
  currentFilters: FilterDocument,
  reference: QueryWindow,
  referenceFilters: FilterDocument,
  selectExpr: string,
  search: string | undefined,
  cursor: string | null | undefined,
  audience: QueryAudience,
  metric: OverviewTableMetric,
  sortBy: OverviewTableSortBy,
  direction: SortDirection,
): Promise<ComparisonDimensionCursor | null> {
  return decodePageCursor(
    env,
    await comparisonCursorBinding(
      siteId,
      current,
      currentFilters,
      reference,
      referenceFilters,
      selectExpr,
      search,
      audience,
      metric,
      sortBy,
      direction,
    ),
    cursor,
    "overview-table-comparison",
    decodeComparisonCursor,
  );
}

export async function queryComparisonDimensionPageFromD1(
  env: Env,
  siteId: string,
  current: QueryWindow,
  currentFilters: FilterDocument,
  reference: QueryWindow,
  referenceFilters: FilterDocument,
  limit: number,
  selectExpr: string,
  options: {
    metric: OverviewTableMetric;
    sortBy: OverviewTableSortBy;
    direction: SortDirection;
    search?: string;
    selection: PageDimensionSelection;
  },
  cursor: ComparisonDimensionCursor | null,
  audience: QueryAudience,
  diagnostics?: D1ReadDiagnostics,
): Promise<ComparisonDimensionPage> {
  const currentPlan = buildComparisonDimensionRollupPlan({
    siteId,
    window: current,
    filters: currentFilters,
    selection: options.selection,
  });
  const referencePlan = buildComparisonDimensionRollupPlan({
    siteId,
    window: reference,
    filters: referenceFilters,
    selection: options.selection,
  });
  const plan = buildComparisonPagePlan({
    current: currentPlan,
    reference: referencePlan,
    metric: options.metric,
    sortBy: options.sortBy,
    direction: options.direction,
    search: options.search,
    cursor,
    limit,
    childOutputId: "comparison-dimension-rollup",
  });
  const rows = await queryAnalyticsReportOutputRowsFromD1(
    env,
    plan,
    "comparison-page",
    undefined,
    diagnostics,
  );
  return comparisonPageFromRows({
    env,
    rows,
    limit,
    siteId,
    current,
    currentFilters,
    reference,
    referenceFilters,
    selectExpr,
    search: options.search,
    audience,
    metric: options.metric,
    sortBy: options.sortBy,
    direction: options.direction,
  });
}

export type { QualifiedComparisonDimensionExecution } from "./comparison-page-qualification-program";
export { tryQueryQualifiedComparisonDimensionPageFromD1 } from "./comparison-page-qualification-program";

/** Comparison variant for session entry/exit, where each session contributes
 * only its first/last page rather than every page view. */
export async function queryComparisonSessionPathPageFromD1(
  env: Env,
  siteId: string,
  current: QueryWindow,
  currentFilters: FilterDocument,
  reference: QueryWindow,
  referenceFilters: FilterDocument,
  limit: number,
  kind: "entry" | "exit",
  options: {
    metric: OverviewTableMetric;
    sortBy: OverviewTableSortBy;
    direction: SortDirection;
    search?: string;
  },
  cursor: ComparisonDimensionCursor | null,
  audience: QueryAudience,
  diagnostics?: D1ReadDiagnostics,
): Promise<ComparisonDimensionPage> {
  const currentPlan = buildComparisonSessionPathPlan({
    siteId,
    window: current,
    filters: currentFilters,
    kind,
  });
  const referencePlan = buildComparisonSessionPathPlan({
    siteId,
    window: reference,
    filters: referenceFilters,
    kind,
  });
  const plan = buildComparisonPagePlan({
    current: currentPlan,
    reference: referencePlan,
    metric: options.metric,
    sortBy: options.sortBy,
    direction: options.direction,
    search: options.search,
    cursor,
    limit,
    childOutputId: "session-path-comparison-rollup",
  });
  const rows = await queryAnalyticsReportOutputRowsFromD1(
    env,
    plan,
    "comparison-page",
    undefined,
    diagnostics,
  );
  return comparisonPageFromRows({
    env,
    rows,
    limit,
    siteId,
    current,
    currentFilters,
    reference,
    referenceFilters,
    selectExpr: comparisonSessionPathCursorExpression(kind),
    search: options.search,
    audience,
    metric: options.metric,
    sortBy: options.sortBy,
    direction: options.direction,
  });
}
