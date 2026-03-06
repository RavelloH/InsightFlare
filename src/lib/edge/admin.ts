import type { Env } from "./types";
import { clampString } from "./utils";
import { argon2id } from "@noble/hashes/argon2.js";
import { requireSession } from "./session-auth";
import { DEFAULT_SITE_SCRIPT_SETTINGS } from "@/lib/site-settings";
import {
  deleteSiteScriptSettings,
  readSiteScriptSettings,
  upsertSiteScriptSettings,
} from "./site-settings-store";

type JsonRecord = Record<string, unknown>;

type UserRow = {
  id: string;
  username: string;
  email: string;
  name: string | null;
  password_hash: string | null;
  system_role: string;
  created_at: number;
  updated_at: number;
};

type Actor = { user: UserRow; isAdmin: boolean };

const HASH_PREFIX_ARGON2 = "argon2id";
const HASH_LEN = 32;
const ARGON2_VERSION = 19;
const ARGON2_MEMORY_KIB = 4096;
const ARGON2_PASSES = 1;
const ARGON2_PARALLELISM = 1;
const ARGON2_NONCE_LEN = 16;
const ARGON2_MIN_MEMORY_KIB = 8;
const ARGON2_MAX_MEMORY_KIB = 262144;
const ARGON2_MIN_PASSES = 1;
const ARGON2_MAX_PASSES = 10;
const ARGON2_MIN_PARALLELISM = 1;
const ARGON2_MAX_PARALLELISM = 8;

type Argon2HashParts = {
  version: number;
  memory: number;
  passes: number;
  parallelism: number;
  nonce: Uint8Array;
  expected: Uint8Array;
};

const j = (payload: unknown, status = 200) =>
  new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
const bad = (m: string) => j({ ok: false, error: m }, 400);
const una = (m = "Unauthorized") => j({ ok: false, error: m }, 401);
const forb = (m = "Forbidden") => j({ ok: false, error: m }, 403);
const nf = (m = "Not Found") => j({ ok: false, error: m }, 404);
const na = () => j({ ok: false, error: "Method Not Allowed" }, 405);

const normU = (s: string) => clampString(s.trim().toLowerCase(), 80);
const normE = (s: string) => clampString(s.trim().toLowerCase(), 200);
const toSlug = (v: string) =>
  v.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80);
const toRole = (v: unknown): "admin" | "user" => (String(v || "user").toLowerCase() === "admin" ? "admin" : "user");
const bool = (v: unknown, fb = false) => {
  if (typeof v === "boolean") return v;
  if (typeof v === "number") return v !== 0;
  if (typeof v === "string") return ["1", "true", "yes", "on"].includes(v.trim().toLowerCase());
  return fb;
};

const parseJson = async (r: Request): Promise<JsonRecord> => {
  try {
    const p = (await r.json()) as unknown;
    if (p && typeof p === "object") return p as JsonRecord;
  } catch {}
  return {};
};

const b64u = (b: Uint8Array) => {
  let bin = "";
  for (let i = 0; i < b.length; i += 1) bin += String.fromCharCode(b[i]);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
};
const u8 = (s: string) => new TextEncoder().encode(s);
const fromB64u = (v: string) => {
  const p = v.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((v.length + 3) % 4);
  const bin = atob(p);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) out[i] = bin.charCodeAt(i);
  return out;
};
const eq = (a: Uint8Array, b: Uint8Array) => {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i += 1) d |= a[i] ^ b[i];
  return d === 0;
};

function parseArgon2Hash(stored: string): Argon2HashParts | null {
  const parts = stored.split("$");
  if (parts.length !== 5 || parts[0] !== HASH_PREFIX_ARGON2) return null;
  const versionMatch = /^v=(\d+)$/.exec(parts[1]);
  const paramsMatch = /^m=(\d+),t=(\d+),p=(\d+)$/.exec(parts[2]);
  if (!versionMatch || !paramsMatch) return null;
  const version = Number(versionMatch[1]);
  const memory = Number(paramsMatch[1]);
  const passes = Number(paramsMatch[2]);
  const parallelism = Number(paramsMatch[3]);
  if (!Number.isFinite(version) || (version !== 16 && version !== 19)) return null;
  if (!Number.isFinite(memory) || memory < ARGON2_MIN_MEMORY_KIB || memory > ARGON2_MAX_MEMORY_KIB) return null;
  if (!Number.isFinite(passes) || passes < ARGON2_MIN_PASSES || passes > ARGON2_MAX_PASSES) return null;
  if (
    !Number.isFinite(parallelism) ||
    parallelism < ARGON2_MIN_PARALLELISM ||
    parallelism > ARGON2_MAX_PARALLELISM
  )
    return null;
  let nonce: Uint8Array;
  let expected: Uint8Array;
  try {
    nonce = fromB64u(parts[3]);
    expected = fromB64u(parts[4]);
  } catch {
    return null;
  }
  if (nonce.length < 8 || expected.length < 16) return null;
  return {
    version: Math.floor(version),
    memory: Math.floor(memory),
    passes: Math.floor(passes),
    parallelism: Math.floor(parallelism),
    nonce,
    expected,
  };
}

