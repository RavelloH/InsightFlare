import {
  DEFAULT_RETENTION_CONFIG,
  normalizeRetentionConfig,
  RETENTION_CONFIG_KEY,
} from "@/lib/retention";
import type { ScheduledTaskRetentionConfig } from "@/lib/scheduled-tasks";

import { readConfig, upsertConfig } from "./system-config";
import type { Env } from "./types";

export async function readRetentionConfig(
  env: Pick<Env, "DB">,
): Promise<ScheduledTaskRetentionConfig> {
  try {
    return normalizeRetentionConfig(
      await readConfig(env, RETENTION_CONFIG_KEY),
    );
  } catch {
    return DEFAULT_RETENTION_CONFIG;
  }
}

export async function writeRetentionConfig(
  env: Pick<Env, "DB">,
  value: ScheduledTaskRetentionConfig,
): Promise<ScheduledTaskRetentionConfig> {
  const normalized = normalizeRetentionConfig(value);
  await upsertConfig(env, RETENTION_CONFIG_KEY, { ...normalized });
  return normalized;
}
