import type { Env } from "@/lib/edge/types";

import type {
  DimensionRow,
  EventSummaryCards,
  EventSummaryRow,
  FilterDocument,
  QueryWindow,
} from "./core";
import { buildEventFilteredSourceCte, queryD1All } from "./core";

async function queryCustomEventNamesFromD1(
  env: Env,
  siteId: string,
  window: QueryWindow,
  filters: FilterDocument,
  limit: number,
  search?: string,
): Promise<DimensionRow[]> {
  const source = buildEventFilteredSourceCte(siteId, window, filters);
  const limitClause = limit > 0 ? "\nLIMIT ?" : "";
  const sql = `
${source.cte},
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
${search ? "AND LOWER(value) LIKE ? ESCAPE '\\'" : ""}
ORDER BY views DESC, sessions DESC, value ASC
${limitClause}
`;
  return (
    await queryD1All<Record<string, unknown>>(env, sql, [
      ...source.bindings,
      ...(search
        ? [
            `%${search
              .trim()
              .toLowerCase()
              .replaceAll("\\", "\\\\")
              .replaceAll("%", "\\%")
              .replaceAll("_", "\\_")}%`,
          ]
        : []),
      ...(limit > 0 ? [limit] : []),
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
  filters: FilterDocument,
  limit: number,
  search?: string,
): Promise<DimensionRow[]> {
  return queryCustomEventNamesFromD1(
    env,
    siteId,
    window,
    filters,
    limit,
    search,
  );
}

export async function queryEventSummaryMetricsFromD1(
  env: Env,
  siteId: string,
  window: QueryWindow,
  filters: FilterDocument,
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
  filters: FilterDocument,
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
