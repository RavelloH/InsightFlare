import type { Env } from "./types";

export const ANALYTICS_WINDOW_MS = 90 * 24 * 60 * 60 * 1000;

export interface AeRange {
  fromMs: number;
  toMs: number;
}

export interface AeQueryFilters {
  country?: string;
  device?: string;
  browser?: string;
}

export interface AeOverviewRow {
  views: number;
  sessions: number;
  visitors: number;
  bounces: number;
  total_duration: number;
  duration_views: number;
}

export interface AeTrendRow {
  bucket: number;
  views: number;
  visitors: number;
  sessions: number;
  bounces: number;
  total_duration: number;
  duration_views: number;
}

export interface AeDimensionRow {
  key: string;
  views: number;
  sessions: number;
}

export interface AeTopPageRow {
  pathname: string;
  query_string: string;
  hash_fragment: string;
  title: string;
  hostname: string;
  views: number;
  sessions: number;
}

export interface AeReferrerRow {
  ref: string;
  views: number;
  sessions: number;
}

export interface AeVisitorRow {
  visitor_id: string;
  first_seen_at: number;
  last_seen_at: number;
  views: number;
  sessions: number;
}

const DATASET = "insightflare_events";
const LAYOUT_VERSION = 4;
const MAX_SQL_LIMIT = 2000;

function sqlString(value: string): string {
  return `'${String(value).replace(/'/g, "''")}'`;
}

function clampLimit(limit: number, fallback = 100): number {
  const value = Math.floor(limit);
  if (!Number.isFinite(value) || value <= 0) return fallback;
  return Math.min(MAX_SQL_LIMIT, value);
}

function parseNumber(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return 0;
}

function parseString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

export function isAnalyticsSqlConfigured(env: Env): boolean {
  return Boolean(String(env.ANALYTICS_ACCOUNT_ID || "").trim() && String(env.ANALYTICS_SQL_API_TOKEN || "").trim());
}

export function isRangeWithinAnalyticsWindow(fromMs: number, nowMs: number): boolean {
  return fromMs >= nowMs - ANALYTICS_WINDOW_MS;
}

function buildVisitFilterClause(filters?: AeQueryFilters): string {
  const clauses: string[] = [];
  if (filters?.country) {
    clauses.push(`country = ${sqlString(filters.country.trim())}`);
  }
  if (filters?.device) {
    clauses.push(`device_type = ${sqlString(filters.device.trim())}`);
  }
  if (filters?.browser) {
    clauses.push(`browser = ${sqlString(filters.browser.trim())}`);
  }
  return clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
}

