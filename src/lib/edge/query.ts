import type { Env } from "./types";
import { ONE_DAY_MS, ONE_HOUR_MS, coerceNumber } from "./utils";
import { requireSession } from "./session-auth";
import {
  type AeDimensionRow,
  queryAeOverview,
  queryAeOverviewBySites,
  queryAeRecentEvents,
  queryAeReferrers,
  queryAeSessionDetails,
  queryAeTopBrowsers,
  queryAeTopCountryRegionCities,
  queryAeTopCountryRegions,
  queryAeTopCountries,
  queryAeTopDevices,
  queryAeTopEventTypes,
  queryAeTopLanguages,
  queryAeTopPages,
  queryAeTopTimezones,
  queryAeTrend,
  queryAeTrendBySites,
  queryAeVisitorDetails,
  splitAeRange,
} from "./analytics-engine-query";
import { isAnalyticsEngineEnabled } from "./flags";

const RETENTION_DAYS = 365;
const ANALYTICS_WINDOW_DAYS = 90;
const GEO_REGION_VALUE_SEPARATOR = "::";
const GEO_CITY_VALUE_SEPARATOR = "::";

interface QueryWindow {
  fromMs: number;
  toMs: number;
  nowMs: number;
  retentionCutoffMs: number;
  analyticsCutoffMs: number;
  hasAnalytics: boolean;
  analyticsFromMs: number;
  analyticsToMs: number;
  hasD1Detail: boolean;
  d1DetailFromMs: number;
  d1DetailToMs: number;
  hasArchive: boolean;
  archiveFromHour: number;
  archiveToHour: number;
}

interface PublicSiteRow {
  id: string;
  team_id: string;
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

interface JsonObject {
  [key: string]: unknown;
}

interface DashboardFilters {
  country?: string;
  device?: string;
  browser?: string;
  eventType?: string;
}

function buildWindowFromRange(
  env: Env,
  fromMs: number,
  toMs: number,
  nowMs: number,
): QueryWindow | null {
  if (!Number.isFinite(fromMs) || !Number.isFinite(toMs) || fromMs < 0 || toMs < fromMs) {
    return null;
  }

  const retentionCutoffMs = nowMs - RETENTION_DAYS * ONE_DAY_MS;
  const analyticsEnabled = isAnalyticsEngineEnabled(env);
  const analyticsCutoffMs = nowMs - ANALYTICS_WINDOW_DAYS * ONE_DAY_MS;
  const analyticsRange = analyticsEnabled ? splitAeRange(fromMs, toMs, nowMs) : null;
  const hasAnalytics = Boolean(analyticsRange);
  const analyticsFromMs = analyticsRange?.fromMs ?? 0;
  const analyticsToMs = analyticsRange?.toMs ?? -1;

  const d1DetailFromMs = Math.max(fromMs, retentionCutoffMs);
  const d1DetailToMs = analyticsEnabled ? Math.min(toMs, analyticsCutoffMs - 1) : toMs;
  const hasD1Detail = d1DetailFromMs <= d1DetailToMs;

  const archiveToMs = Math.min(toMs, retentionCutoffMs - 1);
  const hasArchive = fromMs <= archiveToMs;
  const archiveFromHour = Math.floor(fromMs / ONE_HOUR_MS);
  const archiveToHour = Math.floor(archiveToMs / ONE_HOUR_MS);

  return {
    fromMs,
    toMs,
    nowMs,
    retentionCutoffMs,
    analyticsCutoffMs,
    hasAnalytics,
    analyticsFromMs,
    analyticsToMs,
    hasD1Detail,
    d1DetailFromMs,
    d1DetailToMs,
    hasArchive,
    archiveFromHour,
    archiveToHour,
  };
}

function toPercentChange(current: number, previous: number): number | null {
  if (!Number.isFinite(current) || !Number.isFinite(previous)) return null;
  if (previous <= 0) return null;
  return ((current - previous) / previous) * 100;
}

function jsonResponse(payload: unknown, status = 200, extraHeaders?: Record<string, string>): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      ...(extraHeaders ?? {}),
    },
  });
}

function badRequest(message: string): Response {
  return jsonResponse({ ok: false, error: message }, 400);
}

function unauthorized(message = "Unauthorized"): Response {
  return jsonResponse({ ok: false, error: message }, 401);
}

function notFound(message = "Not Found"): Response {
  return jsonResponse({ ok: false, error: message }, 404);
}

function notAllowed(message = "Method Not Allowed"): Response {
  return jsonResponse({ ok: false, error: message }, 405);
}

function parseWindow(url: URL, env: Env): QueryWindow | null {
  const now = Date.now();
  const defaultFrom = now - ONE_DAY_MS;
  const fromRaw = coerceNumber(url.searchParams.get("from"), defaultFrom);
  const toRaw = coerceNumber(url.searchParams.get("to"), now);
  const fromMs = Math.floor(fromRaw ?? defaultFrom);
  const toMs = Math.floor(toRaw ?? now);
  return buildWindowFromRange(env, fromMs, toMs, now);
}

function parseLimit(url: URL, defaultValue = 20, maxValue = 500): number {
  const n = coerceNumber(url.searchParams.get("limit"), defaultValue);
  if (!n || n <= 0) {
    return defaultValue;
  }
  return Math.min(maxValue, Math.floor(n));
}

function parseInterval(url: URL): "minute" | "hour" | "day" | "week" | "month" {
  const raw = (url.searchParams.get("interval") || "hour").toLowerCase();
  if (raw === "minute") return "minute";
  if (raw === "day") return "day";
  if (raw === "week") return "week";
  if (raw === "month") return "month";
  return "hour";
}

function parseBooleanSearchParam(url: URL, key: string): boolean {
  const raw = (url.searchParams.get(key) || "").trim().toLowerCase();
  return raw === "1" || raw === "true" || raw === "yes";
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
    eventType: normalizeFilterValue(url.searchParams.get("eventType")),
  };
}

function hasActiveFilters(filters: DashboardFilters): boolean {
  return Boolean(filters.country || filters.device || filters.browser || filters.eventType);
}

function buildD1FilterSql(
  filters: DashboardFilters,
  alias?: string,
): { clause: string; bindings: string[] } {
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
  if (filters.eventType) {
    clauses.push(`${prefix}event_type = ?`);
    bindings.push(filters.eventType);
  }

  if (clauses.length === 0) {
    return { clause: "", bindings: [] };
  }

  return {
    clause: ` AND ${clauses.join(" AND ")}`,
    bindings,
  };
}

function crossSourceFetchLimit(limit: number, crossSource: boolean): number {
  if (!crossSource) return limit;
  return 2000;
}

async function resolvePublicSiteBySlug(env: Env, slug: string): Promise<PublicSiteRow | null> {
  const row = await env.DB.prepare(
    `
      SELECT id, team_id, name, domain
      FROM sites
      WHERE public_enabled = 1 AND public_slug = ?
      LIMIT 1
    `,
  )
    .bind(slug)
    .first<PublicSiteRow>();
  return row ?? null;
}

function isAnalyticsSqlConfigured(env: Env): boolean {
  return Boolean(String(env.ANALYTICS_ACCOUNT_ID || "").trim() && String(env.ANALYTICS_SQL_API_TOKEN || "").trim());
}

async function assertSiteMembership(
  env: Env,
  siteId: string,
  userId: string,
): Promise<boolean> {
  const row = await env.DB.prepare(
    `
      SELECT 1 AS ok
      FROM sites s
      INNER JOIN team_members tm ON tm.team_id = s.team_id
      WHERE s.id = ? AND tm.user_id = ?
      LIMIT 1
    `,
  )
    .bind(siteId, userId)
    .first<{ ok: number }>();

  return Boolean(row?.ok);
}

async function assertTeamMembership(
  env: Env,
  teamId: string,
  userId: string,
): Promise<boolean> {
  const row = await env.DB.prepare(
    `
      SELECT 1 AS ok
      FROM team_members
      WHERE team_id = ? AND user_id = ?
      LIMIT 1
    `,
  )
    .bind(teamId, userId)
    .first<{ ok: number }>();

  return Boolean(row?.ok);
}

async function queryOverview(
  env: Env,
  siteId: string,
  window: QueryWindow,
  filters: DashboardFilters,
): Promise<{
  views: number;
  sessions: number;
  visitors: number;
  bounces: number;
  totalDurationMs: number;
  avgDurationMs: number;
  bounceRate: number;
  approximateVisitors: boolean;
}> {
  let views = 0;
  let sessions = 0;
  let visitors = 0;
  let bounces = 0;
  let totalDurationMs = 0;
  let approximateVisitors = false;
  const includeArchive = window.hasArchive && !hasActiveFilters(filters);
  const d1FilterSql = buildD1FilterSql(filters);

  if (window.hasAnalytics) {
    const ae = await queryAeOverview(env, siteId, {
      fromMs: window.analyticsFromMs,
      toMs: window.analyticsToMs,
    }, filters);
    views += ae.views ?? 0;
    sessions += ae.sessions ?? 0;
    visitors += ae.visitors ?? 0;
    bounces += ae.bounces ?? 0;
    totalDurationMs += ae.total_duration ?? 0;
  }

  if (window.hasD1Detail) {
    const detailed = await env.DB.prepare(
      `
        SELECT
          COUNT(*) AS views,
          COUNT(DISTINCT session_id) AS sessions,
          COUNT(DISTINCT visitor_id) AS visitors,
          SUM(CASE WHEN COALESCE(duration_ms, 0) <= 0 THEN 1 ELSE 0 END) AS bounces,
          SUM(COALESCE(duration_ms, 0)) AS total_duration
        FROM pageviews
        WHERE site_id = ? AND event_at BETWEEN ? AND ?${d1FilterSql.clause}
      `,
    )
      .bind(siteId, window.d1DetailFromMs, window.d1DetailToMs, ...d1FilterSql.bindings)
      .first<{
        views: number | null;
        sessions: number | null;
        visitors: number | null;
        bounces: number | null;
        total_duration: number | null;
      }>();

    views += detailed?.views ?? 0;
    sessions += detailed?.sessions ?? 0;
    visitors += detailed?.visitors ?? 0;
    bounces += detailed?.bounces ?? 0;
    totalDurationMs += detailed?.total_duration ?? 0;
  }

  if (includeArchive) {
    const archived = await env.DB.prepare(
      `
        WITH archive_rows AS (
          SELECT
            total_views,
            total_sessions,
            bounces,
            total_duration,
            visitors_json
          FROM pageviews_archive_hourly
          WHERE site_id = ? AND hour_bucket BETWEEN ? AND ?
        ),
        aggregate AS (
          SELECT
            COALESCE(SUM(total_views), 0) AS views,
            COALESCE(SUM(total_sessions), 0) AS sessions,
            COALESCE(SUM(bounces), 0) AS bounces,
            COALESCE(SUM(total_duration), 0) AS total_duration
          FROM archive_rows
        ),
        visitor_aggregate AS (
          SELECT
            COUNT(DISTINCT je.value) AS visitors
          FROM archive_rows
          JOIN json_each(archive_rows.visitors_json) je
          WHERE typeof(je.value) = 'text' AND je.value != ''
        )
        SELECT
          aggregate.views AS views,
          aggregate.sessions AS sessions,
          aggregate.bounces AS bounces,
          aggregate.total_duration AS total_duration,
          COALESCE(visitor_aggregate.visitors, 0) AS visitors
        FROM aggregate
        LEFT JOIN visitor_aggregate ON 1 = 1
      `,
    )
      .bind(siteId, window.archiveFromHour, window.archiveToHour)
      .first<{
        views: number | null;
        sessions: number | null;
        bounces: number | null;
        total_duration: number | null;
        visitors: number | null;
      }>();

    views += archived?.views ?? 0;
    sessions += archived?.sessions ?? 0;
    bounces += archived?.bounces ?? 0;
    totalDurationMs += archived?.total_duration ?? 0;
    visitors += archived?.visitors ?? 0;
    approximateVisitors = true;
  }

  const avgDurationMs = views > 0 ? Math.round(totalDurationMs / views) : 0;
  const bounceRate = views > 0 ? Number((bounces / views).toFixed(6)) : 0;

  return {
    views,
    sessions,
    visitors,
    bounces,
    totalDurationMs,
    avgDurationMs,
    bounceRate,
    approximateVisitors,
  };
}

