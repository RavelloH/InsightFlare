import type { Env } from "./types";

const NINETY_DAYS_MS = 90 * 24 * 60 * 60 * 1000;
const GEO_REGION_VALUE_SEPARATOR = "::";

export interface AeRange {
  fromMs: number;
  toMs: number;
}

export interface AeQueryFilters {
  country?: string;
  device?: string;
  browser?: string;
  eventType?: string;
}

export interface AeOverviewRow {
  views: number;
  sessions: number;
  visitors: number;
  bounces: number;
  total_duration: number;
}

export interface AeTrendRow {
  bucket: number;
  views: number;
  visitors: number;
  sessions: number;
  bounces: number;
  total_duration: number;
}

export interface AeOverviewBySiteRow {
  site_id: string;
  views: number;
  sessions: number;
  visitors: number;
  bounces: number;
  total_duration: number;
}

export interface AeSiteTrendRow {
  site_id: string;
  bucket: number;
  views: number;
  visitors: number;
}

export interface AeTopPageRow {
  pathname: string;
  query_string?: string;
  hash_fragment?: string;
  views: number;
  sessions: number;
}

export interface AeReferrerRow {
  ref: string;
  views: number;
  sessions: number;
}

export interface AeDimensionRow {
  key: string;
  views: number;
  sessions: number;
}

export interface AeRecentEventRow {
  event_type: string;
  event_at: number;
  pathname: string;
  query_string: string;
  hash_fragment: string;
  hostname: string;
  referer: string;
  referer_host: string;
  visitor_id: string;
  session_id: string;
  duration_ms: number;
  country: string;
  region: string;
  city: string;
  browser: string;
  os: string;
  device_type: string;
  language: string;
  timezone: string;
}

export interface AeSessionRow {
  session_id: string;
  visitor_id: string;
  started_at: number;
  ended_at: number;
  views: number;
  total_duration: number;
  countries: number;
  entry_path: string;
  exit_path: string;
}

export interface AeVisitorRow {
  visitor_id: string;
  first_seen_at: number;
  last_seen_at: number;
  views: number;
  sessions: number;
  countries: number;
  latest_path: string;
}

const MAX_SQL_LIMIT = 2000;

function toInt(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.floor(n);
}

function clampLimit(limit: number, fallback = 100): number {
  const n = toInt(limit);
  if (n <= 0) return fallback;
  return Math.min(MAX_SQL_LIMIT, n);
}

function sqlString(value: string): string {
  return `'${String(value).replace(/'/g, "''")}'`;
}

function parseNumber(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const n = Number(value);
    if (Number.isFinite(n)) return n;
  }
  return 0;
}

function parseString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function parseRegionCodeAndName(regionValue: string): {
  stateCode: string;
  stateName: string;
} {
  const normalized = regionValue.trim();
  if (!normalized) {
    return {
      stateCode: "",
      stateName: "",
    };
  }

  const separatorIndex = normalized.indexOf(GEO_REGION_VALUE_SEPARATOR);
  if (separatorIndex < 0) {
    return {
      stateCode: normalized,
      stateName: normalized,
    };
  }

  const stateCode = normalized.slice(0, separatorIndex).trim();
  const stateName = normalized
    .slice(separatorIndex + GEO_REGION_VALUE_SEPARATOR.length)
    .trim();

  return {
    stateCode: stateCode || stateName,
    stateName: stateName || stateCode,
  };
}

function getAeDatasetName(): string {
  const dataset = "insightflare_events";
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(dataset)) {
    throw new Error("Invalid built-in analytics dataset name");
  }
  return dataset;
}

function getAeAccountId(env: Env): string {
  return String(env.ANALYTICS_ACCOUNT_ID || "").trim();
}

function getAeApiToken(env: Env): string {
  return String(env.ANALYTICS_SQL_API_TOKEN || "").trim();
}

