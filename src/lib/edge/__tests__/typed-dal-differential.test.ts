import type { DatabaseSync } from "node:sqlite";
import { type SQLOutputValue } from "node:sqlite";

import { afterEach, describe, expect, it } from "vitest";

import { createMigratedDatabase } from "@/../scripts/schema/database";
import { createSqliteD1Database } from "@/lib/db/__tests__/sqlite-d1";
import {
  type AccountActionTokenRow,
  listTeamInviteTokens,
  markAccountActionTokenUsed,
  toPublicAccountActionToken,
} from "@/lib/edge/auth/account-action-tokens";
import {
  type ApiKeyRow,
  listApiKeys,
  revokeApiKeyRecord,
  toPublicApiKey,
} from "@/lib/edge/auth/api-key-store";
import { assertSitesBelongToTeam } from "@/lib/edge/auth/member-site-access";
import { readConfig, upsertConfig } from "@/lib/edge/system-config";
import type { Env } from "@/lib/edge/types";
import {
  mergeNotificationPreferencesUpdate,
  updateUserNotificationPreferences,
} from "@/lib/notifications/edge/preferences";
import { safeJsonStringify } from "@/lib/notifications/json";

const databases = new Set<DatabaseSync>();

function createFixture() {
  const database = createMigratedDatabase();
  database.function("unixepoch", () => 1_800_000_000);
  databases.add(database);
  const insertUser = database.prepare(
    "INSERT INTO users (id, email, name) VALUES (?, ?, ?)",
  );
  for (const [id, email, name] of [
    ["owner-1", "owner@example.test", "Owner One"],
    ["owner-2", "owner2@example.test", "Owner Two"],
    ["team-admin", "admin@example.test", "Team Admin"],
    ["member-1", "member@example.test", "Member One"],
  ]) {
    insertUser.run(id, email, name);
  }

  database
    .prepare(
      "INSERT INTO teams (id, name, slug, owner_user_id) VALUES (?, ?, ?, ?)",
    )
    .run("team-1", "Team One", "team-one", "owner-1");
  database
    .prepare(
      "INSERT INTO teams (id, name, slug, owner_user_id) VALUES (?, ?, ?, ?)",
    )
    .run("team-2", "Team Two", "team-two", "owner-2");
  database
    .prepare(
      "INSERT INTO team_members (team_id, user_id, role, site_ids_json) VALUES (?, ?, ?, ?)",
    )
    .run("team-1", "member-1", "member", '["site-1"]');
  const insertSite = database.prepare(
    "INSERT INTO sites (id, team_id, name, domain, public_enabled) VALUES (?, ?, ?, ?, ?)",
  );
  insertSite.run("site-1", "team-1", "Site One", "one.example", 0);
  insertSite.run("site-2", "team-1", "Site Two", "two.example", 0);
  insertSite.run("site-other", "team-2", "Other Site", "other.example", 0);

  return {
    database,
    env: {
      MAIN_SECRET: "typed-dal-test-secret",
      DB: createSqliteD1Database(database),
    } as Env,
  };
}

