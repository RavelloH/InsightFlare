import type { Env } from "./types";
import { clampString } from "./utils";

interface JsonRecord {
  [key: string]: unknown;
}

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
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

function toSlug(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

function boolInput(input: unknown, fallback = false): boolean {
  if (typeof input === "boolean") return input;
  if (typeof input === "number") return input !== 0;
  if (typeof input === "string") {
    const normalized = input.trim().toLowerCase();
    return normalized === "1" || normalized === "true" || normalized === "on" || normalized === "yes";
  }
  return fallback;
}

async function parseJsonBody(request: Request): Promise<JsonRecord> {
  try {
    const parsed = (await request.json()) as unknown;
    if (parsed && typeof parsed === "object") {
      return parsed as JsonRecord;
    }
  } catch {
    // ignore invalid json body
  }
  return {};
}

async function ensureUserByEmail(env: Env, email: string, name: string): Promise<string> {
  const existing = await env.DB.prepare("SELECT id FROM users WHERE email = ? LIMIT 1").bind(email).first<{ id: string }>();
  if (existing?.id) {
    if (name.length > 0) {
      await env.DB.prepare("UPDATE users SET name = ?, updated_at = unixepoch() WHERE id = ?").bind(name, existing.id).run();
    }
    return existing.id;
  }

  const userId = crypto.randomUUID();
  await env.DB.prepare(
    "INSERT INTO users (id, email, name, created_at, updated_at) VALUES (?, ?, ?, unixepoch(), unixepoch())",
  )
    .bind(userId, email, name)
    .run();
  return userId;
}

async function ensureOwnerUser(env: Env, body: JsonRecord): Promise<string> {
  const ownerUserId = clampString(String(body.ownerUserId || ""), 120);
  if (ownerUserId.length > 0) {
    return ownerUserId;
  }

  const ownerEmail = clampString(String(body.ownerEmail || "admin@insightflare.local"), 200).toLowerCase();
  const ownerName = clampString(String(body.ownerName || "InsightFlare Admin"), 120);
  return ensureUserByEmail(env, ownerEmail, ownerName);
}

async function handleTeams(request: Request, env: Env, url: URL): Promise<Response> {
  if (request.method === "GET") {
    const userId = clampString(url.searchParams.get("userId") || "", 120);
    if (userId.length > 0) {
      const result = await env.DB.prepare(
        `
          SELECT
            t.id,
            t.name,
            t.slug,
            t.owner_user_id AS ownerUserId,
            t.created_at AS createdAt,
            (
              SELECT COUNT(*) FROM sites s WHERE s.team_id = t.id
            ) AS siteCount,
            (
              SELECT COUNT(*) FROM team_members tm2 WHERE tm2.team_id = t.id
            ) AS memberCount
          FROM teams t
          INNER JOIN team_members tm ON tm.team_id = t.id
          WHERE tm.user_id = ?
          ORDER BY t.created_at DESC
        `,
      )
        .bind(userId)
        .all<Record<string, unknown>>();
      return jsonResponse({ ok: true, data: result.results });
    }

    const result = await env.DB.prepare(
      `
        SELECT
          t.id,
          t.name,
          t.slug,
          t.owner_user_id AS ownerUserId,
          t.created_at AS createdAt,
          (
            SELECT COUNT(*) FROM sites s WHERE s.team_id = t.id
          ) AS siteCount,
          (
            SELECT COUNT(*) FROM team_members tm2 WHERE tm2.team_id = t.id
          ) AS memberCount
        FROM teams t
        ORDER BY t.created_at DESC
      `,
    ).all<Record<string, unknown>>();
    return jsonResponse({ ok: true, data: result.results });
  }

  if (request.method === "POST") {
    const body = await parseJsonBody(request);
    const name = clampString(String(body.name || ""), 120);
    if (name.length < 2) {
      return badRequest("Team name is required");
    }

    const slug = clampString(String(body.slug || toSlug(name)), 80);
    if (slug.length < 2) {
      return badRequest("Invalid team slug");
    }

    const ownerUserId = await ensureOwnerUser(env, body);
    const teamId = crypto.randomUUID();

    try {
      await env.DB.prepare(
        `
          INSERT INTO teams (id, name, slug, owner_user_id, created_at, updated_at)
          VALUES (?, ?, ?, ?, unixepoch(), unixepoch())
        `,
      )
        .bind(teamId, name, slug, ownerUserId)
        .run();
    } catch (error) {
      return badRequest(`Failed to create team: ${error instanceof Error ? error.message : String(error)}`);
    }

    await env.DB.prepare(
      `
        INSERT INTO team_members (team_id, user_id, role, joined_at)
        VALUES (?, ?, 'owner', unixepoch())
        ON CONFLICT(team_id, user_id) DO UPDATE SET role='owner'
      `,
    )
      .bind(teamId, ownerUserId)
      .run();

    return jsonResponse({
      ok: true,
      data: {
        id: teamId,
        name,
        slug,
        ownerUserId,
      },
    });
  }

  return notAllowed();
}

async function handleSites(request: Request, env: Env, url: URL): Promise<Response> {
  if (request.method === "GET") {
    const teamId = clampString(url.searchParams.get("teamId") || "", 120);
    if (teamId.length === 0) {
      return badRequest("Missing teamId");
    }

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
      .all<Record<string, unknown>>();
    return jsonResponse({ ok: true, data: result.results });
  }

  if (request.method === "POST") {
    const body = await parseJsonBody(request);
    const teamId = clampString(String(body.teamId || ""), 120);
    const name = clampString(String(body.name || ""), 120);
    const domain = clampString(String(body.domain || ""), 255);
    const publicEnabled = boolInput(body.publicEnabled, false);
    const publicSlug = clampString(
      String(body.publicSlug || toSlug(name || domain || `site-${Date.now()}`)),
      120,
    );

    if (teamId.length === 0 || name.length === 0 || domain.length === 0) {
      return badRequest("teamId, name and domain are required");
    }

    const siteId = crypto.randomUUID();
    try {
      await env.DB.prepare(
        `
          INSERT INTO sites (
            id, team_id, name, domain, public_enabled, public_slug, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, unixepoch(), unixepoch())
        `,
      )
        .bind(siteId, teamId, name, domain, publicEnabled ? 1 : 0, publicEnabled ? publicSlug : null)
        .run();
    } catch (error) {
      return badRequest(`Failed to create site: ${error instanceof Error ? error.message : String(error)}`);
    }

    return jsonResponse({
      ok: true,
      data: {
        id: siteId,
        teamId,
        name,
        domain,
        publicEnabled,
        publicSlug: publicEnabled ? publicSlug : "",
      },
    });
  }

  if (request.method === "PATCH") {
    const body = await parseJsonBody(request);
    const siteId = clampString(String(body.siteId || ""), 120);
    if (siteId.length === 0) {
      return badRequest("siteId is required");
    }

    const existing = await env.DB.prepare(
      `
        SELECT id, team_id AS teamId, name, domain, public_enabled AS publicEnabled, public_slug AS publicSlug
        FROM sites WHERE id = ? LIMIT 1
      `,
    )
      .bind(siteId)
      .first<{
        id: string;
        teamId: string;
        name: string;
        domain: string;
        publicEnabled: number;
        publicSlug: string | null;
      }>();

    if (!existing) {
      return notFound("Site not found");
    }

    const name = clampString(String(body.name ?? existing.name), 120);
    const domain = clampString(String(body.domain ?? existing.domain), 255);
    const publicEnabled = boolInput(body.publicEnabled, existing.publicEnabled === 1);
    const publicSlug = clampString(
      String(body.publicSlug ?? existing.publicSlug ?? toSlug(name || domain)),
      120,
    );

    try {
      await env.DB.prepare(
        `
          UPDATE sites
          SET name = ?, domain = ?, public_enabled = ?, public_slug = ?, updated_at = unixepoch()
          WHERE id = ?
        `,
      )
        .bind(name, domain, publicEnabled ? 1 : 0, publicEnabled ? publicSlug : null, siteId)
        .run();
    } catch (error) {
      return badRequest(`Failed to update site: ${error instanceof Error ? error.message : String(error)}`);
    }

    return jsonResponse({
      ok: true,
      data: {
        id: siteId,
        teamId: existing.teamId,
        name,
        domain,
        publicEnabled,
        publicSlug: publicEnabled ? publicSlug : "",
      },
    });
  }

  return notAllowed();
}

async function handleMembers(request: Request, env: Env, url: URL): Promise<Response> {
  if (request.method === "GET") {
    const teamId = clampString(url.searchParams.get("teamId") || "", 120);
    if (teamId.length === 0) {
      return badRequest("Missing teamId");
    }

    const result = await env.DB.prepare(
      `
        SELECT
          tm.team_id AS teamId,
          tm.user_id AS userId,
          tm.role,
          tm.joined_at AS joinedAt,
          u.email,
          u.name
        FROM team_members tm
        INNER JOIN users u ON u.id = tm.user_id
        WHERE tm.team_id = ?
        ORDER BY tm.joined_at ASC
      `,
    )
      .bind(teamId)
      .all<Record<string, unknown>>();

    return jsonResponse({ ok: true, data: result.results });
  }

  if (request.method === "POST") {
    const body = await parseJsonBody(request);
    const teamId = clampString(String(body.teamId || ""), 120);
    const email = clampString(String(body.email || ""), 200).toLowerCase();
    const name = clampString(String(body.name || ""), 120);
    const role = clampString(String(body.role || "member"), 30) || "member";

    if (teamId.length === 0 || email.length < 3) {
      return badRequest("teamId and email are required");
    }

    const userId = await ensureUserByEmail(env, email, name);
    await env.DB.prepare(
      `
        INSERT INTO team_members (team_id, user_id, role, joined_at)
        VALUES (?, ?, ?, unixepoch())
        ON CONFLICT(team_id, user_id) DO UPDATE SET role = excluded.role
      `,
    )
      .bind(teamId, userId, role)
      .run();

    return jsonResponse({
      ok: true,
      data: {
        teamId,
        userId,
        role,
        email,
        name,
      },
    });
  }

  return notAllowed();
}

async function handleSiteConfig(request: Request, env: Env, url: URL): Promise<Response> {
  if (request.method === "GET") {
    const siteId = clampString(url.searchParams.get("siteId") || "", 120);
    if (siteId.length === 0) {
      return badRequest("Missing siteId");
    }

    const key = `site:${siteId}`;
    const row = await env.DB.prepare("SELECT value_json FROM configs WHERE config_key = ? LIMIT 1")
      .bind(key)
      .first<{ value_json: string }>();

    if (!row?.value_json) {
      return jsonResponse({ ok: true, data: {} });
    }

    try {
      return jsonResponse({
        ok: true,
        data: JSON.parse(row.value_json) as unknown,
      });
    } catch {
      return jsonResponse({ ok: true, data: {} });
    }
  }

  if (request.method === "POST") {
    const body = await parseJsonBody(request);
    const siteId = clampString(String(body.siteId || ""), 120);
    if (siteId.length === 0) {
      return badRequest("siteId is required");
    }

    const config = (body.config && typeof body.config === "object" ? body.config : {}) as JsonRecord;
    const key = `site:${siteId}`;
    const valueJson = JSON.stringify(config);

    await env.DB.prepare(
      `
        INSERT INTO configs (config_key, value_json, created_at, updated_at)
        VALUES (?, ?, unixepoch(), unixepoch())
        ON CONFLICT(config_key) DO UPDATE SET
          value_json = excluded.value_json,
          updated_at = unixepoch()
      `,
    )
      .bind(key, valueJson)
      .run();

    return jsonResponse({
      ok: true,
      data: config,
    });
  }

  return notAllowed();
}

async function handleScriptSnippet(request: Request, env: Env, url: URL): Promise<Response> {
  if (request.method !== "GET") {
    return notAllowed();
  }

  const siteId = clampString(url.searchParams.get("siteId") || "", 120);
  if (siteId.length === 0) {
    return badRequest("Missing siteId");
  }

  const edgeBaseUrl = env.EDGE_PUBLIC_BASE_URL || `${url.protocol}//${url.host}`;
  const src = `${edgeBaseUrl.replace(/\/$/, "")}/script.js?siteId=${encodeURIComponent(siteId)}`;
  const snippet = `<script defer src="${src}"></script>`;

  return jsonResponse({
    ok: true,
    data: {
      siteId,
      src,
      snippet,
    },
  });
}

export async function handlePrivateAdmin(request: Request, env: Env, url: URL): Promise<Response> {
  if (!isPrivateAuthorized(request, env)) {
    return unauthorized();
  }

  const pathname = url.pathname;
  if (pathname === "/api/private/admin/teams") {
    return handleTeams(request, env, url);
  }
  if (pathname === "/api/private/admin/sites") {
    return handleSites(request, env, url);
  }
  if (pathname === "/api/private/admin/members") {
    return handleMembers(request, env, url);
  }
  if (pathname === "/api/private/admin/site-config") {
    return handleSiteConfig(request, env, url);
  }
  if (pathname === "/api/private/admin/script-snippet") {
    return handleScriptSnippet(request, env, url);
  }

  return notFound();
}
