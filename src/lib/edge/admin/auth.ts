import { argon2id } from "@noble/hashes/argon2.js";

import { toTeamRole } from "@/lib/dashboard/permissions";
import {
  aggregate,
  and,
  callFunction,
  coalesce,
  compileD1Mutation,
  compileD1Query,
  count,
  createD1DatabaseClient,
  eq as queryEq,
  filter,
  inList,
  insert,
  join,
  limit,
  neq,
  onConflictDoUpdate,
  or,
  param,
  project,
  scalar,
  scan,
  schema,
  sort,
  unixepoch,
  update,
} from "@/lib/db";
import type { AnyExpression, SqlExpression } from "@/lib/db/query/expression";
import type { Relation } from "@/lib/db/query/plan";
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

function database(env: Env) {
  return createD1DatabaseClient(env.DB);
}

function userQuery() {
  const users = scan(schema.users);
  return project(users, {
    id: users.columns.id,
    username: users.columns.username,
    email: users.columns.email,
    name: users.columns.name,
    password_hash: users.columns.password_hash,
    system_role: users.columns.system_role,
    timezone: users.columns.timezone,
    preferred_locale: users.columns.preferred_locale,
    created_at: users.columns.created_at,
    updated_at: users.columns.updated_at,
  });
}

type UserQueryRow = NonNullable<ReturnType<typeof userQuery>["__row"]>;

function requireUserRow(row: UserQueryRow): UserRow {
  if (row.id === null || row.username === null) {
    throw new Error("user_row_missing_required_fields");
  }
  return { ...row, id: row.id, username: row.username };
}

function siteCountFor(teamId: SqlExpression<string | null>) {
  const sites = scan(schema.sites);
  const matchingSites = filter(sites, queryEq(sites.columns.team_id, teamId));
  return coalesce(
    scalar(
      aggregate(matchingSites, {
        groupBy: {},
        aggregates: { count: count() },
      }),
    ),
    param(0),
  );
}

function memberCountFor(teamId: SqlExpression<string | null>) {
  const members = scan(schema.team_members);
  const matchingMembers = filter(
    members,
    queryEq(members.columns.team_id, teamId),
  );
  return coalesce(
    scalar(
      aggregate(matchingMembers, {
        groupBy: {},
        aggregates: { count: count() },
      }),
    ),
    param(0),
  );
}

function orderedTeams<
  Row extends object,
  Columns extends Readonly<Record<string, AnyExpression>>,
>(relation: Relation<Row, Columns>) {
  return sort(relation, [
    { expression: relation.columns.createdAt, direction: "DESC" },
  ]);
}

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
  const users = userQuery();
  const matching = filter(users, queryEq(users.columns.id, param(id)));
  const result = await database(env).first(
    compileD1Query(limit(matching, 1), { tag: "admin.users.first" }),
  );
  return result ? requireUserRow(result) : null;
}

export async function byIdentifier(
  env: Env,
  identifier: string,
): Promise<UserRow | null> {
  const lowered = normU(identifier);
  const users = userQuery();
  const matching = filter(
    users,
    or(
      queryEq(callFunction("lower", users.columns.username), param(lowered)),
      queryEq(callFunction("lower", users.columns.email), param(lowered)),
    ),
  );
  const result = await database(env).first(
    compileD1Query(limit(matching, 1), { tag: "admin.users.first" }),
  );
  return result ? requireUserRow(result) : null;
}

