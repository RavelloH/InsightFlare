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
  buildVisitSourceCte,
  eventSourceBindings,
  queryD1All,
  visitSourceBindings,
} from "./core";
import { queryEventSummaryMetricsFromD1 } from "./events-summary";

export async function queryEventTypeOverviewFromD1(
  env: Env,
  siteId: string,
  window: QueryWindow,
  filters: DashboardFilters,
  eventName: string,
) {
  const scopedSummary = await queryEventSummaryMetricsFromD1(
    env,
    siteId,
    window,
    filters,
  );
  const eventFilter = buildEventFilterSql(filters, "es", { eventName });
  const bindings = [
    ...visitSourceBindings(siteId, window),
    ...eventSourceBindings(siteId, window),
    ...eventFilter.bindings,
  ];
  const baseCte = `
WITH
${buildVisitSourceCte()},
${buildEventAnalyticsSourceCte()},
filtered_events AS MATERIALIZED (
  SELECT *
  FROM event_source es
  ${eventFilter.clause}
)`;
  type OverviewCardRow = EventSummaryRow & {
    cardType: "summary" | "page" | "country" | "device" | "browser";
    value: string | null;
  };
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
  GROUP BY browser
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
SELECT cardType, value, events, eventTypes, sessions, visitors
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
  return {
    summary: {
      events: Number(summary.events ?? 0),
      eventTypes: Number(summary.eventTypes ?? 0),
      sessions: Number(summary.sessions ?? 0),
      visitors: Number(summary.visitors ?? 0),
      avgEventsPerSession:
        Number(summary.sessions ?? 0) > 0
          ? Number(summary.events ?? 0) / Number(summary.sessions ?? 0)
          : 0,
      shareOfAllEvents:
        Number(scopedSummary.events ?? 0) > 0
          ? Number(summary.events ?? 0) / Number(scopedSummary.events ?? 0)
          : 0,
    },
    breakdowns: {
      pages,
      countries,
      devices,
      browsers,
    },
  };
}
