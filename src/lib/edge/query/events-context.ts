import type { Env } from "@/lib/edge/types";

import type {
  DashboardFilters,
  DimensionRow,
  EventAnalyticsContextCards,
  GeoTabRow,
  QueryWindow,
} from "./core";
import {
  buildEventFilteredSourceCte,
  cityValueExpr,
  clientDimensionDefinition,
  queryD1All,
  regionValueExpr,
  visitSourceBindings,
} from "./core";

export const EVENT_CONTEXT_CARD_KEYS = [
  "path",
  "query",
  "title",
  "hostname",
  "entry",
  "exit",
  "sourceDomain",
  "sourceLink",
  "browser",
  "osVersion",
  "deviceType",
  "language",
  "screenSize",
  "country",
  "region",
  "city",
  "continent",
  "timezone",
  "organization",
] as const;

export type EventContextCardKey = (typeof EVENT_CONTEXT_CARD_KEYS)[number];

export async function queryEventDimensionRowsFromFilteredEvents(
  env: Env,
  baseCte: string,
  bindings: Array<string | number>,
  expr: string,
  limit: number,
  options?: {
    includeEmpty?: boolean;
  },
): Promise<DimensionRow[]> {
  const havingClause = options?.includeEmpty
    ? ""
    : "HAVING TRIM(COALESCE(value, '')) != ''";
  const sql = `${baseCte}
SELECT
  ${expr} AS value,
  count(*) AS views,
  count(DISTINCT CASE WHEN session_id != '' THEN session_id ELSE NULL END) AS sessions,
  count(DISTINCT CASE WHEN visitor_id != '' THEN visitor_id ELSE NULL END) AS visitors
FROM filtered_events
GROUP BY value
${havingClause}
ORDER BY views DESC, sessions DESC, visitors DESC, value ASC
LIMIT ?
`;
  return queryD1All<DimensionRow>(env, sql, [...bindings, limit]);
}

export async function queryEventGeoRowsFromFilteredEvents(
  env: Env,
  baseCte: string,
  bindings: Array<string | number>,
  valueExpr: string,
  labelExpr: string,
  limit: number,
): Promise<GeoTabRow[]> {
  const sql = `${baseCte}
SELECT
  ${valueExpr} AS value,
  ${labelExpr} AS label,
  count(*) AS views,
  count(DISTINCT CASE WHEN session_id != '' THEN session_id ELSE NULL END) AS sessions,
  count(DISTINCT CASE WHEN visitor_id != '' THEN visitor_id ELSE NULL END) AS visitors
FROM filtered_events
GROUP BY value, label
HAVING TRIM(COALESCE(value, '')) != ''
ORDER BY views DESC, sessions DESC, visitors DESC, label ASC
LIMIT ?
`;
  return queryD1All<GeoTabRow>(env, sql, [...bindings, limit]);
}

export async function queryEventSessionBoundaryRowsFromFilteredEvents(
  env: Env,
  baseCte: string,
  bindings: Array<string | number>,
  kind: "entry" | "exit",
  limit: number,
): Promise<DimensionRow[]> {
  const direction = kind === "entry" ? "ASC" : "DESC";
  const sql = `${baseCte},
event_with_session_edge AS (
  SELECT
    COALESCE((
      SELECT edge.pathname
      FROM visit_source edge
      WHERE edge.session_id = filtered_events.session_id
        AND TRIM(COALESCE(edge.pathname, '')) != ''
      ORDER BY edge.started_at ${direction}, edge.visit_id ${direction}
      LIMIT 1
    ), '') AS value,
    session_id,
    visitor_id
  FROM filtered_events
  WHERE TRIM(COALESCE(session_id, '')) != ''
)
SELECT
  value,
  count(*) AS views,
  count(DISTINCT CASE WHEN session_id != '' THEN session_id ELSE NULL END) AS sessions,
  count(DISTINCT CASE WHEN visitor_id != '' THEN visitor_id ELSE NULL END) AS visitors
FROM event_with_session_edge
GROUP BY value
HAVING TRIM(COALESCE(value, '')) != ''
ORDER BY views DESC, sessions DESC, visitors DESC, value ASC
LIMIT ?
`;
  return queryD1All<DimensionRow>(env, sql, [...bindings, limit]);
}

