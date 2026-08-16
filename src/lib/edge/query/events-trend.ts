import type { Env } from "@/lib/edge/types";

import type {
  DashboardFilters,
  EventTrendPointRow,
  EventTrendSeriesRow,
  EventTypeTrendPointRow,
  Interval,
  QueryWindow,
} from "./core";
import {
  buildEventAnalyticsSourceCte,
  buildEventFilterSql,
  buildTimeBuckets,
  eventSourceBindings,
  queryD1All,
  SHARE_TREND_OTHER_KEY,
  SHARE_TREND_OTHER_LABEL,
  SHARE_TREND_OTHER_TOKEN,
  shareTrendSeriesKey,
  timeBucketCase,
} from "./core";

export async function queryEventsTrendFromD1(
  env: Env,
  siteId: string,
  window: QueryWindow,
  interval: Interval,
  filters: DashboardFilters,
  limit: number,
  eventName?: string,
) {
  const filter = buildEventFilterSql(filters, "es", { eventName });
  const sourceBindings = [...eventSourceBindings(siteId, window)];
  const filterBindings = filter.bindings;
  const baseCte = `
WITH
${buildEventAnalyticsSourceCte()},
filtered_events AS (
  SELECT *
  FROM event_source es
  ${filter.clause}
)`;
  const seriesRows = await queryD1All<EventTrendSeriesRow>(
    env,
    `${baseCte}
SELECT
  event_name AS eventName,
  count(*) AS events,
  count(DISTINCT CASE WHEN session_id != '' THEN session_id ELSE NULL END) AS sessions,
  count(DISTINCT CASE WHEN visitor_id != '' THEN visitor_id ELSE NULL END) AS visitors
FROM filtered_events
GROUP BY event_name
ORDER BY events DESC, sessions DESC, eventName ASC
LIMIT ?
`,
    [...sourceBindings, ...filterBindings, limit],
  );
  const buckets = buildTimeBuckets(window, interval);
  const bucket = timeBucketCase(buckets, "occurred_at");
  const seriesKeyByName = new Map<string, string>();
  const usedKeys = new Set<string>();
  for (const row of seriesRows) {
    seriesKeyByName.set(
      row.eventName,
      shareTrendSeriesKey(row.eventName, usedKeys, "event"),
    );
  }
  const seriesNames = seriesRows.map((row) => row.eventName);
  const namesClause =
    seriesNames.length > 0
      ? `CASE WHEN event_name IN (${seriesNames.map(() => "?").join(", ")}) THEN event_name ELSE ? END`
      : "?";
  const trendRows = await queryD1All<EventTrendPointRow>(
    env,
    `${baseCte},
bucketed AS (
  SELECT
    ${bucket.sql} AS bucket,
    ${namesClause} AS seriesName,
    count(*) AS events
  FROM filtered_events
  GROUP BY bucket, seriesName
)
SELECT
  bucket,
  seriesName AS seriesKey,
  events
FROM bucketed
WHERE bucket IS NOT NULL
ORDER BY bucket ASC
`,
    [
      ...sourceBindings,
      ...filterBindings,
      ...seriesNames,
      SHARE_TREND_OTHER_TOKEN,
    ],
  );
  const hasOther = trendRows.some(
    (row) => String(row.seriesKey) === SHARE_TREND_OTHER_TOKEN,
  );
  const [otherSeriesRow] = hasOther
    ? await queryD1All<EventTrendSeriesRow>(
        env,
        `${baseCte}
SELECT
  ? AS eventName,
  count(*) AS events,
  count(DISTINCT CASE WHEN session_id != '' THEN session_id ELSE NULL END) AS sessions,
  count(DISTINCT CASE WHEN visitor_id != '' THEN visitor_id ELSE NULL END) AS visitors
FROM filtered_events
${seriesNames.length > 0 ? `WHERE event_name NOT IN (${seriesNames.map(() => "?").join(", ")})` : ""}
`,
        [
          ...sourceBindings,
          ...filterBindings,
          SHARE_TREND_OTHER_LABEL,
          ...seriesNames,
        ],
      )
    : [];
  const series: Array<{
    key: string;
    eventName: string;
    label: string;
    events: number;
    sessions: number;
    visitors: number;
    isOther?: boolean;
  }> = seriesRows.map((row) => ({
    key: seriesKeyByName.get(row.eventName)!,
    eventName: row.eventName,
    label: row.eventName,
    events: row.events,
    sessions: row.sessions,
    visitors: row.visitors,
  }));
  if (hasOther) {
    series.push({
      key: SHARE_TREND_OTHER_KEY,
      eventName: SHARE_TREND_OTHER_LABEL,
      label: SHARE_TREND_OTHER_LABEL,
      events:
        Number(otherSeriesRow?.events ?? 0) ||
        trendRows
          .filter((row) => String(row.seriesKey) === SHARE_TREND_OTHER_TOKEN)
          .reduce((sum, row) => sum + Number(row.events ?? 0), 0),
      sessions: Number(otherSeriesRow?.sessions ?? 0),
      visitors: Number(otherSeriesRow?.visitors ?? 0),
      isOther: true,
    });
  }
  const data = buckets.map((item) => ({
    bucket: item.index,
    timestampMs: item.timestampMs,
    totalEvents: 0,
    eventsBySeries: {} as Record<string, number>,
  }));
  for (const row of trendRows) {
    const bucketIndex = Number(row.bucket ?? -1);
    const point = data[bucketIndex];
    if (!point) continue;
    const rawSeries = String(row.seriesKey ?? "");
    const key =
      rawSeries === SHARE_TREND_OTHER_TOKEN
        ? SHARE_TREND_OTHER_KEY
        : (seriesKeyByName.get(rawSeries) ?? rawSeries);
    const events = Number(row.events ?? 0);
    point.eventsBySeries[key] = events;
    point.totalEvents += events;
  }
  return { series, data };
}

export async function queryEventTypeTrendFromD1(
  env: Env,
  siteId: string,
  window: QueryWindow,
  interval: Interval,
  filters: DashboardFilters,
  eventName: string,
) {
  const filter = buildEventFilterSql(filters, "es");
  const buckets = buildTimeBuckets(window, interval);
  const bucket = timeBucketCase(buckets, "occurred_at");
  const rows = await queryD1All<EventTypeTrendPointRow>(
    env,
    `
WITH
${buildEventAnalyticsSourceCte({ eventName })},
filtered_events AS (
  SELECT *
  FROM event_source es
  ${filter.clause}
),
bucketed AS (
  SELECT
    ${bucket.sql} AS bucket,
    count(*) AS events,
    count(DISTINCT CASE WHEN visitor_id != '' THEN visitor_id ELSE NULL END) AS visitors
  FROM filtered_events
  GROUP BY bucket
)
SELECT
  bucket,
  events,
  visitors
FROM bucketed
WHERE bucket IS NOT NULL
ORDER BY bucket ASC
`,
    [...eventSourceBindings(siteId, window, eventName), ...filter.bindings],
  );
  const data = buckets.map((item) => ({
    bucket: item.index,
    timestampMs: item.timestampMs,
    events: 0,
    visitors: 0,
  }));
  for (const row of rows) {
    const bucketIndex = Number(row.bucket ?? -1);
    const point = data[bucketIndex];
    if (!point) continue;
    point.events = Number(row.events ?? 0);
    point.visitors = Number(row.visitors ?? 0);
  }
  return { data };
}