async function queryTrend(
  env: Env,
  siteId: string,
  window: QueryWindow,
  interval: "minute" | "hour" | "day" | "week" | "month",
  filters: DashboardFilters,
): Promise<Array<{
  bucket: number;
  timestampMs: number;
  views: number;
  visitors: number;
  sessions: number;
  bounces: number;
  totalDurationMs: number;
  avgDurationMs: number;
  source: "detail" | "archive" | "mixed";
}>> {
  const bucketMs =
    interval === "minute"
      ? 60 * 1000
      : interval === "hour"
        ? ONE_HOUR_MS
        : interval === "day"
          ? ONE_DAY_MS
          : interval === "week"
            ? 7 * ONE_DAY_MS
            : 30 * ONE_DAY_MS;
  const bucketDivisor = interval === "hour"
    ? 1
    : interval === "day"
      ? 24
      : interval === "week"
        ? 168
        : interval === "month"
          ? 720
          : 0;
  const includeArchive = window.hasArchive && interval !== "minute" && !hasActiveFilters(filters);
  const d1FilterSql = buildD1FilterSql(filters);
  const buckets = new Map<
    number,
    {
      views: number;
      visitors: number;
      sessions: number;
      bounces: number;
      totalDurationMs: number;
      detail: boolean;
      archive: boolean;
    }
  >();

  if (window.hasAnalytics) {
    const aeRows = await queryAeTrend(
      env,
      siteId,
      {
        fromMs: window.analyticsFromMs,
        toMs: window.analyticsToMs,
      },
      interval,
      filters,
    );
    for (const row of aeRows) {
      const entry = buckets.get(row.bucket) ?? {
        views: 0,
        visitors: 0,
        sessions: 0,
        bounces: 0,
        totalDurationMs: 0,
        detail: false,
        archive: false,
      };
      entry.views += row.views ?? 0;
      entry.visitors += row.visitors ?? 0;
      entry.sessions += row.sessions ?? 0;
      entry.bounces += row.bounces ?? 0;
      entry.totalDurationMs += row.total_duration ?? 0;
      entry.detail = true;
      buckets.set(row.bucket, entry);
    }
  }

  if (window.hasD1Detail) {
    const detailSql = `
      SELECT
        CAST(event_at / ${bucketMs} AS INTEGER) AS bucket,
        COUNT(*) AS views,
        COUNT(DISTINCT visitor_id) AS visitors,
        COUNT(DISTINCT session_id) AS sessions,
        SUM(CASE WHEN COALESCE(duration_ms, 0) <= 0 THEN 1 ELSE 0 END) AS bounces,
        SUM(COALESCE(duration_ms, 0)) AS total_duration
      FROM pageviews
      WHERE site_id = ? AND event_at BETWEEN ? AND ?${d1FilterSql.clause}
      GROUP BY bucket
      ORDER BY bucket
    `;

    const detailRows = await env.DB.prepare(detailSql)
      .bind(siteId, window.d1DetailFromMs, window.d1DetailToMs, ...d1FilterSql.bindings)
      .all<{
        bucket: number;
        views: number;
        visitors: number;
        sessions: number;
        bounces: number;
        total_duration: number;
      }>();

    for (const row of detailRows.results) {
      const entry = buckets.get(row.bucket) ?? {
        views: 0,
        visitors: 0,
        sessions: 0,
        bounces: 0,
        totalDurationMs: 0,
        detail: false,
        archive: false,
      };
      entry.views += row.views ?? 0;
      entry.visitors += row.visitors ?? 0;
      entry.sessions += row.sessions ?? 0;
      entry.bounces += row.bounces ?? 0;
      entry.totalDurationMs += row.total_duration ?? 0;
      entry.detail = true;
      buckets.set(row.bucket, entry);
    }
  }

  if (includeArchive) {
    const archiveSql = `
      WITH archive_rows AS (
        SELECT
          CAST(hour_bucket / ? AS INTEGER) AS bucket,
          total_views,
          total_sessions,
          bounces,
          total_duration,
          visitors_json
        FROM pageviews_archive_hourly
        WHERE site_id = ? AND hour_bucket BETWEEN ? AND ?
      ),
      aggregate AS (
        SELECT
          bucket,
          SUM(total_views) AS views,
          SUM(total_sessions) AS sessions,
          SUM(bounces) AS bounces,
          SUM(total_duration) AS total_duration
        FROM archive_rows
        GROUP BY bucket
      ),
      visitor_aggregate AS (
        SELECT
          archive_rows.bucket AS bucket,
          COUNT(DISTINCT je.value) AS visitors
        FROM archive_rows
        JOIN json_each(archive_rows.visitors_json) je
        WHERE typeof(je.value) = 'text' AND je.value != ''
        GROUP BY archive_rows.bucket
      )
      SELECT
        aggregate.bucket AS bucket,
        aggregate.views AS views,
        aggregate.sessions AS sessions,
        aggregate.bounces AS bounces,
        aggregate.total_duration AS total_duration,
        COALESCE(visitor_aggregate.visitors, 0) AS visitors
      FROM aggregate
      LEFT JOIN visitor_aggregate ON visitor_aggregate.bucket = aggregate.bucket
      ORDER BY aggregate.bucket
    `;

    const archiveRows = await env.DB.prepare(archiveSql)
      .bind(bucketDivisor, siteId, window.archiveFromHour, window.archiveToHour)
      .all<{
        bucket: number;
        views: number;
        sessions: number;
        bounces: number;
        total_duration: number;
        visitors: number;
      }>();

    for (const row of archiveRows.results) {
      const entry = buckets.get(row.bucket) ?? {
        views: 0,
        visitors: 0,
        sessions: 0,
        bounces: 0,
        totalDurationMs: 0,
        detail: false,
        archive: false,
      };
      entry.views += row.views ?? 0;
      entry.visitors += row.visitors ?? 0;
      entry.sessions += row.sessions ?? 0;
      entry.bounces += row.bounces ?? 0;
      entry.totalDurationMs += row.total_duration ?? 0;
      entry.archive = true;
      buckets.set(row.bucket, entry);
    }
  }

  return Array.from(buckets.entries())
    .sort((a, b) => a[0] - b[0])
    .map(([bucket, value]) => ({
      bucket,
      timestampMs: bucket * bucketMs,
      views: value.views,
      visitors: value.visitors,
      sessions: value.sessions,
      bounces: value.bounces,
      totalDurationMs: value.totalDurationMs,
      avgDurationMs: value.views > 0 ? Math.round(value.totalDurationMs / value.views) : 0,
      source: value.detail && value.archive ? "mixed" : value.detail ? "detail" : "archive",
    }));
}

function mergeStatObject(target: Record<string, number>, jsonText: string | null | undefined): void {
  if (!jsonText) return;
  try {
    const parsed = JSON.parse(jsonText) as JsonObject;
    for (const [key, value] of Object.entries(parsed)) {
      if (!key) continue;
      if (typeof value === "number" && Number.isFinite(value)) {
        target[key] = (target[key] ?? 0) + value;
      }
    }
  } catch {
    // ignore malformed json
  }
}

type DimensionKey = "country" | "device_type" | "browser" | "event_type";
type ArchiveDimensionKey =
  | "country_stats_json"
  | "region_stats_json"
  | "city_stats_json"
  | "device_stats_json"
  | "browser_stats_json"
  | "os_stats_json"
  | "screen_stats_json"
  | "language_stats_json"
  | "timezone_stats_json"
  | null;
type AeDimensionQueryFn = (
  env: Env,
  siteId: string,
  range: { fromMs: number; toMs: number },
  limit: number,
  filters?: DashboardFilters,
) => Promise<AeDimensionRow[]>;
interface DimensionStatsOptions {
  d1DimensionExpr: string;
  archiveDimensionKey: ArchiveDimensionKey;
  aeQuery?: AeDimensionQueryFn;
}

type PageCardTabKey = "path" | "title" | "hostname" | "entry" | "exit";

interface PageCardTabRow {
  label: string;
  views: number;
  sessions: number;
}

interface PageCardTabsData {
  path: PageCardTabRow[];
  title: PageCardTabRow[];
  hostname: PageCardTabRow[];
  entry: PageCardTabRow[];
  exit: PageCardTabRow[];
}

function emptyPageCardTabsData(): PageCardTabsData {
  return {
    path: [],
    title: [],
    hostname: [],
    entry: [],
    exit: [],
  };
}

async function queryDimensionStats(
  env: Env,
  siteId: string,
  window: QueryWindow,
  limit: number,
  filters: DashboardFilters,
  options: {
    d1DimensionKey: DimensionKey;
    archiveDimensionKey: ArchiveDimensionKey;
    aeQuery: AeDimensionQueryFn;
  },
): Promise<Array<{ value: string; views: number; sessions: number }>> {
  return queryDimensionStatsByExpr(env, siteId, window, limit, filters, {
    d1DimensionExpr: options.d1DimensionKey,
    archiveDimensionKey: options.archiveDimensionKey,
    aeQuery: options.aeQuery,
  });
}

