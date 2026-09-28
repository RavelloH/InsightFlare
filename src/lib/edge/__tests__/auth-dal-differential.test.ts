import type { DatabaseSync, SQLInputValue } from "node:sqlite";

import { afterEach, describe, expect, it, vi } from "vitest";

import { createMigratedDatabase } from "@/../scripts/schema/database";
import { toTeamRole } from "@/lib/dashboard/permissions";
import { explainQueryPlan } from "@/lib/db/__tests__/query-plan";
import {
  createSqliteD1Database,
  type SqliteD1Trace,
} from "@/lib/db/__tests__/sqlite-d1";
import {
  type Actor,
  byId,
  byIdentifier,
  ensureBootstrapAdmin,
  ensureDefaultTeam,
  normU,
  type SessionTeamGroups,
  teamGroupsForSession,
  teamsFor,
  type UserRow,
} from "@/lib/edge/admin/auth";
import type { Env } from "@/lib/edge/types";

vi.mock("@noble/hashes/argon2.js", () => ({
  argon2id: vi.fn(
    (password: Uint8Array, _nonce: Uint8Array, options: { dkLen: number }) =>
      new Uint8Array(options.dkLen).fill(password[0] ?? 0),
  ),
}));

const FIXED_TIME = 1_800_000_000;
const databases = new Set<DatabaseSync>();
const userColumns =
  "id,username,email,name,password_hash,system_role,timezone,preferred_locale,created_at,updated_at";

function createFixture(
  options: { seedUsers?: boolean; seedGroups?: boolean } = {},
) {
  const database = createMigratedDatabase();
  database.function("unixepoch", () => FIXED_TIME);
  databases.add(database);

  if (options.seedUsers !== false) {
    const insertUser = database.prepare(
      "INSERT INTO users (id,email,name,username,system_role,timezone,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)",
    );
    insertUser.run(
      "actor",
      "Mixed@Example.test",
      "Operator",
      "MixedCase",
      "admin",
      "UTC",
      10,
      10,
    );
    insertUser.run(
      "owner-2",
      "owner2@example.test",
      "Other Owner",
      "owner2",
      "user",
      "UTC",
      20,
      20,
    );
  }

  if (options.seedGroups !== false) seedTeamGroups(database);

  const trace: SqliteD1Trace = { preparedSql: [], bindings: [] };
  const env = {
    MAIN_SECRET: "auth-dal-test-secret",
    BOOTSTRAP_ADMIN_PASSWORD: "test-password",
    DB: createSqliteD1Database(database, trace),
  } as Env;
  return { database, env, trace };
}

function seedTeamGroups(database: DatabaseSync) {
  const insertTeam = database.prepare(
    "INSERT INTO teams (id,name,slug,owner_user_id,created_at,updated_at) VALUES (?,?,?,?,?,?)",
  );
  insertTeam.run("created", "Created", "created", "actor", 400, 400);
  insertTeam.run("managed", "Managed", "managed", "owner-2", 300, 300);
  insertTeam.run("member", "Member", "member", "owner-2", 200, 200);
  insertTeam.run("system", "System", "system", "owner-2", 100, 100);

  const insertMembership = database.prepare(
    "INSERT INTO team_members (team_id,user_id,role,joined_at) VALUES (?,?,?,?)",
  );
  insertMembership.run("managed", "actor", "admin", FIXED_TIME);
  insertMembership.run("member", "actor", "viewer", FIXED_TIME);
  insertMembership.run("member", "owner-2", "owner", FIXED_TIME);

  const insertSite = database.prepare(
    "INSERT INTO sites (id,team_id,name,domain) VALUES (?,?,?,?)",
  );
  insertSite.run("site-created", "created", "Created Site", "created.test");
  insertSite.run("site-managed-1", "managed", "Managed One", "managed1.test");
  insertSite.run("site-managed-2", "managed", "Managed Two", "managed2.test");
  insertSite.run("site-system-1", "system", "System One", "system1.test");
  insertSite.run("site-system-2", "system", "System Two", "system2.test");
  insertSite.run("site-system-3", "system", "System Three", "system3.test");
}

