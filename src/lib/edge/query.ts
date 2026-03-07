import type { Env } from "./types";
import { ONE_DAY_MS, ONE_HOUR_MS, coerceNumber } from "./utils";
import { requireSession } from "./session-auth";

const RETENTION_DAYS = 365;
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
  browser: DimensionRow[];
  osVersion: DimensionRow[];
  deviceType: DimensionRow[];
  language: DimensionRow[];
  screenSize: DimensionRow[];
}

interface GeoDimensionTabs {
  country: DimensionRow[];
  region: DimensionRow[];
  city: DimensionRow[];
  continent: DimensionRow[];
  timezone: DimensionRow[];
  organization: DimensionRow[];
}

interface OverviewPanelsAggregate {
  pageTabs: {
    path: DimensionRow[];
    title: DimensionRow[];
    hostname: DimensionRow[];
    entry: DimensionRow[];
    exit: DimensionRow[];
  };
  referrers: ReferrerRow[];
  clientTabs: ClientDimensionTabs;
  geoTabs: GeoDimensionTabs;
}

interface PublicSiteEnvelope {
  slug: string;
  name: string;
  domain: string;
}

interface PreferredSourceResult<T> {
  value: T;
  source: "ae" | "d1";
  approximateVisitors?: boolean;
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

function mapPageTabs(tabs: OverviewPanelsAggregate["pageTabs"]): PageTabs {
  return {
    path: mapTabs(tabs.path),
    title: mapTabs(tabs.title),
    hostname: mapTabs(tabs.hostname),
    entry: mapTabs(tabs.entry),
    exit: mapTabs(tabs.exit),
  };
}

interface DimensionAccumulator {
  views: number;
  sessions: Set<string>;
}

function addDimensionValue(
  buckets: Map<string, DimensionAccumulator>,
  rawValue: string,
  sessionId: string,
): void {
  const value = rawValue.trim();
  if (!value) return;
  const bucket = buckets.get(value) ?? { views: 0, sessions: new Set<string>() };
  bucket.views += 1;
  if (sessionId) bucket.sessions.add(sessionId);
  buckets.set(value, bucket);
}

function finalizeDimensionBuckets(
  buckets: Map<string, DimensionAccumulator>,
  limit: number,
): DimensionRow[] {
  return [...buckets.entries()]
    .map(([value, bucket]) => ({
      value,
      views: bucket.views,
      sessions: bucket.sessions.size,
    }))
    .sort((left, right) => right.views - left.views || right.sessions - left.sessions || left.value.localeCompare(right.value))
    .slice(0, limit);
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

function buildVisitSourceCteForSites(siteCount: number): string {
  const placeholders = Array.from({ length: siteCount }, () => "?").join(", ");
  return `
visit_source AS (
  SELECT ${VISIT_SOURCE_COLUMNS}
  FROM visits
  WHERE site_id IN (${placeholders}) AND started_at BETWEEN ? AND ?
  UNION ALL
  SELECT ${VISIT_SOURCE_COLUMNS}
  FROM visits_archive
  WHERE site_id IN (${placeholders}) AND started_at BETWEEN ? AND ?
)`;
}

function visitSourceBindingsForSites(siteIds: string[], window: QueryWindow): Array<string | number> {
  return [...siteIds, window.fromMs, window.toMs, ...siteIds, window.fromMs, window.toMs];
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

async function queryTeamOverviewFromD1(
  env: Env,
  siteIds: string[],
  window: QueryWindow,
): Promise<Map<string, OverviewAggregateRow>> {
  if (siteIds.length === 0) return new Map();
  const sql = `
WITH
${buildVisitSourceCteForSites(siteIds.length)},
session_rollup AS (
  SELECT site_id AS siteId, session_id, count(*) AS visit_count
  FROM visit_source
  WHERE session_id != ''
  GROUP BY siteId, session_id
),
combined AS (
  SELECT
    site_id AS siteId,
    count(*) AS views,
    count(DISTINCT CASE WHEN session_id != '' THEN session_id ELSE NULL END) AS sessions,
    count(DISTINCT CASE WHEN visitor_id != '' THEN visitor_id ELSE NULL END) AS visitors,
    0 AS bounces,
    COALESCE(sum(CASE WHEN duration_ms IS NOT NULL AND duration_ms >= 0 THEN duration_ms ELSE 0 END), 0) AS totalDuration,
    COALESCE(sum(CASE WHEN duration_ms IS NOT NULL AND duration_ms >= 0 THEN 1 ELSE 0 END), 0) AS durationViews
  FROM visit_source
  GROUP BY siteId
  UNION ALL
  SELECT
    siteId,
    0 AS views,
    0 AS sessions,
    0 AS visitors,
    COALESCE(sum(CASE WHEN visit_count = 1 THEN 1 ELSE 0 END), 0) AS bounces,
    0 AS totalDuration,
    0 AS durationViews
  FROM session_rollup
  GROUP BY siteId
)
SELECT
  siteId,
  sum(views) AS views,
  sum(sessions) AS sessions,
  sum(visitors) AS visitors,
  sum(bounces) AS bounces,
  sum(totalDuration) AS totalDuration,
  sum(durationViews) AS durationViews
FROM combined
GROUP BY siteId
`;
  const rows = await queryD1All<Record<string, unknown>>(
    env,
    sql,
    visitSourceBindingsForSites(siteIds, window),
  );
  return new Map(
    rows.map((row) => [
      String(row.siteId ?? ""),
      {
        views: Number(row.views ?? 0),
        sessions: Number(row.sessions ?? 0),
        visitors: Number(row.visitors ?? 0),
        bounces: Number(row.bounces ?? 0),
        totalDuration: Number(row.totalDuration ?? 0),
        durationViews: Number(row.durationViews ?? 0),
      } satisfies OverviewAggregateRow,
    ]),
  );
}

interface TeamTrendRow {
  siteId: string;
  bucket: number;
  views: number;
  visitors: number;
}

async function queryTeamTrendFromD1(
  env: Env,
  siteIds: string[],
  window: QueryWindow,
  interval: Interval,
): Promise<TeamTrendRow[]> {
  if (siteIds.length === 0) return [];
  const bucketDivisor = intervalBucketMs(interval);
  const sql = `
WITH
${buildVisitSourceCteForSites(siteIds.length)}
SELECT
  site_id AS siteId,
  CAST(started_at / ${bucketDivisor} AS INTEGER) AS bucket,
  count(*) AS views,
  count(DISTINCT CASE WHEN visitor_id != '' THEN visitor_id ELSE NULL END) AS visitors
FROM visit_source
GROUP BY siteId, bucket
ORDER BY bucket ASC, siteId ASC
`;
  return (await queryD1All<Record<string, unknown>>(
    env,
    sql,
    visitSourceBindingsForSites(siteIds, window),
  )).map((row) => ({
    siteId: String(row.siteId ?? ""),
    bucket: Number(row.bucket ?? 0),
    views: Number(row.views ?? 0),
    visitors: Number(row.visitors ?? 0),
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
  return {
    value: await queryOverviewFromD1(env, siteId, window, filters),
    source: "d1",
    approximateVisitors: false,
  };
}

async function queryTrendAggregate(
  env: Env,
  siteId: string,
  window: QueryWindow,
  interval: Interval,
  filters: DashboardFilters,
): Promise<PreferredSourceResult<TrendAggregateRow[]>> {
  return {
    value: await queryTrendFromD1(env, siteId, window, interval, filters),
    source: "d1",
  };
}

async function queryPagesAggregate(
  env: Env,
  siteId: string,
  window: QueryWindow,
  filters: DashboardFilters,
  limit: number,
  includeDetails: boolean,
): Promise<PageRow[]> {
  return queryPagesFromD1(env, siteId, window, filters, limit, includeDetails);
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
  return queryPageTabsFromD1(env, siteId, window, filters, limit);
}

async function queryReferrerAggregate(
  env: Env,
  siteId: string,
  window: QueryWindow,
  filters: DashboardFilters,
  limit: number,
  includeFullUrl: boolean,
): Promise<ReferrerRow[]> {
  return queryReferrersFromD1(
    env,
    siteId,
    window,
    filters,
    limit,
    includeFullUrl,
  );
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
  d1Expr: string,
): Promise<DimensionRow[]> {
  return queryVisitDimensionFromD1(env, siteId, window, filters, limit, d1Expr);
}

async function queryEventTypeAggregate(
  env: Env,
  siteId: string,
  window: QueryWindow,
  filters: DashboardFilters,
  limit: number,
): Promise<DimensionRow[]> {
  return queryCustomEventNamesFromD1(env, siteId, window, filters, limit);
}

async function buildOverviewClientDimensionTabs(
  env: Env,
  siteId: string,
  window: QueryWindow,
  filters: DashboardFilters,
  limit: number,
) {
  return queryOverviewClientDimensionsFromD1(env, siteId, window, filters, limit);
}

async function buildOverviewGeoDimensionTabs(
  env: Env,
  siteId: string,
  window: QueryWindow,
  filters: DashboardFilters,
  limit: number,
) {
  return queryOverviewGeoDimensionsFromD1(env, siteId, window, filters, limit);
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
    approximateVisitors: Boolean(current.approximateVisitors),
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
      approximateVisitors: Boolean(previous.approximateVisitors),
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

async function handleOverviewPanels(
  env: Env,
  siteId: string,
  url: URL,
): Promise<Response> {
  const window = parseWindow(url);
  if (!window) return badRequest("Invalid time window");
  const filters = parseFilters(url);
  const limit = parseLimit(url, 100, 200);
  const panels = await queryOverviewPanelsFromD1(env, siteId, window, filters, limit);
  return jsonResponse({
    ok: true,
    pageTabs: mapPageTabs(panels.pageTabs),
    referrers: mapReferrers(panels.referrers),
    clientTabs: {
      browser: mapTabs(panels.clientTabs.browser),
      osVersion: mapTabs(panels.clientTabs.osVersion),
      deviceType: mapTabs(panels.clientTabs.deviceType),
      language: mapTabs(panels.clientTabs.language),
      screenSize: mapTabs(panels.clientTabs.screenSize),
    },
    geoTabs: {
      country: mapTabs(panels.geoTabs.country),
      region: mapTabs(panels.geoTabs.region),
      city: mapTabs(panels.geoTabs.city),
      continent: mapTabs(panels.geoTabs.continent),
      timezone: mapTabs(panels.geoTabs.timezone),
      organization: mapTabs(panels.geoTabs.organization),
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
  const siteIds = sites.map((site) => site.id);
  const [currentOverview, previousOverview, trendRows] = await Promise.all([
    queryTeamOverviewFromD1(env, siteIds, window),
    queryTeamOverviewFromD1(env, siteIds, previousWindow),
    queryTeamTrendFromD1(env, siteIds, window, interval),
  ]);

  const sitePayload = sites.map((site, index) => {
    const overview = mapOverviewAggregate(currentOverview.get(site.id) ?? {
      views: 0,
      sessions: 0,
      visitors: 0,
      bounces: 0,
      totalDuration: 0,
      durationViews: 0,
    });
    const previous = mapOverviewAggregate(previousOverview.get(site.id) ?? {
      views: 0,
      sessions: 0,
      visitors: 0,
      bounces: 0,
      totalDuration: 0,
      durationViews: 0,
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

  for (const row of trendRows) {
    const bucket = row.bucket;
    const existing = trendByBucket.get(bucket) ?? {
      bucket,
      timestampMs: bucket * bucketMs,
      sites: [],
    };
    existing.sites.push({
      siteId: row.siteId,
      views: row.views,
      visitors: row.visitors,
    });
    trendByBucket.set(bucket, existing);
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
    return handleDimension(env, siteId, url, "country");
  }
  if (pathname === "devices") {
    return handleDimension(env, siteId, url, "device_type");
  }
  if (pathname === "browsers") {
    return handleDimension(env, siteId, url, "browser");
  }
  if (pathname === "event-types") return handleEventTypes(env, siteId, url);
  if (pathname === "overview-panels") {
    return handleOverviewPanels(env, siteId, url);
  }
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

async function queryPageTabsFromD1(
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
    session_id AS sessionId,
    started_at AS startedAt,
    pathname,
    title,
    hostname
  FROM visit_source
  ${filter.clause}
)
SELECT sessionId, startedAt, pathname, title, hostname
FROM filtered_visits
`;
  const rows = await queryD1All<Record<string, unknown>>(
    env,
    sql,
    [...visitSourceBindings(siteId, window), ...filter.bindings],
  );

  const path = new Map<string, DimensionAccumulator>();
  const title = new Map<string, DimensionAccumulator>();
  const hostname = new Map<string, DimensionAccumulator>();
  const entryBySession = new Map<string, { at: number; value: string }>();
  const exitBySession = new Map<string, { at: number; value: string }>();

  for (const row of rows) {
    const sessionId = String(row.sessionId ?? "");
    const startedAt = Number(row.startedAt ?? 0);
    addDimensionValue(path, String(row.pathname ?? ""), sessionId);
    addDimensionValue(title, String(row.title ?? ""), sessionId);
    addDimensionValue(hostname, String(row.hostname ?? ""), sessionId);
    if (!sessionId) continue;
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
    addDimensionValue(entry, edge.value, sessionId);
  }
  for (const [sessionId, edge] of exitBySession.entries()) {
    addDimensionValue(exit, edge.value, sessionId);
  }

  return {
    path: finalizeDimensionBuckets(path, limit),
    title: finalizeDimensionBuckets(title, limit),
    hostname: finalizeDimensionBuckets(hostname, limit),
    entry: finalizeDimensionBuckets(entry, limit),
    exit: finalizeDimensionBuckets(exit, limit),
  };
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
  const rows = await queryD1All<Record<string, unknown>>(
    env,
    sql,
    [...visitSourceBindings(siteId, window), ...filter.bindings],
  );

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
    addDimensionValue(osVersion, os && version ? `${os} ${version}` : os || version, sessionId);
    const width = Number(row.screenWidth ?? 0);
    const height = Number(row.screenHeight ?? 0);
    if (Number.isFinite(width) && width > 0 && Number.isFinite(height) && height > 0) {
      addDimensionValue(screenSize, `${Math.trunc(width)}x${Math.trunc(height)}`, sessionId);
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

async function queryOverviewGeoDimensionsFromD1(
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
    country,
    region,
    city,
    continent,
    timezone,
    as_organization AS asOrganization
  FROM visit_source
  ${filter.clause}
)
SELECT sessionId, country, region, city, continent, timezone, asOrganization
FROM filtered_visits
`;
  const rows = await queryD1All<Record<string, unknown>>(
    env,
    sql,
    [...visitSourceBindings(siteId, window), ...filter.bindings],
  );

  const country = new Map<string, DimensionAccumulator>();
  const region = new Map<string, DimensionAccumulator>();
  const city = new Map<string, DimensionAccumulator>();
  const continent = new Map<string, DimensionAccumulator>();
  const timezone = new Map<string, DimensionAccumulator>();
  const organization = new Map<string, DimensionAccumulator>();

  for (const row of rows) {
    const sessionId = String(row.sessionId ?? "");
    addDimensionValue(country, String(row.country ?? ""), sessionId);
    addDimensionValue(region, String(row.region ?? ""), sessionId);
    addDimensionValue(city, String(row.city ?? ""), sessionId);
    addDimensionValue(continent, String(row.continent ?? ""), sessionId);
    addDimensionValue(timezone, String(row.timezone ?? ""), sessionId);
    addDimensionValue(organization, String(row.asOrganization ?? ""), sessionId);
  }

  return {
    country: finalizeDimensionBuckets(country, limit),
    region: finalizeDimensionBuckets(region, limit),
    city: finalizeDimensionBuckets(city, limit),
    continent: finalizeDimensionBuckets(continent, limit),
    timezone: finalizeDimensionBuckets(timezone, limit),
    organization: finalizeDimensionBuckets(organization, limit),
  };
}

async function queryOverviewPanelsFromD1(
  env: Env,
  siteId: string,
  window: QueryWindow,
  filters: DashboardFilters,
  limit: number,
): Promise<OverviewPanelsAggregate> {
  const filter = buildVisitFilterSql(filters);
  const sql = `
WITH
${buildVisitSourceCte()},
filtered_visits AS (
  SELECT
    session_id AS sessionId,
    started_at AS startedAt,
    pathname,
    title,
    hostname,
    referrer_url AS referrerUrl,
    browser,
    os,
    os_version AS osVersion,
    device_type AS deviceType,
    language,
    screen_width AS screenWidth,
    screen_height AS screenHeight,
    country,
    region,
    city,
    continent,
    timezone,
    as_organization AS asOrganization
  FROM visit_source
  ${filter.clause}
)
SELECT
  sessionId,
  startedAt,
  pathname,
  title,
  hostname,
  referrerUrl,
  browser,
  os,
  osVersion,
  deviceType,
  language,
  screenWidth,
  screenHeight,
  country,
  region,
  city,
  continent,
  timezone,
  asOrganization
FROM filtered_visits
`;
  const rows = await queryD1All<Record<string, unknown>>(
    env,
    sql,
    [...visitSourceBindings(siteId, window), ...filter.bindings],
  );

  const path = new Map<string, DimensionAccumulator>();
  const title = new Map<string, DimensionAccumulator>();
  const hostname = new Map<string, DimensionAccumulator>();
  const referrers = new Map<string, DimensionAccumulator>();
  const browser = new Map<string, DimensionAccumulator>();
  const osVersion = new Map<string, DimensionAccumulator>();
  const deviceType = new Map<string, DimensionAccumulator>();
  const language = new Map<string, DimensionAccumulator>();
  const screenSize = new Map<string, DimensionAccumulator>();
  const country = new Map<string, DimensionAccumulator>();
  const region = new Map<string, DimensionAccumulator>();
  const city = new Map<string, DimensionAccumulator>();
  const continent = new Map<string, DimensionAccumulator>();
  const timezone = new Map<string, DimensionAccumulator>();
  const organization = new Map<string, DimensionAccumulator>();
  const entryBySession = new Map<string, { at: number; value: string }>();
  const exitBySession = new Map<string, { at: number; value: string }>();

  for (const row of rows) {
    const sessionId = String(row.sessionId ?? "");
    const startedAt = Number(row.startedAt ?? 0);
    const pathnameValue = String(row.pathname ?? "");

    addDimensionValue(path, pathnameValue, sessionId);
    addDimensionValue(title, String(row.title ?? ""), sessionId);
    addDimensionValue(hostname, String(row.hostname ?? ""), sessionId);
    addDimensionValue(browser, String(row.browser ?? ""), sessionId);
    addDimensionValue(deviceType, String(row.deviceType ?? ""), sessionId);
    addDimensionValue(language, String(row.language ?? ""), sessionId);
    addDimensionValue(country, String(row.country ?? ""), sessionId);
    addDimensionValue(region, String(row.region ?? ""), sessionId);
    addDimensionValue(city, String(row.city ?? ""), sessionId);
    addDimensionValue(continent, String(row.continent ?? ""), sessionId);
    addDimensionValue(timezone, String(row.timezone ?? ""), sessionId);
    addDimensionValue(organization, String(row.asOrganization ?? ""), sessionId);

    const os = String(row.os ?? "").trim();
    const version = String(row.osVersion ?? "").trim();
    addDimensionValue(osVersion, os && version ? `${os} ${version}` : os || version, sessionId);

    const referrerValue = String(row.referrerUrl ?? "").trim();
    const referrerBucket = referrers.get(referrerValue) ?? {
      views: 0,
      sessions: new Set<string>(),
    };
    referrerBucket.views += 1;
    if (sessionId) referrerBucket.sessions.add(sessionId);
    referrers.set(referrerValue, referrerBucket);

    const width = Number(row.screenWidth ?? 0);
    const height = Number(row.screenHeight ?? 0);
    if (Number.isFinite(width) && width > 0 && Number.isFinite(height) && height > 0) {
      addDimensionValue(screenSize, `${Math.trunc(width)}x${Math.trunc(height)}`, sessionId);
    }

    if (!sessionId) continue;
    const normalizedPath = pathnameValue.trim();
    if (!normalizedPath) continue;
    const entry = entryBySession.get(sessionId);
    if (!entry || startedAt < entry.at) {
      entryBySession.set(sessionId, { at: startedAt, value: normalizedPath });
    }
    const exit = exitBySession.get(sessionId);
    if (!exit || startedAt >= exit.at) {
      exitBySession.set(sessionId, { at: startedAt, value: normalizedPath });
    }
  }

  const entry = new Map<string, DimensionAccumulator>();
  const exit = new Map<string, DimensionAccumulator>();
  for (const [sessionId, edge] of entryBySession.entries()) {
    addDimensionValue(entry, edge.value, sessionId);
  }
  for (const [sessionId, edge] of exitBySession.entries()) {
    addDimensionValue(exit, edge.value, sessionId);
  }

  return {
    pageTabs: {
      path: finalizeDimensionBuckets(path, limit),
      title: finalizeDimensionBuckets(title, limit),
      hostname: finalizeDimensionBuckets(hostname, limit),
      entry: finalizeDimensionBuckets(entry, limit),
      exit: finalizeDimensionBuckets(exit, limit),
    },
    referrers: finalizeDimensionBuckets(referrers, limit).map((row) => ({
      referrer: row.value,
      views: row.views,
      sessions: row.sessions,
    })),
    clientTabs: {
      browser: finalizeDimensionBuckets(browser, limit),
      osVersion: finalizeDimensionBuckets(osVersion, limit),
      deviceType: finalizeDimensionBuckets(deviceType, limit),
      language: finalizeDimensionBuckets(language, limit),
      screenSize: finalizeDimensionBuckets(screenSize, limit),
    },
    geoTabs: {
      country: finalizeDimensionBuckets(country, limit),
      region: finalizeDimensionBuckets(region, limit),
      city: finalizeDimensionBuckets(city, limit),
      continent: finalizeDimensionBuckets(continent, limit),
      timezone: finalizeDimensionBuckets(timezone, limit),
      organization: finalizeDimensionBuckets(organization, limit),
    },
  };
}
