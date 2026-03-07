import type { Env } from "./types";
import { ONE_DAY_MS, ONE_HOUR_MS, coerceNumber } from "./utils";
import { requireSession } from "./session-auth";
import { isAnalyticsEngineEnabled } from "./flags";
import {
  AE_LAYOUT_VERSION,
  AE_ROW_TYPE_CUSTOM_EVENT,
  AE_ROW_TYPE_VISIT_FINALIZE,
  AE_ROW_TYPE_VISIT_START,
  encodeAeDeviceType,
} from "./analytics-engine-layout";
import {
  type AeDimensionRow,
  type AeOverviewRow,
  type AeTopPageRow,
  type AeQueryFilters,
  type AeReferrerRow,
  type AeTrendRow,
  ANALYTICS_WINDOW_MS,
  isAnalyticsSqlConfigured,
  queryAeCustomEventNames,
  queryAeEntryPages,
  queryAeExitPages,
  queryAeOverview,
  queryAeReferrers,
  queryAeTopBrowsers,
  queryAeTopCities,
  queryAeTopContinents,
  queryAeTopCountries,
  queryAeTopDevices,
  queryAeTopHostnames,
  queryAeTopLanguages,
  queryAeTopOsVersions,
  queryAeTopOrganizations,
  queryAeTopPages,
  queryAeTopRegions,
  queryAeTopScreenSizes,
  queryAeTopTimezones,
  queryAeTopTitles,
  queryAeTrend,
} from "./analytics-engine-query";

const RETENTION_DAYS = 365;
const AE_DATASET = "insightflare_events";
const AE_MAX_SQL_LIMIT = 2000;
const PRIVATE_CACHE_HEADERS = {
  "cache-control": "private, no-store",
  vary: "authorization, cookie",
};
const PUBLIC_CACHE_HEADERS = {
  "cache-control": "public, max-age=60, s-maxage=60",
  "access-control-allow-origin": "*",
};
const PUBLIC_PRIVACY = {
  queryHashDetails: "hidden",
  visitorTrajectories: "hidden",
  detailedReferrerUrl: "hidden",
} as const;

type Interval = "minute" | "hour" | "day" | "week" | "month";

interface QueryWindow {
  fromMs: number;
  toMs: number;
  nowMs: number;
}

interface SiteRow {
  id: string;
  name: string;
  domain: string;
}

interface TeamSiteRow {
  id: string;
  teamId: string;
  name: string;
  domain: string;
  publicEnabled: number;
  publicSlug: string | null;
  createdAt: number;
  updatedAt: number;
}

interface DashboardFilters {
  country?: string;
  device?: string;
  browser?: string;
}

interface OverviewAggregateRow {
  views: number;
  sessions: number;
  visitors: number;
  bounces: number;
  totalDuration: number;
  durationViews: number;
}

interface TrendAggregateRow extends OverviewAggregateRow {
  bucket: number;
}

interface DimensionRow {
  value: string;
  views: number;
  sessions: number;
}

interface PageRow {
  pathname: string;
  query: string;
  hash: string;
  views: number;
  sessions: number;
}

interface ReferrerRow {
  referrer: string;
  views: number;
  sessions: number;
}

interface VisitorRow {
  visitorId: string;
  firstSeenAt: number;
  lastSeenAt: number;
  views: number;
  sessions: number;
}

interface PageTabs {
  path: Array<{ label: string; views: number; sessions: number }>;
  title: Array<{ label: string; views: number; sessions: number }>;
  hostname: Array<{ label: string; views: number; sessions: number }>;
  entry: Array<{ label: string; views: number; sessions: number }>;
  exit: Array<{ label: string; views: number; sessions: number }>;
}

interface ClientDimensionTabs {
  browser: Array<{ label: string; views: number; sessions: number }>;
  osVersion: Array<{ label: string; views: number; sessions: number }>;
  deviceType: Array<{ label: string; views: number; sessions: number }>;
  language: Array<{ label: string; views: number; sessions: number }>;
  screenSize: Array<{ label: string; views: number; sessions: number }>;
}

interface GeoDimensionTabs {
  country: Array<{ label: string; views: number; sessions: number }>;
  region: Array<{ label: string; views: number; sessions: number }>;
  city: Array<{ label: string; views: number; sessions: number }>;
  continent: Array<{ label: string; views: number; sessions: number }>;
  timezone: Array<{ label: string; views: number; sessions: number }>;
  organization: Array<{ label: string; views: number; sessions: number }>;
}

interface PublicSiteEnvelope {
  slug: string;
  name: string;
  domain: string;
}

interface PreferredSourceResult<T> {
  value: T;
  source: "ae" | "d1";
}

interface SiteQueryResponseOptions {
  publicSite?: PublicSiteEnvelope;
}

const jsonResponse = (payload: unknown, status = 200, extraHeaders?: Record<string, string>) =>
  new Response(JSON.stringify(payload), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      ...(extraHeaders ?? {}),
    },
  });

const badRequest = (message: string, extraHeaders?: Record<string, string>) =>
  jsonResponse({ ok: false, error: message }, 400, extraHeaders);
const unauthorized = (message = "Unauthorized", extraHeaders?: Record<string, string>) =>
  jsonResponse({ ok: false, error: message }, 401, extraHeaders);
const notFound = (message = "Not Found", extraHeaders?: Record<string, string>) =>
  jsonResponse({ ok: false, error: message }, 404, extraHeaders);
const notAllowed = (extraHeaders?: Record<string, string>) =>
  jsonResponse({ ok: false, error: "Method Not Allowed" }, 405, extraHeaders);

function parseWindow(url: URL): QueryWindow | null {
  const nowMs = Date.now();
  const defaultFrom = nowMs - ONE_DAY_MS;
  const fromMs = Math.floor(coerceNumber(url.searchParams.get("from"), defaultFrom) ?? defaultFrom);
  const toMs = Math.floor(coerceNumber(url.searchParams.get("to"), nowMs) ?? nowMs);
  if (!Number.isFinite(fromMs) || !Number.isFinite(toMs) || fromMs < 0 || toMs < fromMs) {
    return null;
  }
  return { fromMs, toMs, nowMs };
}

function parseLimit(url: URL, fallback = 20, max = 500): number {
  const value = Math.floor(coerceNumber(url.searchParams.get("limit"), fallback) ?? fallback);
  if (!Number.isFinite(value) || value <= 0) return fallback;
  return Math.min(max, value);
}

function parseInterval(url: URL): Interval {
  const raw = (url.searchParams.get("interval") || "day").toLowerCase();
  if (raw === "minute" || raw === "hour" || raw === "week" || raw === "month") return raw;
  return "day";
}

function parseBooleanSearchParam(url: URL, key: string): boolean {
  const value = (url.searchParams.get(key) || "").trim().toLowerCase();
  return value === "1" || value === "true" || value === "yes";
}

function normalizeFilterValue(value: string | null): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim().slice(0, 120);
  return normalized.length > 0 ? normalized : undefined;
}

function parseFilters(url: URL): DashboardFilters {
  return {
    country: normalizeFilterValue(url.searchParams.get("country")),
    device: normalizeFilterValue(url.searchParams.get("device")),
    browser: normalizeFilterValue(url.searchParams.get("browser")),
  };
}

function toAeFilters(filters: DashboardFilters): AeQueryFilters {
  return {
    country: filters.country,
    device: filters.device,
    browser: filters.browser,
  };
}

function shouldUseAnalyticsEngine(env: Env, fromMs: number, nowMs: number): boolean {
  return isAnalyticsEngineEnabled(env)
    && isAnalyticsSqlConfigured(env)
    && fromMs >= nowMs - ANALYTICS_WINDOW_MS;
}

function sourceLabel(window: QueryWindow): "detail" | "archive" | "mixed" {
  const archiveCutoff = window.nowMs - RETENTION_DAYS * ONE_DAY_MS;
  if (window.toMs < archiveCutoff) return "archive";
  if (window.fromMs < archiveCutoff) return "mixed";
  return "detail";
}

function avgDuration(totalDuration: number, durationViews: number): number {
  if (durationViews <= 0) return 0;
  return Math.round(totalDuration / durationViews);
}

function bounceRate(bounces: number, sessions: number): number {
  if (sessions <= 0) return 0;
  return Number((bounces / sessions).toFixed(6));
}

function percentChange(current: number, previous: number): number | null {
  if (!Number.isFinite(current) || !Number.isFinite(previous) || previous <= 0) return null;
  return ((current - previous) / previous) * 100;
}

function intervalBucketMs(interval: Interval): number {
  if (interval === "minute") return 60_000;
  if (interval === "hour") return ONE_HOUR_MS;
  if (interval === "day") return ONE_DAY_MS;
  if (interval === "week") return 7 * ONE_DAY_MS;
  return 30 * ONE_DAY_MS;
}