async function deriveArgon2id(
  password: string,
  nonce: Uint8Array,
  options: {
    memory: number;
    passes: number;
    parallelism: number;
    version: number;
    tagLength: number;
  },
): Promise<Uint8Array> {
  return argon2id(u8(password), new Uint8Array(nonce), {
    p: options.parallelism,
    t: options.passes,
    m: options.memory,
    version: options.version,
    dkLen: options.tagLength,
  });
}

async function hashPasswordArgon2(password: string): Promise<string> {
  const nonce = crypto.getRandomValues(new Uint8Array(ARGON2_NONCE_LEN));
  const derived = await deriveArgon2id(password, nonce, {
    memory: ARGON2_MEMORY_KIB,
    passes: ARGON2_PASSES,
    parallelism: ARGON2_PARALLELISM,
    version: ARGON2_VERSION,
    tagLength: HASH_LEN,
  });
  return `${HASH_PREFIX_ARGON2}$v=${ARGON2_VERSION}$m=${ARGON2_MEMORY_KIB},t=${ARGON2_PASSES},p=${ARGON2_PARALLELISM}$${b64u(nonce)}$${b64u(derived)}`;
}

async function hashPassword(password: string): Promise<string> {
  return hashPasswordArgon2(password);
}

async function verifyPassword(password: string, stored: string | null | undefined): Promise<boolean> {
  if (!stored) return false;
  if (stored.startsWith(`${HASH_PREFIX_ARGON2}$`)) {
    const parsed = parseArgon2Hash(stored);
    if (!parsed) return false;
    try {
      const actual = await deriveArgon2id(password, parsed.nonce, {
        memory: parsed.memory,
        passes: parsed.passes,
        parallelism: parsed.parallelism,
        version: parsed.version,
        tagLength: parsed.expected.length,
      });
      return eq(actual, parsed.expected);
    } catch {
      return false;
    }
  }
  return false;
}

const toPublicUser = (u: UserRow) => ({
  id: u.id,
  username: u.username,
  email: u.email,
  name: u.name || "",
  systemRole: u.system_role === "admin" ? "admin" : "user",
  createdAt: u.created_at,
  updatedAt: u.updated_at,
});

async function byId(env: Env, id: string): Promise<UserRow | null> {
  return (
    (await env.DB.prepare(
      "SELECT id,username,email,name,password_hash,system_role,created_at,updated_at FROM users WHERE id=? LIMIT 1",
    )
      .bind(id)
      .first<UserRow>()) ?? null
  );
}
async function byIdentifier(env: Env, identifier: string): Promise<UserRow | null> {
  const lowered = normU(identifier);
  return (
    (await env.DB.prepare(
      "SELECT id,username,email,name,password_hash,system_role,created_at,updated_at FROM users WHERE lower(username)=? OR lower(email)=? LIMIT 1",
    )
      .bind(lowered, lowered)
      .first<UserRow>()) ?? null
  );
}

async function teamRole(env: Env, teamId: string, userId: string): Promise<string | null> {
  const row = await env.DB.prepare("SELECT role FROM team_members WHERE team_id=? AND user_id=? LIMIT 1")
    .bind(teamId, userId)
    .first<{ role: string }>();
  return row?.role ?? null;
}
async function teamById(env: Env, teamId: string): Promise<{ id: string; ownerUserId: string } | null> {
  const row = await env.DB.prepare("SELECT id,owner_user_id AS ownerUserId FROM teams WHERE id=? LIMIT 1")
    .bind(teamId)
    .first<{ id: string; ownerUserId: string }>();
  return row ?? null;
}
async function siteTeam(env: Env, siteId: string): Promise<string | null> {
  const row = await env.DB.prepare("SELECT team_id FROM sites WHERE id=? LIMIT 1").bind(siteId).first<{ team_id: string }>();
  return row?.team_id ?? null;
}
async function canReadTeam(env: Env, a: Actor, teamId: string): Promise<boolean> {
  if (a.isAdmin) return true;
  const team = await teamById(env, teamId);
  if (team?.ownerUserId === a.user.id) return true;
  return Boolean(await teamRole(env, teamId, a.user.id));
}
async function canManageTeam(env: Env, a: Actor, teamId: string): Promise<boolean> {
  if (a.isAdmin) return true;
  const team = await teamById(env, teamId);
  if (team?.ownerUserId === a.user.id) return true;
  return (await teamRole(env, teamId, a.user.id)) === "owner";
}
async function canReadSite(env: Env, a: Actor, siteId: string): Promise<boolean> {
  const teamId = await siteTeam(env, siteId);
  if (!teamId) return false;
  return canReadTeam(env, a, teamId);
}
async function canManageSite(env: Env, a: Actor, siteId: string): Promise<boolean> {
  const teamId = await siteTeam(env, siteId);
  if (!teamId) return false;
  return canManageTeam(env, a, teamId);
}