async function queryDimensionStatsByExpr(
  env: Env,
  siteId: string,
  window: QueryWindow,
  limit: number,
  filters: DashboardFilters,
  options: DimensionStatsOptions,
): Promise<Array<{ value: string; views: number; sessions: number }>> {
  const map = new Map<string, { value: string; views: number; sessions: number }>();
  const d1FilterSql = buildD1FilterSql(filters);
  const includeArchive = window.hasArchive && !hasActiveFilters(filters);
  const sourceLimit = crossSourceFetchLimit(limit, window.hasAnalytics || includeArchive);

  if (window.hasAnalytics && options.aeQuery) {
    const aeRows = await options.aeQuery(
      env,
      siteId,
      {
        fromMs: window.analyticsFromMs,
        toMs: window.analyticsToMs,
      },
      sourceLimit,
      filters,
    );
    for (const row of aeRows) {
      const value = row.key || "";
      const prev = map.get(value);
      map.set(value, {
        value,
        views: (prev?.views ?? 0) + (row.views ?? 0),
        sessions: (prev?.sessions ?? 0) + (row.sessions ?? 0),
      });
    }
  }

  if (window.hasD1Detail) {
    const sql = `
      SELECT
        COALESCE(${options.d1DimensionExpr}, '') AS k,
        COUNT(*) AS views,
        COUNT(DISTINCT session_id) AS sessions
      FROM pageviews
      WHERE site_id = ? AND event_at BETWEEN ? AND ?${d1FilterSql.clause}
      GROUP BY k
      ORDER BY views DESC
      LIMIT ?
    `;

    const rows = await env.DB.prepare(sql)
      .bind(siteId, window.d1DetailFromMs, window.d1DetailToMs, ...d1FilterSql.bindings, sourceLimit)
      .all<{ k: string; views: number; sessions: number }>();

    for (const row of rows.results) {
      const value = row.k || "";
      const prev = map.get(value);
      map.set(value, {
        value,
        views: (prev?.views ?? 0) + (row.views ?? 0),
        sessions: (prev?.sessions ?? 0) + (row.sessions ?? 0),
      });
    }
  }

  if (includeArchive && options.archiveDimensionKey) {
    const archiveRows = await env.DB.prepare(
      `
        SELECT ${options.archiveDimensionKey} AS stats_json
        FROM pageviews_archive_hourly
        WHERE site_id = ? AND hour_bucket BETWEEN ? AND ?
      `,
    )
      .bind(siteId, window.archiveFromHour, window.archiveToHour)
      .all<{ stats_json: string | null }>();

    const counts: Record<string, number> = {};
    for (const row of archiveRows.results) {
      mergeStatObject(counts, row.stats_json);
    }

    for (const [value, views] of Object.entries(counts)) {
      const prev = map.get(value);
      map.set(value, {
        value,
        views: (prev?.views ?? 0) + views,
        sessions: prev?.sessions ?? 0,
      });
    }
  }

  return Array.from(map.values())
    .sort((a, b) => b.views - a.views)
    .slice(0, limit);
}

interface OverviewDimensionTabRow {
  label: string;
  views: number;
  sessions: number;
}

interface OverviewClientDimensionTabsData {
  browser: OverviewDimensionTabRow[];
  osVersion: OverviewDimensionTabRow[];
  deviceType: OverviewDimensionTabRow[];
  language: OverviewDimensionTabRow[];
  screenSize: OverviewDimensionTabRow[];
}

interface OverviewGeoDimensionTabsData {
  country: OverviewDimensionTabRow[];
  region: OverviewDimensionTabRow[];
  city: OverviewDimensionTabRow[];
  continent: OverviewDimensionTabRow[];
  timezone: OverviewDimensionTabRow[];
  organization: OverviewDimensionTabRow[];
}

function toOverviewDimensionRows(
  rows: Array<{ value: string; views: number; sessions: number }>,
): OverviewDimensionTabRow[] {
  return rows.map((item) => ({
    label: item.value,
    views: Math.max(0, Number(item.views ?? 0)),
    sessions: Math.max(0, Number(item.sessions ?? 0)),
  }));
}

async function queryOverviewClientDimensionTabs(
  env: Env,
  siteId: string,
  window: QueryWindow,
  limit: number,
  filters: DashboardFilters,
): Promise<OverviewClientDimensionTabsData> {
  const osWithVersionExpr = `
    CASE
      WHEN COALESCE(os, '') = '' AND COALESCE(os_version, '') = '' THEN ''
      WHEN COALESCE(os_version, '') = '' THEN COALESCE(os, '')
      ELSE trim(COALESCE(os, '') || ' ' || COALESCE(os_version, ''))
    END
  `;
  const screenSizeExpr = `
    CASE
      WHEN COALESCE(screen_width, 0) > 0 AND COALESCE(screen_height, 0) > 0
        THEN CAST(screen_width AS TEXT) || 'x' || CAST(screen_height AS TEXT)
      ELSE ''
    END
  `;

  const [browser, osVersion, deviceType, language, screenSize] =
    await Promise.all([
    queryDimensionStatsByExpr(env, siteId, window, limit, filters, {
      d1DimensionExpr: "browser",
      archiveDimensionKey: "browser_stats_json",
      aeQuery: queryAeTopBrowsers,
    }),
    queryDimensionStatsByExpr(env, siteId, window, limit, filters, {
      d1DimensionExpr: osWithVersionExpr,
      archiveDimensionKey: null,
    }),
    queryDimensionStatsByExpr(env, siteId, window, limit, filters, {
      d1DimensionExpr: "device_type",
      archiveDimensionKey: "device_stats_json",
      aeQuery: queryAeTopDevices,
    }),
    queryDimensionStatsByExpr(env, siteId, window, limit, filters, {
      d1DimensionExpr: "language",
      archiveDimensionKey: "language_stats_json",
      aeQuery: queryAeTopLanguages,
    }),
    queryDimensionStatsByExpr(env, siteId, window, limit, filters, {
      d1DimensionExpr: screenSizeExpr,
      archiveDimensionKey: "screen_stats_json",
    }),
  ]);

  return {
    browser: toOverviewDimensionRows(browser),
    osVersion: toOverviewDimensionRows(osVersion),
    deviceType: toOverviewDimensionRows(deviceType),
    language: toOverviewDimensionRows(language),
    screenSize: toOverviewDimensionRows(screenSize),
  };
}

async function queryOverviewGeoDimensionTabs(
  env: Env,
  siteId: string,
  window: QueryWindow,
  limit: number,
  filters: DashboardFilters,
): Promise<OverviewGeoDimensionTabsData> {
  const regionCodeOrNameExpr = `
    trim(COALESCE(NULLIF(region_code, ''), NULLIF(region, ''), ''))
  `;
  const regionNameExpr = `
    trim(COALESCE(NULLIF(region, ''), NULLIF(region_code, ''), ''))
  `;
  const regionWithCountryExpr = `
    CASE
      WHEN ${regionCodeOrNameExpr} = '' THEN ''
      ELSE trim(COALESCE(country, '')) || '${GEO_REGION_VALUE_SEPARATOR}' || ${regionCodeOrNameExpr} || '${GEO_REGION_VALUE_SEPARATOR}' || ${regionNameExpr}
    END
  `;
  const cityWithRegionCountryExpr = `
    CASE
      WHEN COALESCE(city, '') = '' THEN ''
      ELSE trim(COALESCE(country, '')) || '${GEO_CITY_VALUE_SEPARATOR}' || ${regionCodeOrNameExpr} || '${GEO_CITY_VALUE_SEPARATOR}' || ${regionNameExpr} || '${GEO_CITY_VALUE_SEPARATOR}' || trim(COALESCE(city, ''))
    END
  `;

  const [country, region, city, continent, timezone, organization] =
    await Promise.all([
      queryDimensionStatsByExpr(env, siteId, window, limit, filters, {
        d1DimensionExpr: "country",
        archiveDimensionKey: "country_stats_json",
        aeQuery: queryAeTopCountries,
      }),
      queryDimensionStatsByExpr(env, siteId, window, limit, filters, {
        d1DimensionExpr: regionWithCountryExpr,
        archiveDimensionKey: "region_stats_json",
        aeQuery: queryAeTopCountryRegions,
      }),
      queryDimensionStatsByExpr(env, siteId, window, limit, filters, {
        d1DimensionExpr: cityWithRegionCountryExpr,
        archiveDimensionKey: "city_stats_json",
        aeQuery: queryAeTopCountryRegionCities,
      }),
      queryDimensionStatsByExpr(env, siteId, window, limit, filters, {
        d1DimensionExpr: "continent",
        archiveDimensionKey: null,
      }),
      queryDimensionStatsByExpr(env, siteId, window, limit, filters, {
        d1DimensionExpr: "timezone",
        archiveDimensionKey: "timezone_stats_json",
        aeQuery: queryAeTopTimezones,
      }),
      queryDimensionStatsByExpr(env, siteId, window, limit, filters, {
        d1DimensionExpr: "as_organization",
        archiveDimensionKey: null,
      }),
    ]);

  return {
    country: toOverviewDimensionRows(country),
    region: toOverviewDimensionRows(region),
    city: toOverviewDimensionRows(city),
    continent: toOverviewDimensionRows(continent),
    timezone: toOverviewDimensionRows(timezone),
    organization: toOverviewDimensionRows(organization),
  };
}

