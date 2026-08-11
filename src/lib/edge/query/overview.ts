import {
  hasDashboardFilters,
  queryOverviewForSitesFromHourlyRollups,
  queryTrendForSitesFromHourlyRollups,
} from "@/lib/edge/hourly-rollup";
import type { Env } from "@/lib/edge/types";

import type {
  ClientDimensionKey,
  DashboardFilterOption,
  DashboardFilters,
  Interval,
  OverviewAggregateRow,
  PreferredSourceResult,
  QueryWindow,
  TrendAggregateRow,
} from "./core";
import {
  badRequest,
  buildTimeBuckets,
  buildVisitFilterSql,
  buildVisitSourceCte,
  cityValueExpr,
  clientDimensionDefinition,
  dedupeFilterOptions,
  geoTabLabel,
  jsonResponseWith,
  mapDimensionRowsToFilterOptions,
  mapGeoRowsToFilterOptions,
  mapGeoTabs,
  mapOverviewAggregate,
  mapReferrerRowsToFilterOptions,
  mapTabs,
  mapTrendRows,
  parseBooleanFlag,
  parseBooleanSearchParam,
  parseFilterOptionKey,
  parseFilters,
  parseInterval,
  parseLimit,
  parseWindow,
  percentChange,
  queryD1All,
  regionValueExpr,
  type ResponseContext,
  sourceLabel,
  timeBucketCase,
  timeBucketTimestamp,
  visitSourceBindings,
  withoutFilterKey,
  withoutGeoFilter,
} from "./core";
import {
  type AnalyticsDataSource,
  analyticsDiagnosticHeaders,
  createD1ReadDiagnostics,
  type D1ReadDiagnostics,
} from "./diagnostics";
import {
  queryOverviewClientDimensionsFromD1,
  queryOverviewGeoDimensionsFromD1,
  querySessionBoundaryDimensionFromD1,
} from "./dimensions";
import { queryGeoPointAggregate } from "./journeys";
import {
  queryDimensionAggregate,
  queryPageTabsAggregate,
  queryReferrerAggregate,
} from "./pages";

export async function queryOverviewFromD1(
  env: Env,
  siteId: string,
  window: QueryWindow,
  filters: DashboardFilters,
  diagnostics?: D1ReadDiagnostics,
): Promise<OverviewAggregateRow> {
  const filter = buildVisitFilterSql(filters);
  const sql = `
WITH
${buildVisitSourceCte()},
filtered_visits AS (
  SELECT *
  FROM visit_source
  ${filter.clause}
),
session_rollup AS (
  SELECT session_id, count(*) AS visit_count
  FROM filtered_visits
  WHERE session_id != ''
  GROUP BY session_id
)
SELECT
  count(*) AS views,
  count(DISTINCT CASE WHEN session_id != '' THEN session_id ELSE NULL END) AS sessions,
  count(DISTINCT CASE WHEN visitor_id != '' THEN visitor_id ELSE NULL END) AS visitors,
  COALESCE((SELECT count(*) FROM session_rollup WHERE visit_count = 1), 0) AS bounces,
  COALESCE(sum(CASE WHEN duration_ms IS NOT NULL AND duration_ms >= 0 THEN duration_ms ELSE 0 END), 0) AS totalDuration,
  COALESCE(sum(CASE WHEN duration_ms IS NOT NULL AND duration_ms >= 0 THEN 1 ELSE 0 END), 0) AS durationViews
FROM filtered_visits
`;
  const row =
    (
      await queryD1All<Record<string, unknown>>(
        env,
        sql,
        [...visitSourceBindings(siteId, window), ...filter.bindings],
        diagnostics,
      )
    )[0] ?? {};
  return {
    views: Number(row.views ?? 0),
    sessions: Number(row.sessions ?? 0),
    visitors: Number(row.visitors ?? 0),
    bounces: Number(row.bounces ?? 0),
    totalDuration: Number(row.totalDuration ?? 0),
    durationViews: Number(row.durationViews ?? 0),
  };
}