function normalizePathname(pathname: string): string {
  const normalized = String(pathname || "").trim();
  return normalized.length > 0 ? normalized : "/";
}

function formatPageLabel(pathname: string, query = "", hash = "", includeDetails = false): string {
  const base = normalizePathname(pathname);
  if (!includeDetails) return base;
  return `${base}${query || ""}${hash || ""}`;
}

function osVersionExpr(): string {
  return "trim(CASE WHEN os != '' AND os_version != '' THEN os || ' ' || os_version WHEN os != '' THEN os WHEN os_version != '' THEN os_version ELSE '' END)";
}

function screenSizeExpr(): string {
  return "CASE WHEN screen_width > 0 AND screen_height > 0 THEN CAST(screen_width AS TEXT) || 'x' || CAST(screen_height AS TEXT) ELSE '' END";
}

function siteQueryHeaders(options: SiteQueryResponseOptions): Record<string, string> {
  return options.publicSite ? PUBLIC_CACHE_HEADERS : PRIVATE_CACHE_HEADERS;
}

function siteQueryResponse(siteId: string, payload: Record<string, unknown>, options: SiteQueryResponseOptions = {}): Response {
  const body = options.publicSite
    ? { ...payload, site: options.publicSite, privacy: PUBLIC_PRIVACY }
    : { ...payload, siteId };
  return jsonResponse(body, 200, siteQueryHeaders(options));
}

function parseBooleanFlag(url: URL, key: string): boolean {
  return parseBooleanSearchParam(url, key);
}

async function loadWithPreferredSource<T>(
  env: Env,
  window: QueryWindow,
  label: string,
  aeLoader: () => Promise<T>,
  d1Loader: () => Promise<T>,
): Promise<PreferredSourceResult<T>> {
  if (shouldUseAnalyticsEngine(env, window.fromMs, window.nowMs)) {
    try {
      return { value: await aeLoader(), source: "ae" };
    } catch (error) {
      console.error(`analytics_query_failed:${label}`, error);
      throw error;
    }
  }
  return { value: await d1Loader(), source: "d1" };
}

function mapOverviewAggregate(
  row: OverviewAggregateRow,
  options?: { approximateVisitors?: boolean },
) {
  return {
    views: row.views,
    sessions: row.sessions,
    visitors: row.visitors,
    bounces: row.bounces,
    totalDurationMs: row.totalDuration,
    avgDurationMs: avgDuration(row.totalDuration, row.durationViews),
    bounceRate: bounceRate(row.bounces, row.sessions),
    approximateVisitors: Boolean(options?.approximateVisitors),
  };
}

function mapTrendRows(
  rows: TrendAggregateRow[],
  interval: Interval,
  source: "detail" | "archive" | "mixed",
) {
  const bucketMs = intervalBucketMs(interval);
  return rows.map((row) => ({
    bucket: row.bucket,
    timestampMs: row.bucket * bucketMs,
    views: row.views,
    visitors: row.visitors,
    sessions: row.sessions,
    bounces: row.bounces,
    totalDurationMs: row.totalDuration,
    avgDurationMs: avgDuration(row.totalDuration, row.durationViews),
    source,
  }));
}

function mapPages(rows: PageRow[]) {
  return rows.map((row) => ({
    pathname: row.pathname,
    query: row.query,
    hash: row.hash,
    views: row.views,
    sessions: row.sessions,
  }));
}

function mapTabs(rows: DimensionRow[]) {
  return rows.map((row) => ({
    label: row.value,
    views: row.views,
    sessions: row.sessions,
  }));
}

function mapReferrers(rows: ReferrerRow[]) {
  return rows.map((row) => ({
    referrer: row.referrer,
    views: row.views,
    sessions: row.sessions,
  }));
}

function mapVisitors(rows: VisitorRow[]) {
  return rows.map((row) => ({
    visitorId: row.visitorId,
    firstSeenAt: row.firstSeenAt,
    lastSeenAt: row.lastSeenAt,
    views: row.views,
    sessions: row.sessions,
  }));
}

function mapAeOverview(row: AeOverviewRow): OverviewAggregateRow {
  return {
    views: row.views,
    sessions: row.sessions,
    visitors: row.visitors,
    bounces: row.bounces,
    totalDuration: row.total_duration,
    durationViews: row.duration_views,
  };
}

function mapAeTrend(rows: AeTrendRow[]): TrendAggregateRow[] {
  return rows.map((row) => ({
    bucket: row.bucket,
    views: row.views,
    visitors: row.visitors,
    sessions: row.sessions,
    bounces: row.bounces,
    totalDuration: row.total_duration,
    durationViews: row.duration_views,
  }));
}

function mapAePages(rows: AeTopPageRow[]): PageRow[] {
  return rows.map((row) => ({
    pathname: row.pathname,
    query: row.query_string,
    hash: row.hash_fragment,
    views: row.views,
    sessions: row.sessions,
  }));
}

function mapAeDimensions(rows: AeDimensionRow[]): DimensionRow[] {
  return rows.map((row) => ({
    value: row.key,
    views: row.views,
    sessions: row.sessions,
  }));
}

async function settleDimensionRows(
  label: string,
  loader: () => Promise<DimensionRow[]>,
): Promise<DimensionRow[]> {
  try {
    return await loader();
  } catch (error) {
    console.error(`dimension_query_failed:${label}`, error);
    return [];
  }
}

function mapAeReferrers(rows: AeReferrerRow[]): ReferrerRow[] {
  return rows.map((row) => ({
    referrer: row.ref,
    views: row.views,
    sessions: row.sessions,
  }));
}

async function resolvePrivateSite(
  request: Request,
  env: Env,
  url: URL,
): Promise<SiteRow | Response> {
  const session = await requireSession(request, env);
  if (!session) return unauthorized("Unauthorized", PRIVATE_CACHE_HEADERS);

  const siteId = normalizeFilterValue(url.searchParams.get("siteId"));
  if (!siteId) return badRequest("siteId is required", PRIVATE_CACHE_HEADERS);

  if (session.systemRole === "admin") {
    const site = await env.DB.prepare(
      "SELECT id,name,domain FROM sites WHERE id=? LIMIT 1",
    )
      .bind(siteId)
      .first<SiteRow>();
    return site ?? notFound("Site not found", PRIVATE_CACHE_HEADERS);
  }

  const site = await env.DB.prepare(
    `
      SELECT s.id, s.name, s.domain
      FROM sites s
      INNER JOIN teams t ON t.id = s.team_id
      LEFT JOIN team_members tm ON tm.team_id = s.team_id AND tm.user_id = ?
      WHERE s.id = ? AND (t.owner_user_id = ? OR tm.user_id IS NOT NULL)
      LIMIT 1
    `,
  )
    .bind(session.userId, siteId, session.userId)
    .first<SiteRow>();
  return site ?? notFound("Site not found", PRIVATE_CACHE_HEADERS);
}

async function resolvePrivateTeam(
  request: Request,
  env: Env,
  url: URL,
): Promise<{ id: string } | Response> {
  const session = await requireSession(request, env);
  if (!session) return unauthorized("Unauthorized", PRIVATE_CACHE_HEADERS);

  const teamId = normalizeFilterValue(url.searchParams.get("teamId"));
  if (!teamId) return badRequest("teamId is required", PRIVATE_CACHE_HEADERS);

  if (session.systemRole === "admin") {
    const team = await env.DB.prepare("SELECT id FROM teams WHERE id=? LIMIT 1")
      .bind(teamId)
      .first<{ id: string }>();
    return team ?? notFound("Team not found", PRIVATE_CACHE_HEADERS);
  }

  const team = await env.DB.prepare(
    `
      SELECT t.id
      FROM teams t
      LEFT JOIN team_members tm ON tm.team_id = t.id AND tm.user_id = ?
      WHERE t.id = ? AND (t.owner_user_id = ? OR tm.user_id IS NOT NULL)
      LIMIT 1
    `,
  )
    .bind(session.userId, teamId, session.userId)
    .first<{ id: string }>();
  return team ?? notFound("Team not found", PRIVATE_CACHE_HEADERS);
}

async function fetchPublicSite(env: Env, url: URL): Promise<SiteRow | Response> {
  const segments = url.pathname.split("/").filter(Boolean);
  const slug = decodeURIComponent(segments[2] || "").trim();
  if (!slug) return notFound("Public site not found", PUBLIC_CACHE_HEADERS);

  const site = await env.DB.prepare(
    "SELECT id,name,domain FROM sites WHERE public_enabled=1 AND public_slug=? LIMIT 1",
  )
    .bind(slug)
    .first<SiteRow>();
  return site ?? notFound("Public site not found", PUBLIC_CACHE_HEADERS);
}