async function queryTopPages(
  env: Env,
  siteId: string,
  window: QueryWindow,
  limit: number,
  includeQueryHashDetails: boolean,
  filters: DashboardFilters,
): Promise<Array<{ pathname: string; query?: string; hash?: string; views: number; sessions: number }>> {
  const pageMap = new Map<string, { pathname: string; query?: string; hash?: string; views: number; sessions: number }>();
  const d1FilterSql = buildD1FilterSql(filters);
  const includeArchive = window.hasArchive && !hasActiveFilters(filters);
  const sourceLimit = crossSourceFetchLimit(limit, window.hasAnalytics || includeArchive);

  if (window.hasAnalytics) {
    const aeRows = await queryAeTopPages(
      env,
      siteId,
      {
        fromMs: window.analyticsFromMs,
        toMs: window.analyticsToMs,
      },
      sourceLimit,
      includeQueryHashDetails,
      filters,
    );
    for (const row of aeRows) {
      const query = row.query_string || "";
      const hash = row.hash_fragment || "";
      const key = includeQueryHashDetails ? `${row.pathname}|${query}|${hash}` : row.pathname;
      const prev = pageMap.get(key);
      pageMap.set(key, {
        pathname: row.pathname,
        query: includeQueryHashDetails ? query : undefined,
        hash: includeQueryHashDetails ? hash : undefined,
        views: (prev?.views ?? 0) + (row.views ?? 0),
        sessions: (prev?.sessions ?? 0) + (row.sessions ?? 0),
      });
    }
  }

  if (window.hasD1Detail) {
    const sql = includeQueryHashDetails
      ? `
        SELECT
          pathname,
          COALESCE(query_string, '') AS query_string,
          COALESCE(hash_fragment, '') AS hash_fragment,
          COUNT(*) AS views,
          COUNT(DISTINCT session_id) AS sessions
        FROM pageviews
        WHERE site_id = ? AND event_at BETWEEN ? AND ?${d1FilterSql.clause}
        GROUP BY pathname, query_string, hash_fragment
        ORDER BY views DESC
        LIMIT ?
      `
      : `
        SELECT
          pathname,
          COUNT(*) AS views,
          COUNT(DISTINCT session_id) AS sessions
        FROM pageviews
        WHERE site_id = ? AND event_at BETWEEN ? AND ?${d1FilterSql.clause}
        GROUP BY pathname
        ORDER BY views DESC
        LIMIT ?
      `;

    if (includeQueryHashDetails) {
      const rows = await env.DB.prepare(sql)
        .bind(siteId, window.d1DetailFromMs, window.d1DetailToMs, ...d1FilterSql.bindings, sourceLimit)
        .all<{ pathname: string; query_string: string; hash_fragment: string; views: number; sessions: number }>();

      for (const row of rows.results) {
        const key = `${row.pathname}|${row.query_string}|${row.hash_fragment}`;
        const prev = pageMap.get(key);
        pageMap.set(key, {
          pathname: row.pathname,
          query: row.query_string,
          hash: row.hash_fragment,
          views: (prev?.views ?? 0) + row.views,
          sessions: (prev?.sessions ?? 0) + row.sessions,
        });
      }
    } else {
      const rows = await env.DB.prepare(sql)
        .bind(siteId, window.d1DetailFromMs, window.d1DetailToMs, ...d1FilterSql.bindings, sourceLimit)
        .all<{ pathname: string; views: number; sessions: number }>();

      for (const row of rows.results) {
        const key = row.pathname;
        const prev = pageMap.get(key);
        pageMap.set(key, {
          pathname: row.pathname,
          views: (prev?.views ?? 0) + row.views,
          sessions: (prev?.sessions ?? 0) + row.sessions,
        });
      }
    }
  }

  if (includeArchive) {
    const archiveRows = await env.DB.prepare(
      `
        SELECT path_stats_json
        FROM pageviews_archive_hourly
        WHERE site_id = ? AND hour_bucket BETWEEN ? AND ?
      `,
    )
      .bind(siteId, window.archiveFromHour, window.archiveToHour)
      .all<{ path_stats_json: string | null }>();

    const archiveCounts: Record<string, number> = {};
    for (const row of archiveRows.results) {
      mergeStatObject(archiveCounts, row.path_stats_json);
    }

    for (const [pathname, views] of Object.entries(archiveCounts)) {
      const key = includeQueryHashDetails ? `${pathname}||` : pathname;
      const prev = pageMap.get(key);
      pageMap.set(key, {
        pathname,
        query: includeQueryHashDetails ? "" : undefined,
        hash: includeQueryHashDetails ? "" : undefined,
        views: views + (prev?.views ?? 0),
        sessions: prev?.sessions ?? 0,
      });
    }
  }

  return Array.from(pageMap.values())
    .sort((a, b) => b.views - a.views)
    .slice(0, limit);
}

function sortPageCardRows(rows: PageCardTabRow[], limit: number): PageCardTabRow[] {
  return [...rows]
    .sort((a, b) => {
      if (b.views !== a.views) return b.views - a.views;
      if (b.sessions !== a.sessions) return b.sessions - a.sessions;
      return a.label.localeCompare(b.label);
    })
    .slice(0, limit);
}

function mergePageCardRows(primary: PageCardTabRow[], extra: PageCardTabRow[], limit: number): PageCardTabRow[] {
  const map = new Map<string, { views: number; sessions: number }>();

  for (const row of primary) {
    const key = String(row.label ?? "");
    const prev = map.get(key);
    map.set(key, {
      views: (prev?.views ?? 0) + Math.max(0, Number(row.views ?? 0)),
      sessions: (prev?.sessions ?? 0) + Math.max(0, Number(row.sessions ?? 0)),
    });
  }

  for (const row of extra) {
    const key = String(row.label ?? "");
    const prev = map.get(key);
    map.set(key, {
      views: (prev?.views ?? 0) + Math.max(0, Number(row.views ?? 0)),
      sessions: (prev?.sessions ?? 0) + Math.max(0, Number(row.sessions ?? 0)),
    });
  }

  return sortPageCardRows(
    Array.from(map.entries()).map(([label, value]) => ({
      label,
      views: value.views,
      sessions: value.sessions,
    })),
    limit,
  );
}

function mergePageCardTabs(primary: PageCardTabsData, extra: PageCardTabsData, limit: number): PageCardTabsData {
  return {
    path: mergePageCardRows(primary.path, extra.path, limit),
    title: mergePageCardRows(primary.title, extra.title, limit),
    hostname: mergePageCardRows(primary.hostname, extra.hostname, limit),
    entry: mergePageCardRows(primary.entry, extra.entry, limit),
    exit: mergePageCardRows(primary.exit, extra.exit, limit),
  };
}

async function queryPageCardTabsFromSingleD1Sql(
  env: Env,
  siteId: string,
  window: QueryWindow,
  limit: number,
  filters: DashboardFilters,
): Promise<PageCardTabsData> {
  if (!window.hasD1Detail) {
    return emptyPageCardTabsData();
  }

  const d1FilterSql = buildD1FilterSql(filters, "p");
  const sql = `
    WITH filtered AS (
      SELECT
        CAST(id AS TEXT) AS id,
        COALESCE(pathname, '/') AS pathname,
        COALESCE(title, '') AS title,
        COALESCE(hostname, '') AS hostname,
        COALESCE(session_id, '') AS session_id,
        event_at
      FROM pageviews p
      WHERE p.site_id = ? AND p.event_at BETWEEN ? AND ?${d1FilterSql.clause}
    ),
    dimension_expanded AS (
      SELECT
        CASE dims.dimension_key
          WHEN 1 THEN 'path'
          WHEN 2 THEN 'title'
          ELSE 'hostname'
        END AS tab,
        CASE dims.dimension_key
          WHEN 1 THEN pathname
          WHEN 2 THEN title
          ELSE hostname
        END AS label,
        session_id,
        id
      FROM filtered
      JOIN (
        SELECT 1 AS dimension_key
        UNION ALL
        SELECT 2 AS dimension_key
        UNION ALL
        SELECT 3 AS dimension_key
      ) dims
    ),
    dimension_rows AS (
      SELECT
        tab,
        label,
        COUNT(*) AS views,
        COUNT(DISTINCT CASE WHEN session_id != '' THEN session_id ELSE id END) AS sessions
      FROM dimension_expanded
      GROUP BY tab, label
    ),
    session_ranked AS (
      SELECT
        CASE WHEN session_id != '' THEN session_id ELSE id END AS session_key,
        pathname,
        ROW_NUMBER() OVER (
          PARTITION BY CASE WHEN session_id != '' THEN session_id ELSE id END
          ORDER BY event_at ASC, id ASC
        ) AS rn_entry,
        ROW_NUMBER() OVER (
          PARTITION BY CASE WHEN session_id != '' THEN session_id ELSE id END
          ORDER BY event_at DESC, id DESC
        ) AS rn_exit,
        COUNT(*) OVER (
          PARTITION BY CASE WHEN session_id != '' THEN session_id ELSE id END
        ) AS session_views
      FROM filtered
    ),
    session_heads AS (
      SELECT
        session_key,
        MAX(CASE WHEN rn_entry = 1 THEN pathname END) AS entry_path,
        MAX(CASE WHEN rn_exit = 1 THEN pathname END) AS exit_path,
        MAX(session_views) AS session_views
      FROM session_ranked
      GROUP BY session_key
    ),
    entry_exit_rows AS (
      SELECT
        tab,
        label,
        SUM(session_views) AS views,
        COUNT(*) AS sessions
      FROM (
        SELECT 'entry' AS tab, COALESCE(entry_path, '/') AS label, session_views
        FROM session_heads
        UNION ALL
        SELECT 'exit' AS tab, COALESCE(exit_path, '/') AS label, session_views
        FROM session_heads
      )
      GROUP BY tab, label
    ),
    combined AS (
      SELECT tab, label, views, sessions FROM dimension_rows
      UNION ALL
      SELECT tab, label, views, sessions FROM entry_exit_rows
    ),
    ranked AS (
      SELECT
        tab,
        label,
        views,
        sessions,
        ROW_NUMBER() OVER (
          PARTITION BY tab
          ORDER BY views DESC, sessions DESC, label ASC
        ) AS row_num
      FROM combined
    )
    SELECT tab, label, views, sessions
    FROM ranked
    WHERE row_num <= ?
    ORDER BY
      CASE tab
        WHEN 'path' THEN 1
        WHEN 'title' THEN 2
        WHEN 'hostname' THEN 3
        WHEN 'entry' THEN 4
        WHEN 'exit' THEN 5
        ELSE 6
      END ASC,
      views DESC,
      sessions DESC,
      label ASC
  `;

  const rows = await env.DB.prepare(sql)
    .bind(siteId, window.d1DetailFromMs, window.d1DetailToMs, ...d1FilterSql.bindings, limit)
    .all<{
      tab: string;
      label: string;
      views: number;
      sessions: number;
    }>();

  const tabs = emptyPageCardTabsData();
  for (const row of rows.results) {
    const tab = row.tab as PageCardTabKey;
    if (!(tab in tabs)) continue;
    const normalizedLabel = tab === "title" || tab === "hostname"
      ? String(row.label ?? "")
      : (String(row.label ?? "").trim() || "/");

    tabs[tab].push({
      label: normalizedLabel,
      views: Math.max(0, Number(row.views ?? 0)),
      sessions: Math.max(0, Number(row.sessions ?? 0)),
    });
  }

  return {
    path: sortPageCardRows(tabs.path, limit),
    title: sortPageCardRows(tabs.title, limit),
    hostname: sortPageCardRows(tabs.hostname, limit),
    entry: sortPageCardRows(tabs.entry, limit),
    exit: sortPageCardRows(tabs.exit, limit),
  };
}

