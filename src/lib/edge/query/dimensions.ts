import type { Env } from "@/lib/edge/types";

import type {
  ClientDimensionTabs,
  DashboardFilters,
  DimensionRow,
  GeoDimensionTabs,
  GeoTabRow,
  QueryWindow,
  ReferrerRow,
} from "./core";
import {
  buildVisitFilterSql,
  buildVisitSourceCte,
  cityValueExpr,
  geoTabLabel,
  queryD1All,
  regionValueExpr,
  visitSourceBindings,
} from "./core";
import type { D1ReadDiagnostics } from "./diagnostics";

export async function queryDimensionFromD1(
  env: Env,
  siteId: string,
  window: QueryWindow,
  filters: DashboardFilters,
  limit: number,
  selectExpr: string,
  options?: { excludeEmpty?: boolean },
  diagnostics?: D1ReadDiagnostics,
): Promise<DimensionRow[]> {
  const filter = buildVisitFilterSql(filters);
  const sql = `
WITH
${buildVisitSourceCte()},
filtered_visits AS (
  SELECT *
  FROM visit_source
  ${filter.clause}
),
dimension_rollup AS (
  SELECT
    COALESCE(${selectExpr}, '') AS value,
    count(*) AS views,
    count(DISTINCT CASE WHEN session_id != '' THEN session_id ELSE NULL END) AS sessions,
    count(DISTINCT CASE WHEN visitor_id != '' THEN visitor_id ELSE NULL END) AS visitors
  FROM filtered_visits
  GROUP BY value
)
SELECT value, views, sessions, visitors
FROM dimension_rollup
${options?.excludeEmpty ? "WHERE TRIM(value) != ''" : ""}
ORDER BY views DESC, sessions DESC, value ASC
LIMIT ?
`;
  return (
    await queryD1All<Record<string, unknown>>(
      env,
      sql,
      [...visitSourceBindings(siteId, window), ...filter.bindings, limit],
      diagnostics,
    )
  ).map((row) => ({
    value: String(row.value ?? ""),
    views: Number(row.views ?? 0),
    sessions: Number(row.sessions ?? 0),
    visitors: Number(row.visitors ?? 0),
  }));
}

export async function querySessionPathDimensionFromD1(
  env: Env,
  siteId: string,
  window: QueryWindow,
  filters: DashboardFilters,
  limit: number,
  kind: "entry" | "exit",
  diagnostics?: D1ReadDiagnostics,
): Promise<DimensionRow[]> {
  const filter = buildVisitFilterSql(filters);
  const boundaryRank = kind === "entry" ? "first_rank" : "latest_rank";
  const sql = `
WITH
${buildVisitSourceCte()},
filtered_visits AS MATERIALIZED (
  SELECT
    visitor_id,
    session_id,
    started_at,
    visit_id,
    TRIM(COALESCE(pathname, '')) AS pathname
  FROM visit_source
  ${filter.clause}
),
ranked_session_visits AS (
  SELECT
    session_id,
    visitor_id,
    pathname,
    ROW_NUMBER() OVER (
      PARTITION BY session_id
      ORDER BY started_at ASC, visit_id ASC
    ) AS first_rank,
    ROW_NUMBER() OVER (
      PARTITION BY session_id
      ORDER BY started_at DESC, visit_id DESC
    ) AS latest_rank
  FROM filtered_visits
  WHERE session_id != '' AND pathname != ''
),
session_edges AS (
  SELECT
    session_id,
    MAX(CASE WHEN first_rank = 1 THEN visitor_id END) AS visitor_id,
    MAX(CASE WHEN ${boundaryRank} = 1 THEN pathname END) AS value
  FROM ranked_session_visits
  GROUP BY session_id
)
SELECT
  value,
  count(*) AS views,
  count(*) AS sessions,
  count(DISTINCT CASE WHEN visitor_id != '' THEN visitor_id ELSE NULL END) AS visitors
FROM session_edges
WHERE TRIM(value) != ''
GROUP BY value
ORDER BY views DESC, value ASC
LIMIT ?
`;
  return (
    await queryD1All<Record<string, unknown>>(
      env,
      sql,
      [...visitSourceBindings(siteId, window), ...filter.bindings, limit],
      diagnostics,
    )
  ).map((row) => ({
    value: String(row.value ?? ""),
    views: Number(row.views ?? 0),
    sessions: Number(row.sessions ?? 0),
    visitors: Number(row.visitors ?? 0),
  }));
}

