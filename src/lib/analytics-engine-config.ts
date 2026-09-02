export const SYSTEM_ANALYTICS_ENGINE_CONFIG_KEY =
  "system.analytics_engine_reader.v1";

export const REQUEST_ANALYTICS_DATASET = "insightflare_request_events";
export const TRAFFIC_ANALYTICS_DATASET = "insightflare_traffic_events";
export const EVENT_ANALYTICS_DATASET = "insightflare_event_facts";

export interface AnalyticsEngineConfig {
  accountId: string;
  apiTokenEncrypted: string;
  apiTokenHint: string;
  configured: boolean;
  updatedAt: number;
  updatedByUserId?: string;
}

export interface PublicAnalyticsEngineConfig {
  accountId: string;
  analyticsEngineDisabled: boolean;
  analyticsEngineEnableUrl: string;
  requestDataset: typeof REQUEST_ANALYTICS_DATASET;
  trafficDataset: typeof TRAFFIC_ANALYTICS_DATASET;
  eventDataset: typeof EVENT_ANALYTICS_DATASET;
  apiTokenConfigured: boolean;
  apiTokenHint: string;
  updatedAt: number;
}

export interface AnalyticsEngineConfigUpdateInput {
  accountId?: string;
  apiToken?: string;
  clearApiToken?: boolean;
}

function cleanString(value: unknown, maxLength: number): string {
  return typeof value === "string" ? value.trim().slice(0, maxLength) : "";
}

export function defaultAnalyticsEngineConfig(): AnalyticsEngineConfig {
  return {
    accountId: "",
    apiTokenEncrypted: "",
    apiTokenHint: "",
    configured: false,
    updatedAt: 0,
  };
}

export function makeSecretHint(secret: string): string {
  const value = secret.trim();
  return value ? `••••${value.slice(-4)}` : "";
}

export function normalizeAnalyticsEngineConfig(
  raw: Record<string, unknown>,
): AnalyticsEngineConfig {
  const config = defaultAnalyticsEngineConfig();
  config.accountId = cleanString(raw.accountId, 128);
  config.apiTokenEncrypted = cleanString(raw.apiTokenEncrypted, 4096);
  config.apiTokenHint = cleanString(raw.apiTokenHint, 80);
  config.configured =
    Boolean(raw.configured) && Boolean(config.apiTokenEncrypted);
  config.updatedAt = Number.isFinite(Number(raw.updatedAt))
    ? Number(raw.updatedAt)
    : 0;
  config.updatedByUserId = cleanString(raw.updatedByUserId, 128) || undefined;
  return config;
}

export function redactAnalyticsEngineConfig(
  config: AnalyticsEngineConfig,
  availability?: {
    analyticsEngineDisabled?: boolean;
    analyticsEngineEnableUrl?: string;
  },
): PublicAnalyticsEngineConfig {
  return {
    accountId: config.accountId,
    analyticsEngineDisabled: availability?.analyticsEngineDisabled ?? false,
    analyticsEngineEnableUrl: availability?.analyticsEngineEnableUrl ?? "",
    requestDataset: REQUEST_ANALYTICS_DATASET,
    trafficDataset: TRAFFIC_ANALYTICS_DATASET,
    eventDataset: EVENT_ANALYTICS_DATASET,
    apiTokenConfigured: config.configured,
    apiTokenHint: config.apiTokenHint,
    updatedAt: config.updatedAt,
  };
}

export function validateAnalyticsEngineUpdateInput(
  raw: unknown,
):
  | { ok: true; input: AnalyticsEngineConfigUpdateInput }
  | { ok: false; message: string } {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, message: "Invalid request body" };
  }
  const body = raw as Record<string, unknown>;
  const input: AnalyticsEngineConfigUpdateInput = {};
  if ("accountId" in body) input.accountId = cleanString(body.accountId, 128);
  if ("apiToken" in body) input.apiToken = cleanString(body.apiToken, 4096);
  if ("clearApiToken" in body) {
    input.clearApiToken = body.clearApiToken === true;
  }
  return { ok: true, input };
}

export function validateAnalyticsEngineConfig(
  config: AnalyticsEngineConfig,
): string | null {
  if (!config.accountId) return "Cloudflare Account ID is required";
  if (!/^[a-f0-9]{32}$/i.test(config.accountId)) {
    return "Cloudflare Account ID must be a 32 character hex string";
  }
  if (config.configured && !config.apiTokenEncrypted) {
    return "Cloudflare API token is required";
  }
  return null;
}
