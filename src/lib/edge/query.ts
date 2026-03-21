import type { Env } from "./types";
import { ONE_DAY_MS, ONE_HOUR_MS, coerceNumber } from "./utils";
import { requireSession } from "./session-auth";
import {
  buildLocalityLocationValue,
  buildRegionLocationValue,
  parseGeoLocationValue,
} from "@/lib/dashboard/geo-location";
import { browserEngineCaseSql } from "@/lib/browser-engine";

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
  path?: string;
  title?: string;
  hostname?: string;
  entry?: string;
  exit?: string;
  sourceDomain?: string;
  sourceLink?: string;
  clientBrowser?: string;
  clientOsVersion?: string;
  clientDeviceType?: string;
  clientLanguage?: string;
  clientScreenSize?: string;
  geo?: string;
  geoContinent?: string;
  geoTimezone?: string;
  geoOrganization?: string;
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

interface BrowserTrendSeriesRow {
  key: string;
  label: string;
  views: number;
  sessions: number;
  isOther?: boolean;
}

interface BrowserTrendBucketRow {
  bucket: number;
  label: string;
  views: number;
  sessions: number;
}

interface BrowserTrendPointRow {
  bucket: number;
  timestampMs: number;
  totalViews: number;
  totalSessions: number;
  viewsBySeries: Record<string, number>;
  sessionsBySeries: Record<string, number>;
}

interface BrowserVersionAggregateRow {
  browser: string;
  version: string;
  views: number;
  sessions: number;
}

interface BrowserVersionSliceRow {
  key: string;
  label: string;
  views: number;
  sessions: number;
  isOther?: boolean;
  isUnknown?: boolean;
}

interface BrowserVersionBreakdownRow {
  browser: string;
  views: number;
  sessions: number;
  versions: BrowserVersionSliceRow[];
}

interface DimensionRow {
  value: string;
  views: number;
  sessions: number;
}

