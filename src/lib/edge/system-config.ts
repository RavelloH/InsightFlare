import {
  compileD1Mutation,
  compileD1Query,
  createDatabaseClient,
  createDatabaseRuntime,
  deleteFrom,
  eq,
  excluded,
  filter,
  insert,
  limit,
  onConflictDoUpdate,
  param,
  project,
  scan,
  unixepoch,
} from "@/lib/db";
import { schema } from "@/lib/db/schema";

import type { Env } from "./types";

function database(env: Pick<Env, "DB">) {
  return createDatabaseClient(createDatabaseRuntime(env.DB));
}

export async function readConfig(
  env: Pick<Env, "DB">,
  key: string,
): Promise<Record<string, unknown> | null> {
  const configs = scan(schema.configs);
  const matchingConfig = filter(
    configs,
    eq(configs.columns.config_key, param(key)),
  );
  const row = await database(env).first(
    compileD1Query(
      limit(
        project(matchingConfig, {
          value_json: matchingConfig.columns.value_json,
        }),
        1,
      ),
      { tag: "system-config.ts.configs.first" },
    ),
  );
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
  await database(env).run(
    compileD1Mutation(
      onConflictDoUpdate(
        insert(schema.configs, {
          config_key: key,
          value_json: JSON.stringify(value),
          created_at: unixepoch(),
          updated_at: unixepoch(),
        }),
        ["config_key"],
        {
          value_json: excluded(schema.configs.columns.value_json),
          updated_at: unixepoch(),
        },
      ),
      { tag: "system.configs.upsert" },
    ),
  );
}

export async function deleteConfig(
  env: Pick<Env, "DB">,
  key: string,
): Promise<void> {
  const configs = schema.configs;
  await database(env).run(
    compileD1Mutation(
      deleteFrom(configs, (columns) => eq(columns.config_key, param(key))),
      { tag: "system.configs.delete" },
    ),
  );
}
