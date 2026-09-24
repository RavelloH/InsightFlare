import type { Env } from "@/lib/edge/types";

export const ANALYTICS_ENGINE_ENABLE_URL =
  "https://dash.cloudflare.com/?to=/:account/workers/analytics-engine";

function enabledFlag(value: string | undefined): boolean {
  return ["1", "true", "yes", "on"].includes(
    String(value || "")
      .trim()
      .toLowerCase(),
  );
}

export function isAnalyticsEngineDisabled(env: Env): boolean {
  return enabledFlag(env.INSIGHTFLARE_ANALYTICS_ENGINE_DISABLED);
}

export function analyticsEngineAvailability(env: Env): {
  analyticsEngineDisabled: boolean;
  analyticsEngineEnableUrl: string;
} {
  return {
    analyticsEngineDisabled: isAnalyticsEngineDisabled(env),
    analyticsEngineEnableUrl: ANALYTICS_ENGINE_ENABLE_URL,
  };
}