export async function ensureDefaultTeam(
  env: Env,
  user: UserRow,
): Promise<void> {
  const teams = scan(schema.teams);
  const ownedTeams = filter(
    teams,
    queryEq(teams.columns.owner_user_id, param(user.id)),
  );
  const selectedTeams = project(ownedTeams, { id: ownedTeams.columns.id });
  const owned = await database(env).first(
    compileD1Query(limit(selectedTeams, 1), { tag: "admin.teams.first" }),
  );
  if (owned?.id) {
    await database(env).run(
      compileD1Mutation(
        onConflictDoUpdate(
          insert(schema.team_members, {
            team_id: owned.id,
            user_id: user.id,
            role: "owner",
            joined_at: unixepoch(),
          }),
          ["team_id", "user_id"],
          { role: "owner" },
        ),
        { tag: "admin.team_members.ensure_owner" },
      ),
    );
    return;
  }
  const teamId = crypto.randomUUID();
  const displayName = clampString(
    (user.name || user.username || "User").trim(),
    120,
  );
  const slug = await uniqueTeamSlug(env, `${user.username}-team`);
  await database(env).run(
    compileD1Mutation(
      insert(schema.teams, {
        id: teamId,
        name: `${displayName}'s team`,
        slug,
        owner_user_id: user.id,
        created_at: unixepoch(),
        updated_at: unixepoch(),
      }),
      { tag: "admin.teams.create_default" },
    ),
  );
  await database(env).run(
    compileD1Mutation(
      insert(schema.team_members, {
        team_id: teamId,
        user_id: user.id,
        role: "owner",
        joined_at: unixepoch(),
      }),
      { tag: "admin.team_members.create_default_owner" },
    ),
  );
}