export async function queryVisitDimensionFromD1(
  env: Env,
  siteId: string,
  window: QueryWindow,
  filters: DashboardFilters,
  limit: number,
  selectExpr: string,
  options?: { excludeEmpty?: boolean },
  diagnostics?: D1ReadDiagnostics,
): Promise<DimensionRow[]> {
  return queryDimensionFromD1(
    env,
    siteId,
    window,
    filters,
    limit,
    selectExpr,
    options,
    diagnostics,
  );
}

export async function querySessionBoundaryDimensionFromD1(
  env: Env,
  siteId: string,
  window: QueryWindow,
  filters: DashboardFilters,
  limit: number,
  kind: "entry" | "exit",
  diagnostics?: D1ReadDiagnostics,
): Promise<DimensionRow[]> {
  return querySessionPathDimensionFromD1(
    env,
    siteId,
    window,
    filters,
    limit,
    kind,
    diagnostics,
  );
}

export async function queryPageTabsFromD1(
  env: Env,
  siteId: string,
  window: QueryWindow,
  filters: DashboardFilters,
  limit: number,
): Promise<{
  path: DimensionRow[];
  title: DimensionRow[];
  hostname: DimensionRow[];
  entry: DimensionRow[];
  exit: DimensionRow[];
}> {
  const filter = buildVisitFilterSql(filters);
  const sql = `
WITH
${buildVisitSourceCte()},
filtered_visits AS (
  SELECT
    visitor_id,
    session_id,
    started_at,
    visit_id,
    TRIM(COALESCE(pathname, '')) AS pathname,
    TRIM(COALESCE(title, '')) AS title,
    TRIM(COALESCE(hostname, '')) AS hostname
  FROM visit_source
  ${filter.clause}
),
ranked_session_visits AS (
  SELECT
    session_id,
    visitor_id,
    pathname,
    ROW_NUMBER() OVER (
      PARTITION BY session_id
      ORDER BY started_at ASC, visit_id ASC
    ) AS first_rank,
    ROW_NUMBER() OVER (
      PARTITION BY session_id
      ORDER BY started_at DESC, visit_id DESC
    ) AS latest_rank
  FROM filtered_visits
  WHERE session_id != '' AND pathname != ''
),
session_edges AS (
  SELECT
    session_id,
    MAX(CASE WHEN first_rank = 1 THEN visitor_id END) AS visitor_id,
    MAX(CASE WHEN first_rank = 1 THEN pathname END) AS entry,
    MAX(CASE WHEN latest_rank = 1 THEN pathname END) AS exit
  FROM ranked_session_visits
  GROUP BY session_id
),
card_rows AS (
  SELECT
    'path' AS card_type,
    pathname AS value,
    COUNT(*) AS views,
    COUNT(DISTINCT CASE WHEN session_id != '' THEN session_id END) AS sessions,
    COUNT(DISTINCT CASE WHEN visitor_id != '' THEN visitor_id END) AS visitors
  FROM filtered_visits
  WHERE pathname != ''
  GROUP BY pathname
  UNION ALL
  SELECT
    'title' AS card_type,
    title AS value,
    COUNT(*) AS views,
    COUNT(DISTINCT CASE WHEN session_id != '' THEN session_id END) AS sessions,
    COUNT(DISTINCT CASE WHEN visitor_id != '' THEN visitor_id END) AS visitors
  FROM filtered_visits
  WHERE title != ''
  GROUP BY title
  UNION ALL
  SELECT
    'hostname' AS card_type,
    hostname AS value,
    COUNT(*) AS views,
    COUNT(DISTINCT CASE WHEN session_id != '' THEN session_id END) AS sessions,
    COUNT(DISTINCT CASE WHEN visitor_id != '' THEN visitor_id END) AS visitors
  FROM filtered_visits
  WHERE hostname != ''
  GROUP BY hostname
  UNION ALL
  SELECT
    'entry' AS card_type,
    entry AS value,
    COUNT(*) AS views,
    COUNT(*) AS sessions,
    COUNT(DISTINCT CASE WHEN visitor_id != '' THEN visitor_id END) AS visitors
  FROM session_edges
  WHERE entry != ''
  GROUP BY entry
  UNION ALL
  SELECT
    'exit' AS card_type,
    exit AS value,
    COUNT(*) AS views,
    COUNT(*) AS sessions,
    COUNT(DISTINCT CASE WHEN visitor_id != '' THEN visitor_id END) AS visitors
  FROM session_edges
  WHERE exit != ''
  GROUP BY exit
),
ranked_cards AS (
  SELECT
    card_type,
    value,
    views,
    sessions,
    visitors,
    ROW_NUMBER() OVER (
      PARTITION BY card_type
      ORDER BY views DESC, sessions DESC, value ASC
    ) AS card_rank
  FROM card_rows
)
SELECT card_type AS cardType, value, views, sessions, visitors
FROM ranked_cards
WHERE card_rank <= ?
ORDER BY card_type ASC, card_rank ASC
`;
  const rows = await queryD1All<Record<string, unknown>>(env, sql, [
    ...visitSourceBindings(siteId, window),
    ...filter.bindings,
    limit,
  ]);
  const byCard = new Map<string, DimensionRow[]>();
  for (const row of rows) {
    const card = String(row.cardType ?? "");
    const values = byCard.get(card) ?? [];
    values.push({
      value: String(row.value ?? ""),
      views: Number(row.views ?? 0),
      sessions: Number(row.sessions ?? 0),
      visitors: Number(row.visitors ?? 0),
    });
    byCard.set(card, values);
  }
  return {
    path: byCard.get("path") ?? [],
    title: byCard.get("title") ?? [],
    hostname: byCard.get("hostname") ?? [],
    entry: byCard.get("entry") ?? [],
    exit: byCard.get("exit") ?? [],
  };
}

