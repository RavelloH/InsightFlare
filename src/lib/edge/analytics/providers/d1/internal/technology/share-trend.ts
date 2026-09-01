import { buildTrafficChannelSqlExpression } from "@/lib/analytics/traffic-channel-rules";
import type {
  BrowserTrendBucketRow,
  BrowserTrendPointRow,
  BrowserTrendSeriesRow,
  ClientDimensionKey,
  FilterDocument,
  Interval,
  QueryWindow,
  TimeBucket,
  UtmDimensionKey,
} from "@/lib/edge/analytics/providers/d1/internal/core";
import {
  buildTimeBuckets,
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
} from "@/lib/edge/analytics/providers/d1/internal/core";
import type { Env } from "@/lib/edge/types";

import { technologyVisitSource } from "./scoped-source";

export interface ShareTrendResult {
  series: BrowserTrendSeriesRow[];
  data: BrowserTrendPointRow[];
}

export interface ReferrerAndChannelTrendResult {
  source: ShareTrendResult;
  channel: ShareTrendResult;
}

type ShareTrendQueryRow = Record<string, unknown>;

function combinedShareTrendRows(value: unknown): ShareTrendQueryRow[] {
  if (typeof value !== "string") return [];

  try {
    const parsed = JSON.parse(value) as {
      top?: unknown;
      series?: unknown;
      buckets?: unknown;
    };
    const taggedRows: ShareTrendQueryRow[] = [];
    const appendRows = (
      rows: unknown,
      rowType: "top" | "series" | "bucket",
    ) => {
      if (!Array.isArray(rows)) return;
      for (const row of rows) {
        if (row && typeof row === "object" && !Array.isArray(row)) {
          taggedRows.push({ ...row, rowType });
        }
      }
    };

    appendRows(parsed.top, "top");
    appendRows(parsed.series, "series");
    appendRows(parsed.buckets, "bucket");
    return taggedRows;
  } catch {
    return [];
  }
}

