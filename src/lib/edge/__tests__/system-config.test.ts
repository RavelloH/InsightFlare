import type { DatabaseSync } from "node:sqlite";

import { afterEach, describe, expect, it } from "vitest";

import { createMigratedDatabase } from "@/../scripts/schema/database";
import {
  createSqliteD1Database,
  type SqliteD1Trace,
} from "@/lib/db/__tests__/sqlite-d1";
import {
  deleteConfig,
  readConfig,
  upsertConfig,
} from "@/lib/edge/system-config";
import type { Env } from "@/lib/edge/types";

function sqliteEnv(database: DatabaseSync, trace: SqliteD1Trace): Env {
  return { DB: createSqliteD1Database(database, trace) } as Env;
}

describe("system config typed DAL", () => {
  let database: DatabaseSync | undefined;

  afterEach(() => {
    database?.close();
    database = undefined;
  });

  it("reads missing, malformed, and valid JSON values", async () => {
    database = createMigratedDatabase();
    const trace = { preparedSql: [], bindings: [] } satisfies SqliteD1Trace;
    const env = sqliteEnv(database, trace);
    database
      .prepare("INSERT INTO configs (config_key, value_json) VALUES (?, ?)")
      .run("malformed", "{");
    database
      .prepare("INSERT INTO configs (config_key, value_json) VALUES (?, ?)")
      .run("valid", '{"enabled":true}');

    await expect(readConfig(env, "missing")).resolves.toBeNull();
    await expect(readConfig(env, "malformed")).resolves.toBeNull();
    await expect(readConfig(env, "valid")).resolves.toEqual({ enabled: true });
    expect(trace.preparedSql).toHaveLength(3);
  });

  it("inserts, updates, and deletes a config without changing its API", async () => {
    database = createMigratedDatabase();
    const trace = { preparedSql: [], bindings: [] } satisfies SqliteD1Trace;
    const env = sqliteEnv(database, trace);

    await upsertConfig(env, "feature", { enabled: false });
    await upsertConfig(env, "feature", { enabled: true });

    await expect(readConfig(env, "feature")).resolves.toEqual({
      enabled: true,
    });
    const timestamps = database
      .prepare(
        "SELECT created_at, updated_at FROM configs WHERE config_key = ?",
      )
      .get("feature");
    expect(timestamps).toMatchObject({ created_at: expect.any(Number) });

    await deleteConfig(env, "feature");
    await expect(readConfig(env, "feature")).resolves.toBeNull();
    expect(trace.preparedSql).toHaveLength(5);
  });
});