export async function ensureBootstrapAdmin(env: Env): Promise<UserRow> {
  const users = userQuery();
  const admins = filter(
    users,
    queryEq(users.columns.system_role, param("admin")),
  );
  const firstAdmin = sort(admins, [
    { expression: admins.columns.created_at, direction: "ASC" },
  ]);
  const adminResult = await database(env).first(
    compileD1Query(limit(firstAdmin, 1), { tag: "admin.users.first" }),
  );
  const admin = adminResult ? requireUserRow(adminResult) : null;
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
    await database(env).run(
      compileD1Mutation(
        update(schema.users, (columns) => ({
          set: {
            username,
            email,
            name,
            password_hash: passHash,
            system_role: "admin",
            updated_at: unixepoch(),
          },
          where: queryEq(columns.id, param(found.id)),
        })),
        { tag: "admin.users.promote_bootstrap" },
      ),
    );
    const promoted = await byId(env, found.id);
    if (!promoted) throw new Error("bootstrap admin promote failed");
    await ensureDefaultTeam(env, promoted);
    return promoted;
  }
  const id = crypto.randomUUID();
  await database(env).run(
    compileD1Mutation(
      insert(schema.users, {
        id,
        username,
        email,
        name,
        password_hash: passHash,
        system_role: "admin",
        created_at: unixepoch(),
        updated_at: unixepoch(),
      }),
      { tag: "admin.users.create_bootstrap" },
    ),
  );
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
  const teams = scan(schema.teams);
  const members = scan(schema.team_members);
  const joined = join(
    teams,
    members,
    queryEq(teams.columns.id, members.columns.team_id),
  );
  const matching = filter(
    joined,
    queryEq(joined.columns.right_user_id, param(userId)),
  );
  const selected = project(matching, {
    id: matching.columns.left_id,
    name: matching.columns.left_name,
    slug: matching.columns.left_slug,
    ownerUserId: matching.columns.left_owner_user_id,
    createdAt: matching.columns.left_created_at,
    updatedAt: matching.columns.left_updated_at,
    membershipRole: matching.columns.right_role,
    siteCount: siteCountFor(matching.columns.left_id),
    memberCount: memberCountFor(matching.columns.left_id),
  });
  const rows = await database(env).all(
    compileD1Query(orderedTeams(selected), { tag: "admin.sites.all" }),
  );
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
  const teams = scan(schema.teams);
  const members = scan(schema.team_members);
  const createdJoined = join(
    teams,
    members,
    and(
      queryEq(teams.columns.id, members.columns.team_id),
      queryEq(members.columns.user_id, param(userId)),
    ),
    "left",
  );
  const createdMatching = filter(
    createdJoined,
    queryEq(createdJoined.columns.left_owner_user_id, param(userId)),
  );
  const createdSelected = project(createdMatching, {
    id: createdMatching.columns.left_id,
    name: createdMatching.columns.left_name,
    slug: createdMatching.columns.left_slug,
    ownerUserId: createdMatching.columns.left_owner_user_id,
    createdAt: createdMatching.columns.left_created_at,
    updatedAt: createdMatching.columns.left_updated_at,
    membershipRole: coalesce(
      createdMatching.columns.right_role,
      param("owner"),
    ),
    siteCount: siteCountFor(createdMatching.columns.left_id),
    memberCount: memberCountFor(createdMatching.columns.left_id),
  });
  const createdRows = await database(env).all(
    compileD1Query(orderedTeams(createdSelected), { tag: "admin.sites.all" }),
  );

  const managedJoined = join(
    teams,
    members,
    queryEq(teams.columns.id, members.columns.team_id),
  );
  const managedMatching = filter(
    managedJoined,
    and(
      queryEq(managedJoined.columns.right_user_id, param(userId)),
      inList(managedJoined.columns.right_role, ["owner", "admin"]),
      neq(managedJoined.columns.left_owner_user_id, param(userId)),
    ),
  );
  const managedSelected = project(managedMatching, {
    id: managedMatching.columns.left_id,
    name: managedMatching.columns.left_name,
    slug: managedMatching.columns.left_slug,
    ownerUserId: managedMatching.columns.left_owner_user_id,
    createdAt: managedMatching.columns.left_created_at,
    updatedAt: managedMatching.columns.left_updated_at,
    membershipRole: managedMatching.columns.right_role,
    siteCount: siteCountFor(managedMatching.columns.left_id),
    memberCount: memberCountFor(managedMatching.columns.left_id),
  });
  const managedRows = await database(env).all(
    compileD1Query(orderedTeams(managedSelected), {
      tag: "admin.sites.all",
    }),
  );

  const memberJoined = join(
    teams,
    members,
    queryEq(teams.columns.id, members.columns.team_id),
  );
  const memberMatching = filter(
    memberJoined,
    and(
      queryEq(memberJoined.columns.right_user_id, param(userId)),
      neq(memberJoined.columns.right_role, param("owner")),
      neq(memberJoined.columns.right_role, param("admin")),
      neq(memberJoined.columns.left_owner_user_id, param(userId)),
    ),
  );
  const memberSelected = project(memberMatching, {
    id: memberMatching.columns.left_id,
    name: memberMatching.columns.left_name,
    slug: memberMatching.columns.left_slug,
    ownerUserId: memberMatching.columns.left_owner_user_id,
    createdAt: memberMatching.columns.left_created_at,
    updatedAt: memberMatching.columns.left_updated_at,
    membershipRole: memberMatching.columns.right_role,
    siteCount: siteCountFor(memberMatching.columns.left_id),
    memberCount: memberCountFor(memberMatching.columns.left_id),
  });
  const memberRows = await database(env).all(
    compileD1Query(orderedTeams(memberSelected), { tag: "admin.sites.all" }),
  );

  let systemRows: { results: Record<string, unknown>[] } = { results: [] };
  if (actor.isAdmin) {
    const systemJoined = join(
      teams,
      members,
      and(
        queryEq(teams.columns.id, members.columns.team_id),
        queryEq(members.columns.user_id, param(userId)),
      ),
      "left",
    );
    const systemSelected = project(systemJoined, {
      id: systemJoined.columns.left_id,
      name: systemJoined.columns.left_name,
      slug: systemJoined.columns.left_slug,
      ownerUserId: systemJoined.columns.left_owner_user_id,
      createdAt: systemJoined.columns.left_created_at,
      updatedAt: systemJoined.columns.left_updated_at,
      membershipRole: systemJoined.columns.right_role,
      siteCount: siteCountFor(systemJoined.columns.left_id),
      memberCount: memberCountFor(systemJoined.columns.left_id),
    });
    systemRows = await database(env).all(
      compileD1Query(orderedTeams(systemSelected), {
        tag: "admin.sites.all",
      }),
    );
  }

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
