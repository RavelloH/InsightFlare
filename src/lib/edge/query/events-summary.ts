import type { Env } from "@/lib/edge/types";

import type {
  DashboardFilters,
  DimensionRow,
  EventSummaryCards,
  EventSummaryRow,
  QueryWindow,
} from "./core";
import {
  buildCustomEventSourceCte,
  buildEventFilteredSourceCte,
  buildVisitFilterSql,
  buildVisitSourceCte,
  eventSourceBindings,
  queryD1All,
  visitSourceBindings,
} from "./core";

async function queryCustomEventNamesFromD1(
  env: Env,
  siteId: string,
  window: QueryWindow,
  filters: DashboardFilters,
  limit: number,
): Promise<DimensionRow[]> {
  const filter = buildVisitFilterSql(filters, "vc");
  const sql = `
WITH
${buildVisitSourceCte()},
${buildCustomEventSourceCte()},
event_with_context AS (
  SELECT
    e.event_id,
    e.event_name,
    COALESCE(vs.session_id, '') AS session_id,
    COALESCE(vs.visitor_id, '') AS visitor_id,
    COALESCE(vs.country, '') AS country,
    COALESCE(vs.region, '') AS region,
    COALESCE(vs.region_code, '') AS region_code,
    COALESCE(vs.city, '') AS city,
    COALESCE(vs.pathname, '') AS pathname,
    COALESCE(vs.title, '') AS title,
    COALESCE(vs.hostname, '') AS hostname,
    COALESCE(vs.referrer_host, '') AS referrer_host,
    COALESCE(vs.referrer_url, '') AS referrer_url,
    COALESCE(vs.device_type, '') AS device_type,
    COALESCE(vs.browser, '') AS browser,
    COALESCE(vs.os, '') AS os,
    COALESCE(vs.os_version, '') AS os_version,
    COALESCE(vs.language, '') AS language,
    COALESCE(vs.screen_width, 0) AS screen_width,
    COALESCE(vs.screen_height, 0) AS screen_height
  FROM event_source e
  LEFT JOIN visit_source vs
    ON vs.site_id = e.site_id
   AND vs.visit_id = e.visit_id
),
filtered_events AS (
  SELECT *
  FROM event_with_context vc
  ${filter.clause}
),
event_rollup AS (
  SELECT
    COALESCE(event_name, '') AS value,
    count(*) AS views,
    count(DISTINCT CASE WHEN session_id != '' THEN session_id ELSE NULL END) AS sessions,
    count(DISTINCT CASE WHEN visitor_id != '' THEN visitor_id ELSE NULL END) AS visitors
  FROM filtered_events
  GROUP BY value
)
SELECT value, views, sessions, visitors
FROM event_rollup
WHERE TRIM(value) != ''
ORDER BY views DESC, sessions DESC, value ASC
LIMIT ?
`;
  return (
    await queryD1All<Record<string, unknown>>(env, sql, [
      ...visitSourceBindings(siteId, window),
      ...eventSourceBindings(siteId, window),
      ...filter.bindings,
      limit,
    ])
  ).map((row) => ({
    value: String(row.value ?? ""),
    views: Number(row.views ?? 0),
    sessions: Number(row.sessions ?? 0),
    visitors: Number(row.visitors ?? 0),
  }));
}

export async function queryEventTypeAggregate(
  env: Env,
  siteId: string,
  window: QueryWindow,
  filters: DashboardFilters,
  limit: number,
): Promise<DimensionRow[]> {
  return queryCustomEventNamesFromD1(env, siteId, window, filters, limit);
}

export async function queryEventSummaryMetricsFromD1(
  env: Env,
  siteId: string,
  window: QueryWindow,
  filters: DashboardFilters,
): Promise<EventSummaryRow> {
  const source = buildEventFilteredSourceCte(siteId, window, filters);
  const [summaryRow] = await queryD1All<EventSummaryRow>(
    env,
    `${source.cte}
SELECT
  count(*) AS events,
  count(DISTINCT event_name) AS eventTypes,
  count(DISTINCT CASE WHEN session_id != '' THEN session_id ELSE NULL END) AS sessions,
  count(DISTINCT CASE WHEN visitor_id != '' THEN visitor_id ELSE NULL END) AS visitors
FROM filtered_events
`,
    source.bindings,
  );
  return (
    summaryRow ?? {
      events: 0,
      eventTypes: 0,
      sessions: 0,
      visitors: 0,
    }
  );
}

