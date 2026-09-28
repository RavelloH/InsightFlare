import type { DatabaseSync, SQLInputValue } from "node:sqlite";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createMigratedDatabase } from "@/../scripts/schema/database";
import { normalizeTimeZone } from "@/lib/analytics/time-zone";
import { explainQueryPlan } from "@/lib/db/__tests__/query-plan";
import {
  createSqliteD1Database,
  type SqliteD1Trace,
} from "@/lib/db/__tests__/sqlite-d1";
import { toSlug } from "@/lib/edge/admin/access";
import {
  hashPassword,
  normE,
  normU,
  toPublicUser,
  type UserRow,
} from "@/lib/edge/admin/auth";
import { toRole } from "@/lib/edge/admin/response";
import {
  handleProfileAdmin,
  handleUsersAdmin,
} from "@/lib/edge/admin/users/handlers";
import type { Env } from "@/lib/edge/types";

const requireSessionMock = vi.hoisted(() => vi.fn());
vi.mock("@/lib/edge/auth/session-auth", () => ({
  requireSession: requireSessionMock,
}));
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
const ADMIN_ID = "00000000-0000-4000-8000-000000000001";
const TARGET_ID = "00000000-0000-4000-8000-000000000002";

function createFixture() {
  const database = createMigratedDatabase();
  database.function("unixepoch", () => FIXED_TIME);
  databases.add(database);

  const insertUser = database.prepare(
    "INSERT INTO users (id,email,name,username,system_role,timezone,created_at,updated_at,password_hash) VALUES (?,?,?,?,?,?,?,?,?)",
  );
  insertUser.run(
    ADMIN_ID,
    "admin@example.test",
    "Administrator",
    "admin",
    "admin",
    "UTC",
    10,
    10,
    null,
  );
  insertUser.run(
    TARGET_ID,
    "target@example.test",
    "Target User",
    "target",
    "user",
    "UTC",
    20,
    20,
    null,
  );

  database
    .prepare(
      "INSERT INTO teams (id,name,slug,owner_user_id,created_at,updated_at) VALUES (?,?,?,?,?,?)",
    )
    .run("admin-team", "Admin Team", "admin-team", ADMIN_ID, 30, 30);
  database
    .prepare(
      "INSERT INTO teams (id,name,slug,owner_user_id,created_at,updated_at) VALUES (?,?,?,?,?,?)",
    )
    .run("other-team", "Other Team", "other-team", ADMIN_ID, 40, 40);
  database
    .prepare("INSERT INTO team_members (team_id,user_id,role) VALUES (?,?,?)")
    .run("admin-team", ADMIN_ID, "owner");
  database
    .prepare("INSERT INTO team_members (team_id,user_id,role) VALUES (?,?,?)")
    .run("admin-team", TARGET_ID, "member");

  const trace: SqliteD1Trace = {
    preparedSql: [],
    bindings: [],
    batchStatements: [],
  };
  const env = {
    MAIN_SECRET: "users-dal-test-secret",
    DB: createSqliteD1Database(database, trace),
  } as Env;
  return { database, env, trace };
}

function mockUuids(...ids: string[]) {
  const spy = vi.spyOn(crypto, "randomUUID");
  spy.mockReset();
  for (const id of ids) {
    spy.mockReturnValueOnce(id as ReturnType<typeof crypto.randomUUID>);
  }
  if (ids.length > 0) {
    spy.mockReturnValue(
      ids[ids.length - 1] as ReturnType<typeof crypto.randomUUID>,
    );
  }
}

