import { describe, expect, it } from "vitest";

import { analyticsFilterRegistry } from "@/lib/edge/analytics/contract/filter-registry";
import {
  decodeGoalConfig,
  encodeGoalConfig,
  GOAL_CONFIG_VERSION,
  type GoalConfigV1,
  goalSemanticFingerprint,
  parseGoalFilter,
  validateGoalConfigForWrite,
} from "@/lib/edge/analytics/contract/goal-config";
import { FILTER_DSL_MAX_LENGTH, parseFilterDsl } from "@/lib/filter-contract";

const validConfig: GoalConfigV1 = {
  filterDslVersion: 1,
  filterDsl: 'event.name eq "purchase"',
};

describe("goal v1 config contract", () => {
  it("decodes and encodes the exact raw DSL", () => {
    const config: GoalConfigV1 = {
      filterDslVersion: 1,
      filterDsl:
        '  event.name eq "purchase" AND\n(event.payload("/plan") eq "pro")  ',
    };
    const encoded = encodeGoalConfig(config);

    expect(GOAL_CONFIG_VERSION).toBe(1);
    expect(encoded.configVersion).toBe(1);
    expect(JSON.parse(encoded.configJson)).toEqual(config);
    expect(decodeGoalConfig(encoded.configVersion, encoded.configJson)).toEqual(
      config,
    );
    expect(parseGoalFilter(config)).toEqual(
      parseFilterDsl(config.filterDsl, analyticsFilterRegistry),
    );
  });

  it("rejects invalid JSON, unknown versions, and invalid structures", () => {
    expect(() => decodeGoalConfig(1, "not-json")).toThrow(
      "goal_config_json_invalid",
    );
    expect(() => decodeGoalConfig(2, JSON.stringify(validConfig))).toThrow(
      "goal_config_version_unknown:2",
    );
    expect(() => decodeGoalConfig(1, "null")).toThrow("goal_v1_config_invalid");
    expect(() =>
      decodeGoalConfig(
        1,
        JSON.stringify({
          filterDslVersion: 1,
          filterDsl: 'event.name nope "purchase"',
        }),
      ),
    ).toThrow("goal_filter_dsl_invalid");
    expect(() =>
      decodeGoalConfig(1, JSON.stringify({ ...validConfig, extra: true })),
    ).toThrow("goal_v1_config_invalid");
    expect(() =>
      decodeGoalConfig(1, JSON.stringify({ filterDsl: validConfig.filterDsl })),
    ).toThrow("goal_v1_config_invalid");
    expect(() => decodeGoalConfig(1.5, JSON.stringify(validConfig))).toThrow(
      "goal_config_version_invalid",
    );
  });

  it("rejects empty, oversized, invalid, and unsupported DSL", () => {
    expect(() => validateGoalConfigForWrite({} as never)).toThrow(
      "goal_config_invalid",
    );
    expect(() =>
      validateGoalConfigForWrite({
        ...validConfig,
        filterDsl: "   ",
      }),
    ).toThrow("goal_filter_dsl_invalid");
    expect(() =>
      validateGoalConfigForWrite({
        ...validConfig,
        filterDsl: "x".repeat(FILTER_DSL_MAX_LENGTH + 1),
      }),
    ).toThrow("goal_filter_dsl_invalid");
    expect(() =>
      validateGoalConfigForWrite({
        ...validConfig,
        filterDsl: 'event.name nope "purchase"',
      }),
    ).toThrow("goal_filter_dsl_invalid");
    expect(() =>
      validateGoalConfigForWrite({
        ...validConfig,
        filterDsl: 'page.query eq "utm_source=ad"',
      }),
    ).not.toThrow();
    expect(() =>
      validateGoalConfigForWrite({
        ...validConfig,
        filterDsl: 'missing.field eq "value"',
      }),
    ).toThrow("goal_filter_dsl_invalid");
    expect(() =>
      validateGoalConfigForWrite({
        ...validConfig,
        filterDslVersion: 2,
      } as never),
    ).toThrow("goal_filter_dsl_version_invalid");
  });

  it("keeps the authored DSL while canonicalizing equivalent semantics for fingerprints", async () => {
    const equivalent: GoalConfigV1 = {
      filterDslVersion: 1,
      filterDsl: 'AND(event.name eq "purchase")',
    };
    const semanticChange: GoalConfigV1 = {
      filterDslVersion: 1,
      filterDsl: 'event.name eq "purchase" AND page.path eq "/checkout"',
    };

    expect(validateGoalConfigForWrite(equivalent).filterDsl).toBe(
      equivalent.filterDsl,
    );
    await expect(goalSemanticFingerprint(validConfig)).resolves.toBe(
      await goalSemanticFingerprint(equivalent),
    );
    await expect(goalSemanticFingerprint(validConfig)).resolves.not.toBe(
      await goalSemanticFingerprint(semanticChange),
    );
  });

  it("does not include definition names or timestamps in semantic identity", async () => {
    const first = {
      ...validConfig,
      id: "goal-1",
      siteId: "site-1",
      name: "Original name",
      createdAt: 1,
      updatedAt: 2,
    };
    const renamed = {
      ...first,
      name: "Renamed goal",
      createdAt: 10,
      updatedAt: 20,
    };

    await expect(goalSemanticFingerprint(first)).resolves.toBe(
      await goalSemanticFingerprint(renamed),
    );
  });
});