export async function queryReferrersFromD1(
  env: Env,
  siteId: string,
  window: QueryWindow,
  filters: DashboardFilters,
  limit: number,
  includeFullUrl: boolean,
  diagnostics?: D1ReadDiagnostics,
): Promise<ReferrerRow[]> {
  const filter = buildVisitFilterSql(filters);
  const keyExpr = includeFullUrl ? "referrer_url" : "referrer_host";
  const sql = `
WITH
${buildVisitSourceCte()},
filtered_visits AS (
  SELECT *
  FROM visit_source
  ${filter.clause}
)
SELECT
  COALESCE(${keyExpr}, '') AS referrer,
  count(*) AS views,
  count(DISTINCT CASE WHEN session_id != '' THEN session_id ELSE NULL END) AS sessions,
  count(DISTINCT CASE WHEN visitor_id != '' THEN visitor_id ELSE NULL END) AS visitors
FROM filtered_visits
GROUP BY referrer
ORDER BY views DESC, sessions DESC, referrer ASC
LIMIT ?
`;
  return (
    await queryD1All<Record<string, unknown>>(
      env,
      sql,
      [...visitSourceBindings(siteId, window), ...filter.bindings, limit],
      diagnostics,
    )
  ).map((row) => ({
    referrer: String(row.referrer ?? ""),
    views: Number(row.views ?? 0),
    sessions: Number(row.sessions ?? 0),
    visitors: Number(row.visitors ?? 0),
  }));
}