export async function queryTrendFromD1(
  env: Env,
  siteId: string,
  window: QueryWindow,
  interval: Interval,
  filters: DashboardFilters,
  diagnostics?: D1ReadDiagnostics,
): Promise<TrendAggregateRow[]> {
  const filter = buildVisitFilterSql(filters);
  const buckets = buildTimeBuckets(window, interval);
  const visitBucket = timeBucketCase(buckets, "started_at");
  const sessionBucket = timeBucketCase(buckets, "session_started_at");
  const sql = `
WITH
${buildVisitSourceCte()},
filtered_visits AS (
  SELECT *
  FROM visit_source
  ${filter.clause}
),
visit_bucket_rollup AS (
  SELECT
    ${visitBucket.sql} AS bucket,
    count(*) AS views,
    count(DISTINCT CASE WHEN visitor_id != '' THEN visitor_id ELSE NULL END) AS visitors,
    COALESCE(sum(CASE WHEN duration_ms IS NOT NULL AND duration_ms >= 0 THEN duration_ms ELSE 0 END), 0) AS totalDuration,
    COALESCE(sum(CASE WHEN duration_ms IS NOT NULL AND duration_ms >= 0 THEN 1 ELSE 0 END), 0) AS durationViews
  FROM filtered_visits
  GROUP BY bucket
),
session_rollup AS (
  SELECT
    session_id,
    MIN(started_at) AS session_started_at,
    count(*) AS visit_count
  FROM filtered_visits
  WHERE session_id != ''
  GROUP BY session_id
),
session_bucket_rollup AS (
  SELECT
    ${sessionBucket.sql} AS bucket,
    count(*) AS sessions,
    COALESCE(sum(CASE WHEN visit_count = 1 THEN 1 ELSE 0 END), 0) AS bounces
  FROM session_rollup
  GROUP BY bucket
),
combined AS (
  SELECT bucket, views, visitors, 0 AS sessions, 0 AS bounces, totalDuration, durationViews FROM visit_bucket_rollup
  UNION ALL
  SELECT bucket, 0 AS views, 0 AS visitors, sessions, bounces, 0 AS totalDuration, 0 AS durationViews FROM session_bucket_rollup
)
SELECT
  bucket,
  sum(views) AS views,
  sum(visitors) AS visitors,
  sum(sessions) AS sessions,
  sum(bounces) AS bounces,
  sum(totalDuration) AS totalDuration,
  sum(durationViews) AS durationViews
FROM combined
GROUP BY bucket
ORDER BY bucket ASC
`;
  return (
    await queryD1All<Record<string, unknown>>(
      env,
      sql,
      [
        ...visitSourceBindings(siteId, window),
        ...filter.bindings,
        ...visitBucket.bindings,
        ...sessionBucket.bindings,
      ],
      diagnostics,
    )
  ).map((row) => ({
    bucket: Number(row.bucket ?? 0),
    timestampMs: timeBucketTimestamp(buckets, Number(row.bucket ?? 0)),
    views: Number(row.views ?? 0),
    visitors: Number(row.visitors ?? 0),
    sessions: Number(row.sessions ?? 0),
    bounces: Number(row.bounces ?? 0),
    totalDuration: Number(row.totalDuration ?? 0),
    durationViews: Number(row.durationViews ?? 0),
  }));
}

export async function queryOverviewAggregate(
  env: Env,
  siteId: string,
  window: QueryWindow,
  filters: DashboardFilters,
  diagnostics?: D1ReadDiagnostics,
): Promise<PreferredSourceResult<OverviewAggregateRow>> {
  if (!hasDashboardFilters(filters)) {
    const rollup = await queryOverviewForSitesFromHourlyRollups(
      env,
      [siteId],
      window,
      diagnostics,
    );
    const value = rollup?.get(siteId);
    if (value) {
      return {
        value,
        source: "d1",
        diagnosticSource: "rollup",
        approximateVisitors: false,
      };
    }
  }
  return {
    value: await queryOverviewFromD1(env, siteId, window, filters, diagnostics),
    source: "d1",
    diagnosticSource: "raw",
    approximateVisitors: false,
  };
}

export async function queryTrendAggregate(
  env: Env,
  siteId: string,
  window: QueryWindow,
  interval: Interval,
  filters: DashboardFilters,
  diagnostics?: D1ReadDiagnostics,
): Promise<PreferredSourceResult<TrendAggregateRow[]>> {
  if (!hasDashboardFilters(filters)) {
    const rollup = await queryTrendForSitesFromHourlyRollups(
      env,
      [siteId],
      window,
      interval,
      diagnostics,
    );
    if (rollup) {
      return {
        value: rollup
          .filter((row) => row.siteId === siteId)
          .map(({ siteId: _siteId, ...row }) => row),
        source: "d1",
        diagnosticSource: "rollup",
      };
    }
  }
  return {
    value: await queryTrendFromD1(
      env,
      siteId,
      window,
      interval,
      filters,
      diagnostics,
    ),
    source: "d1",
    diagnosticSource: "raw",
  };
}