function request(
  method: "GET" | "POST" | "PATCH",
  body?: Record<string, unknown>,
) {
  return new Request("https://edge.test/api/private/admin/users", {
    method,
    headers: body ? { "content-type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
}

function legacyUser(database: DatabaseSync, id: string): UserRow | null {
  return (
    (database
      .prepare(`SELECT ${userColumns} FROM users WHERE id=? LIMIT 1`)
      .get(id) as UserRow | undefined) ?? null
  );
}

function legacyUsersList(database: DatabaseSync) {
  return database
    .prepare(
      "SELECT u.id,u.username,u.email,u.name,u.system_role AS systemRole,u.timezone AS timeZone,u.preferred_locale AS preferredLocale,u.created_at AS createdAt,u.updated_at AS updatedAt,(SELECT COUNT(*) FROM team_members tm WHERE tm.user_id=u.id) AS teamCount,(SELECT COUNT(*) FROM teams t WHERE t.owner_user_id=u.id) AS ownedTeamCount FROM users u ORDER BY u.created_at ASC",
    )
    .all() as Array<Record<string, unknown>>;
}

function sqlRows(
  database: DatabaseSync,
  sql: string,
  ...bindings: SQLInputValue[]
) {
  return database.prepare(sql).all(...bindings) as Array<
    Record<string, unknown>
  >;
}

function publicState(database: DatabaseSync) {
  return sqlRows(
    database,
    "SELECT id,username,email,name,system_role,timezone,preferred_locale,created_at,updated_at FROM users ORDER BY id",
  );
}

function expectIndexSearch(plan: readonly string[], indexName: string) {
  expect(
    plan.some(
      (detail) => detail.includes("SEARCH") && detail.includes(indexName),
    ),
    plan.join("\n"),
  ).toBe(true);
}

function legacyUniqueSlug(database: DatabaseSync, raw: string) {
  const base = toSlug(raw) || "team";
  let slug = base;
  let suffix = 2;
  while (
    database.prepare("SELECT 1 FROM teams WHERE slug=? LIMIT 1").get(slug)
  ) {
    slug = `${base}-${suffix}`;
    suffix += 1;
  }
  return slug;
}

async function legacyCreateUser(database: DatabaseSync, ids: [string, string]) {
  const username = normU(" New.User ");
  const email = normE(" NEW@example.test ");
  const name = "New User";
  const password = "long-enough-password";
  const systemRole = toRole("manager");
  const teamName = `${name}'s team`;
  const teamSlug = legacyUniqueSlug(database, `${username}-team`);
  const passwordHash = await hashPassword(password);

  database.exec("BEGIN");
  try {
    database
      .prepare(
        "INSERT INTO users (id,username,email,name,password_hash,system_role,created_at,updated_at) VALUES (?,?,?,?,?,?,unixepoch(),unixepoch())",
      )
      .run(ids[0], username, email, name, passwordHash, systemRole);
    database
      .prepare(
        "INSERT INTO teams (id,name,slug,owner_user_id,created_at,updated_at) VALUES (?,?,?,?,unixepoch(),unixepoch())",
      )
      .run(ids[1], teamName, teamSlug, ids[0]);
    database
      .prepare(
        "INSERT INTO team_members (team_id,user_id,role,joined_at) VALUES (?,?,'owner',unixepoch())",
      )
      .run(ids[1], ids[0]);
    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }

  const created = legacyUser(database, ids[0]);
  if (!created) throw new Error("legacy user insert failed");
  return {
    data: {
      ...toPublicUser(created),
      team: {
        id: ids[1],
        name: teamName,
        slug: teamSlug,
        ownerUserId: ids[0],
        membershipRole: "owner",
        siteCount: 0,
        memberCount: 1,
      },
    },
  };
}

beforeEach(() => {
  requireSessionMock.mockReset();
  requireSessionMock.mockResolvedValue({ userId: ADMIN_ID });
});

afterEach(() => {
  vi.restoreAllMocks();
  for (const database of databases) database.close();
  databases.clear();
});

describe("admin users Typed DAL differential checks", () => {
  it("matches the user list including correlated counts in one list query", async () => {
    const { database, env, trace } = createFixture();
    const response = await handleUsersAdmin(request("GET"), env);

    expect(response.status).toBe(200);
    const body = (await response.json()) as { data: unknown };
    expect(body.data).toEqual(legacyUsersList(database));
    expect(trace.preparedSql).toHaveLength(2);
    expect(trace.bindings.every((bindings) => bindings.length <= 100)).toBe(
      true,
    );
    expectIndexSearch(
      explainQueryPlan(database, {
        sql: trace.preparedSql[1]!,
        bindings: trace.bindings[1]!,
      }),
      "idx_team_members_user",
    );
  });

  it("keeps user creation in one ordered three-statement batch", async () => {
    const typed = createFixture();
    const legacy = createFixture();
    const ids = [
      "00000000-0000-4000-8000-000000000101",
      "00000000-0000-4000-8000-000000000102",
    ] as const;
    mockUuids(...ids);
    const response = await handleUsersAdmin(
      request("POST", {
        username: " New.User ",
        email: " NEW@example.test ",
        name: "New User",
        password: "long-enough-password",
        systemRole: "manager",
      }),
      typed.env,
    );
    mockUuids(...ids);
    const expected = await legacyCreateUser(legacy.database, [...ids]);

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ok: true, ...expected });
    expect(typed.trace.batchStatements).toHaveLength(1);
    const batch = typed.trace.batchStatements?.[0] ?? [];
    expect(batch).toHaveLength(3);
    expect(
      batch.map((sql) => /INSERT INTO\s+[`"']?([a-z_]+)[`"']?/i.exec(sql)?.[1]),
    ).toEqual(["users", "teams", "team_members"]);
    expect(typed.trace.preparedSql).toHaveLength(8);
    expect(publicState(typed.database)).toEqual(publicState(legacy.database));
    expect(
      typed.database
        .prepare("SELECT password_hash FROM users WHERE id=?")
        .get(ids[0]),
    ).toMatchObject({ password_hash: expect.stringMatching(/^argon2id\$/) });
    expect(
      sqlRows(
        typed.database,
        "SELECT id,name,slug,owner_user_id FROM teams WHERE id=?",
        ids[1],
      ),
    ).toEqual(
      sqlRows(
        legacy.database,
        "SELECT id,name,slug,owner_user_id FROM teams WHERE id=?",
        ids[1],
      ),
    );
    expect(
      sqlRows(
        typed.database,
        "SELECT team_id,user_id,role FROM team_members WHERE team_id=? AND user_id=?",
        ids[1],
        ids[0],
      ),
    ).toEqual(
      sqlRows(
        legacy.database,
        "SELECT team_id,user_id,role FROM team_members WHERE team_id=? AND user_id=?",
        ids[1],
        ids[0],
      ),
    );
  });

  it("matches the owned-team guard and user delete query sequence", async () => {
    const typed = createFixture();
    const legacy = createFixture();
    const response = await handleUsersAdmin(
      request("PATCH", { intent: "delete", userId: TARGET_ID }),
      typed.env,
    );
    legacy.database.prepare("DELETE FROM users WHERE id=?").run(TARGET_ID);

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      ok: true,
      data: { userId: TARGET_ID, removed: true },
    });
    expect(typed.trace.preparedSql).toHaveLength(4);
    expect(publicState(typed.database)).toEqual(publicState(legacy.database));
    expect(
      sqlRows(
        typed.database,
        "SELECT team_id,user_id,role FROM team_members ORDER BY team_id,user_id",
      ),
    ).toEqual(
      sqlRows(
        legacy.database,
        "SELECT team_id,user_id,role FROM team_members ORDER BY team_id,user_id",
      ),
    );
  });

  it("matches user update fields and reload behavior", async () => {
    const typed = createFixture();
    const legacy = createFixture();
    const response = await handleUsersAdmin(
      request("PATCH", {
        intent: "update",
        userId: TARGET_ID,
        username: " New.Target ",
        email: " NEW.TARGET@example.test ",
        name: "Updated Target",
        systemRole: "admin",
      }),
      typed.env,
    );
    legacy.database
      .prepare(
        "UPDATE users SET username=?,email=?,name=?,password_hash=?,system_role=?,updated_at=unixepoch() WHERE id=?",
      )
      .run(
        normU(" New.Target "),
        normE(" NEW.TARGET@example.test "),
        "Updated Target",
        null,
        "admin",
        TARGET_ID,
      );
    const updated = legacyUser(legacy.database, TARGET_ID);

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      ok: true,
      data: toPublicUser(updated!),
    });
    expect(typed.trace.preparedSql).toHaveLength(6);
    expect(publicState(typed.database)).toEqual(publicState(legacy.database));
  });

  it("matches profile identity and timezone update behavior", async () => {
    const typed = createFixture();
    const legacy = createFixture();
    const response = await handleProfileAdmin(
      new Request("https://edge.test/api/private/admin/profile", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          username: " ADMIN.NEW ",
          email: " ADMIN.NEW@example.test ",
          name: "New Administrator",
          timeZone: "America/Los_Angeles",
          preferredLocale: "en",
        }),
      }),
      typed.env,
    );
    legacy.database
      .prepare(
        "UPDATE users SET username=?,email=?,name=?,password_hash=?,timezone=?,preferred_locale=?,updated_at=unixepoch() WHERE id=?",
      )
      .run(
        normU(" ADMIN.NEW "),
        normE(" ADMIN.NEW@example.test "),
        "New Administrator",
        null,
        normalizeTimeZone("America/Los_Angeles"),
        "en",
        ADMIN_ID,
      );
    const updated = legacyUser(legacy.database, ADMIN_ID);

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      ok: true,
      data: toPublicUser(updated!),
    });
    expect(typed.trace.preparedSql).toHaveLength(5);
    expect(publicState(typed.database)).toEqual(publicState(legacy.database));
  });
});