function ensureAeConfig(env: Env): {
  accountId: string;
  apiToken: string;
  dataset: string;
} {
  const accountId = getAeAccountId(env);
  const apiToken = getAeApiToken(env);
  const dataset = getAeDatasetName();
  if (!accountId || !apiToken) {
    throw new Error("Analytics Engine SQL config missing (ANALYTICS_ACCOUNT_ID / ANALYTICS_SQL_API_TOKEN)");
  }
  return { accountId, apiToken, dataset };
}

function hasNewBlobLayoutExpr(): string {
  return "blob14 != ''";
}

function layoutVersionExpr(): string {
  return "double3";
}

function hasLayoutV2Expr(): string {
  return `${layoutVersionExpr()} >= 2`;
}

function eventAtExpr(): string {
  return "double1";
}

function durationExpr(): string {
  return "double2";
}

function eventTypeExpr(): string {
  return "if(blob14 != '', blob14, blob6)";
}

function sessionExpr(): string {
  return `if(${hasNewBlobLayoutExpr()}, blob6, '')`;
}

function visitorExpr(): string {
  return `if(${hasNewBlobLayoutExpr()}, blob7, '')`;
}

function pathnameExpr(): string {
  return "blob1";
}

function queryExpr(): string {
  return `if(${hasNewBlobLayoutExpr()}, blob2, '')`;
}

function hashExpr(): string {
  return `if(${hasNewBlobLayoutExpr()}, blob3, '')`;
}

function hostnameExpr(): string {
  return `if(${hasNewBlobLayoutExpr()}, blob4, '')`;
}

function refererExpr(): string {
  return `if(${hasNewBlobLayoutExpr()}, blob5, '')`;
}

function refererHostExpr(): string {
  return `if(${hasNewBlobLayoutExpr()}, blob20, blob9)`;
}

function browserExpr(): string {
  return `if(${hasNewBlobLayoutExpr()}, blob8, blob2)`;
}

function osExpr(): string {
  return `if(${hasNewBlobLayoutExpr()}, blob10, blob3)`;
}

function osVersionExpr(): string {
  return `if(${hasNewBlobLayoutExpr()}, blob11, '')`;
}

function osWithVersionExpr(): string {
  return `
  CASE
    WHEN ${osExpr()} = '' AND ${osVersionExpr()} = '' THEN ''
    WHEN ${osVersionExpr()} = '' THEN ${osExpr()}
    ELSE trim(concat(${osExpr()}, ' ', ${osVersionExpr()}))
  END
`;
}

function languageExpr(): string {
  return `if(${hasNewBlobLayoutExpr()}, blob12, blob4)`;
}

function continentExpr(): string {
  return `if(${hasLayoutV2Expr()}, blob13, '')`;
}

function countryExpr(): string {
  return `if(${hasNewBlobLayoutExpr()}, blob15, blob7)`;
}

function regionExpr(): string {
  return `if(${hasNewBlobLayoutExpr()}, blob16, '')`;
}

function cityExpr(): string {
  return `if(${hasNewBlobLayoutExpr()}, blob17, '')`;
}

function timezoneExpr(): string {
  return `if(${hasNewBlobLayoutExpr()}, blob18, '')`;
}

function deviceExpr(): string {
  return `if(${hasNewBlobLayoutExpr()}, blob19, blob8)`;
}

function organizationExpr(): string {
  return `if(${hasLayoutV2Expr()}, blob9, '')`;
}

function screenSizeExpr(): string {
  return "if(double4 > 0 AND double5 > 0, concat(toString(toInt32(double4)), 'x', toString(toInt32(double5))), '')";
}

function nonEmptyDistinctCountExpr(expr: string): string {
  const sentinel = "__if_empty_sentinel__";
  return `(
    count(DISTINCT if(${expr} != '', ${expr}, '${sentinel}'))
    - if(max(if(${expr} = '', 1, 0)) = 1, 1, 0)
  )`;
}

function normalizeFilterValue(value: string | undefined): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim().slice(0, 120);
  if (!normalized) return null;
  return normalized;
}

