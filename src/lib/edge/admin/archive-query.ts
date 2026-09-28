import {
  and,
  compileD1Query,
  createD1DatabaseClient,
  eq,
  filter,
  gte,
  join,
  limit,
  lte,
  param,
  project,
  scan,
  sort,
} from "@/lib/db";
import { schema } from "@/lib/db/schema";
import {
  canAccessMemberSite,
  parseMemberSiteIdsJson,
} from "@/lib/edge/auth/member-site-access";
import { requireSession } from "@/lib/edge/auth/session-auth";
import { sitePkForSiteId } from "@/lib/edge/sites/identity-query";
import type { Env } from "@/lib/edge/types";
import { coerceNumber, ONE_HOUR_MS } from "@/lib/edge/utils";
import {
  bad as badRequest,
  j as jsonResponse,
  na as notAllowed,
  nf as notFound,
  una as unauthorized,
} from "@/lib/response";
function normalizeRange(
  range: R2Range | undefined,
  size: number,
): { start: number; end: number; length: number } | null {
  if (!range || !Number.isFinite(size) || size <= 0) {
    return null;
  }

  if ("suffix" in range && typeof range.suffix === "number") {
    const suffix = Math.max(0, Math.floor(range.suffix));
    if (suffix <= 0) return null;
    const length = Math.min(size, suffix);
    const start = size - length;
    const end = size - 1;
    return { start, end, length };
  }

  const offsetRange = range as Exclude<R2Range, { suffix: number }>;
  const start = Math.max(0, Math.floor(offsetRange.offset ?? 0));
  const maxLength = Math.max(0, size - start);
  const requestedLength =
    offsetRange.length === undefined
      ? maxLength
      : Math.max(0, Math.floor(offsetRange.length));
  const length = Math.min(maxLength, requestedLength);
  if (length <= 0) return null;
  const end = start + length - 1;
  return { start, end, length };
}
async function assertSiteAccess(
  env: Env,
  siteId: string,
  userId: string,
): Promise<boolean> {
  const sites = scan(schema.sites);
  const teams = scan(schema.teams);
  const members = scan(schema.team_members);
  const siteTeams = join(
    sites,
    teams,
    eq(sites.columns.team_id, teams.columns.id),
    "inner",
  );
  const siteTeamMembers = join(
    siteTeams,
    members,
    and(
      eq(siteTeams.columns.left_team_id, members.columns.team_id),
      eq(members.columns.user_id, param(userId)),
    ),
    "left",
  );
  const matchingPrivateSites = filter(
    siteTeamMembers,
    eq(siteTeamMembers.columns.left_left_id, param(siteId)),
  );
  const privateSiteQuery = limit(
    project(matchingPrivateSites, {
      id: matchingPrivateSites.columns.left_left_id,
      ownerUserId: matchingPrivateSites.columns.left_right_owner_user_id,
      role: matchingPrivateSites.columns.right_role,
      siteIdsJson: matchingPrivateSites.columns.right_site_ids_json,
    }),
    1,
  );
  const row = await createD1DatabaseClient(env.DB).first(
    compileD1Query(privateSiteQuery, { tag: "admin.sites.first" }),
  );
  if (!row?.id) return false;
  if (row.ownerUserId === userId) return true;
  if (row.role === "owner" || row.role === "admin") return true;
  if (!row.role) return false;
  return canAccessMemberSite(parseMemberSiteIdsJson(row.siteIdsJson), siteId);
}
function parseWindowHours(
  url: URL,
): { fromHour: number; toHour: number } | null {
  const nowMs = Date.now();
  const defaultFrom = nowMs - 365 * 24 * ONE_HOUR_MS;
  const rawFrom = url.searchParams.get("from");
  const rawTo = url.searchParams.get("to");
  const parsedFrom = coerceNumber(rawFrom, null);
  const parsedTo = coerceNumber(rawTo, null);
  if (
    (rawFrom !== null && parsedFrom === null) ||
    (rawTo !== null && parsedTo === null)
  ) {
    return null;
  }
  const fromMs = Math.floor(parsedFrom ?? defaultFrom);
  const toMs = Math.floor(parsedTo ?? nowMs);
  if (!Number.isFinite(fromMs) || !Number.isFinite(toMs) || toMs < fromMs) {
    return null;
  }
  return {
    fromHour: Math.floor(fromMs / ONE_HOUR_MS),
    toHour: Math.floor(toMs / ONE_HOUR_MS),
  };
}
export async function handlePrivateArchiveManifest(
  request: Request,
  env: Env,
  url: URL,
): Promise<Response> {
  if (request.method !== "GET") {
    return notAllowed();
  }
  const siteId = (url.searchParams.get("siteId") || "").trim();
  if (siteId.length === 0) {
    return badRequest("Missing siteId");
  }

  const session = await requireSession(request, env);
  if (!session) {
    return unauthorized();
  }

  const allowed =
    session.systemRole === "admin"
      ? true
      : await assertSiteAccess(env, siteId, session.userId);
  if (!allowed) {
    return unauthorized("Site access denied for current user");
  }

  const window = parseWindowHours(url);
  if (!window) {
    return badRequest("Invalid time window");
  }

  const archiveObjects = scan(schema.archive_objects);
  const matchingObjects = filter(
    archiveObjects,
    and(
      eq(archiveObjects.columns.site_pk, sitePkForSiteId(siteId)),
      gte(archiveObjects.columns.end_hour, param(window.fromHour)),
      lte(archiveObjects.columns.start_hour, param(window.toHour)),
    ),
  );
  const selectedObjects = project(matchingObjects, {
    archiveKey: matchingObjects.columns.archive_key,
    siteId: matchingObjects.columns.site_id,
    startHour: matchingObjects.columns.start_hour,
    endHour: matchingObjects.columns.end_hour,
    granularity: matchingObjects.columns.granularity,
    format: matchingObjects.columns.format,
    rowCount: matchingObjects.columns.row_count,
    sizeBytes: matchingObjects.columns.size_bytes,
    createdAt: matchingObjects.columns.created_at,
  });
  const orderedObjects = sort(selectedObjects, [
    { expression: selectedObjects.columns.startHour, direction: "ASC" },
  ]);
  const result = await createD1DatabaseClient(env.DB).all(
    compileD1Query(orderedObjects, { tag: "admin.archive_objects.all" }),
  );

  const files = result.results.map((row) => ({
    ...row,
    fetchUrl: `/api/private/archive/file?key=${encodeURIComponent(
      row.archiveKey === null ? "null" : row.archiveKey,
    )}`,
  }));

  return jsonResponse({
    ok: true,
    siteId,
    fromHour: window.fromHour,
    toHour: window.toHour,
    files,
  });
}
export async function handlePrivateArchiveFile(
  request: Request,
  env: Env,
  url: URL,
): Promise<Response> {
  if (request.method !== "GET" && request.method !== "HEAD") {
    return notAllowed();
  }
  if (!env.ARCHIVE_BUCKET) {
    return notFound("Archive bucket is not configured");
  }

  const session = await requireSession(request, env);
  if (!session) {
    return unauthorized();
  }

  const key = (url.searchParams.get("key") || "").trim();
  if (key.length === 0) {
    return badRequest("Missing key");
  }

  const archiveObjects = scan(schema.archive_objects);
  const matchingObjects = filter(
    archiveObjects,
    eq(archiveObjects.columns.archive_key, param(key)),
  );
  const archiveObjectQuery = limit(
    project(matchingObjects, {
      archiveKey: matchingObjects.columns.archive_key,
      format: matchingObjects.columns.format,
      siteId: matchingObjects.columns.site_id,
    }),
    1,
  );
  const row = await createD1DatabaseClient(env.DB).first(
    compileD1Query(archiveObjectQuery, { tag: "admin.archive_objects.first" }),
  );
  if (!row?.archiveKey) {
    return notFound("Archive object not found");
  }
  if (row.format !== "parquet") {
    return notFound("Archive object is not queryable in precise mode");
  }

  const allowed =
    session.systemRole === "admin"
      ? true
      : await assertSiteAccess(env, row.siteId, session.userId);
  if (!allowed) {
    return unauthorized("Site access denied for current user");
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
  headers.set(
    "content-type",
    object.httpMetadata?.contentType || "application/vnd.apache.parquet",
  );
  headers.set("cache-control", "private, max-age=120");
  headers.set("accept-ranges", "bytes");
  headers.set("etag", object.httpEtag);

  let status = 200;
  let contentLength = object.size;
  const normalizedRange = normalizeRange(object.range, object.size);
  if (rangeHeader && normalizedRange) {
    status = 206;
    contentLength = normalizedRange.length;
    headers.set(
      "content-range",
      `bytes ${normalizedRange.start}-${normalizedRange.end}/${object.size}`,
    );
  }

  headers.set("content-length", String(contentLength));

  if (request.method === "HEAD") {
    return new Response(null, { status, headers });
  }

  return new Response(object.body, { status, headers });
}
/**
 * Compatibility wrapper. Production routing lives in src/lib/hono/routes.
 */
export async function handlePrivateArchive(
  request: Request,
  env: Env,
  url: URL,
): Promise<Response> {
  const pathname = url.pathname;
  if (pathname === "/api/private/archive/manifest") {
    return handlePrivateArchiveManifest(request, env, url);
  }
  if (pathname === "/api/private/archive/file") {
    return handlePrivateArchiveFile(request, env, url);
  }

  return notFound();
}
