import type { DatabaseSync } from "node:sqlite";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createMigratedDatabase } from "@/../scripts/schema/database";
import { explainQueryPlan } from "@/lib/db/__tests__/query-plan";
import {
  createSqliteD1Database,
  type SqliteD1Trace,
} from "@/lib/db/__tests__/sqlite-d1";
import {
  type AccountActionTokenType,
  hashAccountActionToken,
} from "@/lib/edge/auth/account-action-tokens";
import { handlePublicAccountLinks } from "@/lib/edge/auth/public-account-links";
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
const EXPIRES_AT = 2_000_000_000;
const databases = new Set<DatabaseSync>();
const TOKEN = "typed-dal-invite-token";
const ADMIN_ID = "00000000-0000-4000-8000-000000000201";
const USER_ID = "00000000-0000-4000-8000-000000000202";
const CREATED_USER_ID = "00000000-0000-4000-8000-000000000203";

interface Fixture {
  database: DatabaseSync;
  env: Env;
  trace: SqliteD1Trace;
}

function createFixture(options: { includeUser?: boolean } = {}): Fixture {
  const database = createMigratedDatabase();
  database.function("unixepoch", () => FIXED_TIME);
  databases.add(database);
  const insertUser = database.prepare(
    "INSERT INTO users (id,email,name,username,system_role,timezone,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)",
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
  );
  if (options.includeUser !== false) {
    insertUser.run(
      USER_ID,
      "invitee@example.test",
      "Invitee",
      "invitee",
      "user",
      "UTC",
      20,
      20,
    );
  }
  database
    .prepare(
      "INSERT INTO teams (id,name,slug,owner_user_id,created_at,updated_at) VALUES (?,?,?,?,?,?)",
    )
    .run("team-1", "Invite Team", "invite-team", ADMIN_ID, 30, 30);
  database
    .prepare("INSERT INTO sites (id,team_id,name,domain) VALUES (?,?,?,?)")
    .run("site-1", "team-1", "Invite Site", "invite.example.test");
  const trace: SqliteD1Trace = {
    preparedSql: [],
    bindings: [],
    batchStatements: [],
  };
  return {
    database,
    env: {
      MAIN_SECRET: "public-account-links-dal-test-secret",
      DB: createSqliteD1Database(database, trace),
    } as Env,
    trace,
  };
}

async function insertToken(
  fixture: Fixture,
  input: {
    id: string;
    type: AccountActionTokenType;
    teamId?: string | null;
    userId?: string | null;
    email?: string | null;
    payload?: Record<string, unknown>;
  },
) {
  const tokenHash = await hashAccountActionToken(fixture.env, TOKEN);
  fixture.database
    .prepare(
      "INSERT INTO account_action_tokens (id,type,token_hash,team_id,user_id,email,payload_json,created_by_user_id,created_at,expires_at) VALUES (?,?,?,?,?,?,?,?,?,?)",
    )
    .run(
      input.id,
      input.type,
      tokenHash,
      input.teamId ?? null,
      input.userId ?? null,
      input.email ?? null,
      JSON.stringify(input.payload ?? {}),
      ADMIN_ID,
      100,
      EXPIRES_AT,
    );
}

function inviteRequest(
  body: Record<string, unknown>,
  action: "inspect" | "complete" = "complete",
) {
  const path = `/api/public/account-links/${action}`;
  return new Request(`https://app.test${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function tableForStatement(sql: string): string {
  const match =
    /^(?:SELECT[\s\S]*?\bFROM|INSERT\s+INTO|UPDATE|DELETE\s+FROM)\s+["`']?([a-z_]+)/i.exec(
      sql,
    );
  return match?.[1]?.toLowerCase() ?? "unknown";
}

function expectIndexSearch(plan: readonly string[], indexName: string) {
  expect(
    plan.some(
      (detail) => detail.includes("SEARCH") && detail.includes(indexName),
    ),
    plan.join("\n"),
  ).toBe(true);
}

function memberships(database: DatabaseSync) {
  return database
    .prepare(
      "SELECT team_id,user_id,role,site_ids_json,joined_at FROM team_members WHERE team_id=? ORDER BY user_id",
    )
    .all("team-1");
}

function users(database: DatabaseSync) {
  return database
    .prepare(
      "SELECT id,username,email,name,system_role,timezone,preferred_locale,created_at,updated_at FROM users ORDER BY id",
    )
    .all();
}