function mapShareTrendRows(
  rows: ShareTrendQueryRow[],
  buckets: TimeBucket[],
  fallbackKeyBase: string,
): ShareTrendResult {
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

export async function queryShareTrendFromD1(
  env: Env,
  siteId: string,
  window: QueryWindow,
  interval: Interval,
  filters: FilterDocument,
  limit: number,
  labelExpr: string,
  fallbackKeyBase: string,
): Promise<ShareTrendResult> {
  const source = technologyVisitSource(siteId, window, filters);
  const buckets = buildTimeBuckets(window, interval);
  const bucket = timeBucketCase(buckets, "started_at");
  const normalizedLimit = Math.min(Math.max(1, limit), 12);
  const sql = `
WITH
${source.ctes},
filtered_visits AS MATERIALIZED (
  SELECT
    ${bucket.sql} AS bucket,
    visit_id AS visitId,
    started_at AS startedAt,
    ${labelExpr} AS labelValue,
    visitor_id AS visitorId,
    session_id AS sessionId
  FROM ${source.relation}
  ${source.filterClause}
),
ranked_visits AS MATERIALIZED (
  SELECT
    bucket,
    visitId,
    visitorId,
    sessionId,
    FIRST_VALUE(labelValue) OVER (
      PARTITION BY visitorId
      ORDER BY startedAt DESC, visitId DESC
    ) AS globalLabel,
    FIRST_VALUE(labelValue) OVER (
      PARTITION BY bucket, visitorId
      ORDER BY startedAt DESC, visitId DESC
    ) AS bucketLabel
  FROM filtered_visits
  WHERE visitorId != ''
),
top_aggregate AS (
  SELECT
    globalLabel AS label,
    count(*) AS views,
    count(DISTINCT visitorId) AS visitors,
    count(DISTINCT CASE WHEN sessionId != '' THEN sessionId ELSE NULL END) AS sessions
  FROM ranked_visits
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
    count(DISTINCT ranked_visits.visitorId) AS visitors,
    count(DISTINCT CASE WHEN ranked_visits.sessionId != '' THEN ranked_visits.sessionId ELSE NULL END) AS sessions
  FROM ranked_visits
  LEFT JOIN top_rows
    ON top_rows.label = ranked_visits.globalLabel
  GROUP BY label
),
bucket_rows AS (
  SELECT
    ranked_visits.bucket AS bucket,
    COALESCE(top_rows.label, '${SHARE_TREND_OTHER_TOKEN}') AS label,
    count(*) AS views,
    count(DISTINCT ranked_visits.visitorId) AS visitors,
    count(DISTINCT CASE WHEN ranked_visits.sessionId != '' THEN ranked_visits.sessionId ELSE NULL END) AS sessions
  FROM ranked_visits
  LEFT JOIN top_rows
    ON top_rows.label = ranked_visits.bucketLabel
  GROUP BY ranked_visits.bucket, label
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
    ...source.bindings,
    ...bucket.bindings,
    ...source.filterBindings,
    normalizedLimit,
  ]);
  return mapShareTrendRows(rows, buckets, fallbackKeyBase);
}

/**
 * Reads the visit window once and produces the source-domain and traffic-
 * channel share trends independently. The two dimensions intentionally use
 * separate top/series/bucket CTEs instead of joining their bucket rows.
 */
export async function queryReferrerAndChannelTrendFromD1(
  env: Env,
  siteId: string,
  window: QueryWindow,
  interval: Interval,
  filters: FilterDocument,
  limit: number,
): Promise<ReferrerAndChannelTrendResult> {
  const source = technologyVisitSource(siteId, window, filters);
  const buckets = buildTimeBuckets(window, interval);
  const bucket = timeBucketCase(buckets, "started_at");
  const normalizedLimit = Math.min(Math.max(1, limit), 12);
  const sourceDefinition = referrerDomainDimensionDefinition();
  const channelExpression = buildTrafficChannelSqlExpression();
  const sql = `
WITH
${source.ctes},
filtered_visits AS MATERIALIZED (
  SELECT
    ${bucket.sql} AS bucket,
    visit_id AS visitId,
    started_at AS startedAt,
    ${sourceDefinition.labelExpr} AS sourceLabelValue,
    ${channelExpression} AS channelLabelValue,
    visitor_id AS visitorId,
    session_id AS sessionId
  FROM ${source.relation}
  ${source.filterClause}
),
ranked_visits AS MATERIALIZED (
  SELECT
    bucket,
    visitId,
    visitorId,
    sessionId,
    FIRST_VALUE(sourceLabelValue) OVER (
      PARTITION BY visitorId
      ORDER BY startedAt DESC, visitId DESC
    ) AS sourceGlobalLabel,
    FIRST_VALUE(sourceLabelValue) OVER (
      PARTITION BY bucket, visitorId
      ORDER BY startedAt DESC, visitId DESC
    ) AS sourceBucketLabel,
    FIRST_VALUE(channelLabelValue) OVER (
      PARTITION BY visitorId
      ORDER BY startedAt DESC, visitId DESC
    ) AS channelGlobalLabel,
    FIRST_VALUE(channelLabelValue) OVER (
      PARTITION BY bucket, visitorId
      ORDER BY startedAt DESC, visitId DESC
    ) AS channelBucketLabel
  FROM filtered_visits
  WHERE visitorId != ''
),
source_top_aggregate AS (
  SELECT
    sourceGlobalLabel AS label,
    count(*) AS views,
    count(DISTINCT visitorId) AS visitors,
    count(DISTINCT CASE WHEN sessionId != '' THEN sessionId ELSE NULL END) AS sessions
  FROM ranked_visits
  WHERE sourceGlobalLabel != ''
  GROUP BY sourceGlobalLabel
),
source_top_rows AS (
  SELECT
    label,
    views,
    visitors,
    sessions,
    ROW_NUMBER() OVER (
      ORDER BY visitors DESC, views DESC, sessions DESC, label ASC
    ) AS rowOrder
  FROM source_top_aggregate
  ORDER BY visitors DESC, views DESC, sessions DESC, label ASC
  LIMIT ?
),
source_series_rows AS (
  SELECT
    COALESCE(source_top_rows.label, '${SHARE_TREND_OTHER_TOKEN}') AS label,
    count(*) AS views,
    count(DISTINCT ranked_visits.visitorId) AS visitors,
    count(DISTINCT CASE WHEN ranked_visits.sessionId != '' THEN ranked_visits.sessionId ELSE NULL END) AS sessions
  FROM ranked_visits
  LEFT JOIN source_top_rows
    ON source_top_rows.label = ranked_visits.sourceGlobalLabel
  GROUP BY label
),
source_bucket_rows AS (
  SELECT
    ranked_visits.bucket AS bucket,
    COALESCE(source_top_rows.label, '${SHARE_TREND_OTHER_TOKEN}') AS label,
    count(*) AS views,
    count(DISTINCT ranked_visits.visitorId) AS visitors,
    count(DISTINCT CASE WHEN ranked_visits.sessionId != '' THEN ranked_visits.sessionId ELSE NULL END) AS sessions
  FROM ranked_visits
  LEFT JOIN source_top_rows
    ON source_top_rows.label = ranked_visits.sourceBucketLabel
  GROUP BY ranked_visits.bucket, label
),
channel_top_aggregate AS (
  SELECT
    channelGlobalLabel AS label,
    count(*) AS views,
    count(DISTINCT visitorId) AS visitors,
    count(DISTINCT CASE WHEN sessionId != '' THEN sessionId ELSE NULL END) AS sessions
  FROM ranked_visits
  WHERE channelGlobalLabel != ''
  GROUP BY channelGlobalLabel
),
channel_top_rows AS (
  SELECT
    label,
    views,
    visitors,
    sessions,
    ROW_NUMBER() OVER (
      ORDER BY visitors DESC, views DESC, sessions DESC, label ASC
    ) AS rowOrder
  FROM channel_top_aggregate
  ORDER BY visitors DESC, views DESC, sessions DESC, label ASC
  LIMIT ?
),
channel_series_rows AS (
  SELECT
    COALESCE(channel_top_rows.label, '${SHARE_TREND_OTHER_TOKEN}') AS label,
    count(*) AS views,
    count(DISTINCT ranked_visits.visitorId) AS visitors,
    count(DISTINCT CASE WHEN ranked_visits.sessionId != '' THEN ranked_visits.sessionId ELSE NULL END) AS sessions
  FROM ranked_visits
  LEFT JOIN channel_top_rows
    ON channel_top_rows.label = ranked_visits.channelGlobalLabel
  GROUP BY label
),
channel_bucket_rows AS (
  SELECT
    ranked_visits.bucket AS bucket,
    COALESCE(channel_top_rows.label, '${SHARE_TREND_OTHER_TOKEN}') AS label,
    count(*) AS views,
    count(DISTINCT ranked_visits.visitorId) AS visitors,
    count(DISTINCT CASE WHEN ranked_visits.sessionId != '' THEN ranked_visits.sessionId ELSE NULL END) AS sessions
  FROM ranked_visits
  LEFT JOIN channel_top_rows
    ON channel_top_rows.label = ranked_visits.channelBucketLabel
  GROUP BY ranked_visits.bucket, label
)
SELECT
  json_object(
    'top', (
      SELECT json_group_array(json_object(
        'label', label,
        'views', views,
        'visitors', visitors,
        'sessions', sessions
      ))
      FROM (
        SELECT label, views, visitors, sessions
        FROM source_top_rows
        ORDER BY rowOrder ASC
      )
    ),
    'series', (
      SELECT json_group_array(json_object(
        'label', label,
        'views', views,
        'visitors', visitors,
        'sessions', sessions
      ))
      FROM source_series_rows
    ),
    'buckets', (
      SELECT json_group_array(json_object(
        'bucket', bucket,
        'label', label,
        'views', views,
        'visitors', visitors,
        'sessions', sessions
      ))
      FROM source_bucket_rows
    )
  ) AS source,
  json_object(
    'top', (
      SELECT json_group_array(json_object(
        'label', label,
        'views', views,
        'visitors', visitors,
        'sessions', sessions
      ))
      FROM (
        SELECT label, views, visitors, sessions
        FROM channel_top_rows
        ORDER BY rowOrder ASC
      )
    ),
    'series', (
      SELECT json_group_array(json_object(
        'label', label,
        'views', views,
        'visitors', visitors,
        'sessions', sessions
      ))
      FROM channel_series_rows
    ),
    'buckets', (
      SELECT json_group_array(json_object(
        'bucket', bucket,
        'label', label,
        'views', views,
        'visitors', visitors,
        'sessions', sessions
      ))
      FROM channel_bucket_rows
    )
  ) AS channel
`;
  const rows = await queryD1All<ShareTrendQueryRow>(env, sql, [
    ...source.bindings,
    ...bucket.bindings,
    ...source.filterBindings,
    normalizedLimit,
    normalizedLimit,
  ]);

  const row = rows[0];
  return {
    source: mapShareTrendRows(
      combinedShareTrendRows(row?.source),
      buckets,
      sourceDefinition.fallbackKeyBase,
    ),
    channel: mapShareTrendRows(
      combinedShareTrendRows(row?.channel),
      buckets,
      "channel",
    ),
  };
}

export async function queryClientDimensionTrendFromD1(
  env: Env,
  siteId: string,
  window: QueryWindow,
  interval: Interval,
  filters: FilterDocument,
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
  filters: FilterDocument,
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
  filters: FilterDocument,
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