function buildAeWhere(siteId: string, range: AeRange, filters?: AeQueryFilters): string {
  const fromMs = toInt(range.fromMs);
  const toMs = toInt(range.toMs);
  const clauses = [`index1 = ${sqlString(siteId)}`, `${eventAtExpr()} BETWEEN ${fromMs} AND ${toMs}`];

  const country = normalizeFilterValue(filters?.country);
  if (country) {
    clauses.push(`${countryExpr()} = ${sqlString(country)}`);
  }

  const device = normalizeFilterValue(filters?.device);
  if (device) {
    clauses.push(`${deviceExpr()} = ${sqlString(device)}`);
  }

  const browser = normalizeFilterValue(filters?.browser);
  if (browser) {
    clauses.push(`${browserExpr()} = ${sqlString(browser)}`);
  }

  const eventType = normalizeFilterValue(filters?.eventType);
  if (eventType) {
    clauses.push(`${eventTypeExpr()} = ${sqlString(eventType)}`);
  }

  return clauses.join(" AND ");
}

function buildAeWhereForSites(siteIds: string[], range: AeRange, filters?: AeQueryFilters): string {
  const fromMs = toInt(range.fromMs);
  const toMs = toInt(range.toMs);
  const normalizedSiteIds = Array.from(
    new Set(
      siteIds
        .map((siteId) => String(siteId || "").trim())
        .filter((siteId) => siteId.length > 0),
    ),
  );
  if (normalizedSiteIds.length === 0) {
    return "1 = 0";
  }

  const siteListSql = normalizedSiteIds.map((siteId) => sqlString(siteId)).join(", ");
  const clauses = [`index1 IN (${siteListSql})`, `${eventAtExpr()} BETWEEN ${fromMs} AND ${toMs}`];

  const country = normalizeFilterValue(filters?.country);
  if (country) {
    clauses.push(`${countryExpr()} = ${sqlString(country)}`);
  }

  const device = normalizeFilterValue(filters?.device);
  if (device) {
    clauses.push(`${deviceExpr()} = ${sqlString(device)}`);
  }

  const browser = normalizeFilterValue(filters?.browser);
  if (browser) {
    clauses.push(`${browserExpr()} = ${sqlString(browser)}`);
  }

  const eventType = normalizeFilterValue(filters?.eventType);
  if (eventType) {
    clauses.push(`${eventTypeExpr()} = ${sqlString(eventType)}`);
  }

  return clauses.join(" AND ");
}

function ninetyDaysFloorMs(nowMs: number): number {
  return toInt(nowMs - NINETY_DAYS_MS);
}

export function splitAeRange(
  fromMs: number,
  toMs: number,
  nowMs: number,
): AeRange | null {
  const floorMs = ninetyDaysFloorMs(nowMs);
  const from = Math.max(toInt(fromMs), floorMs);
  const to = toInt(toMs);
  if (to < from) return null;
  return { fromMs: from, toMs: to };
}

async function runAeSql<T extends Record<string, unknown>>(env: Env, sql: string): Promise<T[]> {
  const { accountId, apiToken } = ensureAeConfig(env);
  const endpoint = `https://api.cloudflare.com/client/v4/accounts/${accountId}/analytics_engine/sql`;

  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      authorization: `Bearer ${apiToken}`,
      "content-type": "text/plain",
    },
    body: sql,
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Analytics Engine SQL failed (${response.status}): ${text.slice(0, 512)}`);
  }

  const payload = (await response.json()) as unknown;
  if (!payload || typeof payload !== "object") {
    return [];
  }

  const record = payload as Record<string, unknown>;
  if (record.success === false) {
    const errors = Array.isArray(record.errors) ? JSON.stringify(record.errors).slice(0, 512) : "unknown";
    throw new Error(`Analytics Engine SQL returned error: ${errors}`);
  }
  if (Array.isArray(record.data)) {
    return record.data as T[];
  }

  const result = record.result;
  if (result && typeof result === "object") {
    const resultRecord = result as Record<string, unknown>;
    if (Array.isArray(resultRecord.data)) {
      return resultRecord.data as T[];
    }
    if (Array.isArray(resultRecord.results)) {
      return resultRecord.results as T[];
    }
  }

  if (Array.isArray(record.results)) {
    return record.results as T[];
  }

  return [];
}

export async function queryAeOverview(
  env: Env,
  siteId: string,
  range: AeRange,
  filters?: AeQueryFilters,
): Promise<AeOverviewRow> {
  const dataset = getAeDatasetName();
  const where = buildAeWhere(siteId, range, filters);
  const sql = `
