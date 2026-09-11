import {
  attachFilterScopePreference,
  type FilterDocument,
  filterScopePreferenceFromDocument,
} from "@/lib/filter-contract";

import {
  type DashboardComparisonMode,
  parseDashboardComparisonSearchParams,
} from "./filter-state";
import type { TimeWindow } from "./query-state";

export interface DashboardComparisonQuery {
  readonly mode: DashboardComparisonMode;
  readonly window: TimeWindow;
  readonly filters: FilterDocument;
}

function previousComparisonWindow(window: TimeWindow): TimeWindow | null {
  const from = Math.max(0, Math.floor(window.from));
  const to = Math.max(from + 1, Math.floor(window.to));
  const span = Math.max(1, to - from);
  const previousTo = Math.max(from - 1, 0);
  const previousFrom = Math.max(previousTo - span, 0);

  if (previousFrom >= previousTo) return null;

  return {
    ...window,
    from: previousFrom,
    to: previousTo,
  };
}

/**
 * Resolves the comparison request that should accompany a dashboard query.
 *
 * A previous-period comparison without compareFilter follows the current
 * filter. A same-period comparison is only valid when compareFilter exists;
 * parseDashboardComparisonSearchParams already enforces that rule.
 */
export function resolveDashboardComparisonQuery(
  searchParams: URLSearchParams,
  currentWindow: TimeWindow,
  currentFilters: FilterDocument,
): DashboardComparisonQuery | null {
  const state = parseDashboardComparisonSearchParams(searchParams);
  if (!state.mode) return null;

  const comparisonWindow =
    state.mode === "same"
      ? currentWindow
      : previousComparisonWindow(currentWindow);
  if (!comparisonWindow) return null;

  const comparisonFilters = state.filterDocument.root
    ? attachFilterScopePreference(
        state.filterDocument,
        filterScopePreferenceFromDocument(currentFilters) ?? "auto",
      )
    : currentFilters;

  return {
    mode: state.mode,
    window: comparisonWindow,
    filters: comparisonFilters,
  };
}
