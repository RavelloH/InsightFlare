import type { Env } from "./types";
import { ONE_DAY_MS, ONE_HOUR_MS, coerceNumber } from "./utils";

const RETENTION_DAYS = 365;

interface QueryWindow {
  fromMs: number;
  toMs: number;
  hasDetail: boolean;
  detailFromMs: number;
  detailToMs: number;
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

interface JsonObject {
  [key: string]: unknown;
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

function parseWindow(url: URL): QueryWindow | null {
  const now = Date.now();
  const defaultFrom = now - ONE_DAY_MS;
  const fromRaw = coerceNumber(url.searchParams.get("from"), defaultFrom);
  const toRaw = coerceNumber(url.searchParams.get("to"), now);
  const fromMs = Math.floor(fromRaw ?? defaultFrom);
  const toMs = Math.floor(toRaw ?? now);

  if (!Number.isFinite(fromMs) || !Number.isFinite(toMs) || fromMs < 0 || toMs < fromMs) {
    return null;
  }

  const retentionCutoffMs = now - RETENTION_DAYS * ONE_DAY_MS;

  const detailFromMs = Math.max(fromMs, retentionCutoffMs);
  const detailToMs = toMs;
  const hasDetail = detailFromMs <= detailToMs;

  const archiveToMs = Math.min(toMs, retentionCutoffMs - 1);
  const hasArchive = fromMs <= archiveToMs;
  const archiveFromHour = Math.floor(fromMs / ONE_HOUR_MS);
  const archiveToHour = Math.floor(archiveToMs / ONE_HOUR_MS);

  return {
    fromMs,
    toMs,
    hasDetail,
    detailFromMs,
    detailToMs,
    hasArchive,
    archiveFromHour,
    archiveToHour,
  };
}

function parseLimit(url: URL, defaultValue = 20, maxValue = 500): number {
  const n = coerceNumber(url.searchParams.get("limit"), defaultValue);
  if (!n || n <= 0) {
    return defaultValue;
  }
  return Math.min(maxValue, Math.floor(n));
}

function parseInterval(url: URL): "hour" | "day" {
  const raw = (url.searchParams.get("interval") || "hour").toLowerCase();
  return raw === "day" ? "day" : "hour";
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

function extractBearerToken(request: Request): string {
  const auth = request.headers.get("authorization") || "";
  if (auth.toLowerCase().startsWith("bearer ")) {
    return auth.slice(7).trim();
  }
  return "";
}

function isPrivateAuthorized(request: Request, env: Env): boolean {
  const expected = env.ADMIN_API_TOKEN;
  if (!expected || expected.length === 0) {
    // Dev bootstrap mode: allow when token is not configured.
    return true;
  }

  const fromBearer = extractBearerToken(request);
  const fromHeader = request.headers.get("x-admin-token") || "";
  return fromBearer === expected || fromHeader === expected;
}

function requiresTeamMembershipCheck(env: Env): boolean {
  return (env.REQUIRE_TEAM_MEMBERSHIP ?? "0") === "1";
}

function extractUserIdForMembership(request: Request): string {
  return (request.headers.get("x-user-id") || "").trim();
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

async function queryOverview(env: Env, siteId: string, window: QueryWindow): Promise<{
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

  if (window.hasDetail) {
    const detailed = await env.DB.prepare(
      `
        SELECT
          COUNT(*) AS views,
          COUNT(DISTINCT session_id) AS sessions,
          COUNT(DISTINCT visitor_id) AS visitors,
          SUM(CASE WHEN COALESCE(duration_ms, 0) <= 0 THEN 1 ELSE 0 END) AS bounces,
          SUM(COALESCE(duration_ms, 0)) AS total_duration
        FROM pageviews
        WHERE site_id = ? AND event_at BETWEEN ? AND ?
      `,
    )
      .bind(siteId, window.detailFromMs, window.detailToMs)
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

  if (window.hasArchive) {
    const archived = await env.DB.prepare(
      `
        SELECT
          SUM(total_views) AS views,
          SUM(total_sessions) AS sessions,
          SUM(bounces) AS bounces,
          SUM(total_duration) AS total_duration
        FROM pageviews_archive_hourly
        WHERE site_id = ? AND hour_bucket BETWEEN ? AND ?
      `,
    )
      .bind(siteId, window.archiveFromHour, window.archiveToHour)
      .first<{
        views: number | null;
        sessions: number | null;
        bounces: number | null;
        total_duration: number | null;
      }>();

    views += archived?.views ?? 0;
    sessions += archived?.sessions ?? 0;
    bounces += archived?.bounces ?? 0;
    totalDurationMs += archived?.total_duration ?? 0;

    // Visitors in archive rows are JSON arrays and can only be approximated cheaply.
    const visitorRows = await env.DB.prepare(
      `
        SELECT visitors_json
        FROM pageviews_archive_hourly
        WHERE site_id = ? AND hour_bucket BETWEEN ? AND ?
      `,
    )
      .bind(siteId, window.archiveFromHour, window.archiveToHour)
      .all<{ visitors_json: string | null }>();

    const visitorSet = new Set<string>();
    for (const row of visitorRows.results) {
      if (!row.visitors_json) continue;
      try {
        const ids = JSON.parse(row.visitors_json) as unknown;
        if (Array.isArray(ids)) {
          for (const id of ids) {
            if (typeof id === "string" && id.length > 0) {
              visitorSet.add(id);
            }
          }
        }
      } catch {
        // ignore malformed archive visitors_json
      }
    }
    visitors += visitorSet.size;
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
  interval: "hour" | "day",
): Promise<Array<{
  bucket: number;
  timestampMs: number;
  views: number;
  sessions: number;
  totalDurationMs: number;
  source: "detail" | "archive" | "mixed";
}>> {
  const bucketDivisor = interval === "hour" ? 1 : 24;
  const bucketMs = interval === "hour" ? ONE_HOUR_MS : ONE_DAY_MS;
  const buckets = new Map<
    number,
    { views: number; sessions: number; totalDurationMs: number; detail: boolean; archive: boolean }
  >();

  if (window.hasDetail) {
    const detailSql =
      interval === "hour"
        ? `
          SELECT
            CAST(event_at / 3600000 AS INTEGER) AS bucket,
            COUNT(*) AS views,
            COUNT(DISTINCT session_id) AS sessions,
            SUM(COALESCE(duration_ms, 0)) AS total_duration
          FROM pageviews
          WHERE site_id = ? AND event_at BETWEEN ? AND ?
          GROUP BY bucket
          ORDER BY bucket
        `
        : `
          SELECT
            CAST(event_at / 86400000 AS INTEGER) AS bucket,
            COUNT(*) AS views,
            COUNT(DISTINCT session_id) AS sessions,
            SUM(COALESCE(duration_ms, 0)) AS total_duration
          FROM pageviews
          WHERE site_id = ? AND event_at BETWEEN ? AND ?
          GROUP BY bucket
          ORDER BY bucket
        `;

    const detailRows = await env.DB.prepare(detailSql)
      .bind(siteId, window.detailFromMs, window.detailToMs)
      .all<{ bucket: number; views: number; sessions: number; total_duration: number }>();

    for (const row of detailRows.results) {
      const entry = buckets.get(row.bucket) ?? {
        views: 0,
        sessions: 0,
        totalDurationMs: 0,
        detail: false,
        archive: false,
      };
      entry.views += row.views ?? 0;
      entry.sessions += row.sessions ?? 0;
      entry.totalDurationMs += row.total_duration ?? 0;
      entry.detail = true;
      buckets.set(row.bucket, entry);
    }
  }

  if (window.hasArchive) {
    const archiveSql = `
      SELECT
        CAST(hour_bucket / ? AS INTEGER) AS bucket,
        SUM(total_views) AS views,
        SUM(total_sessions) AS sessions,
        SUM(total_duration) AS total_duration
      FROM pageviews_archive_hourly
      WHERE site_id = ? AND hour_bucket BETWEEN ? AND ?
      GROUP BY bucket
      ORDER BY bucket
    `;

    const archiveRows = await env.DB.prepare(archiveSql)
      .bind(bucketDivisor, siteId, window.archiveFromHour, window.archiveToHour)
      .all<{ bucket: number; views: number; sessions: number; total_duration: number }>();

    for (const row of archiveRows.results) {
      const entry = buckets.get(row.bucket) ?? {
        views: 0,
        sessions: 0,
        totalDurationMs: 0,
        detail: false,
        archive: false,
      };
      entry.views += row.views ?? 0;
      entry.sessions += row.sessions ?? 0;
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
      sessions: value.sessions,
      totalDurationMs: value.totalDurationMs,
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

async function queryTopPages(
  env: Env,
  siteId: string,
  window: QueryWindow,
  limit: number,
  includeQueryHashDetails: boolean,
): Promise<Array<{ pathname: string; query?: string; hash?: string; views: number; sessions: number }>> {
  const pageMap = new Map<string, { pathname: string; query?: string; hash?: string; views: number; sessions: number }>();

  if (window.hasDetail) {
    const sql = includeQueryHashDetails
      ? `
        SELECT
          pathname,
          COALESCE(query_string, '') AS query_string,
          COALESCE(hash_fragment, '') AS hash_fragment,
          COUNT(*) AS views,
          COUNT(DISTINCT session_id) AS sessions
        FROM pageviews
        WHERE site_id = ? AND event_at BETWEEN ? AND ?
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
        WHERE site_id = ? AND event_at BETWEEN ? AND ?
        GROUP BY pathname
        ORDER BY views DESC
        LIMIT ?
      `;

    if (includeQueryHashDetails) {
      const rows = await env.DB.prepare(sql)
        .bind(siteId, window.detailFromMs, window.detailToMs, limit)
        .all<{ pathname: string; query_string: string; hash_fragment: string; views: number; sessions: number }>();

      for (const row of rows.results) {
        const key = `${row.pathname}|${row.query_string}|${row.hash_fragment}`;
        pageMap.set(key, {
          pathname: row.pathname,
          query: row.query_string,
          hash: row.hash_fragment,
          views: row.views,
          sessions: row.sessions,
        });
      }
    } else {
      const rows = await env.DB.prepare(sql)
        .bind(siteId, window.detailFromMs, window.detailToMs, limit)
        .all<{ pathname: string; views: number; sessions: number }>();

      for (const row of rows.results) {
        const key = row.pathname;
        pageMap.set(key, {
          pathname: row.pathname,
          views: row.views,
          sessions: row.sessions,
        });
      }
    }
  }

  if (window.hasArchive) {
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

async function queryReferrers(
  env: Env,
  siteId: string,
  window: QueryWindow,
  limit: number,
  includeFullUrl: boolean,
): Promise<Array<{ referrer: string; views: number; sessions: number }>> {
  const keyField = includeFullUrl ? "referer" : "referer_host";
  const map = new Map<string, { referrer: string; views: number; sessions: number }>();

  if (window.hasDetail) {
    const sql = `
      SELECT
        COALESCE(${keyField}, '') AS ref,
        COUNT(*) AS views,
        COUNT(DISTINCT session_id) AS sessions
      FROM pageviews
      WHERE site_id = ? AND event_at BETWEEN ? AND ?
      GROUP BY ref
      ORDER BY views DESC
      LIMIT ?
    `;
    const rows = await env.DB.prepare(sql)
      .bind(siteId, window.detailFromMs, window.detailToMs, limit)
      .all<{ ref: string; views: number; sessions: number }>();

    for (const row of rows.results) {
      map.set(row.ref, {
        referrer: row.ref,
        views: row.views,
        sessions: row.sessions,
      });
    }
  }

  if (window.hasArchive) {
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

async function queryRecentEvents(env: Env, siteId: string, window: QueryWindow, limit: number): Promise<unknown[]> {
  if (!window.hasDetail) {
    return [];
  }
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
        timezone,
        bot_score,
        bot_verified,
        bot_security_json
      FROM pageviews
      WHERE site_id = ? AND event_at BETWEEN ? AND ?
      ORDER BY event_at DESC
      LIMIT ?
    `,
  )
    .bind(siteId, window.detailFromMs, window.detailToMs, limit)
    .all<Record<string, unknown>>();

  return rows.results;
}

async function querySessionDetails(
  env: Env,
  siteId: string,
  window: QueryWindow,
  limit: number,
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
  if (!window.hasDetail) {
    return [];
  }

  const rows = await env.DB.prepare(
    `
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
          FROM pageviews p2
          WHERE p2.site_id = p.site_id AND p2.session_id = p.session_id
          ORDER BY p2.event_at ASC
          LIMIT 1
        ) AS entry_path,
        (
          SELECT p3.pathname
          FROM pageviews p3
          WHERE p3.site_id = p.site_id AND p3.session_id = p.session_id
          ORDER BY p3.event_at DESC
          LIMIT 1
        ) AS exit_path
      FROM pageviews p
      WHERE p.site_id = ? AND p.event_at BETWEEN ? AND ?
      GROUP BY p.session_id
      ORDER BY started_at DESC
      LIMIT ?
    `,
  )
    .bind(siteId, window.detailFromMs, window.detailToMs, limit)
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

  return rows.results.map((row) => ({
    sessionId: row.session_id,
    visitorId: row.visitor_id,
    startedAt: row.started_at,
    endedAt: row.ended_at,
    views: row.views,
    totalDurationMs: row.total_duration,
    countries: row.countries,
    entryPath: row.entry_path ?? "",
    exitPath: row.exit_path ?? "",
  }));
}

async function queryVisitorDetails(
  env: Env,
  siteId: string,
  window: QueryWindow,
  limit: number,
): Promise<
  Array<{
    visitorId: string;
    firstSeenAt: number;
    lastSeenAt: number;
    views: number;
    sessions: number;
    countries: number;
    latestPath: string;
  }>
> {
  if (!window.hasDetail) {
    return [];
  }

  const rows = await env.DB.prepare(
    `
      SELECT
        p.visitor_id AS visitor_id,
        MIN(p.event_at) AS first_seen_at,
        MAX(p.event_at) AS last_seen_at,
        COUNT(*) AS views,
        COUNT(DISTINCT p.session_id) AS sessions,
        COUNT(DISTINCT p.country) AS countries,
        (
          SELECT p2.pathname
          FROM pageviews p2
          WHERE p2.site_id = p.site_id AND p2.visitor_id = p.visitor_id
          ORDER BY p2.event_at DESC
          LIMIT 1
        ) AS latest_path
      FROM pageviews p
      WHERE p.site_id = ? AND p.event_at BETWEEN ? AND ?
      GROUP BY p.visitor_id
      ORDER BY last_seen_at DESC
      LIMIT ?
    `,
  )
    .bind(siteId, window.detailFromMs, window.detailToMs, limit)
    .all<{
      visitor_id: string;
      first_seen_at: number;
      last_seen_at: number;
      views: number;
      sessions: number;
      countries: number;
      latest_path: string;
    }>();

  return rows.results.map((row) => ({
    visitorId: row.visitor_id,
    firstSeenAt: row.first_seen_at,
    lastSeenAt: row.last_seen_at,
    views: row.views,
    sessions: row.sessions,
    countries: row.countries,
    latestPath: row.latest_path ?? "",
  }));
}

function requireSiteId(url: URL): string | null {
  const siteId = (url.searchParams.get("siteId") || "").trim();
  return siteId.length > 0 ? siteId : null;
}

export async function handlePrivateQuery(request: Request, env: Env, url: URL): Promise<Response> {
  if (request.method !== "GET") {
    return notAllowed();
  }
  if (!isPrivateAuthorized(request, env)) {
    return unauthorized();
  }

  const siteId = requireSiteId(url);
  if (!siteId) {
    return badRequest("Missing siteId");
  }

  if (requiresTeamMembershipCheck(env)) {
    const userId = extractUserIdForMembership(request);
    if (!userId) {
      return unauthorized("Missing x-user-id for team membership check");
    }
    const allowed = await assertSiteMembership(env, siteId, userId);
    if (!allowed) {
      return unauthorized("Site access denied for current user");
    }
  }

  const window = parseWindow(url);
  if (!window) {
    return badRequest("Invalid time window");
  }

  const pathname = url.pathname;

  if (pathname === "/api/private/overview") {
    const overview = await queryOverview(env, siteId, window);
    return jsonResponse({
      ok: true,
      siteId,
      fromMs: window.fromMs,
      toMs: window.toMs,
      data: overview,
    });
  }

  if (pathname === "/api/private/trend") {
    const interval = parseInterval(url);
    const data = await queryTrend(env, siteId, window, interval);
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
    const includeDetails = (url.searchParams.get("details") || "1") !== "0";
    const data = await queryTopPages(env, siteId, window, limit, includeDetails);
    return jsonResponse({
      ok: true,
      siteId,
      fromMs: window.fromMs,
      toMs: window.toMs,
      data,
    });
  }

  if (pathname === "/api/private/referrers") {
    const limit = parseLimit(url, 30, 200);
    const includeFullUrl = (url.searchParams.get("fullUrl") || "1") !== "0";
    const data = await queryReferrers(env, siteId, window, limit, includeFullUrl);
    return jsonResponse({
      ok: true,
      siteId,
      fromMs: window.fromMs,
      toMs: window.toMs,
      data,
    });
  }

  if (pathname === "/api/private/events") {
    const limit = parseLimit(url, 50, 500);
    const data = await queryRecentEvents(env, siteId, window, limit);
    return jsonResponse({
      ok: true,
      siteId,
      fromMs: window.fromMs,
      toMs: window.toMs,
      data,
    });
  }

  if (pathname === "/api/private/sessions") {
    const limit = parseLimit(url, 50, 500);
    const data = await querySessionDetails(env, siteId, window, limit);
    return jsonResponse({
      ok: true,
      siteId,
      fromMs: window.fromMs,
      toMs: window.toMs,
      data,
    });
  }

  if (pathname === "/api/private/visitors") {
    const limit = parseLimit(url, 50, 500);
    const data = await queryVisitorDetails(env, siteId, window, limit);
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

  const window = parseWindow(url);
  if (!window) {
    return badRequest("Invalid time window");
  }

  const cacheHeaders = {
    "cache-control": "public, max-age=60, s-maxage=60",
    "access-control-allow-origin": "*",
  };

  if (resource === "overview") {
    const overview = await queryOverview(env, site.id, window);
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
          botSecurityFeatures: "hidden",
          detailedReferrerUrl: "hidden",
        },
      },
      200,
      cacheHeaders,
    );
  }

  if (resource === "trend") {
    const interval = parseInterval(url);
    const data = await queryTrend(env, site.id, window, interval);
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
    const data = await queryTopPages(env, site.id, window, limit, false);
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
    const data = await queryReferrers(env, site.id, window, limit, false);
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
