import { argon2id } from "@noble/hashes/argon2.js";

import { toTeamRole } from "@/lib/dashboard/permissions";
import { uniqueTeamSlug } from "@/lib/edge/admin/access";
import { requireSession } from "@/lib/edge/auth/session-auth";
import type { Env } from "@/lib/edge/types";
import { clampString } from "@/lib/edge/utils";
import { isValidLocale } from "@/lib/i18n/config";
import { una } from "@/lib/response";

export type UserRow = {
  id: string;
  username: string;
  email: string;
  name: string | null;
  password_hash: string | null;
  system_role: string;
  timezone: string;
  preferred_locale?: string | null;
  created_at: number;
  updated_at: number;
};

export type Actor = { user: UserRow; isAdmin: boolean };

type Argon2HashParts = {
  version: number;
  memory: number;
  passes: number;
  parallelism: number;
  nonce: Uint8Array;
  expected: Uint8Array;
};

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

export const normU = (s: string) => clampString(s.trim().toLowerCase(), 80);
export const normE = (s: string) => clampString(s.trim().toLowerCase(), 200);

const b64u = (b: Uint8Array) => {
  let bin = "";
  for (let i = 0; i < b.length; i += 1) bin += String.fromCharCode(b[i]);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
};
const u8 = (s: string) => new TextEncoder().encode(s);
const fromB64u = (v: string) => {
  const p =
    v.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((v.length + 3) % 4);
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
  if (!Number.isFinite(version) || (version !== 16 && version !== 19))
    return null;
  if (
    !Number.isFinite(memory) ||
    memory < ARGON2_MIN_MEMORY_KIB ||
    memory > ARGON2_MAX_MEMORY_KIB
  )
    return null;
  if (
    !Number.isFinite(passes) ||
    passes < ARGON2_MIN_PASSES ||
    passes > ARGON2_MAX_PASSES
  )
    return null;
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

export async function hashPassword(password: string): Promise<string> {
  return hashPasswordArgon2(password);
}

export async function verifyPassword(
  password: string,
  stored: string | null | undefined,
): Promise<boolean> {
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

export const toPublicUser = (u: UserRow) => ({
  id: u.id,
  username: u.username,
  email: u.email,
  name: u.name || "",
  systemRole: u.system_role === "admin" ? "admin" : "user",
  timeZone: u.timezone || "",
  preferredLocale: isValidLocale(u.preferred_locale) ? u.preferred_locale : "",
  createdAt: u.created_at,
  updatedAt: u.updated_at,
});

export async function byId(env: Env, id: string): Promise<UserRow | null> {
  return (
    (await env.DB.prepare(
      "SELECT id,username,email,name,password_hash,system_role,timezone,preferred_locale,created_at,updated_at FROM users WHERE id=? LIMIT 1",
    )
      .bind(id)
      .first<UserRow>()) ?? null
  );
}

export async function byIdentifier(
  env: Env,
  identifier: string,
): Promise<UserRow | null> {
  const lowered = normU(identifier);
  return (
    (await env.DB.prepare(
      "SELECT id,username,email,name,password_hash,system_role,timezone,preferred_locale,created_at,updated_at FROM users WHERE lower(username)=? OR lower(email)=? LIMIT 1",
    )
      .bind(lowered, lowered)
      .first<UserRow>()) ?? null
  );
}

export async function ensureDefaultTeam(
  env: Env,
  user: UserRow,
): Promise<void> {
  const owned = await env.DB.prepare(
    "SELECT id FROM teams WHERE owner_user_id=? LIMIT 1",
  )
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
  const displayName = clampString(
    (user.name || user.username || "User").trim(),
    120,
  );
  const slug = await uniqueTeamSlug(env, `${user.username}-team`);
  await env.DB.prepare(
    "INSERT INTO teams (id,name,slug,owner_user_id,created_at,updated_at) VALUES (?,?,?,?,unixepoch(),unixepoch())",
  )
    .bind(teamId, `${displayName}'s team`, slug, user.id)
    .run();
  await env.DB.prepare(
    "INSERT INTO team_members (team_id,user_id,role,joined_at) VALUES (?,?,'owner',unixepoch())",
  )
    .bind(teamId, user.id)
    .run();
}

export async function ensureBootstrapAdmin(env: Env): Promise<UserRow> {
  const admin = await env.DB.prepare(
    "SELECT id,username,email,name,password_hash,system_role,timezone,preferred_locale,created_at,updated_at FROM users WHERE system_role='admin' ORDER BY created_at ASC LIMIT 1",
  ).first<UserRow>();
  if (admin) {
    await ensureDefaultTeam(env, admin);
    return admin;
  }
  const username = "admin";
  const email = normE(`${username}@insightflare.local`);
  const name = "Administrator";
  const passHash = await hashPassword(
    String(env.BOOTSTRAP_ADMIN_PASSWORD || "insightflare"),
  );
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

export async function requireActor(
  env: Env,
  req: Request,
): Promise<Actor | Response> {
  const session = await requireSession(req, env);
  if (!session) return una();
  const uid = clampString(session.userId, 120);
  if (!uid) return una();
  const user = await byId(env, uid);
  if (!user) return una("User not found");
  return { user, isAdmin: user.system_role === "admin" };
}

export async function teamsFor(
  env: Env,
  userId: string,
): Promise<Array<Record<string, unknown>>> {
  const rows = await env.DB.prepare(
    "SELECT t.id,t.name,t.slug,t.owner_user_id AS ownerUserId,t.created_at AS createdAt,t.updated_at AS updatedAt,tm.role AS membershipRole,(SELECT COUNT(*) FROM sites s WHERE s.team_id=t.id) AS siteCount,(SELECT COUNT(*) FROM team_members x WHERE x.team_id=t.id) AS memberCount FROM teams t INNER JOIN team_members tm ON tm.team_id=t.id WHERE tm.user_id=? ORDER BY t.created_at DESC",
  )
    .bind(userId)
    .all<Record<string, unknown>>();
  return rows.results.map((row) => ({
    ...row,
    membershipRole: toTeamRole(row.membershipRole),
  }));
}

export interface SessionTeamGroups {
  created: Array<Record<string, unknown>>;
  managed: Array<Record<string, unknown>>;
  member: Array<Record<string, unknown>>;
  system: Array<Record<string, unknown>>;
}

function mapTeamRows(
  rows: Array<Record<string, unknown>>,
): Array<Record<string, unknown>> {
  return rows.map((row) => {
    const role = row.membershipRole;
    const mapped = { ...row };
    if (role === null || role === undefined) {
      delete mapped.membershipRole;
      return mapped;
    }
    return {
      ...mapped,
      membershipRole: toTeamRole(role),
    };
  });
}

function flattenTeamGroups(groups: SessionTeamGroups) {
  const seen = new Set<string>();
  const out: Array<Record<string, unknown>> = [];

  for (const group of [
    groups.created,
    groups.managed,
    groups.member,
    groups.system,
  ]) {
    for (const team of group) {
      const id = String(team.id || "");
      if (!id || seen.has(id)) continue;
      seen.add(id);
      out.push(team);
    }
  }

  return out;
}

export async function teamGroupsForSession(
  env: Env,
  actor: Actor,
): Promise<{
  teams: Array<Record<string, unknown>>;
  teamGroups: SessionTeamGroups;
}> {
  const userId = actor.user.id;
  const createdRows = await env.DB.prepare(
    "SELECT t.id,t.name,t.slug,t.owner_user_id AS ownerUserId,t.created_at AS createdAt,t.updated_at AS updatedAt,COALESCE(tm.role,'owner') AS membershipRole,(SELECT COUNT(*) FROM sites s WHERE s.team_id=t.id) AS siteCount,(SELECT COUNT(*) FROM team_members x WHERE x.team_id=t.id) AS memberCount FROM teams t LEFT JOIN team_members tm ON tm.team_id=t.id AND tm.user_id=? WHERE t.owner_user_id=? ORDER BY t.created_at DESC",
  )
    .bind(userId, userId)
    .all<Record<string, unknown>>();
  const managedRows = await env.DB.prepare(
    "SELECT t.id,t.name,t.slug,t.owner_user_id AS ownerUserId,t.created_at AS createdAt,t.updated_at AS updatedAt,tm.role AS membershipRole,(SELECT COUNT(*) FROM sites s WHERE s.team_id=t.id) AS siteCount,(SELECT COUNT(*) FROM team_members x WHERE x.team_id=t.id) AS memberCount FROM teams t INNER JOIN team_members tm ON tm.team_id=t.id WHERE tm.user_id=? AND tm.role IN ('owner','admin') AND t.owner_user_id<>? ORDER BY t.created_at DESC",
  )
    .bind(userId, userId)
    .all<Record<string, unknown>>();
  const memberRows = await env.DB.prepare(
    "SELECT t.id,t.name,t.slug,t.owner_user_id AS ownerUserId,t.created_at AS createdAt,t.updated_at AS updatedAt,tm.role AS membershipRole,(SELECT COUNT(*) FROM sites s WHERE s.team_id=t.id) AS siteCount,(SELECT COUNT(*) FROM team_members x WHERE x.team_id=t.id) AS memberCount FROM teams t INNER JOIN team_members tm ON tm.team_id=t.id WHERE tm.user_id=? AND tm.role NOT IN ('owner','admin') AND t.owner_user_id<>? ORDER BY t.created_at DESC",
  )
    .bind(userId, userId)
    .all<Record<string, unknown>>();
  const systemRows = actor.isAdmin
    ? await env.DB.prepare(
        "SELECT t.id,t.name,t.slug,t.owner_user_id AS ownerUserId,t.created_at AS createdAt,t.updated_at AS updatedAt,tm.role AS membershipRole,(SELECT COUNT(*) FROM sites s WHERE s.team_id=t.id) AS siteCount,(SELECT COUNT(*) FROM team_members x WHERE x.team_id=t.id) AS memberCount FROM teams t LEFT JOIN team_members tm ON tm.team_id=t.id AND tm.user_id=? ORDER BY t.created_at DESC",
      )
        .bind(userId)
        .all<Record<string, unknown>>()
    : { results: [] };

  const teamGroups: SessionTeamGroups = {
    created: mapTeamRows(createdRows.results),
    managed: mapTeamRows(managedRows.results),
    member: mapTeamRows(memberRows.results),
    system: mapTeamRows(systemRows.results),
  };

  return {
    teams: flattenTeamGroups(teamGroups),
    teamGroups,
  };
}