function regionValueExpr(): string {
  return "CASE WHEN TRIM(country) = '' AND TRIM(region_code) = '' AND TRIM(region) = '' THEN '' ELSE TRIM(country) || '::' || CASE WHEN TRIM(region_code) != '' THEN TRIM(region_code) ELSE TRIM(region) END || '::' || TRIM(region) END";
}

function cityValueExpr(): string {
  return "CASE WHEN TRIM(country) = '' AND TRIM(region_code) = '' AND TRIM(region) = '' AND TRIM(city) = '' THEN '' ELSE TRIM(country) || '::' || CASE WHEN TRIM(region_code) != '' THEN TRIM(region_code) ELSE TRIM(region) END || '::' || TRIM(region) || '::' || TRIM(city) END";
}

const VISIT_SOURCE_COLUMNS = `
  visit_id, site_id, visitor_id, session_id, status, started_at, last_activity_at,
  ended_at, finalized_at, duration_ms, duration_source, exit_reason,
  pathname, query_string, hash_fragment, hostname, title, referrer_url, referrer_host,
  utm_source, utm_medium, utm_campaign, utm_term, utm_content,
  is_eu, country, region, region_code, city, continent, latitude, longitude,
  postal_code, metro_code, timezone, as_organization, ua_raw, browser, browser_version,
  os, os_version, device_type, screen_width, screen_height, language, ae_synced_at
`;

const CUSTOM_EVENT_SOURCE_COLUMNS = `
  event_id, site_id, visit_id, visitor_id, session_id, occurred_at, event_name, event_data_json,
  pathname, query_string, hash_fragment, hostname, title, referrer_url, referrer_host,
  country, region, city, browser, os, os_version, device_type, language, timezone,
  screen_width, screen_height, ae_synced_at
`;

function buildVisitSourceCte(): string {
  return `
visit_source AS (
  SELECT ${VISIT_SOURCE_COLUMNS}
  FROM visits
  WHERE site_id = ? AND started_at BETWEEN ? AND ?
  UNION ALL
  SELECT ${VISIT_SOURCE_COLUMNS}
  FROM visits_archive
  WHERE site_id = ? AND started_at BETWEEN ? AND ?
)`;
}

function buildCustomEventSourceCte(): string {
  return `
event_source AS (
  SELECT ${CUSTOM_EVENT_SOURCE_COLUMNS}
  FROM custom_events
  WHERE site_id = ? AND occurred_at BETWEEN ? AND ?
  UNION ALL
  SELECT ${CUSTOM_EVENT_SOURCE_COLUMNS}
  FROM custom_events_archive
  WHERE site_id = ? AND occurred_at BETWEEN ? AND ?
)`;
}

function visitSourceBindings(siteId: string, window: QueryWindow): Array<string | number> {
  return [siteId, window.fromMs, window.toMs, siteId, window.fromMs, window.toMs];
}

function eventSourceBindings(siteId: string, window: QueryWindow): Array<string | number> {
  return [siteId, window.fromMs, window.toMs, siteId, window.fromMs, window.toMs];
}

function buildVisitFilterSql(filters: DashboardFilters, alias = ""): { clause: string; bindings: string[] } {
  const prefix = alias ? `${alias}.` : "";
  const clauses: string[] = [];
  const bindings: string[] = [];
  if (filters.country) {
    clauses.push(`${prefix}country = ?`);
    bindings.push(filters.country);
  }
  if (filters.device) {
    clauses.push(`${prefix}device_type = ?`);
    bindings.push(filters.device);
  }
  if (filters.browser) {
    clauses.push(`${prefix}browser = ?`);
    bindings.push(filters.browser);
  }
  return clauses.length > 0 ? { clause: `WHERE ${clauses.join(" AND ")}`, bindings } : { clause: "", bindings: [] };
}

function buildEventFilterSql(filters: DashboardFilters, alias = ""): { clause: string; bindings: string[] } {
  const prefix = alias ? `${alias}.` : "";
  const clauses: string[] = [];
  const bindings: string[] = [];
  if (filters.country) {
    clauses.push(`${prefix}country = ?`);
    bindings.push(filters.country);
  }
  if (filters.device) {
    clauses.push(`${prefix}device_type = ?`);
    bindings.push(filters.device);
  }
  if (filters.browser) {
    clauses.push(`${prefix}browser = ?`);
    bindings.push(filters.browser);
  }
  return clauses.length > 0 ? { clause: `WHERE ${clauses.join(" AND ")}`, bindings } : { clause: "", bindings: [] };
}

async function queryD1All<T extends Record<string, unknown>>(
  env: Env,
  sql: string,
  bindings: Array<string | number | null>,
): Promise<T[]> {
  const result = await env.DB.prepare(sql).bind(...bindings).all<T>();
  return result.results;
}

async function queryOverviewFromD1(
  env: Env,
  siteId: string,
  window: QueryWindow,
  filters: DashboardFilters,
): Promise<OverviewAggregateRow> {
  const filter = buildVisitFilterSql(filters);
  const sql = `
WITH
${buildVisitSourceCte()},
filtered_visits AS (
  SELECT *
  FROM visit_source
  ${filter.clause}
),
session_rollup AS (
  SELECT session_id, count(*) AS visit_count
  FROM filtered_visits
  WHERE session_id != ''
  GROUP BY session_id
)
SELECT
  count(*) AS views,
  count(DISTINCT CASE WHEN session_id != '' THEN session_id ELSE NULL END) AS sessions,
  count(DISTINCT CASE WHEN visitor_id != '' THEN visitor_id ELSE NULL END) AS visitors,
  COALESCE((SELECT count(*) FROM session_rollup WHERE visit_count = 1), 0) AS bounces,
  COALESCE(sum(CASE WHEN duration_ms IS NOT NULL AND duration_ms >= 0 THEN duration_ms ELSE 0 END), 0) AS totalDuration,
  COALESCE(sum(CASE WHEN duration_ms IS NOT NULL AND duration_ms >= 0 THEN 1 ELSE 0 END), 0) AS durationViews
FROM filtered_visits
`;
  const row = (await queryD1All<Record<string, unknown>>(
    env,
    sql,
    [...visitSourceBindings(siteId, window), ...filter.bindings],
  ))[0] ?? {};
  return {
    views: Number(row.views ?? 0),
    sessions: Number(row.sessions ?? 0),
    visitors: Number(row.visitors ?? 0),
    bounces: Number(row.bounces ?? 0),
    totalDuration: Number(row.totalDuration ?? 0),
    durationViews: Number(row.durationViews ?? 0),
  };
}

async function queryTrendFromD1(
  env: Env,
  siteId: string,
  window: QueryWindow,
  interval: Interval,
  filters: DashboardFilters,
): Promise<TrendAggregateRow[]> {
  const filter = buildVisitFilterSql(filters);
  const bucketDivisor = intervalBucketMs(interval);
  const sql = `
WITH
${buildVisitSourceCte()},
filtered_visits AS (
  SELECT *
  FROM visit_source
  ${filter.clause}
),
visit_bucket_rollup AS (
  SELECT
    CAST(started_at / ${bucketDivisor} AS INTEGER) AS bucket,
    count(*) AS views,
    count(DISTINCT CASE WHEN visitor_id != '' THEN visitor_id ELSE NULL END) AS visitors,
    COALESCE(sum(CASE WHEN duration_ms IS NOT NULL AND duration_ms >= 0 THEN duration_ms ELSE 0 END), 0) AS totalDuration,
    COALESCE(sum(CASE WHEN duration_ms IS NOT NULL AND duration_ms >= 0 THEN 1 ELSE 0 END), 0) AS durationViews
  FROM filtered_visits
  GROUP BY bucket
),
session_rollup AS (
  SELECT
    session_id,
    MIN(started_at) AS session_started_at,
    count(*) AS visit_count
  FROM filtered_visits
  WHERE session_id != ''
  GROUP BY session_id
),
session_bucket_rollup AS (
  SELECT
    CAST(session_started_at / ${bucketDivisor} AS INTEGER) AS bucket,
    count(*) AS sessions,
    COALESCE(sum(CASE WHEN visit_count = 1 THEN 1 ELSE 0 END), 0) AS bounces
  FROM session_rollup
  GROUP BY bucket
),
combined AS (
  SELECT bucket, views, visitors, 0 AS sessions, 0 AS bounces, totalDuration, durationViews FROM visit_bucket_rollup
  UNION ALL
  SELECT bucket, 0 AS views, 0 AS visitors, sessions, bounces, 0 AS totalDuration, 0 AS durationViews FROM session_bucket_rollup
)
SELECT
  bucket,
  sum(views) AS views,
  sum(visitors) AS visitors,
  sum(sessions) AS sessions,
  sum(bounces) AS bounces,
  sum(totalDuration) AS totalDuration,
  sum(durationViews) AS durationViews
FROM combined
GROUP BY bucket
ORDER BY bucket ASC
`;
  return (await queryD1All<Record<string, unknown>>(
    env,
    sql,
    [...visitSourceBindings(siteId, window), ...filter.bindings],
  )).map((row) => ({
    bucket: Number(row.bucket ?? 0),
    views: Number(row.views ?? 0),
    visitors: Number(row.visitors ?? 0),
    sessions: Number(row.sessions ?? 0),
    bounces: Number(row.bounces ?? 0),
    totalDuration: Number(row.totalDuration ?? 0),
    durationViews: Number(row.durationViews ?? 0),
  }));
}

