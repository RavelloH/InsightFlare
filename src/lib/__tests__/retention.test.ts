import { describe, expect, it } from "vitest";

import { notificationRuleExpiresAtSeconds } from "@/lib/notifications/schedule";
import {
  DEFAULT_RETENTION_CONFIG,
  mergeRetentionConfig,
  normalizeRetentionConfig,
} from "@/lib/retention";

describe("retention configuration", () => {
  it("falls back per field for missing and invalid values", () => {
    expect(
      normalizeRetentionConfig({
        scheduledTaskLogsDays: 45,
        notificationTestDays: 0,
        notificationAttentionDays: "180",
      }),
    ).toEqual({
      ...DEFAULT_RETENTION_CONFIG,
      scheduledTaskLogsDays: 45,
    });
  });

  it("merges configured retention without changing the defaults", () => {
    const config = mergeRetentionConfig(DEFAULT_RETENTION_CONFIG, {
      notificationTestDays: 7,
    });
    expect(config).toMatchObject({
      scheduledTaskLogsDays: 30,
      notificationTestDays: 7,
      notificationAttentionDays: 180,
      notificationDefaultDays: 120,
    });
    expect(
      notificationRuleExpiresAtSeconds({
        type: "test",
        severity: "info",
        createdAtSeconds: 1000,
        retention: config,
      }),
    ).toBe(1000 + 7 * 24 * 60 * 60);
  });
});
