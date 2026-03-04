import type { Env } from "./types";

const TRUE_VALUES = new Set(["1", "true", "yes", "on"]);

function parseBooleanFlag(value: string | undefined, fallback = false): boolean {
  if (typeof value !== "string") return fallback;
  const normalized = value.trim().toLowerCase();
  if (normalized.length === 0) return fallback;
  return TRUE_VALUES.has(normalized);
}

export function isAnalyticsEngineDisabled(env: Pick<Env, "DISABLE_ANALYTICS_ENGINE">): boolean {
  return parseBooleanFlag(env.DISABLE_ANALYTICS_ENGINE, false);
}

export function isAnalyticsEngineEnabled(env: Pick<Env, "DISABLE_ANALYTICS_ENGINE">): boolean {
  return !isAnalyticsEngineDisabled(env);
}