async function queryTopPagesFromD1(
  env: Env,
  siteId: string,
  window: QueryWindow,
  limit: number,
  includeDetails: boolean,
  filters: DashboardFilters,
): Promise<PageRow[]> {
  const filter = buildVisitFilterSql(filters);
  const queryExpr = includeDetails ? "query_string" : "''";
  const hashExpr = includeDetails ? "hash_fragment" : "''";
  const sql = `
WITH
${buildVisitSourceCte()},
filtered_visits AS (
  SELECT *
  FROM visit_source
  ${filter.clause}
)
SELECT
  pathname,
  ${queryExpr} AS queryValue,
  ${hashExpr} AS hashValue,
  count(*) AS views,
  count(DISTINCT CASE WHEN session_id != '' THEN session_id ELSE NULL END) AS sessions
FROM filtered_visits
GROUP BY pathname, queryValue, hashValue
ORDER BY views DESC, pathname ASC
LIMIT ?
`;
  return (await queryD1All<Record<string, unknown>>(
    env,
    sql,
    [...visitSourceBindings(siteId, window), ...filter.bindings, limit],
  )).map((row) => ({
    pathname: String(row.pathname ?? ""),
    query: String(row.queryValue ?? ""),
    hash: String(row.hashValue ?? ""),
    views: Number(row.views ?? 0),
    sessions: Number(row.sessions ?? 0),
  }));
}

async function queryPagesFromD1(
  env: Env,
  siteId: string,
  window: QueryWindow,
  filters: DashboardFilters,
  limit: number,
  includeDetails: boolean,
): Promise<PageRow[]> {
  return queryTopPagesFromD1(env, siteId, window, limit, includeDetails, filters);
}
async function queryOverviewAggregate(
  env: Env,
  siteId: string,
  window: QueryWindow,
  filters: DashboardFilters,
): Promise<PreferredSourceResult<OverviewAggregateRow>> {
  return loadWithPreferredSource(
    env,
    window,
    "overview",
    async () =>
      mapAeOverview(await queryAeOverview(env, siteId, window, toAeFilters(filters))),
    () => queryOverviewFromD1(env, siteId, window, filters),
  );
}

async function queryTrendAggregate(
  env: Env,
  siteId: string,
  window: QueryWindow,
  interval: Interval,
  filters: DashboardFilters,
): Promise<PreferredSourceResult<TrendAggregateRow[]>> {
  return loadWithPreferredSource(
    env,
    window,
    "trend",
    async () =>
      mapAeTrend(await queryAeTrend(env, siteId, window, interval, toAeFilters(filters))),
    () => queryTrendFromD1(env, siteId, window, interval, filters),
  );
}

async function queryPagesAggregate(
  env: Env,
  siteId: string,
  window: QueryWindow,
  filters: DashboardFilters,
  limit: number,
  includeDetails: boolean,
): Promise<PageRow[]> {
  const preferred = await loadWithPreferredSource(
    env,
    window,
    "pages",
    async () =>
      mapAePages(
        await queryAeTopPages(
          env,
          siteId,
          window,
          limit,
          includeDetails,
          toAeFilters(filters),
        ),
      ),
    () => queryPagesFromD1(env, siteId, window, filters, limit, includeDetails),
  );
  return preferred.value;
}

async function queryPageTabsAggregate(
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
  const preferred = await loadWithPreferredSource(
    env,
    window,
    "page_tabs",
    async () => {
      const aeFilters = toAeFilters(filters);
      const [path, title, hostname, entry, exit] = await Promise.all([
        queryAeTopPages(env, siteId, window, limit, false, aeFilters).then((rows) =>
          mapAePages(rows).map((row) => ({
            value: row.pathname,
            views: row.views,
            sessions: row.sessions,
          })),
        ),
        queryAeTopTitles(env, siteId, window, limit, aeFilters).then(mapAeDimensions),
        queryAeTopHostnames(env, siteId, window, limit, aeFilters).then(
          mapAeDimensions,
        ),
        queryAeEntryPages(env, siteId, window, limit, aeFilters).then(
          mapAeDimensions,
        ),
        queryAeExitPages(env, siteId, window, limit, aeFilters).then(
          mapAeDimensions,
        ),
      ]);
      return { path, title, hostname, entry, exit };
    },
    async () => {
      const [path, title, hostname, entry, exit] = await Promise.all([
        queryVisitDimensionFromD1(env, siteId, window, filters, limit, "pathname"),
        queryVisitDimensionFromD1(env, siteId, window, filters, limit, "title"),
        queryVisitDimensionFromD1(env, siteId, window, filters, limit, "hostname"),
        querySessionBoundaryDimensionFromD1(
          env,
          siteId,
          window,
          filters,
          limit,
          "entry",
        ),
        querySessionBoundaryDimensionFromD1(
          env,
          siteId,
          window,
          filters,
          limit,
          "exit",
        ),
      ]);
      return { path, title, hostname, entry, exit };
    },
  );
  return preferred.value;
}

async function queryReferrerAggregate(
  env: Env,
  siteId: string,
  window: QueryWindow,
  filters: DashboardFilters,
  limit: number,
  includeFullUrl: boolean,
): Promise<ReferrerRow[]> {
  const preferred = await loadWithPreferredSource(
    env,
    window,
    "referrers",
    async () =>
      mapAeReferrers(
        await queryAeReferrers(
          env,
          siteId,
          window,
          limit,
          includeFullUrl,
          toAeFilters(filters),
        ),
      ),
    () =>
      queryReferrersFromD1(
        env,
        siteId,
        window,
        filters,
        limit,
        includeFullUrl,
      ),
  );
  return preferred.value;
}

async function queryVisitorAggregate(
  env: Env,
  siteId: string,
  window: QueryWindow,
  filters: DashboardFilters,
  limit: number,
): Promise<VisitorRow[]> {
  return queryVisitorsFromD1(env, siteId, window, filters, limit);
}

async function queryDimensionAggregate(
  env: Env,
  siteId: string,
  window: QueryWindow,
  filters: DashboardFilters,
  limit: number,
  label: string,
  aeLoader: (filters: AeQueryFilters) => Promise<AeDimensionRow[]>,
  d1Expr: string,
): Promise<DimensionRow[]> {
  const preferred = await loadWithPreferredSource(
    env,
    window,
    label,
    async () => mapAeDimensions(await aeLoader(toAeFilters(filters))),
    () => queryVisitDimensionFromD1(env, siteId, window, filters, limit, d1Expr),
  );
  return preferred.value;
}

async function queryEventTypeAggregate(
  env: Env,
  siteId: string,
  window: QueryWindow,
  filters: DashboardFilters,
  limit: number,
): Promise<DimensionRow[]> {
  const preferred = await loadWithPreferredSource(
    env,
    window,
    "event_types",
    async () =>
      mapAeDimensions(
        await queryAeCustomEventNames(
          env,
          siteId,
          window,
          limit,
          toAeFilters(filters),
        ),
      ),
    () => queryCustomEventNamesFromD1(env, siteId, window, filters, limit),
  );
  return preferred.value;
}

async function buildOverviewClientDimensionTabs(
  env: Env,
  siteId: string,
  window: QueryWindow,
  filters: DashboardFilters,
  limit: number,
) {
  const preferred = await loadWithPreferredSource(
    env,
    window,
    "overview_client_dimensions",
    async () => {
      const aeFilters = toAeFilters(filters);
      const [browser, osVersion, deviceType, language, screenSize] =
        await Promise.all([
          settleDimensionRows("overview_client_dimensions:browser", () =>
            queryAeTopBrowsers(env, siteId, window, limit, aeFilters).then(
              mapAeDimensions,
            )),
          settleDimensionRows("overview_client_dimensions:os_version", () =>
            queryAeTopOsVersions(env, siteId, window, limit, aeFilters).then(
              mapAeDimensions,
            )),
          settleDimensionRows("overview_client_dimensions:device_type", () =>
            queryAeTopDevices(env, siteId, window, limit, aeFilters).then(
              mapAeDimensions,
            )),
          settleDimensionRows("overview_client_dimensions:language", () =>
            queryAeTopLanguages(env, siteId, window, limit, aeFilters).then(
              mapAeDimensions,
            )),
          settleDimensionRows("overview_client_dimensions:screen_size", () =>
            queryAeTopScreenSizes(env, siteId, window, limit, aeFilters).then(
              mapAeDimensions,
            )),
        ]);
      return { browser, osVersion, deviceType, language, screenSize };
    },
    async () => {
      const [browser, osVersion, deviceType, language, screenSize] =
        await Promise.all([
          queryVisitDimensionFromD1(env, siteId, window, filters, limit, "browser"),
          queryVisitDimensionFromD1(
            env,
            siteId,
            window,
            filters,
            limit,
            osVersionExpr(),
          ),
          queryVisitDimensionFromD1(
            env,
            siteId,
            window,
            filters,
            limit,
            "device_type",
          ),
          queryVisitDimensionFromD1(
            env,
            siteId,
            window,
            filters,
            limit,
            "language",
          ),
          queryVisitDimensionFromD1(
            env,
            siteId,
            window,
            filters,
            limit,
            screenSizeExpr(),
          ),
        ]);
      return { browser, osVersion, deviceType, language, screenSize };
    },
  );
  return preferred.value;
}