function legacyAcceptInvite(database: DatabaseSync, tokenId: string) {
  database
    .prepare(
      "INSERT INTO team_members (team_id,user_id,role,site_ids_json,joined_at) VALUES (?,?,?,?,unixepoch()) ON CONFLICT(team_id,user_id) DO UPDATE SET role=excluded.role, site_ids_json=excluded.site_ids_json",
    )
    .run("team-1", USER_ID, "member", '["site-1"]');
  database
    .prepare(
      "UPDATE account_action_tokens SET used_at = COALESCE(used_at, unixepoch()), used_by_user_id = COALESCE(used_by_user_id, ?) WHERE id = ? AND used_at IS NULL AND revoked_at IS NULL",
    )
    .run(USER_ID, tokenId);
}

function legacyRegisterInvite(database: DatabaseSync, tokenId: string) {
  database.exec("BEGIN");
  try {
    database
      .prepare(
        "INSERT INTO users (id,username,email,name,password_hash,system_role,created_at,updated_at) VALUES (?,?,?,?,?,'user',unixepoch(),unixepoch())",
      )
      .run(
        CREATED_USER_ID,
        "new-user",
        "new@example.test",
        "New User",
        "legacy-password-hash",
      );
    database
      .prepare(
        "INSERT INTO team_members (team_id,user_id,role,site_ids_json,joined_at) VALUES (?,?,?,?,unixepoch())",
      )
      .run("team-1", CREATED_USER_ID, "member", '["site-1"]');
    database
      .prepare(
        "UPDATE account_action_tokens SET used_at = COALESCE(used_at, unixepoch()), used_by_user_id = COALESCE(used_by_user_id, ?) WHERE id = ? AND used_at IS NULL AND revoked_at IS NULL",
      )
      .run(CREATED_USER_ID, tokenId);
    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}

function legacyPasswordReset(database: DatabaseSync, tokenId: string) {
  database
    .prepare(
      "UPDATE users SET password_hash=?,updated_at=unixepoch() WHERE id=?",
    )
    .run("legacy-password-hash", USER_ID);
  database
    .prepare(
      "UPDATE account_action_tokens SET used_at = COALESCE(used_at, unixepoch()), used_by_user_id = COALESCE(used_by_user_id, ?) WHERE id = ? AND used_at IS NULL AND revoked_at IS NULL",
    )
    .run(USER_ID, tokenId);
}

function mockUuid(id: string) {
  vi.spyOn(crypto, "randomUUID").mockReturnValue(
    id as ReturnType<typeof crypto.randomUUID>,
  );
}

beforeEach(() => {
  requireSessionMock.mockReset();
  requireSessionMock.mockResolvedValue(null);
});

afterEach(() => {
  vi.restoreAllMocks();
  for (const database of databases) database.close();
  databases.clear();
});

describe("public account links Typed DAL differential checks", () => {
  it("matches existing-user invite upsert and token-use sequence", async () => {
    const typed = createFixture();
    const legacy = createFixture();
    for (const fixture of [typed, legacy]) {
      fixture.database
        .prepare(
          "INSERT INTO team_members (team_id,user_id,role,site_ids_json) VALUES (?,?,?,?)",
        )
        .run("team-1", USER_ID, "admin", "[]");
      await insertToken(fixture, {
        id: "invite-1",
        type: "team_invite",
        teamId: "team-1",
        email: "invitee@example.test",
        payload: { teamRole: "member", siteIds: ["site-1"] },
      });
    }
    requireSessionMock.mockResolvedValue({ userId: USER_ID });

    const response = await handlePublicAccountLinks(
      inviteRequest({ token: TOKEN }),
      typed.env,
      new URL("https://app.test/api/public/account-links/complete"),
    );
    legacyAcceptInvite(legacy.database, "invite-1");
    const body = (await response.json()) as {
      data: { type: string; team: { id: string; name: string; slug: string } };
    };

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(body).toMatchObject({
      ok: true,
      data: {
        type: "team_invite",
        team: { id: "team-1", name: "Invite Team", slug: "invite-team" },
      },
    });
    expect(memberships(typed.database)).toEqual(memberships(legacy.database));
    expect(
      typed.database
        .prepare(
          "SELECT used_at,used_by_user_id FROM account_action_tokens WHERE id=?",
        )
        .get("invite-1"),
    ).toEqual(
      legacy.database
        .prepare(
          "SELECT used_at,used_by_user_id FROM account_action_tokens WHERE id=?",
        )
        .get("invite-1"),
    );
    expect(typed.trace.preparedSql).toHaveLength(7);
    expect(typed.trace.preparedSql.map(tableForStatement)).toEqual([
      "account_action_tokens",
      "teams",
      "users",
      "team_members",
      "account_action_tokens",
      "account_action_tokens",
      "teams",
    ]);
    expectIndexSearch(
      explainQueryPlan(typed.database, {
        sql: typed.trace.preparedSql[1]!,
        bindings: typed.trace.bindings[1]!,
      }),
      "sqlite_autoindex_teams_1",
    );
  });

  it("matches new-user invite registration and one ordered three-statement batch", async () => {
    const typed = createFixture({ includeUser: false });
    const legacy = createFixture({ includeUser: false });
    for (const fixture of [typed, legacy]) {
      await insertToken(fixture, {
        id: "invite-register",
        type: "team_invite",
        teamId: "team-1",
        payload: {
          teamRole: "member",
          siteIds: ["site-1"],
          allowRegistration: true,
        },
      });
    }
    mockUuid(CREATED_USER_ID);

    const response = await handlePublicAccountLinks(
      inviteRequest({
        token: TOKEN,
        username: "new-user",
        email: "new@example.test",
        name: "New User",
        password: "long-enough-password",
      }),
      typed.env,
      new URL("https://app.test/api/public/account-links/complete"),
    );
    legacyRegisterInvite(legacy.database, "invite-register");
    const body = (await response.json()) as {
      data: { registered: boolean; user: { id: string } };
    };

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(body).toMatchObject({
      ok: true,
      data: { registered: true, user: { id: CREATED_USER_ID } },
    });
    expect(typed.trace.batchStatements).toHaveLength(1);
    const batch = typed.trace.batchStatements?.[0] ?? [];
    expect(batch).toHaveLength(3);
    expect(batch.map(tableForStatement)).toEqual([
      "users",
      "team_members",
      "account_action_tokens",
    ]);
    expect(batch[2]).toMatch(/COALESCE\([^)]*used_at/i);
    expect(batch[2]).toMatch(/COALESCE\([^)]*used_by_user_id/i);
    expect(batch[2]).toMatch(/used_at["`]?\s+IS\s+NULL/i);
    expect(batch[2]).toMatch(/revoked_at["`]?\s+IS\s+NULL/i);
    expect(typed.trace.preparedSql).toHaveLength(8);
    expect(users(typed.database)).toEqual(users(legacy.database));
    expect(memberships(typed.database)).toEqual(memberships(legacy.database));
    expect(
      typed.database
        .prepare(
          "SELECT used_at,used_by_user_id FROM account_action_tokens WHERE id=?",
        )
        .get("invite-register"),
    ).toEqual(
      legacy.database
        .prepare(
          "SELECT used_at,used_by_user_id FROM account_action_tokens WHERE id=?",
        )
        .get("invite-register"),
    );
  });

  it("matches password reset as separate password and token writes", async () => {
    const typed = createFixture();
    const legacy = createFixture();
    for (const fixture of [typed, legacy]) {
      await insertToken(fixture, {
        id: "reset-1",
        type: "password_reset",
        userId: USER_ID,
      });
    }

    const response = await handlePublicAccountLinks(
      inviteRequest({ token: TOKEN, password: "new-long-password" }),
      typed.env,
      new URL("https://app.test/api/public/account-links/complete"),
    );
    legacyPasswordReset(legacy.database, "reset-1");
    const body = (await response.json()) as { data: { reset: boolean } };

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(body).toMatchObject({ ok: true, data: { reset: true } });
    expect(typed.trace.preparedSql).toHaveLength(4);
    expect(typed.trace.preparedSql.map(tableForStatement)).toEqual([
      "account_action_tokens",
      "users",
      "account_action_tokens",
      "account_action_tokens",
    ]);
    expect(
      typed.database
        .prepare("SELECT updated_at FROM users WHERE id=?")
        .get(USER_ID),
    ).toEqual(
      legacy.database
        .prepare("SELECT updated_at FROM users WHERE id=?")
        .get(USER_ID),
    );
    const passwordHash = typed.database
      .prepare("SELECT password_hash FROM users WHERE id=?")
      .get(USER_ID) as { password_hash: string };
    expect(passwordHash.password_hash).toMatch(/^argon2id\$/);
    expect(
      typed.database
        .prepare(
          "SELECT used_at,used_by_user_id FROM account_action_tokens WHERE id=?",
        )
        .get("reset-1"),
    ).toEqual(
      legacy.database
        .prepare(
          "SELECT used_at,used_by_user_id FROM account_action_tokens WHERE id=?",
        )
        .get("reset-1"),
    );
  });
});