SELECT
  sum(_sample_interval) AS views,
  ${nonEmptyDistinctCountExpr(sessionExpr())} AS sessions,
  ${nonEmptyDistinctCountExpr(visitorExpr())} AS visitors,
  sum(if(${durationExpr()} <= 0, _sample_interval, 0)) AS bounces,
  sum(_sample_interval * ${durationExpr()}) AS total_duration
FROM ${dataset}
WHERE ${where}
`;
  const rows = await runAeSql<Record<string, unknown>>(env, sql);
  const row = rows[0] || {};
  return {
    views: parseNumber(row.views),
    sessions: parseNumber(row.sessions),
    visitors: parseNumber(row.visitors),
    bounces: parseNumber(row.bounces),
    total_duration: parseNumber(row.total_duration),
  };
}

export async function queryAeTrend(
  env: Env,
  siteId: string,
  range: AeRange,
  interval: "minute" | "hour" | "day" | "week" | "month",
  filters?: AeQueryFilters,
): Promise<AeTrendRow[]> {
  const dataset = getAeDatasetName();
  const where = buildAeWhere(siteId, range, filters);
  const bucketDivisor =
    interval === "minute"
      ? 60000
      : interval === "hour"
        ? 3600000
        : interval === "day"
          ? 86400000
          : interval === "week"
            ? 604800000
            : 2592000000;
  const sql = `
SELECT
  floor(${eventAtExpr()} / ${bucketDivisor}) AS bucket,
  sum(_sample_interval) AS views,
  ${nonEmptyDistinctCountExpr(visitorExpr())} AS visitors,
  ${nonEmptyDistinctCountExpr(sessionExpr())} AS sessions,
  sum(if(${durationExpr()} <= 0, _sample_interval, 0)) AS bounces,
  sum(_sample_interval * ${durationExpr()}) AS total_duration
FROM ${dataset}
WHERE ${where}
GROUP BY bucket
ORDER BY bucket
`;
  const rows = await runAeSql<Record<string, unknown>>(env, sql);
  return rows.map((row) => ({
    bucket: parseNumber(row.bucket),
    views: parseNumber(row.views),
    visitors: parseNumber(row.visitors),
    sessions: parseNumber(row.sessions),
    bounces: parseNumber(row.bounces),
    total_duration: parseNumber(row.total_duration),
  }));
}

export async function queryAeOverviewBySites(
  env: Env,
  siteIds: string[],
  range: AeRange,
  filters?: AeQueryFilters,
): Promise<AeOverviewBySiteRow[]> {
  if (siteIds.length === 0) return [];
  const dataset = getAeDatasetName();
  const where = buildAeWhereForSites(siteIds, range, filters);
  const sql = `
SELECT
  index1 AS site_id,
  sum(_sample_interval) AS views,
  ${nonEmptyDistinctCountExpr(sessionExpr())} AS sessions,
  ${nonEmptyDistinctCountExpr(visitorExpr())} AS visitors,
  sum(if(${durationExpr()} <= 0, _sample_interval, 0)) AS bounces,
  sum(_sample_interval * ${durationExpr()}) AS total_duration
FROM ${dataset}
WHERE ${where}
GROUP BY site_id
`;
  const rows = await runAeSql<Record<string, unknown>>(env, sql);
  return rows.map((row) => ({
    site_id: parseString(row.site_id),
    views: parseNumber(row.views),
    sessions: parseNumber(row.sessions),
    visitors: parseNumber(row.visitors),
    bounces: parseNumber(row.bounces),
    total_duration: parseNumber(row.total_duration),
  }));
}

export async function queryAeTrendBySites(
  env: Env,
  siteIds: string[],
  range: AeRange,
  interval: "minute" | "hour" | "day" | "week" | "month",
  filters?: AeQueryFilters,
): Promise<AeSiteTrendRow[]> {
  if (siteIds.length === 0) return [];
  const dataset = getAeDatasetName();
  const where = buildAeWhereForSites(siteIds, range, filters);
  const bucketDivisor =
    interval === "minute"
      ? 60000
      : interval === "hour"
        ? 3600000
        : interval === "day"
          ? 86400000
          : interval === "week"
            ? 604800000
            : 2592000000;
  const sql = `
