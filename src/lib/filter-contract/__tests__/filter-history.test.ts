import { describe, expect, it } from "vitest";

import {
  analyticsFilterRegistry,
  analyzeFilterDocument,
  analyzeFilterHistory,
  analyzeFilterPopulation,
  parseFilterDsl,
} from "@/lib/filter-contract";
import type { AnalyzedFilterDocument } from "@/lib/filter-contract/filter-semantics";
import type {
  FilterCondition,
  FilterExpression,
} from "@/lib/filter-contract/filters";

const candidate = { startMs: 80_000, endExclusiveMs: 90_000 };
const capturedAtMs = 100_000;

function analyzed(source: string) {
  const document = parseFilterDsl(source, analyticsFilterRegistry);
  return analyzeFilterDocument(document, analyticsFilterRegistry);
}

function history(source: string) {
  return analyzeFilterHistory(
    analyzed(source),
    candidate,
    capturedAtMs,
    "visitor",
  );
}

function population(source: string) {
  return analyzeFilterPopulation(analyzed(source), candidate, capturedAtMs);
}

function rawTimeCondition(
  operator: string,
  value?: unknown,
  targetMember = "time",
): FilterCondition {
  return {
    kind: "condition",
    target: {
      kind: "member",
      object: { kind: "context-root", context: "current" },
      member: targetMember,
    },
    operator: operator as FilterCondition["operator"],
    ...(value !== undefined
      ? { value: value as FilterCondition["value"] }
      : {}),
  };
}

function populationForRawRoot(
  root: FilterExpression,
  now = capturedAtMs,
  markAllConditionsAsTemporal = false,
): ReturnType<typeof analyzeFilterPopulation> {
  const conditions = new WeakMap<object, { temporalPredicate: boolean }>();
  const visit = (expression: FilterExpression): void => {
    if (expression.kind === "condition") {
      const isTime =
        expression.target.kind === "member" &&
        expression.target.object.kind === "context-root" &&
        expression.target.object.context === "current" &&
        expression.target.member === "time";
      if (isTime || markAllConditionsAsTemporal)
        conditions.set(expression, { temporalPredicate: true });
    } else if (expression.kind === "not") {
      visit(expression.child);
    } else {
      expression.children.forEach(visit);
    }
  };
  visit(root);
  const document = { version: 1, root };
  return analyzeFilterPopulation(
    { document, conditions } as unknown as AnalyzedFilterDocument,
    candidate,
    now,
  );
}