async function uniqueTeamSlug(env: Env, raw: string, excludeTeamId?: string): Promise<string> {
  const base = toSlug(raw) || `team-${Date.now()}`;
  let slug = base;
  let i = 2;
  while (true) {
    const e = excludeTeamId
      ? await env.DB.prepare("SELECT 1 AS ok FROM teams WHERE slug=? AND id<>? LIMIT 1").bind(slug, excludeTeamId).first<{ ok: number }>()
      : await env.DB.prepare("SELECT 1 AS ok FROM teams WHERE slug=? LIMIT 1").bind(slug).first<{ ok: number }>();
    if (!e?.ok) return slug;
    slug = `${base}-${i}`;
    i += 1;
  }
}

async function ensureDefaultTeam(env: Env, user: UserRow): Promise<void> {
  const owned = await env.DB.prepare("SELECT id FROM teams WHERE owner_user_id=? LIMIT 1")
    .bind(user.id)
    .first<{ id: string }>();
  if (owned?.id) {
    await env.DB.prepare(
      "INSERT INTO team_members (team_id,user_id,role,joined_at) VALUES (?,?,'owner',unixepoch()) ON CONFLICT(team_id,user_id) DO UPDATE SET role='owner'",
    )
      .bind(owned.id, user.id)
      .run();
    return;
  }
  const teamId = crypto.randomUUID();
  const displayName = clampString((user.name || user.username || "User").trim(), 120);
  const slug = await uniqueTeamSlug(env, `${user.username}-team`);
  await env.DB.prepare(
    "INSERT INTO teams (id,name,slug,owner_user_id,created_at,updated_at) VALUES (?,?,?,?,unixepoch(),unixepoch())",
  )
    .bind(teamId, `${displayName}'s team`, slug, user.id)
    .run();
  await env.DB.prepare("INSERT INTO team_members (team_id,user_id,role,joined_at) VALUES (?,?,'owner',unixepoch())")
    .bind(teamId, user.id)
    .run();
}

async function ensureBootstrapAdmin(env: Env): Promise<UserRow> {
  const admin = await env.DB.prepare(
    "SELECT id,username,email,name,password_hash,system_role,created_at,updated_at FROM users WHERE system_role='admin' ORDER BY created_at ASC LIMIT 1",
  ).first<UserRow>();
  if (admin) {
    await ensureDefaultTeam(env, admin);
    return admin;
  }
  const username = normU(env.BOOTSTRAP_ADMIN_USERNAME || "admin") || "admin";
  const email = normE(env.BOOTSTRAP_ADMIN_EMAIL || `${username}@insightflare.local`);
  const name = clampString(env.BOOTSTRAP_ADMIN_NAME || "Administrator", 120);
  const passHash = await hashPassword(String(env.BOOTSTRAP_ADMIN_PASSWORD || "insightflare"));
  const found = await byIdentifier(env, username);
  if (found) {
    await env.DB.prepare(
      "UPDATE users SET username=?,email=?,name=?,password_hash=?,system_role='admin',updated_at=unixepoch() WHERE id=?",
    )
      .bind(username, email, name, passHash, found.id)
      .run();
    const promoted = await byId(env, found.id);
    if (!promoted) throw new Error("bootstrap admin promote failed");
    await ensureDefaultTeam(env, promoted);
    return promoted;
  }
  const id = crypto.randomUUID();
  await env.DB.prepare(
    "INSERT INTO users (id,username,email,name,password_hash,system_role,created_at,updated_at) VALUES (?,?,?,?,?,'admin',unixepoch(),unixepoch())",
  )
    .bind(id, username, email, name, passHash)
    .run();
  const created = await byId(env, id);
  if (!created) throw new Error("bootstrap admin create failed");
  await ensureDefaultTeam(env, created);
  return created;
}

async function requireActor(env: Env, req: Request): Promise<Actor | Response> {
  const session = await requireSession(req, env);
  if (!session) return una();
  const uid = clampString(session.userId, 120);
  if (!uid) return una();
  const user = await byId(env, uid);
  if (!user) return una("User not found");
  return { user, isAdmin: user.system_role === "admin" };
}