SELECT
  index1 AS site_id,
  floor(${eventAtExpr()} / ${bucketDivisor}) AS bucket,
  sum(_sample_interval) AS views,
  ${nonEmptyDistinctCountExpr(visitorExpr())} AS visitors
FROM ${dataset}
WHERE ${where}
GROUP BY site_id, bucket
ORDER BY bucket, site_id
`;
  const rows = await runAeSql<Record<string, unknown>>(env, sql);
  return rows.map((row) => ({
    site_id: parseString(row.site_id),
    bucket: parseNumber(row.bucket),
    views: parseNumber(row.views),
    visitors: parseNumber(row.visitors),
  }));
}

export async function queryAeTopPages(
  env: Env,
  siteId: string,
  range: AeRange,
  limit: number,
  includeQueryHashDetails: boolean,
  filters?: AeQueryFilters,
): Promise<AeTopPageRow[]> {
  const dataset = getAeDatasetName();
  const where = buildAeWhere(siteId, range, filters);
  const n = clampLimit(limit, 30);

  const sql = includeQueryHashDetails
    ? `
SELECT
  ${pathnameExpr()} AS pathname,
  ${queryExpr()} AS query_string,
  ${hashExpr()} AS hash_fragment,
  sum(_sample_interval) AS views,
  ${nonEmptyDistinctCountExpr(sessionExpr())} AS sessions
FROM ${dataset}
WHERE ${where}
GROUP BY pathname, query_string, hash_fragment
ORDER BY views DESC
LIMIT ${n}
`
    : `
SELECT
  ${pathnameExpr()} AS pathname,
  sum(_sample_interval) AS views,
  ${nonEmptyDistinctCountExpr(sessionExpr())} AS sessions
FROM ${dataset}
WHERE ${where}
GROUP BY pathname
ORDER BY views DESC
LIMIT ${n}
`;

  const rows = await runAeSql<Record<string, unknown>>(env, sql);
  return rows.map((row) => ({
    pathname: parseString(row.pathname),
    query_string: parseString(row.query_string),
    hash_fragment: parseString(row.hash_fragment),
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
  const dataset = getAeDatasetName();
  const where = buildAeWhere(siteId, range, filters);
  const n = clampLimit(limit, 30);
  const refExpr = includeFullUrl ? refererExpr() : refererHostExpr();
  const sql = `
SELECT
  ${refExpr} AS ref,
  sum(_sample_interval) AS views,
  ${nonEmptyDistinctCountExpr(sessionExpr())} AS sessions
FROM ${dataset}
WHERE ${where}
GROUP BY ref
ORDER BY views DESC
LIMIT ${n}
`;
  const rows = await runAeSql<Record<string, unknown>>(env, sql);
  return rows.map((row) => ({
    ref: parseString(row.ref),
    views: parseNumber(row.views),
    sessions: parseNumber(row.sessions),
  }));
}

async function queryAeTopDimension(
  env: Env,
  siteId: string,
  range: AeRange,
  limit: number,
  dimensionExpr: string,
  filters?: AeQueryFilters,
): Promise<AeDimensionRow[]> {
  const dataset = getAeDatasetName();
  const where = buildAeWhere(siteId, range, filters);
  const n = clampLimit(limit, 30);
  const sql = `
SELECT
  ${dimensionExpr} AS k,
  sum(_sample_interval) AS views,
  ${nonEmptyDistinctCountExpr(sessionExpr())} AS sessions