function visitCtes(siteId: string, range: AeRange): string {
  return `
visit_rows AS (
  SELECT
    blob1 AS row_type,
    blob2 AS visit_id,
    blob3 AS visitor_id,
    blob4 AS session_id,
    blob5 AS pathname,
    blob6 AS query_string,
    blob7 AS hash_fragment,
    blob8 AS hostname,
    blob9 AS referrer_url,
    blob10 AS referrer_host,
    blob11 AS country,
    blob12 AS region,
    blob13 AS city,
    blob14 AS browser,
    blob15 AS os,
    blob16 AS os_version,
    blob17 AS device_type,
    blob18 AS language,
    blob19 AS timezone,
    blob20 AS extra_value,
    index2 AS continent,
    index3 AS as_organization,
    double1 AS event_at,
    double2 AS duration_ms,
    double3 AS started_at,
    double4 AS screen_width,
    double5 AS screen_height
  FROM ${DATASET}
  WHERE index1 = ${sqlString(siteId)}
    AND double6 >= ${LAYOUT_VERSION}
    AND double3 BETWEEN ${Math.floor(range.fromMs)} AND ${Math.floor(range.toMs)}
    AND blob1 IN ('visit_start', 'visit_finalize')
),
visits AS (
  SELECT
    visit_id,
    argMax(visitor_id, if(row_type = 'visit_start', event_at, -1)) AS visitor_id,
    argMax(session_id, if(row_type = 'visit_start', event_at, -1)) AS session_id,
    argMax(pathname, if(row_type = 'visit_start', event_at, -1)) AS pathname,
    argMax(query_string, if(row_type = 'visit_start', event_at, -1)) AS query_string,
    argMax(hash_fragment, if(row_type = 'visit_start', event_at, -1)) AS hash_fragment,
    argMax(hostname, if(row_type = 'visit_start', event_at, -1)) AS hostname,
    argMax(referrer_url, if(row_type = 'visit_start', event_at, -1)) AS referrer_url,
    argMax(referrer_host, if(row_type = 'visit_start', event_at, -1)) AS referrer_host,
    argMax(country, if(row_type = 'visit_start', event_at, -1)) AS country,
    argMax(region, if(row_type = 'visit_start', event_at, -1)) AS region,
    argMax(city, if(row_type = 'visit_start', event_at, -1)) AS city,
    argMax(browser, if(row_type = 'visit_start', event_at, -1)) AS browser,
    argMax(os, if(row_type = 'visit_start', event_at, -1)) AS os,
    argMax(os_version, if(row_type = 'visit_start', event_at, -1)) AS os_version,
    argMax(device_type, if(row_type = 'visit_start', event_at, -1)) AS device_type,
    argMax(language, if(row_type = 'visit_start', event_at, -1)) AS language,
    argMax(timezone, if(row_type = 'visit_start', event_at, -1)) AS timezone,
    argMax(continent, if(row_type = 'visit_start', event_at, -1)) AS continent,
    argMax(as_organization, if(row_type = 'visit_start', event_at, -1)) AS as_organization,
    argMax(extra_value, if(row_type = 'visit_start', event_at, -1)) AS title,
    argMax(screen_width, if(row_type = 'visit_start', event_at, -1)) AS screen_width,
    argMax(screen_height, if(row_type = 'visit_start', event_at, -1)) AS screen_height,
    max(if(row_type = 'visit_start', started_at, NULL)) AS started_at,
    max(if(row_type = 'visit_finalize', event_at, NULL)) AS finalized_at,
    max(if(row_type = 'visit_finalize', duration_ms, NULL)) AS duration_ms,
    argMax(extra_value, if(row_type = 'visit_finalize', event_at, -1)) AS finalize_meta
  FROM visit_rows
  GROUP BY visit_id
)`;
}

function screenSizeExpr(): string {
  return `
CASE
  WHEN screen_width > 0 AND screen_height > 0 THEN concat(toString(toInt32(screen_width)), 'x', toString(toInt32(screen_height)))
  ELSE ''
END`;
}

async function runAeSql<T extends Record<string, unknown>>(env: Env, sql: string): Promise<T[]> {
  if (!isAnalyticsSqlConfigured(env)) {
    throw new Error("Analytics Engine SQL config missing");
  }

  const endpoint = `https://api.cloudflare.com/client/v4/accounts/${String(env.ANALYTICS_ACCOUNT_ID).trim()}/analytics_engine/sql`;
  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      authorization: `Bearer ${String(env.ANALYTICS_SQL_API_TOKEN).trim()}`,
      "content-type": "text/plain",
    },
    body: sql,
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Analytics Engine SQL failed (${response.status}): ${text.slice(0, 512)}`);
  }

  const payload = (await response.json()) as Record<string, unknown>;
  if (Array.isArray(payload.data)) {
    return payload.data as T[];
  }
  const result = payload.result;
  if (result && typeof result === "object") {
    const record = result as Record<string, unknown>;
    if (Array.isArray(record.data)) return record.data as T[];
    if (Array.isArray(record.results)) return record.results as T[];
  }
  if (Array.isArray(payload.results)) {
    return payload.results as T[];
  }
  return [];
}

export async function queryAeOverview(
  env: Env,
  siteId: string,
  range: AeRange,
  filters?: AeQueryFilters,
): Promise<AeOverviewRow> {
  const sql = `
WITH
${visitCtes(siteId, range)},
filtered_visits AS (
  SELECT *
  FROM visits
  ${buildVisitFilterClause(filters)}
),
session_rollup AS (
  SELECT session_id, count() AS visit_count
  FROM filtered_visits
  WHERE session_id != ''
  GROUP BY session_id
)
SELECT
  count() AS views,
  count(DISTINCT session_id) AS sessions,
  count(DISTINCT visitor_id) AS visitors,
  (SELECT count() FROM session_rollup WHERE visit_count = 1) AS bounces,
  sum(if(duration_ms IS NOT NULL AND duration_ms >= 0, duration_ms, 0)) AS total_duration,
  sum(if(duration_ms IS NOT NULL AND duration_ms >= 0, 1, 0)) AS duration_views