async function teamsFor(env: Env, userId: string): Promise<Array<Record<string, unknown>>> {
  const rows = await env.DB.prepare(
    "SELECT t.id,t.name,t.slug,t.owner_user_id AS ownerUserId,t.created_at AS createdAt,t.updated_at AS updatedAt,tm.role AS membershipRole,(SELECT COUNT(*) FROM sites s WHERE s.team_id=t.id) AS siteCount,(SELECT COUNT(*) FROM team_members x WHERE x.team_id=t.id) AS memberCount FROM teams t INNER JOIN team_members tm ON tm.team_id=t.id WHERE tm.user_id=? ORDER BY t.created_at DESC",
  )
    .bind(userId)
    .all<Record<string, unknown>>();
  return rows.results;
}

async function hAuthLogin(req: Request, env: Env): Promise<Response> {
  if (req.method !== "POST") return na();
  try {
    await ensureBootstrapAdmin(env);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("bootstrap_admin_failed", { message });
    return j({ ok: false, error: "bootstrap_admin_failed" }, 500);
  }
  const body = await parseJson(req);
  const identifier = clampString(String(body.username || body.email || ""), 200);
  const password = String(body.password || "");
  if (identifier.length < 3 || !password) return bad("username/email and password are required");
  const user = await byIdentifier(env, identifier);
  if (!user) return una("Invalid credentials");
  const verified = await verifyPassword(password, user.password_hash);
  if (!verified) return una("Invalid credentials");
  await ensureDefaultTeam(env, user);
  return j({ ok: true, data: { user: toPublicUser(user), teams: await teamsFor(env, user.id) } });
}

async function hAuthMe(req: Request, env: Env): Promise<Response> {
  if (req.method !== "GET") return na();
  const a = await requireActor(env, req);
  if (a instanceof Response) return a;
  return j({ ok: true, data: { user: toPublicUser(a.user), teams: await teamsFor(env, a.user.id) } });
}

async function hUsers(req: Request, env: Env): Promise<Response> {
  const a = await requireActor(env, req);
  if (a instanceof Response) return a;
  if (!a.isAdmin) return forb("Only system admin can manage accounts");
  if (req.method === "GET") {
    const rows = await env.DB.prepare(
      "SELECT u.id,u.username,u.email,u.name,u.system_role AS systemRole,u.created_at AS createdAt,u.updated_at AS updatedAt,(SELECT COUNT(*) FROM team_members tm WHERE tm.user_id=u.id) AS teamCount,(SELECT COUNT(*) FROM teams t WHERE t.owner_user_id=u.id) AS ownedTeamCount FROM users u ORDER BY u.created_at ASC",
    ).all<Record<string, unknown>>();
    return j({ ok: true, data: rows.results });
  }
  if (req.method === "POST") {
    const body = await parseJson(req);
    const username = normU(String(body.username || ""));
    const email = normE(String(body.email || ""));
    const name = clampString(String(body.name || ""), 120);
    const password = String(body.password || "");
    const systemRole = toRole(body.systemRole);
    if (username.length < 3 || !/^[a-z0-9._@-]+$/.test(username)) return bad("Invalid username");
    if (email.length < 3 || !email.includes("@")) return bad("A valid email is required");
    if (password.length < 8) return bad("Password must be at least 8 characters");
    if (await env.DB.prepare("SELECT 1 AS ok FROM users WHERE lower(username)=? LIMIT 1").bind(username).first()) return bad("Username already exists");
    if (await env.DB.prepare("SELECT 1 AS ok FROM users WHERE lower(email)=? LIMIT 1").bind(email).first()) return bad("Email already exists");
    const id = crypto.randomUUID();
    const pass = await hashPassword(password);
    await env.DB.prepare(
      "INSERT INTO users (id,username,email,name,password_hash,system_role,created_at,updated_at) VALUES (?,?,?,?,?,?,unixepoch(),unixepoch())",
    )
      .bind(id, username, email, name, pass, systemRole)
      .run();
    const created = await byId(env, id);
    if (!created) return bad("Failed to create account");
    await ensureDefaultTeam(env, created);
    return j({ ok: true, data: toPublicUser(created) });
  }
  if (req.method === "PATCH") {
    const body = await parseJson(req);
    const intent = clampString(String(body.intent || ""), 24).toLowerCase();
    const id = clampString(String(body.userId || ""), 120);
    if (!id) return bad("userId is required");

    if (intent === "remove" || intent === "delete") {
      if (id === a.user.id) return bad("Cannot delete current user");
      const target = await byId(env, id);
      if (!target) return nf("User not found");

      const ownedTeams = await env.DB.prepare("SELECT COUNT(*) AS count FROM teams WHERE owner_user_id=?")
        .bind(id)
        .first<{ count: number | null }>();
      if (Number(ownedTeams?.count ?? 0) > 0) {
        return bad("Cannot delete user that owns teams");
      }

      await env.DB.prepare("DELETE FROM users WHERE id=?").bind(id).run();
      return j({ ok: true, data: { userId: id, removed: true } });
    }

    const e = await byId(env, id);
    if (!e) return nf("User not found");
    const username = normU(String(body.username ?? e.username));
    const email = normE(String(body.email ?? e.email));
    const name = clampString(String(body.name ?? e.name ?? ""), 120);
    const role = toRole(body.systemRole ?? e.system_role);
    const password = String(body.password || "");
    if (username.length < 3 || !/^[a-z0-9._@-]+$/.test(username)) return bad("Invalid username");
    if (email.length < 3 || !email.includes("@")) return bad("A valid email is required");
    if (
      await env.DB.prepare("SELECT 1 AS ok FROM users WHERE lower(username)=? AND id<>? LIMIT 1").bind(username, id).first()
    )
      return bad("Username already exists");
    if (await env.DB.prepare("SELECT 1 AS ok FROM users WHERE lower(email)=? AND id<>? LIMIT 1").bind(email, id).first())
      return bad("Email already exists");
    const pass = password.length > 0 ? await hashPassword(password) : e.password_hash;
    await env.DB.prepare(
      "UPDATE users SET username=?,email=?,name=?,password_hash=?,system_role=?,updated_at=unixepoch() WHERE id=?",
    )
      .bind(username, email, name, pass, role, id)
      .run();
    const u = await byId(env, id);
    if (!u) return bad("Failed to update account");
    return j({ ok: true, data: toPublicUser(u) });
  }
  return na();
}

