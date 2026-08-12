import type { Env } from "@/lib/edge/types";

import type {
  ClientDimensionTabs,
  DashboardFilters,
  DimensionAccumulator,
  DimensionRow,
  GeoDimensionAccumulator,
  GeoDimensionTabs,
  QueryWindow,
  ReferrerRow,
} from "./core";
import {
  addDimensionValue,
  addGeoDimensionValue,
  buildVisitFilterSql,
  buildVisitSourceCte,
  cityValueExpr,
  finalizeDimensionBuckets,
  finalizeGeoDimensionBuckets,
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
  const order = kind === "entry" ? "ASC" : "DESC";
  const sql = `
WITH
${buildVisitSourceCte()},
filtered_visits AS (
  SELECT *
  FROM visit_source
  ${filter.clause}
),
session_edges AS (
  SELECT
    fv.session_id AS session_id,
    (
      SELECT COALESCE(fv2.visitor_id, '')
      FROM filtered_visits fv2
      WHERE fv2.session_id = fv.session_id
      LIMIT 1
    ) AS visitor_id,
    (
      SELECT COALESCE(fv2.pathname, '')
      FROM filtered_visits fv2
      WHERE fv2.session_id = fv.session_id
      ORDER BY fv2.started_at ${order}, fv2.visit_id ${order}
      LIMIT 1
    ) AS value
  FROM filtered_visits fv
  WHERE fv.session_id != ''
  GROUP BY fv.session_id
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
    visitor_id AS visitorId,
    session_id AS sessionId,
    started_at AS startedAt,
    pathname,
    title,
    hostname
  FROM visit_source
  ${filter.clause}
)
SELECT visitorId, sessionId, startedAt, pathname, title, hostname
FROM filtered_visits
`;
  const rows = await queryD1All<Record<string, unknown>>(env, sql, [
    ...visitSourceBindings(siteId, window),
    ...filter.bindings,
  ]);

  const path = new Map<string, DimensionAccumulator>();
  const title = new Map<string, DimensionAccumulator>();
  const hostname = new Map<string, DimensionAccumulator>();
  const entryBySession = new Map<string, { at: number; value: string }>();
  const exitBySession = new Map<string, { at: number; value: string }>();
  const visitorBySession = new Map<string, string>();

  for (const row of rows) {
    const sessionId = String(row.sessionId ?? "");
    const visitorId = String(row.visitorId ?? "");
    const startedAt = Number(row.startedAt ?? 0);
    addDimensionValue(path, String(row.pathname ?? ""), sessionId, visitorId);
    addDimensionValue(title, String(row.title ?? ""), sessionId, visitorId);
    addDimensionValue(
      hostname,
      String(row.hostname ?? ""),
      sessionId,
      visitorId,
    );
    if (!sessionId) continue;
    if (visitorId) visitorBySession.set(sessionId, visitorId);
    const pathname = String(row.pathname ?? "").trim();
    if (!pathname) continue;
    const entry = entryBySession.get(sessionId);
    if (!entry || startedAt < entry.at) {
      entryBySession.set(sessionId, { at: startedAt, value: pathname });
    }
    const exit = exitBySession.get(sessionId);
    if (!exit || startedAt >= exit.at) {
      exitBySession.set(sessionId, { at: startedAt, value: pathname });
    }
  }

  const entry = new Map<string, DimensionAccumulator>();
  const exit = new Map<string, DimensionAccumulator>();
  for (const [sessionId, edge] of entryBySession.entries()) {
    addDimensionValue(
      entry,
      edge.value,
      sessionId,
      visitorBySession.get(sessionId),
    );
  }
  for (const [sessionId, edge] of exitBySession.entries()) {
    addDimensionValue(
      exit,
      edge.value,
      sessionId,
      visitorBySession.get(sessionId),
    );
  }

  return {
    path: finalizeDimensionBuckets(path, limit),
    title: finalizeDimensionBuckets(title, limit),
    hostname: finalizeDimensionBuckets(hostname, limit),
    entry: finalizeDimensionBuckets(entry, limit),
    exit: finalizeDimensionBuckets(exit, limit),
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
    session_id AS sessionId,
    browser,
    os,
    os_version AS osVersion,
    device_type AS deviceType,
    language,
    screen_width AS screenWidth,
    screen_height AS screenHeight
  FROM visit_source
  ${filter.clause}
)
SELECT sessionId, browser, os, osVersion, deviceType, language, screenWidth, screenHeight
FROM filtered_visits
`;
  const rows = await queryD1All<Record<string, unknown>>(env, sql, [
    ...visitSourceBindings(siteId, window),
    ...filter.bindings,
  ]);

  const browser = new Map<string, DimensionAccumulator>();
  const osVersion = new Map<string, DimensionAccumulator>();
  const deviceType = new Map<string, DimensionAccumulator>();
  const language = new Map<string, DimensionAccumulator>();
  const screenSize = new Map<string, DimensionAccumulator>();

  for (const row of rows) {
    const sessionId = String(row.sessionId ?? "");
    addDimensionValue(browser, String(row.browser ?? ""), sessionId);
    addDimensionValue(deviceType, String(row.deviceType ?? ""), sessionId);
    addDimensionValue(language, String(row.language ?? ""), sessionId);
    const os = String(row.os ?? "").trim();
    const version = String(row.osVersion ?? "").trim();
    addDimensionValue(
      osVersion,
      os && version ? `${os} ${version}` : os || version,
      sessionId,
    );
    const width = Number(row.screenWidth ?? 0);
    const height = Number(row.screenHeight ?? 0);
    if (
      Number.isFinite(width) &&
      width > 0 &&
      Number.isFinite(height) &&
      height > 0
    ) {
      addDimensionValue(
        screenSize,
        `${Math.trunc(width)}x${Math.trunc(height)}`,
        sessionId,
      );
    }
  }

  return {
    browser: finalizeDimensionBuckets(browser, limit),
    osVersion: finalizeDimensionBuckets(osVersion, limit),
    deviceType: finalizeDimensionBuckets(deviceType, limit),
    language: finalizeDimensionBuckets(language, limit),
    screenSize: finalizeDimensionBuckets(screenSize, limit),
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
  const sql = `
WITH
${buildVisitSourceCte()},
filtered_visits AS (
  SELECT
    session_id AS sessionId,
    visitor_id AS visitorId,
    country,
    ${regionValueExpr()} AS region,
    ${cityValueExpr()} AS city,
    continent,
    timezone,
    as_organization AS asOrganization
  FROM visit_source
  ${filter.clause}
)
SELECT sessionId, visitorId, country, region, city, continent, timezone, asOrganization
FROM filtered_visits
`;
  const rows = await queryD1All<Record<string, unknown>>(env, sql, [
    ...visitSourceBindings(siteId, window),
    ...filter.bindings,
  ]);

  const country = new Map<string, GeoDimensionAccumulator>();
  const region = new Map<string, GeoDimensionAccumulator>();
  const city = new Map<string, GeoDimensionAccumulator>();
  const continent = new Map<string, GeoDimensionAccumulator>();
  const timezone = new Map<string, GeoDimensionAccumulator>();
  const organization = new Map<string, GeoDimensionAccumulator>();

  for (const row of rows) {
    const sessionId = String(row.sessionId ?? "");
    const visitorId = String(row.visitorId ?? "");
    addGeoDimensionValue(
      country,
      String(row.country ?? ""),
      sessionId,
      visitorId,
    );
    addGeoDimensionValue(
      region,
      String(row.region ?? ""),
      sessionId,
      visitorId,
    );
    addGeoDimensionValue(city, String(row.city ?? ""), sessionId, visitorId);
    addGeoDimensionValue(
      continent,
      String(row.continent ?? ""),
      sessionId,
      visitorId,
    );
    addGeoDimensionValue(
      timezone,
      String(row.timezone ?? ""),
      sessionId,
      visitorId,
    );
    addGeoDimensionValue(
      organization,
      String(row.asOrganization ?? ""),
      sessionId,
      visitorId,
    );
  }

  return {
    country: finalizeGeoDimensionBuckets(country, limit, (value) =>
      geoTabLabel(value, "country"),
    ),
    region: finalizeGeoDimensionBuckets(region, limit, (value) =>
      geoTabLabel(value, "region"),
    ),
    city: finalizeGeoDimensionBuckets(city, limit, (value) =>
      geoTabLabel(value, "city"),
    ),
    continent: finalizeGeoDimensionBuckets(continent, limit),
    timezone: finalizeGeoDimensionBuckets(timezone, limit),
    organization: finalizeGeoDimensionBuckets(organization, limit),
  };
}