function actorFor(
  user: UserRow,
  isAdmin = user.system_role === "admin",
): Actor {
  return { user, isAdmin };
}

function legacyById(database: DatabaseSync, id: string): UserRow | null {
  return (
    (database
      .prepare(`SELECT ${userColumns} FROM users WHERE id=? LIMIT 1`)
      .get(id) as UserRow | undefined) ?? null
  );
}

function legacyByIdentifier(
  database: DatabaseSync,
  identifier: string,
): UserRow | null {
  const lowered = normU(identifier);
  return (
    (database
      .prepare(
        `SELECT ${userColumns} FROM users WHERE lower(username)=? OR lower(email)=? LIMIT 1`,
      )
      .get(lowered, lowered) as UserRow | undefined) ?? null
  );
}

function legacyRows(
  database: DatabaseSync,
  sql: string,
  ...bindings: SQLInputValue[]
) {
  return database.prepare(sql).all(...bindings) as Array<
    Record<string, unknown>
  >;
}

function mapLegacyTeamRows(rows: Array<Record<string, unknown>>) {
  return rows.map((row) => {
    const role = row.membershipRole;
    if (role === null || role === undefined) {
      const mapped = { ...row };
      delete mapped.membershipRole;
      return mapped;
    }
    return { ...row, membershipRole: toTeamRole(role) };
  });
}

function legacyTeamGroups(
  database: DatabaseSync,
  actor: Actor,
): { teams: Array<Record<string, unknown>>; teamGroups: SessionTeamGroups } {
  const userId = actor.user.id;
  const select =
    "SELECT t.id,t.name,t.slug,t.owner_user_id AS ownerUserId,t.created_at AS createdAt,t.updated_at AS updatedAt,";
  const counts =
    ",(SELECT COUNT(*) FROM sites s WHERE s.team_id=t.id) AS siteCount,(SELECT COUNT(*) FROM team_members x WHERE x.team_id=t.id) AS memberCount FROM teams t ";
  const created = legacyRows(
    database,
    `${select}COALESCE(tm.role,'owner') AS membershipRole${counts}LEFT JOIN team_members tm ON tm.team_id=t.id AND tm.user_id=? WHERE t.owner_user_id=? ORDER BY t.created_at DESC`,
    userId,
    userId,
  );
  const managed = legacyRows(
    database,
    `${select}tm.role AS membershipRole${counts}INNER JOIN team_members tm ON tm.team_id=t.id WHERE tm.user_id=? AND tm.role IN ('owner','admin') AND t.owner_user_id<>? ORDER BY t.created_at DESC`,
    userId,
    userId,
  );
  const member = legacyRows(
    database,
    `${select}tm.role AS membershipRole${counts}INNER JOIN team_members tm ON tm.team_id=t.id WHERE tm.user_id=? AND tm.role NOT IN ('owner','admin') AND t.owner_user_id<>? ORDER BY t.created_at DESC`,
    userId,
    userId,
  );
  const system = actor.isAdmin
    ? legacyRows(
        database,
        `${select}tm.role AS membershipRole${counts}LEFT JOIN team_members tm ON tm.team_id=t.id AND tm.user_id=? ORDER BY t.created_at DESC`,
        userId,
      )
    : [];
  const teamGroups: SessionTeamGroups = {
    created: mapLegacyTeamRows(created),
    managed: mapLegacyTeamRows(managed),
    member: mapLegacyTeamRows(member),
    system: mapLegacyTeamRows(system),
  };
  const seen = new Set<string>();
  const teams: Array<Record<string, unknown>> = [];
  for (const group of [
    teamGroups.created,
    teamGroups.managed,
    teamGroups.member,
    teamGroups.system,
  ]) {
    for (const team of group) {
      const id = String(team.id || "");
      if (!id || seen.has(id)) continue;
      seen.add(id);
      teams.push(team);
    }
  }
  return { teams, teamGroups };
}