async function buildOverviewGeoDimensionTabs(
  env: Env,
  siteId: string,
  window: QueryWindow,
  filters: DashboardFilters,
  limit: number,
) {
  const preferred = await loadWithPreferredSource(
    env,
    window,
    "overview_geo_dimensions",
    async () => {
      const aeFilters = toAeFilters(filters);
      const [country, region, city, continent, timezone, organization] =
        await Promise.all([
          settleDimensionRows("overview_geo_dimensions:country", () =>
            queryAeTopCountries(env, siteId, window, limit, aeFilters).then(
              mapAeDimensions,
            )),
          settleDimensionRows("overview_geo_dimensions:region", () =>
            queryAeTopRegions(env, siteId, window, limit, aeFilters).then(
              mapAeDimensions,
            )),
          settleDimensionRows("overview_geo_dimensions:city", () =>
            queryAeTopCities(env, siteId, window, limit, aeFilters).then(
              mapAeDimensions,
            )),
          settleDimensionRows("overview_geo_dimensions:continent", () =>
            queryAeTopContinents(env, siteId, window, limit, aeFilters).then(
              mapAeDimensions,
            )),
          settleDimensionRows("overview_geo_dimensions:timezone", () =>
            queryAeTopTimezones(env, siteId, window, limit, aeFilters).then(
              mapAeDimensions,
            )),
          settleDimensionRows("overview_geo_dimensions:organization", () =>
            queryAeTopOrganizations(env, siteId, window, limit, aeFilters).then(
              mapAeDimensions,
            )),
        ]);
      return { country, region, city, continent, timezone, organization };
    },
    async () => {
      const [country, region, city, continent, timezone, organization] =
        await Promise.all([
          queryVisitDimensionFromD1(env, siteId, window, filters, limit, "country"),
          queryVisitDimensionFromD1(
            env,
            siteId,
            window,
            filters,
            limit,
            regionValueExpr(),
          ),
          queryVisitDimensionFromD1(
            env,
            siteId,
            window,
            filters,
            limit,
            cityValueExpr(),
          ),
          queryVisitDimensionFromD1(
            env,
            siteId,
            window,
            filters,
            limit,
            "continent",
          ),
          queryVisitDimensionFromD1(
            env,
            siteId,
            window,
            filters,
            limit,
            "timezone",
          ),
          queryVisitDimensionFromD1(
            env,
            siteId,
            window,
            filters,
            limit,
            "as_organization",
          ),
        ]);
      return { country, region, city, continent, timezone, organization };
    },
  );
  return preferred.value;
}
async function handleOverview(
  env: Env,
  siteId: string,
  url: URL,
): Promise<Response> {
  const window = parseWindow(url);
  if (!window) return badRequest("Invalid time window");
  const filters = parseFilters(url);
  const includeChange = parseBooleanFlag(url, "includeChange");
  const includeDetail = parseBooleanFlag(url, "includeDetail");
  const interval = parseInterval(url);

  const current = await queryOverviewAggregate(env, siteId, window, filters);
  const currentMetrics = mapOverviewAggregate(current.value, {
    approximateVisitors: current.source === "ae",
  });
  const payload: Record<string, unknown> = {
    ok: true,
    data: currentMetrics,
  };

  if (includeChange) {
    const previousTo = Math.max(window.fromMs - 1, 0);
    const previousFrom = Math.max(previousTo - (window.toMs - window.fromMs), 0);
    const previousWindow: QueryWindow = {
      fromMs: previousFrom,
      toMs: previousTo,
      nowMs: window.nowMs,
    };
    const previous = await queryOverviewAggregate(
      env,
      siteId,
      previousWindow,
      filters,
    );
    const previousMetrics = mapOverviewAggregate(previous.value, {
      approximateVisitors: previous.source === "ae",
    });
    payload.previousData = previousMetrics;
    payload.changeRates = {
      views: percentChange(currentMetrics.views, previousMetrics.views),
      sessions: percentChange(currentMetrics.sessions, previousMetrics.sessions),
      visitors: percentChange(currentMetrics.visitors, previousMetrics.visitors),
      bounces: percentChange(currentMetrics.bounces, previousMetrics.bounces),
      bounceRate: percentChange(
        currentMetrics.bounceRate,
        previousMetrics.bounceRate,
      ),
      avgDurationMs: percentChange(
        currentMetrics.avgDurationMs,
        previousMetrics.avgDurationMs,
      ),
    };
  }

  if (includeDetail) {
    const detail = await queryTrendAggregate(env, siteId, window, interval, filters);
    payload.detail = {
      interval,
      data: mapTrendRows(
        detail.value,
        interval,
        detail.source === "ae" ? "detail" : sourceLabel(window),
      ),
    };
  }

  return jsonResponse(payload);
}

async function handleTrend(env: Env, siteId: string, url: URL): Promise<Response> {
  const window = parseWindow(url);
  if (!window) return badRequest("Invalid time window");
  const filters = parseFilters(url);
  const interval = parseInterval(url);
  const trend = await queryTrendAggregate(env, siteId, window, interval, filters);
  return jsonResponse({
    ok: true,
    interval,
    data: mapTrendRows(
      trend.value,
      interval,
      trend.source === "ae" ? "detail" : sourceLabel(window),
    ),
  });
}

async function handlePages(
  env: Env,
  siteId: string,
  url: URL,
  includeTabs: boolean,
): Promise<Response> {
  const window = parseWindow(url);
  if (!window) return badRequest("Invalid time window");
  const filters = parseFilters(url);
  const limit = parseLimit(url, 20, 200);
  const includeDetails = parseBooleanFlag(url, "details");
  const pages = await queryPagesAggregate(
    env,
    siteId,
    window,
    filters,
    limit,
    includeDetails,
  );
  const payload: Record<string, unknown> = {
    ok: true,
    data: mapPages(pages),
  };
  if (includeTabs) {
    const tabs = await queryPageTabsAggregate(env, siteId, window, filters, limit);
    payload.tabs = {
      path: mapTabs(tabs.path),
      title: mapTabs(tabs.title),
      hostname: mapTabs(tabs.hostname),
      entry: mapTabs(tabs.entry),
      exit: mapTabs(tabs.exit),
    };
  }
  return jsonResponse(payload);
}

async function handleReferrers(
  env: Env,
  siteId: string,
  url: URL,
): Promise<Response> {
  const window = parseWindow(url);
  if (!window) return badRequest("Invalid time window");
  const filters = parseFilters(url);
  const limit = parseLimit(url, 20, 200);
  const includeFullUrl = parseBooleanFlag(url, "fullUrl");
  const rows = await queryReferrerAggregate(
    env,
    siteId,
    window,
    filters,
    limit,
    includeFullUrl,
  );
  return jsonResponse({ ok: true, data: mapReferrers(rows) });
}

async function handleVisitors(
  env: Env,
  siteId: string,
  url: URL,
): Promise<Response> {
  const window = parseWindow(url);
  if (!window) return badRequest("Invalid time window");
  const filters = parseFilters(url);
  const limit = parseLimit(url, 20, 200);
  const rows = await queryVisitorAggregate(env, siteId, window, filters, limit);
  return jsonResponse({ ok: true, data: mapVisitors(rows) });
}

async function handleDimension(
  env: Env,
  siteId: string,
  url: URL,
  label: string,
  aeLoader: (
    env: Env,
    siteId: string,
    window: QueryWindow,
    limit: number,
    filters?: AeQueryFilters,
  ) => Promise<AeDimensionRow[]>,
  d1Expr: string,
): Promise<Response> {
  const window = parseWindow(url);
  if (!window) return badRequest("Invalid time window");
  const filters = parseFilters(url);
  const limit = parseLimit(url, 20, 200);
  const rows = await queryDimensionAggregate(
    env,
    siteId,
    window,
    filters,
    limit,
    label,
    (aeFilters) => aeLoader(env, siteId, window, limit, aeFilters),
    d1Expr,
  );
  return jsonResponse({ ok: true, data: mapTabs(rows) });
}

