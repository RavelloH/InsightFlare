import type { Env } from "./types";
import { ONE_HOUR_MS, coerceNumber } from "./utils";

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

function normalizeRange(
  range: R2Range | undefined,
  size: number,
): { start: number; end: number; length: number } | null {
  if (!range || !Number.isFinite(size) || size <= 0) {
    return null;
  }

  if ("suffix" in range) {
    const suffix = Math.max(0, Math.floor(range.suffix));
    if (suffix <= 0) return null;
    const length = Math.min(size, suffix);
    const start = size - length;
    const end = size - 1;
    return { start, end, length };
  }

  const start = Math.max(0, Math.floor(range.offset ?? 0));
  const maxLength = Math.max(0, size - start);
  const requestedLength = range.length === undefined ? maxLength : Math.max(0, Math.floor(range.length));
  const length = Math.min(maxLength, requestedLength);
  if (length <= 0) return null;
  const end = start + length - 1;
  return { start, end, length };
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

async function assertSiteMembership(env: Env, siteId: string, userId: string): Promise<boolean> {
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

function parseWindowHours(url: URL): { fromHour: number; toHour: number } | null {
  const nowMs = Date.now();
  const defaultFrom = nowMs - 365 * 24 * ONE_HOUR_MS;
  const fromMs = Math.floor(coerceNumber(url.searchParams.get("from"), defaultFrom) ?? defaultFrom);
  const toMs = Math.floor(coerceNumber(url.searchParams.get("to"), nowMs) ?? nowMs);
  if (!Number.isFinite(fromMs) || !Number.isFinite(toMs) || toMs < fromMs) {
    return null;
  }
  return {
    fromHour: Math.floor(fromMs / ONE_HOUR_MS),
    toHour: Math.floor(toMs / ONE_HOUR_MS),
  };
}

async function handleManifest(request: Request, env: Env, url: URL): Promise<Response> {
  if (request.method !== "GET") {
    return notAllowed();
  }
  const siteId = (url.searchParams.get("siteId") || "").trim();
  if (siteId.length === 0) {
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

  const window = parseWindowHours(url);
  if (!window) {
    return badRequest("Invalid time window");
  }

  const result = await env.DB.prepare(
    `
      SELECT
        archive_key AS archiveKey,
        site_id AS siteId,
        start_hour AS startHour,
        end_hour AS endHour,
        granularity,
        format,
        row_count AS rowCount,
        size_bytes AS sizeBytes,
        created_at AS createdAt
      FROM archive_objects
      WHERE site_id = ?
        AND end_hour >= ?
        AND start_hour <= ?
      ORDER BY start_hour ASC
    `,
  )
    .bind(siteId, window.fromHour, window.toHour)
    .all<{
      archiveKey: string;
      siteId: string;
      startHour: number;
      endHour: number;
      granularity: string;
      format: string;
      rowCount: number;
      sizeBytes: number;
      createdAt: number;
    }>();

  const files = result.results.map((row) => ({
    ...row,
    fetchUrl: `/api/private/archive/file?key=${encodeURIComponent(row.archiveKey)}`,
  }));

  return jsonResponse({
    ok: true,
    siteId,
    fromHour: window.fromHour,
    toHour: window.toHour,
    files,
  });
}

async function handleFile(request: Request, env: Env, url: URL): Promise<Response> {
  if (request.method !== "GET" && request.method !== "HEAD") {
    return notAllowed();
  }
  if (!env.ARCHIVE_BUCKET) {
    return notFound("Archive bucket is not configured");
  }

  const key = (url.searchParams.get("key") || "").trim();
  if (key.length === 0) {
    return badRequest("Missing key");
  }

  const row = await env.DB.prepare(
    `
      SELECT archive_key AS archiveKey, format, site_id AS siteId
      FROM archive_objects
      WHERE archive_key = ?
      LIMIT 1
    `,
  )
    .bind(key)
    .first<{ archiveKey: string; format: string; siteId: string }>();
  if (!row?.archiveKey) {
    return notFound("Archive object not found");
  }
  if (row.format !== "parquet") {
    return notFound("Archive object is not queryable in precise mode");
  }

  if (requiresTeamMembershipCheck(env)) {
    const userId = extractUserIdForMembership(request);
    if (!userId) {
      return unauthorized("Missing x-user-id for team membership check");
    }
    const allowed = await assertSiteMembership(env, row.siteId, userId);
    if (!allowed) {
      return unauthorized("Site access denied for current user");
    }
  }

  const rangeHeader = request.headers.get("range");
  const object = await env.ARCHIVE_BUCKET.get(
    key,
    rangeHeader ? { range: request.headers } : undefined,
  );
  if (!object) {
    return notFound("Archive object content is missing");
  }

  const headers = new Headers();
  headers.set("content-type", object.httpMetadata?.contentType || "application/vnd.apache.parquet");
  headers.set("cache-control", "private, max-age=120");
  headers.set("accept-ranges", "bytes");
  headers.set("etag", object.httpEtag);

  let status = 200;
  let contentLength = object.size;
  const normalizedRange = normalizeRange(object.range, object.size);
  if (rangeHeader && normalizedRange) {
    status = 206;
    contentLength = normalizedRange.length;
    headers.set("content-range", `bytes ${normalizedRange.start}-${normalizedRange.end}/${object.size}`);
  }

  headers.set("content-length", String(contentLength));

  if (request.method === "HEAD") {
    return new Response(null, { status, headers });
  }

  return new Response(object.body, { status, headers });
}

export async function handlePrivateArchive(request: Request, env: Env, url: URL): Promise<Response> {
  if (!isPrivateAuthorized(request, env)) {
    return unauthorized();
  }

  const pathname = url.pathname;
  if (pathname === "/api/private/archive/manifest") {
    return handleManifest(request, env, url);
  }
  if (pathname === "/api/private/archive/file") {
    return handleFile(request, env, url);
  }

  return notFound();
}