export async function buildOverviewClientDimensionTabs(
  env: Env,
  siteId: string,
  window: QueryWindow,
  filters: DashboardFilters,
  limit: number,
) {
  return queryOverviewClientDimensionsFromD1(
    env,
    siteId,
    window,
    filters,
    limit,
  );
}

export async function buildOverviewGeoDimensionTabs(
  env: Env,
  siteId: string,
  window: QueryWindow,
  filters: DashboardFilters,
  limit: number,
) {
  return queryOverviewGeoDimensionsFromD1(env, siteId, window, filters, limit);
}

export async function handleOverview(
  env: Env,
  siteId: string,
  url: URL,
  ctx?: ResponseContext,
): Promise<Response> {
  const window = parseWindow(url);
  if (!window) return badRequest("Invalid time window");
  const filters = parseFilters(url);
  const includeChange = parseBooleanFlag(url, "includeChange");
  const includeDetail = parseBooleanFlag(url, "includeDetail");
  const interval = parseInterval(url);
  const diagnostics = createD1ReadDiagnostics();

  const current = await queryOverviewAggregate(
    env,
    siteId,
    window,
    filters,
    diagnostics,
  );
  const dataSources: AnalyticsDataSource[] = [
    current.diagnosticSource ?? "raw",
  ];
  const currentMetrics = mapOverviewAggregate(current.value, {
    approximateVisitors: Boolean(current.approximateVisitors),
  });
  const payload: Record<string, unknown> = {
    ok: true,
    data: currentMetrics,
  };

  if (includeChange) {
    const previousTo = Math.max(window.fromMs - 1, 0);
    const previousFrom = Math.max(
      previousTo - (window.toMs - window.fromMs),
      0,
    );
    const previousWindow: QueryWindow = {
      fromMs: previousFrom,
      toMs: previousTo,
      nowMs: window.nowMs,
      timeZone: window.timeZone,
    };
    const previous = await queryOverviewAggregate(
      env,
      siteId,
      previousWindow,
      filters,
      diagnostics,
    );
    dataSources.push(previous.diagnosticSource ?? "raw");
    const previousMetrics = mapOverviewAggregate(previous.value, {
      approximateVisitors: Boolean(previous.approximateVisitors),
    });
    payload.previousData = previousMetrics;
    payload.changeRates = {
      views: percentChange(currentMetrics.views, previousMetrics.views),
      sessions: percentChange(
        currentMetrics.sessions,
        previousMetrics.sessions,
      ),
      visitors: percentChange(
        currentMetrics.visitors,
        previousMetrics.visitors,
      ),
      bounces: percentChange(currentMetrics.bounces, previousMetrics.bounces),
      bounceRate: percentChange(
        currentMetrics.bounceRate,
        previousMetrics.bounceRate,
      ),
      avgDurationMs: percentChange(
        currentMetrics.avgDurationMs,
        previousMetrics.avgDurationMs,
      ),
    };
  }

  if (includeDetail) {
    const detail = await queryTrendAggregate(
      env,
      siteId,
      window,
      interval,
      filters,
      diagnostics,
    );
    dataSources.push(detail.diagnosticSource ?? "raw");
    payload.detail = {
      interval,
      data: mapTrendRows(
        detail.value,
        detail.source === "ae" ? "detail" : sourceLabel(window),
      ),
    };
  }

  return jsonResponseWith(
    ctx!,
    payload,
    200,
    analyticsDiagnosticHeaders(
      dataSources.every((source) => source === "rollup")
        ? "rollup"
        : dataSources.every((source) => source === "raw")
          ? "raw"
          : "mixed",
      diagnostics,
    ),
  );
}

export async function handleTrend(
  env: Env,
  siteId: string,
  url: URL,
  ctx?: ResponseContext,
): Promise<Response> {
  const window = parseWindow(url);
  if (!window) return badRequest("Invalid time window");
  const filters = parseFilters(url);
  const interval = parseInterval(url);
  const diagnostics = createD1ReadDiagnostics();
  const trend = await queryTrendAggregate(
    env,
    siteId,
    window,
    interval,
    filters,
    diagnostics,
  );
  return jsonResponseWith(
    ctx!,
    {
      ok: true,
      interval,
      data: mapTrendRows(
        trend.value,
        trend.source === "ae" ? "detail" : sourceLabel(window),
      ),
    },
    200,
    analyticsDiagnosticHeaders(trend.diagnosticSource ?? "raw", diagnostics),
  );
}