export async function queryOverviewClientDimensionsFromD1(
  env: Env,
  siteId: string,
  window: QueryWindow,
  filters: DashboardFilters,
  limit: number,
): Promise<ClientDimensionTabs> {
  const filter = buildVisitFilterSql(filters);
  const sql = `
WITH
${buildVisitSourceCte()},
filtered_visits AS (
  SELECT
    session_id,
    TRIM(COALESCE(browser, '')) AS browser,
    TRIM(CASE
      WHEN TRIM(COALESCE(os, '')) != '' AND TRIM(COALESCE(os_version, '')) != ''
        THEN TRIM(os) || ' ' || TRIM(os_version)
      WHEN TRIM(COALESCE(os, '')) != '' THEN TRIM(os)
      ELSE TRIM(COALESCE(os_version, ''))
    END) AS osVersion,
    TRIM(COALESCE(device_type, '')) AS deviceType,
    TRIM(COALESCE(language, '')) AS language,
    CASE
      WHEN screen_width > 0 AND screen_height > 0
        THEN CAST(screen_width AS INTEGER) || 'x' || CAST(screen_height AS INTEGER)
      ELSE ''
    END AS screenSize
  FROM visit_source
  ${filter.clause}
),
card_rows AS (
  SELECT 'browser' AS card_type, browser AS value, COUNT(*) AS views,
    COUNT(DISTINCT CASE WHEN session_id != '' THEN session_id END) AS sessions
  FROM filtered_visits WHERE browser != '' GROUP BY browser
  UNION ALL
  SELECT 'osVersion', osVersion, COUNT(*),
    COUNT(DISTINCT CASE WHEN session_id != '' THEN session_id END)
  FROM filtered_visits WHERE osVersion != '' GROUP BY osVersion
  UNION ALL
  SELECT 'deviceType', deviceType, COUNT(*),
    COUNT(DISTINCT CASE WHEN session_id != '' THEN session_id END)
  FROM filtered_visits WHERE deviceType != '' GROUP BY deviceType
  UNION ALL
  SELECT 'language', language, COUNT(*),
    COUNT(DISTINCT CASE WHEN session_id != '' THEN session_id END)
  FROM filtered_visits WHERE language != '' GROUP BY language
  UNION ALL
  SELECT 'screenSize', screenSize, COUNT(*),
    COUNT(DISTINCT CASE WHEN session_id != '' THEN session_id END)
  FROM filtered_visits WHERE screenSize != '' GROUP BY screenSize
),
ranked_cards AS (
  SELECT *, ROW_NUMBER() OVER (
    PARTITION BY card_type ORDER BY views DESC, sessions DESC, value ASC
  ) AS card_rank
  FROM card_rows
)
SELECT card_type AS cardType, value, views, sessions
FROM ranked_cards
WHERE card_rank <= ?
ORDER BY card_type ASC, card_rank ASC
`;
  const rows = await queryD1All<Record<string, unknown>>(env, sql, [
    ...visitSourceBindings(siteId, window),
    ...filter.bindings,
    limit,
  ]);
  const byCard = new Map<string, DimensionRow[]>();
  for (const row of rows) {
    const values = byCard.get(String(row.cardType ?? "")) ?? [];
    values.push({
      value: String(row.value ?? ""),
      views: Number(row.views ?? 0),
      sessions: Number(row.sessions ?? 0),
      visitors: 0,
    });
    byCard.set(String(row.cardType ?? ""), values);
  }
  return {
    browser: byCard.get("browser") ?? [],
    osVersion: byCard.get("osVersion") ?? [],
    deviceType: byCard.get("deviceType") ?? [],
    language: byCard.get("language") ?? [],
    screenSize: byCard.get("screenSize") ?? [],
  };
}

