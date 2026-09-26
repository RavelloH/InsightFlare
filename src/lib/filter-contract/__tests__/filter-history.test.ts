import { describe, expect, it } from "vitest";

import {
  analyticsFilterRegistry,
  analyzeFilterDocument,
  analyzeFilterHistory,
  parseFilterDsl,
} from "@/lib/filter-contract";
import type { AnalyzedFilterDocument } from "@/lib/filter-contract/filter-semantics";
import type {
  FilterCondition,
  FilterDocument,
} from "@/lib/filter-contract/filters";

const candidate = { startMs: 80_000, endExclusiveMs: 90_000 };

function history(
  source: string,
  scope: "event" | "session" | "visitor" = "visitor",
) {
  return analyzeFilterHistory(
    analyzeFilterDocument(
      parseFilterDsl(source, analyticsFilterRegistry),
      analyticsFilterRegistry,
    ),
    candidate,
    100_000,
    scope,
  );
}

function historyForUnvalidatedTimeCondition(
  operator: string,
  value: unknown,
  targetMember = "time",
) {
  const condition = {
    kind: "condition",
    target: {
      kind: "member",
      object: { kind: "context-root", context: "current" },
      member: targetMember,
    },
    operator,
    value,
  } as unknown as FilterCondition;
  const document = {
    version: 1,
    root: {
      kind: "condition",
      target: {
        kind: "reducer",
        reducer: "count",
        input: {
          kind: "selector",
          collection: { kind: "entity-root", entity: "event" },
          predicate: condition,
        },
      },
      operator: "gte",
      value: 1,
    },
  } as unknown as FilterDocument;
  const conditions = new WeakMap<object, { temporalPredicate: boolean }>([
    [condition, { temporalPredicate: true }],
  ]);
  const analysis = {
    document,
    conditions,
  } as unknown as AnalyzedFilterDocument;
  return analyzeFilterHistory(analysis, candidate, 100_000, "visitor");
}

function historyForUnvalidatedWindow(startOffsetUnit: string) {
  const condition = {
    kind: "condition",
    target: {
      kind: "member",
      object: { kind: "context-root", context: "current" },
      member: "time",
    },
    operator: "gte",
    value: 80_000,
  } as unknown as FilterCondition;
  const anchor = {
    kind: "selector",
    collection: { kind: "entity-root", entity: "event" },
    predicate: condition,
  };
  const document = {
    version: 1,
    root: {
      kind: "condition",
      target: {
        kind: "reducer",
        reducer: "count",
        input: {
          kind: "window",
          collection: { kind: "entity-root", entity: "event" },
          anchor,
          startOffset: { kind: "duration", amount: -1, unit: startOffsetUnit },
          endOffset: { kind: "duration", amount: 0, unit: "ms" },
        },
      },
      operator: "gte",
      value: 1,
    },
  } as unknown as FilterDocument;
  const conditions = new WeakMap<object, { temporalPredicate: boolean }>([
    [condition, { temporalPredicate: true }],
  ]);
  const analysis = {
    document,
    conditions,
  } as unknown as AnalyzedFilterDocument;
  return analyzeFilterHistory(analysis, candidate, 100_000, "visitor");
}

