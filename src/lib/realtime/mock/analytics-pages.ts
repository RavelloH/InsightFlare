import {
  aggregateDimensionRowsFromVisits,
  aggregateOverviewMetrics,
  applyDemoFilters,
  buildDemoFactDataset,
  collectPageDataAndTabs,
  collectReferrerRows,
} from "@/lib/realtime/mock/fact-builder";
import {
  parseDemoFilters,
  parseDemoInterval,
  parseDemoLimit,
  parseDemoNumber,
  withoutDemoGeoFilter,
} from "@/lib/realtime/mock/filters";
import {
  buildDemoTrendBuckets,
  parseDemoTimeZone,
} from "@/lib/realtime/mock/shared";
import type { DemoDimensionRow } from "@/lib/realtime/mock/types";
import {
  DEMO_EMPTY_HASH_VALUE,
  DEMO_EMPTY_QUERY_VALUE,
  demoHashFragmentForVisit,
  demoQueryStringForVisit,
} from "@/lib/realtime/mock/visit-helpers";

export function generateDemoPages(
  siteId: string,
  params: Record<string, string | number>,
): Record<string, unknown> {
  const limit = parseDemoLimit(params.limit, 100, 1, 500);
  const from = parseDemoNumber(params.from, 0);
  const to = parseDemoNumber(params.to, Date.now());
  const filters = parseDemoFilters(params);
  const dataset = buildDemoFactDataset(siteId, from, to);
  const filtered = applyDemoFilters(dataset, filters);
  const pages = collectPageDataAndTabs(dataset, filtered, limit);

  return {
    ok: true,
    data: pages.data,
    tabs: pages.tabs,
  };
}

export function generateDemoPagesDashboard(
  siteId: string,
  params: Record<string, string | number>,
): Record<string, unknown> {
  const page = parseDemoLimit(params.page, 1, 1, 10_000);
  const pageSize = parseDemoLimit(params.pageSize, 12, 1, 24);
  const from = parseDemoNumber(params.from, 0);
  const to = parseDemoNumber(params.to, Date.now());
  const interval = parseDemoInterval(params.interval);
  const filters = parseDemoFilters(params);
  const timeZone = parseDemoTimeZone(params);
  const dataset = buildDemoFactDataset(siteId, from, to);
  const filtered = applyDemoFilters(dataset, filters);
  const allPathRows = aggregateDimensionRowsFromVisits(
    dataset,
    filtered.visits,
    Math.max(filtered.visits.length, page * pageSize + 1),
    (visit) => visit.pathname,
  );
  const offset = (page - 1) * pageSize;
  const requestedRows = allPathRows.slice(offset, offset + pageSize + 1);
  const hasMore = requestedRows.length > pageSize;
  const currentRows = requestedRows.slice(0, pageSize);
  const span = Math.max(0, to - from);
  const previousFrom = Math.max(0, from - span);
  const previousTo = Math.max(previousFrom, from);
  const previousDataset = buildDemoFactDataset(
    siteId,
    previousFrom,
    previousTo,
  );

  const percentDelta = (current: number, previous: number) =>
    previous <= 0 ? null : ((current - previous) / previous) * 100;

  return {
    ok: true,
    interval,
    data: currentRows.map((row) => {
      const pathname = row.label;
      const currentMetrics = aggregateOverviewMetrics(
        dataset,
        applyDemoFilters(dataset, { ...filters, path: pathname }),
      );
      const previousMetrics = aggregateOverviewMetrics(
        previousDataset,
        applyDemoFilters(previousDataset, { ...filters, path: pathname }),
      );
      const currentPagesPerSession =
        currentMetrics.sessions > 0
          ? currentMetrics.views / currentMetrics.sessions
          : 0;
      const previousPagesPerSession =
        previousMetrics.sessions > 0
          ? previousMetrics.views / previousMetrics.sessions
          : 0;
      const titles = aggregateDimensionRowsFromVisits(
        dataset,
        filtered.visits.filter((visit) => visit.pathname === pathname),
        3,
        (visit) => visit.title,
      ).map((titleRow) => titleRow.label);
      const trend = buildDemoTrendBuckets(
        siteId,
        from,
        to,
        interval,
        {
          ...filters,
          path: pathname,
        },
        timeZone,
      ).map((point) => ({
        timestampMs: point.timestampMs,
        views: point.views,
        visitors: point.visitors,
      }));

      return {
        pathname,
        titles,
        trend,
        metrics: {
          views: currentMetrics.views,
          visitors: currentMetrics.visitors,
          sessions: currentMetrics.sessions,
          bounceRate: currentMetrics.bounceRate,
          pagesPerSession: currentPagesPerSession,
          avgDurationMs: currentMetrics.avgDurationMs,
        },
        changeRates: {
          views: percentDelta(currentMetrics.views, previousMetrics.views),
          visitors: percentDelta(
            currentMetrics.visitors,
            previousMetrics.visitors,
          ),
          sessions: percentDelta(
            currentMetrics.sessions,
            previousMetrics.sessions,
          ),
          bounceRate: percentDelta(
            currentMetrics.bounceRate,
            previousMetrics.bounceRate,
          ),
          pagesPerSession: percentDelta(
            currentPagesPerSession,
            previousPagesPerSession,
          ),
          avgDurationMs: percentDelta(
            currentMetrics.avgDurationMs,
            previousMetrics.avgDurationMs,
          ),
        },
      };
    }),
    meta: {
      page,
      pageSize,
      returned: currentRows.length,
      hasMore,
      nextPage: hasMore ? page + 1 : null,
    },
  };
}