export async function queryOverviewGeoDimensionsFromD1(
  env: Env,
  siteId: string,
  window: QueryWindow,
  filters: DashboardFilters,
  limit: number,
): Promise<GeoDimensionTabs> {
  const filter = buildVisitFilterSql(filters);
  const cardSources = [
    `SELECT 'country' AS card_type, country AS value, COUNT(*) AS views,
    COUNT(DISTINCT CASE WHEN session_id != '' THEN session_id END) AS sessions,
    COUNT(DISTINCT CASE WHEN visitor_id != '' THEN visitor_id END) AS visitors
  FROM filtered_visits WHERE country != '' GROUP BY country`,
    `SELECT 'region', region, COUNT(*),
    COUNT(DISTINCT CASE WHEN session_id != '' THEN session_id END),
    COUNT(DISTINCT CASE WHEN visitor_id != '' THEN visitor_id END)
  FROM filtered_visits WHERE region != '' GROUP BY region`,
    `SELECT 'city', city, COUNT(*),
    COUNT(DISTINCT CASE WHEN session_id != '' THEN session_id END),
    COUNT(DISTINCT CASE WHEN visitor_id != '' THEN visitor_id END)
  FROM filtered_visits WHERE city != '' GROUP BY city`,
    `SELECT 'continent', continent, COUNT(*),
    COUNT(DISTINCT CASE WHEN session_id != '' THEN session_id END),
    COUNT(DISTINCT CASE WHEN visitor_id != '' THEN visitor_id END)
  FROM filtered_visits WHERE continent != '' GROUP BY continent`,
    `SELECT 'timezone', timezone, COUNT(*),
    COUNT(DISTINCT CASE WHEN session_id != '' THEN session_id END),
    COUNT(DISTINCT CASE WHEN visitor_id != '' THEN visitor_id END)
  FROM filtered_visits WHERE timezone != '' GROUP BY timezone`,
    `SELECT 'organization', organization, COUNT(*),
    COUNT(DISTINCT CASE WHEN session_id != '' THEN session_id END),
    COUNT(DISTINCT CASE WHEN visitor_id != '' THEN visitor_id END)
  FROM filtered_visits WHERE organization != '' GROUP BY organization`,
  ];
  // D1 currently rejects compound SELECT statements with more than five terms.
  const maxCompoundTerms = 5;
  const rows = (
    await Promise.all(
      Array.from(
        { length: Math.ceil(cardSources.length / maxCompoundTerms) },
        (_, index) =>
          queryD1All<Record<string, unknown>>(
            env,
            `
WITH
${buildVisitSourceCte()},
filtered_visits AS (
  SELECT
    session_id,
    visitor_id,
    TRIM(COALESCE(country, '')) AS country,
    ${regionValueExpr()} AS region,
    ${cityValueExpr()} AS city,
    TRIM(COALESCE(continent, '')) AS continent,
    TRIM(COALESCE(timezone, '')) AS timezone,
    TRIM(COALESCE(as_organization, '')) AS organization
  FROM visit_source
  ${filter.clause}
),
card_rows AS (
${cardSources
  .slice(index * maxCompoundTerms, (index + 1) * maxCompoundTerms)
  .join("\n  UNION ALL\n")}
),
ranked_cards AS (
  SELECT *, ROW_NUMBER() OVER (
    PARTITION BY card_type
    ORDER BY views DESC, sessions DESC, visitors DESC, value ASC
  ) AS card_rank
  FROM card_rows
)
SELECT card_type AS cardType, value, views, sessions, visitors
FROM ranked_cards
WHERE card_rank <= ?
ORDER BY card_type ASC, card_rank ASC
`,
            [...visitSourceBindings(siteId, window), ...filter.bindings, limit],
          ),
      ),
    )
  ).flat();
  const byCard = new Map<string, GeoTabRow[]>();
  for (const row of rows) {
    const card = String(row.cardType ?? "");
    const value = String(row.value ?? "");
    const values = byCard.get(card) ?? [];
    values.push({
      value,
      label: geoTabLabel(value, card as Parameters<typeof geoTabLabel>[1]),
      views: Number(row.views ?? 0),
      sessions: Number(row.sessions ?? 0),
      visitors: Number(row.visitors ?? 0),
    });
    byCard.set(card, values);
  }
  return {
    country: byCard.get("country") ?? [],
    region: byCard.get("region") ?? [],
    city: byCard.get("city") ?? [],
    continent: byCard.get("continent") ?? [],
    timezone: byCard.get("timezone") ?? [],
    organization: byCard.get("organization") ?? [],
  };
}
