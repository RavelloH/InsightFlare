import { describe, expect, it } from "vitest";

import { safeFilterShape } from "@/lib/edge/analytics-engine/filter-shape";
import { HotspotCollector } from "@/lib/edge/analytics-engine/hotspot-collector";
import { v2BooleanFlag } from "@/lib/edge/analytics-engine/invocation-schema-v2";
import { encodeInvocationMetricsPointV2 } from "@/lib/edge/analytics-engine/invocation-writer";
import { createInvocationLogger } from "@/lib/edge/observability/logger";
import type {
  FilterDocument,
  FilterExpression,
} from "@/lib/filter-contract/filters";

function shape(kind: "and" | "or" | "not", country: string) {
  const geo: FilterExpression = {
    kind: "condition",
    target: { kind: "field", field: "geo.country" as never },
    operator: "eq",
    value: country,
  };
  const duration: FilterExpression = {
    kind: "condition",
    target: { kind: "field", field: "session.durationMS" as never },
    operator: "gte",
    value: 1000,
  };
  const root: FilterExpression =
    kind === "not"
      ? { kind: "not", child: { kind: "and", children: [geo, duration] } }
      : { kind, children: [geo, duration] };
  return safeFilterShape({ version: 1, root } satisfies FilterDocument);
}
function point(collector: HotspotCollector, statements: number) {
  const logger = createInvocationLogger({
    source: "worker",
    trigger: "request",
  });
  logger.setPerformance({ d1Statements: statements });
  return encodeInvocationMetricsPointV2(
    logger.snapshot(),
    collector.snapshot(),
  );
}

describe("review R1 F1: distinct safe filter shapes must not share costs", () => {
  it("splits same ID/Variant by distinct Boolean structure and attributes the expensive shape", () => {
    const c = new HotspotCollector();
    const id = { id: "analytics.overview", variant: "raw.filtered" as const };
    const and = shape("and", "US");
    const or = shape("or", "JP");
    c.record({
      identity: id,
      filter: and,
      rowsRead: 10,
      sqlEngineMs: 1,
      apiWallMs: 1,
    });
    c.record({
      identity: id,
      filter: or,
      rowsRead: 100_000,
      sqlEngineMs: 50,
      apiWallMs: 90,
    });
    const groups = c.snapshot().queries;
    expect(groups).toHaveLength(2);
    expect(groups.find((q) => q.filter?.code === and.code)?.rowsRead).toBe(10);
    expect(groups.find((q) => q.filter?.code === or.code)?.rowsRead).toBe(
      100_000,
    );
    const p = point(c, 2);
    expect(p.blobs[15]).toBe(or.code);
    expect(p.doubles[15]).toBe(100_000);
    const details = JSON.parse(p.blobs[18]);
    expect(details.queries).toHaveLength(2);
    expect(
      details.queries.some(
        (q: { filterShape: string; rowsRead: number }) =>
          q.filterShape === or.code && q.rowsRead === 100_000,
      ),
    ).toBe(true);
  });

  it("marks the Invocation-level filter ambiguous when none and filtered scopes coexist", () => {
    const c = new HotspotCollector();
    c.setFilter(safeFilterShape({ version: 1, root: null }));
    c.setFilter(shape("and", "JP"));
    expect(c.snapshot().filter).toBeUndefined();
    expect(c.snapshot().filterAmbiguous).toBe(true);
    const p = point(c, 0);
    expect(JSON.parse(p.blobs[18]).coverage.filter).toBe("mixed");
  });

  it("never combines separate scope/field-group shapes with identical compact code", () => {
    const a = shape("and", "US");
    const b = { ...a, fieldGroups: ["other"] as const };
    const c = new HotspotCollector();
    c.record({
      identity: { id: "analytics.overview", variant: "raw.filtered" },
      filter: a,
      rowsRead: 3,
    });
    c.record({
      identity: { id: "analytics.overview", variant: "raw.filtered" },
      filter: b,
      rowsRead: 900,
    });
    expect(c.snapshot().queries).toHaveLength(2);
  });
});

