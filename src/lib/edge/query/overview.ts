import {
  hasFilterDocument,
  queryOverviewForSitesFromHourlyRollups,
  queryTrendForSitesFromHourlyRollups,
} from "@/lib/edge/hourly-rollup";
import type { Env } from "@/lib/edge/types";

import type {
  ClientDimensionKey,
  FilterDocument,
  Interval,
  OverviewAggregateRow,
  PreferredSourceResult,
  QueryWindow,
  TrendAggregateRow,
} from "./core";
import {
  buildTimeBuckets,
  buildVisitFilterSql,
  buildVisitSourceCte,
  queryD1All,
  timeBucketCase,
  timeBucketTimestamp,
  visitSourceBindings,
} from "./core";
import type { D1ReadDiagnostics } from "./diagnostics";
import {
  queryOverviewClientDimensionsFromD1,
  queryOverviewGeoDimensionsFromD1,
} from "./dimensions";

export async function queryOverviewFromD1(
  env: Env,
  siteId: string,
  window: QueryWindow,
  filters: FilterDocument,
  diagnostics?: D1ReadDiagnostics,
): Promise<OverviewAggregateRow> {
  const filter = buildVisitFilterSql(filters);
  const sql = `
WITH
${buildVisitSourceCte()},
filtered_visits AS MATERIALIZED (
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
  filters: FilterDocument,
  diagnostics?: D1ReadDiagnostics,
): Promise<TrendAggregateRow[]> {
  const filter = buildVisitFilterSql(filters);
  const buckets = buildTimeBuckets(window, interval);
  const visitBucket = timeBucketCase(buckets, "started_at");
  const sessionBucket = timeBucketCase(buckets, "session_started_at");
  const sql = `
WITH
${buildVisitSourceCte()},
filtered_visits AS MATERIALIZED (
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
  filters: FilterDocument,
  diagnostics?: D1ReadDiagnostics,
): Promise<PreferredSourceResult<OverviewAggregateRow>> {
  if (!hasFilterDocument(filters)) {
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
  filters: FilterDocument,
  diagnostics?: D1ReadDiagnostics,
): Promise<PreferredSourceResult<TrendAggregateRow[]>> {
  if (!hasFilterDocument(filters)) {
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
  filters: FilterDocument,
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
  filters: FilterDocument,
  limit: number,
) {
  return queryOverviewGeoDimensionsFromD1(env, siteId, window, filters, limit);
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