FROM ${dataset}
WHERE ${where}
GROUP BY k
ORDER BY views DESC
LIMIT ${n}
`;
  const rows = await runAeSql<Record<string, unknown>>(env, sql);
  return rows.map((row) => ({
    key: parseString(row.k),
    views: parseNumber(row.views),
    sessions: parseNumber(row.sessions),
  }));
}

export async function queryAeTopCountries(
  env: Env,
  siteId: string,
  range: AeRange,
  limit: number,
  filters?: AeQueryFilters,
): Promise<AeDimensionRow[]> {
  return queryAeTopDimension(env, siteId, range, limit, countryExpr(), filters);
}

export async function queryAeTopDevices(
  env: Env,
  siteId: string,
  range: AeRange,
  limit: number,
  filters?: AeQueryFilters,
): Promise<AeDimensionRow[]> {
  return queryAeTopDimension(env, siteId, range, limit, deviceExpr(), filters);
}

export async function queryAeTopBrowsers(
  env: Env,
  siteId: string,
  range: AeRange,
  limit: number,
  filters?: AeQueryFilters,
): Promise<AeDimensionRow[]> {
  return queryAeTopDimension(env, siteId, range, limit, browserExpr(), filters);
}

export async function queryAeTopLanguages(
  env: Env,
  siteId: string,
  range: AeRange,
  limit: number,
  filters?: AeQueryFilters,
): Promise<AeDimensionRow[]> {
  return queryAeTopDimension(env, siteId, range, limit, languageExpr(), filters);
}

export async function queryAeTopOsVersions(
  env: Env,
  siteId: string,
  range: AeRange,
  limit: number,
  filters?: AeQueryFilters,
): Promise<AeDimensionRow[]> {
  return queryAeTopDimension(env, siteId, range, limit, osWithVersionExpr(), filters);
}

export async function queryAeTopScreenSizes(
  env: Env,
  siteId: string,
  range: AeRange,
  limit: number,
  filters?: AeQueryFilters,
): Promise<AeDimensionRow[]> {
  return queryAeTopDimension(env, siteId, range, limit, screenSizeExpr(), filters);
}

export async function queryAeTopRegions(
  env: Env,
  siteId: string,
  range: AeRange,
  limit: number,
  filters?: AeQueryFilters,
): Promise<AeDimensionRow[]> {
  return queryAeTopDimension(env, siteId, range, limit, regionExpr(), filters);
}

export async function queryAeTopCountryRegions(
  env: Env,
  siteId: string,
  range: AeRange,
  limit: number,
  filters?: AeQueryFilters,
): Promise<AeDimensionRow[]> {
  const dataset = getAeDatasetName();
  const where = buildAeWhere(siteId, range, filters);
  const n = clampLimit(limit, 30);
  const sql = `
SELECT
  ${countryExpr()} AS country,
  ${regionExpr()} AS region,
  sum(_sample_interval) AS views,
  ${nonEmptyDistinctCountExpr(sessionExpr())} AS sessions
FROM ${dataset}
WHERE ${where}
GROUP BY country, region
ORDER BY views DESC
LIMIT ${n}
`;

  const rows = await runAeSql<Record<string, unknown>>(env, sql);
  return rows.map((row) => {
    const country = parseString(row.country).trim();
    const region = parseString(row.region).trim();
    const { stateCode, stateName } = parseRegionCodeAndName(region);

    return {
      key: stateName
        ? `${country}${GEO_REGION_VALUE_SEPARATOR}${stateCode}${GEO_REGION_VALUE_SEPARATOR}${stateName}`
        : "",
      views: parseNumber(row.views),
      sessions: parseNumber(row.sessions),
    };
  });
}

export async function queryAeTopCountryRegionCities(
  env: Env,
  siteId: string,
  range: AeRange,
  limit: number,
  filters?: AeQueryFilters,
): Promise<AeDimensionRow[]> {
  const dataset = getAeDatasetName();
  const where = buildAeWhere(siteId, range, filters);
  const n = clampLimit(limit, 30);
  const sql = `
SELECT
  ${countryExpr()} AS country,
  ${regionExpr()} AS region,
  ${cityExpr()} AS city,
  sum(_sample_interval) AS views,
  ${nonEmptyDistinctCountExpr(sessionExpr())} AS sessions
