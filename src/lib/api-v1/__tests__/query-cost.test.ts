import { describe, expect, it } from "vitest";

import {
  calculateQueryCost,
  defaultQueryCostPolicy,
} from "@/lib/edge/analytics/application/cost";

describe("calculateQueryCost", () => {
  it("is deterministic and increases with range, fanout, and provider weight", () => {
    const base = calculateQueryCost({ rangeMs: 86_400_000 });
    const larger = calculateQueryCost({
      rangeMs: 30 * 86_400_000,
      siteCount: 3,
      metricCount: 4,
      dimensionCardinality: 100,
      batchFanout: 4,
      provider: "mixed",
    });
    expect(base).toBe(1);
    expect(larger).toBeGreaterThan(base);
    expect(larger).toBe(
      calculateQueryCost({
        rangeMs: 30 * 86_400_000,
        siteCount: 3,
        metricCount: 4,
        dimensionCardinality: 100,
        batchFanout: 4,
        provider: "mixed",
      }),
    );
  });

  it("fails closed and caps expensive requests", () => {
    expect(calculateQueryCost({ rangeMs: -1 })).toBe(
      defaultQueryCostPolicy.maxCost,
    );
    expect(calculateQueryCost({ rangeMs: Number.POSITIVE_INFINITY })).toBe(
      defaultQueryCostPolicy.maxCost,
    );
    expect(
      calculateQueryCost({
        rangeMs: 365 * 86_400_000,
        siteCount: 100,
        metricCount: 100,
        dimensionCardinality: 100_000,
        batchFanout: 100,
      }),
    ).toBe(defaultQueryCostPolicy.maxCost);
  });

  it("weights entity scopes and raw-source plans above event scope", () => {
    const event = calculateQueryCost({ rangeMs: 86_400_000, scope: "event" });
    const session = calculateQueryCost({
      rangeMs: 86_400_000,
      scope: "session",
      entityAlgebraComplexity: 2,
    });
    const visitor = calculateQueryCost({
      rangeMs: 86_400_000,
      scope: "visitor",
      entityAlgebraComplexity: 2,
      requiredSourceCount: 2,
      requiresRawSource: true,
    });

    expect(event).toBeLessThan(session);
    expect(session).toBeLessThan(visitor);
  });

  it("charges Funnel structural dimensions and worst-case planning", () => {
    const ordinary = calculateQueryCost({
      rangeMs: 86_400_000,
      provider: "d1",
    });
    const tenStepWorstCase = calculateQueryCost({
      rangeMs: 86_400_000,
      provider: "d1",
      funnelStepCount: 10,
      funnelCteCount: 61,
      funnelSqlLength: 1_000_000,
      funnelBindingCount: 100,
      funnelWorstCase: true,
    });
    expect(tenStepWorstCase).toBeGreaterThan(ordinary);
    expect(
      calculateQueryCost({
        rangeMs: 86_400_000,
        provider: "d1",
        funnelStepCount: 10,
        funnelCteCount: 61,
        funnelSqlLength: 1_000_000,
        funnelBindingCount: 100,
        funnelWorstCase: true,
      }),
    ).toBe(tenStepWorstCase);
  });
});
