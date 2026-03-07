import type { Env } from "./types";
import {
  AE_LAYOUT_VERSION,
  AE_ROW_TYPE_CUSTOM_EVENT,
  AE_ROW_TYPE_VISIT_FINALIZE,
  AE_ROW_TYPE_VISIT_START,
  decodeAeContinent,
  decodeAeDeviceType,
  encodeAeDeviceType,
} from "./analytics-engine-layout";

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

function parseIntKey(value: unknown): number {
  return Math.trunc(parseNumber(value));
}

export function isAnalyticsSqlConfigured(env: Env): boolean {
  return Boolean(String(env.ANALYTICS_ACCOUNT_ID || "").trim() && String(env.ANALYTICS_SQL_API_TOKEN || "").trim());
}

export function isRangeWithinAnalyticsWindow(fromMs: number, nowMs: number): boolean {
  return fromMs >= nowMs - ANALYTICS_WINDOW_MS;
}

function buildVisitFilterClause(filters?: AeQueryFilters, alias = ""): string {
  const prefix = alias ? `${alias}.` : "";
  const clauses: string[] = [];
  if (filters?.country) {
    clauses.push(`${prefix}blob10 = ${sqlString(filters.country.trim())}`);
  }
  if (filters?.device) {
    clauses.push(`${prefix}double9 = ${encodeAeDeviceType(filters.device)}`);
  }
  if (filters?.browser) {
    clauses.push(`${prefix}blob13 = ${sqlString(filters.browser.trim())}`);
  }
  return clauses.length > 0 ? clauses.join("\n  AND ") : "";
}

function buildStartWhere(siteId: string, range: AeRange, alias = ""): string {
  const prefix = alias ? `${alias}.` : "";
  return [
    `${prefix}index1 = ${sqlString(siteId)}`,
    `${prefix}double3 = ${AE_LAYOUT_VERSION}`,
    `${prefix}double8 = ${AE_ROW_TYPE_VISIT_START}`,
    `${prefix}double11 BETWEEN ${Math.floor(range.fromMs)} AND ${Math.floor(range.toMs)}`,
  ].join("\n  AND ");
}

function buildFinalizeWhere(siteId: string, range: AeRange, alias = ""): string {
  const prefix = alias ? `${alias}.` : "";
  return [
    `${prefix}index1 = ${sqlString(siteId)}`,
    `${prefix}double3 = ${AE_LAYOUT_VERSION}`,
    `${prefix}double8 = ${AE_ROW_TYPE_VISIT_FINALIZE}`,
    `${prefix}double11 BETWEEN ${Math.floor(range.fromMs)} AND ${Math.floor(range.toMs)}`,
  ].join("\n  AND ");
}

function buildCustomEventWhere(siteId: string, range: AeRange, alias = ""): string {
  const prefix = alias ? `${alias}.` : "";
  return [
    `${prefix}index1 = ${sqlString(siteId)}`,
    `${prefix}double3 = ${AE_LAYOUT_VERSION}`,
    `${prefix}double8 = ${AE_ROW_TYPE_CUSTOM_EVENT}`,
    `${prefix}double1 BETWEEN ${Math.floor(range.fromMs)} AND ${Math.floor(range.toMs)}`,
  ].join("\n  AND ");
}

function appendWhere(base: string, extra: string): string {
  return extra ? `${base}\n  AND ${extra}` : base;
}

function sampleIntervalExpr(alias = ""): string {
  const prefix = alias ? `${alias}.` : "";
  return `if(${prefix}_sample_interval IS NOT NULL AND ${prefix}_sample_interval > 0, ${prefix}_sample_interval, 1)`;
}

function weightedCountExpr(alias = "", predicate?: string): string {
  const weight = sampleIntervalExpr(alias);
  return predicate ? `sum(if(${predicate}, ${weight}, 0))` : `sum(${weight})`;
}

