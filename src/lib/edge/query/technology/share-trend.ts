import type {
  BrowserTrendBucketRow,
  BrowserTrendPointRow,
  BrowserTrendSeriesRow,
  ClientDimensionKey,
  DashboardFilters,
  Interval,
  QueryWindow,
  UtmDimensionKey,
} from "@/lib/edge/query/core";
import {
  buildTimeBuckets,
  buildVisitFilterSql,
  buildVisitSourceCte,
  clientDimensionDefinition,
  queryD1All,
  referrerDomainDimensionDefinition,
  SHARE_TREND_OTHER_KEY,
  SHARE_TREND_OTHER_LABEL,
  SHARE_TREND_OTHER_TOKEN,
  shareTrendSeriesKey,
  timeBucketCase,
  timeBucketTimestamp,
  utmDimensionDefinition,
  visitSourceBindings,
} from "@/lib/edge/query/core";
import type { Env } from "@/lib/edge/types";

export async function queryShareTrendFromD1(
  env: Env,
  siteId: string,
  window: QueryWindow,
  interval: Interval,
  filters: DashboardFilters,
  limit: number,
  labelExpr: string,
  fallbackKeyBase: string,
): Promise<{
  series: BrowserTrendSeriesRow[];
  data: BrowserTrendPointRow[];
}> {
  const filter = buildVisitFilterSql(filters);
  const buckets = buildTimeBuckets(window, interval);
  const bucket = timeBucketCase(buckets, "started_at");
  const normalizedLimit = Math.min(Math.max(1, limit), 12);
  const sql = `
WITH
${buildVisitSourceCte()},
filtered_visits AS MATERIALIZED (
  SELECT
    ${bucket.sql} AS bucket,
    visit_id AS visitId,
    started_at AS startedAt,
    ${labelExpr} AS labelValue,
    visitor_id AS visitorId,
    session_id AS sessionId
  FROM visit_source
  ${filter.clause}
),
visitor_latest AS (
  SELECT
    visitorId,
    labelValue AS assignedLabel
  FROM (
    SELECT
      visitorId,
      labelValue,
      startedAt,
      visitId,
      ROW_NUMBER() OVER (
        PARTITION BY visitorId
        ORDER BY startedAt DESC, visitId DESC
      ) AS rowNumber
    FROM filtered_visits
    WHERE visitorId != ''
  )
  WHERE rowNumber = 1
),
assigned_visits AS (
  SELECT
    visitor_latest.assignedLabel AS label,
    filtered_visits.visitorId AS visitorId,
    filtered_visits.sessionId AS sessionId
  FROM visitor_latest
  INNER JOIN filtered_visits
    ON filtered_visits.visitorId = visitor_latest.visitorId
),
top_aggregate AS (
  SELECT
    label,
    count(*) AS views,
    count(DISTINCT visitorId) AS visitors,
    count(DISTINCT CASE WHEN sessionId != '' THEN sessionId ELSE NULL END) AS sessions
  FROM assigned_visits
  WHERE label != ''
  GROUP BY label
),
top_rows AS (
  SELECT
    label,
    views,
    visitors,
    sessions,
    ROW_NUMBER() OVER (
      ORDER BY visitors DESC, views DESC, sessions DESC, label ASC
    ) AS rowOrder
  FROM top_aggregate
  ORDER BY visitors DESC, views DESC, sessions DESC, label ASC
  LIMIT ?
),
series_rows AS (
  SELECT
    COALESCE(top_rows.label, '${SHARE_TREND_OTHER_TOKEN}') AS label,
    count(*) AS views,
    count(DISTINCT filtered_visits.visitorId) AS visitors,
    count(DISTINCT CASE WHEN filtered_visits.sessionId != '' THEN filtered_visits.sessionId ELSE NULL END) AS sessions
  FROM visitor_latest
  INNER JOIN filtered_visits
    ON filtered_visits.visitorId = visitor_latest.visitorId
  LEFT JOIN top_rows
    ON top_rows.label = visitor_latest.assignedLabel
  GROUP BY label
),
bucket_visitor_latest AS (
  SELECT
    bucket,
    visitorId,
    labelValue AS assignedLabel
  FROM (
    SELECT
      bucket,
      visitorId,
      labelValue,
      startedAt,
      visitId,
      ROW_NUMBER() OVER (
        PARTITION BY bucket, visitorId
        ORDER BY startedAt DESC, visitId DESC
      ) AS rowNumber
    FROM filtered_visits
    WHERE visitorId != ''
  )
  WHERE rowNumber = 1
),
bucket_rows AS (
  SELECT
    bucket_visitor_latest.bucket AS bucket,
    COALESCE(top_rows.label, '${SHARE_TREND_OTHER_TOKEN}') AS label,
    count(*) AS views,
    count(DISTINCT filtered_visits.visitorId) AS visitors,
    count(DISTINCT CASE WHEN filtered_visits.sessionId != '' THEN filtered_visits.sessionId ELSE NULL END) AS sessions
  FROM bucket_visitor_latest
  INNER JOIN filtered_visits
    ON filtered_visits.bucket = bucket_visitor_latest.bucket
    AND filtered_visits.visitorId = bucket_visitor_latest.visitorId
  LEFT JOIN top_rows
    ON top_rows.label = bucket_visitor_latest.assignedLabel
  GROUP BY bucket_visitor_latest.bucket, label
),
tagged_rows AS (
  SELECT
    'top' AS rowType,
    NULL AS bucket,
    label,
    views,
    visitors,
    sessions,
    rowOrder
  FROM top_rows
  UNION ALL
  SELECT
    'series' AS rowType,
    NULL AS bucket,
    label,
    views,
    visitors,
    sessions,
    0 AS rowOrder
  FROM series_rows
  UNION ALL
  SELECT
    'bucket' AS rowType,
    bucket,
    label,
    views,
    visitors,
    sessions,
    0 AS rowOrder
  FROM bucket_rows
)
SELECT rowType, bucket, label, views, visitors, sessions
FROM tagged_rows
ORDER BY rowType ASC, rowOrder ASC, bucket ASC, label ASC
`;
  const rows = await queryD1All<Record<string, unknown>>(env, sql, [
    ...visitSourceBindings(siteId, window),
    ...bucket.bindings,
    ...filter.bindings,
    normalizedLimit,
  ]);
  const topRows = rows
    .filter((row) => String(row.rowType ?? "") === "top")
    .map((row) => ({
      label: String(row.label ?? "").trim(),
      views: Number(row.views ?? 0),
      visitors: Number(row.visitors ?? 0),
      sessions: Number(row.sessions ?? 0),
    }))
    .filter((row) => row.label.length > 0 && row.visitors > 0);
  const seriesRows = rows
    .filter((row) => String(row.rowType ?? "") === "series")
    .map((row) => ({
      label: String(row.label ?? "").trim(),
      views: Number(row.views ?? 0),
      visitors: Number(row.visitors ?? 0),
      sessions: Number(row.sessions ?? 0),
    }))
    .filter((row) => row.label.length > 0 && row.visitors > 0);
  const bucketRows = rows
    .filter((row) => String(row.rowType ?? "") === "bucket")
    .map(
      (row) =>
        ({
          bucket: Number(row.bucket ?? 0),
          label: String(row.label ?? "").trim(),
          views: Number(row.views ?? 0),
          visitors: Number(row.visitors ?? 0),
          sessions: Number(row.sessions ?? 0),
        }) satisfies BrowserTrendBucketRow,
    );

  if (seriesRows.length === 0) {
    return {
      series: [],
      data: [],
    };
  }

  const topLabels = topRows.map((row) => row.label);

  const seriesByLabel = new Map(
    seriesRows.map((row) => [row.label, row] as const),
  );
  const usedKeys = new Set<string>([SHARE_TREND_OTHER_KEY]);
  const series: BrowserTrendSeriesRow[] = [];
  const keyByLabel = new Map<string, string>();

  for (const label of topLabels) {
    const row = seriesByLabel.get(label);
    if (!row || row.visitors <= 0) continue;
    const key = shareTrendSeriesKey(label, usedKeys, fallbackKeyBase);
    keyByLabel.set(label, key);
    series.push({
      key,
      label,
      views: row.views,
      visitors: row.visitors,
      sessions: row.sessions,
    });
  }

  const otherRow = seriesByLabel.get(SHARE_TREND_OTHER_TOKEN);
  if (otherRow && otherRow.visitors > 0) {
    keyByLabel.set(SHARE_TREND_OTHER_TOKEN, SHARE_TREND_OTHER_KEY);
    series.push({
      key: SHARE_TREND_OTHER_KEY,
      label: SHARE_TREND_OTHER_LABEL,
      views: otherRow.views,
      visitors: otherRow.visitors,
      sessions: otherRow.sessions,
      isOther: true,
    });
  }

  const hasBucketOther = bucketRows.some(
    (row) => row.label === SHARE_TREND_OTHER_TOKEN && row.visitors > 0,
  );
  if (!otherRow && hasBucketOther) {
    keyByLabel.set(SHARE_TREND_OTHER_TOKEN, SHARE_TREND_OTHER_KEY);
    series.push({
      key: SHARE_TREND_OTHER_KEY,
      label: SHARE_TREND_OTHER_LABEL,
      views: 0,
      visitors: 0,
      sessions: 0,
      isOther: true,
    });
  }

  if (series.length === 0) {
    return {
      series: [],
      data: [],
    };
  }

  const createEmptyPoint = (bucket: number): BrowserTrendPointRow => ({
    bucket,
    timestampMs: timeBucketTimestamp(buckets, bucket),
    totalVisitors: 0,
    visitorsBySeries: Object.fromEntries(series.map((item) => [item.key, 0])),
  });

  const pointsByBucket = new Map<number, BrowserTrendPointRow>();
  for (const row of bucketRows) {
    const key = keyByLabel.get(row.label);
    if (!key) continue;
    const point =
      pointsByBucket.get(row.bucket) ?? createEmptyPoint(row.bucket);
    point.visitorsBySeries[key] = row.visitors;
    point.totalVisitors += row.visitors;
    pointsByBucket.set(row.bucket, point);
  }

  const data: BrowserTrendPointRow[] = [];
  for (const item of buckets) {
    data.push(pointsByBucket.get(item.index) ?? createEmptyPoint(item.index));
  }

  return {
    series,
    data,
  };
}

