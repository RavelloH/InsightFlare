import { describe, expect, it } from "vitest";

import {
  applyAnalyticsEngineDisabledFallback,
  applyWranglerEnvOverrides,
  isAnalyticsEngineNotEnabledError,
} from "./wrangler-env-overrides";

const BASE_CONFIG = `name = "insightflare"

[vars]
SESSION_WINDOW_MINUTES = "30" # keep comment

[[d1_databases]]
binding = "DB"
database_name = "insightflare"
database_id = "YOUR_D1_ID"
migrations_dir = "./migrations"

[[kv_namespaces]]
binding = "SITE_SETTINGS_KV"
id = "YOUR_KV_ID"

[[analytics_engine_datasets]]
binding = "BOT_ANALYTICS"
dataset = "insightflare_bot_events"

[[analytics_engine_datasets]]
binding = "NORMAL_ANALYTICS"
dataset = "insightflare_normal_events"

[env.production]
name = "insightflare-production"

[env.production.vars]
SESSION_WINDOW_MINUTES = "30"

[[env.production.d1_databases]]
binding = "DB"
database_name = "insightflare"
database_id = "PROD_D1_ID"
migrations_dir = "./migrations"

[[env.production.analytics_engine_datasets]]
binding = "BOT_ANALYTICS"
dataset = "insightflare_bot_events"

[[env.production.analytics_engine_datasets]]
binding = "NORMAL_ANALYTICS"
dataset = "insightflare_normal_events"
`;

describe("applyWranglerEnvOverrides", () => {
  it("overrides root vars and resource bindings from environment values", () => {
    const result = applyWranglerEnvOverrides(BASE_CONFIG, {
      SESSION_WINDOW_MINUTES: "45",
      INSIGHTFLARE_D1_DATABASE_ID: "d1-id",
      INSIGHTFLARE_SITE_SETTINGS_KV_ID: "kv-id",
      INSIGHTFLARE_VAR_CUSTOM_FLAG: "enabled",
    });

    expect(result.applied).toEqual([
      "[vars].SESSION_WINDOW_MINUTES",
      "[vars].CUSTOM_FLAG",
      "[[d1_databases]].database_id",
      "[[kv_namespaces]].id",
    ]);
    expect(result.content).toContain(
      'SESSION_WINDOW_MINUTES = "45" # keep comment',
    );
    expect(result.content).toContain('CUSTOM_FLAG = "enabled"');
    expect(result.content).toContain('database_id = "d1-id"');
    expect(result.content).toContain('id = "kv-id"');
  });

  it("replaces an existing CRLF variable without duplicating it", () => {
    const config = `[vars]\r\nDEMO_MODE = "1"\r\n[[migrations]]\r\ntag = "v1"\r\n`;
    const result = applyWranglerEnvOverrides(config, { DEMO_MODE: "1" });

    expect(result.content.match(/^DEMO_MODE\s*=/gm)).toHaveLength(1);
    expect(result.content).toContain('DEMO_MODE = "1"\r\n');
  });

  it("overrides root and environment worker names", () => {
    const rootResult = applyWranglerEnvOverrides(BASE_CONFIG, {
      INSIGHTFLARE_WORKER_NAME: "custom-root",
    });
    const envResult = applyWranglerEnvOverrides(
      BASE_CONFIG,
      {
        INSIGHTFLARE_PRODUCTION_WORKER_NAME: "custom-production",
      },
      "production",
    );

    expect(rootResult.content).toContain('name = "custom-root"');
    expect(envResult.content).toContain(
      '[env.production]\nname = "custom-production"',
    );
    expect(envResult.content).toContain('name = "insightflare"');
  });

  it("targets the selected Wrangler environment and supports env-specific names", () => {
    const result = applyWranglerEnvOverrides(
      BASE_CONFIG,
      {
        INSIGHTFLARE_PRODUCTION_D1_DATABASE_ID: "production-d1-id",
        INSIGHTFLARE_PRODUCTION_VAR_CUSTOM_FLAG: "prod-enabled",
      },
      "production",
    );

    expect(result.applied).toEqual([
      "[env.production.vars].CUSTOM_FLAG",
      "[[env.production.d1_databases]].database_id",
    ]);
    expect(result.content).toContain('database_id = "production-d1-id"');
    expect(result.content).toContain('CUSTOM_FLAG = "prod-enabled"');
    expect(result.content).toContain('database_id = "YOUR_D1_ID"');
  });

  it("creates the optional R2 binding when a bucket name is supplied", () => {
    const result = applyWranglerEnvOverrides(BASE_CONFIG, {
      INSIGHTFLARE_ARCHIVE_BUCKET_NAME: "archive",
      INSIGHTFLARE_ARCHIVE_PREVIEW_BUCKET_NAME: "archive-preview",
    });

    expect(result.content).toContain("[[r2_buckets]]");
    expect(result.content).toContain('binding = "ARCHIVE_BUCKET"');
    expect(result.content).toContain('bucket_name = "archive"');
    expect(result.content).toContain('preview_bucket_name = "archive-preview"');
  });

  it("removes root Analytics Engine binding and writes disabled runtime var", () => {
    const result = applyAnalyticsEngineDisabledFallback(BASE_CONFIG);

    expect(result.content).not.toContain("[[analytics_engine_datasets]]");
    expect(result.content).toContain(
      "[[env.production.analytics_engine_datasets]]",
    );
    expect(result.content).toContain(
      'INSIGHTFLARE_ANALYTICS_ENGINE_DISABLED = "1"',
    );
  });

  it("removes all root Analytics Engine datasets when disabled", () => {
    const result = applyAnalyticsEngineDisabledFallback(BASE_CONFIG);
    const rootContent = result.content.split("[env.production]")[0] ?? "";

    expect(rootContent).not.toContain('binding = "BOT_ANALYTICS"');
    expect(rootContent).not.toContain('binding = "NORMAL_ANALYTICS"');
    expect(rootContent).not.toContain('dataset = "insightflare_bot_events"');
    expect(rootContent).not.toContain('dataset = "insightflare_normal_events"');
  });

  it("targets environment Analytics Engine binding for env deploys", () => {
    const result = applyAnalyticsEngineDisabledFallback(
      BASE_CONFIG,
      "production",
    );

    expect(result.content).toContain("[[analytics_engine_datasets]]");
    expect(result.content).not.toContain(
      "[[env.production.analytics_engine_datasets]]",
    );
    const envContent = result.content.split("[env.production]")[1] ?? "";
    expect(envContent).not.toContain('binding = "BOT_ANALYTICS"');
    expect(envContent).not.toContain('binding = "NORMAL_ANALYTICS"');
    expect(result.content).toContain("[env.production.vars]");
    expect(result.content).toContain(
      'INSIGHTFLARE_ANALYTICS_ENGINE_DISABLED = "1"',
    );
  });

  it("recognizes Cloudflare Analytics Engine disabled deploy errors", () => {
    expect(
      isAnalyticsEngineNotEnabledError(
        "You need to enable Analytics Engine. [code: 10089]",
      ),
    ).toBe(true);
    expect(isAnalyticsEngineNotEnabledError("different deploy error")).toBe(
      false,
    );
  });
});