FROM ${dataset}
WHERE ${where}
GROUP BY country, region, city
ORDER BY views DESC
LIMIT ${n}
`;

  const rows = await runAeSql<Record<string, unknown>>(env, sql);
  return rows.map((row) => {
    const country = parseString(row.country).trim();
    const region = parseString(row.region).trim();
    const city = parseString(row.city).trim();
    const { stateCode, stateName } = parseRegionCodeAndName(region);

    return {
      key: city
        ? `${country}${GEO_REGION_VALUE_SEPARATOR}${stateCode}${GEO_REGION_VALUE_SEPARATOR}${stateName}${GEO_REGION_VALUE_SEPARATOR}${city}`
        : "",
      views: parseNumber(row.views),
      sessions: parseNumber(row.sessions),
    };
  });
}

export async function queryAeTopCities(
  env: Env,
  siteId: string,
  range: AeRange,
  limit: number,
  filters?: AeQueryFilters,
): Promise<AeDimensionRow[]> {
  return queryAeTopDimension(env, siteId, range, limit, cityExpr(), filters);
}

export async function queryAeTopTimezones(
  env: Env,
  siteId: string,
  range: AeRange,
  limit: number,
  filters?: AeQueryFilters,
): Promise<AeDimensionRow[]> {
  return queryAeTopDimension(env, siteId, range, limit, timezoneExpr(), filters);
}

export async function queryAeTopContinents(
  env: Env,
  siteId: string,
  range: AeRange,
  limit: number,
  filters?: AeQueryFilters,
): Promise<AeDimensionRow[]> {
  return queryAeTopDimension(env, siteId, range, limit, continentExpr(), filters);
}

export async function queryAeTopOrganizations(
  env: Env,
  siteId: string,
  range: AeRange,
  limit: number,
  filters?: AeQueryFilters,
): Promise<AeDimensionRow[]> {
  return queryAeTopDimension(env, siteId, range, limit, organizationExpr(), filters);
}

export async function queryAeTopEventTypes(
  env: Env,
  siteId: string,
  range: AeRange,
  limit: number,
  filters?: AeQueryFilters,
): Promise<AeDimensionRow[]> {
  return queryAeTopDimension(env, siteId, range, limit, eventTypeExpr(), filters);
}

export async function queryAeRecentEvents(
  env: Env,
  siteId: string,
  range: AeRange,
  limit: number,
  filters?: AeQueryFilters,
): Promise<AeRecentEventRow[]> {
  const dataset = getAeDatasetName();
  const where = buildAeWhere(siteId, range, filters);
  const n = clampLimit(limit, 100);
  const sql = `
SELECT
  ${eventTypeExpr()} AS event_type,
  ${eventAtExpr()} AS event_at,
  ${pathnameExpr()} AS pathname,
  ${queryExpr()} AS query_string,
  ${hashExpr()} AS hash_fragment,
  ${hostnameExpr()} AS hostname,
  ${refererExpr()} AS referer,
  ${refererHostExpr()} AS referer_host,
  ${visitorExpr()} AS visitor_id,
  ${sessionExpr()} AS session_id,
  ${durationExpr()} AS duration_ms,
  ${countryExpr()} AS country,
  ${regionExpr()} AS region,
  ${cityExpr()} AS city,
  ${browserExpr()} AS browser,
  ${osExpr()} AS os,
  ${deviceExpr()} AS device_type,
  ${languageExpr()} AS language,
  ${timezoneExpr()} AS timezone