function legacyTeamsFor(database: DatabaseSync, userId: string) {
  return mapLegacyTeamRows(
    legacyRows(
      database,
      "SELECT t.id,t.name,t.slug,t.owner_user_id AS ownerUserId,t.created_at AS createdAt,t.updated_at AS updatedAt,tm.role AS membershipRole,(SELECT COUNT(*) FROM sites s WHERE s.team_id=t.id) AS siteCount,(SELECT COUNT(*) FROM team_members x WHERE x.team_id=t.id) AS memberCount FROM teams t INNER JOIN team_members tm ON tm.team_id=t.id WHERE tm.user_id=? ORDER BY t.created_at DESC",
      userId,
    ),
  );
}

function legacyUniqueTeamSlug(database: DatabaseSync, raw: string) {
  const base = raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
  const normalizedBase = base || "team";
  let slug = normalizedBase;
  let suffix = 2;
  while (
    database.prepare("SELECT 1 FROM teams WHERE slug=? LIMIT 1").get(slug)
  ) {
    slug = `${normalizedBase}-${suffix}`;
    suffix += 1;
  }
  return slug;
}

async function legacyEnsureDefaultTeam(
  database: DatabaseSync,
  user: UserRow,
): Promise<number> {
  let statements = 1;
  const owned = database
    .prepare("SELECT id FROM teams WHERE owner_user_id=? LIMIT 1")
    .get(user.id) as { id: string } | undefined;
  if (owned?.id) {
    database
      .prepare(
        "INSERT INTO team_members (team_id,user_id,role,joined_at) VALUES (?,?,'owner',unixepoch()) ON CONFLICT(team_id,user_id) DO UPDATE SET role='owner'",
      )
      .run(owned.id, user.id);
    return statements + 1;
  }

  const teamId = crypto.randomUUID();
  const displayName = (user.name || user.username || "User").trim();
  const slug = legacyUniqueTeamSlug(database, `${user.username}-team`);
  statements += 1;
  database
    .prepare(
      "INSERT INTO teams (id,name,slug,owner_user_id,created_at,updated_at) VALUES (?,?,?,?,unixepoch(),unixepoch())",
    )
    .run(teamId, `${displayName}'s team`, slug, user.id);
  statements += 1;
  database
    .prepare(
      "INSERT INTO team_members (team_id,user_id,role,joined_at) VALUES (?,?,'owner',unixepoch())",
    )
    .run(teamId, user.id);
  return statements + 1;
}

async function legacyEnsureBootstrapAdmin(
  database: DatabaseSync,
  password: string,
): Promise<{ user: UserRow; statements: number }> {
  let statements = 1;
  const admin = database
    .prepare(
      `SELECT ${userColumns} FROM users WHERE system_role='admin' ORDER BY created_at ASC LIMIT 1`,
    )
    .get() as UserRow | undefined;
  if (admin) {
    statements += await legacyEnsureDefaultTeam(database, admin);
    return { user: admin, statements };
  }

  const username = "admin";
  const email = `${username}@insightflare.local`;
  const name = "Administrator";
  const { hashPassword } = await import("@/lib/edge/admin/auth");
  const passHash = await hashPassword(password);
  const found = legacyByIdentifier(database, username);
  statements += 1;
  if (found) {
    database
      .prepare(
        "UPDATE users SET username=?,email=?,name=?,password_hash=?,system_role='admin',updated_at=unixepoch() WHERE id=?",
      )
      .run(username, email, name, passHash, found.id);
    statements += 1;
    const promoted = legacyById(database, found.id);
    statements += 1;
    if (!promoted) throw new Error("bootstrap admin promote failed");
    statements += await legacyEnsureDefaultTeam(database, promoted);
    return { user: promoted, statements };
  }

  const id = crypto.randomUUID();
  database
    .prepare(
      "INSERT INTO users (id,username,email,name,password_hash,system_role,created_at,updated_at) VALUES (?,?,?,?,?,'admin',unixepoch(),unixepoch())",
    )
    .run(id, username, email, name, passHash);
  statements += 1;
  const created = legacyById(database, id);
  statements += 1;
  if (!created) throw new Error("bootstrap admin create failed");
  statements += await legacyEnsureDefaultTeam(database, created);
  return { user: created, statements };
}

