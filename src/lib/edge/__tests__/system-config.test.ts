import type { DatabaseSync } from "node:sqlite";
import { type SQLInputValue } from "node:sqlite";

import { afterEach, describe, expect, it } from "vitest";

import { createMigratedDatabase } from "@/../scripts/schema/database";
import {
  deleteConfig,
  readConfig,
  upsertConfig,
} from "@/lib/edge/system-config";
import type { Env } from "@/lib/edge/types";

function sqliteEnv(database: DatabaseSync): Env {
  const DB = {
    prepare(sql: string) {
      const statement = database.prepare(sql);
      let bindings: SQLInputValue[] = [];
      const prepared = {
        bind(...values: SQLInputValue[]) {
          bindings = values;
          return prepared;
        },
        async first<Row>() {
          return (statement.get(...bindings) as Row | undefined) ?? null;
        },
        async all<Row>() {
          return {
            success: true,
            results: statement.all(...bindings) as Row[],
          } as D1Result<Row>;
        },
        async run() {
          const result = statement.run(...bindings);
          return {
            success: true,
            meta: { changes: Number(result.changes) },
          } as D1Result;
        },
      };
      return prepared as unknown as D1PreparedStatement;
    },
  };
  return { DB: DB as D1Database } as Env;
}

describe("system config typed DAL", () => {
  let database: DatabaseSync | undefined;

  afterEach(() => {
    database?.close();
    database = undefined;
  });

  it("reads missing, malformed, and valid JSON values", async () => {
    database = createMigratedDatabase();
    const env = sqliteEnv(database);
    database
      .prepare("INSERT INTO configs (config_key, value_json) VALUES (?, ?)")
      .run("malformed", "{");
    database
      .prepare("INSERT INTO configs (config_key, value_json) VALUES (?, ?)")
      .run("valid", '{"enabled":true}');

    await expect(readConfig(env, "missing")).resolves.toBeNull();
    await expect(readConfig(env, "malformed")).resolves.toBeNull();
    await expect(readConfig(env, "valid")).resolves.toEqual({ enabled: true });
  });

  it("inserts, updates, and deletes a config without changing its API", async () => {
    database = createMigratedDatabase();
    const env = sqliteEnv(database);

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
  });
});