describe("review R1 F2: fixed AE shape code is Boolean-aware", () => {
  it("distinguishes AND, OR and NOT and ignores user values", () => {
    const and = shape("and", "US");
    const and2 = shape("and", "JP");
    const or = shape("or", "US");
    const not = shape("not", "US");
    expect(and.code).toBe(and2.code);
    expect(and.code).not.toBe(or.code);
    expect(or.code).not.toBe(not.code);
    // Even when both trees use AND and OR, root direction affects planning.
    const eq = {
      kind: "condition" as const,
      target: { kind: "field" as const, field: "geo.country" as never },
      operator: "eq" as const,
      value: "US",
    };
    const range = {
      kind: "condition" as const,
      target: { kind: "field" as const, field: "session.durationMS" as never },
      operator: "gte" as const,
      value: 1000,
    };
    const outerAnd = safeFilterShape({
      version: 1,
      root: {
        kind: "and",
        children: [{ kind: "or", children: [eq, range] }, eq],
      },
    });
    const outerOr = safeFilterShape({
      version: 1,
      root: {
        kind: "or",
        children: [{ kind: "and", children: [eq, range] }, eq],
      },
    });
    expect(outerAnd.booleanGroups).toEqual(outerOr.booleanGroups);
    expect(outerAnd.conditionsBucket).toBe(outerOr.conditionsBucket);
    expect(outerAnd.maxDepthBucket).toBe(outerOr.maxDepthBucket);
    expect(outerAnd.code).not.toBe(outerOr.code);
    for (const v of [and, and2, or, not, outerAnd, outerOr]) {
      expect(v.code.length).toBeLessThan(64);
      expect(JSON.stringify(v)).not.toContain("country");
      expect(JSON.stringify(v)).not.toContain("1000");
    }
  });
});

describe("review R1 F4: never rank incomparable API wait and batch SQL engine", () => {
  it("suppresses Hot API rank for mixed measured wall and missing per-statement batch wait", () => {
    const c = new HotspotCollector();
    c.record({
      identity: { id: "analytics.overview", variant: "raw.filtered" },
      apiWallMs: 4,
      sqlEngineMs: 1,
      rowsRead: 5,
    });
    c.record({
      identity: { id: "analytics.pages", variant: "raw.filtered" },
      batchSharedWall: true,
      sqlEngineMs: 90,
      rowsRead: 5_000,
    });
    c.recordBatchApiWall(120);
    const p = point(c, 2);
    expect(p.blobs[13]).toBe("");
    expect(p.doubles[13]).toBe(0);
    expect(v2BooleanFlag(p.doubles[18], "hotQueryPresent")).toBe(false);
    expect(JSON.parse(p.blobs[18]).hotBasis).toBe("unavailable");
    expect(p.blobs[16]).toBe("analytics.pages");
  });

  it("distinguishes unobserved batch API wait from measured zero via a fixed flag", () => {
    const batch = new HotspotCollector();
    batch.record({
      identity: { id: "analytics.pages", variant: "rollup" },
      batchSharedWall: true,
      sqlEngineMs: 25,
      rowsRead: 400,
    });
    batch.recordBatchApiWall(30);
    const b = point(batch, 1);
    expect(b.blobs[13]).toBe("analytics.pages");
    expect(b.doubles[13]).toBe(0);
    expect(v2BooleanFlag(b.doubles[18], "hotQueryApiWallPresent")).toBe(false);

    const zero = new HotspotCollector();
    zero.record({
      identity: { id: "analytics.pages", variant: "rollup" },
      apiWallMs: 0,
      sqlEngineMs: 0,
      rowsRead: 0,
    });
    const z = point(zero, 1);
    expect(z.blobs[13]).toBe("analytics.pages");
    expect(z.doubles[13]).toBe(0);
    expect(v2BooleanFlag(z.doubles[18], "hotQueryApiWallPresent")).toBe(true);
  });
});
