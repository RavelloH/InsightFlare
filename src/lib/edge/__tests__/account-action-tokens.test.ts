import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  type AccountActionTokenRow,
  accountActionTokenStatus,
  createAccountActionToken,
  generateAccountActionToken,
  getAccountActionTokenByToken,
  getValidAccountActionToken,
  hashAccountActionToken,
  listTeamInviteTokens,
  markAccountActionTokenUsed,
  revokeAccountActionToken,
} from "@/lib/edge/auth/account-action-tokens";
import type { Env } from "@/lib/edge/types";
interface MockStatement {
  sql: string;
  bound: unknown[];
  bind: ReturnType<typeof vi.fn>;
  first: ReturnType<typeof vi.fn>;
  all: ReturnType<typeof vi.fn>;
  run: ReturnType<typeof vi.fn>;
}
function cloneRow(row: AccountActionTokenRow): AccountActionTokenRow {
  return { ...row };
}
function createEnv() {
  const rows: AccountActionTokenRow[] = [];
  const prepare = vi.fn((sql: string): MockStatement => {
    const stmt = {
      sql,
      bind: vi.fn(function (this: MockStatement, ...args: unknown[]) {
        this.bound = args;
        return this;
      }),
      first: vi.fn(async function (this: MockStatement) {
        const args = (this.bound ?? []) as unknown[];
        if (this.sql.includes("WHERE id = ?")) {
          const row = rows.find((item) => item.id === args[0]);
          return row ? cloneRow(row) : null;
        }
        if (this.sql.includes("WHERE token_hash = ?")) {
          const row = rows.find((item) => item.token_hash === args[0]);
          return row ? cloneRow(row) : null;
        }
        return null;
      }),
      all: vi.fn(async function (this: MockStatement) {
        const args = (this.bound ?? []) as unknown[];
        if (
          this.sql.includes("WHERE team_id = ?") &&
          this.sql.includes("type = 'team_invite'")
        ) {
          return {
            results: rows
              .filter(
                (item) =>
                  item.team_id === args[0] && item.type === "team_invite",
              )
              .sort((left, right) => right.created_at - left.created_at)
              .map(cloneRow),
          };
        }
        return { results: [] };
      }),
      run: vi.fn(async function (this: MockStatement) {
        const args = (this.bound ?? []) as unknown[];
        if (this.sql.includes("INSERT INTO account_action_tokens")) {
          rows.push({
            id: String(args[0]),
            type: String(args[1]),
            token_hash: String(args[2]),
            team_id: args[3] ? String(args[3]) : null,
            user_id: args[4] ? String(args[4]) : null,
            email: args[5] ? String(args[5]) : null,
            payload_json: String(args[6] ?? "{}"),
            created_by_user_id: args[7] ? String(args[7]) : null,
            created_at: Math.floor(Date.now() / 1000),
            expires_at: Number(args[8]),
            used_at: null,
            used_by_user_id: null,
            revoked_at: null,
          });
        }
        if (
          this.sql.includes("SET used_at") &&
          this.sql.includes("used_by_user_id")
        ) {
          const row = rows.find((item) => item.id === args[1]);
          if (row && row.used_at === null && row.revoked_at === null) {
            row.used_at = Math.floor(Date.now() / 1000);
            row.used_by_user_id = args[0]
              ? String(args[0])
              : row.used_by_user_id;
          }
        }
        if (this.sql.includes("SET revoked_at")) {
          const row = rows.find((item) => item.id === args[0]);
          if (row && row.used_at === null) {
            row.revoked_at = Math.floor(Date.now() / 1000);
          }
        }
        return { success: true };
      }),
      bound: [] as unknown[],
    } satisfies MockStatement & { bound: unknown[] };
    return stmt;
  });

  return {
    rows,
    env: {
      MAIN_SECRET: "account-action-secret",
      DB: { prepare } as unknown as D1Database,
    } as Env,
    prepare,
  };
}
describe("account action token utilities", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-01T00:00:00Z"));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("generates base64url tokens and hashes them with HMAC", async () => {
    const env = createEnv().env;
    const token = generateAccountActionToken();
    expect(token).toMatch(/^[A-Za-z0-9_-]{40,}$/);

    const left = await hashAccountActionToken(env, token);
    const right = await hashAccountActionToken(env, token);
    const other = await hashAccountActionToken(env, `${token}x`);

    expect(left).toBe(right);
    expect(left).toMatch(/^[a-f0-9]{64}$/);
    expect(left).not.toBe(other);
  });

  it("throws when hashing account action tokens without a root secret", async () => {
    await expect(
      hashAccountActionToken({} as Env, generateAccountActionToken()),
    ).rejects.toThrow(
      "MAIN_SECRET or DAILY_SALT_SECRET is required for account action tokens",
    );
  });

  it("creates records without storing the plain token", async () => {
    const uuidSpy = vi
      .spyOn(crypto, "randomUUID")
      .mockReturnValue("00000000-0000-4000-8000-000000000001");
    const { env, rows } = createEnv();

    const created = await createAccountActionToken(env, {
      type: "team_invite",
      teamId: "team-1",
      email: " USER@Example.Test ",
      payload: { teamRole: "member" },
      createdByUserId: "admin-1",
      expiresAt: Math.floor(Date.now() / 1000) + 3600,
    });

    expect(uuidSpy).toHaveBeenCalled();
    expect(created.token).toMatch(/^[A-Za-z0-9_-]{40,}$/);
    expect(created.record).toMatchObject({
      id: "00000000-0000-4000-8000-000000000001",
      type: "team_invite",
      teamId: "team-1",
      email: "user@example.test",
      payload: { teamRole: "member" },
      createdByUserId: "admin-1",
      status: "active",
    });
    expect(rows[0].token_hash).not.toBe(created.token);
    expect(rows[0].token_hash).toMatch(/^[a-f0-9]{64}$/);
  });

  it("looks up valid tokens by hash and rejects wrong, expired, used, or revoked tokens", async () => {
    const { env } = createEnv();
    const created = await createAccountActionToken(env, {
      type: "password_reset",
      userId: "user-1",
      expiresAt: Math.floor(Date.now() / 1000) + 3600,
    });

    await expect(
      getValidAccountActionToken(env, {
        token: created.token,
        type: "password_reset",
      }),
    ).resolves.toMatchObject({ id: created.record.id });
    await expect(
      getAccountActionTokenByToken(env, "wrong-token"),
    ).resolves.toBeNull();
    await expect(
      getValidAccountActionToken(env, {
        token: created.token,
        type: "team_invite",
      }),
    ).resolves.toBeNull();

    await markAccountActionTokenUsed(env, {
      tokenId: created.record.id,
      usedByUserId: "user-1",
    });
    await expect(
      getValidAccountActionToken(env, { token: created.token }),
    ).resolves.toBeNull();

    const revoked = await createAccountActionToken(env, {
      type: "team_invite",
      teamId: "team-1",
      expiresAt: Math.floor(Date.now() / 1000) + 3600,
    });
    await revokeAccountActionToken(env, { tokenId: revoked.record.id });
    await expect(
      getValidAccountActionToken(env, { token: revoked.token }),
    ).resolves.toBeNull();

    const expired = await createAccountActionToken(env, {
      type: "team_invite",
      teamId: "team-1",
      expiresAt: 1,
    });
    await expect(
      getValidAccountActionToken(env, { token: expired.token }),
    ).resolves.toBeNull();
  });

  it("marks tokens as used once and does not revoke used tokens", async () => {
    const { env } = createEnv();
    const created = await createAccountActionToken(env, {
      type: "team_invite",
      teamId: "team-1",
      expiresAt: Math.floor(Date.now() / 1000) + 3600,
    });

    const used = await markAccountActionTokenUsed(env, {
      tokenId: created.record.id,
      usedByUserId: "user-1",
    });
    expect(used).toMatchObject({
      id: created.record.id,
      used_by_user_id: "user-1",
    });
    expect(accountActionTokenStatus(used as AccountActionTokenRow)).toBe(
      "used",
    );

    const revoked = await revokeAccountActionToken(env, {
      tokenId: created.record.id,
    });
    expect(revoked?.revoked_at).toBeNull();
    expect(accountActionTokenStatus(revoked as AccountActionTokenRow)).toBe(
      "used",
    );
  });

  it("lists team invite tokens without exposing token hashes", async () => {
    const { env } = createEnv();
    await createAccountActionToken(env, {
      type: "team_invite",
      teamId: "team-1",
      email: "a@example.test",
      expiresAt: Math.floor(Date.now() / 1000) + 3600,
    });
    await createAccountActionToken(env, {
      type: "password_reset",
      userId: "user-1",
      expiresAt: Math.floor(Date.now() / 1000) + 3600,
    });

    const list = await listTeamInviteTokens(env, "team-1");

    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({
      type: "team_invite",
      teamId: "team-1",
      email: "a@example.test",
    });
    expect(list[0]).not.toHaveProperty("token");
    expect(list[0]).not.toHaveProperty("tokenHash");
    expect(list[0]).not.toHaveProperty("token_hash");
  });
});
