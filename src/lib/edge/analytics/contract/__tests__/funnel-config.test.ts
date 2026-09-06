import { describe, expect, it } from "vitest";

import { analyticsFilterRegistry } from "@/lib/edge/analytics/contract/filter-registry";
import {
  decodeFunnelConfig,
  encodeFunnelConfig,
  estimateFunnelSqlBindingCount,
  type FunnelConfigV2,
  funnelSemanticFingerprint,
  MAX_FUNNEL_STEPS,
  parseFunnelStepFilter,
  validateFunnelConfigForWrite,
} from "@/lib/edge/analytics/contract/funnel-config";
import { parseFilterDsl } from "@/lib/filter-contract";

const step = (id: string, filterDsl: string) => ({ id, filterDsl });

function writeConfig(overrides: Partial<FunnelConfigV2> = {}): FunnelConfigV2 {
  return {
    filterDslVersion: 1,
    progressionScope: "session",
    conversionWindowMs: null,
    steps: [
      step("first", 'page.path eq "/first"'),
      step("second", 'page.path eq "/second"'),
    ],
    ...overrides,
  };
}

describe("funnel v2 config contract", () => {
  it("decodes legacy v1 pageview/event steps without truncating history", () => {
    const config = decodeFunnelConfig(
      1,
      JSON.stringify({
        steps: [
          { type: "pageview", value: "/pricing" },
          { type: "event", value: "signup" },
        ],
      }),
    );

    expect(config).toEqual({
      filterDslVersion: 1,
      progressionScope: "session",
      conversionWindowMs: null,
      steps: [
        { id: "v1:0", filterDsl: 'page.path eq "/pricing"' },
        { id: "v1:1", filterDsl: 'event.name eq "signup"' },
      ],
    });
  });

  it("round trips v2 config and keeps the authored DSL unchanged", () => {
    const config = {
      filterDslVersion: 1 as const,
      progressionScope: "visitor" as const,
      conversionWindowMs: 86_400_000,
      steps: [
        step("landing", 'page.path eq "/pricing"'),
        { ...step("signup", 'event.name eq "signup"'), name: "Sign up" },
      ],
    };

    const encoded = encodeFunnelConfig(config);
    expect(encoded.configVersion).toBe(2);
    expect(
      decodeFunnelConfig(encoded.configVersion, encoded.configJson),
    ).toEqual(config);
    expect(parseFunnelStepFilter(config.steps[0]!)).toEqual(
      parseFilterDsl('page.path eq "/pricing"', analyticsFilterRegistry),
    );
  });

  it("allows historical over-limit reads but rejects every new over-limit write", () => {
    const legacySteps = Array.from(
      { length: MAX_FUNNEL_STEPS + 1 },
      (_, i) => ({
        type: "pageview",
        value: `/step-${i}`,
      }),
    );
    const decoded = decodeFunnelConfig(
      1,
      JSON.stringify({ steps: legacySteps }),
    );
    expect(decoded.steps).toHaveLength(MAX_FUNNEL_STEPS + 1);
    expect(() => validateFunnelConfigForWrite(decoded)).toThrow(
      "funnel_has_too_many_steps",
    );
  });

  it("rejects malformed legacy and v2 stored configurations", () => {
    expect(() => decodeFunnelConfig(1, JSON.stringify({}))).toThrow(
      "funnel_v1_steps_required",
    );
    expect(() =>
      decodeFunnelConfig(1, JSON.stringify({ steps: [null] })),
    ).toThrow("funnel_v1_step_invalid:0");
    expect(() =>
      decodeFunnelConfig(
        1,
        JSON.stringify({ steps: [{ type: "custom", value: "x" }] }),
      ),
    ).toThrow("funnel_v1_step_type_invalid:0");
    expect(() =>
      decodeFunnelConfig(
        1,
        JSON.stringify({ steps: [{ type: "pageview", value: "" }] }),
      ),
    ).toThrow("funnel_v1_step_value_invalid:0");

    const validV2 = writeConfig();
    expect(() => decodeFunnelConfig(2, "null")).toThrow(
      "funnel_v2_config_invalid",
    );
    expect(() =>
      decodeFunnelConfig(
        2,
        JSON.stringify({ ...validV2, filterDslVersion: 2 }),
      ),
    ).toThrow("funnel_filter_dsl_version_invalid");
    expect(() =>
      decodeFunnelConfig(
        2,
        JSON.stringify({ ...validV2, progressionScope: "account" }),
      ),
    ).toThrow("funnel_progression_scope_invalid");
    expect(() =>
      decodeFunnelConfig(
        2,
        JSON.stringify({ ...validV2, conversionWindowMs: "1" }),
      ),
    ).toThrow("funnel_conversion_window_invalid");
    expect(() =>
      decodeFunnelConfig(2, JSON.stringify({ ...validV2, steps: null })),
    ).toThrow("funnel_steps_required");
    expect(() =>
      decodeFunnelConfig(
        2,
        JSON.stringify({ ...validV2, steps: [{ id: "first" }] }),
      ),
    ).toThrow("funnel_v2_step_invalid:0");
    expect(() =>
      decodeFunnelConfig(
        2,
        JSON.stringify({
          ...validV2,
          steps: [step("", 'page.path eq "/first"'), validV2.steps[1]],
        }),
      ),
    ).toThrow("funnel_step_id_invalid:0");
    expect(() =>
      decodeFunnelConfig(
        2,
        JSON.stringify({
          ...validV2,
          steps: [step("bad id", 'page.path eq "/first"'), validV2.steps[1]],
        }),
      ),
    ).toThrow("funnel_step_id_invalid:0");
    expect(() =>
      decodeFunnelConfig(
        2,
        JSON.stringify({
          ...validV2,
          steps: [{ ...validV2.steps[0], name: 1 }, validV2.steps[1]],
        }),
      ),
    ).toThrow("funnel_step_name_invalid:0");
    expect(() =>
      decodeFunnelConfig(
        2,
        JSON.stringify({
          ...validV2,
          steps: [step("first", ""), validV2.steps[1]],
        }),
      ),
    ).toThrow("funnel_filter_dsl_invalid:0");
    expect(() =>
      decodeFunnelConfig(
        2,
        JSON.stringify({
          ...validV2,
          steps: [validV2.steps[0], validV2.steps[0]],
        }),
      ),
    ).toThrow("funnel_step_id_duplicate:1");
    expect(() =>
      decodeFunnelConfig(
        2,
        JSON.stringify({
          ...validV2,
          steps: Array.from({ length: MAX_FUNNEL_STEPS + 1 }, (_, index) =>
            step(`step-${index}`, 'page.path eq "/step"'),
          ),
        }),
      ),
    ).toThrow("funnel_has_too_many_steps");
    expect(() =>
      decodeFunnelConfig(
        2,
        JSON.stringify({
          ...validV2,
          steps: [step("first", "not a filter"), validV2.steps[1]],
        }),
      ),
    ).toThrow("funnel_filter_dsl_invalid:0");
    expect(() =>
      decodeFunnelConfig(
        2,
        JSON.stringify({
          ...validV2,
          progressionScope: "visitor",
          conversionWindowMs: null,
        }),
      ),
    ).toThrow("visitor_funnel_conversion_window_must_be_positive");
  });

  it("rejects invalid versions, windows, steps, names, and filters on write", () => {
    expect(() => decodeFunnelConfig(1.5, "{}")).toThrow(
      "funnel_config_version_invalid",
    );
    expect(() => decodeFunnelConfig(3, "{}")).toThrow(
      "funnel_config_version_unknown:3",
    );
    expect(() => decodeFunnelConfig(1, "not-json")).toThrow(
      "funnel_config_json_invalid",
    );

    expect(() => validateFunnelConfigForWrite(null as never)).toThrow(
      "funnel_config_invalid",
    );
    expect(() =>
      validateFunnelConfigForWrite({ ...writeConfig(), steps: null } as never),
    ).toThrow("funnel_steps_required");
    expect(() =>
      validateFunnelConfigForWrite({ ...writeConfig(), steps: [] }),
    ).toThrow("funnel_requires_two_steps");
    expect(() =>
      validateFunnelConfigForWrite({
        ...writeConfig(),
        filterDslVersion: 2,
      } as never),
    ).toThrow("funnel_filter_dsl_version_invalid");
    expect(() =>
      validateFunnelConfigForWrite({
        ...writeConfig(),
        steps: [null, writeConfig().steps[1]],
      } as never),
    ).toThrow("funnel_step_invalid:0");
    expect(() =>
      validateFunnelConfigForWrite({
        ...writeConfig(),
        steps: [
          step("bad id", 'page.path eq "/first"'),
          writeConfig().steps[1],
        ],
      }),
    ).toThrow("funnel_step_id_invalid:0");
    expect(() =>
      validateFunnelConfigForWrite({
        ...writeConfig(),
        steps: [
          { ...writeConfig().steps[0], name: "x".repeat(121) },
          writeConfig().steps[1],
        ],
      }),
    ).toThrow("funnel_step_name_invalid:0");
    expect(() =>
      validateFunnelConfigForWrite({
        ...writeConfig(),
        steps: [step("first", ""), writeConfig().steps[1]],
      }),
    ).toThrow("funnel_filter_dsl_invalid:0");
    expect(() =>
      validateFunnelConfigForWrite({
        ...writeConfig(),
        steps: [step("first", "not a filter"), writeConfig().steps[1]],
      }),
    ).toThrow("funnel_filter_dsl_invalid:0");
    expect(() =>
      validateFunnelConfigForWrite({
        ...writeConfig(),
        conversionWindowMs: 1,
      }),
    ).toThrow("session_funnel_conversion_window_must_be_null");

    const highBindingDsl = Array.from(
      { length: 10 },
      (_, index) => `page.path eq "/candidate-${index}"`,
    ).join(" AND ");
    const highBindingConfig = writeConfig({
      steps: Array.from({ length: MAX_FUNNEL_STEPS }, (_, index) =>
        step(`step-${index}`, highBindingDsl),
      ),
    });
    expect(estimateFunnelSqlBindingCount(highBindingConfig)).toBeGreaterThan(
      100 - 6,
    );
    expect(() => validateFunnelConfigForWrite(highBindingConfig)).toThrow(
      "funnel_sql_binding_limit_exceeded",
    );
  });

  it("excludes display name while including scope, window, IDs and filter semantics", async () => {
    const first = {
      filterDslVersion: 1 as const,
      progressionScope: "session" as const,
      conversionWindowMs: null,
      steps: [
        { ...step("first", 'page.path eq "/pricing"'), name: "Original" },
        step("second", 'event.name eq "signup"'),
      ],
    };
    const renamed = {
      ...first,
      steps: [{ ...first.steps[0], name: "Renamed" }, first.steps[1]],
    };
    const changedId = {
      ...first,
      steps: [{ ...first.steps[0], id: "different" }, first.steps[1]],
    };

    await expect(funnelSemanticFingerprint(first)).resolves.toBe(
      await funnelSemanticFingerprint(renamed),
    );
    await expect(funnelSemanticFingerprint(first)).resolves.not.toBe(
      await funnelSemanticFingerprint(changedId),
    );
    await expect(
      funnelSemanticFingerprint({
        ...first,
        progressionScope: "visitor",
        conversionWindowMs: 60_000,
      }),
    ).resolves.not.toBe(await funnelSemanticFingerprint(first));
  });
});
