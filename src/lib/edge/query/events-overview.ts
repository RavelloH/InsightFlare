import type { Env } from "@/lib/edge/types";

import type {
  DashboardFilters,
  DimensionRow,
  EventSummaryRow,
  QueryWindow,
} from "./core";
import {
  buildEventAnalyticsSourceCte,
  buildEventFilterSql,
  eventSourceBindings,
  queryD1All,
} from "./core";

export async function queryEventTypeOverviewFromD1(
  env: Env,
  siteId: string,
  window: QueryWindow,
  filters: DashboardFilters,
  eventName: string,
  options?: { includeBreakdowns?: boolean },
) {
  const includeBreakdowns = options?.includeBreakdowns !== false;
  const eventFilter = buildEventFilterSql(filters, "es");
  const hasEventFilter = eventFilter.clause.length > 0;
  const bindings = [
    ...eventSourceBindings(siteId, window, eventName),
    ...eventFilter.bindings,
    ...(hasEventFilter
      ? [...eventSourceBindings(siteId, window), ...eventFilter.bindings]
      : [siteId, window.startMs, window.endExclusiveMs]),
  ];
  const scopedSummaryCte = hasEventFilter
    ? `
${buildEventAnalyticsSourceCte({ cteName: "scoped_event_source" })},
scoped_events AS (
  SELECT *
  FROM scoped_event_source es
  ${eventFilter.clause}
),
scoped_summary AS (
  SELECT count(*) AS events
  FROM scoped_events
)`
    : `
scoped_summary AS (
  SELECT count(*) AS events
  FROM custom_events
  WHERE site_id = ? AND occurred_at >= ? AND occurred_at < ?
)`;
  const baseCte = `
WITH
${buildEventAnalyticsSourceCte({ eventName })},
filtered_events AS MATERIALIZED (
  SELECT *
  FROM event_source es
  ${eventFilter.clause}
),
${scopedSummaryCte}`;
  type OverviewCardRow = EventSummaryRow & {
    cardType: "summary" | "page" | "country" | "device" | "browser";
    value: string | null;
    scopedEvents: number | null;
  };
  const breakdownRows = includeBreakdowns
    ? `
  UNION ALL
  SELECT
    count(*) AS events,
    0 AS eventTypes,
    count(DISTINCT CASE WHEN session_id != '' THEN session_id ELSE NULL END) AS sessions,
    count(DISTINCT CASE WHEN visitor_id != '' THEN visitor_id ELSE NULL END) AS visitors,
    'page' AS cardType,
    pathname AS value
  FROM filtered_events
  WHERE TRIM(COALESCE(pathname, '')) != ''
  GROUP BY pathname
  UNION ALL
  SELECT
    count(*) AS events,
    0 AS eventTypes,
    count(DISTINCT CASE WHEN session_id != '' THEN session_id ELSE NULL END) AS sessions,
    count(DISTINCT CASE WHEN visitor_id != '' THEN visitor_id ELSE NULL END) AS visitors,
    'country' AS cardType,
    country AS value
  FROM filtered_events
  WHERE TRIM(COALESCE(country, '')) != ''
  GROUP BY country
  UNION ALL
  SELECT
    count(*) AS events,
    0 AS eventTypes,
    count(DISTINCT CASE WHEN session_id != '' THEN session_id ELSE NULL END) AS sessions,
    count(DISTINCT CASE WHEN visitor_id != '' THEN visitor_id ELSE NULL END) AS visitors,
    'device' AS cardType,
    device_type AS value
  FROM filtered_events
  WHERE TRIM(COALESCE(device_type, '')) != ''
  GROUP BY device_type
  UNION ALL
  SELECT
    count(*) AS events,
    0 AS eventTypes,
    count(DISTINCT CASE WHEN session_id != '' THEN session_id ELSE NULL END) AS sessions,
    count(DISTINCT CASE WHEN visitor_id != '' THEN visitor_id ELSE NULL END) AS visitors,
    'browser' AS cardType,
    browser AS value
  FROM filtered_events
  WHERE TRIM(COALESCE(browser, '')) != ''
  GROUP BY browser`
    : "";
  const overviewRows = await queryD1All<OverviewCardRow>(
    env,
    `${baseCte},
overview_card_rows AS (
  SELECT
    count(*) AS events,
    count(DISTINCT event_name) AS eventTypes,
    count(DISTINCT CASE WHEN session_id != '' THEN session_id ELSE NULL END) AS sessions,
    count(DISTINCT CASE WHEN visitor_id != '' THEN visitor_id ELSE NULL END) AS visitors,
    'summary' AS cardType,
    NULL AS value
  FROM filtered_events
${breakdownRows}
),
ranked_overview_cards AS (
  SELECT
    cardType,
    value,
    events,
    eventTypes,
    sessions,
    visitors,
    ROW_NUMBER() OVER (
      PARTITION BY cardType
      ORDER BY events DESC, sessions DESC, value ASC
    ) AS cardRank
  FROM overview_card_rows
)
SELECT
  cardType,
  value,
  events,
  eventTypes,
  sessions,
  visitors,
  (SELECT events FROM scoped_summary) AS scopedEvents
FROM ranked_overview_cards
WHERE cardType = 'summary' OR cardRank <= 8
ORDER BY cardType ASC, cardRank ASC
`,
    bindings,
  );
  const summaryRow = overviewRows.find((row) => row.cardType === "summary");
  const readDimension = (
    cardType: OverviewCardRow["cardType"],
  ): DimensionRow[] =>
    overviewRows
      .filter((row) => row.cardType === cardType)
      .map((row) => ({
        value: String(row.value ?? ""),
        views: Number(row.events ?? 0),
        sessions: Number(row.sessions ?? 0),
        visitors: Number(row.visitors ?? 0),
      }));
  const pages = readDimension("page");
  const countries = readDimension("country");
  const devices = readDimension("device");
  const browsers = readDimension("browser");
  const summary = summaryRow ?? {
    events: 0,
    eventTypes: 0,
    sessions: 0,
    visitors: 0,
  };
  const summaryEvents = Number(summary.events ?? 0);
  const summaryEventTypes = Number(summary.eventTypes ?? 0);
  const summarySessions = Number(summary.sessions ?? 0);
  const summaryVisitors = Number(summary.visitors ?? 0);
  const scopedEvents = Number(summaryRow?.scopedEvents ?? 0);
  return {
    summary: {
      events: summaryEvents,
      eventTypes: summaryEventTypes,
      sessions: summarySessions,
      visitors: summaryVisitors,
      avgEventsPerSession:
        summarySessions > 0 ? summaryEvents / summarySessions : 0,
      shareOfAllEvents: scopedEvents > 0 ? summaryEvents / scopedEvents : 0,
    },
    breakdowns: {
      pages,
      countries,
      devices,
      browsers,
    },
  };
}