FROM filtered_visits
`;
  const row = (await runAeSql<Record<string, unknown>>(env, sql))[0] ?? {};
  return {
    views: parseNumber(row.views),
    sessions: parseNumber(row.sessions),
    visitors: parseNumber(row.visitors),
    bounces: parseNumber(row.bounces),
    total_duration: parseNumber(row.total_duration),
    duration_views: parseNumber(row.duration_views),
  };
}

export async function queryAeTrend(
  env: Env,
  siteId: string,
  range: AeRange,
  interval: "minute" | "hour" | "day" | "week" | "month",
  filters?: AeQueryFilters,
): Promise<AeTrendRow[]> {
  const bucketDivisor =
    interval === "minute"
      ? 60_000
      : interval === "hour"
        ? 3_600_000
        : interval === "day"
          ? 86_400_000
          : interval === "week"
            ? 604_800_000
            : 2_592_000_000;

  const sql = `
WITH
${visitCtes(siteId, range)},
filtered_visits AS (
  SELECT *
  FROM visits
  ${buildVisitFilterClause(filters)}
),
visit_bucket_rollup AS (
  SELECT
    floor(started_at / ${bucketDivisor}) AS bucket,
    count() AS views,
    count(DISTINCT visitor_id) AS visitors,
    sum(if(duration_ms IS NOT NULL AND duration_ms >= 0, duration_ms, 0)) AS total_duration,
    sum(if(duration_ms IS NOT NULL AND duration_ms >= 0, 1, 0)) AS duration_views
  FROM filtered_visits
  GROUP BY bucket
),
session_rollup AS (
  SELECT
    session_id,
    min(started_at) AS session_started_at,
    count() AS visit_count
  FROM filtered_visits
  WHERE session_id != ''
  GROUP BY session_id
),
session_bucket_rollup AS (
  SELECT
    floor(session_started_at / ${bucketDivisor}) AS bucket,
    count() AS sessions,
    sum(if(visit_count = 1, 1, 0)) AS bounces
  FROM session_rollup
  GROUP BY bucket
),
combined AS (
  SELECT bucket, views, visitors, 0 AS sessions, 0 AS bounces, total_duration, duration_views FROM visit_bucket_rollup
  UNION ALL
  SELECT bucket, 0 AS views, 0 AS visitors, sessions, bounces, 0 AS total_duration, 0 AS duration_views FROM session_bucket_rollup
)
SELECT
  bucket,
  sum(views) AS views,
  sum(visitors) AS visitors,
  sum(sessions) AS sessions,
  sum(bounces) AS bounces,
  sum(total_duration) AS total_duration,
  sum(duration_views) AS duration_views
FROM combined
GROUP BY bucket
ORDER BY bucket
`;

  return (await runAeSql<Record<string, unknown>>(env, sql)).map((row) => ({
    bucket: parseNumber(row.bucket),
    views: parseNumber(row.views),
    visitors: parseNumber(row.visitors),
    sessions: parseNumber(row.sessions),
    bounces: parseNumber(row.bounces),
    total_duration: parseNumber(row.total_duration),
    duration_views: parseNumber(row.duration_views),
  }));
}

async function queryAeVisitDimension(
  env: Env,
  siteId: string,
  range: AeRange,
  limit: number,
  selectExpr: string,
  filters?: AeQueryFilters,
): Promise<AeDimensionRow[]> {
  const sql = `
WITH
${visitCtes(siteId, range)},
filtered_visits AS (
  SELECT *
  FROM visits
  ${buildVisitFilterClause(filters)}
)
SELECT
  ${selectExpr} AS key,
  count() AS views,
  count(DISTINCT session_id) AS sessions
FROM filtered_visits
GROUP BY key
ORDER BY views DESC
LIMIT ${clampLimit(limit, 30)}
`;

  return (await runAeSql<Record<string, unknown>>(env, sql)).map((row) => ({
    key: parseString(row.key),
    views: parseNumber(row.views),
    sessions: parseNumber(row.sessions),
  }));
}

export async function queryAeTopPages(
  env: Env,
  siteId: string,
  range: AeRange,
  limit: number,
  includeDetails: boolean,
  filters?: AeQueryFilters,
): Promise<AeTopPageRow[]> {
  const sql = `
WITH
${visitCtes(siteId, range)},
filtered_visits AS (
  SELECT *
  FROM visits
  ${buildVisitFilterClause(filters)}
)
SELECT
  pathname,
  ${includeDetails ? "query_string," : "'' AS query_string,"}
  ${includeDetails ? "hash_fragment," : "'' AS hash_fragment,"}
  argMax(title, started_at) AS title,
  argMax(hostname, started_at) AS hostname,
  count() AS views,
  count(DISTINCT session_id) AS sessions
