import type {
  PageCardTabsData,
  PrivateRequestParams,
} from "@/lib/dashboard/client-data-types";
import {
  emptyPageCardTabs,
  emptyTrend,
} from "@/lib/dashboard/client-empty-data";
import type { TimeWindow } from "@/lib/dashboard/query-state";
import type {
  BrowserTrendData,
  PagesDashboardData,
  PagesData,
} from "@/lib/edge-client";
import type { FilterDocument } from "@/lib/filter-contract";

import { fetchTrend } from "./client-core-data";
import { fetchPrivateJson } from "./client-request";
import { withFilters } from "./client-utils";

function fallbackUnlessAborted<T>(error: unknown, fallback: () => T): T {
  if (error instanceof Error && error.name === "AbortError") throw error;
  return fallback();
}

export async function fetchPagesDashboard(
  siteId: string,
  window: TimeWindow,
  filters?: FilterDocument,
  options?: {
    page?: number;
    pageSize?: number;
    signal?: AbortSignal;
  },
): Promise<PagesDashboardData> {
  return fetchPrivateJson<PagesDashboardData>(
    "/api/private/pages-dashboard",
    withFilters(
      {
        siteId,
        from: window.from,
        to: window.to,
        timeZone: window.timeZone,
        interval: window.interval,
        page: options?.page ?? 1,
        pageSize: options?.pageSize ?? 12,
      },
      filters,
    ),
    { signal: options?.signal },
  );
}

export async function fetchPagesShareTrend(
  siteId: string,
  window: TimeWindow,
  filters?: FilterDocument,
  options?: {
    limit?: number;
    signal?: AbortSignal;
  },
): Promise<BrowserTrendData> {
  const limit = Math.max(1, Math.min(options?.limit ?? 5, 12));
  const [payload, totalTrend] = await Promise.all([
    fetchPagesDashboard(siteId, window, filters, {
      page: 1,
      pageSize: limit,
      signal: options?.signal,
    }).catch((error) =>
      fallbackUnlessAborted(
        error,
        () =>
          ({
            ok: true,
            interval: window.interval,
            data: [],
            meta: {
              page: 1,
              pageSize: limit,
              returned: 0,
              hasMore: false,
              nextPage: null,
            },
          }) satisfies PagesDashboardData,
      ),
    ),
    fetchTrend(siteId, window, filters, { signal: options?.signal }).catch(
      (error) =>
        fallbackUnlessAborted(error, () => emptyTrend(window.interval)),
    ),
  ]);

  const series: BrowserTrendData["series"] = payload.data.map(
    (item, index) => ({
      key: `page_${index}`,
      label: item.pathname,
      views: item.metrics.views,
      visitors: item.metrics.views,
      sessions: item.metrics.sessions,
    }),
  );

  const pointByTimestamp = new Map<
    number,
    {
      timestampMs: number;
      totalVisitors: number;
      visitorsBySeries: Record<string, number>;
    }
  >();

  for (const [index, item] of payload.data.entries()) {
    const seriesKey = `page_${index}`;
    for (const point of item.trend) {
      const timestampMs = Number(point.timestampMs ?? 0);
      const value = Math.max(0, Number(point.views ?? 0));
      const current = pointByTimestamp.get(timestampMs) ?? {
        timestampMs,
        totalVisitors: 0,
        visitorsBySeries: {},
      };
      current.totalVisitors += value;
      current.visitorsBySeries[seriesKey] = value;
      pointByTimestamp.set(timestampMs, current);
    }
  }

  for (const point of totalTrend.data) {
    const timestampMs = Number(point.timestampMs ?? 0);
    const totalVisitors = Math.max(0, Number(point.views ?? 0));
    const current = pointByTimestamp.get(timestampMs) ?? {
      timestampMs,
      totalVisitors: 0,
      visitorsBySeries: {},
    };
    current.totalVisitors = Math.max(current.totalVisitors, totalVisitors);
    pointByTimestamp.set(timestampMs, current);
  }

  let otherViews = 0;
  let otherVisitors = 0;
  let otherSessions = 0;

  for (const point of pointByTimestamp.values()) {
    const topSeriesTotal = Object.values(point.visitorsBySeries).reduce(
      (sum, value) => sum + Math.max(0, Number(value ?? 0)),
      0,
    );
    const otherValue = Math.max(0, point.totalVisitors - topSeriesTotal);
    if (otherValue <= 0) continue;
    point.visitorsBySeries.other = otherValue;
    otherViews += otherValue;
    otherVisitors += otherValue;
    otherSessions += otherValue;
  }

  if (otherVisitors > 0) {
    series.push({
      key: "other",
      label: "Other",
      views: otherViews,
      visitors: otherVisitors,
      sessions: otherSessions,
      isOther: true,
    });
  }

  const data = [...pointByTimestamp.values()]
    .sort((left, right) => left.timestampMs - right.timestampMs)
    .map((point, index) => ({
      bucket: index,
      timestampMs: point.timestampMs,
      totalVisitors: point.totalVisitors,
      visitorsBySeries: point.visitorsBySeries,
    }));

  return {
    ok: payload.ok,
    interval: payload.interval,
    series,
    data,
  };
}

export async function fetchPageCardTabs(
  siteId: string,
  window: TimeWindow,
  filters?: FilterDocument,
): Promise<PageCardTabsData> {
  const payload = await fetchPrivateJson<PagesData>(
    "/api/private/pages",
    withFilters(
      {
        siteId,
        from: window.from,
        to: window.to,
        timeZone: window.timeZone,
        limit: 100,
      },
      filters,
    ) satisfies PrivateRequestParams,
  );
  return payload.tabs ?? emptyPageCardTabs();
}