export type OverviewPageTabKey =
  | "path"
  | "title"
  | "hostname"
  | "entry"
  | "exit";

export type OverviewSourceTabKey = "domain" | "link";

export type OverviewClientTabKey = Exclude<
  ClientDimensionKey,
  "operatingSystem"
>;

export type OverviewGeoTabKey =
  | "country"
  | "region"
  | "city"
  | "continent"
  | "timezone"
  | "organization";

const PAGE_TAB_DIMENSION_EXPRESSIONS: Partial<
  Record<OverviewPageTabKey, string>
> = {
  path: "pathname",
  title: "title",
  hostname: "hostname",
};

const GEO_TAB_DIMENSION_EXPRESSIONS: Record<OverviewGeoTabKey, string> = {
  country: "country",
  region: regionValueExpr(),
  city: cityValueExpr(),
  continent: "continent",
  timezone: "timezone",
  organization: "as_organization",
};

export async function handleOverviewPageTab(
  env: Env,
  siteId: string,
  url: URL,
  tab: OverviewPageTabKey,
  ctx?: ResponseContext,
): Promise<Response> {
  const window = parseWindow(url);
  if (!window) return badRequest("Invalid time window");
  const filters = parseFilters(url);
  const limit = parseLimit(url, 100, 200);
  const rows =
    tab === "entry" || tab === "exit"
      ? await querySessionBoundaryDimensionFromD1(
          env,
          siteId,
          window,
          filters,
          limit,
          tab,
        )
      : await queryDimensionAggregate(
          env,
          siteId,
          window,
          filters,
          limit,
          PAGE_TAB_DIMENSION_EXPRESSIONS[tab]!,
          { excludeEmpty: true },
        );
  return jsonResponseWith(ctx!, {
    ok: true,
    data: mapTabs(rows),
  });
}

export async function handleOverviewSourceTab(
  env: Env,
  siteId: string,
  url: URL,
  tab: OverviewSourceTabKey,
  ctx?: ResponseContext,
): Promise<Response> {
  const window = parseWindow(url);
  if (!window) return badRequest("Invalid time window");
  const filters = parseFilters(url);
  const limit = parseLimit(url, 100, 200);
  const rows = await queryReferrerAggregate(
    env,
    siteId,
    window,
    filters,
    limit,
    tab === "link",
  );
  return jsonResponseWith(ctx!, {
    ok: true,
    data: rows.map((row) => ({
      label: row.referrer,
      views: row.views,
      sessions: row.sessions,
      visitors: row.visitors,
    })),
  });
}

export async function handleOverviewClientTab(
  env: Env,
  siteId: string,
  url: URL,
  tab: OverviewClientTabKey,
  ctx?: ResponseContext,
): Promise<Response> {
  const window = parseWindow(url);
  if (!window) return badRequest("Invalid time window");
  const filters = parseFilters(url);
  const limit = parseLimit(url, 100, 200);
  const rows = await queryDimensionAggregate(
    env,
    siteId,
    window,
    filters,
    limit,
    clientDimensionDefinition(tab).labelExpr,
    { excludeEmpty: true },
  );
  return jsonResponseWith(ctx!, {
    ok: true,
    // Preserve the existing response contract. The legacy client-dimension
    // path did not expose distinct visitor counts for these cards.
    data: mapTabs(rows.map((row) => ({ ...row, visitors: 0 }))),
  });
}

export async function handleOverviewGeoTab(
  env: Env,
  siteId: string,
  url: URL,
  tab: OverviewGeoTabKey,
  ctx?: ResponseContext,
): Promise<Response> {
  const window = parseWindow(url);
  if (!window) return badRequest("Invalid time window");
  const rawFilters = parseFilters(url);
  const filters = tab === "country" ? withoutGeoFilter(rawFilters) : rawFilters;
  const limit = parseLimit(url, 100, 200);
  const rows = await queryDimensionAggregate(
    env,
    siteId,
    window,
    filters,
    limit,
    GEO_TAB_DIMENSION_EXPRESSIONS[tab],
    { excludeEmpty: true },
  );
  return jsonResponseWith(ctx!, {
    ok: true,
    data: mapGeoTabs(
      rows.map((row) => ({
        ...row,
        label: geoTabLabel(row.value, tab),
      })),
    ),
  });
}