FROM filtered_visits
GROUP BY pathname, query_string, hash_fragment
ORDER BY views DESC
LIMIT ${clampLimit(limit, 30)}
`;

  return (await runAeSql<Record<string, unknown>>(env, sql)).map((row) => ({
    pathname: parseString(row.pathname),
    query_string: parseString(row.query_string),
    hash_fragment: parseString(row.hash_fragment),
    title: parseString(row.title),
    hostname: parseString(row.hostname),
    views: parseNumber(row.views),
    sessions: parseNumber(row.sessions),
  }));
}

export async function queryAeTopPathnames(
  env: Env,
  siteId: string,
  range: AeRange,
  limit: number,
  filters?: AeQueryFilters,
): Promise<AeDimensionRow[]> {
  return queryAeVisitDimension(env, siteId, range, limit, "pathname", filters);
}

export async function queryAeTopTitles(
  env: Env,
  siteId: string,
  range: AeRange,
  limit: number,
  filters?: AeQueryFilters,
): Promise<AeDimensionRow[]> {
  return queryAeVisitDimension(env, siteId, range, limit, "title", filters);
}

export async function queryAeTopHostnames(
  env: Env,
  siteId: string,
  range: AeRange,
  limit: number,
  filters?: AeQueryFilters,
): Promise<AeDimensionRow[]> {
  return queryAeVisitDimension(env, siteId, range, limit, "hostname", filters);
}

export async function queryAeEntryPages(
  env: Env,
  siteId: string,
  range: AeRange,
  limit: number,
  filters?: AeQueryFilters,
): Promise<AeDimensionRow[]> {
  const sql = `
WITH
${visitCtes(siteId, range)},
filtered_visits AS (
  SELECT *
  FROM visits
  ${buildVisitFilterClause(filters)}
),
session_rollup AS (
  SELECT
    session_id,
    argMin(pathname, started_at) AS entry_path
  FROM filtered_visits
  WHERE session_id != ''
  GROUP BY session_id
)
SELECT
  entry_path AS key,
  count() AS views,
  count() AS sessions
FROM session_rollup
GROUP BY key
ORDER BY views DESC
LIMIT ${clampLimit(limit, 30)}
`;
  return (await runAeSql<Record<string, unknown>>(env, sql)).map((row) => ({
    key: parseString(row.key),
    views: parseNumber(row.views),
    sessions: parseNumber(row.sessions),
  }));
}

export async function queryAeExitPages(
  env: Env,
  siteId: string,
  range: AeRange,
  limit: number,
  filters?: AeQueryFilters,
): Promise<AeDimensionRow[]> {
  const sql = `
WITH
${visitCtes(siteId, range)},
filtered_visits AS (
  SELECT *
  FROM visits
  ${buildVisitFilterClause(filters)}
),
session_rollup AS (
  SELECT
    session_id,
    argMax(pathname, started_at) AS exit_path
  FROM filtered_visits
  WHERE session_id != ''
  GROUP BY session_id
)
SELECT
  exit_path AS key,
  count() AS views,
  count() AS sessions