export function generateDemoReferrers(
  siteId: string,
  params: Record<string, string | number>,
): Record<string, unknown> {
  const limit = parseDemoLimit(params.limit, 100, 1, 500);
  const from = parseDemoNumber(params.from, 0);
  const to = parseDemoNumber(params.to, Date.now());
  const filters = parseDemoFilters(params);
  const dataset = buildDemoFactDataset(siteId, from, to);
  const filtered = applyDemoFilters(dataset, filters);

  return {
    ok: true,
    data: collectReferrerRows(dataset, filtered, limit),
  };
}

export function generateDemoReferrerSummary(
  siteId: string,
  params: Record<string, string | number>,
): Record<string, unknown> {
  const topN = parseDemoLimit(params.topN, 5, 1, 20);
  const from = parseDemoNumber(params.from, 0);
  const to = parseDemoNumber(params.to, Date.now());
  const filters = parseDemoFilters(params);
  const dataset = buildDemoFactDataset(siteId, from, to);
  const filtered = applyDemoFilters(dataset, filters);
  const domains = new Set<string>();
  const links = new Set<string>();
  let directViews = 0;
  for (const visit of filtered.visits) {
    const domain = visit.referrerHost.trim();
    const link = visit.referrerUrl.trim();
    if (domain) domains.add(domain);
    else directViews += dataset.viewWeight;
    if (link) links.add(link);
  }
  const totalViews = filtered.visits.length * dataset.viewWeight;
  const topSources = collectReferrerRows(dataset, filtered, topN + 1).filter(
    (row) => row.referrer !== "(direct)",
  );
  return {
    ok: true,
    data: {
      totalViews,
      directViews,
      externalViews: totalViews - directViews,
      uniqueDomains: domains.size,
      uniqueLinks: links.size,
      truncated: topSources.length > topN,
      topSources: topSources.slice(0, topN).map((row) => ({
        referrer: row.referrer,
        views: row.views,
      })),
    },
  };
}

export function generateDemoDimension(
  siteId: string,
  dimensionType: string,
  params: Record<string, string | number>,
): Record<string, unknown> {
  const limit = parseDemoLimit(params.limit, 20, 1, 500);
  const from = parseDemoNumber(params.from, 0);
  const to = parseDemoNumber(params.to, Date.now());
  let filters = parseDemoFilters(params);
  if (dimensionType === "countries") {
    filters = withoutDemoGeoFilter(filters);
  }
  const dataset = buildDemoFactDataset(siteId, from, to);
  const filtered = applyDemoFilters(dataset, filters);

  let rows: DemoDimensionRow[] = [];
  if (dimensionType === "countries") {
    rows = aggregateDimensionRowsFromVisits(
      dataset,
      filtered.visits,
      limit,
      (visit) => visit.country,
    );
  } else if (dimensionType === "devices") {
    rows = aggregateDimensionRowsFromVisits(
      dataset,
      filtered.visits,
      limit,
      (visit) => visit.deviceType,
    );
  } else if (dimensionType === "page-hash") {
    rows = aggregateDimensionRowsFromVisits(
      dataset,
      filtered.visits,
      limit,
      (visit) => demoHashFragmentForVisit(visit) || DEMO_EMPTY_HASH_VALUE,
    );
  } else if (dimensionType === "page-query") {
    rows = aggregateDimensionRowsFromVisits(
      dataset,
      filtered.visits,
      limit,
      (visit) => demoQueryStringForVisit(visit) || DEMO_EMPTY_QUERY_VALUE,
    );
  } else if (dimensionType === "event-types") {
    rows = aggregateDimensionRowsFromVisits(
      dataset,
      filtered.visits,
      limit,
      (visit) => (visit.eventType === "pageview" ? "" : visit.eventType),
    );
  }

  return {
    ok: true,
    data: rows
      .map((row) => ({
        value:
          row.label === DEMO_EMPTY_HASH_VALUE ||
          row.label === DEMO_EMPTY_QUERY_VALUE
            ? ""
            : row.label,
        views: row.views,
        sessions: row.sessions,
        visitors: row.visitors,
      }))
      .sort((a, b) => b.views - a.views),
  };
}