async function handleEventTypes(
  env: Env,
  siteId: string,
  url: URL,
): Promise<Response> {
  const window = parseWindow(url);
  if (!window) return badRequest("Invalid time window");
  const filters = parseFilters(url);
  const limit = parseLimit(url, 20, 200);
  const rows = await queryEventTypeAggregate(env, siteId, window, filters, limit);
  return jsonResponse({ ok: true, data: mapTabs(rows) });
}

async function handleOverviewClientDimensions(
  env: Env,
  siteId: string,
  url: URL,
): Promise<Response> {
  const window = parseWindow(url);
  if (!window) return badRequest("Invalid time window");
  const filters = parseFilters(url);
  const limit = parseLimit(url, 20, 200);
  const tabs = await buildOverviewClientDimensionTabs(
    env,
    siteId,
    window,
    filters,
    limit,
  );
  return jsonResponse({
    ok: true,
    tabs: {
      browser: mapTabs(tabs.browser),
      osVersion: mapTabs(tabs.osVersion),
      deviceType: mapTabs(tabs.deviceType),
      language: mapTabs(tabs.language),
      screenSize: mapTabs(tabs.screenSize),
    },
  });
}

async function handleOverviewGeoDimensions(
  env: Env,
  siteId: string,
  url: URL,
): Promise<Response> {
  const window = parseWindow(url);
  if (!window) return badRequest("Invalid time window");
  const filters = parseFilters(url);
  const limit = parseLimit(url, 20, 200);
  const tabs = await buildOverviewGeoDimensionTabs(
    env,
    siteId,
    window,
    filters,
    limit,
  );
  return jsonResponse({
    ok: true,
    tabs: {
      country: mapTabs(tabs.country),
      region: mapTabs(tabs.region),
      city: mapTabs(tabs.city),
      continent: mapTabs(tabs.continent),
      timezone: mapTabs(tabs.timezone),
      organization: mapTabs(tabs.organization),
    },
  });
}

async function listTeamSites(env: Env, teamId: string): Promise<TeamSiteRow[]> {
  const result = await env.DB.prepare(
    `
      SELECT
        id,
        team_id AS teamId,
        name,
        domain,
        public_enabled AS publicEnabled,
        public_slug AS publicSlug,
        created_at AS createdAt,
        updated_at AS updatedAt
      FROM sites
      WHERE team_id = ?
      ORDER BY created_at DESC
    `,
  )
    .bind(teamId)
    .all<TeamSiteRow>();
  return result.results;
}

async function handleTeamDashboard(
  request: Request,
  env: Env,
  url: URL,
): Promise<Response> {
  const window = parseWindow(url);
  if (!window) return badRequest("Invalid time window", PRIVATE_CACHE_HEADERS);
  const team = await resolvePrivateTeam(request, env, url);
  if (team instanceof Response) return team;

  const interval = parseInterval(url);
  const sites = await listTeamSites(env, team.id);
  if (sites.length === 0) {
    return jsonResponse(
      {
        ok: true,
        data: {
          sites: [],
          trend: [],
        },
      },
      200,
      PRIVATE_CACHE_HEADERS,
    );
  }

  const previousTo = Math.max(window.fromMs - 1, 0);
  const previousFrom = Math.max(previousTo - (window.toMs - window.fromMs), 0);
  const previousWindow: QueryWindow = {
    fromMs: previousFrom,
    toMs: previousTo,
    nowMs: window.nowMs,
  };
  const filters: DashboardFilters = {};

  const [currentOverview, previousOverview, trends] = await Promise.all([
    Promise.all(sites.map((site) => queryOverviewAggregate(env, site.id, window, filters))),
    Promise.all(sites.map((site) => queryOverviewAggregate(env, site.id, previousWindow, filters))),
    Promise.all(sites.map((site) => queryTrendAggregate(env, site.id, window, interval, filters))),
  ]);

  const sitePayload = sites.map((site, index) => {
    const overview = mapOverviewAggregate(currentOverview[index]?.value ?? {
      views: 0,
      sessions: 0,
      visitors: 0,
      bounces: 0,
      totalDuration: 0,
      durationViews: 0,
    }, {
      approximateVisitors: currentOverview[index]?.source === "ae",
    });
    const previous = mapOverviewAggregate(previousOverview[index]?.value ?? {
      views: 0,
      sessions: 0,
      visitors: 0,
      bounces: 0,
      totalDuration: 0,
      durationViews: 0,
    }, {
      approximateVisitors: previousOverview[index]?.source === "ae",
    });
    const currentPagesPerSession = overview.sessions > 0 ? overview.views / overview.sessions : 0;
    const previousPagesPerSession = previous.sessions > 0 ? previous.views / previous.sessions : 0;

    return {
      ...site,
      overview,
      changeRates: {
        views: percentChange(overview.views, previous.views),
        visitors: percentChange(overview.visitors, previous.visitors),
        sessions: percentChange(overview.sessions, previous.sessions),
        bounceRate: percentChange(overview.bounceRate, previous.bounceRate),
        avgDurationMs: percentChange(overview.avgDurationMs, previous.avgDurationMs),
        pagesPerSession: percentChange(currentPagesPerSession, previousPagesPerSession),
      },
    };
  });

  const bucketMs = intervalBucketMs(interval);
  const trendByBucket = new Map<
    number,
    {
      bucket: number;
      timestampMs: number;
      sites: Array<{ siteId: string; views: number; visitors: number }>;
    }
  >();

  for (let index = 0; index < sites.length; index += 1) {
    const site = sites[index];
    const rows = trends[index]?.value ?? [];
    for (const row of rows) {
      const bucket = row.bucket;
      const existing = trendByBucket.get(bucket) ?? {
        bucket,
        timestampMs: bucket * bucketMs,
        sites: [],
      };
      existing.sites.push({
        siteId: site.id,
        views: row.views,
        visitors: row.visitors,
      });
      trendByBucket.set(bucket, existing);
    }
  }

  return jsonResponse(
    {
      ok: true,
      data: {
        sites: sitePayload,
        trend: [...trendByBucket.values()].sort((left, right) => left.bucket - right.bucket),
      },
    },
    200,
    PRIVATE_CACHE_HEADERS,
  );
}

async function routeQuery(
  env: Env,
  siteId: string,
  pathname: string,
  url: URL,
  options: { publicMode: boolean },
): Promise<Response> {
  if (pathname === "overview") return handleOverview(env, siteId, url);
  if (pathname === "trend") return handleTrend(env, siteId, url);
  if (pathname === "pages") return handlePages(env, siteId, url, !options.publicMode);
  if (pathname === "referrers") return handleReferrers(env, siteId, url);
  if (options.publicMode) return notFound();
  if (pathname === "visitors") return handleVisitors(env, siteId, url);
  if (pathname === "countries") {
    return handleDimension(
      env,
      siteId,
      url,
      "countries",
      queryAeTopCountries,
      "country",
    );
  }
  if (pathname === "devices") {
    return handleDimension(
      env,
      siteId,
      url,
      "devices",
      queryAeTopDevices,
      "device_type",
    );
  }
  if (pathname === "browsers") {
    return handleDimension(
      env,
      siteId,
      url,
      "browsers",
      queryAeTopBrowsers,
      "browser",
    );
  }
  if (pathname === "event-types") return handleEventTypes(env, siteId, url);
  if (pathname === "overview-client-dimensions") {
    return handleOverviewClientDimensions(env, siteId, url);
  }
  if (pathname === "overview-geo-dimensions") {
    return handleOverviewGeoDimensions(env, siteId, url);
  }
  return notFound();
}