function weightedSumExpr(valueExpr: string, alias = "", predicate?: string): string {
  const weight = sampleIntervalExpr(alias);
  return predicate ? `sum(if(${predicate}, (${valueExpr}) * ${weight}, 0.0))` : `sum((${valueExpr}) * ${weight})`;
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
  const startWhere = appendWhere(buildStartWhere(siteId, range), buildVisitFilterClause(filters));
  const finalizeWhere = appendWhere(buildFinalizeWhere(siteId, range), buildVisitFilterClause(filters));
  const [summary, durationRow, bounceRow] = await Promise.all([
    runAeSql<Record<string, unknown>>(
      env,
      `
SELECT
  ${weightedCountExpr()} AS views,
  count(DISTINCT blob3) AS sessions,
  count(DISTINCT blob2) AS visitors
FROM ${DATASET}
WHERE ${startWhere}
`,
    ).then((rows) => rows[0] ?? {}),
    runAeSql<Record<string, unknown>>(
      env,
      `
SELECT
  ${weightedSumExpr("double2", "", "double2 IS NOT NULL AND double2 >= 0")} AS total_duration,
  ${weightedCountExpr("", "double2 IS NOT NULL AND double2 >= 0")} AS duration_views
FROM ${DATASET}
WHERE ${finalizeWhere}
`,
    ).then((rows) => rows[0] ?? {}),
    runAeSql<Record<string, unknown>>(
      env,
      `
SELECT
  count() AS bounces
FROM (
  SELECT blob3
  FROM ${DATASET}
  WHERE ${startWhere}
    AND blob3 != ''
  GROUP BY blob3
  HAVING count() = 1
)
`,
    ).then((rows) => rows[0] ?? {}),
  ]);
  return {
    views: parseNumber(summary.views),
    sessions: parseNumber(summary.sessions),
    visitors: parseNumber(summary.visitors),
    bounces: parseNumber(bounceRow.bounces),
    total_duration: parseNumber(durationRow.total_duration),
    duration_views: parseNumber(durationRow.duration_views),
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

  const startWhere = appendWhere(buildStartWhere(siteId, range), buildVisitFilterClause(filters));
  const finalizeWhere = appendWhere(buildFinalizeWhere(siteId, range), buildVisitFilterClause(filters));
  const [startRows, durationRows, sessionRows] = await Promise.all([
    runAeSql<Record<string, unknown>>(
      env,
      `
SELECT
  floor(double11 / ${bucketDivisor}) AS bucket,
  ${weightedCountExpr()} AS views,
  count(DISTINCT blob2) AS visitors
FROM ${DATASET}
WHERE ${startWhere}
GROUP BY bucket
ORDER BY bucket
`,
    ),
    runAeSql<Record<string, unknown>>(
      env,
      `
SELECT
  floor(double11 / ${bucketDivisor}) AS bucket,
  ${weightedSumExpr("double2", "", "double2 IS NOT NULL AND double2 >= 0")} AS total_duration,
  ${weightedCountExpr("", "double2 IS NOT NULL AND double2 >= 0")} AS duration_views
FROM ${DATASET}
WHERE ${finalizeWhere}
GROUP BY bucket
ORDER BY bucket
`,
    ),
    runAeSql<Record<string, unknown>>(
      env,
      `
SELECT
  floor(session_started_at / ${bucketDivisor}) AS bucket,
  count() AS sessions,
  sum(if(visit_count = 1, 1, 0)) AS bounces
FROM (
  SELECT
    blob3 AS session_id,
    min(double11) AS session_started_at,
    count() AS visit_count
  FROM ${DATASET}
  WHERE ${startWhere}
    AND blob3 != ''
  GROUP BY blob3
)
GROUP BY bucket
ORDER BY bucket
`,
    )]);

  const buckets = new Map<number, AeTrendRow>();
  for (const row of startRows) {
    const bucket = parseNumber(row.bucket);
    buckets.set(bucket, {
      bucket,
      views: parseNumber(row.views),
      visitors: parseNumber(row.visitors),
      sessions: 0,
      bounces: 0,
      total_duration: 0,
      duration_views: 0,
    });
  }
  for (const row of durationRows) {
    const bucket = parseNumber(row.bucket);
    const existing = buckets.get(bucket) ?? {
      bucket,
      views: 0,
      visitors: 0,
      sessions: 0,
      bounces: 0,
      total_duration: 0,
      duration_views: 0,
    };
    existing.total_duration = parseNumber(row.total_duration);
    existing.duration_views = parseNumber(row.duration_views);
    buckets.set(bucket, existing);
  }
  for (const row of sessionRows) {
    const bucket = parseNumber(row.bucket);
    const existing = buckets.get(bucket) ?? {
      bucket,
      views: 0,
      visitors: 0,
      sessions: 0,
      bounces: 0,
      total_duration: 0,
      duration_views: 0,
    };
    existing.sessions = parseNumber(row.sessions);
    existing.bounces = parseNumber(row.bounces);
    buckets.set(bucket, existing);
  }
  return [...buckets.values()].sort((a, b) => a.bucket - b.bucket);
}

async function queryAeVisitDimension(
  env: Env,
  siteId: string,
  range: AeRange,
  limit: number,
  selectExpr: string,
  filters?: AeQueryFilters,
): Promise<AeDimensionRow[]> {
  const where = appendWhere(buildStartWhere(siteId, range), buildVisitFilterClause(filters));
  const sql = `
SELECT
  ${selectExpr} AS key,
  ${weightedCountExpr()} AS views,
  count(DISTINCT blob3) AS sessions
FROM ${DATASET}
WHERE ${where}
GROUP BY key
ORDER BY views DESC
LIMIT ${clampLimit(limit, 30)}
`;

  return (await runAeSql<Record<string, unknown>>(env, sql)).map((row) => ({
    key: typeof row.key === "number" && Number.isFinite(row.key) ? String(row.key) : parseString(row.key),
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
  const where = appendWhere(buildStartWhere(siteId, range), buildVisitFilterClause(filters));
  const sql = `
SELECT
  blob4 AS pathname,
  ${includeDetails ? "blob5 AS query_string," : "'' AS query_string,"}
  ${includeDetails ? "blob6 AS hash_fragment," : "'' AS hash_fragment,"}
  argMax(blob20, double11) AS title,
  argMax(blob7, double11) AS hostname,
  ${weightedCountExpr()} AS views,
  count(DISTINCT blob3) AS sessions
FROM ${DATASET}
WHERE ${where}
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
  return queryAeVisitDimension(env, siteId, range, limit, "blob4", filters);
}

export async function queryAeTopTitles(
  env: Env,
  siteId: string,
  range: AeRange,
  limit: number,
  filters?: AeQueryFilters,
): Promise<AeDimensionRow[]> {
  return queryAeVisitDimension(env, siteId, range, limit, "blob20", filters);
}

export async function queryAeTopHostnames(
  env: Env,
  siteId: string,
  range: AeRange,
  limit: number,
  filters?: AeQueryFilters,
): Promise<AeDimensionRow[]> {
  return queryAeVisitDimension(env, siteId, range, limit, "blob7", filters);
}

export async function queryAeEntryPages(
  env: Env,
  siteId: string,
  range: AeRange,
  limit: number,
  filters?: AeQueryFilters,
): Promise<AeDimensionRow[]> {
  const where = appendWhere(buildStartWhere(siteId, range), buildVisitFilterClause(filters));
  const sql = `
SELECT
  entry_path AS key,
  count() AS views,
  count() AS sessions
FROM (
  SELECT
    blob3 AS session_id,
    argMin(blob4, double11) AS entry_path
  FROM ${DATASET}
  WHERE ${where}
    AND blob3 != ''
  GROUP BY blob3
)
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
  const where = appendWhere(buildStartWhere(siteId, range), buildVisitFilterClause(filters));
  const sql = `
SELECT
  exit_path AS key,
  count() AS views,
  count() AS sessions
FROM (
  SELECT
    blob3 AS session_id,
    argMax(blob4, double11) AS exit_path
  FROM ${DATASET}
  WHERE ${where}
    AND blob3 != ''
  GROUP BY blob3
)
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
  const keyExpr = includeFullUrl ? "blob8" : "blob9";
  const rows = await queryAeVisitDimension(env, siteId, range, limit, keyExpr, filters);
  return rows.map((row) => ({
    ref: row.key,
    views: row.views,
    sessions: row.sessions,
  }));
}

export async function queryAeTopCountries(env: Env, siteId: string, range: AeRange, limit: number, filters?: AeQueryFilters) {
  return queryAeVisitDimension(env, siteId, range, limit, "blob10", filters);
}

async function queryAeNumericDimension(
  env: Env,
  siteId: string,
  range: AeRange,
  limit: number,
  selectExpr: string,
  decode: (code: number) => string,
  filters?: AeQueryFilters,
): Promise<AeDimensionRow[]> {
  const rows = await queryAeVisitDimension(env, siteId, range, limit, selectExpr, filters);
  return rows.map((row) => ({
    key: decode(parseIntKey(row.key)),
    views: row.views,
    sessions: row.sessions,
  })).filter((row) => row.key);
}

export async function queryAeTopDevices(env: Env, siteId: string, range: AeRange, limit: number, filters?: AeQueryFilters) {
  return queryAeNumericDimension(env, siteId, range, limit, "double9", decodeAeDeviceType, filters);
}

export async function queryAeTopBrowsers(env: Env, siteId: string, range: AeRange, limit: number, filters?: AeQueryFilters) {
  return queryAeVisitDimension(env, siteId, range, limit, "blob13", filters);
}

export async function queryAeTopLanguages(env: Env, siteId: string, range: AeRange, limit: number, filters?: AeQueryFilters) {
  return queryAeVisitDimension(env, siteId, range, limit, "blob16", filters);
}

export async function queryAeTopOsVersions(env: Env, siteId: string, range: AeRange, limit: number, filters?: AeQueryFilters) {
  const where = appendWhere(buildStartWhere(siteId, range), buildVisitFilterClause(filters));
  const sql = `
SELECT
  blob14 AS os,
  blob15 AS os_version,
  ${weightedCountExpr()} AS views,
  count(DISTINCT blob3) AS sessions
FROM ${DATASET}
WHERE ${where}
GROUP BY os, os_version
ORDER BY views DESC
LIMIT ${clampLimit(limit, 30)}
`;

  return (await runAeSql<Record<string, unknown>>(env, sql)).map((row) => {
    const os = parseString(row.os).trim();
    const osVersion = parseString(row.os_version).trim();
    const key = os && osVersion ? `${os} ${osVersion}` : (os || osVersion);
    return {
      key,
      views: parseNumber(row.views),
      sessions: parseNumber(row.sessions),
    };
  }).filter((row) => row.key);
}

export async function queryAeTopTimezones(env: Env, siteId: string, range: AeRange, limit: number, filters?: AeQueryFilters) {
  return queryAeVisitDimension(env, siteId, range, limit, "blob17", filters);
}

export async function queryAeTopScreenSizes(
  env: Env,
  siteId: string,
  range: AeRange,
  limit: number,
  filters?: AeQueryFilters,
): Promise<AeDimensionRow[]> {
  const where = appendWhere(buildStartWhere(siteId, range), buildVisitFilterClause(filters));
  const sql = `
SELECT
  double4 AS width,
  double5 AS height,
  ${weightedCountExpr()} AS views,
  count(DISTINCT blob3) AS sessions
FROM ${DATASET}
WHERE ${where}
  AND double4 > 0
  AND double5 > 0
GROUP BY width, height
ORDER BY views DESC
LIMIT ${clampLimit(limit, 30)}
`;

  return (await runAeSql<Record<string, unknown>>(env, sql)).map((row) => {
    const width = Math.trunc(parseNumber(row.width));
    const height = Math.trunc(parseNumber(row.height));
    return {
      key: width > 0 && height > 0 ? `${width}x${height}` : "",
      views: parseNumber(row.views),
      sessions: parseNumber(row.sessions),
    };
  }).filter((row) => row.key);
}

export async function queryAeTopRegions(env: Env, siteId: string, range: AeRange, limit: number, filters?: AeQueryFilters) {
  return queryAeVisitDimension(env, siteId, range, limit, "blob11", filters);
}

export async function queryAeTopCities(env: Env, siteId: string, range: AeRange, limit: number, filters?: AeQueryFilters) {
  return queryAeVisitDimension(env, siteId, range, limit, "blob12", filters);
}

export async function queryAeTopContinents(env: Env, siteId: string, range: AeRange, limit: number, filters?: AeQueryFilters) {
  return queryAeNumericDimension(env, siteId, range, limit, "double10", decodeAeContinent, filters);
}

export async function queryAeTopOrganizations(env: Env, siteId: string, range: AeRange, limit: number, filters?: AeQueryFilters) {
  return queryAeVisitDimension(env, siteId, range, limit, "blob18", filters);
}

export async function queryAeVisitorDetails(
  env: Env,
  siteId: string,
  range: AeRange,
  limit: number,
  filters?: AeQueryFilters,
): Promise<AeVisitorRow[]> {
  const where = appendWhere(buildStartWhere(siteId, range), buildVisitFilterClause(filters));
  const sql = `
SELECT
  blob2 AS visitor_id,
  min(double11) AS first_seen_at,
  max(double11) AS last_seen_at,
  ${weightedCountExpr()} AS views,
  count(DISTINCT blob3) AS sessions
FROM ${DATASET}
WHERE ${where}
  AND blob2 != ''
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
  const clauses = [buildCustomEventWhere(siteId, range)];
  if (filters?.country) clauses.push(`blob10 = ${sqlString(filters.country.trim())}`);
  if (filters?.browser) clauses.push(`blob13 = ${sqlString(filters.browser.trim())}`);
  if (filters?.device) clauses.push(`double9 = ${encodeAeDeviceType(filters.device)}`);
  const sql = `
SELECT
  blob20 AS key,
  ${weightedCountExpr()} AS views,
  count(DISTINCT blob3) AS sessions
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