async function queryPageCardTabsFallback(
  env: Env,
  siteId: string,
  window: QueryWindow,
  limit: number,
  filters: DashboardFilters,
): Promise<PageCardTabsData> {
  const [paths, events, sessions] = await Promise.all([
    queryTopPages(env, siteId, window, limit, false, filters),
    queryRecentEvents(env, siteId, window, Math.max(limit, 100), filters),
    querySessionDetails(env, siteId, window, Math.max(limit, 100), filters),
  ]);

  const pathRows: PageCardTabRow[] = paths.map((row) => ({
    label: String(row.pathname || "/").trim() || "/",
    views: Math.max(0, Number(row.views ?? 0)),
    sessions: Math.max(0, Number(row.sessions ?? 0)),
  }));

  const aggregateEventDimension = (dimension: "title" | "hostname"): PageCardTabRow[] => {
    const map = new Map<string, { views: number; sessionIds: Set<string>; unknownSessions: number }>();

    for (const raw of events) {
      if (!raw || typeof raw !== "object") continue;
      const row = raw as Record<string, unknown>;
      const rawLabel = String(row[dimension] ?? "").trim();
      const key = rawLabel;
      const prev = map.get(key) ?? {
        views: 0,
        sessionIds: new Set<string>(),
        unknownSessions: 0,
      };
      prev.views += 1;
      const sessionId = String(row.session_id ?? "").trim();
      if (sessionId) {
        prev.sessionIds.add(sessionId);
      } else {
        prev.unknownSessions += 1;
      }
      map.set(key, prev);
    }

    return Array.from(map.entries()).map(([label, value]) => ({
      label,
      views: value.views,
      sessions: value.sessionIds.size + value.unknownSessions,
    }));
  };

  const aggregateSessionPath = (dimension: "entryPath" | "exitPath"): PageCardTabRow[] => {
    const map = new Map<string, { views: number; sessions: number }>();
    for (const row of sessions) {
      const label = String(row[dimension] ?? "").trim() || "/";
      const prev = map.get(label) ?? { views: 0, sessions: 0 };
      map.set(label, {
        views: prev.views + Math.max(0, Number(row.views ?? 0)),
        sessions: prev.sessions + 1,
      });
    }
    return Array.from(map.entries()).map(([label, value]) => ({
      label,
      views: value.views,
      sessions: value.sessions,
    }));
  };

  return {
    path: sortPageCardRows(pathRows, limit),
    title: sortPageCardRows(aggregateEventDimension("title"), limit),
    hostname: sortPageCardRows(aggregateEventDimension("hostname"), limit),
    entry: sortPageCardRows(aggregateSessionPath("entryPath"), limit),
    exit: sortPageCardRows(aggregateSessionPath("exitPath"), limit),
  };
}

async function queryPageCardTabs(
  env: Env,
  siteId: string,
  window: QueryWindow,
  limit: number,
  filters: DashboardFilters,
): Promise<PageCardTabsData> {
  if (!window.hasD1Detail) {
    return queryPageCardTabsFallback(env, siteId, window, limit, filters);
  }

  const d1Tabs = await queryPageCardTabsFromSingleD1Sql(env, siteId, window, limit, filters);
  if (!window.hasAnalytics && !window.hasArchive) {
    return d1Tabs;
  }

  const nonD1Window: QueryWindow = {
    ...window,
    hasD1Detail: false,
    d1DetailFromMs: 0,
    d1DetailToMs: -1,
  };
  const nonD1Tabs = await queryPageCardTabsFallback(env, siteId, nonD1Window, limit, filters);
  return mergePageCardTabs(d1Tabs, nonD1Tabs, limit);
}

async function queryReferrers(
  env: Env,
  siteId: string,
  window: QueryWindow,
  limit: number,
  includeFullUrl: boolean,
  filters: DashboardFilters,
): Promise<Array<{ referrer: string; views: number; sessions: number }>> {
  const keyField = includeFullUrl ? "referer" : "referer_host";
  const map = new Map<string, { referrer: string; views: number; sessions: number }>();
  const d1FilterSql = buildD1FilterSql(filters);
  const includeArchive = window.hasArchive && !hasActiveFilters(filters) && !includeFullUrl;
  const sourceLimit = crossSourceFetchLimit(limit, window.hasAnalytics || includeArchive);

  if (window.hasAnalytics) {
    const aeRows = await queryAeReferrers(
      env,
      siteId,
      {
        fromMs: window.analyticsFromMs,
        toMs: window.analyticsToMs,
      },
      sourceLimit,
      includeFullUrl,
      filters,
    );
    for (const row of aeRows) {
      const referrer = row.ref || "";
      const prev = map.get(referrer);
      map.set(referrer, {
        referrer,
        views: (prev?.views ?? 0) + (row.views ?? 0),
        sessions: (prev?.sessions ?? 0) + (row.sessions ?? 0),
      });
    }
  }

  if (window.hasD1Detail) {
    const sql = `
      SELECT
        COALESCE(${keyField}, '') AS ref,
        COUNT(*) AS views,
        COUNT(DISTINCT session_id) AS sessions
      FROM pageviews
      WHERE site_id = ? AND event_at BETWEEN ? AND ?${d1FilterSql.clause}
      GROUP BY ref
      ORDER BY views DESC
      LIMIT ?
    `;
    const rows = await env.DB.prepare(sql)
      .bind(siteId, window.d1DetailFromMs, window.d1DetailToMs, ...d1FilterSql.bindings, sourceLimit)
      .all<{ ref: string; views: number; sessions: number }>();

    for (const row of rows.results) {
      const prev = map.get(row.ref);
      map.set(row.ref, {
        referrer: row.ref,
        views: (prev?.views ?? 0) + row.views,
        sessions: (prev?.sessions ?? 0) + row.sessions,
      });
    }
  }

  if (includeArchive) {
    const rows = await env.DB.prepare(
      `
        SELECT referer_stats_json
        FROM pageviews_archive_hourly
        WHERE site_id = ? AND hour_bucket BETWEEN ? AND ?
      `,
    )
      .bind(siteId, window.archiveFromHour, window.archiveToHour)
      .all<{ referer_stats_json: string | null }>();

    const counts: Record<string, number> = {};
    for (const row of rows.results) {
      mergeStatObject(counts, row.referer_stats_json);
    }
    for (const [referrer, views] of Object.entries(counts)) {
      const prev = map.get(referrer);
      map.set(referrer, {
        referrer,
        views: views + (prev?.views ?? 0),
        sessions: prev?.sessions ?? 0,
      });
    }
  }

  return Array.from(map.values())
    .sort((a, b) => b.views - a.views)
    .slice(0, limit);
}

async function queryRecentEvents(
  env: Env,
  siteId: string,
  window: QueryWindow,
  limit: number,
  filters: DashboardFilters,
): Promise<unknown[]> {
  if (!window.hasD1Detail && !window.hasAnalytics) {
    return [];
  }
  const merged: Record<string, unknown>[] = [];
  const d1FilterSql = buildD1FilterSql(filters);

  if (window.hasAnalytics) {
    const aeRows = await queryAeRecentEvents(
      env,
      siteId,
      {
        fromMs: window.analyticsFromMs,
        toMs: window.analyticsToMs,
      },
      limit,
      filters,
    );
    for (const row of aeRows) {
      const eventAt = row.event_at ?? 0;
      const id = `${eventAt}|${row.session_id || ""}|${row.visitor_id || ""}|${row.pathname || "/"}`;
      merged.push({
        id,
        event_type: row.event_type || "",
        event_at: eventAt,
        pathname: row.pathname || "/",
        query_string: row.query_string || "",
        hash_fragment: row.hash_fragment || "",
        title: "",
        hostname: row.hostname || "",
        referer: row.referer || "",
        referer_host: row.referer_host || "",
        visitor_id: row.visitor_id || "",
        session_id: row.session_id || "",
        duration_ms: row.duration_ms ?? 0,
        country: row.country || "",
        region: row.region || "",
        city: row.city || "",
        browser: row.browser || "",
        os: row.os || "",
        device_type: row.device_type || "",
        language: row.language || "",
        timezone: row.timezone || "",
      });
    }
  }

  if (window.hasD1Detail) {
    const rows = await env.DB.prepare(
      `
        SELECT
          id,
          event_type,
          event_at,
          pathname,
          query_string,
          hash_fragment,
          title,
          hostname,
          referer,
          referer_host,
          visitor_id,
          session_id,
          duration_ms,
          country,
          region,
          city,
          browser,
          os,
          device_type,
          language,
          timezone
        FROM pageviews
        WHERE site_id = ? AND event_at BETWEEN ? AND ?${d1FilterSql.clause}
        ORDER BY event_at DESC
        LIMIT ?
      `,
    )
      .bind(siteId, window.d1DetailFromMs, window.d1DetailToMs, ...d1FilterSql.bindings, limit)
      .all<Record<string, unknown>>();
    merged.push(...rows.results);
  }

  return merged
    .sort((a, b) => Number(b.event_at ?? 0) - Number(a.event_at ?? 0))
    .slice(0, limit);
}

async function querySessionDetails(
  env: Env,
  siteId: string,
  window: QueryWindow,
  limit: number,
  filters: DashboardFilters,
): Promise<
  Array<{
    sessionId: string;
    visitorId: string;
    startedAt: number;
    endedAt: number;
    views: number;
    totalDurationMs: number;
    countries: number;
    entryPath: string;
    exitPath: string;
  }>
> {
  if (!window.hasD1Detail && !window.hasAnalytics) {
    return [];
  }
  const d1FilterSql = buildD1FilterSql(filters);

  const merged = new Map<
    string,
    {
      sessionId: string;
      visitorId: string;
      startedAt: number;
      endedAt: number;
      views: number;
      totalDurationMs: number;
      countries: number;
      entryPath: string;
      exitPath: string;
    }
  >();

  if (window.hasAnalytics) {
    const aeRows = await queryAeSessionDetails(
      env,
      siteId,
      {
        fromMs: window.analyticsFromMs,
        toMs: window.analyticsToMs,
      },
      limit,
      filters,
    );
    for (const row of aeRows) {
      const key = row.session_id || "";
      if (!key) continue;
      merged.set(key, {
        sessionId: key,
        visitorId: row.visitor_id || "",
        startedAt: row.started_at ?? 0,
        endedAt: row.ended_at ?? 0,
        views: row.views ?? 0,
        totalDurationMs: row.total_duration ?? 0,
        countries: row.countries ?? 0,
        entryPath: row.entry_path || "",
        exitPath: row.exit_path || "",
      });
    }
  }

  if (window.hasD1Detail) {
    const rows = await env.DB.prepare(
      `
        WITH filtered AS (
          SELECT *
          FROM pageviews
          WHERE site_id = ? AND event_at BETWEEN ? AND ?${d1FilterSql.clause}
        )
        SELECT
          p.session_id AS session_id,
          MIN(p.visitor_id) AS visitor_id,
          MIN(p.event_at) AS started_at,
          MAX(p.event_at) AS ended_at,
          COUNT(*) AS views,
          SUM(COALESCE(p.duration_ms, 0)) AS total_duration,
          COUNT(DISTINCT p.country) AS countries,
          (
            SELECT p2.pathname
            FROM filtered p2
            WHERE p2.session_id = p.session_id
            ORDER BY p2.event_at ASC
            LIMIT 1
          ) AS entry_path,
          (
            SELECT p3.pathname
            FROM filtered p3
            WHERE p3.session_id = p.session_id
            ORDER BY p3.event_at DESC
            LIMIT 1
          ) AS exit_path
        FROM filtered p
        GROUP BY p.session_id
        ORDER BY started_at DESC
        LIMIT ?
      `,
    )
      .bind(siteId, window.d1DetailFromMs, window.d1DetailToMs, ...d1FilterSql.bindings, limit)
      .all<{
        session_id: string;
        visitor_id: string;
        started_at: number;
        ended_at: number;
        views: number;
        total_duration: number;
        countries: number;
        entry_path: string;
        exit_path: string;
      }>();

    for (const row of rows.results) {
      const key = row.session_id;
      const prev = merged.get(key);
      if (!prev) {
        merged.set(key, {
          sessionId: key,
          visitorId: row.visitor_id,
          startedAt: row.started_at,
          endedAt: row.ended_at,
          views: row.views,
          totalDurationMs: row.total_duration,
          countries: row.countries,
          entryPath: row.entry_path ?? "",
          exitPath: row.exit_path ?? "",
        });
        continue;
      }
      merged.set(key, {
        sessionId: key,
        visitorId: prev.visitorId || row.visitor_id,
        startedAt: Math.min(prev.startedAt, row.started_at),
        endedAt: Math.max(prev.endedAt, row.ended_at),
        views: prev.views + row.views,
        totalDurationMs: prev.totalDurationMs + row.total_duration,
        countries: Math.max(prev.countries, row.countries),
        entryPath: prev.startedAt <= row.started_at ? prev.entryPath : (row.entry_path ?? ""),
        exitPath: prev.endedAt >= row.ended_at ? prev.exitPath : (row.exit_path ?? ""),
      });
    }
  }

  return Array.from(merged.values())
    .sort((a, b) => b.startedAt - a.startedAt)
    .slice(0, limit);
}