FROM session_rollup
GROUP BY key
ORDER BY views DESC
LIMIT ${clampLimit(limit, 30)}
`;
  return (await runAeSql<Record<string, unknown>>(env, sql)).map((row) => ({
    key: parseString(row.key),
    views: parseNumber(row.views),
    sessions: parseNumber(row.sessions),
  }));
}

export async function queryAeReferrers(
  env: Env,
  siteId: string,
  range: AeRange,
  limit: number,
  includeFullUrl: boolean,
  filters?: AeQueryFilters,
): Promise<AeReferrerRow[]> {
  const keyExpr = includeFullUrl ? "referrer_url" : "referrer_host";
  const rows = await queryAeVisitDimension(env, siteId, range, limit, keyExpr, filters);
  return rows.map((row) => ({
    ref: row.key,
    views: row.views,
    sessions: row.sessions,
  }));
}

export async function queryAeTopCountries(env: Env, siteId: string, range: AeRange, limit: number, filters?: AeQueryFilters) {
  return queryAeVisitDimension(env, siteId, range, limit, "country", filters);
}

export async function queryAeTopDevices(env: Env, siteId: string, range: AeRange, limit: number, filters?: AeQueryFilters) {
  return queryAeVisitDimension(env, siteId, range, limit, "device_type", filters);
}

export async function queryAeTopBrowsers(env: Env, siteId: string, range: AeRange, limit: number, filters?: AeQueryFilters) {
  return queryAeVisitDimension(env, siteId, range, limit, "browser", filters);
}

export async function queryAeTopLanguages(env: Env, siteId: string, range: AeRange, limit: number, filters?: AeQueryFilters) {
  return queryAeVisitDimension(env, siteId, range, limit, "language", filters);
}

export async function queryAeTopOsVersions(env: Env, siteId: string, range: AeRange, limit: number, filters?: AeQueryFilters) {
  return queryAeVisitDimension(env, siteId, range, limit, "trim(concat(os, ' ', os_version))", filters);
}

export async function queryAeTopTimezones(env: Env, siteId: string, range: AeRange, limit: number, filters?: AeQueryFilters) {
  return queryAeVisitDimension(env, siteId, range, limit, "timezone", filters);
}

export async function queryAeTopScreenSizes(env: Env, siteId: string, range: AeRange, limit: number, filters?: AeQueryFilters) {
  return queryAeVisitDimension(env, siteId, range, limit, screenSizeExpr(), filters);
}

export async function queryAeTopRegions(env: Env, siteId: string, range: AeRange, limit: number, filters?: AeQueryFilters) {
  return queryAeVisitDimension(env, siteId, range, limit, "region", filters);
}

export async function queryAeTopCities(env: Env, siteId: string, range: AeRange, limit: number, filters?: AeQueryFilters) {
  return queryAeVisitDimension(env, siteId, range, limit, "city", filters);
}

export async function queryAeTopContinents(env: Env, siteId: string, range: AeRange, limit: number, filters?: AeQueryFilters) {
  return queryAeVisitDimension(env, siteId, range, limit, "continent", filters);
}

export async function queryAeTopOrganizations(env: Env, siteId: string, range: AeRange, limit: number, filters?: AeQueryFilters) {
  return queryAeVisitDimension(env, siteId, range, limit, "as_organization", filters);
}

export async function queryAeVisitorDetails(
  env: Env,
  siteId: string,
  range: AeRange,
  limit: number,
  filters?: AeQueryFilters,
): Promise<AeVisitorRow[]> {
  const sql = `
WITH
${visitCtes(siteId, range)},
filtered_visits AS (
  SELECT *
  FROM visits
  ${buildVisitFilterClause(filters)}
)
SELECT
  visitor_id,
  min(started_at) AS first_seen_at,
  max(started_at) AS last_seen_at,
  count() AS views,
  count(DISTINCT session_id) AS sessions
FROM filtered_visits
WHERE visitor_id != ''
GROUP BY visitor_id
ORDER BY last_seen_at DESC
LIMIT ${clampLimit(limit, 100)}
`;

  return (await runAeSql<Record<string, unknown>>(env, sql)).map((row) => ({
    visitor_id: parseString(row.visitor_id),
    first_seen_at: parseNumber(row.first_seen_at),
    last_seen_at: parseNumber(row.last_seen_at),
    views: parseNumber(row.views),
    sessions: parseNumber(row.sessions),
  }));
}

export async function queryAeCustomEventNames(
  env: Env,
  siteId: string,
  range: AeRange,
  limit: number,
  filters?: AeQueryFilters,
): Promise<AeDimensionRow[]> {
  const clauses = [
    `index1 = ${sqlString(siteId)}`,
    `double6 >= ${LAYOUT_VERSION}`,
    `blob1 = 'custom_event'`,
    `double1 BETWEEN ${Math.floor(range.fromMs)} AND ${Math.floor(range.toMs)}`,
  ];
  if (filters?.country) clauses.push(`blob11 = ${sqlString(filters.country.trim())}`);
  if (filters?.browser) clauses.push(`blob14 = ${sqlString(filters.browser.trim())}`);
  if (filters?.device) clauses.push(`blob17 = ${sqlString(filters.device.trim())}`);
  const sql = `
SELECT
  blob20 AS key,
  count() AS views,
  count(DISTINCT blob4) AS sessions
FROM ${DATASET}
WHERE ${clauses.join("\n  AND ")}
GROUP BY key
ORDER BY views DESC
LIMIT ${clampLimit(limit, 30)}
`;

  return (await runAeSql<Record<string, unknown>>(env, sql)).map((row) => ({
    key: parseString(row.key),
    views: parseNumber(row.views),
    sessions: parseNumber(row.sessions),
  }));
}
