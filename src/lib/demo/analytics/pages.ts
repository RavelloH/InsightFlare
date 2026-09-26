import {
  buildDemoComparisonRows,
  resolveDemoComparison,
} from "@/lib/demo/realtime/comparison";
import {
  aggregateDimensionRowsFromVisits,
  aggregateOverviewMetrics,
  applyDemoFilters,
  buildDemoFactDataset,
  collectPageDataAndTabs,
  collectReferrerRows,
} from "@/lib/demo/realtime/fact-builder";
import {
  parseDemoBoolean,
  parseDemoFilters,
  parseDemoInterval,
  parseDemoNumber,
  parseDemoQueryLimit,
  withoutDemoGeoFilter,
} from "@/lib/demo/realtime/filters";
import { demoPage } from "@/lib/demo/realtime/pagination";
import {
  buildDemoTrendBuckets,
  parseDemoTimeZone,
} from "@/lib/demo/realtime/shared";
import type { DemoDimensionRow } from "@/lib/demo/realtime/types";
import {
  DEMO_EMPTY_HASH_VALUE,
  DEMO_EMPTY_QUERY_VALUE,
  demoHashFragmentForVisit,
  demoQueryStringForVisit,
} from "@/lib/demo/realtime/visit-helpers";
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
  const comparison = resolveDemoComparison(params, filters);
  const referenceDataset = comparison
    ? buildDemoFactDataset(siteId, comparison.from, comparison.to)
    : null;
  const span = Math.max(0, to - from);
  const previousFrom = Math.max(0, from - span);
  const previousTo = Math.max(previousFrom, from);
  const previousDataset = comparison
    ? null
    : buildDemoFactDataset(siteId, previousFrom, previousTo);
  const referenceFilters = comparison?.filters ?? null;
  const referenceFiltered =
    referenceDataset && referenceFilters
      ? applyDemoFilters(referenceDataset, referenceFilters)
      : null;
  const referencePathRows = referenceFiltered
    ? aggregateDimensionRowsFromVisits(
        referenceDataset!,
        referenceFiltered.visits,
        Math.max(1, referenceFiltered.visits.length),
        (visit) => visit.pathname,
      )
    : [];
  const pathnames = Array.from(
    new Set([
      ...allPathRows.map((row) => row.label),
      ...referencePathRows.map((row) => row.label),
    ]),
  );

  const percentDelta = (current: number, previous: number) =>
    previous <= 0 ? null : ((current - previous) / previous) * 100;

  const pageRows = pathnames.map((pathname) => {
    const currentMetrics = aggregateOverviewMetrics(
      dataset,
      applyDemoFilters(dataset, { ...filters, path: pathname }),
    );
    const referenceMetrics =
      referenceDataset && referenceFilters
        ? aggregateOverviewMetrics(
            referenceDataset,
            applyDemoFilters(referenceDataset, {
              ...referenceFilters,
              path: pathname,
            }),
          )
        : null;
    const currentPagesPerSession =
      currentMetrics.sessions > 0
        ? currentMetrics.views / currentMetrics.sessions
        : 0;
    const referencePagesPerSession =
      referenceMetrics && referenceMetrics.sessions > 0
        ? referenceMetrics.views / referenceMetrics.sessions
        : 0;
    const metricValues = {
      views: currentMetrics.views,
      visitors: currentMetrics.visitors,
      sessions: currentMetrics.sessions,
      bounceRate: currentMetrics.bounceRate,
      pagesPerSession: currentPagesPerSession,
      avgDurationMs: currentMetrics.avgDurationMs,
    };
    const referenceValues = referenceMetrics
      ? {
          views: referenceMetrics.views,
          visitors: referenceMetrics.visitors,
          sessions: referenceMetrics.sessions,
          bounceRate: referenceMetrics.bounceRate,
          pagesPerSession: referencePagesPerSession,
          avgDurationMs: referenceMetrics.avgDurationMs,
        }
      : null;
    const previousMetrics =
      previousDataset && !comparison
        ? aggregateOverviewMetrics(
            previousDataset,
            applyDemoFilters(previousDataset, { ...filters, path: pathname }),
          )
        : null;
    const previousValues = previousMetrics
      ? {
          views: previousMetrics.views,
          visitors: previousMetrics.visitors,
          sessions: previousMetrics.sessions,
          bounceRate: previousMetrics.bounceRate,
          pagesPerSession:
            previousMetrics.sessions > 0
              ? previousMetrics.views / previousMetrics.sessions
              : 0,
          avgDurationMs: previousMetrics.avgDurationMs,
        }
      : null;
    const changeReferenceValues = referenceValues ?? previousValues;
    const change = changeReferenceValues
      ? Object.fromEntries(
          Object.keys(metricValues).map((key) => {
            const metric = key as keyof typeof metricValues;
            const current = metricValues[metric];
            const reference = changeReferenceValues[metric];
            return [
              metric,
              {
                absolute: current - reference,
                relative: percentDelta(current, reference),
              },
            ];
          }),
        )
      : undefined;
    return {
      label: pathname,
      views: currentMetrics.views,
      visitors: currentMetrics.visitors,
      sessions: currentMetrics.sessions,
      metrics: metricValues,
      reference: referenceValues,
      change,
    };
  });
  const page = demoPage(
    pageRows,
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
      sort: String(params.sort ?? "views"),
      direction: String(params.direction ?? "desc"),
    },
    12,
    25,
    true,
    {
      search: String(params.search ?? ""),
      getSearchValues: (row) => [row.label],
      compare: (left, right) => {
        const direction = params.direction === "asc" ? 1 : -1;
        const metric = String(
          params.compare === "same" || params.compare === "previous"
            ? (params.metric ?? "views")
            : (params.sort ?? "views"),
        ) as keyof typeof left.metrics;
        const sortBy = String(params.sortBy ?? "current");
        const value = (row: typeof left) => {
          if (sortBy === "reference") {
            return Number(row.reference?.[metric] ?? 0);
          }
          if (sortBy === "change") {
            return Number(row.change?.[metric]?.relative ?? 0);
          }
          return Number(row.metrics[metric] ?? 0);
        };
        const leftValue = value(left);
        const rightValue = value(right);
        return (
          (leftValue - rightValue) * direction ||
          left.label.localeCompare(right.label)
        );
      },
    },
  );
  const items = page.items.flatMap((pathname) => {
    const row = pageRows.find(
      (candidate) => candidate.label === pathname.label,
    );
    if (!row) return [];
    const currentMetrics = aggregateOverviewMetrics(
      dataset,
      applyDemoFilters(dataset, { ...filters, path: row.label }),
    );
    const currentPagesPerSession = row.metrics.pagesPerSession;
    const titles = aggregateDimensionRowsFromVisits(
      dataset,
      filtered.visits.filter((visit) => visit.pathname === row.label),
      3,
      (visit) => visit.title,
    ).map((titleRow) => titleRow.label);
    const trend = buildDemoTrendBuckets(
      siteId,
      from,
      to,
      interval,
      { ...filters, path: row.label },
      timeZone,
      dataset,
    ).map((point) => ({
      timestampMs: point.timestampMs,
      views: point.views,
      visitors: point.visitors,
    }));
    const referenceTrend =
      referenceDataset && referenceFilters && comparison
        ? buildDemoTrendBuckets(
            siteId,
            comparison.from,
            comparison.to,
            interval,
            { ...referenceFilters, path: row.label },
            timeZone,
          ).map((point) => ({
            timestampMs: point.timestampMs,
            views: point.views,
            visitors: point.visitors,
          }))
        : undefined;
    return [
      {
        pathname: row.label,
        titles,
        trend,
        ...(referenceTrend ? { referenceTrend } : {}),
        metrics: {
          views: currentMetrics.views,
          visitors: currentMetrics.visitors,
          sessions: currentMetrics.sessions,
          bounceRate: currentMetrics.bounceRate,
          pagesPerSession: currentPagesPerSession,
          avgDurationMs: currentMetrics.avgDurationMs,
        },
        changeRates: row.change
          ? Object.fromEntries(
              Object.entries(row.change).map(([key, value]) => [
                key,
                value.relative,
              ]),
            )
          : {
              views: null,
              visitors: null,
              sessions: null,
              bounceRate: null,
              pagesPerSession: null,
              avgDurationMs: null,
            },
        ...(row.reference && row.change
          ? {
              reference: row.reference,
              change: Object.fromEntries(
                Object.entries(row.change).map(([key, value]) => [
                  key,
                  {
                    absolute: value.absolute,
                    relative: value.relative,
                  },
                ]),
              ),
            }
          : {}),
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
  const comparison = resolveDemoComparison(params, filters);
  const comparisonItems = comparison
    ? (() => {
        const referenceDataset = buildDemoFactDataset(
          siteId,
          comparison.from,
          comparison.to,
        );
        const referenceFilters =
          dimensionType === "countries"
            ? withoutDemoGeoFilter(comparison.filters)
            : comparison.filters;
        const referenceFiltered = applyDemoFilters(
          referenceDataset,
          referenceFilters,
        );
        const referenceRows = aggregateDimensionRowsFromVisits(
          referenceDataset,
          referenceFiltered.visits,
          Math.max(1, referenceFiltered.visits.length),
          (visit) => {
            if (dimensionType === "countries") return visit.country;
            if (dimensionType === "devices") return visit.deviceType;
            if (dimensionType === "page-hash") {
              return demoHashFragmentForVisit(visit) || DEMO_EMPTY_HASH_VALUE;
            }
            if (dimensionType === "page-query") {
              return demoQueryStringForVisit(visit) || DEMO_EMPTY_QUERY_VALUE;
            }
            return visit.eventType === "pageview" ? "" : visit.eventType;
          },
        ).map((row) => {
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
        });
        return buildDemoComparisonRows(items, referenceRows, params);
      })()
    : items;
  const page = demoPage(
    comparisonItems,
    params,
    {
      operation: "dimension",
      siteId,
      dimensionType,
      from,
      to,
      filters,
      compare: params.compare ?? null,
      metric: params.metric ?? null,
      sortBy: params.sortBy ?? null,
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