describe("Filter history requirements", () => {
  it("derives a historical window from selector time predicates without removing them", () => {
    const document = parseFilterDsl(
      'count(event { event.name eq "purchase" AND time gte @now-30s }) gte 1',
      analyticsFilterRegistry,
    );
    expect(
      analyzeFilterHistory(
        analyzeFilterDocument(document, analyticsFilterRegistry),
        candidate,
        100_000,
        "visitor",
      ),
    ).toEqual({
      kind: "bounded",
      startMs: 70_000,
      endExclusiveMs: 100_001,
    });
    expect(document.root).not.toBeNull();
  });

  it("uses the conservative union of multiple selector windows", () => {
    expect(
      history(
        'count(event { event.name eq "purchase" AND time gte @now-90d }) gte 5 AND count(event { event.name eq "refund" AND time gte @now-30d }) gte 1',
      ),
    ).toMatchObject({ kind: "bounded" });
  });

  it("requires complete history for unbounded positional reducers and relations", () => {
    expect(history("first(page).time exists")).toEqual({
      kind: "full-history",
    });
    expect(
      history(
        'sequence([event { event.name eq "signup" }, event { event.name eq "purchase" }]) exists',
      ),
    ).toEqual({ kind: "full-history" });
  });

  it("requires history for an upper-bounded selector even when the candidate is newer", () => {
    expect(history("count(event { time lt @now-30s }) gte 1")).toEqual({
      kind: "full-history",
    });
  });

  it("extends window history backward by a negative start offset from a bounded anchor", () => {
    expect(
      history(
        "count(window(event, first(event { time gte @now-30d }).time, [-10d, 0d])) gte 1",
      ),
    ).toEqual({
      kind: "bounded",
      startMs: 100_000 - 40 * 86_400_000,
      endExclusiveMs: 100_001,
    });
  });

  it("extends window history through its end offset from a bounded anchor", () => {
    expect(
      history(
        "count(window(event, first(event { time between [@now-10s, @now-5s] }).time, [0s, 10s])) gte 1",
      ),
    ).toEqual({
      kind: "bounded",
      startMs: 90_000,
      endExclusiveMs: 100_001,
    });
  });

  it("bounds positional reducers and sequences when their source selectors are bounded", () => {
    expect(
      history(
        'first(page { time gte @now-30d }).time exists AND sequence([event { event.name eq "signup" AND time gte @now-30d }, event { event.name eq "purchase" AND time gte @now-30d }]) exists',
      ),
    ).toMatchObject({ kind: "bounded", startMs: 100_000 - 30 * 86_400_000 });
  });

  it("propagates source history through buckets, periods, relations, and arithmetic", () => {
    const bucketed = history(
      "countDistinct(bucket(page { time gte @now-30s }.time, 1d)) gte 1",
    );
    expect(bucketed).toEqual({
      kind: "bounded",
      startMs: 70_000,
      endExclusiveMs: 100_001,
    });

    expect(
      history(
        'count(periods(event { event.name eq "shared_insight" AND time gte @now-30s }, 1w) { count(period.items) gte 1 }) gte 1',
      ),
    ).toEqual({
      kind: "bounded",
      startMs: 70_000,
      endExclusiveMs: 100_001,
    });
    expect(
      history(
        'without(sequence([event { event.name eq "signup" AND time gte @now-30s }, event { event.name eq "purchase" AND time gte @now-30s }]), event { event.name eq "cancel" AND time gte @now-30s }) exists',
      ),
    ).toEqual({
      kind: "bounded",
      startMs: 70_000,
      endExclusiveMs: 100_001,
    });
    expect(history("sub(first(page).time, first(event).time) exists")).toEqual({
      kind: "full-history",
    });
    expect(
      history("count(window(event, first(event).time, [0s, 10s])) gte 1"),
    ).toEqual({ kind: "full-history" });
  });

  it("uses the bounded sequence domain for without exclusions", () => {
    const sequence =
      'sequence([event { event.name eq "signup" AND time gte @now-30d }, event { event.name eq "purchase" AND time gte @now-30d }])';
    expect(
      history(`without(${sequence}, event { event.name eq "cancel" }) exists`),
    ).toEqual({
      kind: "bounded",
      startMs: 100_000 - 30 * 86_400_000,
      endExclusiveMs: 100_001,
    });
    expect(
      history(
        `without(${sequence}, event { event.name eq "cancel" AND time gte @now-90d }) exists`,
      ),
    ).toEqual({
      kind: "bounded",
      startMs: 100_000 - 90 * 86_400_000,
      endExclusiveMs: 100_001,
    });
  });

  it("keeps non-temporal and empty documents candidate-bound", () => {
    expect(history("")).toEqual({ kind: "candidate-only" });
    expect(history("count(event) gte 1")).toEqual({ kind: "candidate-only" });
  });

  it("resolves range anchors and single-point temporal selectors", () => {
    expect(
      history("count(event { time between [@range.start, @range.end] }) gte 1"),
    ).toEqual({ kind: "bounded", startMs: 80_000, endExclusiveMs: 90_001 });
    expect(history("count(event { time eq @now-10s }) gte 1")).toEqual({
      kind: "bounded",
      startMs: 90_000,
      endExclusiveMs: 90_001,
    });
  });

  it("handles datetime literals, ordered bounds, and selector existence", () => {
    expect(
      history('count(event { time eq "1970-01-01T00:00:01Z" }) gte 1'),
    ).toEqual({ kind: "bounded", startMs: 1_000, endExclusiveMs: 1_001 });
    expect(history("count(event { time gt @range.start }) gte 1")).toEqual({
      kind: "bounded",
      startMs: 80_001,
      endExclusiveMs: 100_001,
    });
    expect(history("count(event { time lt @now-5s }) gte 1")).toEqual({
      kind: "full-history",
    });
    expect(history("count(event { time lte @now-5s }) gte 1")).toEqual({
      kind: "full-history",
    });
    expect(
      history(
        'count(event { time between ["1970-01-01T00:00:01Z", @now] }) gte 1',
      ),
    ).toEqual({ kind: "bounded", startMs: 1_000, endExclusiveMs: 100_001 });
    expect(
      history("count(event { time gte @now-30s AND time lte @now-5s }) gte 1"),
    ).toEqual({ kind: "bounded", startMs: 70_000, endExclusiveMs: 95_001 });
    expect(history("count(event { time exists }) gte 1")).toEqual({
      kind: "full-history",
    });
    expect(history("count(event { time isNull }) gte 1")).toEqual({
      kind: "full-history",
    });
  });

  it("conservatively requires full history for upper-only and disjunctive time predicates", () => {
    expect(history("count(event { time lte @range.end }) gte 1")).toEqual({
      kind: "full-history",
    });
    expect(
      history(
        'count(event { time gte @now-30s OR event.name eq "signup" }) gte 1',
      ),
    ).toEqual({ kind: "full-history" });
    expect(history("count(event { NOT time gte @now-30s }) gte 1")).toEqual({
      kind: "full-history",
    });
  });

  it("does not expand history for empty intersections and detects unrepresentable windows", () => {
    expect(
      history("count(event { time gte @now-10s AND time lt @now-20s }) gte 1"),
    ).toEqual({ kind: "candidate-only" });
    expect(
      history(
        "count(window(event, first(event { time between [@now-10s, @now-5s] }).time, [0s, 9007199254740991ms])) gte 1",
      ),
    ).toEqual({ kind: "full-history" });
  });

  it("preserves nested selector coverage and empty bounded domains", () => {
    const ninetyDays = {
      kind: "bounded",
      startMs: 100_000 - 90 * 86_400_000,
      endExclusiveMs: 100_001,
    };
    expect(
      history("count(event { time gte @now-90d } { time gte @now-30d }) gte 1"),
    ).toEqual(ninetyDays);
    expect(
      history("count(event { time gte @now-30d } { time lt @now-40d }) gte 1"),
    ).toEqual({ kind: "candidate-only" });
  });

  it("uses full history when an exclusion has an upper-only time bound", () => {
    const sequence =
      "sequence([event { time gte @now-30d }, event { time gte @now-30d }])";
    expect(
      history(`without(${sequence}, event { time lt @now-10d }) exists`),
    ).toEqual({ kind: "full-history" });
  });

  it("falls back to full history when computed ranges overflow safe timestamps", () => {
    const document = parseFilterDsl(
      "count(event { time gte @now-1ms }) gte 1",
      analyticsFilterRegistry,
    );
    expect(
      analyzeFilterHistory(
        analyzeFilterDocument(document, analyticsFilterRegistry),
        { startMs: 0, endExclusiveMs: Number.MAX_SAFE_INTEGER },
        Number.MAX_SAFE_INTEGER,
        "visitor",
      ),
    ).toEqual({ kind: "full-history" });

    const windowDocument = parseFilterDsl(
      "count(window(event, first(event { time gte @range.start }).time, [-1ms, 0ms])) gte 1",
      analyticsFilterRegistry,
    );
    expect(
      analyzeFilterHistory(
        analyzeFilterDocument(windowDocument, analyticsFilterRegistry),
        { startMs: -Number.MAX_SAFE_INTEGER, endExclusiveMs: 0 },
        0,
        "visitor",
      ),
    ).toEqual({ kind: "full-history" });
  });

  it("preserves bounded history through periods, buckets, projections, and windows", () => {
    const bounded = {
      kind: "bounded",
      startMs: 100_000 - 30 * 86_400_000,
      endExclusiveMs: 100_001,
    };
    expect(
      history("first(periods(event { time gte @now-30d }, 1d)).start exists"),
    ).toEqual(bounded);
    expect(
      history(
        "first(bucket(page { time gte @now-30d }.time, 1d)).start exists",
      ),
    ).toEqual(bounded);
    expect(
      history('nth(event { time gte @now-30d }.payload("/amount"), 3) eq 3'),
    ).toEqual(bounded);
    expect(
      history(
        "first(window(event, first(event { time gte @now-30d }).time, [0d, 7d])) exists",
      ),
    ).toEqual(bounded);
    expect(history("first(event) exists")).toEqual({
      kind: "full-history",
    });
  });

  it("plans top-level activity time according to the resolved Scope", () => {
    const expected = {
      kind: "bounded",
      startMs: 100_000 - 30 * 86_400_000,
      endExclusiveMs: 100_001,
    };
    expect(history("time gte @now-30d", "visitor")).toEqual(expected);
    expect(history("time gte @now-30d", "session")).toEqual(expected);
    expect(history("time gte @now-30d", "event")).toEqual({
      kind: "candidate-only",
    });
  });

  it("fails conservatively for endpoints the history planner cannot resolve", () => {
    expect(historyForUnvalidatedTimeCondition("gte", 80_000)).toEqual({
      kind: "bounded",
      startMs: 80_000,
      endExclusiveMs: 100_001,
    });
    expect(
      historyForUnvalidatedTimeCondition("between", [
        80_000,
        Number.MAX_SAFE_INTEGER,
      ]),
    ).toEqual({ kind: "full-history" });
    expect(historyForUnvalidatedTimeCondition("gte", "not a date")).toEqual({
      kind: "full-history",
    });
    expect(historyForUnvalidatedTimeCondition("gte", null)).toEqual({
      kind: "full-history",
    });
    expect(
      historyForUnvalidatedTimeCondition("gte", {
        kind: "duration",
        amount: 1,
        unit: "d",
      }),
    ).toEqual({ kind: "full-history" });
    expect(historyForUnvalidatedTimeCondition("gte", 80_000, "path")).toEqual({
      kind: "full-history",
    });
    expect(
      historyForUnvalidatedTimeCondition("gte", {
        kind: "time-anchor",
        anchor: "now",
        offset: { kind: "duration", amount: 1, unit: "mo" },
      }),
    ).toEqual({ kind: "full-history" });
    expect(
      historyForUnvalidatedTimeCondition("gte", {
        kind: "time-anchor",
        anchor: "now",
        offset: {
          kind: "duration",
          amount: Number.MAX_SAFE_INTEGER,
          unit: "ms",
        },
      }),
    ).toEqual({ kind: "full-history" });
    expect(historyForUnvalidatedTimeCondition("contains", 80_000)).toEqual({
      kind: "full-history",
    });
    expect(historyForUnvalidatedWindow("mo")).toEqual({
      kind: "full-history",
    });
  });
});
