import { useMemo } from "react";

import { useLiveSearchParams } from "@/lib/client-history";
import {
  type DashboardComparisonQuery,
  resolveDashboardComparisonQuery,
} from "@/lib/dashboard/comparison-query";
import { filterQueryKey } from "@/lib/dashboard/filter-query-key";
import type { TimeWindow } from "@/lib/dashboard/query-state";
import type { FilterDocument } from "@/lib/filter-contract";
import type { AppMessages } from "@/lib/i18n/messages";

export function useDashboardComparisonQuery(
  timeWindow: TimeWindow,
  filters: FilterDocument,
): DashboardComparisonQuery | null {
  const searchParams = useLiveSearchParams();
  const searchParamsKey = searchParams.toString();
  const filtersKey = useMemo(() => filterQueryKey(filters), [filters]);

  return useMemo(
    () =>
      resolveDashboardComparisonQuery(
        new URLSearchParams(searchParamsKey),
        timeWindow,
        filters,
      ),
    [
      filters,
      filtersKey,
      searchParamsKey,
      timeWindow.from,
      timeWindow.interval,
      timeWindow.timeZone,
      timeWindow.to,
    ],
  );
}

export function dashboardComparisonLabel(
  messages: AppMessages,
  comparisonQuery: DashboardComparisonQuery | null | undefined,
): string {
  return comparisonQuery?.mode === "previous" && !comparisonQuery.filters.root
    ? messages.dashboardHeader.previousPeriod
    : messages.dashboardHeader.compareButton;
}