export async function queryClientDimensionTrendFromD1(
  env: Env,
  siteId: string,
  window: QueryWindow,
  interval: Interval,
  filters: DashboardFilters,
  dimension: ClientDimensionKey,
  limit: number,
): Promise<{
  series: BrowserTrendSeriesRow[];
  data: BrowserTrendPointRow[];
}> {
  const definition = clientDimensionDefinition(dimension);
  return queryShareTrendFromD1(
    env,
    siteId,
    window,
    interval,
    filters,
    limit,
    definition.labelExpr,
    definition.fallbackKeyBase,
  );
}

export async function queryUtmDimensionTrendFromD1(
  env: Env,
  siteId: string,
  window: QueryWindow,
  interval: Interval,
  filters: DashboardFilters,
  dimension: UtmDimensionKey,
  limit: number,
): Promise<{
  series: BrowserTrendSeriesRow[];
  data: BrowserTrendPointRow[];
}> {
  const definition = utmDimensionDefinition(dimension);
  return queryShareTrendFromD1(
    env,
    siteId,
    window,
    interval,
    filters,
    limit,
    definition.labelExpr,
    definition.fallbackKeyBase,
  );
}

export async function queryReferrerTrendFromD1(
  env: Env,
  siteId: string,
  window: QueryWindow,
  interval: Interval,
  filters: DashboardFilters,
  limit: number,
): Promise<{
  series: BrowserTrendSeriesRow[];
  data: BrowserTrendPointRow[];
}> {
  const definition = referrerDomainDimensionDefinition();
  return queryShareTrendFromD1(
    env,
    siteId,
    window,
    interval,
    filters,
    limit,
    definition.labelExpr,
    definition.fallbackKeyBase,
  );
}