function mockUuids(...ids: string[]) {
  const spy = vi.spyOn(crypto, "randomUUID");
  spy.mockReset();
  for (const id of ids)
    spy.mockReturnValueOnce(id as ReturnType<typeof crypto.randomUUID>);
  if (ids.length > 0) {
    spy.mockReturnValue(
      ids[ids.length - 1] as ReturnType<typeof crypto.randomUUID>,
    );
  }
}

function publicBootstrapRow(user: UserRow) {
  return { ...user, password_hash: null };
}

function expectIndexSearch(plan: readonly string[], indexName: string) {
  expect(
    plan.some(
      (detail) => detail.includes("SEARCH") && detail.includes(indexName),
    ),
    plan.join("\n"),
  ).toBe(true);
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const database of databases) database.close();
  databases.clear();
});

describe("admin auth Typed DAL differential checks", () => {
  it("matches byId and case-normalized username/email lookups", async () => {
    const { database, env, trace } = createFixture();

    await expect(byId(env, "actor")).resolves.toEqual(
      legacyById(database, "actor"),
    );
    await expect(byId(env, "missing")).resolves.toBe(
      legacyById(database, "missing"),
    );
    for (const identifier of [
      "mixedcase",
      "MIXEDCASE",
      "mixed@example.test",
      "MIXED@EXAMPLE.TEST",
      "not-found",
    ]) {
      await expect(byIdentifier(env, identifier)).resolves.toEqual(
        legacyByIdentifier(database, identifier),
      );
    }
    expect(trace.preparedSql).toHaveLength(7);
    expect(trace.bindings.every((bindings) => bindings.length <= 100)).toBe(
      true,
    );
  });

  it("matches teamsFor rows, counts, ordering, and one-query behavior", async () => {
    const { database, env, trace } = createFixture();

    await expect(teamsFor(env, "actor")).resolves.toEqual(
      legacyTeamsFor(database, "actor"),
    );
    expect(trace.preparedSql).toHaveLength(1);
    expect(trace.bindings[0]?.length).toBeLessThanOrEqual(100);
    const plan = explainQueryPlan(database, {
      sql: trace.preparedSql[0]!,
      bindings: trace.bindings[0]!,
    });
    expectIndexSearch(plan, "idx_team_members_user");
    expectIndexSearch(plan, "idx_sites_team");
    expectIndexSearch(plan, "sqlite_autoindex_team_members_1");
  });

  it("matches all session groups and keeps the non-admin query count", async () => {
    const { database, env, trace } = createFixture();
    const admin = legacyById(database, "actor");
    if (!admin) throw new Error("test actor missing");

    await expect(teamGroupsForSession(env, actorFor(admin))).resolves.toEqual(
      legacyTeamGroups(database, actorFor(admin)),
    );
    expect(trace.preparedSql).toHaveLength(4);

    trace.preparedSql.length = 0;
    trace.bindings.length = 0;
    await expect(
      teamGroupsForSession(env, actorFor(admin, false)),
    ).resolves.toEqual(legacyTeamGroups(database, actorFor(admin, false)));
    expect(trace.preparedSql).toHaveLength(3);
  });

  it("matches existing-team owner upsert and keeps it to two statements", async () => {
    const typed = createFixture({ seedGroups: false });
    const legacy = createFixture({ seedGroups: false });
    const user = legacyById(typed.database, "actor");
    const legacyUser = legacyById(legacy.database, "actor");
    if (!user || !legacyUser) throw new Error("test actor missing");
    for (const fixture of [typed, legacy]) {
      fixture.database
        .prepare(
          "INSERT INTO teams (id,name,slug,owner_user_id) VALUES (?,?,?,?)",
        )
        .run("owned", "Owned", "owned", "actor");
      fixture.database
        .prepare(
          "INSERT INTO team_members (team_id,user_id,role) VALUES (?,?,?)",
        )
        .run("owned", "actor", "member");
    }

    await ensureDefaultTeam(typed.env, user);
    const legacyCount = await legacyEnsureDefaultTeam(
      legacy.database,
      legacyUser,
    );
    expect(typed.trace.preparedSql).toHaveLength(2);
    expect(typed.trace.preparedSql).toHaveLength(legacyCount);
    expect(
      typed.database
        .prepare(
          "SELECT team_id,user_id,role,joined_at FROM team_members WHERE team_id='owned'",
        )
        .all(),
    ).toEqual(
      legacy.database
        .prepare(
          "SELECT team_id,user_id,role,joined_at FROM team_members WHERE team_id='owned'",
        )
        .all(),
    );
  });

  it("matches new default-team creation as two separate writes", async () => {
    const typed = createFixture({ seedGroups: false });
    const legacy = createFixture({ seedGroups: false });
    const user = legacyById(typed.database, "actor");
    const legacyUser = legacyById(legacy.database, "actor");
    if (!user || !legacyUser) throw new Error("test actor missing");

    mockUuids("00000000-0000-4000-8000-000000000001");
    await ensureDefaultTeam(typed.env, user);
    mockUuids("00000000-0000-4000-8000-000000000001");
    const legacyCount = await legacyEnsureDefaultTeam(
      legacy.database,
      legacyUser,
    );
    expect(typed.trace.preparedSql).toHaveLength(4);
    expect(typed.trace.preparedSql).toHaveLength(legacyCount);
    expect(
      typed.database
        .prepare("SELECT name,slug,owner_user_id FROM teams ORDER BY slug")
        .all(),
    ).toEqual(
      legacy.database
        .prepare("SELECT name,slug,owner_user_id FROM teams ORDER BY slug")
        .all(),
    );
    expect(
      typed.database
        .prepare(
          "SELECT team_id,user_id,role FROM team_members ORDER BY team_id,user_id",
        )
        .all(),
    ).toEqual(
      legacy.database
        .prepare(
          "SELECT team_id,user_id,role FROM team_members ORDER BY team_id,user_id",
        )
        .all(),
    );
  });

  it.each([
    { kind: "promotion", existingUser: true },
    { kind: "creation", existingUser: false },
  ])("matches bootstrap admin $kind", async ({ existingUser }) => {
    const typed = createFixture({ seedUsers: false, seedGroups: false });
    const legacy = createFixture({ seedUsers: false, seedGroups: false });
    if (existingUser) {
      for (const fixture of [typed, legacy]) {
        fixture.database
          .prepare(
            "INSERT INTO users (id,email,name,username,system_role,timezone,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)",
          )
          .run(
            "existing",
            "old@example.test",
            "Old Admin",
            "ADMIN",
            "user",
            "UTC",
            20,
            20,
          );
      }
    }

    const newUserId = "00000000-0000-4000-8000-000000000010";
    const newTeamId = "00000000-0000-4000-8000-000000000011";
    mockUuids(newUserId, newTeamId);
    const typedUser = await ensureBootstrapAdmin(typed.env);
    mockUuids(newUserId, newTeamId);
    const { user: legacyUser, statements: legacyCount } =
      await legacyEnsureBootstrapAdmin(
        legacy.database,
        String(legacy.env.BOOTSTRAP_ADMIN_PASSWORD),
      );

    expect(publicBootstrapRow(typedUser)).toEqual(
      publicBootstrapRow(legacyUser),
    );
    expect(typed.trace.preparedSql).toHaveLength(legacyCount);
    expect(typed.trace.preparedSql).toHaveLength(8);
    expect(
      typed.database
        .prepare(
          "SELECT username,email,name,system_role FROM users ORDER BY id",
        )
        .all(),
    ).toEqual(
      legacy.database
        .prepare(
          "SELECT username,email,name,system_role FROM users ORDER BY id",
        )
        .all(),
    );
    expect(
      typed.database
        .prepare("SELECT name,slug,owner_user_id FROM teams ORDER BY slug")
        .all(),
    ).toEqual(
      legacy.database
        .prepare("SELECT name,slug,owner_user_id FROM teams ORDER BY slug")
        .all(),
    );
  });
});
