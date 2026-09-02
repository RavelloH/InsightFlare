import { describe, expect, it } from "vitest";

import {
  defaultAnalyticsEngineConfig,
  EVENT_ANALYTICS_DATASET,
  makeSecretHint,
  normalizeAnalyticsEngineConfig,
  redactAnalyticsEngineConfig,
  REQUEST_ANALYTICS_DATASET,
  TRAFFIC_ANALYTICS_DATASET,
  validateAnalyticsEngineConfig,
  validateAnalyticsEngineUpdateInput,
} from "@/lib/analytics-engine-config";

describe("Analytics Engine config helpers", () => {
  it("normalizes defaults, malformed values, and configured state", () => {
    expect(makeSecretHint("")).toBe("");
    expect(makeSecretHint("abcdef")).toBe("••••cdef");

    const normalized = normalizeAnalyticsEngineConfig({
      accountId: " abc ",
      apiTokenEncrypted: "",
      apiTokenHint: " hint ",
      configured: true,
      updatedAt: "bad",
      updatedByUserId: 123,
    });

    expect(normalized).toMatchObject({
      accountId: "abc",
      apiTokenEncrypted: "",
      configured: false,
      updatedAt: 0,
      updatedByUserId: undefined,
    });

    expect(
      normalizeAnalyticsEngineConfig({
        ...defaultAnalyticsEngineConfig(),
        apiTokenEncrypted: "v1:secret",
        configured: true,
        updatedAt: "123",
        updatedByUserId: "admin-1",
      }),
    ).toMatchObject({
      configured: true,
      updatedAt: 123,
      updatedByUserId: "admin-1",
    });
  });

  it("ignores client dataset fields and validates saved config", () => {
    expect(validateAnalyticsEngineUpdateInput(null).ok).toBe(false);
    expect(validateAnalyticsEngineUpdateInput([]).ok).toBe(false);
    expect(
      validateAnalyticsEngineUpdateInput({
        accountId: " 442fe5198bff93bdf60d4223d9618033 ",
        dataset: "old_dataset",
        [["normal", "Dataset"].join("")]: "old_normal_dataset",
        apiToken: " token ",
        clearApiToken: "yes",
      }),
    ).toEqual({
      ok: true,
      input: {
        accountId: "442fe5198bff93bdf60d4223d9618033",
        apiToken: "token",
        clearApiToken: false,
      },
    });

    const valid = {
      ...defaultAnalyticsEngineConfig(),
      accountId: "442fe5198bff93bdf60d4223d9618033",
    };
    expect(validateAnalyticsEngineConfig(valid)).toBeNull();
    expect(validateAnalyticsEngineConfig({ ...valid, accountId: "" })).toMatch(
      /Account ID/,
    );
    expect(
      validateAnalyticsEngineConfig({ ...valid, accountId: "bad" }),
    ).toMatch(/32 character/);
    expect(
      validateAnalyticsEngineConfig({
        ...valid,
        configured: true,
        apiTokenEncrypted: "",
      }),
    ).toMatch(/API token/);

    expect(redactAnalyticsEngineConfig(valid)).toMatchObject({
      requestDataset: REQUEST_ANALYTICS_DATASET,
      trafficDataset: TRAFFIC_ANALYTICS_DATASET,
      eventDataset: EVENT_ANALYTICS_DATASET,
    });
  });
});