FROM ${dataset}
WHERE ${where}
ORDER BY event_at DESC
LIMIT ${n}
`;
  const rows = await runAeSql<Record<string, unknown>>(env, sql);
  return rows.map((row) => {
    // `blob16` now stores `stateCode::stateName`; keep API payload as plain state name.
    // Legacy rows that only stored a state name are also handled.
    const region = parseString(row.region);
    const { stateName } = parseRegionCodeAndName(region);

    return {
      event_type: parseString(row.event_type),
      event_at: parseNumber(row.event_at),
      pathname: parseString(row.pathname),
      query_string: parseString(row.query_string),
      hash_fragment: parseString(row.hash_fragment),
      hostname: parseString(row.hostname),
      referer: parseString(row.referer),
      referer_host: parseString(row.referer_host),
      visitor_id: parseString(row.visitor_id),
      session_id: parseString(row.session_id),
      duration_ms: parseNumber(row.duration_ms),
      country: parseString(row.country),
      region: stateName,
      city: parseString(row.city),
      browser: parseString(row.browser),
      os: parseString(row.os),
      device_type: parseString(row.device_type),
      language: parseString(row.language),
      timezone: parseString(row.timezone),
    };
  });
}

export async function queryAeSessionDetails(
  env: Env,
  siteId: string,
  range: AeRange,
  limit: number,
  filters?: AeQueryFilters,
): Promise<AeSessionRow[]> {
  const dataset = getAeDatasetName();
  const where = buildAeWhere(siteId, range, filters);
  const n = clampLimit(limit, 200);
  const sql = `
SELECT
  session_id,
  argMax(visitor_id, event_at) AS visitor_id,
  min(event_at) AS started_at,
  max(event_at) AS ended_at,
  sum(sample_interval) AS views,
  sum(sample_interval * duration_ms) AS total_duration,
  ${nonEmptyDistinctCountExpr("country")} AS countries,
  argMin(pathname, event_at) AS entry_path,
  argMax(pathname, event_at) AS exit_path
FROM (
  SELECT
    ${sessionExpr()} AS session_id,
    ${visitorExpr()} AS visitor_id,
    ${eventAtExpr()} AS event_at,
    ${pathnameExpr()} AS pathname,
    ${countryExpr()} AS country,
    ${durationExpr()} AS duration_ms,
    _sample_interval AS sample_interval
  FROM ${dataset}
  WHERE ${where}
)
WHERE session_id != ''
GROUP BY session_id
ORDER BY started_at DESC
LIMIT ${n}
`;
  const rows = await runAeSql<Record<string, unknown>>(env, sql);
  return rows.map((row) => ({
    session_id: parseString(row.session_id),
    visitor_id: parseString(row.visitor_id),
    started_at: parseNumber(row.started_at),
    ended_at: parseNumber(row.ended_at),
    views: parseNumber(row.views),
    total_duration: parseNumber(row.total_duration),
    countries: parseNumber(row.countries),
    entry_path: parseString(row.entry_path),
    exit_path: parseString(row.exit_path),
  }));
}

export async function queryAeVisitorDetails(
  env: Env,
  siteId: string,
  range: AeRange,
  limit: number,
  filters?: AeQueryFilters,
): Promise<AeVisitorRow[]> {
  const dataset = getAeDatasetName();
  const where = buildAeWhere(siteId, range, filters);
  const n = clampLimit(limit, 200);
  const sql = `
SELECT
  visitor_id,
  min(event_at) AS first_seen_at,
  max(event_at) AS last_seen_at,
  sum(sample_interval) AS views,
  ${nonEmptyDistinctCountExpr("session_id")} AS sessions,
  ${nonEmptyDistinctCountExpr("country")} AS countries,
  argMax(pathname, event_at) AS latest_path
FROM (
  SELECT
    ${visitorExpr()} AS visitor_id,
    ${sessionExpr()} AS session_id,
    ${eventAtExpr()} AS event_at,
    ${pathnameExpr()} AS pathname,
    ${countryExpr()} AS country,
    _sample_interval AS sample_interval
  FROM ${dataset}
  WHERE ${where}
)
WHERE visitor_id != ''
GROUP BY visitor_id
ORDER BY last_seen_at DESC
LIMIT ${n}
`;
  const rows = await runAeSql<Record<string, unknown>>(env, sql);
  return rows.map((row) => ({
    visitor_id: parseString(row.visitor_id),
    first_seen_at: parseNumber(row.first_seen_at),
    last_seen_at: parseNumber(row.last_seen_at),
    views: parseNumber(row.views),
    sessions: parseNumber(row.sessions),
    countries: parseNumber(row.countries),
    latest_path: parseString(row.latest_path),
  }));
}