async function hProfile(req: Request, env: Env): Promise<Response> {
  const a = await requireActor(env, req);
  if (a instanceof Response) return a;
  if (req.method === "GET") return j({ ok: true, data: { user: toPublicUser(a.user), teams: await teamsFor(env, a.user.id) } });
  if (req.method === "POST" || req.method === "PATCH") {
    const body = await parseJson(req);
    const username = normU(String(body.username ?? a.user.username));
    const email = normE(String(body.email ?? a.user.email));
    const name = clampString(String(body.name ?? a.user.name ?? ""), 120);
    const password = String(body.password || "");
    if (username.length < 3 || !/^[a-z0-9._@-]+$/.test(username)) return bad("Invalid username");
    if (email.length < 3 || !email.includes("@")) return bad("A valid email is required");
    if (
      await env.DB.prepare("SELECT 1 AS ok FROM users WHERE lower(username)=? AND id<>? LIMIT 1").bind(username, a.user.id).first()
    )
      return bad("Username already exists");
    if (
      await env.DB.prepare("SELECT 1 AS ok FROM users WHERE lower(email)=? AND id<>? LIMIT 1").bind(email, a.user.id).first()
    )
      return bad("Email already exists");
    const pass = password.length > 0 ? await hashPassword(password) : a.user.password_hash;
    await env.DB.prepare("UPDATE users SET username=?,email=?,name=?,password_hash=?,updated_at=unixepoch() WHERE id=?")
      .bind(username, email, name, pass, a.user.id)
      .run();
    const u = await byId(env, a.user.id);
    if (!u) return bad("Failed to update profile");
    return j({ ok: true, data: toPublicUser(u) });
  }
  return na();
}

