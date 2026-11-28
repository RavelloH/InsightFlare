import { D1_MAX_BOUND_PARAMETERS, D1_MAX_SQL_UTF8_BYTES } from "@/lib/db";
import { scopedFilterMetadata } from "@/lib/edge/analytics/contract";
import type { Env } from "@/lib/edge/types";

import type {
  EventTrendPointRow,
  EventTrendSeriesRow,
  EventTypeTrendPointRow,
  FilterDocument,
  Interval,
  QueryWindow,
} from "./core";
import {
  buildEventFilteredSourceCte,
  buildTimeBuckets,
  queryD1All,
  SHARE_TREND_OTHER_KEY,
  SHARE_TREND_OTHER_LABEL,
  SHARE_TREND_OTHER_TOKEN,
  shareTrendSeriesKey,
  timeBucketCase,
} from "./core";

/** Comparison needs bucket totals, not the top-event series or Other identities. */
export async function queryEventTotalsTrendFromD1(
  env: Env,
  siteId: string,
  window: QueryWindow,
  interval: Interval,
  filters: FilterDocument,
): Promise<
  readonly { bucket: number; timestampMs: number; totalEvents: number }[]
> {
  const source = buildEventFilteredSourceCte(siteId, window, filters);
  const buckets = buildTimeBuckets(window, interval);
  const bucket = timeBucketCase(buckets, "occurred_at");
  const rows = await queryD1All<{ bucket: number; events: number }>(
    env,
    `${source.cte},
bucketed AS (
  SELECT ${bucket.sql} AS bucket, count(*) AS events
  FROM filtered_events
  GROUP BY bucket
)
SELECT bucket, events FROM bucketed
WHERE bucket IS NOT NULL
ORDER BY bucket ASC`,
    [...source.bindings, ...bucket.bindings],
  );
  const totals = new Map(
    rows.map((row) => [Number(row.bucket), Number(row.events ?? 0)]),
  );
  return buckets.map((item) => ({
    bucket: item.index,
    timestampMs: item.timestampMs,
    totalEvents: totals.get(item.index) ?? 0,
  }));
}

type EventTrendRows = {
  seriesRows: EventTrendSeriesRow[];
  trendRows: EventTrendPointRow[];
  otherSeriesRow?: EventTrendSeriesRow;
};

async function querySharedEventTrendRows(
  env: Env,
  source: ReturnType<typeof buildEventFilteredSourceCte>,
  bucket: ReturnType<typeof timeBucketCase>,
  limit: number,
): Promise<EventTrendRows | null> {
  const sql = `${source.cte},
trend_observations AS MATERIALIZED (
  SELECT event_name, session_id, visitor_id, occurred_at FROM filtered_events
),
top_rows AS MATERIALIZED (
  SELECT event_name AS eventName, count(*) AS events,
    count(DISTINCT CASE WHEN session_id != '' THEN session_id END) AS sessions,
    count(DISTINCT CASE WHEN visitor_id != '' THEN visitor_id END) AS visitors
  FROM trend_observations
  GROUP BY event_name
  ORDER BY events DESC, sessions DESC, eventName ASC
  LIMIT ?
),
bucketed AS (
  SELECT ${bucket.sql} AS bucket,
    CASE WHEN event_name IN (SELECT eventName FROM top_rows) THEN event_name
      ELSE '${SHARE_TREND_OTHER_TOKEN}' END AS seriesKey,
    count(*) AS events
  FROM trend_observations
  GROUP BY bucket, seriesKey
),
other_counts AS (
  SELECT count(*) AS events,
    count(DISTINCT CASE WHEN session_id != '' THEN session_id END) AS sessions,
    count(DISTINCT CASE WHEN visitor_id != '' THEN visitor_id END) AS visitors
  FROM trend_observations
  WHERE event_name NOT IN (SELECT eventName FROM top_rows)
  HAVING count(*) > 0
)
SELECT 'top' AS rowType, eventName, NULL AS bucket, events, sessions, visitors FROM top_rows
UNION ALL SELECT 'bucket', seriesKey, bucket, events, NULL, NULL FROM bucketed WHERE bucket IS NOT NULL
UNION ALL SELECT 'other', '${SHARE_TREND_OTHER_TOKEN}', NULL, events, sessions, visitors FROM other_counts
ORDER BY rowType, events DESC, sessions DESC, eventName ASC, bucket ASC`;
  const bindings = [...source.bindings, limit, ...bucket.bindings];
  if (
    bindings.length > D1_MAX_BOUND_PARAMETERS ||
    new TextEncoder().encode(sql).byteLength > D1_MAX_SQL_UTF8_BYTES
  )
    return null;
  const rows = await queryD1All<
    EventTrendSeriesRow & { rowType: string; bucket: number | null }
  >(env, sql, bindings);
  return {
    seriesRows: rows.filter((row) => row.rowType === "top"),
    trendRows: rows
      .filter((row) => row.rowType === "bucket")
      .map((row) => ({
        bucket: row.bucket!,
        seriesKey: row.eventName,
        events: row.events,
      })),
    otherSeriesRow: rows.find((row) => row.rowType === "other"),
  };
}

export async function queryEventsTrendFromD1(
  env: Env,
  siteId: string,
  window: QueryWindow,
  interval: Interval,
  filters: FilterDocument,
  limit: number,
  eventName?: string,
) {
  const buckets = buildTimeBuckets(window, interval);
  const bucket = timeBucketCase(buckets, "occurred_at");
  const scope = scopedFilterMetadata(filters)?.plan.scope;
  // Nonempty entity scopes repeat costly membership qualification.
  // Reuse the measured Visit-evidence guard only on the shared statement.
  // Preserve the legacy empty-string, zero-limit and budget fallback paths.
  const shareEligible =
    filters.root !== null &&
    (scope === "session" || scope === "visitor") &&
    eventName !== "" &&
    limit > 0;
  const source = buildEventFilteredSourceCte(
    siteId,
    window,
    filters,
    eventName,
    shareEligible ? { inlineVisitEvidence: true } : undefined,
  );
  const shared = shareEligible
    ? await querySharedEventTrendRows(env, source, bucket, limit)
    : null;
  let result: EventTrendRows;
  if (shared) {
    result = shared;
  } else {
    const fallbackSource = shareEligible
      ? buildEventFilteredSourceCte(siteId, window, filters, eventName)
      : source;
    const baseCte = fallbackSource.cte;
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
      [...fallbackSource.bindings, limit],
    );
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
      [...fallbackSource.bindings, ...seriesNames, SHARE_TREND_OTHER_TOKEN],
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
          [...fallbackSource.bindings, SHARE_TREND_OTHER_LABEL, ...seriesNames],
        )
      : [];

    result = { seriesRows, trendRows, otherSeriesRow };
  }
  const { seriesRows, trendRows, otherSeriesRow } = result;
  const hasOther = trendRows.some(
    (row) => String(row.seriesKey) === SHARE_TREND_OTHER_TOKEN,
  );
  const seriesKeyByName = new Map<string, string>();
  const usedKeys = new Set<string>();
  for (const row of seriesRows) {
    seriesKeyByName.set(
      row.eventName,
      shareTrendSeriesKey(row.eventName, usedKeys, "event"),
    );
  }
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
  filters: FilterDocument,
  eventName: string,
) {
  const source = buildEventFilteredSourceCte(
    siteId,
    window,
    filters,
    eventName,
  );
  const buckets = buildTimeBuckets(window, interval);
  const bucket = timeBucketCase(buckets, "occurred_at");
  const rows = await queryD1All<EventTypeTrendPointRow>(
    env,
    `${source.cte},
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
    source.bindings,
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
