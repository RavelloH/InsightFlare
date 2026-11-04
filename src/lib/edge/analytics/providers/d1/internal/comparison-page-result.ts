import type {
  FilterDocument,
  OverviewTableMetric,
  OverviewTableSortBy,
  QueryAudience,
  SortDirection,
} from "@/lib/edge/analytics/contract";
import {
  analyticsFilterRegistry,
  effectiveScopeForPagination,
  filterFingerprint,
} from "@/lib/edge/analytics/contract";
import type { ComparisonDimensionCursor } from "@/lib/edge/analytics/engine/comparison-report-plan";
import type { Env } from "@/lib/edge/types";

import type { DimensionRow, QueryWindow } from "./core-types";
import {
  encodePageCursor,
  pageResult,
  paginationBindingForWindow,
} from "./pagination";

export type ComparisonDimensionPageRow = DimensionRow & {
  readonly key: string;
  readonly reference: {
    readonly views: number;
    readonly sessions: number;
    readonly visitors: number;
  };
  readonly change: {
    readonly views: {
      readonly absolute: number;
      readonly relative: number | null;
    };
    readonly sessions: {
      readonly absolute: number;
      readonly relative: number | null;
    };
    readonly visitors: {
      readonly absolute: number;
      readonly relative: number | null;
    };
  };
};

export type ComparisonDimensionPage = {
  readonly items: readonly ComparisonDimensionPageRow[];
  readonly pagination: {
    readonly limit: number;
    readonly returned: number;
    readonly hasMore: boolean;
    readonly nextCursor: string | null;
  };
};

export function mapComparisonRows(
  rows: readonly Record<string, unknown>[],
): ComparisonDimensionPageRow[] {
  return rows.map((row) => {
    const number = (name: string) => Number(row[name] ?? 0);
    const currentViews = number("currentViews");
    const currentSessions = number("currentSessions");
    const currentVisitors = number("currentVisitors");
    const referenceViews = number("referenceViews");
    const referenceSessions = number("referenceSessions");
    const referenceVisitors = number("referenceVisitors");
    const delta = (a: number, b: number) => ({
      absolute: a - b,
      relative: b === 0 ? (a === 0 ? 0 : null) : (a - b) / b,
    });
    const key = String(row.key ?? "");
    return {
      key,
      value: key,
      views: currentViews,
      sessions: currentSessions,
      visitors: currentVisitors,
      reference: {
        views: referenceViews,
        sessions: referenceSessions,
        visitors: referenceVisitors,
      },
      change: {
        views: delta(currentViews, referenceViews),
        sessions: delta(currentSessions, referenceSessions),
        visitors: delta(currentVisitors, referenceVisitors),
      },
    };
  });
}

export function comparisonCursorBinding(
  siteId: string,
  current: QueryWindow,
  currentFilters: FilterDocument,
  reference: QueryWindow,
  referenceFilters: FilterDocument,
  selectExpr: string,
  search: string | undefined,
  audience: QueryAudience,
  metric: OverviewTableMetric,
  sortBy: OverviewTableSortBy,
  direction: SortDirection,
): Promise<string> {
  return paginationBindingForWindow(current, [
    "analytics-overview-table-comparison-v1",
    audience,
    siteId,
    current.startMs,
    current.endExclusiveMs,
    current.timeZone,
    reference.startMs,
    reference.endExclusiveMs,
    reference.timeZone,
    filterFingerprint(currentFilters, analyticsFilterRegistry),
    effectiveScopeForPagination(currentFilters),
    filterFingerprint(referenceFilters, analyticsFilterRegistry),
    effectiveScopeForPagination(referenceFilters),
    selectExpr,
    search?.trim().toLowerCase() ?? "",
    metric,
    sortBy,
    direction,
  ]);
}

export async function comparisonPageFromRows(input: {
  readonly env: Env;
  readonly rows: readonly Record<string, unknown>[];
  readonly limit: number;
  readonly siteId: string;
  readonly current: QueryWindow;
  readonly currentFilters: FilterDocument;
  readonly reference: QueryWindow;
  readonly referenceFilters: FilterDocument;
  readonly selectExpr: string;
  readonly search: string | undefined;
  readonly audience: QueryAudience;
  readonly metric: OverviewTableMetric;
  readonly sortBy: OverviewTableSortBy;
  readonly direction: SortDirection;
}): Promise<ComparisonDimensionPage> {
  const page = pageResult(mapComparisonRows(input.rows), input.limit);
  const binding = await comparisonCursorBinding(
    input.siteId,
    input.current,
    input.currentFilters,
    input.reference,
    input.referenceFilters,
    input.selectExpr,
    input.search,
    input.audience,
    input.metric,
    input.sortBy,
    input.direction,
  );
  const nextCursor =
    page.hasMore && page.last
      ? await encodePageCursor(input.env, binding, {
          sortClass:
            input.sortBy === "change"
              ? page.last.reference[input.metric] === 0 &&
                page.last[input.metric] > 0
                ? 1
                : 0
              : 0,
          primary:
            input.sortBy === "reference"
              ? page.last.reference[input.metric]
              : input.sortBy === "change"
                ? (page.last.change[input.metric].relative ?? 0)
                : page.last[input.metric],
          secondary:
            input.sortBy === "current"
              ? page.last.reference[input.metric]
              : input.sortBy === "reference"
                ? page.last[input.metric]
                : 0,
          key: page.last.key,
        })
      : null;
  return {
    items: page.rows,
    pagination: {
      limit: input.limit,
      returned: page.rows.length,
      hasMore: page.hasMore,
      nextCursor,
    },
  };
}

export type ComparisonDimensionCursorToken = ComparisonDimensionCursor | null;