async function hTeams(req: Request, env: Env): Promise<Response> {
  const a = await requireActor(env, req);
  if (a instanceof Response) return a;
  if (req.method === "GET") {
    if (a.isAdmin) {
      const rows = await env.DB.prepare(
        "SELECT t.id,t.name,t.slug,t.owner_user_id AS ownerUserId,t.created_at AS createdAt,t.updated_at AS updatedAt,'owner' AS membershipRole,(SELECT COUNT(*) FROM sites s WHERE s.team_id=t.id) AS siteCount,(SELECT COUNT(*) FROM team_members x WHERE x.team_id=t.id) AS memberCount FROM teams t ORDER BY t.created_at DESC",
      ).all<Record<string, unknown>>();
      return j({ ok: true, data: rows.results });
    }
    return j({ ok: true, data: await teamsFor(env, a.user.id) });
  }
  if (req.method === "POST") {
    const body = await parseJson(req);
    const name = clampString(String(body.name || ""), 120);
    if (name.length < 2) return bad("Team name is required");
    const slug = await uniqueTeamSlug(env, clampString(String(body.slug || toSlug(name)), 80));
    const teamId = crypto.randomUUID();
    await env.DB.prepare(
      "INSERT INTO teams (id,name,slug,owner_user_id,created_at,updated_at) VALUES (?,?,?,?,unixepoch(),unixepoch())",
    )
      .bind(teamId, name, slug, a.user.id)
      .run();
    await env.DB.prepare("INSERT INTO team_members (team_id,user_id,role,joined_at) VALUES (?,?,'owner',unixepoch())")
      .bind(teamId, a.user.id)
      .run();
    return j({ ok: true, data: { id: teamId, name, slug, ownerUserId: a.user.id, membershipRole: "owner" } });
  }
  if (req.method === "PATCH") {
    const body = await parseJson(req);
    const intent = clampString(String(body.intent || ""), 24).toLowerCase();
    const teamId = clampString(String(body.teamId || ""), 120);
    if (!teamId) return bad("teamId is required");
    if (!(await canManageTeam(env, a, teamId))) return forb("Only team owner can update team");

    const existing = await env.DB.prepare(
      "SELECT id,name,slug,owner_user_id AS ownerUserId,created_at AS createdAt,updated_at AS updatedAt FROM teams WHERE id=? LIMIT 1",
    )
      .bind(teamId)
      .first<{
        id: string;
        name: string;
        slug: string;
        ownerUserId: string;
        createdAt: number;
        updatedAt: number;
      }>();
    if (!existing) return nf("Team not found");

    if (intent === "remove" || intent === "delete") {
      const siteRows = await env.DB.prepare("SELECT id FROM sites WHERE team_id=?")
        .bind(teamId)
        .all<{ id: string }>();
      const siteIds = siteRows.results.map((row) => row.id);

      await env.DB.prepare("DELETE FROM pageviews WHERE team_id=?").bind(teamId).run();

      if (siteIds.length > 0) {
        const sitePlaceholders = siteIds.map(() => "?").join(",");
        await env.DB.prepare(`DELETE FROM pageviews_archive_hourly WHERE site_id IN (${sitePlaceholders})`)
          .bind(...siteIds)
          .run();

        const configKeys = siteIds.map((id) => `site:${id}`);
        const cfgPlaceholders = configKeys.map(() => "?").join(",");
        await env.DB.prepare(`DELETE FROM configs WHERE config_key IN (${cfgPlaceholders})`)
          .bind(...configKeys)
          .run();

        await Promise.allSettled(siteIds.map((id) => deleteSiteScriptSettings(env, id)));
      }

      await env.DB.prepare("DELETE FROM teams WHERE id=?").bind(teamId).run();
      return j({ ok: true, data: { teamId, removed: true } });
    }

    const nameInput = clampString(String(body.name || ""), 120);
    const slugInput = clampString(String(body.slug || ""), 80);
    const name = nameInput || existing.name;
    if (name.length < 2) return bad("Team name is required");
    const slug = slugInput.length > 0 ? await uniqueTeamSlug(env, slugInput, teamId) : await uniqueTeamSlug(env, name, teamId);

    await env.DB.prepare("UPDATE teams SET name=?,slug=?,updated_at=unixepoch() WHERE id=?")
      .bind(name, slug, teamId)
      .run();

    return j({
      ok: true,
      data: {
        id: teamId,
        name,
        slug,
        ownerUserId: existing.ownerUserId,
        createdAt: existing.createdAt,
        updatedAt: Math.floor(Date.now() / 1000),
      },
    });
  }
  return na();
}