export async function handlePrivateQuery(
  request: Request,
  env: Env,
  url: URL,
): Promise<Response> {
  if (request.method !== "GET") return notAllowed();
  const pathname = url.pathname.replace(/^\/api\/private\//, "");
  if (pathname === "team-dashboard") {
    return handleTeamDashboard(request, env, url);
  }
  const site = await resolvePrivateSite(request, env, url);
  if (site instanceof Response) return site;
  return routeQuery(env, site.id, pathname, url, { publicMode: false });
}

export async function handlePublicQuery(
  request: Request,
  env: Env,
  url: URL,
): Promise<Response> {
  if (request.method !== "GET") return notAllowed();
  const site = await fetchPublicSite(env, url);
  if (site instanceof Response) return site;
  const segments = url.pathname.split("/").filter(Boolean);
  const pathname = segments.slice(3).join("/");
  return routeQuery(env, site.id, pathname, url, { publicMode: true });
}
async function queryDimensionFromD1(
  env: Env,
  siteId: string,
  window: QueryWindow,
  filters: DashboardFilters,
  limit: number,
  selectExpr: string,
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
    count(DISTINCT CASE WHEN session_id != '' THEN session_id ELSE NULL END) AS sessions
  FROM filtered_visits
  GROUP BY value
)
SELECT value, views, sessions
FROM dimension_rollup
ORDER BY views DESC, sessions DESC, value ASC
LIMIT ?
`;
  return (await queryD1All<Record<string, unknown>>(
    env,
    sql,
    [...visitSourceBindings(siteId, window), ...filter.bindings, limit],
  )).map((row) => ({
    value: String(row.value ?? ""),
    views: Number(row.views ?? 0),
    sessions: Number(row.sessions ?? 0),
  }));
}

async function querySessionPathDimensionFromD1(
  env: Env,
  siteId: string,
  window: QueryWindow,
  filters: DashboardFilters,
  limit: number,
  kind: "entry" | "exit",
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
  count(*) AS sessions
FROM session_edges
GROUP BY value
ORDER BY views DESC, value ASC
LIMIT ?
`;
  return (await queryD1All<Record<string, unknown>>(
    env,
    sql,
    [...visitSourceBindings(siteId, window), ...filter.bindings, limit],
  )).map((row) => ({
    value: String(row.value ?? ""),
    views: Number(row.views ?? 0),
    sessions: Number(row.sessions ?? 0),
  }));
}

async function queryVisitDimensionFromD1(
  env: Env,
  siteId: string,
  window: QueryWindow,
  filters: DashboardFilters,
  limit: number,
  selectExpr: string,
): Promise<DimensionRow[]> {
  return queryDimensionFromD1(env, siteId, window, filters, limit, selectExpr);
}

async function querySessionBoundaryDimensionFromD1(
  env: Env,
  siteId: string,
  window: QueryWindow,
  filters: DashboardFilters,
  limit: number,
  kind: "entry" | "exit",
): Promise<DimensionRow[]> {
  return querySessionPathDimensionFromD1(env, siteId, window, filters, limit, kind);
}

async function queryReferrersFromD1(
  env: Env,
  siteId: string,
  window: QueryWindow,
  filters: DashboardFilters,
  limit: number,
  includeFullUrl: boolean,
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
  count(DISTINCT CASE WHEN session_id != '' THEN session_id ELSE NULL END) AS sessions
FROM filtered_visits
GROUP BY referrer
ORDER BY views DESC, sessions DESC, referrer ASC
LIMIT ?
`;
  return (await queryD1All<Record<string, unknown>>(
    env,
    sql,
    [...visitSourceBindings(siteId, window), ...filter.bindings, limit],
  )).map((row) => ({
    referrer: String(row.referrer ?? ""),
    views: Number(row.views ?? 0),
    sessions: Number(row.sessions ?? 0),
  }));
}

async function queryVisitorsFromD1(
  env: Env,
  siteId: string,
  window: QueryWindow,
  filters: DashboardFilters,
  limit: number,
): Promise<VisitorRow[]> {
  const filter = buildVisitFilterSql(filters);
  const sql = `
WITH
${buildVisitSourceCte()},
filtered_visits AS (
  SELECT *
  FROM visit_source
  ${filter.clause}
)
SELECT
  visitor_id AS visitorId,
  MIN(started_at) AS firstSeenAt,
  MAX(started_at) AS lastSeenAt,
  count(*) AS views,
  count(DISTINCT CASE WHEN session_id != '' THEN session_id ELSE NULL END) AS sessions
FROM filtered_visits
WHERE visitor_id != ''
GROUP BY visitor_id
ORDER BY lastSeenAt DESC, visitorId ASC
LIMIT ?
`;
  return (await queryD1All<Record<string, unknown>>(
    env,
    sql,
    [...visitSourceBindings(siteId, window), ...filter.bindings, limit],
  )).map((row) => ({
    visitorId: String(row.visitorId ?? ""),
    firstSeenAt: Number(row.firstSeenAt ?? 0),
    lastSeenAt: Number(row.lastSeenAt ?? 0),
    views: Number(row.views ?? 0),
    sessions: Number(row.sessions ?? 0),
  }));
}

async function queryCustomEventNamesFromD1(
  env: Env,
  siteId: string,
  window: QueryWindow,
  filters: DashboardFilters,
  limit: number,
): Promise<DimensionRow[]> {
  const filter = buildEventFilterSql(filters);
  const sql = `
WITH
${buildCustomEventSourceCte()},
filtered_events AS (
  SELECT *
  FROM event_source
  ${filter.clause}
),
event_rollup AS (
  SELECT
    COALESCE(event_name, '') AS value,
    count(*) AS views,
    count(DISTINCT CASE WHEN session_id != '' THEN session_id ELSE NULL END) AS sessions
  FROM filtered_events
  GROUP BY value
)
SELECT value, views, sessions
FROM event_rollup
WHERE TRIM(value) != ''
ORDER BY views DESC, sessions DESC, value ASC
LIMIT ?
`;
  return (await queryD1All<Record<string, unknown>>(
    env,
    sql,
    [...eventSourceBindings(siteId, window), ...filter.bindings, limit],
  )).map((row) => ({
    value: String(row.value ?? ""),
    views: Number(row.views ?? 0),
    sessions: Number(row.sessions ?? 0),
  }));
}

async function queryOverviewClientDimensionsFromD1(
  env: Env,
  siteId: string,
  window: QueryWindow,
  filters: DashboardFilters,
  limit: number,
): Promise<ClientDimensionTabs> {
  const [browser, osVersion, deviceType, language, screenSize] = await Promise.all([
    queryDimensionFromD1(env, siteId, window, filters, limit, "browser"),
    queryDimensionFromD1(env, siteId, window, filters, limit, osVersionExpr()),
    queryDimensionFromD1(env, siteId, window, filters, limit, "device_type"),
    queryDimensionFromD1(env, siteId, window, filters, limit, "language"),
    queryDimensionFromD1(env, siteId, window, filters, limit, screenSizeExpr()),
  ]);

  return {
    browser: browser.map((row) => ({ label: row.value, views: row.views, sessions: row.sessions })),
    osVersion: osVersion.map((row) => ({ label: row.value, views: row.views, sessions: row.sessions })),
    deviceType: deviceType.map((row) => ({ label: row.value, views: row.views, sessions: row.sessions })),
    language: language.map((row) => ({ label: row.value, views: row.views, sessions: row.sessions })),
    screenSize: screenSize.map((row) => ({ label: row.value, views: row.views, sessions: row.sessions })),
  };
}

async function queryOverviewGeoDimensionsFromD1(
  env: Env,
  siteId: string,
  window: QueryWindow,
  filters: DashboardFilters,
  limit: number,
): Promise<GeoDimensionTabs> {
  const [country, region, city, continent, timezone, organization] = await Promise.all([
    queryDimensionFromD1(env, siteId, window, filters, limit, "country"),
    queryDimensionFromD1(env, siteId, window, filters, limit, "region"),
    queryDimensionFromD1(env, siteId, window, filters, limit, "city"),
    queryDimensionFromD1(env, siteId, window, filters, limit, "continent"),
    queryDimensionFromD1(env, siteId, window, filters, limit, "timezone"),
    queryDimensionFromD1(env, siteId, window, filters, limit, "as_organization"),
  ]);

  return {
    country: country.map((row) => ({ label: row.value, views: row.views, sessions: row.sessions })),
    region: region.map((row) => ({ label: row.value, views: row.views, sessions: row.sessions })),
    city: city.map((row) => ({ label: row.value, views: row.views, sessions: row.sessions })),
    continent: continent.map((row) => ({ label: row.value, views: row.views, sessions: row.sessions })),
    timezone: timezone.map((row) => ({ label: row.value, views: row.views, sessions: row.sessions })),
    organization: organization.map((row) => ({ label: row.value, views: row.views, sessions: row.sessions })),
  };
}

function aeSqlString(value: string): string {
  return `'${String(value).replace(/'/g, "''")}'`;
}

function clampAeLimit(limit: number, fallback = 100): number {
  const value = Math.floor(limit);
  if (!Number.isFinite(value) || value <= 0) return fallback;
  return Math.min(AE_MAX_SQL_LIMIT, value);
}

function parseAeNumber(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return 0;
}

function parseAeString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

