import {
  aggregateDimensionRowsFromVisits,
  aggregateOverviewMetrics,
  applyDemoFilters,
  buildDemoFactDataset,
  collectPageDataAndTabs,
  collectReferrerRows,
} from "@/lib/realtime/mock/fact-builder";
import {
  parseDemoBoolean,
  parseDemoFilters,
  parseDemoInterval,
  parseDemoNumber,
  parseDemoQueryLimit,
  withoutDemoGeoFilter,
} from "@/lib/realtime/mock/filters";
import { demoPage } from "@/lib/realtime/mock/pagination";
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
  options: { includeTabs?: boolean; defaultLimit?: number } = {},
): Record<string, unknown> {
  const from = parseDemoNumber(params.from, 0);
  const to = parseDemoNumber(params.to, Date.now());
  const filters = parseDemoFilters(params);
  const includeDetails = parseDemoBoolean(params.details);
  const dataset = buildDemoFactDataset(siteId, from, to);
  const filtered = applyDemoFilters(dataset, filters);
  const allPages = aggregateDimensionRowsFromVisits(
    dataset,
    filtered.visits,
    Math.max(1, filtered.visits.length),
    (visit) =>
      includeDetails
        ? [
            visit.pathname,
            demoQueryStringForVisit(visit),
            demoHashFragmentForVisit(visit),
          ].join("\u001f")
        : visit.pathname,
  );
  const page = demoPage(
    allPages.map((row) => ({
      pathname: row.label.split("\u001f")[0] ?? row.label,
      query: includeDetails ? (row.label.split("\u001f")[1] ?? "") : "",
      hash: includeDetails ? (row.label.split("\u001f")[2] ?? "") : "",
      views: row.views,
      sessions: row.sessions,
    })),
    params,
    {
      operation: "pages",
      siteId,
      from,
      to,
      filters,
      search: String(params.search ?? "")
        .trim()
        .toLowerCase(),
      sort: String(params.sort ?? params.sortBy ?? "views"),
      direction: String(params.direction ?? params.sortDir ?? "desc"),
    },
    options.defaultLimit ?? 20,
    200,
  );
  const pages = collectPageDataAndTabs(dataset, filtered, 100);

  const result: Record<string, unknown> = {
    ok: true,
    data: {
      items: page.items,
      pagination: page.pagination,
    },
  };
  if (options.includeTabs !== false) result.tabs = pages.tabs;
  return result;
}

export function generateDemoPagesDashboard(
  siteId: string,
  params: Record<string, string | number>,
): Record<string, unknown> {
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
    Math.max(1, filtered.visits.length),
    (visit) => visit.pathname,
  );
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

  const page = demoPage(
    allPathRows.map((row) => row.label),
    params,
    {
      operation: "pages-dashboard",
      siteId,
      from,
      to,
      interval,
      timeZone,
      filters,
      includeDetails: true,
      sort: "views:desc,sessions:desc,pathname:asc",
    },
    12,
    24,
  );
  const items = page.items.flatMap((pathname) => {
    const row = allPathRows.find((candidate) => candidate.label === pathname);
    if (!row) return [];
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
      { ...filters, path: pathname },
      timeZone,
    ).map((point) => ({
      timestampMs: point.timestampMs,
      views: point.views,
      visitors: point.visitors,
    }));
    return [
      {
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
      },
    ];
  });

  return {
    ok: true,
    interval,
    data: { items, pagination: page.pagination },
  };
}

export function generateDemoReferrers(
  siteId: string,
  params: Record<string, string | number>,
  options: { allowFullUrl?: boolean; defaultLimit?: number } = {},
): Record<string, unknown> {
  const from = parseDemoNumber(params.from, 0);
  const to = parseDemoNumber(params.to, Date.now());
  const filters = parseDemoFilters(params);
  const dataset = buildDemoFactDataset(siteId, from, to);
  const filtered = applyDemoFilters(dataset, filters);
  const includeFullUrl =
    options.allowFullUrl !== false && parseDemoBoolean(params.fullUrl);

  const allRows = collectReferrerRows(
    dataset,
    filtered,
    Math.max(1, filtered.visits.length),
    { includeFullUrl },
  );
  const page = demoPage(
    allRows.map(({ referrer, views, sessions }) => ({
      referrer,
      views,
      sessions,
    })),
    params,
    {
      operation: "referrers",
      siteId,
      from,
      to,
      filters,
      includeFullUrl,
      search: String(params.search ?? "")
        .trim()
        .toLowerCase(),
      sort: String(params.sort ?? params.sortBy ?? "views"),
      direction: String(params.direction ?? params.sortDir ?? "desc"),
    },
    options.defaultLimit ?? 20,
    200,
  );
  return {
    ok: true,
    data: {
      items: page.items,
      pagination: page.pagination,
    },
  };
}

export function generateDemoReferrerSummary(
  siteId: string,
  params: Record<string, string | number>,
): Record<string, unknown> {
  const topN = parseDemoQueryLimit(params.topN, 5, 1, 20);
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
      Math.max(1, filtered.visits.length),
      (visit) => visit.country,
    );
  } else if (dimensionType === "devices") {
    rows = aggregateDimensionRowsFromVisits(
      dataset,
      filtered.visits,
      Math.max(1, filtered.visits.length),
      (visit) => visit.deviceType,
    );
  } else if (dimensionType === "page-hash") {
    rows = aggregateDimensionRowsFromVisits(
      dataset,
      filtered.visits,
      Math.max(1, filtered.visits.length),
      (visit) => demoHashFragmentForVisit(visit) || DEMO_EMPTY_HASH_VALUE,
    );
  } else if (dimensionType === "page-query") {
    rows = aggregateDimensionRowsFromVisits(
      dataset,
      filtered.visits,
      Math.max(1, filtered.visits.length),
      (visit) => demoQueryStringForVisit(visit) || DEMO_EMPTY_QUERY_VALUE,
    );
  } else if (dimensionType === "event-types") {
    rows = aggregateDimensionRowsFromVisits(
      dataset,
      filtered.visits,
      Math.max(1, filtered.visits.length),
      (visit) => (visit.eventType === "pageview" ? "" : visit.eventType),
    );
  }

  const items = rows
    .map((row) => {
      const value =
        row.label === DEMO_EMPTY_HASH_VALUE ||
        row.label === DEMO_EMPTY_QUERY_VALUE
          ? ""
          : row.label;
      return {
        value,
        label: value,
        views: row.views,
        sessions: row.sessions,
        visitors: row.visitors,
      };
    })
    .sort((a, b) => b.views - a.views || a.value.localeCompare(b.value));
  const page = demoPage(
    items,
    params,
    {
      operation: "dimension",
      siteId,
      dimensionType,
      from,
      to,
      filters,
      search: String(params.search ?? "")
        .trim()
        .toLowerCase(),
      sort: "views:desc,value:asc",
    },
    20,
    200,
  );
  return { ok: true, data: page };
}