async function hSites(req: Request, env: Env, url: URL): Promise<Response> {
  const a = await requireActor(env, req);
  if (a instanceof Response) return a;
  if (req.method === "GET") {
    const teamId = clampString(url.searchParams.get("teamId") || "", 120);
    if (!teamId) return bad("Missing teamId");
    if (!(await canReadTeam(env, a, teamId))) return forb("Team access denied");
    const rows = await env.DB.prepare(
      "SELECT id,team_id AS teamId,name,domain,public_enabled AS publicEnabled,public_slug AS publicSlug,created_at AS createdAt,updated_at AS updatedAt FROM sites WHERE team_id=? ORDER BY created_at DESC",
    )
      .bind(teamId)
      .all<Record<string, unknown>>();
    return j({ ok: true, data: rows.results });
  }
  if (req.method === "POST") {
    const body = await parseJson(req);
    const teamId = clampString(String(body.teamId || ""), 120);
    const name = clampString(String(body.name || ""), 120);
    const domain = clampString(String(body.domain || ""), 255);
    const pub = bool(body.publicEnabled, false);
    const pubSlug = clampString(String(body.publicSlug || toSlug(name || domain || `site-${Date.now()}`)), 120);
    if (!teamId || !name || !domain) return bad("teamId, name and domain are required");
    if (!(await canManageTeam(env, a, teamId))) return forb("Only team owner can create sites");
    const siteId = crypto.randomUUID();
    await env.DB.prepare(
      "INSERT INTO sites (id,team_id,name,domain,public_enabled,public_slug,created_at,updated_at) VALUES (?,?,?,?,?,?,unixepoch(),unixepoch())",
    )
      .bind(siteId, teamId, name, domain, pub ? 1 : 0, pub ? pubSlug : null)
      .run();
    try {
      await upsertSiteScriptSettings(env, siteId, DEFAULT_SITE_SCRIPT_SETTINGS);
    } catch (error) {
      await env.DB.prepare("DELETE FROM sites WHERE id=?").bind(siteId).run();
      throw error;
    }
    return j({ ok: true, data: { id: siteId, teamId, name, domain, publicEnabled: pub, publicSlug: pub ? pubSlug : "" } });
  }
  if (req.method === "PATCH") {
    const body = await parseJson(req);
    const siteId = clampString(String(body.siteId || ""), 120);
    const intent = clampString(String(body.intent || ""), 20);
    if (!siteId) return bad("siteId is required");
    const e = await env.DB.prepare(
      "SELECT id,team_id AS teamId,name,domain,public_enabled AS publicEnabled,public_slug AS publicSlug FROM sites WHERE id=? LIMIT 1",
    )
      .bind(siteId)
      .first<{ id: string; teamId: string; name: string; domain: string; publicEnabled: number; publicSlug: string | null }>();
    if (!e) return nf("Site not found");
    if (!(await canManageTeam(env, a, e.teamId))) return forb("Only team owner can update sites");
    if (intent === "remove") {
      await env.DB.prepare("DELETE FROM configs WHERE config_key=?").bind(`site:${siteId}`).run();
      await env.DB.prepare("DELETE FROM pageviews_archive_hourly WHERE site_id=?").bind(siteId).run();
      await env.DB.prepare("DELETE FROM pageviews WHERE site_id=?").bind(siteId).run();
      await env.DB.prepare("DELETE FROM sites WHERE id=?").bind(siteId).run();
      try {
        await deleteSiteScriptSettings(env, siteId);
      } catch {
        // Best effort cleanup for KV-backed settings.
      }
      return j({ ok: true, data: { siteId, teamId: e.teamId, removed: true } });
    }
    const nextTeamId = clampString(String(body.teamId ?? e.teamId), 120);
    if (!nextTeamId) return bad("teamId is required");
    if (nextTeamId !== e.teamId && !(await canManageTeam(env, a, nextTeamId))) {
      return forb("Only team owner can transfer sites");
    }
    const name = clampString(String(body.name ?? e.name), 120);
    const domain = clampString(String(body.domain ?? e.domain), 255);
    const pub = bool(body.publicEnabled, e.publicEnabled === 1);
    const pubSlug = clampString(String(body.publicSlug ?? e.publicSlug ?? toSlug(name || domain)), 120);
    await env.DB.prepare("UPDATE sites SET team_id=?,name=?,domain=?,public_enabled=?,public_slug=?,updated_at=unixepoch() WHERE id=?")
      .bind(nextTeamId, name, domain, pub ? 1 : 0, pub ? pubSlug : null, siteId)
      .run();
    return j({ ok: true, data: { id: siteId, teamId: nextTeamId, name, domain, publicEnabled: pub, publicSlug: pub ? pubSlug : "" } });
  }
  return na();
}

async function hMembers(req: Request, env: Env, url: URL): Promise<Response> {
  const a = await requireActor(env, req);
  if (a instanceof Response) return a;
  if (req.method === "GET") {
    const teamId = clampString(url.searchParams.get("teamId") || "", 120);
    if (!teamId) return bad("Missing teamId");
    if (!(await canReadTeam(env, a, teamId))) return forb("Team access denied");
    const rows = await env.DB.prepare(
      "SELECT tm.team_id AS teamId,tm.user_id AS userId,tm.role,tm.joined_at AS joinedAt,u.username,u.email,u.name FROM team_members tm INNER JOIN users u ON u.id=tm.user_id WHERE tm.team_id=? ORDER BY tm.joined_at ASC",
    )
      .bind(teamId)
      .all<Record<string, unknown>>();
    return j({ ok: true, data: rows.results });
  }
  if (req.method === "POST") {
    const body = await parseJson(req);
    const teamId = clampString(String(body.teamId || ""), 120);
    const userId = clampString(String(body.userId || ""), 120);
    const identifier = clampString(String(body.identifier || body.username || body.email || ""), 200);
    if (!teamId || (!userId && !identifier)) return bad("teamId and user identifier are required");
    const team = await teamById(env, teamId);
    if (!team) return nf("Team not found");
    if (!(await canManageTeam(env, a, teamId))) return forb("Only team owner can manage members");
    const m = userId ? await byId(env, userId) : await byIdentifier(env, identifier);
    if (!m) return nf("User not found");
    if (m.id === team.ownerUserId) {
      await env.DB.prepare(
        "INSERT INTO team_members (team_id,user_id,role,joined_at) VALUES (?,?,'owner',unixepoch()) ON CONFLICT(team_id,user_id) DO UPDATE SET role='owner'",
      )
        .bind(teamId, m.id)
        .run();
      return j({ ok: true, data: { teamId, userId: m.id, role: "owner", username: m.username, email: m.email, name: m.name || "" } });
    }
    const existingRole = await env.DB.prepare("SELECT role FROM team_members WHERE team_id=? AND user_id=? LIMIT 1")
      .bind(teamId, m.id)
      .first<{ role: string }>();
    if (existingRole?.role === "owner") return forb("Cannot change team owner membership");
    await env.DB.prepare(
      "INSERT INTO team_members (team_id,user_id,role,joined_at) VALUES (?,?,'member',unixepoch()) ON CONFLICT(team_id,user_id) DO UPDATE SET role='member'",
    )
      .bind(teamId, m.id)
      .run();
    return j({ ok: true, data: { teamId, userId: m.id, role: "member", username: m.username, email: m.email, name: m.name || "" } });
  }
  if (req.method === "PATCH") {
    const body = await parseJson(req);
    const teamId = clampString(String(body.teamId || ""), 120);
    const userId = clampString(String(body.userId || ""), 120);
    if (!teamId || !userId) return bad("teamId and userId are required");
    const team = await teamById(env, teamId);
    if (!team) return nf("Team not found");
    if (!(await canManageTeam(env, a, teamId))) return forb("Only team owner can manage members");
    if (userId === team.ownerUserId) return bad("Cannot remove team owner");
    const existing = await env.DB.prepare("SELECT role FROM team_members WHERE team_id=? AND user_id=? LIMIT 1")
      .bind(teamId, userId)
      .first<{ role: string }>();
    if (!existing) return nf("Member not found");
    if (existing.role === "owner") return bad("Cannot remove team owner");
    await env.DB.prepare("DELETE FROM team_members WHERE team_id=? AND user_id=?").bind(teamId, userId).run();
    return j({ ok: true, data: { teamId, userId, removed: true } });
  }
  return na();
}

