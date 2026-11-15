import { describe, expect, it } from "vitest";

import type { C01FixtureMeasurement } from "./analytics-fixture-cost-budgets";
import {
  assertJourneyEventFieldsCostBudget,
  assertJourneyEventFieldsCostGrowth,
} from "./journey-event-fields-cost-budgets";
import { buildJourneyEventFieldsCostFixture } from "./journey-event-fields-cost-fixture";
import { JOURNEY_EVENT_FIELDS_COST_SCENARIOS } from "./journey-event-fields-cost-scenarios";
import { COST_TIME } from "./referrers-cost-harness";

const scenario = JOURNEY_EVENT_FIELDS_COST_SCENARIOS[0]!;
function measurement(visits = 2000): C01FixtureMeasurement {
  return {
    engine: "local-miniflare",
    visits,
    seedFingerprint: buildJourneyEventFieldsCostFixture(visits).fingerprint,
    scenario,
    time: COST_TIME,
    cost: {
      rowsRead: visits === 2000 ? 28361 : 141557,
      rowsWritten: 0,
      statements: 1,
    },
  };
}

describe("independent journey/fields fixture budget validation", () => {
  it("validates the measured Retention pair and stable request key ordering", () => {
    const actual = measurement();
    expect(
      assertJourneyEventFieldsCostBudget({
        ...actual,
        scenario: { ...scenario, parameters: { ...scenario.parameters } },
      }).actualRowsRead,
    ).toBe(28361);
    expect(
      assertJourneyEventFieldsCostGrowth(actual, measurement(10000))
        .actualGrowth,
    ).toBeLessThan(7);
  });
  it("rejects unsupported engines, fixture/request drift, missing metadata and writes", () => {
    const actual = measurement();
    expect(
      assertJourneyEventFieldsCostBudget({
        ...actual,
        engine: "remote-cloudflare-d1",
      }),
    ).toMatchObject({
      baselineEngine: "local-miniflare",
      remoteBeforeAvailable: false,
    });
    expect(() =>
      assertJourneyEventFieldsCostBudget({
        ...actual,
        seedFingerprint: "other",
      }),
    ).toThrow("seed_changed");
    expect(() =>
      assertJourneyEventFieldsCostBudget({
        ...actual,
        scenario: { ...scenario, parameters: { granularity: "week" } },
      }),
    ).toThrow("request_changed");
    for (const rowsRead of [
      null,
      undefined,
      NaN,
      Infinity,
      Number.MAX_SAFE_INTEGER + 1,
      -1,
      0,
    ])
      expect(() =>
        assertJourneyEventFieldsCostBudget({
          ...actual,
          cost: { ...actual.cost, rowsRead },
        }),
      ).toThrow("metadata_unavailable");
    expect(() =>
      assertJourneyEventFieldsCostBudget({
        ...actual,
        cost: { ...actual.cost, rowsWritten: 1 },
      }),
    ).toThrow("writes");
    expect(() =>
      assertJourneyEventFieldsCostBudget({
        ...actual,
        cost: { ...actual.cost, statements: 2 },
      }),
    ).toThrow("statements");
    expect(() =>
      assertJourneyEventFieldsCostBudget({
        ...actual,
        cost: { ...actual.cost, rowsRead: 1000000 },
      }),
    ).toThrow("reads");
  });
  it("rejects malformed requests and incompatible or excessive growth", () => {
    const actual = measurement();
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(() =>
      assertJourneyEventFieldsCostBudget({
        ...actual,
        scenario: { ...scenario, parameters: cyclic },
      }),
    ).toThrow("not_json");
    expect(() => assertJourneyEventFieldsCostGrowth(actual, actual)).toThrow(
      "inputs_incompatible",
    );
    expect(() =>
      assertJourneyEventFieldsCostGrowth(
        { ...actual, cost: { ...actual.cost, rowsRead: 1 } },
        measurement(10000),
      ),
    ).toThrow("fixture_growth");
  });
});