export async function queryEventsSummaryFromD1(
  env: Env,
  siteId: string,
  window: QueryWindow,
  filters: DashboardFilters,
): Promise<{
  summary: EventSummaryRow;
  cards: EventSummaryCards;
}> {
  const source = buildEventFilteredSourceCte(
    siteId,
    window,
    filters,
    undefined,
    {
      materialize: true,
    },
  );
  const rows = await queryD1All<{
    cardType: string;
    value: string | null;
    views: number;
    eventTypes: number;
    sessions: number;
    visitors: number;
  }>(
    env,
    `${source.cte},
card_rows AS (
  SELECT
    '__summary__' AS cardType,
    NULL AS value,
    count(*) AS views,
    count(DISTINCT event_name) AS eventTypes,
    count(DISTINCT CASE WHEN session_id != '' THEN session_id ELSE NULL END) AS sessions,
    count(DISTINCT CASE WHEN visitor_id != '' THEN visitor_id ELSE NULL END) AS visitors
  FROM filtered_events
  UNION ALL
  SELECT 'event', event_name, count(*), 0,
    count(DISTINCT CASE WHEN session_id != '' THEN session_id ELSE NULL END),
    count(DISTINCT CASE WHEN visitor_id != '' THEN visitor_id ELSE NULL END)
  FROM filtered_events
  WHERE TRIM(COALESCE(event_name, '')) != ''
  GROUP BY event_name
  UNION ALL
  SELECT 'path', pathname, count(*), 0,
    count(DISTINCT CASE WHEN session_id != '' THEN session_id ELSE NULL END),
    count(DISTINCT CASE WHEN visitor_id != '' THEN visitor_id ELSE NULL END)
  FROM filtered_events
  WHERE TRIM(COALESCE(pathname, '')) != ''
  GROUP BY pathname
  UNION ALL
  SELECT 'title', title, count(*), 0,
    count(DISTINCT CASE WHEN session_id != '' THEN session_id ELSE NULL END),
    count(DISTINCT CASE WHEN visitor_id != '' THEN visitor_id ELSE NULL END)
  FROM filtered_events
  WHERE TRIM(COALESCE(title, '')) != ''
  GROUP BY title
  UNION ALL
  SELECT 'hostname', hostname, count(*), 0,
    count(DISTINCT CASE WHEN session_id != '' THEN session_id ELSE NULL END),
    count(DISTINCT CASE WHEN visitor_id != '' THEN visitor_id ELSE NULL END)
  FROM filtered_events
  WHERE TRIM(COALESCE(hostname, '')) != ''
  GROUP BY hostname
),
ranked_cards AS (
  SELECT
    cardType,
    value,
    views,
    eventTypes,
    sessions,
    visitors,
    ROW_NUMBER() OVER (
      PARTITION BY cardType
      ORDER BY views DESC, sessions DESC, visitors DESC, value ASC
    ) AS card_rank
  FROM card_rows
)
SELECT cardType, value, views, eventTypes, sessions, visitors
FROM ranked_cards
WHERE cardType = '__summary__' OR card_rank <= 100
ORDER BY cardType ASC, card_rank ASC
`,
    source.bindings,
  );
  const summaryRow = rows.find((row) => row.cardType === "__summary__");
  const summary: EventSummaryRow = summaryRow
    ? {
        events: Number(summaryRow.views ?? 0),
        eventTypes: Number(summaryRow.eventTypes ?? 0),
        sessions: Number(summaryRow.sessions ?? 0),
        visitors: Number(summaryRow.visitors ?? 0),
      }
    : { events: 0, eventTypes: 0, sessions: 0, visitors: 0 };
  const readDimension = (cardType: string): DimensionRow[] =>
    rows
      .filter((row) => row.cardType === cardType)
      .map((row) => ({
        value: String(row.value ?? ""),
        views: Number(row.views ?? 0),
        sessions: Number(row.sessions ?? 0),
        visitors: Number(row.visitors ?? 0),
      }));
  const eventNames = readDimension("event");
  const path = readDimension("path");
  const title = readDimension("title");
  const hostname = readDimension("hostname");

  return {
    summary,
    cards: {
      event: {
        name: eventNames,
      },
      page: {
        path,
        title,
        hostname,
      },
    },
  };
}