function seedApiKey(database: DatabaseSync, id: string, createdAt: number) {
  database
    .prepare(
      `INSERT INTO api_keys (
        id, team_id, name, key_prefix, key_hash, scopes_json, site_ids_json,
        created_by_user_id, expires_at, revoked_at, revoked_by_user_id,
        rotated_from_key_id, last_used_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      id,
      "team-1",
      `Key ${id}`,
      `prefix-${id}`,
      `hash-${id}`,
      '["site:read"]',
      '["site-1"]',
      "owner-1",
      null,
      null,
      null,
      null,
      null,
      createdAt,
      createdAt,
    );
}

function seedAccountToken(
  database: DatabaseSync,
  id: string,
  createdAt: number,
) {
  database
    .prepare(
      `INSERT INTO account_action_tokens (
        id, type, token_hash, team_id, user_id, email, payload_json,
        created_by_user_id, created_at, expires_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      id,
      "team_invite",
      `hash-${id}`,
      "team-1",
      null,
      `${id}@example.test`,
      '{"teamRole":"member"}',
      "owner-1",
      createdAt,
      9_999_999_999,
    );
}

function isNullableString(value: SQLOutputValue): value is string | null {
  return value === null || typeof value === "string";
}

function isNullableNumber(value: SQLOutputValue): value is number | null {
  return value === null || typeof value === "number";
}

function isApiKeyRow(
  row: Record<string, SQLOutputValue>,
): row is Record<string, SQLOutputValue> & ApiKeyRow {
  return (
    typeof row.id === "string" &&
    typeof row.team_id === "string" &&
    typeof row.name === "string" &&
    typeof row.key_prefix === "string" &&
    typeof row.key_hash === "string" &&
    typeof row.scopes_json === "string" &&
    typeof row.site_ids_json === "string" &&
    isNullableString(row.created_by_user_id) &&
    isNullableNumber(row.expires_at) &&
    isNullableNumber(row.revoked_at) &&
    isNullableString(row.revoked_by_user_id) &&
    isNullableString(row.rotated_from_key_id) &&
    isNullableNumber(row.last_used_at) &&
    typeof row.created_at === "number" &&
    typeof row.updated_at === "number"
  );
}

function isAccountActionTokenRow(
  row: Record<string, SQLOutputValue>,
): row is Record<string, SQLOutputValue> & AccountActionTokenRow {
  return (
    typeof row.id === "string" &&
    typeof row.type === "string" &&
    typeof row.token_hash === "string" &&
    isNullableString(row.team_id) &&
    isNullableString(row.user_id) &&
    isNullableString(row.email) &&
    typeof row.payload_json === "string" &&
    isNullableString(row.created_by_user_id) &&
    typeof row.created_at === "number" &&
    typeof row.expires_at === "number" &&
    isNullableNumber(row.used_at) &&
    isNullableString(row.used_by_user_id) &&
    isNullableNumber(row.revoked_at)
  );
}

afterEach(() => {
  for (const database of databases) database.close();
  databases.clear();
});

describe("typed DAL query differential checks", () => {
  it("matches the reference config lookup", async () => {
    const { database, env } = createFixture();
    database
      .prepare("INSERT INTO configs (config_key, value_json) VALUES (?, ?)")
      .run("feature-flags", '{"enabled":true}');

    const legacy = database
      .prepare("SELECT value_json FROM configs WHERE config_key = ? LIMIT 1")
      .get("feature-flags") as { value_json: string };
    await expect(readConfig(env, "feature-flags")).resolves.toEqual(
      JSON.parse(legacy.value_json),
    );
  });

  it("matches API key list rows and ordering", async () => {
    const { database, env } = createFixture();
    seedApiKey(database, "older", 100);
    seedApiKey(database, "newer", 200);
    const legacyRows = database
      .prepare(
        `SELECT
          id, team_id, name, key_prefix, key_hash, scopes_json, site_ids_json,
          created_by_user_id, expires_at, revoked_at, revoked_by_user_id,
          rotated_from_key_id, last_used_at, created_at, updated_at
        FROM api_keys
        WHERE team_id = ?
        ORDER BY created_at DESC`,
      )
      .all("team-1");
    expect(legacyRows.every(isApiKeyRow)).toBe(true);

    await expect(listApiKeys(env, "team-1")).resolves.toEqual(
      legacyRows.filter(isApiKeyRow).map(toPublicApiKey),
    );
  });

  it("matches team invite list rows and ordering", async () => {
    const { database, env } = createFixture();
    seedAccountToken(database, "older-invite", 100);
    seedAccountToken(database, "newer-invite", 200);
    database
      .prepare(
        `INSERT INTO account_action_tokens (
          id, type, token_hash, user_id, payload_json, created_at, expires_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        "password-reset",
        "password_reset",
        "reset-hash",
        "member-1",
        "{}",
        300,
        9_999_999_999,
      );
    const legacyRows = database
      .prepare(
        `SELECT
          id, type, token_hash, team_id, user_id, email, payload_json,
          created_by_user_id, created_at, expires_at, used_at,
          used_by_user_id, revoked_at
        FROM account_action_tokens
        WHERE team_id = ? AND type = 'team_invite'
        ORDER BY created_at DESC`,
      )
      .all("team-1");
    expect(legacyRows.every(isAccountActionTokenRow)).toBe(true);

    await expect(listTeamInviteTokens(env, "team-1")).resolves.toEqual(
      legacyRows
        .filter(isAccountActionTokenRow)
        .map(toPublicAccountActionToken),
    );
  });

  it("matches the member site IN result for same-team and cross-team ids", async () => {
    const { database, env } = createFixture();
    const siteIds = ["site-1", "site-2"];
    const matching = database
      .prepare(
        `SELECT id FROM sites WHERE team_id = ? AND id IN (${siteIds.map(() => "?").join(",")})`,
      )
      .all("team-1", ...siteIds);
    await expect(assertSitesBelongToTeam(env, "team-1", siteIds)).resolves.toBe(
      matching.length === siteIds.length,
    );

    const mixedSiteIds = ["site-1", "site-other"];
    const mixedMatching = database
      .prepare(
        `SELECT id FROM sites WHERE team_id = ? AND id IN (${mixedSiteIds.map(() => "?").join(",")})`,
      )
      .all("team-1", ...mixedSiteIds);
    await expect(
      assertSitesBelongToTeam(env, "team-1", mixedSiteIds),
    ).resolves.toBe(mixedMatching.length === mixedSiteIds.length);
  });
});

describe("typed DAL mutation differential checks", () => {
  it("matches config upsert state", async () => {
    const legacy = createFixture();
    const compiled = createFixture();
    for (const { database } of [legacy, compiled]) {
      database
        .prepare(
          "INSERT INTO configs (config_key, value_json, created_at, updated_at) VALUES (?, ?, ?, ?)",
        )
        .run("feature-flags", '{"enabled":false}', 100, 200);
    }

    legacy.database
      .prepare(
        `INSERT INTO configs (config_key, value_json, created_at, updated_at)
        VALUES (?, ?, unixepoch(), unixepoch())
        ON CONFLICT(config_key) DO UPDATE SET
          value_json = excluded.value_json,
          updated_at = unixepoch()`,
      )
      .run("feature-flags", '{"enabled":true}');
    await upsertConfig(compiled.env, "feature-flags", { enabled: true });

    const legacyRow = legacy.database
      .prepare(
        "SELECT value_json, created_at, updated_at FROM configs WHERE config_key = ?",
      )
      .get("feature-flags") as Record<string, unknown>;
    const compiledRow = compiled.database
      .prepare(
        "SELECT value_json, created_at, updated_at FROM configs WHERE config_key = ?",
      )
      .get("feature-flags") as Record<string, unknown>;
    expect(compiledRow).toEqual(legacyRow);
  });

  it("matches API key revoke state and preserves write-then-read", async () => {
    const legacy = createFixture();
    const compiled = createFixture();
    seedApiKey(legacy.database, "revoke-me", 100);
    seedApiKey(compiled.database, "revoke-me", 100);

    legacy.database
      .prepare(
        `UPDATE api_keys
        SET revoked_at = COALESCE(revoked_at, unixepoch()),
            revoked_by_user_id = COALESCE(revoked_by_user_id, ?),
            updated_at = unixepoch()
        WHERE id = ? AND team_id = ?`,
      )
      .run("team-admin", "revoke-me", "team-1");
    const legacyRow = legacy.database
      .prepare(
        `SELECT id, team_id, name, key_prefix, key_hash, scopes_json, site_ids_json,
          created_by_user_id, expires_at, revoked_at, revoked_by_user_id,
          rotated_from_key_id, last_used_at, created_at, updated_at
        FROM api_keys WHERE id = ? LIMIT 1`,
      )
      .get("revoke-me");
    expect(legacyRow).toBeDefined();
    if (!legacyRow || !isApiKeyRow(legacyRow)) {
      throw new Error("legacy_api_key_row_invalid");
    }
    const publicLegacyRow = toPublicApiKey(legacyRow);
    const publicCompiledRow = await revokeApiKeyRecord(compiled.env, {
      keyId: "revoke-me",
      teamId: "team-1",
      revokedByUserId: "team-admin",
    });

    expect(publicCompiledRow).toEqual(publicLegacyRow);
  });

  it("matches account token mark-used state", async () => {
    const legacy = createFixture();
    const compiled = createFixture();
    seedAccountToken(legacy.database, "use-me", 100);
    seedAccountToken(compiled.database, "use-me", 100);

    legacy.database
      .prepare(
        `UPDATE account_action_tokens
        SET used_at = COALESCE(used_at, unixepoch()),
            used_by_user_id = COALESCE(used_by_user_id, ?)
        WHERE id = ? AND used_at IS NULL AND revoked_at IS NULL`,
      )
      .run("team-admin", "use-me");
    const legacyRow = legacy.database
      .prepare(
        `SELECT id, type, token_hash, team_id, user_id, email, payload_json,
          created_by_user_id, created_at, expires_at, used_at,
          used_by_user_id, revoked_at
        FROM account_action_tokens WHERE id = ? LIMIT 1`,
      )
      .get("use-me");
    const compiledRow = await markAccountActionTokenUsed(compiled.env, {
      tokenId: "use-me",
      usedByUserId: "team-admin",
    });

    expect(compiledRow).toEqual(legacyRow);
  });

  it("matches notification preference merge and stored state", async () => {
    const legacy = createFixture();
    const compiled = createFixture();
    for (const { database } of [legacy, compiled]) {
      database
        .prepare(
          "UPDATE users SET notification_preferences_json = ? WHERE id = ?",
        )
        .run(
          JSON.stringify({
            email: false,
            webPush: true,
            attention: {
              reportsCreateUnread: true,
              milestonesCreateUnread: false,
              alertsCreateUnread: true,
            },
          }),
          "member-1",
        );
    }
    const update = {
      email: true,
      webPush: false,
      attention: { milestonesCreateUnread: true },
    };
    const current = legacy.database
      .prepare(
        "SELECT notification_preferences_json AS preferencesJson FROM users WHERE id = ? LIMIT 1",
      )
      .get("member-1") as { preferencesJson: string };
    const next = mergeNotificationPreferencesUpdate(
      current.preferencesJson,
      update,
    );
    legacy.database
      .prepare(
        "UPDATE users SET notification_preferences_json = ?, updated_at = unixepoch() WHERE id = ?",
      )
      .run(safeJsonStringify(next), "member-1");
    await updateUserNotificationPreferences(compiled.env, {
      userId: "member-1",
      preferences: update,
    });

    const legacyRow = legacy.database
      .prepare(
        "SELECT notification_preferences_json, updated_at FROM users WHERE id = ?",
      )
      .get("member-1");
    const compiledRow = compiled.database
      .prepare(
        "SELECT notification_preferences_json, updated_at FROM users WHERE id = ?",
      )
      .get("member-1");
    expect(compiledRow).toEqual(legacyRow);
  });
});
