import { useMemo } from "react";
import { keepPreviousData, useQuery } from "@tanstack/react-query";

import { type MetricAreaPoint } from "@/components/dashboard/charts/metric-area-chart";
import { fetchOverview, fetchTrend } from "@/lib/dashboard/client/data/index";
import { useLiveSearchParams } from "@/lib/dashboard/client/history";
import {
  type DashboardComparisonQuery,
  resolveDashboardComparisonQuery,
} from "@/lib/dashboard/comparison-query";
import { filterQueryKey } from "@/lib/dashboard/filter-query-key";
import type { TimeWindow } from "@/lib/dashboard/query-state";
import type { OverviewData, TrendData } from "@/lib/dashboard-api/client/edge";
import { type FilterDocument } from "@/lib/filter-contract/index";
import type { AppMessages } from "@/lib/i18n/messages";

import {
  emptyOverviewData,
  emptyTrendData,
  fallbackUnlessAborted,
} from "./overview-model";
import {
  type OverviewDataSectionProps,
  type OverviewMetricSeries,
} from "./types";
export function buildOverviewMetricSeries(
  detailSeries: TrendData["data"],
): OverviewMetricSeries {
  const views: MetricAreaPoint[] = [];
  const visitors: MetricAreaPoint[] = [];
  const sessions: MetricAreaPoint[] = [];
  const bounceRate: MetricAreaPoint[] = [];
  const pagesPerSession: MetricAreaPoint[] = [];
  const avgDuration: MetricAreaPoint[] = [];

  for (const point of detailSeries) {
    const { timestampMs } = point;
    views.push({ timestampMs, value: point.views });
    visitors.push({ timestampMs, value: point.visitors });
    sessions.push({ timestampMs, value: point.sessions });

    if (point.sessions > 0) {
      bounceRate.push({
        timestampMs,
        value: point.bounces / point.sessions,
      });
      pagesPerSession.push({
        timestampMs,
        value: point.views / point.sessions,
      });
    }

    if (point.views > 0) {
      avgDuration.push({ timestampMs, value: point.avgDurationMs });
    }
  }

  return {
    views,
    visitors,
    sessions,
    bounceRate,
    pagesPerSession,
    avgDuration,
  };
}
export function comparisonLabelForQuery(
  messages: AppMessages,
  comparisonQuery: DashboardComparisonQuery | null,
): string {
  return comparisonQuery?.mode === "previous" && !comparisonQuery.filters.root
    ? messages.dashboardHeader.previousPeriod
    : messages.dashboardHeader.compareButton;
}
export function useOverviewComparisonQuery(
  timeWindow: TimeWindow,
  filters: FilterDocument,
  enabled = true,
): DashboardComparisonQuery | null {
  const searchParams = useLiveSearchParams();
  const searchParamsKey = searchParams.toString();
  const filtersKey = useMemo(() => filterQueryKey(filters), [filters]);

  return useMemo(
    () =>
      enabled
        ? resolveDashboardComparisonQuery(
            new URLSearchParams(searchParamsKey),
            timeWindow,
            filters,
          )
        : null,
    [
      enabled,
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
export function useOverviewSummaryQuery({
  siteId,
  window: timeWindow,
  filters,
  comparisonQuery,
}: Pick<OverviewDataSectionProps, "siteId" | "window" | "filters"> & {
  comparisonQuery: DashboardComparisonQuery | null;
}) {
  const filtersKey = useMemo(() => filterQueryKey(filters), [filters]);
  const comparisonFiltersKey = useMemo(
    () => (comparisonQuery ? filterQueryKey(comparisonQuery.filters) : "none"),
    [comparisonQuery],
  );
  const comparisonKey = comparisonQuery
    ? [
        comparisonQuery.mode,
        comparisonQuery.window.from,
        comparisonQuery.window.to,
        comparisonQuery.window.interval,
        comparisonQuery.window.timeZone,
        comparisonFiltersKey,
      ]
    : ["none"];

  const resolveTrendData = async (
    overview: OverviewData,
    trendWindow: TimeWindow,
    trendFilters: FilterDocument,
    signal: AbortSignal,
  ): Promise<TrendData> => {
    if (overview.detail) {
      return {
        ok: overview.ok,
        interval: overview.detail.interval,
        data: overview.detail.data,
      };
    }

    return fetchTrend(siteId, trendWindow, trendFilters, { signal }).catch(
      (error) =>
        fallbackUnlessAborted(error, () =>
          emptyTrendData(trendWindow.interval),
        ),
    );
  };

  return useQuery({
    queryKey: [
      "dashboard",
      "overview-summary",
      siteId,
      timeWindow.from,
      timeWindow.to,
      timeWindow.interval,
      timeWindow.timeZone,
      filtersKey,
      "comparison",
      ...comparisonKey,
    ],
    queryFn: async ({ signal }) => {
      if (comparisonQuery) {
        const [current, comparison] = await Promise.all([
          fetchOverview(siteId, timeWindow, filters, {
            includeChange: false,
            includeDetail: true,
            signal,
          }).catch((error) => fallbackUnlessAborted(error, emptyOverviewData)),
          fetchOverview(
            siteId,
            comparisonQuery.window,
            comparisonQuery.filters,
            {
              includeChange: false,
              includeDetail: true,
              signal,
            },
          ).catch((error) => fallbackUnlessAborted(error, emptyOverviewData)),
        ]);
        const [trend, comparisonTrend] = await Promise.all([
          resolveTrendData(current, timeWindow, filters, signal),
          resolveTrendData(
            comparison,
            comparisonQuery.window,
            comparisonQuery.filters,
            signal,
          ),
        ]);

        return {
          overview: current,
          previousOverview: emptyOverviewData(),
          trendData: trend,
          comparisonOverview: comparison,
          comparisonTrendData: comparisonTrend,
          dataWindow: {
            from: timeWindow.from,
            to: timeWindow.to,
            interval: timeWindow.interval,
            timeZone: timeWindow.timeZone,
          },
        };
      }

      const current = await fetchOverview(siteId, timeWindow, filters, {
        includeChange: true,
        includeDetail: true,
        signal,
      }).catch((error) => fallbackUnlessAborted(error, emptyOverviewData));
      const previousTo = Math.max(timeWindow.from - 1, 0);
      const previousFrom = Math.max(
        previousTo - (timeWindow.to - timeWindow.from),
        0,
      );
      const previousWindow: TimeWindow = {
        ...timeWindow,
        from: previousFrom,
        to: previousTo,
      };
      const [previous, trend] = await Promise.all([
        current.previousData
          ? Promise.resolve({
              ok: current.ok,
              data: current.previousData,
            } as OverviewData)
          : fetchOverview(siteId, previousWindow, filters, { signal }).catch(
              (error) => fallbackUnlessAborted(error, emptyOverviewData),
            ),
        current.detail
          ? Promise.resolve({
              ok: current.ok,
              interval: current.detail.interval,
              data: current.detail.data,
            } as TrendData)
          : fetchTrend(siteId, timeWindow, filters, { signal }).catch((error) =>
              fallbackUnlessAborted(error, () =>
                emptyTrendData(timeWindow.interval),
              ),
            ),
      ]);

      return {
        overview: current,
        previousOverview: previous,
        trendData: trend,
        dataWindow: {
          from: timeWindow.from,
          to: timeWindow.to,
          interval: timeWindow.interval,
          timeZone: timeWindow.timeZone,
        },
      };
    },
    enabled: typeof window !== "undefined",
    placeholderData: keepPreviousData,
  });
}
