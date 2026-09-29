import { describe, expect, it } from "vitest";

import { COMPARISON_METRIC_KEYS } from "@/lib/edge/analytics/contract/types";
import {
  COMPARISON_TO_SEMANTIC_METRIC,
  SEMANTIC_METRIC_IDS,
  semanticMetric,
  semanticMetricCatalog,
  type SemanticMetricDefinition,
  validateMetricCatalog,
} from "@/lib/edge/analytics/engine/semantic/metrics";

describe("canonical semantic metrics", () => {
  it("registers every canonical metric with the intended visibility and measure", () => {
    expect(semanticMetricCatalog.map(({ id }) => id)).toEqual(
      [...SEMANTIC_METRIC_IDS].sort(),
    );
    expect(Object.keys(COMPARISON_TO_SEMANTIC_METRIC).sort()).toEqual(
      [...COMPARISON_METRIC_KEYS].sort(),
    );
    expect(
      Object.values(COMPARISON_TO_SEMANTIC_METRIC).every((id) =>
        SEMANTIC_METRIC_IDS.includes(id),
      ),
    ).toBe(true);
    expect(COMPARISON_TO_SEMANTIC_METRIC).toEqual(
      Object.fromEntries(COMPARISON_METRIC_KEYS.map((key) => [key, key])),
    );
    expect(semanticMetric("views")).toMatchObject({
      kind: "atomic",
      measure: { kind: "entity-count", entity: "page" },
      timeGroupingPolicy: "occurrence",
    });
    expect(semanticMetric("events")).toMatchObject({
      kind: "atomic",
      measure: { kind: "entity-count", entity: "event" },
      timeGroupingPolicy: "occurrence",
    });
    expect(semanticMetric("totalDurationMs")).toMatchObject({
      visibility: "internal",
      valueType: { kind: "scalar", scalar: "number", unit: "ms" },
      measure: {
        kind: "valid-attribute-sum",
        entity: "page",
        attribute: "page.durationMs",
        valid: "non-negative",
        empty: 0,
      },
      timeGroupingPolicy: "occurrence",
    });
    expect(semanticMetric("durationViews")).toMatchObject({
      visibility: "internal",
      measure: {
        kind: "valid-attribute-count",
        attribute: "page.durationMs",
        valid: "non-negative",
      },
    });
    expect(semanticMetric("sessions")).toMatchObject({
      timeGroupingPolicy: "entity-first-observation",
    });
    expect(semanticMetric("visitors")).toMatchObject({
      timeGroupingPolicy: "distinct-entity-per-bucket",
    });
    expect(validateMetricCatalog()).toEqual([]);
  });

  it("keeps derived formulas data-only and nulls undefined ratios", () => {
    expect(semanticMetric("avgDurationMs")).toMatchObject({
      kind: "derived",
      dependencies: ["totalDurationMs", "sessions"],
      formula: {
        kind: "round",
        input: {
          kind: "divide",
          zeroDenominator: "null",
          left: { kind: "metric-reference", metric: "totalDurationMs" },
          right: { kind: "metric-reference", metric: "sessions" },
        },
      },
    });
    expect(semanticMetric("bounceRate")).toMatchObject({
      valueType: { kind: "scalar", scalar: "number", unit: "ratio" },
      formula: { kind: "divide", zeroDenominator: "null" },
    });
    expect(semanticMetric("viewsPerSession")).toMatchObject({
      formula: { kind: "divide", zeroDenominator: "null" },
    });

    const serialized = JSON.parse(
      JSON.stringify(semanticMetricCatalog),
    ) as unknown;
    expect(serialized).toEqual(semanticMetricCatalog);
    expect(
      semanticMetricCatalog.some((metric) =>
        JSON.stringify(metric).includes("function"),
      ),
    ).toBe(false);
  });

  it("rejects missing, duplicate, undeclared, and cyclic metric dependencies", () => {
    const views = semanticMetric("views")!;
    const sessions = semanticMetric("sessions")!;
    const bounceRate = semanticMetric("bounceRate")!;
    if (views.kind !== "atomic" || sessions.kind !== "atomic") {
      throw new Error("expected_atomic_metric_fixture");
    }
    if (bounceRate.kind !== "derived") {
      throw new Error("expected_derived_metric_fixture");
    }
    const invalid: readonly SemanticMetricDefinition[] = [
      views,
      sessions,
      {
        ...bounceRate,
        dependencies: ["sessions", "sessions"],
        formula: {
          kind: "divide",
          left: { kind: "metric-reference", metric: "views" },
          right: { kind: "metric-reference", metric: "sessions" },
          zeroDenominator: "null",
        },
      },
    ];
    const invalidIssues = validateMetricCatalog(invalid);
    expect(invalidIssues.map(({ code }) => code)).toContain(
      "duplicate-dependency",
    );
    expect(invalidIssues.map(({ code }) => code)).toContain(
      "undeclared-formula-dependency",
    );
    expect(invalidIssues.map(({ code }) => code)).toContain(
      "missing-dependency",
    );

    const cycle: readonly SemanticMetricDefinition[] = [
      {
        id: "views",
        kind: "derived",
        visibility: "public",
        valueType: views.valueType,
        dependencies: ["sessions"],
        formula: {
          kind: "metric-reference",
          metric: "sessions",
        },
      },
      {
        id: "sessions",
        kind: "derived",
        visibility: "public",
        valueType: sessions.valueType,
        dependencies: ["views"],
        formula: {
          kind: "metric-reference",
          metric: "views",
        },
      },
    ];
    expect(validateMetricCatalog(cycle).map(({ code }) => code)).toContain(
      "dependency-cycle",
    );
  });
});