interface GeoTabRow {
  value: string;
  label: string;
  views: number;
  sessions: number;
  visitors: number;
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

interface GeoPointRow {
  latitude: number;
  longitude: number;
  timestampMs: number;
  country: string;
  region: string;
  regionCode: string;
  city: string;
}

interface GeoCountryCountRow {
  country: string;
  views: number;
  sessions: number;
  visitors: number;
}

interface GeoDimensionCountRow {
  value: string;
  label: string;
  views: number;
  sessions: number;
  visitors: number;
}

interface GeoPointAggregate {
  points: GeoPointRow[];
  countryCounts: GeoCountryCountRow[];
  regionCounts: GeoDimensionCountRow[];
  cityCounts: GeoDimensionCountRow[];
}

interface ClientDimensionTabs {
  browser: DimensionRow[];
  osVersion: DimensionRow[];
  deviceType: DimensionRow[];
  language: DimensionRow[];
  screenSize: DimensionRow[];
}

interface GeoDimensionTabs {
  country: GeoTabRow[];
  region: GeoTabRow[];
  city: GeoTabRow[];
  continent: GeoTabRow[];
  timezone: GeoTabRow[];
  organization: GeoTabRow[];
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

type FilterOptionKey = keyof DashboardFilters;

interface DashboardFilterOption {
  value: string;
  label: string;
  group?: "country" | "region" | "city";
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
  const geo =
    normalizeFilterValue(url.searchParams.get("geo")) ||
    normalizeFilterValue(url.searchParams.get("geoCountry")) ||
    normalizeFilterValue(url.searchParams.get("geoRegion")) ||
    normalizeFilterValue(url.searchParams.get("geoCity"));
  return {
    country: normalizeFilterValue(url.searchParams.get("country")),
    device: normalizeFilterValue(url.searchParams.get("device")),
    browser: normalizeFilterValue(url.searchParams.get("browser")),
    path: normalizeFilterValue(url.searchParams.get("path")),
    title: normalizeFilterValue(url.searchParams.get("title")),
    hostname: normalizeFilterValue(url.searchParams.get("hostname")),
    entry: normalizeFilterValue(url.searchParams.get("entry")),
    exit: normalizeFilterValue(url.searchParams.get("exit")),
    sourceDomain: normalizeFilterValue(url.searchParams.get("sourceDomain")),
    sourceLink: normalizeFilterValue(url.searchParams.get("sourceLink")),
    clientBrowser: normalizeFilterValue(url.searchParams.get("clientBrowser")),
    clientOsVersion: normalizeFilterValue(url.searchParams.get("clientOsVersion")),
    clientDeviceType: normalizeFilterValue(url.searchParams.get("clientDeviceType")),
    clientLanguage: normalizeFilterValue(url.searchParams.get("clientLanguage")),
    clientScreenSize: normalizeFilterValue(url.searchParams.get("clientScreenSize")),
    geo,
    geoContinent: normalizeFilterValue(url.searchParams.get("geoContinent")),
    geoTimezone: normalizeFilterValue(url.searchParams.get("geoTimezone")),
    geoOrganization: normalizeFilterValue(url.searchParams.get("geoOrganization")),
  };
}

function parseFilterOptionKey(url: URL): FilterOptionKey | null {
  const raw = normalizeFilterValue(url.searchParams.get("filterKey"));
  if (!raw) return null;
  const keys: FilterOptionKey[] = [
    "country",
    "device",
    "browser",
    "path",
    "title",
    "hostname",
    "entry",
    "exit",
    "sourceDomain",
    "sourceLink",
    "clientBrowser",
    "clientOsVersion",
    "clientDeviceType",
    "clientLanguage",
    "clientScreenSize",
    "geo",
    "geoContinent",
    "geoTimezone",
    "geoOrganization",
  ];
  return keys.includes(raw as FilterOptionKey)
    ? (raw as FilterOptionKey)
    : null;
}

function withoutFilterKey(
  filters: DashboardFilters,
  key: FilterOptionKey,
): DashboardFilters {
  const next = { ...filters };
  delete next[key];
  return next;
}

function sourceLabel(window: QueryWindow): "detail" | "archive" | "mixed" {
  const archiveCutoff = window.nowMs - RETENTION_DAYS * ONE_DAY_MS;
  if (window.toMs < archiveCutoff) return "archive";
  if (window.fromMs < archiveCutoff) return "mixed";
  return "detail";
}

function avgDuration(totalDuration: number, sessions: number): number {
  if (sessions <= 0) return 0;
  return Math.round(totalDuration / sessions);
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

const SHARE_TREND_OTHER_KEY = "other";
const SHARE_TREND_OTHER_LABEL = "Other";
const SHARE_TREND_OTHER_TOKEN = "__share_trend_other__";
const BROWSER_VERSION_UNKNOWN_TOKEN = "__browser_version_unknown__";

function shareTrendSeriesKey(
  label: string,
  usedKeys: Set<string>,
  fallbackBase: string,
): string {
  const normalized = label
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  const base = normalized || fallbackBase;
  let candidate = base;
  let suffix = 2;

  while (usedKeys.has(candidate)) {
    candidate = `${base}-${suffix}`;
    suffix += 1;
  }

  usedKeys.add(candidate);
  return candidate;
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

function osVersionExpr(alias = ""): string {
  const prefix = alias ? `${alias}.` : "";
  return `trim(CASE WHEN ${prefix}os != '' AND ${prefix}os_version != '' THEN ${prefix}os || ' ' || ${prefix}os_version WHEN ${prefix}os != '' THEN ${prefix}os WHEN ${prefix}os_version != '' THEN ${prefix}os_version ELSE '' END)`;
}

function browserMajorVersionExpr(alias = ""): string {
  const prefix = alias ? `${alias}.` : "";
  return `trim(CASE WHEN ${prefix}browser_version = '' THEN '' WHEN instr(${prefix}browser_version, '.') > 0 THEN substr(${prefix}browser_version, 1, instr(${prefix}browser_version, '.') - 1) ELSE ${prefix}browser_version END)`;
}

function screenSizeExpr(alias = ""): string {
  const prefix = alias ? `${alias}.` : "";
  return `CASE WHEN ${prefix}screen_width > 0 AND ${prefix}screen_height > 0 THEN CAST(${prefix}screen_width AS TEXT) || 'x' || CAST(${prefix}screen_height AS TEXT) ELSE '' END`;
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
    avgDurationMs: avgDuration(row.totalDuration, row.sessions),
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
    avgDurationMs: avgDuration(row.totalDuration, row.sessions),
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

function mapGeoTabs(rows: GeoTabRow[]) {
  return rows.map((row) => ({
    value: row.value,
    label: row.label,
    views: row.views,
    sessions: row.sessions,
    visitors: row.visitors,
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

function dedupeFilterOptions(
  options: DashboardFilterOption[],
): DashboardFilterOption[] {
  const seen = new Set<string>();
  const deduped: DashboardFilterOption[] = [];
  for (const option of options) {
    const value = String(option.value ?? "").trim();
    if (!value || seen.has(value)) continue;
    seen.add(value);
    deduped.push({
      value,
      label: String(option.label ?? value).trim() || value,
      ...(option.group ? { group: option.group } : {}),
    });
  }
  return deduped;
}

function mapDimensionRowsToFilterOptions(rows: DimensionRow[]): DashboardFilterOption[] {
  return dedupeFilterOptions(
    rows.map((row) => {
      const value = String(row.value ?? "").trim();
      return {
        value,
        label: value,
      };
    }),
  );
}

function mapReferrerRowsToFilterOptions(rows: ReferrerRow[]): DashboardFilterOption[] {
  return dedupeFilterOptions(
    rows.map((row) => {
      const value = String(row.referrer ?? "").trim();
      if (!value) {
        return {
          value: DIRECT_REFERRER_FILTER_VALUE,
          label: DIRECT_REFERRER_FILTER_VALUE,
        };
      }
      return {
        value,
        label: value,
      };
    }),
  );
}

function mapGeoRowsToFilterOptions(
  rows: DimensionRow[],
  group: "country" | "region" | "city",
): DashboardFilterOption[] {
  return dedupeFilterOptions(
    rows.map((row) => {
      const value = String(row.value ?? "").trim();
      if (!value) {
        return {
          value: "",
          label: "",
          group,
        };
      }
      const parsed = parseGeoFilterValue(value);
      if (group === "country") {
        return {
          value,
          label: parsed?.country || value,
          group,
        };
      }
      if (group === "region") {
        return {
          value,
          label: parsed?.regionName || parsed?.regionCode || parsed?.country || value,
          group,
        };
      }
      return {
        value,
        label:
          parsed?.city ||
          parsed?.regionName ||
          parsed?.regionCode ||
          parsed?.country ||
          value,
        group,
      };
    }),
  );
}

interface DimensionAccumulator {
  views: number;
  sessions: Set<string>;
}

interface GeoDimensionAccumulator extends DimensionAccumulator {
  visitors: Set<string>;
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

function addGeoDimensionValue(
  buckets: Map<string, GeoDimensionAccumulator>,
  rawValue: string,
  sessionId: string,
  visitorId: string,
): void {
  const value = rawValue.trim();
  if (!value) return;
  const bucket = buckets.get(value) ?? {
    views: 0,
    sessions: new Set<string>(),
    visitors: new Set<string>(),
  };
  bucket.views += 1;
  if (sessionId) bucket.sessions.add(sessionId);
  if (visitorId) bucket.visitors.add(visitorId);
  buckets.set(value, bucket);
}

function finalizeGeoDimensionBuckets(
  buckets: Map<string, GeoDimensionAccumulator>,
  limit: number,
  labelResolver?: (value: string) => string,
): GeoTabRow[] {
  return [...buckets.entries()]
    .map(([value, bucket]) => ({
      value,
      label: labelResolver ? labelResolver(value) : value,
      views: bucket.views,
      sessions: bucket.sessions.size,
      visitors: bucket.visitors.size,
    }))
    .sort((left, right) =>
      right.views - left.views ||
      right.sessions - left.sessions ||
      right.visitors - left.visitors ||
      left.label.localeCompare(right.label),
    )
    .slice(0, limit);
}

function geoTabLabel(value: string, tab: OverviewGeoTabKey): string {
  const parsed = parseGeoFilterValue(value);
  if (tab === "country") {
    return parsed?.country || value;
  }
  if (tab === "region") {
    return parsed?.regionName || parsed?.regionCode || parsed?.country || value;
  }
  if (tab === "city") {
    return (
      parsed?.city ||
      parsed?.regionName ||
      parsed?.regionCode ||
      parsed?.country ||
      value
    );
  }
  return value;
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
  event_id, site_id, visit_id, occurred_at, event_name, event_data_json, ae_synced_at
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

const DIRECT_REFERRER_FILTER_VALUE = "__direct__";

interface ParsedGeoFilter {
  country: string;
  regionCode?: string;
  regionName?: string;
  city?: string;
}

function parseGeoFilterValue(value: string | undefined): ParsedGeoFilter | null {
  const parsed = parseGeoLocationValue(value);
  if (!parsed) return null;

  return {
    country: parsed.countryCode,
    ...(parsed.regionCode ? { regionCode: parsed.regionCode } : {}),
    ...(parsed.regionName ? { regionName: parsed.regionName } : {}),
    ...(parsed.level === "locality" && parsed.localityName
      ? { city: parsed.localityName }
      : {}),
  };
}

function withoutGeoFilter(filters: DashboardFilters): DashboardFilters {
  return {
    ...filters,
    geo: undefined,
  };
}

function buildVisitFilterSql(filters: DashboardFilters, alias = ""): { clause: string; bindings: string[] } {
  const prefix = alias ? `${alias}.` : "";
  const clauses: string[] = [];
  const bindings: string[] = [];

  const equalsTrimmed = (column: string, value: string) => {
    clauses.push(`TRIM(COALESCE(${column}, '')) = ?`);
    bindings.push(value);
  };
  const equalsCaseInsensitive = (column: string, value: string) => {
    clauses.push(`LOWER(TRIM(COALESCE(${column}, ''))) = ?`);
    bindings.push(value.toLowerCase());
  };

  if (filters.country) {
    equalsCaseInsensitive(`${prefix}country`, filters.country);
  }
  if (filters.device) {
    equalsTrimmed(`${prefix}device_type`, filters.device);
  }
  if (filters.browser) {
    equalsTrimmed(`${prefix}browser`, filters.browser);
  }
  if (filters.path) {
    equalsTrimmed(`${prefix}pathname`, filters.path);
  }
  if (filters.title) {
    equalsTrimmed(`${prefix}title`, filters.title);
  }
  if (filters.hostname) {
    equalsCaseInsensitive(`${prefix}hostname`, filters.hostname);
  }
  if (filters.entry) {
    clauses.push(`TRIM(COALESCE(${prefix}session_id, '')) != ''`);
    clauses.push(
      `COALESCE((SELECT edge.pathname FROM visit_source edge WHERE edge.session_id = ${prefix}session_id ORDER BY edge.started_at ASC, edge.visit_id ASC LIMIT 1), '') = ?`,
    );
    bindings.push(filters.entry);
  }
  if (filters.exit) {
    clauses.push(`TRIM(COALESCE(${prefix}session_id, '')) != ''`);
    clauses.push(
      `COALESCE((SELECT edge.pathname FROM visit_source edge WHERE edge.session_id = ${prefix}session_id ORDER BY edge.started_at DESC, edge.visit_id DESC LIMIT 1), '') = ?`,
    );
    bindings.push(filters.exit);
  }
  if (filters.sourceDomain) {
    if (filters.sourceDomain === DIRECT_REFERRER_FILTER_VALUE) {
      clauses.push(`TRIM(COALESCE(${prefix}referrer_host, '')) = ''`);
    } else {
      equalsCaseInsensitive(`${prefix}referrer_host`, filters.sourceDomain);
    }
  }
  if (filters.sourceLink) {
    if (filters.sourceLink === DIRECT_REFERRER_FILTER_VALUE) {
      clauses.push(`TRIM(COALESCE(${prefix}referrer_url, '')) = ''`);
    } else {
      equalsCaseInsensitive(`${prefix}referrer_url`, filters.sourceLink);
    }
  }
  if (filters.clientBrowser) {
    equalsTrimmed(`${prefix}browser`, filters.clientBrowser);
  }
  if (filters.clientOsVersion) {
    equalsTrimmed(osVersionExpr(alias), filters.clientOsVersion);
  }
  if (filters.clientDeviceType) {
    equalsTrimmed(`${prefix}device_type`, filters.clientDeviceType);
  }
  if (filters.clientLanguage) {
    equalsTrimmed(`${prefix}language`, filters.clientLanguage);
  }
  if (filters.clientScreenSize) {
    equalsTrimmed(screenSizeExpr(alias), filters.clientScreenSize);
  }
  if (filters.geoContinent) {
    equalsTrimmed(`${prefix}continent`, filters.geoContinent);
  }
  if (filters.geoTimezone) {
    equalsTrimmed(`${prefix}timezone`, filters.geoTimezone);
  }
  if (filters.geoOrganization) {
    equalsTrimmed(`${prefix}as_organization`, filters.geoOrganization);
  }

  const parsedGeo = parseGeoFilterValue(filters.geo);
  if (parsedGeo?.country) {
    equalsCaseInsensitive(`${prefix}country`, parsedGeo.country);
  }
  if (parsedGeo?.regionCode || parsedGeo?.regionName) {
    const geoRegionTokens = Array.from(
      new Set(
        [parsedGeo.regionCode, parsedGeo.regionName]
          .map((value) => String(value ?? "").trim().toUpperCase())
          .filter((value) => value.length > 0),
      ),
    );
    if (geoRegionTokens.length > 0) {
      clauses.push(
        `UPPER(TRIM(CASE WHEN TRIM(COALESCE(${prefix}region_code, '')) != '' THEN ${prefix}region_code ELSE ${prefix}region END)) IN (${geoRegionTokens.map(() => "?").join(", ")})`,
      );
      bindings.push(...geoRegionTokens);
    }
  }
  if (parsedGeo?.city) {
    equalsCaseInsensitive(`${prefix}city`, parsedGeo.city);
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

async function queryBrowserTrendFromD1(
  env: Env,
  siteId: string,
  window: QueryWindow,
  interval: Interval,
  filters: DashboardFilters,
  limit: number,
): Promise<{
  series: BrowserTrendSeriesRow[];
  data: BrowserTrendPointRow[];
}> {
  return queryShareTrendFromD1(
    env,
    siteId,
    window,
    interval,
    filters,
    limit,
    "TRIM(COALESCE(browser, ''))",
    "browser",
  );
}

async function queryBrowserEngineTrendFromD1(
  env: Env,
  siteId: string,
  window: QueryWindow,
  interval: Interval,
  filters: DashboardFilters,
  limit: number,
): Promise<{
  series: BrowserTrendSeriesRow[];
  data: BrowserTrendPointRow[];
}> {
  return queryShareTrendFromD1(
    env,
    siteId,
    window,
    interval,
    filters,
    limit,
    browserEngineCaseSql("browser", "os"),
    "engine",
  );
}

async function queryBrowserVersionBreakdownFromD1(
  env: Env,
  siteId: string,
  window: QueryWindow,
  filters: DashboardFilters,
  browserLimit: number,
  versionLimit: number,
): Promise<BrowserVersionBreakdownRow[]> {
  const filter = buildVisitFilterSql(filters);
  const normalizedBrowserLimit = Number.isFinite(browserLimit) && browserLimit > 0
    ? Math.max(1, Math.floor(browserLimit))
    : null;
  const normalizedVersionLimit = Math.min(Math.max(1, versionLimit), 8);
  const topBrowsersSql = `
WITH
${buildVisitSourceCte()},
filtered_visits AS (
  SELECT
    TRIM(COALESCE(browser, '')) AS browser,
    session_id AS sessionId
  FROM visit_source
  ${filter.clause}
)
SELECT
  browser,
  count(*) AS views,
  count(DISTINCT CASE WHEN sessionId != '' THEN sessionId ELSE NULL END) AS sessions
FROM filtered_visits
WHERE browser != ''
GROUP BY browser
ORDER BY views DESC, sessions DESC, browser ASC
${normalizedBrowserLimit ? "LIMIT ?" : ""}
`;
  const topBrowsers = (await queryD1All<Record<string, unknown>>(
    env,
    topBrowsersSql,
    [
      ...visitSourceBindings(siteId, window),
      ...filter.bindings,
      ...(normalizedBrowserLimit ? [normalizedBrowserLimit] : []),
    ],
  )).map((row) => ({
    browser: String(row.browser ?? "").trim(),
    views: Number(row.views ?? 0),
    sessions: Number(row.sessions ?? 0),
  })).filter((row) => row.browser.length > 0 && row.views > 0);

  if (topBrowsers.length === 0) {
    return [];
  }

  const topBrowserLabels = topBrowsers.map((row) => row.browser);
  const topBrowserPlaceholders = topBrowserLabels.map(() => "?").join(", ");
  const versionsSql = `
WITH
${buildVisitSourceCte()},
filtered_visits AS (
  SELECT
    TRIM(COALESCE(browser, '')) AS browser,
    ${browserMajorVersionExpr()} AS browserVersion,
    session_id AS sessionId
  FROM visit_source
  ${filter.clause}
)
SELECT
  browser,
  CASE
    WHEN browserVersion != '' THEN browserVersion
    ELSE '${BROWSER_VERSION_UNKNOWN_TOKEN}'
  END AS version,
  count(*) AS views,
  count(DISTINCT CASE WHEN sessionId != '' THEN sessionId ELSE NULL END) AS sessions
FROM filtered_visits
WHERE browser != '' AND browser IN (${topBrowserPlaceholders})
GROUP BY browser, version
ORDER BY browser ASC, views DESC, sessions DESC, version ASC
`;
  const versionRows = (await queryD1All<Record<string, unknown>>(
    env,
    versionsSql,
    [...visitSourceBindings(siteId, window), ...filter.bindings, ...topBrowserLabels],
  )).map((row) => ({
    browser: String(row.browser ?? "").trim(),
    version: String(row.version ?? "").trim(),
    views: Number(row.views ?? 0),
    sessions: Number(row.sessions ?? 0),
  } satisfies BrowserVersionAggregateRow)).filter((row) =>
    row.browser.length > 0 && row.views > 0
  );

  const versionsByBrowser = new Map<string, BrowserVersionAggregateRow[]>();
  for (const row of versionRows) {
    const bucket = versionsByBrowser.get(row.browser) ?? [];
    bucket.push(row);
    versionsByBrowser.set(row.browser, bucket);
  }

  return topBrowsers.map((browserRow) => {
    const rows = versionsByBrowser.get(browserRow.browser) ?? [];
    const usedKeys = new Set<string>(["other", "unknown"]);
    const versions: BrowserVersionSliceRow[] = [];
    let otherViews = 0;
    let otherSessions = 0;

    for (let index = 0; index < rows.length; index += 1) {
      const row = rows[index];
      if (index < normalizedVersionLimit) {
        if (row.version === BROWSER_VERSION_UNKNOWN_TOKEN) {
          versions.push({
            key: "unknown",
            label: "Unknown",
            views: row.views,
            sessions: row.sessions,
            isUnknown: true,
          });
        } else {
          versions.push({
            key: shareTrendSeriesKey(row.version, usedKeys, "version"),
            label: row.version,
            views: row.views,
            sessions: row.sessions,
          });
        }
        continue;
      }

      otherViews += row.views;
      otherSessions += row.sessions;
    }

    if (otherViews > 0) {
      versions.push({
        key: "other",
        label: SHARE_TREND_OTHER_LABEL,
        views: otherViews,
        sessions: otherSessions,
        isOther: true,
      });
    }

    return {
      browser: browserRow.browser,
      views: browserRow.views,
      sessions: browserRow.sessions,
      versions,
    };
  });
}

async function queryShareTrendFromD1(
  env: Env,
  siteId: string,
  window: QueryWindow,
  interval: Interval,
  filters: DashboardFilters,
  limit: number,
  labelExpr: string,
  fallbackKeyBase: string,
): Promise<{
  series: BrowserTrendSeriesRow[];
  data: BrowserTrendPointRow[];
}> {
  const filter = buildVisitFilterSql(filters);
  const bucketDivisor = intervalBucketMs(interval);
  const normalizedLimit = Math.min(Math.max(1, limit), 8);
  const topSql = `
WITH
${buildVisitSourceCte()},
filtered_visits AS (
  SELECT
    ${labelExpr} AS labelValue,
    session_id AS sessionId
  FROM visit_source
  ${filter.clause}
)
SELECT
  labelValue AS label,
  count(*) AS views,
  count(DISTINCT CASE WHEN sessionId != '' THEN sessionId ELSE NULL END) AS sessions
FROM filtered_visits
WHERE labelValue != ''
GROUP BY labelValue
ORDER BY views DESC, sessions DESC, label ASC
LIMIT ?
`;
  const topRows = (await queryD1All<Record<string, unknown>>(
    env,
    topSql,
    [...visitSourceBindings(siteId, window), ...filter.bindings, normalizedLimit],
  )).map((row) => ({
    label: String(row.label ?? "").trim(),
    views: Number(row.views ?? 0),
    sessions: Number(row.sessions ?? 0),
  })).filter((row) => row.label.length > 0 && row.views > 0);

  const topLabels = topRows.map((row) => row.label);
  const topLabelPlaceholders = topLabels.map(() => "?").join(", ");
  const seriesCaseExpr = topLabels.length > 0
    ? `CASE WHEN labelValue != '' AND labelValue IN (${topLabelPlaceholders}) THEN labelValue ELSE '${SHARE_TREND_OTHER_TOKEN}' END`
    : `'${SHARE_TREND_OTHER_TOKEN}'`;

  const seriesSql = `
WITH
${buildVisitSourceCte()},
filtered_visits AS (
  SELECT
    ${labelExpr} AS labelValue,
    session_id AS sessionId
  FROM visit_source
  ${filter.clause}
)
SELECT
  ${seriesCaseExpr} AS label,
  count(*) AS views,
  count(DISTINCT CASE WHEN sessionId != '' THEN sessionId ELSE NULL END) AS sessions
FROM filtered_visits
GROUP BY label
ORDER BY views DESC, sessions DESC, label ASC
`;
  const seriesRows = (await queryD1All<Record<string, unknown>>(
    env,
    seriesSql,
    [...visitSourceBindings(siteId, window), ...filter.bindings, ...topLabels],
  )).map((row) => ({
    label: String(row.label ?? "").trim(),
    views: Number(row.views ?? 0),
    sessions: Number(row.sessions ?? 0),
  })).filter((row) => row.label.length > 0 && row.views > 0);

  if (seriesRows.length === 0) {
    return {
      series: [],
      data: [],
    };
  }

  const bucketSql = `
WITH
${buildVisitSourceCte()},
filtered_visits AS (
  SELECT
    CAST(started_at / ${bucketDivisor} AS INTEGER) AS bucket,
    ${labelExpr} AS labelValue,
    session_id AS sessionId
  FROM visit_source
  ${filter.clause}
)
SELECT
  bucket,
  ${seriesCaseExpr} AS label,
  count(*) AS views,
  count(DISTINCT CASE WHEN sessionId != '' THEN sessionId ELSE NULL END) AS sessions
FROM filtered_visits
GROUP BY bucket, label
ORDER BY bucket ASC, label ASC
`;
  const bucketRows = (await queryD1All<Record<string, unknown>>(
    env,
    bucketSql,
    [...visitSourceBindings(siteId, window), ...filter.bindings, ...topLabels],
  )).map((row) => ({
    bucket: Number(row.bucket ?? 0),
    label: String(row.label ?? "").trim(),
    views: Number(row.views ?? 0),
    sessions: Number(row.sessions ?? 0),
  } satisfies BrowserTrendBucketRow));

  const seriesByLabel = new Map(
    seriesRows.map((row) => [row.label, row] as const),
  );
  const usedKeys = new Set<string>([SHARE_TREND_OTHER_KEY]);
  const series: BrowserTrendSeriesRow[] = [];
  const keyByLabel = new Map<string, string>();

  for (const label of topLabels) {
    const row = seriesByLabel.get(label);
    if (!row || row.views <= 0) continue;
    const key = shareTrendSeriesKey(label, usedKeys, fallbackKeyBase);
    keyByLabel.set(label, key);
    series.push({
      key,
      label,
      views: row.views,
      sessions: row.sessions,
    });
  }

  const otherRow = seriesByLabel.get(SHARE_TREND_OTHER_TOKEN);
  if (otherRow && otherRow.views > 0) {
    keyByLabel.set(SHARE_TREND_OTHER_TOKEN, SHARE_TREND_OTHER_KEY);
    series.push({
      key: SHARE_TREND_OTHER_KEY,
      label: SHARE_TREND_OTHER_LABEL,
      views: otherRow.views,
      sessions: otherRow.sessions,
      isOther: true,
    });
  }

  if (series.length === 0) {
    return {
      series: [],
      data: [],
    };
  }

  const createEmptyPoint = (bucket: number): BrowserTrendPointRow => ({
    bucket,
    timestampMs: bucket * bucketDivisor,
    totalViews: 0,
    totalSessions: 0,
    viewsBySeries: Object.fromEntries(series.map((item) => [item.key, 0])),
    sessionsBySeries: Object.fromEntries(series.map((item) => [item.key, 0])),
  });

  const pointsByBucket = new Map<number, BrowserTrendPointRow>();
  for (const row of bucketRows) {
    const key = keyByLabel.get(row.label);
    if (!key) continue;
    const point = pointsByBucket.get(row.bucket) ?? createEmptyPoint(row.bucket);
    point.viewsBySeries[key] = row.views;
    point.sessionsBySeries[key] = row.sessions;
    point.totalViews += row.views;
    point.totalSessions += row.sessions;
    pointsByBucket.set(row.bucket, point);
  }

  const fromBucket = Math.floor(window.fromMs / bucketDivisor);
  const toBucket = Math.max(fromBucket, Math.floor(window.toMs / bucketDivisor));
  const data: BrowserTrendPointRow[] = [];
  for (let bucket = fromBucket; bucket <= toBucket; bucket += 1) {
    data.push(pointsByBucket.get(bucket) ?? createEmptyPoint(bucket));
  }

  return {
    series,
    data,
  };
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

async function queryGeoPointAggregate(
  env: Env,
  siteId: string,
  window: QueryWindow,
  filters: DashboardFilters,
  limit: number,
): Promise<GeoPointAggregate> {
  return queryGeoPointsFromD1(env, siteId, window, filters, limit);
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

async function handleBrowserTrend(
  env: Env,
  siteId: string,
  url: URL,
): Promise<Response> {
  const window = parseWindow(url);
  if (!window) return badRequest("Invalid time window");
  const filters = parseFilters(url);
  const interval = parseInterval(url);
  const limit = parseLimit(url, 5, 8);
  const trend = await queryBrowserTrendFromD1(
    env,
    siteId,
    window,
    interval,
    filters,
    limit,
  );
  return jsonResponse({
    ok: true,
    interval,
    series: trend.series,
    data: trend.data,
  });
}

async function handleBrowserEngineTrend(
  env: Env,
  siteId: string,
  url: URL,
): Promise<Response> {
  const window = parseWindow(url);
  if (!window) return badRequest("Invalid time window");
  const filters = parseFilters(url);
  const interval = parseInterval(url);
  const limit = parseLimit(url, 5, 8);
  const trend = await queryBrowserEngineTrendFromD1(
    env,
    siteId,
    window,
    interval,
    filters,
    limit,
  );
  return jsonResponse({
    ok: true,
    interval,
    series: trend.series,
    data: trend.data,
  });
}

async function handleBrowserVersionBreakdown(
  env: Env,
  siteId: string,
  url: URL,
): Promise<Response> {
  const window = parseWindow(url);
  if (!window) return badRequest("Invalid time window");
  const filters = parseFilters(url);
  const rawBrowserLimit = coerceNumber(url.searchParams.get("browserLimit"), 0);
  const browserLimit = Number.isFinite(rawBrowserLimit ?? NaN) && (rawBrowserLimit ?? 0) > 0
    ? Math.max(1, Math.floor(rawBrowserLimit ?? 0))
    : 0;
  const versionLimit = Math.min(
    8,
    Math.max(
      1,
      Math.floor(coerceNumber(url.searchParams.get("versionLimit"), 5) ?? 5),
    ),
  );
  const data = await queryBrowserVersionBreakdownFromD1(
    env,
    siteId,
    window,
    filters,
    browserLimit,
    versionLimit,
  );
  return jsonResponse({
    ok: true,
    data,
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
  options?: {
    ignoreGeo?: boolean;
  },
): Promise<Response> {
  const window = parseWindow(url);
  if (!window) return badRequest("Invalid time window");
  const rawFilters = parseFilters(url);
  const filters = options?.ignoreGeo ? withoutGeoFilter(rawFilters) : rawFilters;
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

type OverviewPageTabKey = "path" | "title" | "hostname" | "entry" | "exit";
type OverviewSourceTabKey = "domain" | "link";
type OverviewClientTabKey =
  | "browser"
  | "osVersion"
  | "deviceType"
  | "language"
  | "screenSize";
type OverviewGeoTabKey =
  | "country"
  | "region"
  | "city"
  | "continent"
  | "timezone"
  | "organization";

async function handleOverviewPageTab(
  env: Env,
  siteId: string,
  url: URL,
  tab: OverviewPageTabKey,
): Promise<Response> {
  const window = parseWindow(url);
  if (!window) return badRequest("Invalid time window");
  const filters = parseFilters(url);
  const limit = parseLimit(url, 100, 200);
  const tabs = await queryPageTabsAggregate(env, siteId, window, filters, limit);
  return jsonResponse({
    ok: true,
    data: mapTabs(tabs[tab]),
  });
}

async function handleOverviewSourceTab(
  env: Env,
  siteId: string,
  url: URL,
  tab: OverviewSourceTabKey,
): Promise<Response> {
  const window = parseWindow(url);
  if (!window) return badRequest("Invalid time window");
  const filters = parseFilters(url);
  const limit = parseLimit(url, 100, 200);
  const rows = await queryReferrerAggregate(
    env,
    siteId,
    window,
    filters,
    limit,
    tab === "link",
  );
  return jsonResponse({
    ok: true,
    data: rows.map((row) => ({
      label: row.referrer,
      views: row.views,
      sessions: row.sessions,
    })),
  });
}

async function handleOverviewClientTab(
  env: Env,
  siteId: string,
  url: URL,
  tab: OverviewClientTabKey,
): Promise<Response> {
  const window = parseWindow(url);
  if (!window) return badRequest("Invalid time window");
  const filters = parseFilters(url);
  const limit = parseLimit(url, 100, 200);
  const tabs = await buildOverviewClientDimensionTabs(
    env,
    siteId,
    window,
    filters,
    limit,
  );
  return jsonResponse({
    ok: true,
    data: mapTabs(tabs[tab]),
  });
}

async function handleOverviewGeoTab(
  env: Env,
  siteId: string,
  url: URL,
  tab: OverviewGeoTabKey,
): Promise<Response> {
  const window = parseWindow(url);
  if (!window) return badRequest("Invalid time window");
  const rawFilters = parseFilters(url);
  const filters = tab === "country" ? withoutGeoFilter(rawFilters) : rawFilters;
  const limit = parseLimit(url, 100, 200);
  const tabs = await buildOverviewGeoDimensionTabs(
    env,
    siteId,
    window,
    filters,
    limit,
  );
  return jsonResponse({
    ok: true,
    data: mapGeoTabs(tabs[tab]),
  });
}

async function handleFilterOptions(
  env: Env,
  siteId: string,
  url: URL,
): Promise<Response> {
  const filterKey = parseFilterOptionKey(url);
  if (!filterKey) return badRequest("Invalid filter key");
  const window = parseWindow(url);
  if (!window) return badRequest("Invalid time window");
  const filters = withoutFilterKey(parseFilters(url), filterKey);
  const limit = parseLimit(url, 200, 500);

  let data: DashboardFilterOption[] = [];

  if (filterKey === "country") {
    const rows = await queryDimensionAggregate(
      env,
      siteId,
      window,
      filters,
      limit,
      "country",
    );
    data = mapDimensionRowsToFilterOptions(rows);
  } else if (filterKey === "device") {
    const rows = await queryDimensionAggregate(
      env,
      siteId,
      window,
      filters,
      limit,
      "device_type",
    );
    data = mapDimensionRowsToFilterOptions(rows);
  } else if (filterKey === "browser") {
    const rows = await queryDimensionAggregate(
      env,
      siteId,
      window,
      filters,
      limit,
      "browser",
    );
    data = mapDimensionRowsToFilterOptions(rows);
  } else if (
    filterKey === "path" ||
    filterKey === "title" ||
    filterKey === "hostname" ||
    filterKey === "entry" ||
    filterKey === "exit"
  ) {
    const tabs = await queryPageTabsAggregate(env, siteId, window, filters, limit);
    data = mapDimensionRowsToFilterOptions(tabs[filterKey]);
  } else if (filterKey === "sourceDomain" || filterKey === "sourceLink") {
    const rows = await queryReferrerAggregate(
      env,
      siteId,
      window,
      filters,
      limit,
      filterKey === "sourceLink",
    );
    data = mapReferrerRowsToFilterOptions(rows);
  } else if (
    filterKey === "clientBrowser" ||
    filterKey === "clientOsVersion" ||
    filterKey === "clientDeviceType" ||
    filterKey === "clientLanguage" ||
    filterKey === "clientScreenSize"
  ) {
    const tabs = await buildOverviewClientDimensionTabs(
      env,
      siteId,
      window,
      filters,
      limit,
    );
    const keyMap = {
      clientBrowser: "browser",
      clientOsVersion: "osVersion",
      clientDeviceType: "deviceType",
      clientLanguage: "language",
      clientScreenSize: "screenSize",
    } as const;
    data = mapDimensionRowsToFilterOptions(tabs[keyMap[filterKey]]);
  } else if (filterKey === "geo") {
    const tabs = await buildOverviewGeoDimensionTabs(
      env,
      siteId,
      window,
      filters,
      limit,
    );
    data = dedupeFilterOptions([
      ...mapGeoRowsToFilterOptions(tabs.country, "country"),
      ...mapGeoRowsToFilterOptions(tabs.region, "region"),
      ...mapGeoRowsToFilterOptions(tabs.city, "city"),
    ]);
  } else if (
    filterKey === "geoContinent" ||
    filterKey === "geoTimezone" ||
    filterKey === "geoOrganization"
  ) {
    const tabs = await buildOverviewGeoDimensionTabs(
      env,
      siteId,
      window,
      filters,
      limit,
    );
    const keyMap = {
      geoContinent: "continent",
      geoTimezone: "timezone",
      geoOrganization: "organization",
    } as const;
    data = mapDimensionRowsToFilterOptions(tabs[keyMap[filterKey]]);
  }

  return jsonResponse({ ok: true, data });
}

async function handleOverviewGeoPoints(
  env: Env,
  siteId: string,
  url: URL,
): Promise<Response> {
  const window = parseWindow(url);
  if (!window) return badRequest("Invalid time window");
  const filters = parseBooleanSearchParam(url, "applyGeoFilter")
    ? parseFilters(url)
    : withoutGeoFilter(parseFilters(url));
  const limit = parseLimit(url, 5000, 20000);
  const aggregate = await queryGeoPointAggregate(
    env,
    siteId,
    window,
    filters,
    limit,
  );
  return jsonResponse({
    ok: true,
    data: aggregate.points,
    countryCounts: aggregate.countryCounts,
    regionCounts: aggregate.regionCounts,
    cityCounts: aggregate.cityCounts,
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
  if (pathname === "browser-trend") return handleBrowserTrend(env, siteId, url);
  if (pathname === "browser-engine-trend") {
    return handleBrowserEngineTrend(env, siteId, url);
  }
  if (pathname === "browser-version-breakdown") {
    return handleBrowserVersionBreakdown(env, siteId, url);
  }
  if (pathname === "visitors") return handleVisitors(env, siteId, url);
  if (pathname === "countries") {
    return handleDimension(env, siteId, url, "country", { ignoreGeo: true });
  }
  if (pathname === "devices") {
    return handleDimension(env, siteId, url, "device_type");
  }
  if (pathname === "event-types") return handleEventTypes(env, siteId, url);
  if (pathname === "filter-options") return handleFilterOptions(env, siteId, url);
  if (pathname === "overview-page-path") {
    return handleOverviewPageTab(env, siteId, url, "path");
  }
  if (pathname === "overview-page-title") {
    return handleOverviewPageTab(env, siteId, url, "title");
  }
  if (pathname === "overview-page-hostname") {
    return handleOverviewPageTab(env, siteId, url, "hostname");
  }
  if (pathname === "overview-page-entry") {
    return handleOverviewPageTab(env, siteId, url, "entry");
  }
  if (pathname === "overview-page-exit") {
    return handleOverviewPageTab(env, siteId, url, "exit");
  }
  if (pathname === "overview-source-domain") {
    return handleOverviewSourceTab(env, siteId, url, "domain");
  }
  if (pathname === "overview-source-link") {
    return handleOverviewSourceTab(env, siteId, url, "link");
  }
  if (pathname === "overview-client-browser") {
    return handleOverviewClientTab(env, siteId, url, "browser");
  }
  if (pathname === "overview-client-os-version") {
    return handleOverviewClientTab(env, siteId, url, "osVersion");
  }
  if (pathname === "overview-client-device-type") {
    return handleOverviewClientTab(env, siteId, url, "deviceType");
  }
  if (pathname === "overview-client-language") {
    return handleOverviewClientTab(env, siteId, url, "language");
  }
  if (pathname === "overview-client-screen-size") {
    return handleOverviewClientTab(env, siteId, url, "screenSize");
  }
  if (pathname === "overview-geo-country") {
    return handleOverviewGeoTab(env, siteId, url, "country");
  }
  if (pathname === "overview-geo-region") {
    return handleOverviewGeoTab(env, siteId, url, "region");
  }
  if (pathname === "overview-geo-city") {
    return handleOverviewGeoTab(env, siteId, url, "city");
  }
  if (pathname === "overview-geo-continent") {
    return handleOverviewGeoTab(env, siteId, url, "continent");
  }
  if (pathname === "overview-geo-timezone") {
    return handleOverviewGeoTab(env, siteId, url, "timezone");
  }
  if (pathname === "overview-geo-organization") {
    return handleOverviewGeoTab(env, siteId, url, "organization");
  }
  if (pathname === "overview-geo-points") {
    return handleOverviewGeoPoints(env, siteId, url);
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

async function queryGeoPointsFromD1(
  env: Env,
  siteId: string,
  window: QueryWindow,
  filters: DashboardFilters,
  limit: number,
): Promise<GeoPointAggregate> {
  const filter = buildVisitFilterSql(filters);
  const parsedGeo = parseGeoFilterValue(filters.geo);
  const pointsSql = `
WITH
${buildVisitSourceCte()},
filtered_visits AS (
  SELECT *
  FROM visit_source
  ${filter.clause}
)
SELECT
  latitude,
  longitude,
  started_at AS timestampMs,
  country,
  region,
  region_code AS regionCode,
  city
FROM filtered_visits
WHERE
  latitude IS NOT NULL
  AND longitude IS NOT NULL
  AND ABS(latitude) <= 90
  AND ABS(longitude) <= 180
ORDER BY timestampMs DESC
LIMIT ?
`;
  const points = (await queryD1All<Record<string, unknown>>(
    env,
    pointsSql,
    [...visitSourceBindings(siteId, window), ...filter.bindings, limit],
  )).map((row) => ({
    latitude: Number(row.latitude ?? 0),
    longitude: Number(row.longitude ?? 0),
    timestampMs: Number(row.timestampMs ?? 0),
    country: String(row.country ?? ""),
    region: String(row.region ?? ""),
    regionCode: String(row.regionCode ?? ""),
    city: String(row.city ?? ""),
  }));

  const countryCounts: GeoCountryCountRow[] = [];
  const regionCounts: GeoDimensionCountRow[] = [];
  const cityCounts: GeoDimensionCountRow[] = [];

  if (!parsedGeo?.country) {
    const countrySql = `
WITH
${buildVisitSourceCte()},
filtered_visits AS (
  SELECT
    country,
    session_id AS sessionId,
    visitor_id AS visitorId
  FROM visit_source
  ${filter.clause}
)
SELECT
  country,
  count(*) AS views,
  count(DISTINCT CASE WHEN sessionId != '' THEN sessionId ELSE NULL END) AS sessions,
  count(DISTINCT CASE WHEN visitorId != '' THEN visitorId ELSE NULL END) AS visitors
FROM filtered_visits
GROUP BY country
ORDER BY views DESC, sessions DESC, country ASC
LIMIT 300
`;
    countryCounts.push(
      ...(await queryD1All<Record<string, unknown>>(
        env,
        countrySql,
        [...visitSourceBindings(siteId, window), ...filter.bindings],
      )).map((row) => ({
        country: String(row.country ?? ""),
        views: Number(row.views ?? 0),
        sessions: Number(row.sessions ?? 0),
        visitors: Number(row.visitors ?? 0),
      })),
    );
  } else if (!parsedGeo.regionCode && !parsedGeo.regionName) {
    const regionSql = `
WITH
${buildVisitSourceCte()},
filtered_visits AS (
  SELECT
    country,
    region,
    region_code AS regionCode,
    session_id AS sessionId,
    visitor_id AS visitorId
  FROM visit_source
  ${filter.clause}
)
SELECT
  country,
  regionCode,
  region,
  count(*) AS views,
  count(DISTINCT CASE WHEN sessionId != '' THEN sessionId ELSE NULL END) AS sessions,
  count(DISTINCT CASE WHEN visitorId != '' THEN visitorId ELSE NULL END) AS visitors
FROM filtered_visits
WHERE
  TRIM(COALESCE(country, '')) != ''
  AND (
    TRIM(COALESCE(regionCode, '')) != ''
    OR TRIM(COALESCE(region, '')) != ''
  )
GROUP BY country, regionCode, region
ORDER BY views DESC, sessions DESC, region ASC, regionCode ASC
LIMIT 400
`;
    regionCounts.push(
      ...(await queryD1All<Record<string, unknown>>(
        env,
        regionSql,
        [...visitSourceBindings(siteId, window), ...filter.bindings],
      ))
        .map((row) => {
          const country = String(row.country ?? "").trim().toUpperCase();
          const regionCode = String(row.regionCode ?? "").trim().toUpperCase();
          const regionName = String(row.region ?? "").trim() || regionCode;
          const value = buildRegionLocationValue(
            country,
            regionCode || regionName,
            regionName || regionCode,
          );
          if (!value) return null;
          return {
            value,
            label: regionName || regionCode,
            views: Number(row.views ?? 0),
            sessions: Number(row.sessions ?? 0),
            visitors: Number(row.visitors ?? 0),
          };
        })
        .filter((row): row is GeoDimensionCountRow => Boolean(row)),
    );
  } else {
    const citySql = `
WITH
${buildVisitSourceCte()},
filtered_visits AS (
  SELECT
    country,
    region,
    region_code AS regionCode,
    city,
    session_id AS sessionId,
    visitor_id AS visitorId
  FROM visit_source
  ${filter.clause}
)
SELECT
  country,
  regionCode,
  region,
  city,
  count(*) AS views,
  count(DISTINCT CASE WHEN sessionId != '' THEN sessionId ELSE NULL END) AS sessions,
  count(DISTINCT CASE WHEN visitorId != '' THEN visitorId ELSE NULL END) AS visitors
FROM filtered_visits
WHERE
  TRIM(COALESCE(country, '')) != ''
  AND TRIM(COALESCE(city, '')) != ''
GROUP BY country, regionCode, region, city
ORDER BY views DESC, sessions DESC, city ASC
LIMIT 600
`;
    cityCounts.push(
      ...(await queryD1All<Record<string, unknown>>(
        env,
        citySql,
        [...visitSourceBindings(siteId, window), ...filter.bindings],
      ))
        .map((row) => {
          const country = String(row.country ?? "").trim().toUpperCase();
          const regionCode = String(row.regionCode ?? "").trim().toUpperCase();
          const regionName = String(row.region ?? "").trim() || regionCode;
          const city = String(row.city ?? "").trim();
          const value = buildLocalityLocationValue(
            country,
            regionCode || null,
            regionName || null,
            city,
          );
          if (!value || !city) return null;
          return {
            value,
            label: city,
            views: Number(row.views ?? 0),
            sessions: Number(row.sessions ?? 0),
            visitors: Number(row.visitors ?? 0),
          };
        })
        .filter((row): row is GeoDimensionCountRow => Boolean(row)),
    );
  }

  return {
    points,
    countryCounts,
    regionCounts,
    cityCounts,
  };
}

async function queryCustomEventNamesFromD1(
  env: Env,
  siteId: string,
  window: QueryWindow,
  filters: DashboardFilters,
  limit: number,
): Promise<DimensionRow[]> {
  const filter = buildVisitFilterSql(filters, "vc");
  const sql = `
WITH
${buildVisitSourceCte()},
${buildCustomEventSourceCte()},
event_with_context AS (
  SELECT
    e.event_id,
    e.event_name,
    COALESCE(vs.session_id, '') AS session_id,
    COALESCE(vs.country, '') AS country,
    COALESCE(vs.region, '') AS region,
    COALESCE(vs.region_code, '') AS region_code,
    COALESCE(vs.city, '') AS city,
    COALESCE(vs.pathname, '') AS pathname,
    COALESCE(vs.title, '') AS title,
    COALESCE(vs.hostname, '') AS hostname,
    COALESCE(vs.referrer_host, '') AS referrer_host,
    COALESCE(vs.referrer_url, '') AS referrer_url,
    COALESCE(vs.device_type, '') AS device_type,
    COALESCE(vs.browser, '') AS browser,
    COALESCE(vs.os, '') AS os,
    COALESCE(vs.os_version, '') AS os_version,
    COALESCE(vs.language, '') AS language,
    COALESCE(vs.screen_width, 0) AS screen_width,
    COALESCE(vs.screen_height, 0) AS screen_height
  FROM event_source e
  LEFT JOIN visit_source vs
    ON vs.site_id = e.site_id
   AND vs.visit_id = e.visit_id
),
filtered_events AS (
  SELECT *
  FROM event_with_context vc
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
    [...visitSourceBindings(siteId, window), ...eventSourceBindings(siteId, window), ...filter.bindings, limit],
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
  const rows = await queryD1All<Record<string, unknown>>(
    env,
    sql,
    [...visitSourceBindings(siteId, window), ...filter.bindings],
  );

  const country = new Map<string, GeoDimensionAccumulator>();
  const region = new Map<string, GeoDimensionAccumulator>();
  const city = new Map<string, GeoDimensionAccumulator>();
  const continent = new Map<string, GeoDimensionAccumulator>();
  const timezone = new Map<string, GeoDimensionAccumulator>();
  const organization = new Map<string, GeoDimensionAccumulator>();

  for (const row of rows) {
    const sessionId = String(row.sessionId ?? "");
    const visitorId = String(row.visitorId ?? "");
    addGeoDimensionValue(country, String(row.country ?? ""), sessionId, visitorId);
    addGeoDimensionValue(region, String(row.region ?? ""), sessionId, visitorId);
    addGeoDimensionValue(city, String(row.city ?? ""), sessionId, visitorId);
    addGeoDimensionValue(continent, String(row.continent ?? ""), sessionId, visitorId);
    addGeoDimensionValue(timezone, String(row.timezone ?? ""), sessionId, visitorId);
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