export async function handleFilterOptions(
  env: Env,
  siteId: string,
  url: URL,
  ctx?: ResponseContext,
): Promise<Response> {
  const filterKey = parseFilterOptionKey(url);
  if (!filterKey) return badRequest("Invalid filter key");
  const window = parseWindow(url);
  if (!window) return badRequest("Invalid time window");
  const filters = withoutFilterKey(parseFilters(url), filterKey);
  const limit = parseLimit(url, 200, 500);

  let data: DashboardFilterOption[] = [];

  if (filterKey === "country") {
    const rows = await queryDimensionAggregate(
      env,
      siteId,
      window,
      filters,
      limit,
      "country",
    );
    data = mapDimensionRowsToFilterOptions(rows);
  } else if (filterKey === "device") {
    const rows = await queryDimensionAggregate(
      env,
      siteId,
      window,
      filters,
      limit,
      "device_type",
    );
    data = mapDimensionRowsToFilterOptions(rows);
  } else if (filterKey === "browser") {
    const rows = await queryDimensionAggregate(
      env,
      siteId,
      window,
      filters,
      limit,
      "browser",
    );
    data = mapDimensionRowsToFilterOptions(rows);
  } else if (
    filterKey === "path" ||
    filterKey === "title" ||
    filterKey === "hostname" ||
    filterKey === "entry" ||
    filterKey === "exit"
  ) {
    const tabs = await queryPageTabsAggregate(
      env,
      siteId,
      window,
      filters,
      limit,
    );
    data = mapDimensionRowsToFilterOptions(tabs[filterKey]);
  } else if (filterKey === "sourceDomain" || filterKey === "sourceLink") {
    const rows = await queryReferrerAggregate(
      env,
      siteId,
      window,
      filters,
      limit,
      filterKey === "sourceLink",
    );
    data = mapReferrerRowsToFilterOptions(rows);
  } else if (
    filterKey === "clientBrowser" ||
    filterKey === "clientOsVersion" ||
    filterKey === "clientDeviceType" ||
    filterKey === "clientLanguage" ||
    filterKey === "clientScreenSize"
  ) {
    const tabs = await buildOverviewClientDimensionTabs(
      env,
      siteId,
      window,
      filters,
      limit,
    );
    const keyMap = {
      clientBrowser: "browser",
      clientOsVersion: "osVersion",
      clientDeviceType: "deviceType",
      clientLanguage: "language",
      clientScreenSize: "screenSize",
    } as const;
    data = mapDimensionRowsToFilterOptions(tabs[keyMap[filterKey]]);
  } else if (filterKey === "geo") {
    const tabs = await buildOverviewGeoDimensionTabs(
      env,
      siteId,
      window,
      filters,
      limit,
    );
    data = dedupeFilterOptions([
      ...mapGeoRowsToFilterOptions(tabs.country, "country"),
      ...mapGeoRowsToFilterOptions(tabs.region, "region"),
      ...mapGeoRowsToFilterOptions(tabs.city, "city"),
    ]);
  } else if (
    filterKey === "geoContinent" ||
    filterKey === "geoTimezone" ||
    filterKey === "geoOrganization"
  ) {
    const tabs = await buildOverviewGeoDimensionTabs(
      env,
      siteId,
      window,
      filters,
      limit,
    );
    const keyMap = {
      geoContinent: "continent",
      geoTimezone: "timezone",
      geoOrganization: "organization",
    } as const;
    data = mapDimensionRowsToFilterOptions(tabs[keyMap[filterKey]]);
  }

  return jsonResponseWith(ctx!, { ok: true, data });
}

export async function handleOverviewGeoPoints(
  env: Env,
  siteId: string,
  url: URL,
  ctx?: ResponseContext,
): Promise<Response> {
  const window = parseWindow(url);
  if (!window) return badRequest("Invalid time window");
  const filters = parseBooleanSearchParam(url, "applyGeoFilter")
    ? parseFilters(url)
    : withoutGeoFilter(parseFilters(url));
  const limit = parseLimit(url, 5000, 20000);
  const aggregate = await queryGeoPointAggregate(
    env,
    siteId,
    window,
    filters,
    limit,
  );
  return jsonResponseWith(ctx!, {
    ok: true,
    data: aggregate.points,
    countryCounts: aggregate.countryCounts,
    regionCounts: aggregate.regionCounts,
    cityCounts: aggregate.cityCounts,
  });
}