async function queryVisitorDetails(
  env: Env,
  siteId: string,
  window: QueryWindow,
  limit: number,
  filters: DashboardFilters,
): Promise<
  Array<{
    visitorId: string;
    firstSeenAt: number;
    lastSeenAt: number;
    views: number;
    sessions: number;
  }>
> {
  if (!window.hasD1Detail && !window.hasAnalytics) {
    return [];
  }
  const d1FilterSql = buildD1FilterSql(filters);

  const merged = new Map<
    string,
    {
      visitorId: string;
      firstSeenAt: number;
      lastSeenAt: number;
      views: number;
      sessions: number;
    }
  >();

  if (window.hasAnalytics) {
    const aeRows = await queryAeVisitorDetails(
      env,
      siteId,
      {
        fromMs: window.analyticsFromMs,
        toMs: window.analyticsToMs,
      },
      limit,
      filters,
    );
    for (const row of aeRows) {
      const key = row.visitor_id || "";
      if (!key) continue;
      merged.set(key, {
        visitorId: key,
        firstSeenAt: row.first_seen_at ?? 0,
        lastSeenAt: row.last_seen_at ?? 0,
        views: row.views ?? 0,
        sessions: row.sessions ?? 0,
      });
    }
  }

  if (window.hasD1Detail) {
    const rows = await env.DB.prepare(
      `
        WITH filtered AS (
          SELECT *
          FROM pageviews
          WHERE site_id = ? AND event_at BETWEEN ? AND ?${d1FilterSql.clause}
        )
        SELECT
          p.visitor_id AS visitor_id,
          MIN(p.event_at) AS first_seen_at,
          MAX(p.event_at) AS last_seen_at,
          COUNT(*) AS views,
          COUNT(DISTINCT p.session_id) AS sessions
        FROM filtered p
        GROUP BY p.visitor_id
        ORDER BY last_seen_at DESC
        LIMIT ?
      `,
    )
      .bind(siteId, window.d1DetailFromMs, window.d1DetailToMs, ...d1FilterSql.bindings, limit)
      .all<{
        visitor_id: string;
        first_seen_at: number;
        last_seen_at: number;
        views: number;
        sessions: number;
      }>();

    for (const row of rows.results) {
      const key = row.visitor_id;
      const prev = merged.get(key);
      if (!prev) {
        merged.set(key, {
          visitorId: key,
          firstSeenAt: row.first_seen_at,
          lastSeenAt: row.last_seen_at,
          views: row.views,
          sessions: row.sessions,
        });
        continue;
      }
      merged.set(key, {
        visitorId: key,
        firstSeenAt: Math.min(prev.firstSeenAt, row.first_seen_at),
        lastSeenAt: Math.max(prev.lastSeenAt, row.last_seen_at),
        views: prev.views + row.views,
        sessions: prev.sessions + row.sessions,
      });
    }
  }

  return Array.from(merged.values())
    .sort((a, b) => b.lastSeenAt - a.lastSeenAt)
    .slice(0, limit);
}

function emptyOverviewMetrics(): {
  views: number;
  sessions: number;
  visitors: number;
  bounces: number;
  totalDurationMs: number;
  avgDurationMs: number;
  bounceRate: number;
  approximateVisitors: boolean;
} {
  return {
    views: 0,
    sessions: 0,
    visitors: 0,
    bounces: 0,
    totalDurationMs: 0,
    avgDurationMs: 0,
    bounceRate: 0,
    approximateVisitors: false,
  };
}

function buildSiteIdBindings(siteIds: string[]): string[] {
  return Array.from(
    new Set(
      siteIds
        .map((siteId) => String(siteId || "").trim())
        .filter((siteId) => siteId.length > 0),
    ),
  );
}

async function queryOverviewBySites(
  env: Env,
  siteIds: string[],
  window: QueryWindow,
): Promise<
  Map<
    string,
    {
      views: number;
      sessions: number;
      visitors: number;
      bounces: number;
      totalDurationMs: number;
      avgDurationMs: number;
      bounceRate: number;
      approximateVisitors: boolean;
    }
  >
> {
  const normalizedSiteIds = buildSiteIdBindings(siteIds);
  const result = new Map<
    string,
    {
      views: number;
      sessions: number;
      visitors: number;
      bounces: number;
      totalDurationMs: number;
      avgDurationMs: number;
      bounceRate: number;
      approximateVisitors: boolean;
    }
  >();

  if (normalizedSiteIds.length === 0) {
    return result;
  }

  for (const siteId of normalizedSiteIds) {
    result.set(siteId, emptyOverviewMetrics());
  }

  const placeholders = normalizedSiteIds.map(() => "?").join(",");
  const includeArchive = window.hasArchive;

  if (window.hasAnalytics) {
    const aeRows = await queryAeOverviewBySites(
      env,
      normalizedSiteIds,
      {
        fromMs: window.analyticsFromMs,
        toMs: window.analyticsToMs,
      },
      {},
    );
    for (const row of aeRows) {
      const siteId = String(row.site_id || "");
      if (!siteId || !result.has(siteId)) continue;
      const prev = result.get(siteId) ?? emptyOverviewMetrics();
      result.set(siteId, {
        ...prev,
        views: prev.views + (row.views ?? 0),
        sessions: prev.sessions + (row.sessions ?? 0),
        visitors: prev.visitors + (row.visitors ?? 0),
        bounces: prev.bounces + (row.bounces ?? 0),
        totalDurationMs: prev.totalDurationMs + (row.total_duration ?? 0),
      });
    }
  }

  if (window.hasD1Detail) {
    const d1Rows = await env.DB.prepare(
      `
        SELECT
          site_id,
          COUNT(*) AS views,
          COUNT(DISTINCT session_id) AS sessions,
          COUNT(DISTINCT visitor_id) AS visitors,
          SUM(CASE WHEN COALESCE(duration_ms, 0) <= 0 THEN 1 ELSE 0 END) AS bounces,
          SUM(COALESCE(duration_ms, 0)) AS total_duration
        FROM pageviews
        WHERE site_id IN (${placeholders}) AND event_at BETWEEN ? AND ?
        GROUP BY site_id
      `,
    )
      .bind(...normalizedSiteIds, window.d1DetailFromMs, window.d1DetailToMs)
      .all<{
        site_id: string;
        views: number;
        sessions: number;
        visitors: number;
        bounces: number;
        total_duration: number;
      }>();

    for (const row of d1Rows.results) {
      const siteId = String(row.site_id || "");
      if (!siteId || !result.has(siteId)) continue;
      const prev = result.get(siteId) ?? emptyOverviewMetrics();
      result.set(siteId, {
        ...prev,
        views: prev.views + (row.views ?? 0),
        sessions: prev.sessions + (row.sessions ?? 0),
        visitors: prev.visitors + (row.visitors ?? 0),
        bounces: prev.bounces + (row.bounces ?? 0),
        totalDurationMs: prev.totalDurationMs + (row.total_duration ?? 0),
      });
    }
  }

  if (includeArchive) {
    const archiveRows = await env.DB.prepare(
      `
        WITH archive_rows AS (
          SELECT
            site_id,
            total_views,
            total_sessions,
            bounces,
            total_duration,
            visitors_json
          FROM pageviews_archive_hourly
          WHERE site_id IN (${placeholders}) AND hour_bucket BETWEEN ? AND ?
        ),
        aggregate AS (
          SELECT
            site_id,
            COALESCE(SUM(total_views), 0) AS views,
            COALESCE(SUM(total_sessions), 0) AS sessions,
            COALESCE(SUM(bounces), 0) AS bounces,
            COALESCE(SUM(total_duration), 0) AS total_duration
          FROM archive_rows
          GROUP BY site_id
        ),
        visitor_aggregate AS (
          SELECT
            archive_rows.site_id AS site_id,
            COUNT(DISTINCT je.value) AS visitors
          FROM archive_rows
          JOIN json_each(archive_rows.visitors_json) je
          WHERE typeof(je.value) = 'text' AND je.value != ''
          GROUP BY archive_rows.site_id
        )
        SELECT
          aggregate.site_id AS site_id,
          aggregate.views AS views,
          aggregate.sessions AS sessions,
          aggregate.bounces AS bounces,
          aggregate.total_duration AS total_duration,
          COALESCE(visitor_aggregate.visitors, 0) AS visitors
        FROM aggregate
        LEFT JOIN visitor_aggregate ON visitor_aggregate.site_id = aggregate.site_id
      `,
    )
      .bind(...normalizedSiteIds, window.archiveFromHour, window.archiveToHour)
      .all<{
        site_id: string;
        views: number;
        sessions: number;
        bounces: number;
        total_duration: number;
        visitors: number;
      }>();

    for (const row of archiveRows.results) {
      const siteId = String(row.site_id || "");
      if (!siteId || !result.has(siteId)) continue;
      const prev = result.get(siteId) ?? emptyOverviewMetrics();
      result.set(siteId, {
        ...prev,
        views: prev.views + (row.views ?? 0),
        sessions: prev.sessions + (row.sessions ?? 0),
        visitors: prev.visitors + (row.visitors ?? 0),
        bounces: prev.bounces + (row.bounces ?? 0),
        totalDurationMs: prev.totalDurationMs + (row.total_duration ?? 0),
      });
    }
  }

  for (const siteId of normalizedSiteIds) {
    const value = result.get(siteId) ?? emptyOverviewMetrics();
    result.set(siteId, {
      ...value,
      avgDurationMs: value.views > 0 ? Math.round(value.totalDurationMs / value.views) : 0,
      bounceRate: value.views > 0 ? Number((value.bounces / value.views).toFixed(6)) : 0,
      approximateVisitors: includeArchive,
    });
  }

  return result;
}