export async function queryEventAnalyticsContextCardsFromD1(
  env: Env,
  siteId: string,
  window: QueryWindow,
  filters: DashboardFilters,
  limit: number,
  eventName?: string,
  selectedKeys: readonly EventContextCardKey[] = EVENT_CONTEXT_CARD_KEYS,
): Promise<EventAnalyticsContextCards> {
  const source = buildEventFilteredSourceCte(
    siteId,
    window,
    filters,
    eventName,
    { materialize: true },
  );
  const dimensions: Array<{
    key: string;
    expr: string;
    includeEmpty?: boolean;
  }> = [
    { key: "path", expr: "pathname" },
    { key: "query", expr: "query_string" },
    { key: "title", expr: "title" },
    { key: "hostname", expr: "hostname" },
    { key: "sourceDomain", expr: "referrer_host", includeEmpty: true },
    { key: "sourceLink", expr: "referrer_url", includeEmpty: true },
    { key: "browser", expr: clientDimensionDefinition("browser").labelExpr },
    {
      key: "osVersion",
      expr: clientDimensionDefinition("osVersion").labelExpr,
    },
    {
      key: "deviceType",
      expr: clientDimensionDefinition("deviceType").labelExpr,
    },
    { key: "language", expr: clientDimensionDefinition("language").labelExpr },
    {
      key: "screenSize",
      expr: clientDimensionDefinition("screenSize").labelExpr,
    },
  ];
  const geoDimensions: Array<{
    key: string;
    valueExpr: string;
    labelExpr: string;
  }> = [
    { key: "country", valueExpr: "country", labelExpr: "country" },
    {
      key: "region",
      valueExpr: regionValueExpr(),
      labelExpr: regionValueExpr(),
    },
    { key: "city", valueExpr: cityValueExpr(), labelExpr: cityValueExpr() },
    { key: "continent", valueExpr: "continent", labelExpr: "continent" },
    { key: "timezone", valueExpr: "timezone", labelExpr: "timezone" },
    {
      key: "organization",
      valueExpr: "as_organization",
      labelExpr: "as_organization",
    },
  ];
  const selectedKeySet = new Set(selectedKeys);
  const cardSources: Array<{ key: EventContextCardKey; sql: string }> = [
    ...dimensions.map(({ key, expr, includeEmpty }) => ({
      key: key as EventContextCardKey,
      sql: `
  SELECT
    '${key}' AS cardType,
    ${expr} AS value,
    NULL AS label,
    count(*) AS views,
    count(DISTINCT CASE WHEN session_id != '' THEN session_id ELSE NULL END) AS sessions,
    count(DISTINCT CASE WHEN visitor_id != '' THEN visitor_id ELSE NULL END) AS visitors
  FROM filtered_events
  ${includeEmpty ? "" : `WHERE TRIM(COALESCE(${expr}, '')) != ''`}
  GROUP BY value`,
    })),
    ...geoDimensions.map(({ key, valueExpr, labelExpr }) => ({
      key: key as EventContextCardKey,
      sql: `
  SELECT
    '${key}' AS cardType,
    ${valueExpr} AS value,
    ${labelExpr} AS label,
    count(*) AS views,
    count(DISTINCT CASE WHEN session_id != '' THEN session_id ELSE NULL END) AS sessions,
    count(DISTINCT CASE WHEN visitor_id != '' THEN visitor_id ELSE NULL END) AS visitors
  FROM filtered_events
  WHERE TRIM(COALESCE(${valueExpr}, '')) != ''
  GROUP BY value, label`,
    })),
    ...(["entry", "exit"] as const).map((kind) => ({
      key: kind,
      sql: `
  SELECT
    '${kind}' AS cardType,
    edges.${kind}Path AS value,
    NULL AS label,
    count(*) AS views,
    count(DISTINCT CASE WHEN fe.session_id != '' THEN fe.session_id ELSE NULL END) AS sessions,
    count(DISTINCT CASE WHEN fe.visitor_id != '' THEN fe.visitor_id ELSE NULL END) AS visitors
  FROM filtered_events fe
  INNER JOIN session_edges edges ON edges.session_id = fe.session_id
  WHERE TRIM(COALESCE(edges.${kind}Path, '')) != ''
      GROUP BY value`,
    })),
  ].filter(({ key }) => selectedKeySet.has(key));
  const cardSourceChunks: Array<Array<{ sql: string }>> = [];
  // D1 currently rejects compound SELECT statements with more than five terms.
  const maxCompoundTerms = 5;
  for (let index = 0; index < cardSources.length; index += maxCompoundTerms) {
    cardSourceChunks.push(cardSources.slice(index, index + maxCompoundTerms));
  }
  const cardGroupCtes = cardSourceChunks.map(
    (sources, index) => `
card_group_${index} AS (
${sources.map(({ sql }) => sql).join("\nUNION ALL")}
)`,
  );
  const needsSessionEdges =
    selectedKeySet.has("entry") || selectedKeySet.has("exit");
  const sessionEdgeCte = needsSessionEdges
    ? `,
event_sessions AS MATERIALIZED (
  SELECT DISTINCT session_id
  FROM filtered_events
  WHERE TRIM(COALESCE(session_id, '')) != ''
),
session_visit_edges AS (
  SELECT
    v.session_id,
    v.pathname,
    ROW_NUMBER() OVER (
      PARTITION BY v.session_id
      ORDER BY v.started_at ASC, v.visit_id ASC
    ) AS first_rank,
    ROW_NUMBER() OVER (
      PARTITION BY v.session_id
      ORDER BY v.started_at DESC, v.visit_id DESC
    ) AS latest_rank
  FROM event_sessions es
  INNER JOIN visits v
    ON v.site_id = ?
   AND v.session_id = es.session_id
   AND v.started_at BETWEEN ? AND ?
  WHERE TRIM(COALESCE(v.pathname, '')) != ''
),
session_edges AS (
  SELECT
    session_id,
    MAX(CASE WHEN first_rank = 1 THEN pathname END) AS entryPath,
    MAX(CASE WHEN latest_rank = 1 THEN pathname END) AS exitPath
  FROM session_visit_edges
  GROUP BY session_id
)`
    : "";
  const rows = await queryD1All<{
    cardType: string;
    value: string | null;
    label: string | null;
    views: number;
    sessions: number;
    visitors: number;
  }>(
    env,
    `${source.cte}${sessionEdgeCte},
${cardGroupCtes.join(",")},
card_rows AS (
${cardSourceChunks
  .map((_, index) => `SELECT * FROM card_group_${index}`)
  .join("\nUNION ALL\n")}
),
ranked_cards AS (
  SELECT
    cardType,
    value,
    label,
    views,
    sessions,
    visitors,
    ROW_NUMBER() OVER (
      PARTITION BY cardType
      ORDER BY views DESC, sessions DESC, visitors DESC, COALESCE(label, value) ASC
    ) AS card_rank
  FROM card_rows
)
SELECT cardType, value, label, views, sessions, visitors
FROM ranked_cards
WHERE card_rank <= ?
ORDER BY cardType ASC, card_rank ASC
`,
    [
      ...source.bindings,
      ...(needsSessionEdges ? visitSourceBindings(siteId, window) : []),
      limit,
    ],
  );
  const byCard = new Map<
    string,
    Array<{
      value: string;
      label: string;
      views: number;
      sessions: number;
      visitors: number;
    }>
  >();
  for (const row of rows) {
    const list = byCard.get(row.cardType) ?? [];
    list.push({
      value: String(row.value ?? ""),
      label: String(row.label ?? row.value ?? ""),
      views: Number(row.views ?? 0),
      sessions: Number(row.sessions ?? 0),
      visitors: Number(row.visitors ?? 0),
    });
    byCard.set(row.cardType, list);
  }
  const dimensionRows = (key: string): DimensionRow[] =>
    (byCard.get(key) ?? []).map(({ value, views, sessions, visitors }) => ({
      value,
      views,
      sessions,
      visitors,
    }));
  const geoRows = (key: string): GeoTabRow[] => byCard.get(key) ?? [];
  const path = dimensionRows("path");
  const query = dimensionRows("query");
  const title = dimensionRows("title");
  const hostname = dimensionRows("hostname");
  const entry = dimensionRows("entry");
  const exit = dimensionRows("exit");
  const sourceDomain = dimensionRows("sourceDomain");
  const sourceLink = dimensionRows("sourceLink");
  const browser = dimensionRows("browser");
  const osVersion = dimensionRows("osVersion");
  const deviceType = dimensionRows("deviceType");
  const language = dimensionRows("language");
  const screenSize = dimensionRows("screenSize");
  const country = geoRows("country");
  const region = geoRows("region");
  const city = geoRows("city");
  const continent = geoRows("continent");
  const timezone = geoRows("timezone");
  const organization = geoRows("organization");

  return {
    page: {
      path,
      query,
      title,
      hostname,
      entry,
      exit,
    },
    source: {
      domain: sourceDomain,
      link: sourceLink,
    },
    client: {
      browser,
      osVersion,
      deviceType,
      language,
      screenSize,
    },
    geo: {
      country,
      region,
      city,
      continent,
      timezone,
      organization,
    },
  };
}
