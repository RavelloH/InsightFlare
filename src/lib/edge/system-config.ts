import { createDatabaseRuntime } from "@/lib/db";

import type { Env } from "./types";

export async function readConfig(
  env: Pick<Env, "DB">,
  key: string,
): Promise<Record<string, unknown> | null> {
  const row = await createDatabaseRuntime(env.DB).first<{
    value_json: string | null;
  }>({
    sql: "SELECT value_json FROM configs WHERE config_key = ? LIMIT 1",
    bindings: [key],
    tag: "system-config.ts.configs.first",
  });
  if (!row?.value_json) return null;
  try {
    const parsed = JSON.parse(row.value_json) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

export async function upsertConfig(
  env: Pick<Env, "DB">,
  key: string,
  value: Record<string, unknown>,
): Promise<void> {
  await createDatabaseRuntime(env.DB).run({
    sql: `
      INSERT INTO configs (config_key, value_json, created_at, updated_at)
      VALUES (?, ?, unixepoch(), unixepoch())
      ON CONFLICT(config_key) DO UPDATE SET
        value_json = excluded.value_json,
        updated_at = unixepoch()
    `,
    bindings: [key, JSON.stringify(value)],
    tag: "system.configs.upsert",
  });
}

export async function deleteConfig(
  env: Pick<Env, "DB">,
  key: string,
): Promise<void> {
  await createDatabaseRuntime(env.DB).run({
    sql: "DELETE FROM configs WHERE config_key = ?",
    bindings: [key],
    tag: "system.configs.delete",
  });
}