async function queryTrendBySites(
  env: Env,
  siteIds: string[],
  window: QueryWindow,
  interval: "minute" | "hour" | "day" | "week" | "month",
): Promise<
  Map<
    string,
    Array<{
      bucket: number;
      timestampMs: number;
      views: number;
      visitors: number;
    }>
  >
> {
  const normalizedSiteIds = buildSiteIdBindings(siteIds);
  const siteBuckets = new Map<string, Map<number, { views: number; visitors: number }>>();
  if (normalizedSiteIds.length === 0) {
    return new Map();
  }

  const placeholders = normalizedSiteIds.map(() => "?").join(",");
  const bucketMs = intervalBucketMs(interval);
  const bucketDivisor = interval === "hour"
    ? 1
    : interval === "day"
      ? 24
      : interval === "week"
        ? 168
        : interval === "month"
          ? 720
          : 0;
  const includeArchive = window.hasArchive && interval !== "minute";

  const addPoint = (siteId: string, bucket: number, views: number, visitors: number) => {
    if (!siteId || !Number.isFinite(bucket)) return;
    const bucketMap = siteBuckets.get(siteId) ?? new Map<number, { views: number; visitors: number }>();
    const prev = bucketMap.get(bucket) ?? { views: 0, visitors: 0 };
    bucketMap.set(bucket, {
      views: prev.views + Math.max(0, views),
      visitors: prev.visitors + Math.max(0, visitors),
    });
    siteBuckets.set(siteId, bucketMap);
  };

  if (window.hasAnalytics) {
    const aeRows = await queryAeTrendBySites(
      env,
      normalizedSiteIds,
      {
        fromMs: window.analyticsFromMs,
        toMs: window.analyticsToMs,
      },
      interval,
      {},
    );
    for (const row of aeRows) {
      addPoint(row.site_id, row.bucket, row.views ?? 0, row.visitors ?? 0);
    }
  }

  if (window.hasD1Detail) {
    const d1Rows = await env.DB.prepare(
      `
        SELECT
          site_id,
          CAST(event_at / ${bucketMs} AS INTEGER) AS bucket,
          COUNT(*) AS views,
          COUNT(DISTINCT visitor_id) AS visitors
        FROM pageviews
        WHERE site_id IN (${placeholders}) AND event_at BETWEEN ? AND ?
        GROUP BY site_id, bucket
      `,
    )
      .bind(...normalizedSiteIds, window.d1DetailFromMs, window.d1DetailToMs)
      .all<{
        site_id: string;
        bucket: number;
        views: number;
        visitors: number;
      }>();

    for (const row of d1Rows.results) {
      addPoint(row.site_id, row.bucket, row.views ?? 0, row.visitors ?? 0);
    }
  }

  if (includeArchive) {
    const archiveRows = await env.DB.prepare(
      `
        WITH archive_rows AS (
          SELECT
            site_id,
            CAST(hour_bucket / ? AS INTEGER) AS bucket,
            total_views,
            visitors_json
          FROM pageviews_archive_hourly
          WHERE site_id IN (${placeholders}) AND hour_bucket BETWEEN ? AND ?
        ),
        aggregate AS (
          SELECT
            site_id,
            bucket,
            SUM(total_views) AS views
          FROM archive_rows
          GROUP BY site_id, bucket
        ),
        visitor_aggregate AS (
          SELECT
            archive_rows.site_id AS site_id,
            archive_rows.bucket AS bucket,
            COUNT(DISTINCT je.value) AS visitors
          FROM archive_rows
          JOIN json_each(archive_rows.visitors_json) je
          WHERE typeof(je.value) = 'text' AND je.value != ''
          GROUP BY archive_rows.site_id, archive_rows.bucket
        )
        SELECT
          aggregate.site_id AS site_id,
          aggregate.bucket AS bucket,
          aggregate.views AS views,
          COALESCE(visitor_aggregate.visitors, 0) AS visitors
        FROM aggregate
        LEFT JOIN visitor_aggregate
          ON visitor_aggregate.site_id = aggregate.site_id
         AND visitor_aggregate.bucket = aggregate.bucket
      `,
    )
      .bind(bucketDivisor, ...normalizedSiteIds, window.archiveFromHour, window.archiveToHour)
      .all<{
        site_id: string;
        bucket: number;
        views: number;
        visitors: number;
      }>();

    for (const row of archiveRows.results) {
      addPoint(row.site_id, row.bucket, row.views ?? 0, row.visitors ?? 0);
    }
  }

  const result = new Map<
    string,
    Array<{
      bucket: number;
      timestampMs: number;
      views: number;
      visitors: number;
    }>
  >();

  for (const siteId of normalizedSiteIds) {
    const bucketMap = siteBuckets.get(siteId);
    if (!bucketMap || bucketMap.size === 0) {
      result.set(siteId, []);
      continue;
    }
    result.set(
      siteId,
      Array.from(bucketMap.entries())
        .sort((a, b) => a[0] - b[0])
        .map(([bucket, value]) => ({
          bucket,
          timestampMs: bucket * bucketMs,
          views: value.views,
          visitors: value.visitors,
        })),
    );
  }

  return result;
}

function intervalBucketMs(interval: "minute" | "hour" | "day" | "week" | "month"): number {
  if (interval === "minute") return 60 * 1000;
  if (interval === "hour") return ONE_HOUR_MS;
  if (interval === "day") return ONE_DAY_MS;
  if (interval === "week") return 7 * ONE_DAY_MS;
  return 30 * ONE_DAY_MS;
}