async function hSiteConfig(req: Request, env: Env, url: URL): Promise<Response> {
  const a = await requireActor(env, req);
  if (a instanceof Response) return a;
  if (req.method === "GET") {
    const siteId = clampString(url.searchParams.get("siteId") || "", 120);
    if (!siteId) return bad("Missing siteId");
    if (!(await canReadSite(env, a, siteId))) return forb("Site access denied");
    try {
      const settings = await readSiteScriptSettings(env, siteId);
      return j({ ok: true, data: settings ?? DEFAULT_SITE_SCRIPT_SETTINGS });
    } catch (error) {
      const message = error instanceof Error ? error.message : "load_site_config_failed";
      return j({ ok: false, error: message }, 500);
    }
  }
  if (req.method === "POST") {
    const body = await parseJson(req);
    const siteId = clampString(String(body.siteId || ""), 120);
    if (!siteId) return bad("siteId is required");
    if (!(await canManageSite(env, a, siteId))) return forb("Only team owner can update site config");
    const cfg = (body.config && typeof body.config === "object" ? body.config : {}) as JsonRecord;
    try {
      const next = await upsertSiteScriptSettings(env, siteId, cfg);
      return j({ ok: true, data: next });
    } catch (error) {
      const message = error instanceof Error ? error.message : "save_site_config_failed";
      return j({ ok: false, error: message }, 500);
    }
  }
  return na();
}

async function hScriptSnippet(req: Request, env: Env, url: URL): Promise<Response> {
  if (req.method !== "GET") return na();
  const a = await requireActor(env, req);
  if (a instanceof Response) return a;
  const siteId = clampString(url.searchParams.get("siteId") || "", 120);
  if (!siteId) return bad("Missing siteId");
  if (!(await canReadSite(env, a, siteId))) return forb("Site access denied");
  const edgeBase = env.EDGE_PUBLIC_BASE_URL || `${url.protocol}//${url.host}`;
  const src = `${edgeBase.replace(/\/$/, "")}/script.js?siteId=${encodeURIComponent(siteId)}`;
  return j({ ok: true, data: { siteId, src, snippet: `<script defer src=\"${src}\"></script>` } });
}

export async function handlePrivateAdmin(request: Request, env: Env, url: URL): Promise<Response> {
  const p = url.pathname;
  if (p === "/api/private/admin/auth/login") return hAuthLogin(request, env);
  if (p === "/api/private/admin/auth/me") return hAuthMe(request, env);
  if (p === "/api/private/admin/users") return hUsers(request, env);
  if (p === "/api/private/admin/profile") return hProfile(request, env);
  if (p === "/api/private/admin/teams") return hTeams(request, env);
  if (p === "/api/private/admin/sites") return hSites(request, env, url);
  if (p === "/api/private/admin/members") return hMembers(request, env, url);
  if (p === "/api/private/admin/site-config") return hSiteConfig(request, env, url);
  if (p === "/api/private/admin/script-snippet") return hScriptSnippet(request, env, url);
  return nf();
}