async function runAeSqlLocal<T extends Record<string, unknown>>(env: Env, sql: string): Promise<T[]> {
  if (!isAnalyticsSqlConfigured(env)) {
    throw new Error("Analytics Engine SQL config missing");
  }

  const endpoint = `https://api.cloudflare.com/client/v4/accounts/${String(env.ANALYTICS_ACCOUNT_ID || "").trim()}/analytics_engine/sql`;
  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      authorization: `Bearer ${String(env.ANALYTICS_SQL_API_TOKEN || "").trim()}`,
      "content-type": "text/plain",
    },
    body: sql,
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Analytics Engine SQL failed (${response.status}): ${text.slice(0, 512)}`);
  }

  const payload = (await response.json()) as Record<string, unknown>;
  if (Array.isArray(payload.data)) return payload.data as T[];
  if (Array.isArray(payload.results)) return payload.results as T[];
  const result = payload.result;
  if (result && typeof result === "object") {
    const nested = result as Record<string, unknown>;
    if (Array.isArray(nested.data)) return nested.data as T[];
    if (Array.isArray(nested.results)) return nested.results as T[];
  }
  return [];
}

function buildAeVisitFilterClause(filters: DashboardFilters): string {
  const clauses: string[] = [];
  if (filters.country) clauses.push(`country = ${aeSqlString(filters.country)}`);
  if (filters.device) clauses.push(`device_type_code = ${encodeAeDeviceType(filters.device)}`);
  if (filters.browser) clauses.push(`browser = ${aeSqlString(filters.browser)}`);
  return clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
}

function aeDeviceTypeSql(codeExpr: string): string {
  return [
    `if(${codeExpr} = 1, 'desktop'`,
    `if(${codeExpr} = 2, 'mobile'`,
    `if(${codeExpr} = 3, 'tablet'`,
    `if(${codeExpr} = 4, 'smarttv'`,
    `if(${codeExpr} = 5, 'console'`,
    `if(${codeExpr} = 6, 'wearable'`,
    `if(${codeExpr} = 7, 'embedded'`,
    `if(${codeExpr} = 255, 'other', ''))))))))`,
  ].join(", ");
}

function aeVisitCtes(siteId: string, window: QueryWindow): string {
  return `
visit_rows AS (
  SELECT
    double8 AS row_type_code,
    blob1 AS visit_id,
    blob2 AS visitor_id,
    blob3 AS session_id,
    blob4 AS pathname,
    blob5 AS query_string,
    blob6 AS hash_fragment,
    blob7 AS hostname,
    blob8 AS referrer_url,
    blob9 AS referrer_host,
    blob10 AS country,
    blob11 AS region,
    blob12 AS city,
    blob13 AS browser,
    blob14 AS os,
    blob15 AS os_version,
    double9 AS device_type_code,
    ${aeDeviceTypeSql("double9")} AS device_type,
    blob16 AS language,
    blob17 AS timezone,
    blob20 AS extra_value,
    double1 AS event_at,
    double2 AS duration_ms,
    double11 AS started_at,
    double4 AS screen_width,
    double5 AS screen_height
  FROM ${AE_DATASET}
  WHERE index1 = ${aeSqlString(siteId)}
    AND double3 = ${AE_LAYOUT_VERSION}
    AND double11 BETWEEN ${Math.floor(window.fromMs)} AND ${Math.floor(window.toMs)}
    AND double8 IN (${AE_ROW_TYPE_VISIT_START}, ${AE_ROW_TYPE_VISIT_FINALIZE})
),
visits AS (
  SELECT
    visit_id,
    argMax(visitor_id, if(row_type_code = ${AE_ROW_TYPE_VISIT_START}, event_at, -1)) AS visitor_id,
    argMax(session_id, if(row_type_code = ${AE_ROW_TYPE_VISIT_START}, event_at, -1)) AS session_id,
    argMax(pathname, if(row_type_code = ${AE_ROW_TYPE_VISIT_START}, event_at, -1)) AS pathname,
    argMax(query_string, if(row_type_code = ${AE_ROW_TYPE_VISIT_START}, event_at, -1)) AS query_string,
    argMax(hash_fragment, if(row_type_code = ${AE_ROW_TYPE_VISIT_START}, event_at, -1)) AS hash_fragment,
    argMax(hostname, if(row_type_code = ${AE_ROW_TYPE_VISIT_START}, event_at, -1)) AS hostname,
    argMax(referrer_url, if(row_type_code = ${AE_ROW_TYPE_VISIT_START}, event_at, -1)) AS referrer_url,
    argMax(referrer_host, if(row_type_code = ${AE_ROW_TYPE_VISIT_START}, event_at, -1)) AS referrer_host,
    argMax(country, if(row_type_code = ${AE_ROW_TYPE_VISIT_START}, event_at, -1)) AS country,
    argMax(region, if(row_type_code = ${AE_ROW_TYPE_VISIT_START}, event_at, -1)) AS region,
    argMax(city, if(row_type_code = ${AE_ROW_TYPE_VISIT_START}, event_at, -1)) AS city,
    argMax(browser, if(row_type_code = ${AE_ROW_TYPE_VISIT_START}, event_at, -1)) AS browser,
    argMax(os, if(row_type_code = ${AE_ROW_TYPE_VISIT_START}, event_at, -1)) AS os,
    argMax(os_version, if(row_type_code = ${AE_ROW_TYPE_VISIT_START}, event_at, -1)) AS os_version,
    argMax(device_type_code, if(row_type_code = ${AE_ROW_TYPE_VISIT_START}, event_at, -1)) AS device_type_code,
    argMax(device_type, if(row_type_code = ${AE_ROW_TYPE_VISIT_START}, event_at, -1)) AS device_type,
    argMax(language, if(row_type_code = ${AE_ROW_TYPE_VISIT_START}, event_at, -1)) AS language,
    argMax(timezone, if(row_type_code = ${AE_ROW_TYPE_VISIT_START}, event_at, -1)) AS timezone,
    argMax(extra_value, if(row_type_code = ${AE_ROW_TYPE_VISIT_START}, event_at, -1)) AS title,
    max(if(row_type_code = ${AE_ROW_TYPE_VISIT_START}, started_at, NULL)) AS started_at,
    max(if(row_type_code = ${AE_ROW_TYPE_VISIT_FINALIZE}, event_at, NULL)) AS finalized_at,
    max(if(row_type_code = ${AE_ROW_TYPE_VISIT_FINALIZE}, duration_ms, NULL)) AS duration_ms
  FROM visit_rows
  GROUP BY visit_id
)`;
}

async function queryAeTopPagesExact(
  env: Env,
  siteId: string,
  window: QueryWindow,
  limit: number,
  includeDetails: boolean,
  filters: DashboardFilters,
): Promise<PageRow[]> {
  const sql = `
WITH
${aeVisitCtes(siteId, window)},
filtered_visits AS (
  SELECT *
  FROM visits
  ${buildAeVisitFilterClause(filters)}
)
SELECT
  pathname,
  ${includeDetails ? "query_string" : "'' AS query_string"},
  ${includeDetails ? "hash_fragment" : "'' AS hash_fragment"},
  count() AS views,
  count(DISTINCT session_id) AS sessions
FROM filtered_visits
GROUP BY pathname, query_string, hash_fragment
ORDER BY views DESC, pathname ASC
LIMIT ${clampAeLimit(limit, 30)}
`;

  return (await runAeSqlLocal<Record<string, unknown>>(env, sql)).map((row) => ({
    pathname: parseAeString(row.pathname),
    query: parseAeString(row.query_string),
    hash: parseAeString(row.hash_fragment),
    views: parseAeNumber(row.views),
    sessions: parseAeNumber(row.sessions),
  }));
}

async function queryAeCustomEventNamesExact(
  env: Env,
  siteId: string,
  window: QueryWindow,
  limit: number,
  filters: DashboardFilters,
): Promise<DimensionRow[]> {
  const clauses = [
    `index1 = ${aeSqlString(siteId)}`,
    `double3 = ${AE_LAYOUT_VERSION}`,
    `double8 = ${AE_ROW_TYPE_CUSTOM_EVENT}`,
    `double1 BETWEEN ${Math.floor(window.fromMs)} AND ${Math.floor(window.toMs)}`,
    "length(trim(blob20)) > 0",
  ];
  if (filters.country) clauses.push(`blob10 = ${aeSqlString(filters.country)}`);
  if (filters.browser) clauses.push(`blob13 = ${aeSqlString(filters.browser)}`);
  if (filters.device) clauses.push(`double9 = ${encodeAeDeviceType(filters.device)}`);

  const sql = `
SELECT
  blob20 AS value,
  count() AS views,
  count(DISTINCT blob3) AS sessions
FROM ${AE_DATASET}
WHERE ${clauses.join(" AND ")}
GROUP BY value
ORDER BY views DESC, sessions DESC, value ASC
LIMIT ${clampAeLimit(limit, 30)}
`;

  return (await runAeSqlLocal<Record<string, unknown>>(env, sql)).map((row) => ({
    value: parseAeString(row.value),
    views: parseAeNumber(row.views),
    sessions: parseAeNumber(row.sessions),
  }));
}