describe("Filter history and population planning", () => {
  it("keeps candidate-only reducers inside the report window", () => {
    expect(history("count(event) gte 1")).toEqual({
      kind: "candidate-only",
    });
    expect(history("countDistinct(bucket(page, 1d)) gte 1")).toEqual({
      kind: "candidate-only",
    });
    expect(history("count(periods(event, 1w)) gte 1")).toEqual({
      kind: "candidate-only",
    });
  });

  it("merges a bounded history target with candidate-only conditions", () => {
    expect(
      history(
        "count(window(event, @range.start, [0ms, 10ms])) gte 1 AND count(event) gte 1",
      ),
    ).toEqual({ kind: "bounded", startMs: 80_000, endExclusiveMs: 80_011 });
  });

  it("requires full history for positional reducers and entity anchors", () => {
    expect(history("first(event) exists")).toEqual({
      kind: "full-history",
    });
    expect(history("last(page) exists")).toEqual({
      kind: "full-history",
    });
    expect(
      history("count(window(event, first(event), [0d, 7d])) gte 1"),
    ).toEqual({
      kind: "full-history",
    });
  });

  it("propagates positional history through payload projection and wrappers", () => {
    expect(
      history(
        'nth(event { event.name eq "purchase" }.payload("/amount"), 3) eq 3',
      ),
    ).toEqual({
      kind: "full-history",
    });
    expect(history("first(periods(event, 1w)) exists")).toEqual({
      kind: "full-history",
    });
  });

  it("does not turn scope-level time into evaluator history", () => {
    expect(history("time gte @now-30d AND visitor.sessions gte 3")).toEqual({
      kind: "candidate-only",
    });
  });

  it("derives a bounded historical population range from time predicates", () => {
    expect(population("time gte @now-30d")).toEqual({
      kind: "bounded",
      startMs: 100_000 - 30 * 86_400_000,
      endExclusiveMs: 100_001,
    });
    expect(population("time between [@now-90d, @now-30d]")).toEqual({
      kind: "bounded",
      startMs: 100_000 - 90 * 86_400_000,
      endExclusiveMs: 100_000 - 30 * 86_400_000 + 1,
    });
    expect(population("time eq @range.start")).toEqual({
      kind: "bounded",
      startMs: 80_000,
      endExclusiveMs: 80_001,
    });
  });

  it("requires retained full history for upper-only population bounds", () => {
    expect(population("time lt @now-30d")).toEqual({
      kind: "full-history",
      endExclusiveMs: 100_000 - 30 * 86_400_000,
    });
    expect(population("time lte @range.end")).toEqual({
      kind: "full-history",
      endExclusiveMs: 90_001,
    });
  });

  it("returns an empty population for disjoint top-level time bounds", () => {
    expect(population("time gte @now-10d AND time lt @now-20d")).toEqual({
      kind: "empty",
    });
    expect(population("time gte @now+1ms")).toEqual({ kind: "empty" });
    expect(population("time between [@now+1ms, @now+2ms]")).toEqual({
      kind: "empty",
    });
  });

  it("keeps population selection absent when the filter has no time", () => {
    expect(population('event.name eq "purchase"')).toEqual({ kind: "none" });
    expect(history("")).toEqual({ kind: "candidate-only" });
    expect(population("")).toEqual({ kind: "none" });
  });

  it("resolves date literals, elapsed anchors and every range endpoint", () => {
    expect(population('time eq "1970-01-01T00:01:30Z"')).toEqual({
      kind: "bounded",
      startMs: 90_000,
      endExclusiveMs: 90_001,
    });
    expect(population("time gt @range.start")).toEqual({
      kind: "bounded",
      startMs: 80_001,
      endExclusiveMs: capturedAtMs + 1,
    });
    expect(population("time lte @range.start")).toEqual({
      kind: "full-history",
      endExclusiveMs: 80_001,
    });
    expect(population("time between [@range.start, @range.end]")).toEqual({
      kind: "bounded",
      startMs: 80_000,
      endExclusiveMs: 90_001,
    });
    expect(
      populationForRawRoot(
        rawTimeCondition("gte", {
          kind: "time-anchor",
          anchor: "now",
          offset: { kind: "duration", amount: -2, unit: "d" },
        }),
      ),
    ).toEqual({
      kind: "bounded",
      startMs: capturedAtMs - 2 * 86_400_000,
      endExclusiveMs: capturedAtMs + 1,
    });
  });

  it("conservatively handles malformed and unsupported temporal endpoints", () => {
    for (const [operator, value] of [
      ["gte", undefined],
      ["gte", null],
      ["gte", "not a date"],
      ["gte", { kind: "duration", amount: 1, unit: "d" }],
      [
        "gte",
        {
          kind: "time-anchor",
          anchor: "now",
          offset: { kind: "duration", amount: 1, unit: "mo" },
        },
      ],
      [
        "gte",
        {
          kind: "time-anchor",
          anchor: "now",
          offset: {
            kind: "duration",
            amount: Number.MAX_SAFE_INTEGER,
            unit: "ms",
          },
        },
      ],
      ["between", [80_000]],
      ["between", [80_000, Number.MAX_SAFE_INTEGER]],
      ["eq", Number.MAX_SAFE_INTEGER],
      ["gt", Number.MAX_SAFE_INTEGER],
      ["lte", Number.MAX_SAFE_INTEGER],
      ["contains", 80_000],
      ["neq", 80_000],
    ] as const) {
      expect(populationForRawRoot(rawTimeCondition(operator, value))).toEqual({
        kind: "full-history",
        endExclusiveMs: capturedAtMs + 1,
      });
    }
    expect(
      populationForRawRoot(
        rawTimeCondition("gte", 80_000),
        Number.MAX_SAFE_INTEGER,
      ),
    ).toEqual({
      kind: "full-history",
      endExclusiveMs: Number.MAX_SAFE_INTEGER + 1,
    });
    expect(
      populationForRawRoot(
        rawTimeCondition("gte", 80_000, "not-time"),
        capturedAtMs,
        true,
      ),
    ).toEqual({ kind: "full-history", endExclusiveMs: capturedAtMs + 1 });
  });

  it("treats time inside OR and NOT as requiring a conservative full scan", () => {
    const bounded = rawTimeCondition("gte", 80_000);
    const or = {
      kind: "or",
      children: [
        bounded,
        {
          kind: "condition",
          target: { kind: "field", field: "page.path" },
          operator: "exists",
        },
      ],
    } as FilterExpression;
    const not = { kind: "not", child: bounded } as FilterExpression;
    expect(populationForRawRoot(or)).toEqual({
      kind: "full-history",
      endExclusiveMs: capturedAtMs + 1,
    });
    expect(populationForRawRoot(not)).toEqual({
      kind: "full-history",
      endExclusiveMs: capturedAtMs + 1,
    });
  });

  it("keeps bucket values opaque while carrying window and relation history", () => {
    expect(history("countDistinct(bucket(page, 1d)) gte 1")).toEqual({
      kind: "candidate-only",
    });
    expect(
      history("first(window(event, @range.start, [-10d, 7d])) exists"),
    ).toEqual({
      kind: "bounded",
      startMs: 80_000 - 10 * 86_400_000,
      endExclusiveMs: capturedAtMs + 1,
    });
    expect(history("first(window(event, @now, [0d, -7d])) exists")).toEqual({
      kind: "candidate-only",
    });
    expect(
      history(
        "count(window(event, @range.start, [0d, 9007199254740991ms])) gte 1",
      ),
    ).toEqual({ kind: "full-history" });
    expect(
      history("count(window(event, @now+9007199254740991ms, [0d, 1d])) gte 1"),
    ).toEqual({ kind: "candidate-only" });
    expect(
      history(
        "sequence([window(event, @range.start, [0d, 1d]), window(page, @range.end, [-1d, 0d])]) exists",
      ),
    ).toMatchObject({ kind: "bounded", startMs: 90_000 - 86_400_000 });
    expect(history("adjacent(sequence([event, page])) exists")).toEqual({
      kind: "full-history",
    });
  });

  it("limits without exclusions to a bounded sequence domain", () => {
    const boundedSequence =
      "sequence([window(event, @range.start, [0d, 1d]), window(event, @range.end, [-1d, 0d])])";
    expect(history(`without(${boundedSequence}, event) exists`)).toMatchObject({
      kind: "bounded",
      startMs: 90_000 - 86_400_000,
    });
    expect(
      history(
        `without(${boundedSequence}, window(event, first(event), [0d, 7d])) exists`,
      ),
    ).toEqual({ kind: "full-history" });
    expect(
      history(
        `without(${boundedSequence}, window(event, @now, [-30d, 0d])) exists`,
      ),
    ).toMatchObject({ kind: "bounded" });
    expect(history(`without(sequence([event, page]), event) exists`)).toEqual({
      kind: "full-history",
    });
  });
});
