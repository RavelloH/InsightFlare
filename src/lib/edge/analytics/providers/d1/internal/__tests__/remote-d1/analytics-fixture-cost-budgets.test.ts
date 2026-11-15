import { describe, expect, it } from "vitest";

import { ANALYTICS_COST_SCENARIOS } from "./analytics-cost-scenarios";
import {
  assertC01AnalyticsFixtureBudget,
  assertC01AnalyticsFixtureGrowth,
} from "./analytics-fixture-cost-budgets";
import { COST_TIME } from "./referrers-cost-harness";

const pages = ANALYTICS_COST_SCENARIOS.find(
  (scenario) => scenario.name === "pages aggregate / no filter",
)!;
const overview = ANALYTICS_COST_SCENARIOS.find(
  (scenario) => scenario.name === "overview summary / no filter",
)!;
const seed2000 =
  "09fa29a15432fa8e26e00c02f1615a0f678d2345a7c2e04f3c85148f2e076a14";
const seed10000 =
  "3eca71718f7fa7873c5c3348584528221206594ecac1490d751ab9a654f7f998";
const measuredPages = {
  engine: "local-miniflare" as const,
  visits: 2000,
  seedFingerprint: seed2000,
  scenario: pages,
  time: COST_TIME,
  cost: { rowsRead: 10872, rowsWritten: 0, statements: 1 },
};
describe("C01 fixed-fixture cost budgets", () => {
  it("accepts actual final paired-scale measurements and rejects the recorded quadratic before cost", () => {
    const larger = {
      engine: "local-miniflare" as const,
      visits: 10000,
      seedFingerprint: seed10000,
      scenario: pages,
      time: COST_TIME,
      cost: { rowsRead: 54304, rowsWritten: 0, statements: 1 },
    };
    expect(() =>
      assertC01AnalyticsFixtureGrowth(measuredPages, larger),
    ).not.toThrow();
    expect(() =>
      assertC01AnalyticsFixtureGrowth(
        { ...measuredPages, cost: { ...measuredPages.cost, rowsRead: 1000 } },
        larger,
      ),
    ).toThrow(/c01_fixture_growth:/);
    // Original same-fixture remote 2k Overview summary no-filter observation.
    expect(() =>
      assertC01AnalyticsFixtureBudget({
        ...measuredPages,
        scenario: overview,
        cost: { rowsRead: 5374887, rowsWritten: 0, statements: 1 },
      }),
    ).toThrow(/c01_fixture_rows_read/);
  });
  it("rejects writes, unavailable metadata, and extra statements rather than reporting budget success", () => {
    expect(() =>
      assertC01AnalyticsFixtureBudget({
        ...measuredPages,
        cost: { ...measuredPages.cost, rowsWritten: 1 },
      }),
    ).toThrow(/c01_fixture_writes/);
    expect(() =>
      assertC01AnalyticsFixtureBudget({
        ...measuredPages,
        cost: { ...measuredPages.cost, rowsRead: null },
      }),
    ).toThrow(/c01_fixture_metadata_unavailable/);
    expect(() =>
      assertC01AnalyticsFixtureBudget({
        ...measuredPages,
        cost: { ...measuredPages.cost, statements: 2 },
      }),
    ).toThrow(/c01_fixture_statements/);
  });
  it("uses canonical object order and rejects non-JSON requests and unsafe cost numbers", () => {
    const reordered = {
      ...pages,
      parameters: Object.fromEntries(
        Object.entries(pages.parameters).reverse(),
      ),
    };
    expect(() =>
      assertC01AnalyticsFixtureBudget({
        ...measuredPages,
        scenario: reordered,
      }),
    ).not.toThrow();
    for (const rowsRead of [
      NaN,
      Infinity,
      Number.MAX_SAFE_INTEGER + 1,
      1.5,
      -1,
    ])
      expect(() =>
        assertC01AnalyticsFixtureBudget({
          ...measuredPages,
          cost: { ...measuredPages.cost, rowsRead },
        }),
      ).toThrow(/c01_fixture_metadata_unavailable/);
    expect(() =>
      assertC01AnalyticsFixtureBudget({
        ...measuredPages,
        scenario: { ...pages, parameters: { value: NaN } },
      }),
    ).toThrow(/c01_fixture_request_not_json/);
    expect(() =>
      assertC01AnalyticsFixtureBudget({
        ...measuredPages,
        engine: "remote-cloudflare-d1",
        cost: { ...measuredPages.cost, rowsRead: 12000 },
      }),
    ).toThrow(/c01_fixture_original_remote_ceiling/);
  });
  it("refuses changed seeds, requests, scales, and mismatched growth workloads", () => {
    expect(() =>
      assertC01AnalyticsFixtureBudget({
        ...measuredPages,
        seedFingerprint: "different-fixture",
      }),
    ).toThrow(/c01_fixture_seed_changed/);
    expect(() =>
      assertC01AnalyticsFixtureBudget({
        ...measuredPages,
        scenario: {
          ...pages,
          parameters: { limit: 21, includeDetails: false },
        },
      }),
    ).toThrow(/c01_fixture_request_changed/);
    expect(() =>
      assertC01AnalyticsFixtureBudget({ ...measuredPages, visits: 5000 }),
    ).toThrow(/c01_fixture_scale_unsupported/);
    expect(() =>
      assertC01AnalyticsFixtureBudget({
        ...measuredPages,
        time: {
          ...COST_TIME,
          capturedAtMs: 0 as typeof COST_TIME.capturedAtMs,
        },
      }),
    ).toThrow(/c01_fixture_request_changed/);
    expect(() =>
      assertC01AnalyticsFixtureGrowth(measuredPages, {
        engine: "local-miniflare" as const,
        visits: 10000,
        seedFingerprint: seed10000,
        scenario: overview,
        time: COST_TIME,
        cost: { rowsRead: 252054, rowsWritten: 0, statements: 1 },
      }),
    ).toThrow(/c01_fixture_growth_inputs_incompatible/);
  });
});
