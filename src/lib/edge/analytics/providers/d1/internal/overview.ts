import { scopedFilterMetadata } from "@/lib/edge/analytics/contract";
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
import {
  type D1ReadDiagnostics,
  recordScopedFilterDiagnostics,
} from "./diagnostics";
import {
  queryOverviewClientDimensionsFromD1,
  queryOverviewGeoDimensionsFromD1,
} from "./dimensions";
import { scopedDatasetFor } from "./scoped-dataset";

function entityExpansionSql(): string {
  return `
matched_entities AS MATERIALIZED (
  SELECT DISTINCT site_pk, session_id
  FROM filtered_visits
  WHERE TRIM(COALESCE(session_id, '')) != ''
),
calculated_visits AS MATERIALIZED (
  SELECT vs.*
  FROM visit_source vs
  INNER JOIN matched_entities me
    ON me.site_pk = vs.site_pk AND me.session_id = vs.session_id
),`;
}

export async function queryOverviewFromD1(
  env: Env,
  siteId: string,
  window: QueryWindow,
  filters: FilterDocument,
  diagnostics?: D1ReadDiagnostics,
): Promise<OverviewAggregateRow> {
  const scopedDataset = scopedDatasetFor(siteId, window, filters);
  recordScopedFilterDiagnostics(diagnostics, scopedFilterMetadata(filters));
  const filter = scopedDataset
    ? { clause: "", bindings: [] as Array<string | number> }
    : buildVisitFilterSql(filters, "visit_source", { window });
  const hasFilter = filter.clause.length > 0;
  const expandEntities = !scopedDataset && hasFilter;
  const entityExpansion = expandEntities ? entityExpansionSql() : "";
  const visitSource = buildVisitSourceCte().replace(
    "visit_source AS (",
    "visit_source AS MATERIALIZED (",
  );
  const metricSource = scopedDataset
    ? scopedDataset.visitRelation
    : expandEntities
      ? "calculated_visits"
      : "filtered_visits";
  const entityCounts = scopedDataset
    ? `
  (SELECT count(*) FROM ${scopedDataset.sessionRelation}) AS sessions,
  (SELECT count(*) FROM ${scopedDataset.visitorRelation}) AS visitors,`
    : `
  count(DISTINCT CASE WHEN session_id != '' THEN session_id ELSE NULL END) AS sessions,
  count(DISTINCT CASE WHEN visitor_id != '' THEN visitor_id ELSE NULL END) AS visitors,`;
  const sourceSql = scopedDataset
    ? `${scopedDataset.ctes},`
    : `${visitSource},
filtered_visits AS MATERIALIZED (
  SELECT *
  FROM visit_source
  ${filter.clause}
),${entityExpansion}`;
  const sql = `
WITH
${sourceSql}
session_rollup AS (
  SELECT vs.session_id, count(*) AS visit_count
  FROM ${metricSource} vs
  WHERE vs.session_id != ''
  GROUP BY vs.session_id
)
SELECT
  count(*) AS views,
${entityCounts}
  COALESCE((SELECT count(*) FROM session_rollup WHERE visit_count = 1), 0) AS bounces,
  COALESCE(sum(CASE WHEN duration_ms IS NOT NULL AND duration_ms >= 0 THEN duration_ms ELSE 0 END), 0) AS totalDuration,
  COALESCE(sum(CASE WHEN duration_ms IS NOT NULL AND duration_ms >= 0 THEN 1 ELSE 0 END), 0) AS durationViews
FROM ${metricSource}
`;
  const row =
    (
      await queryD1All<Record<string, unknown>>(
        env,
        sql,
        scopedDataset
          ? scopedDataset.bindings.map((binding) => binding.value)
          : [...visitSourceBindings(siteId, window), ...filter.bindings],
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
  const scopedDataset = scopedDatasetFor(siteId, window, filters);
  recordScopedFilterDiagnostics(diagnostics, scopedFilterMetadata(filters));
  const filter = scopedDataset
    ? { clause: "", bindings: [] as Array<string | number> }
    : buildVisitFilterSql(filters, "visit_source", { window });
  const hasFilter = filter.clause.length > 0;
  const expandEntities = !scopedDataset && hasFilter;
  const entityExpansion = expandEntities ? entityExpansionSql() : "";
  const visitSource = buildVisitSourceCte().replace(
    "visit_source AS (",
    "visit_source AS MATERIALIZED (",
  );
  const buckets = buildTimeBuckets(window, interval);
  const visitBucket = timeBucketCase(buckets, "started_at");
  const scopedVisitorBucket = scopedDataset
    ? timeBucketCase(buckets, "observed_at")
    : null;
  const sessionBucket = timeBucketCase(
    buckets,
    scopedDataset ? "session_observed_at" : "session_started_at",
  );
  const metricSource = scopedDataset
    ? scopedDataset.visitRelation
    : expandEntities
      ? "calculated_visits"
      : "filtered_visits";
  const scopedEntityObservations = scopedDataset
    ? `
scope_entity_observations AS (
  SELECT visitor_id, session_id, started_at AS observed_at, 1 AS is_visit_observation
  FROM ${scopedDataset.visitRelation}
  UNION ALL
  SELECT visitor_id, session_id, occurred_at AS observed_at, 0 AS is_visit_observation
  FROM ${scopedDataset.eventRelation}
),`
    : "";
  const visitBucketRollup = scopedDataset
    ? `
visit_bucket_rollup AS (
  SELECT
    ${visitBucket.sql} AS bucket,
    count(*) AS views,
    0 AS visitors,
    COALESCE(sum(CASE WHEN duration_ms IS NOT NULL AND duration_ms >= 0 THEN duration_ms ELSE 0 END), 0) AS totalDuration,
    COALESCE(sum(CASE WHEN duration_ms IS NOT NULL AND duration_ms >= 0 THEN 1 ELSE 0 END), 0) AS durationViews
  FROM ${metricSource}
  GROUP BY bucket
),`
    : `
visit_bucket_rollup AS (
  SELECT
    ${visitBucket.sql} AS bucket,
    count(*) AS views,
    count(DISTINCT CASE WHEN visitor_id != '' THEN visitor_id ELSE NULL END) AS visitors,
    COALESCE(sum(CASE WHEN duration_ms IS NOT NULL AND duration_ms >= 0 THEN duration_ms ELSE 0 END), 0) AS totalDuration,
    COALESCE(sum(CASE WHEN duration_ms IS NOT NULL AND duration_ms >= 0 THEN 1 ELSE 0 END), 0) AS durationViews
  FROM ${metricSource}
  GROUP BY bucket
),`;
  const scopedVisitorBucketRollup = scopedDataset
    ? `
visitor_bucket_rollup AS (
  SELECT
    ${scopedVisitorBucket?.sql} AS bucket,
    count(DISTINCT CASE WHEN visitor_id != '' THEN visitor_id ELSE NULL END) AS visitors
  FROM scope_entity_observations
  GROUP BY bucket
),`
    : "";
  const sessionRollup = scopedDataset
    ? `
session_rollup AS (
  SELECT
    session_id,
    MIN(observed_at) AS session_observed_at,
    COUNT(CASE WHEN is_visit_observation = 1 THEN 1 END) AS visit_count
  FROM scope_entity_observations
  WHERE session_id != ''
  GROUP BY session_id
),`
    : `
session_rollup AS (
  SELECT
    vs.session_id,
    MIN(vs.started_at) AS session_started_at,
    count(*) AS visit_count
  FROM ${metricSource} vs
  WHERE vs.session_id != ''
  GROUP BY vs.session_id
),`;
  const combined = scopedDataset
    ? `
combined AS (
  SELECT bucket, views, visitors, 0 AS sessions, 0 AS bounces, totalDuration, durationViews FROM visit_bucket_rollup
  UNION ALL
  SELECT bucket, 0 AS views, visitors, 0 AS sessions, 0 AS bounces, 0 AS totalDuration, 0 AS durationViews FROM visitor_bucket_rollup
  UNION ALL
  SELECT bucket, 0 AS views, 0 AS visitors, sessions, bounces, 0 AS totalDuration, 0 AS durationViews FROM session_bucket_rollup
 )`
    : `
combined AS (
  SELECT bucket, views, visitors, 0 AS sessions, 0 AS bounces, totalDuration, durationViews FROM visit_bucket_rollup
  UNION ALL
  SELECT bucket, 0 AS views, 0 AS visitors, sessions, bounces, 0 AS totalDuration, 0 AS durationViews FROM session_bucket_rollup
 )`;
  const sourceSql = scopedDataset
    ? `${scopedDataset.ctes},
${scopedEntityObservations}`
    : `${visitSource},
filtered_visits AS MATERIALIZED (
  SELECT *
  FROM visit_source
  ${filter.clause}
),${entityExpansion}`;
  const sql = `
WITH
${sourceSql}
${visitBucketRollup}
${scopedVisitorBucketRollup}
${sessionRollup}
session_bucket_rollup AS (
  SELECT
    ${sessionBucket.sql} AS bucket,
    count(*) AS sessions,
    COALESCE(sum(CASE WHEN visit_count = 1 THEN 1 ELSE 0 END), 0) AS bounces
  FROM session_rollup
  GROUP BY bucket
),
${combined}
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
        ...(scopedDataset
          ? scopedDataset.bindings.map((binding) => binding.value)
          : [...visitSourceBindings(siteId, window), ...filter.bindings]),
        ...visitBucket.bindings,
        ...(scopedVisitorBucket?.bindings ?? []),
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

/**
 * Site-level activity is a composite concern, not a breakdown metric. Keep
 * the filter and half-open window aligned with the overview/trend readers.
 */
export async function queryLatestSiteActivity(
  env: Env,
  siteId: string,
  window: QueryWindow,
  filters: FilterDocument,
  diagnostics?: D1ReadDiagnostics,
): Promise<number | null> {
  const scopedDataset = scopedDatasetFor(siteId, window, filters);
  recordScopedFilterDiagnostics(diagnostics, scopedFilterMetadata(filters));
  const filter = scopedDataset
    ? { clause: "", bindings: [] as Array<string | number> }
    : buildVisitFilterSql(filters, "visit_source", { window });
  const hasFilter = filter.clause.length > 0;
  const expandEntities = !scopedDataset && hasFilter;
  const entityExpansion = expandEntities ? entityExpansionSql() : "";
  const visitSource = buildVisitSourceCte().replace(
    "visit_source AS (",
    "visit_source AS MATERIALIZED (",
  );
  const metricSource = scopedDataset
    ? scopedDataset.visitRelation
    : expandEntities
      ? "calculated_visits"
      : "filtered_visits";
  const sourceSql = scopedDataset
    ? `${scopedDataset.ctes},`
    : `${visitSource},
filtered_visits AS MATERIALIZED (
  SELECT *
  FROM visit_source
  ${filter.clause}
),${entityExpansion}`;
  const sql = `
WITH
${sourceSql}
SELECT MAX(last_activity_at) AS lastActivityAt
FROM ${metricSource}
`;
  const row = (
    await queryD1All<Record<string, unknown>>(
      env,
      sql,
      scopedDataset
        ? scopedDataset.bindings.map((binding) => binding.value)
        : [...visitSourceBindings(siteId, window), ...filter.bindings],
      diagnostics,
    )
  )[0];
  const raw = row?.lastActivityAt;
  if (raw === null || raw === undefined || raw === "") return null;
  const value = Number(raw);
  return Number.isSafeInteger(value) ? value : null;
}

export async function queryOverviewAggregate(
  env: Env,
  siteId: string,
  window: QueryWindow,
  filters: FilterDocument,
  diagnostics?: D1ReadDiagnostics,
): Promise<PreferredSourceResult<OverviewAggregateRow>> {
  const scopedDataset = scopedDatasetFor(siteId, window, filters);
  if (!hasFilterDocument(filters) && !scopedDataset) {
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
  const scopedDataset = scopedDatasetFor(siteId, window, filters);
  if (!hasFilterDocument(filters) && !scopedDataset) {
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
  "path" | "title" | "hostname" | "entry" | "exit";

export type OverviewSourceTabKey = "domain" | "link";

export type OverviewClientTabKey = Exclude<
  ClientDimensionKey,
  "operatingSystem"
>;

export type OverviewGeoTabKey =
  "country" | "region" | "city" | "continent" | "timezone" | "organization";
