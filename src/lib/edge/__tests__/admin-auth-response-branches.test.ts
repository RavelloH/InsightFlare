import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { uniqueTeamSlug } from "@/lib/edge/admin/access";
import {
  ensureDefaultTeam,
  normE,
  normU,
  requireActor,
  teamGroupsForSession,
  teamsFor,
  toPublicUser,
  verifyPassword,
} from "@/lib/edge/admin/auth";
import {
  bad,
  bool,
  forb,
  j,
  na,
  nf,
  parseJson,
  toRole,
  una,
} from "@/lib/edge/admin/response";
import { requireSession } from "@/lib/edge/auth/session-auth";
import type { Env } from "@/lib/edge/types";
const deriveMockBytes = vi.hoisted(
  () =>
    (password: Uint8Array, nonce: Uint8Array, length: number): Uint8Array => {
      const out = new Uint8Array(length);
      for (let i = 0; i < out.length; i += 1) {
        const passwordByte =
          password.length > 0 ? password[i % password.length] : 0;
        const nonceByte = nonce.length > 0 ? nonce[i % nonce.length] : 0;
        out[i] = (passwordByte + nonceByte + i * 13) & 255;
      }
      return out;
    },
);
vi.mock("@noble/hashes/argon2.js", () => ({
  argon2id: vi.fn(
    (
      password: Uint8Array,
      nonce: Uint8Array,
      options: { dkLen?: number } = {},
    ) => deriveMockBytes(password, nonce, options.dkLen ?? 32),
  ),
}));
vi.mock("@/lib/edge/admin/access", () => ({
  uniqueTeamSlug: vi.fn(),
}));
vi.mock("@/lib/edge/auth/session-auth", () => ({
  requireSession: vi.fn(),
}));
type UserRow = {
  id: string;
  username: string;
  email: string;
  name: string | null;
  password_hash: string | null;
  system_role: string;
  timezone: string;
  created_at: number;
  updated_at: number;
};
interface MockStatement {
  sql?: string;
  bind: ReturnType<typeof vi.fn>;
  first: ReturnType<typeof vi.fn>;
  all: ReturnType<typeof vi.fn>;
  run: ReturnType<typeof vi.fn>;
}
const requireSessionMock = vi.mocked(requireSession);
const uniqueTeamSlugMock = vi.mocked(uniqueTeamSlug);
function b64u(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}
function argonHash(
  password: string,
  nonce = new Uint8Array([
    1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16,
  ]),
  expectedLength = 32,
): string {
  const passwordBytes = new TextEncoder().encode(password);
  const expected = deriveMockBytes(passwordBytes, nonce, expectedLength);
  return `argon2id$v=19$m=4096,t=1,p=1$${b64u(nonce)}$${b64u(expected)}`;
}
function userRow(overrides: Partial<UserRow> = {}): UserRow {
  return {
    id: "user-1",
    username: "admin",
    email: "admin@example.test",
    name: "Admin User",
    password_hash: argonHash("secret-password"),
    system_role: "admin",
    timezone: "UTC",
    created_at: 100,
    updated_at: 200,
    ...overrides,
  };
}
function statement(
  input: {
    first?: unknown;
    all?: Record<string, unknown>[];
    run?: unknown;
  } = {},
): MockStatement {
  const stmt = {
    bind: vi.fn(function (this: MockStatement) {
      return this;
    }),
    first: vi.fn().mockResolvedValue("first" in input ? input.first : null),
    all: vi.fn().mockResolvedValue({ results: input.all ?? [] }),
    run: vi.fn().mockResolvedValue(input.run ?? { success: true }),
  } satisfies MockStatement;
  return stmt;
}
function createEnv(statements: MockStatement[] = []): {
  env: Env;
  prepare: ReturnType<typeof vi.fn>;
} {
  let index = 0;
  const prepare = vi.fn((sql: string) => {
    const stmt = statements[index];
    index += 1;
    if (!stmt) {
      throw new Error(`Unexpected SQL #${index}: ${sql}`);
    }
    stmt.sql = sql;
    return stmt;
  });
  return {
    env: {
      DB: { prepare, batch: vi.fn() } as unknown as D1Database,
      DAILY_SALT_SECRET: "daily-salt",
    } as Env,
    prepare,
  };
}
async function jsonOf(response: Response): Promise<Record<string, unknown>> {
  return (await response.json()) as Record<string, unknown>;
}
describe("admin response low branches", () => {
  it("wraps JSON responses and maps status helpers, roles, and booleans", async () => {
    const accepted = j({ ok: true }, 202);
    expect(accepted.status).toBe(202);
    expect(accepted.headers.get("content-type")).toBe(
      "application/json; charset=utf-8",
    );
    expect(await accepted.json()).toEqual({ ok: true });

    await expect(jsonOf(bad("bad_input"))).resolves.toMatchObject({
      ok: false,
      error: { message: "bad_input" },
    });
    expect(bad("bad_input").status).toBe(400);
    expect(una().status).toBe(401);
    expect(forb().status).toBe(403);
    expect(nf().status).toBe(404);
    expect(na().status).toBe(405);

    expect(toRole("ADMIN")).toBe("admin");
    expect(toRole("owner")).toBe("user");
    expect(toRole(null)).toBe("user");

    expect(bool(true, false)).toBe(true);
    expect(bool(false, true)).toBe(false);
    expect(bool(2)).toBe(true);
    expect(bool(0, true)).toBe(false);
    expect(bool(" YES ")).toBe(true);
    expect(bool("off", true)).toBe(false);
    expect(bool({ enabled: true }, true)).toBe(true);
  });

  it("parses object JSON and falls back to an empty record for invalid bodies", async () => {
    await expect(
      parseJson(
        new Request("https://edge.test/admin", {
          method: "POST",
          body: JSON.stringify({ teamId: "team-1" }),
        }),
      ),
    ).resolves.toEqual({ teamId: "team-1" });

    await expect(
      parseJson(
        new Request("https://edge.test/admin", {
          method: "POST",
          body: "not-json",
        }),
      ),
    ).resolves.toEqual({});

    await expect(
      parseJson(
        new Request("https://edge.test/admin", {
          method: "POST",
          body: "null",
        }),
      ),
    ).resolves.toEqual({});
  });
});
describe("admin auth low branches", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    uniqueTeamSlugMock.mockResolvedValue("user-team");
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("normalizes public user fields and verifies malformed argon hashes defensively", async () => {
    expect(normU(`  ${"A".repeat(90)}  `)).toBe("a".repeat(80));
    expect(normE(`  ${"E".repeat(210)}@EXAMPLE.TEST  `)).toHaveLength(200);

    expect(
      toPublicUser(
        userRow({
          name: null,
          system_role: "owner",
          timezone: "",
        }),
      ),
    ).toMatchObject({
      name: "",
      systemRole: "user",
      timeZone: "",
    });

    const goodHash = argonHash("secret-password");
    await expect(verifyPassword("secret-password", goodHash)).resolves.toBe(
      true,
    );
    await expect(verifyPassword("wrong", goodHash)).resolves.toBe(false);
    await expect(verifyPassword("secret-password", null)).resolves.toBe(false);
    await expect(
      verifyPassword("secret-password", "bcrypt$not-supported"),
    ).resolves.toBe(false);

    const nonce = b64u(new Uint8Array(8).fill(1));
    const expected = b64u(new Uint8Array(16).fill(2));
    await expect(
      verifyPassword(
        "secret-password",
        `argon2id$v=20$m=4096,t=1,p=1$${nonce}$${expected}`,
      ),
    ).resolves.toBe(false);
    await expect(
      verifyPassword(
        "secret-password",
        `argon2id$v=19$m=7,t=1,p=1$${nonce}$${expected}`,
      ),
    ).resolves.toBe(false);
    await expect(
      verifyPassword(
        "secret-password",
        `argon2id$v=19$m=4096,t=11,p=1$${nonce}$${expected}`,
      ),
    ).resolves.toBe(false);
    await expect(
      verifyPassword(
        "secret-password",
        `argon2id$v=19$m=4096,t=1,p=9$${nonce}$${expected}`,
      ),
    ).resolves.toBe(false);
    await expect(
      verifyPassword(
        "secret-password",
        `argon2id$v=19$m=4096,t=1,p=1$${b64u(new Uint8Array(7))}$${expected}`,
      ),
    ).resolves.toBe(false);
    await expect(
      verifyPassword(
        "secret-password",
        `argon2id$v=19$m=4096,t=1,p=1$${nonce}$${b64u(new Uint8Array(15))}`,
      ),
    ).resolves.toBe(false);
  });

  it("returns auth responses for missing sessions, blank session ids, and missing users", async () => {
    const request = new Request("https://edge.test/admin");

    requireSessionMock.mockResolvedValueOnce(null);
    const missingSession = await requireActor(createEnv().env, request);
    expect(missingSession).toBeInstanceOf(Response);
    expect((missingSession as Response).status).toBe(401);

    requireSessionMock.mockResolvedValueOnce({ userId: "" } as Awaited<
      ReturnType<typeof requireSession>
    >);
    const blankUserIdEnv = createEnv();
    const blankUserId = await requireActor(blankUserIdEnv.env, request);
    expect(blankUserId).toBeInstanceOf(Response);
    expect(blankUserIdEnv.prepare).not.toHaveBeenCalled();

    requireSessionMock.mockResolvedValueOnce({
      userId: "missing-user",
    } as Awaited<ReturnType<typeof requireSession>>);
    const missingUserEnv = createEnv([statement({ first: null })]);
    const missingUser = await requireActor(missingUserEnv.env, request);
    expect(missingUser).toBeInstanceOf(Response);
    expect((missingUser as Response).status).toBe(401);
    await expect((missingUser as Response).json()).resolves.toMatchObject({
      ok: false,
      error: { message: "User not found" },
    });

    requireSessionMock.mockResolvedValueOnce({ userId: "user-1" } as Awaited<
      ReturnType<typeof requireSession>
    >);
    const successUser = userRow({ system_role: "user" });
    const success = await requireActor(
      createEnv([statement({ first: successUser })]).env,
      request,
    );
    expect(success).toEqual({ user: successUser, isAdmin: false });
  });

  it("maps team memberships and creates or repairs default teams", async () => {
    const teamRows = [
      { id: "team-1", membershipRole: "admin", siteCount: 2 },
      { id: "team-2", membershipRole: "unexpected", memberCount: 4 },
    ];
    const teamsStatement = statement({ all: teamRows });
    await expect(
      teamsFor(createEnv([teamsStatement]).env, "user-1"),
    ).resolves.toEqual([
      { id: "team-1", membershipRole: "admin", siteCount: 2 },
      { id: "team-2", membershipRole: "member", memberCount: 4 },
    ]);
    expect(teamsStatement.bind).toHaveBeenCalledWith("user-1");

    const ownedLookup = statement({ first: { id: "owned-team" } });
    const ownedRepair = statement();
    await ensureDefaultTeam(
      createEnv([ownedLookup, ownedRepair]).env,
      userRow({ id: "owner-1" }),
    );
    expect(ownedRepair.bind).toHaveBeenCalledWith("owned-team", "owner-1");
    expect(uniqueTeamSlugMock).not.toHaveBeenCalled();

    const uuidSpy = vi
      .spyOn(crypto, "randomUUID")
      .mockReturnValue("00000000-0000-4000-8000-000000000001");
    const newLookup = statement({ first: null });
    const insertTeam = statement();
    const insertMember = statement();
    uniqueTeamSlugMock.mockResolvedValueOnce("blank-user-team");
    await ensureDefaultTeam(
      createEnv([newLookup, insertTeam, insertMember]).env,
      userRow({ id: "blank-user", username: "", name: null }),
    );
    expect(uuidSpy).toHaveBeenCalled();
    expect(uniqueTeamSlugMock).toHaveBeenCalledWith(expect.anything(), "-team");
    expect(insertTeam.bind).toHaveBeenCalledWith(
      "00000000-0000-4000-8000-000000000001",
      "User's team",
      "blank-user-team",
      "blank-user",
    );
    expect(insertMember.bind).toHaveBeenCalledWith(
      "00000000-0000-4000-8000-000000000001",
      "blank-user",
    );
  });

  it("builds categorized session team groups", async () => {
    const createdRows = [
      { id: "created-team", slug: "created", membershipRole: "owner" },
    ];
    const managedRows = [
      { id: "managed-team", slug: "managed", membershipRole: "admin" },
    ];
    const memberRows = [
      { id: "member-team", slug: "member", membershipRole: "member" },
    ];
    const systemRows = [
      { id: "created-team", slug: "created", membershipRole: "owner" },
      { id: "system-team", slug: "system", membershipRole: null },
    ];

    const result = await teamGroupsForSession(
      createEnv([
        statement({ all: createdRows }),
        statement({ all: managedRows }),
        statement({ all: memberRows }),
        statement({ all: systemRows }),
      ]).env,
      { user: userRow({ id: "admin-1" }), isAdmin: true },
    );

    expect(result.teamGroups).toMatchObject({
      created: [{ id: "created-team", membershipRole: "owner" }],
      managed: [{ id: "managed-team", membershipRole: "admin" }],
      member: [{ id: "member-team", membershipRole: "member" }],
      system: [
        { id: "created-team", membershipRole: "owner" },
        { id: "system-team" },
      ],
    });
    expect(result.teamGroups.system[1]).not.toHaveProperty("membershipRole");
    expect(result.teams.map((team) => team.id)).toEqual([
      "created-team",
      "managed-team",
      "member-team",
      "system-team",
    ]);
  });
});