async function queryTeamDashboard(
  env: Env,
  teamId: string,
  window: QueryWindow,
  interval: "minute" | "hour" | "day" | "week" | "month",
): Promise<{
  sites: Array<
    TeamSiteRow & {
      overview: {
        views: number;
        sessions: number;
        visitors: number;
        bounces: number;
        totalDurationMs: number;
        avgDurationMs: number;
        bounceRate: number;
        approximateVisitors: boolean;
      };
      changeRates: {
        views: number | null;
        visitors: number | null;
        sessions: number | null;
        bounceRate: number | null;
        avgDurationMs: number | null;
        pagesPerSession: number | null;
      };
    }
  >;
  trend: Array<{
    bucket: number;
    timestampMs: number;
    sites: Array<{
      siteId: string;
      views: number;
      visitors: number;
    }>;
  }>;
}> {
  const sitesResult = await env.DB.prepare(
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

  const siteRows = sitesResult.results;
  if (siteRows.length === 0) {
    return { sites: [], trend: [] };
  }

  const windowSpanMs = Math.max(0, window.toMs - window.fromMs);
  const previousToMs = window.fromMs - 1;
  const previousFromMs = previousToMs - windowSpanMs;
  const previousWindow = previousToMs >= 0
    ? buildWindowFromRange(
      env,
      Math.max(0, previousFromMs),
      Math.max(0, previousToMs),
      window.nowMs,
    )
    : null;

  const siteIds = siteRows.map((site) => site.id);
  const [overviewBySite, trendBySite, previousOverviewBySite] = await Promise.all([
    queryOverviewBySites(env, siteIds, window).catch(() => new Map()),
    queryTrendBySites(env, siteIds, window, interval).catch(() => new Map()),
    previousWindow
      ? queryOverviewBySites(env, siteIds, previousWindow).catch(() => new Map())
      : Promise.resolve(new Map()),
  ]);

  const siteStats = siteRows.map((site) => {
    const overview = overviewBySite.get(site.id) ?? emptyOverviewMetrics();
    const trend = trendBySite.get(site.id) ?? [];
    const previousOverview = previousOverviewBySite.get(site.id) ?? emptyOverviewMetrics();
    const currentPagesPerSession = overview.sessions > 0 ? overview.views / overview.sessions : 0;
    const previousPagesPerSession = previousOverview.sessions > 0
      ? previousOverview.views / previousOverview.sessions
      : 0;
    return {
      site,
      overview,
      trend,
      changeRates: {
        views: toPercentChange(overview.views, previousOverview.views),
        visitors: toPercentChange(overview.visitors, previousOverview.visitors),
        sessions: toPercentChange(overview.sessions, previousOverview.sessions),
        bounceRate: toPercentChange(overview.bounceRate, previousOverview.bounceRate),
        avgDurationMs: toPercentChange(overview.avgDurationMs, previousOverview.avgDurationMs),
        pagesPerSession: toPercentChange(currentPagesPerSession, previousPagesPerSession),
      },
    };
  });

  const bucketMs = intervalBucketMs(interval);
  const fromBucket = Math.floor(window.fromMs / bucketMs);
  const toBucket = Math.max(fromBucket, Math.floor(window.toMs / bucketMs));

  const trendByBucket = new Map<
    number,
    {
      bucket: number;
      timestampMs: number;
      sites: Map<string, { views: number; visitors: number }>;
    }
  >();

  for (let bucket = fromBucket; bucket <= toBucket; bucket += 1) {
    trendByBucket.set(bucket, {
      bucket,
      timestampMs: bucket * bucketMs,
      sites: new Map(),
    });
  }

  for (const siteStat of siteStats) {
    for (const point of siteStat.trend) {
      const bucket = Number.isFinite(point.bucket)
        ? point.bucket
        : Math.floor(point.timestampMs / bucketMs);
      const entry = trendByBucket.get(bucket) ?? {
        bucket,
        timestampMs: point.timestampMs,
        sites: new Map<string, { views: number; visitors: number }>(),
      };
      entry.sites.set(siteStat.site.id, {
        views: point.views ?? 0,
        visitors: point.visitors ?? 0,
      });
      trendByBucket.set(bucket, entry);
    }
  }

  const trend = Array.from(trendByBucket.values())
    .sort((a, b) => a.bucket - b.bucket)
    .map((point) => ({
      bucket: point.bucket,
      timestampMs: point.timestampMs,
      sites: Array.from(point.sites.entries()).map(([siteId, value]) => ({
        siteId,
        views: value.views,
        visitors: value.visitors,
      })),
    }));

  const sites = siteStats.map((siteStat) => ({
    ...siteStat.site,
    overview: siteStat.overview,
    changeRates: siteStat.changeRates,
  }));

  return {
    sites,
    trend,
  };
}

function requireSiteId(url: URL): string | null {
  const siteId = (url.searchParams.get("siteId") || "").trim();
  return siteId.length > 0 ? siteId : null;
}

export async function handlePrivateQuery(request: Request, env: Env, url: URL): Promise<Response> {
  if (request.method !== "GET") {
    return notAllowed();
  }
  const session = await requireSession(request, env);
  if (!session) {
    return unauthorized();
  }

  const pathname = url.pathname;

  if (pathname === "/api/private/team-dashboard") {
    const teamId = (url.searchParams.get("teamId") || "").trim();
    if (!teamId) {
      return badRequest("Missing teamId");
    }

    const allowed = session.systemRole === "admin"
      ? true
      : await assertTeamMembership(env, teamId, session.userId);
    if (!allowed) {
      return unauthorized("Team access denied for current user");
    }

    const window = parseWindow(url, env);
    if (!window) {
      return badRequest("Invalid time window");
    }
    if (window.hasAnalytics && !isAnalyticsSqlConfigured(env)) {
      return jsonResponse(
        {
          ok: false,
          error: "Analytics Engine SQL not configured for 0-90 day queries",
          required: ["ANALYTICS_ACCOUNT_ID", "ANALYTICS_SQL_API_TOKEN"],
        },
        500,
      );
    }

    const interval = parseInterval(url);
    const data = await queryTeamDashboard(env, teamId, window, interval);
    return jsonResponse(
      {
        ok: true,
        teamId,
        fromMs: window.fromMs,
        toMs: window.toMs,
        interval,
        data,
      },
      200,
      {
        "cache-control": "private, max-age=300",
        vary: "Cookie",
      },
    );
  }

  const siteId = requireSiteId(url);
  if (!siteId) {
    return badRequest("Missing siteId");
  }

  const allowed = session.systemRole === "admin" ? true : await assertSiteMembership(env, siteId, session.userId);
  if (!allowed) {
    return unauthorized("Site access denied for current user");
  }

  const window = parseWindow(url, env);
  if (!window) {
    return badRequest("Invalid time window");
  }
  if (window.hasAnalytics && !isAnalyticsSqlConfigured(env)) {
    return jsonResponse(
      {
        ok: false,
        error: "Analytics Engine SQL not configured for 0-90 day queries",
        required: ["ANALYTICS_ACCOUNT_ID", "ANALYTICS_SQL_API_TOKEN"],
      },
      500,
    );
  }
  const filters = parseFilters(url);

  if (pathname === "/api/private/overview") {
    const includeChange = parseBooleanSearchParam(url, "includeChange");
    const includeDetail = parseBooleanSearchParam(url, "includeDetail");
    const detailInterval = parseInterval(url);
    if (!includeChange) {
      const [overview, detail] = await Promise.all([
        queryOverview(env, siteId, window, filters),
        includeDetail
          ? queryTrend(env, siteId, window, detailInterval, filters)
          : Promise.resolve(null),
      ]);

      return jsonResponse({
        ok: true,
        siteId,
        fromMs: window.fromMs,
        toMs: window.toMs,
        data: overview,
        ...(includeDetail
          ? {
            detail: {
              interval: detailInterval,
              data: detail ?? [],
            },
          }
          : {}),
      });
    }

    const spanMs = Math.max(0, window.toMs - window.fromMs);
    const previousToMs = Math.max(window.fromMs - 1, 0);
    const previousFromMs = Math.max(previousToMs - spanMs, 0);
    const previousWindow = buildWindowFromRange(
      env,
      previousFromMs,
      previousToMs,
      window.nowMs,
    );
    const [overview, previousOverview, detail] = await Promise.all([
      queryOverview(env, siteId, window, filters),
      previousWindow
        ? queryOverview(env, siteId, previousWindow, filters)
        : Promise.resolve(emptyOverviewMetrics()),
      includeDetail
        ? queryTrend(env, siteId, window, detailInterval, filters)
        : Promise.resolve(null),
    ]);

    return jsonResponse({
      ok: true,
      siteId,
      fromMs: window.fromMs,
      toMs: window.toMs,
      data: overview,
      previousData: previousOverview,
      ...(includeDetail
        ? {
          detail: {
            interval: detailInterval,
            data: detail ?? [],
          },
        }
        : {}),
      changeRates: {
        views: toPercentChange(overview.views, previousOverview.views),
        sessions: toPercentChange(overview.sessions, previousOverview.sessions),
        visitors: toPercentChange(overview.visitors, previousOverview.visitors),
        bounces: toPercentChange(overview.bounces, previousOverview.bounces),
        bounceRate: toPercentChange(overview.bounceRate, previousOverview.bounceRate),
        avgDurationMs: toPercentChange(overview.avgDurationMs, previousOverview.avgDurationMs),
      },
    });
  }

  if (pathname === "/api/private/trend") {
    const interval = parseInterval(url);
    const data = await queryTrend(env, siteId, window, interval, filters);
    return jsonResponse({
      ok: true,
      siteId,
      fromMs: window.fromMs,
      toMs: window.toMs,
      interval,
      data,
    });
  }

  if (pathname === "/api/private/pages") {
    const limit = parseLimit(url, 30, 200);
    const tabs = await queryPageCardTabs(env, siteId, window, limit, filters);
    const data = tabs.path.map((item) => ({
      pathname: item.label,
      views: item.views,
      sessions: item.sessions,
    }));
    return jsonResponse({
      ok: true,
      siteId,
      fromMs: window.fromMs,
      toMs: window.toMs,
      data,
      tabs,
    });
  }

  if (pathname === "/api/private/referrers") {
    const limit = parseLimit(url, 30, 200);
    const includeFullUrl = (url.searchParams.get("fullUrl") || "0") !== "0";
    const data = await queryReferrers(env, siteId, window, limit, includeFullUrl, filters);
    return jsonResponse({
      ok: true,
      siteId,
      fromMs: window.fromMs,
      toMs: window.toMs,
      data,
    });
  }

  if (pathname === "/api/private/overview-client-dimensions") {
    const limit = parseLimit(url, 100, 300);
    const tabs = await queryOverviewClientDimensionTabs(
      env,
      siteId,
      window,
      limit,
      filters,
    );
    return jsonResponse({
      ok: true,
      siteId,
      fromMs: window.fromMs,
      toMs: window.toMs,
      tabs,
    });
  }

  if (pathname === "/api/private/overview-geo-dimensions") {
    const limit = parseLimit(url, 100, 300);
    const tabs = await queryOverviewGeoDimensionTabs(
      env,
      siteId,
      window,
      limit,
      filters,
    );
    return jsonResponse({
      ok: true,
      siteId,
      fromMs: window.fromMs,
      toMs: window.toMs,
      tabs,
    });
  }

  if (pathname === "/api/private/visitors") {
    const limit = parseLimit(url, 50, 500);
    const data = await queryVisitorDetails(env, siteId, window, limit, filters);
    return jsonResponse({
      ok: true,
      siteId,
      fromMs: window.fromMs,
      toMs: window.toMs,
      data,
    });
  }

  if (pathname === "/api/private/countries") {
    const limit = parseLimit(url, 20, 200);
    const data = await queryDimensionStats(env, siteId, window, limit, filters, {
      d1DimensionKey: "country",
      archiveDimensionKey: "country_stats_json",
      aeQuery: queryAeTopCountries,
    });
    return jsonResponse({
      ok: true,
      siteId,
      fromMs: window.fromMs,
      toMs: window.toMs,
      data,
    });
  }

  if (pathname === "/api/private/devices") {
    const limit = parseLimit(url, 20, 200);
    const data = await queryDimensionStats(env, siteId, window, limit, filters, {
      d1DimensionKey: "device_type",
      archiveDimensionKey: "device_stats_json",
      aeQuery: queryAeTopDevices,
    });
    return jsonResponse({
      ok: true,
      siteId,
      fromMs: window.fromMs,
      toMs: window.toMs,
      data,
    });
  }

  if (pathname === "/api/private/browsers") {
    const limit = parseLimit(url, 20, 200);
    const data = await queryDimensionStats(env, siteId, window, limit, filters, {
      d1DimensionKey: "browser",
      archiveDimensionKey: "browser_stats_json",
      aeQuery: queryAeTopBrowsers,
    });
    return jsonResponse({
      ok: true,
      siteId,
      fromMs: window.fromMs,
      toMs: window.toMs,
      data,
    });
  }

  if (pathname === "/api/private/event-types") {
    const limit = parseLimit(url, 20, 200);
    const data = await queryDimensionStats(env, siteId, window, limit, filters, {
      d1DimensionKey: "event_type",
      archiveDimensionKey: null,
      aeQuery: queryAeTopEventTypes,
    });
    return jsonResponse({
      ok: true,
      siteId,
      fromMs: window.fromMs,
      toMs: window.toMs,
      data,
    });
  }

  return notFound();
}

export async function handlePublicQuery(request: Request, env: Env, url: URL): Promise<Response> {
  if (request.method !== "GET") {
    return notAllowed();
  }

  const parts = url.pathname.split("/").filter(Boolean);
  // /api/public/{slug}/{resource}
  if (parts.length < 4) {
    return badRequest("Invalid public route");
  }

  const slug = parts[2];
  const resource = parts[3];
  const site = await resolvePublicSiteBySlug(env, slug);
  if (!site) {
    return notFound("Public site not found");
  }

  const window = parseWindow(url, env);
  if (!window) {
    return badRequest("Invalid time window");
  }
  if (window.hasAnalytics && !isAnalyticsSqlConfigured(env)) {
    return jsonResponse(
      {
        ok: false,
        error: "Analytics Engine SQL not configured for 0-90 day queries",
      },
      500,
      {
        "cache-control": "no-store",
        "access-control-allow-origin": "*",
      },
    );
  }

  const cacheHeaders = {
    "cache-control": "public, max-age=60, s-maxage=60",
    "access-control-allow-origin": "*",
  };

  if (resource === "overview") {
    const overview = await queryOverview(env, site.id, window, {});
    return jsonResponse(
      {
        ok: true,
        site: {
          slug,
          name: site.name,
          domain: site.domain,
        },
        fromMs: window.fromMs,
        toMs: window.toMs,
        data: overview,
        privacy: {
          queryHashDetails: "hidden",
          visitorTrajectories: "hidden",
          detailedReferrerUrl: "hidden",
        },
      },
      200,
      cacheHeaders,
    );
  }

  if (resource === "trend") {
    const interval = parseInterval(url);
    const data = await queryTrend(env, site.id, window, interval, {});
    return jsonResponse(
      {
        ok: true,
        site: {
          slug,
          name: site.name,
          domain: site.domain,
        },
        fromMs: window.fromMs,
        toMs: window.toMs,
        interval,
        data,
      },
      200,
      cacheHeaders,
    );
  }

  if (resource === "pages") {
    const limit = parseLimit(url, 30, 200);
    const data = await queryTopPages(env, site.id, window, limit, false, {});
    return jsonResponse(
      {
        ok: true,
        site: {
          slug,
          name: site.name,
          domain: site.domain,
        },
        fromMs: window.fromMs,
        toMs: window.toMs,
        data,
      },
      200,
      cacheHeaders,
    );
  }

  if (resource === "referrers") {
    const limit = parseLimit(url, 30, 200);
    const data = await queryReferrers(env, site.id, window, limit, false, {});
    return jsonResponse(
      {
        ok: true,
        site: {
          slug,
          name: site.name,
          domain: site.domain,
        },
        fromMs: window.fromMs,
        toMs: window.toMs,
        data,
      },
      200,
      cacheHeaders,
    );
  }

  return notFound();
}
