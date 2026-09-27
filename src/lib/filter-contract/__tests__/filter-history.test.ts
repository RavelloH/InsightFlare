import { describe, expect, it } from "vitest";

import {
  analyticsFilterRegistry,
  analyzeFilterDocument,
  analyzeFilterHistory,
  analyzeFilterTimeRange,
  parseFilterDsl,
  validateFilterConditionDomains,
} from "@/lib/filter-contract";
import type { AnalyzedFilterDocument } from "@/lib/filter-contract/filter-semantics";
import type {
  FilterCondition,
  FilterDocument,
  FilterExpression,
  FilterTargetExpression,
} from "@/lib/filter-contract/filters";

const queryRange = { startMs: 80_000, endExclusiveMs: 90_000 };
const capturedAtMs = 100_000;

function analyzed(source: string) {
  const document = parseFilterDsl(source, analyticsFilterRegistry);
  return {
    document,
    analysis: analyzeFilterDocument(document, analyticsFilterRegistry),
  };
}

function filterTime(source: string) {
  const { analysis } = analyzed(source);
  return analyzeFilterTimeRange(analysis, queryRange, capturedAtMs);
}

function history(source: string) {
  const { analysis } = analyzed(source);
  const time = analyzeFilterTimeRange(analysis, queryRange, capturedAtMs);
  return analyzeFilterHistory(
    analysis,
    queryRange,
    capturedAtMs,
    "visitor",
    time.explicit && !time.empty ? time.range : undefined,
  );
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

function rawAnalysisForRoot(
  root: FilterExpression,
  markAllConditionsAsTemporal = false,
): AnalyzedFilterDocument {
  const conditions = new WeakMap<object, { temporalPredicate: boolean }>();
  const visit = (expression: FilterExpression): void => {
    if (expression.kind === "condition") {
      const target = expression.target;
      const isTime =
        target.kind === "member" &&
        target.object.kind === "context-root" &&
        target.object.context === "current" &&
        target.member === "time";
      if (isTime || markAllConditionsAsTemporal)
        conditions.set(expression, { temporalPredicate: true });
    } else if (expression.kind === "not") {
      visit(expression.child);
    } else {
      expression.children.forEach(visit);
    }
  };
  visit(root);
  return {
    document: { version: 1, root } satisfies FilterDocument,
    conditions,
  } as unknown as AnalyzedFilterDocument;
}

function rawTime(root: FilterExpression) {
  return analyzeFilterTimeRange(
    rawAnalysisForRoot(root),
    queryRange,
    capturedAtMs,
  );
}

function rawHistory(root: FilterExpression) {
  const analysis = rawAnalysisForRoot(root);
  const time = analyzeFilterTimeRange(analysis, queryRange, capturedAtMs);
  return analyzeFilterHistory(
    analysis,
    queryRange,
    capturedAtMs,
    "visitor",
    time.explicit && !time.empty ? time.range : undefined,
  );
}

describe("Filter time domain and history planning", () => {
  it("derives a finite Filter range from top-level time predicates", () => {
    expect(filterTime("time gte @now-30d")).toEqual({
      explicit: true,
      empty: false,
      range: {
        startMs: capturedAtMs - 30 * 86_400_000,
        endExclusiveMs: capturedAtMs + 1,
      },
    });
    expect(filterTime("time between [@now-90d, @now-30d]")).toEqual({
      explicit: true,
      empty: false,
      range: {
        startMs: capturedAtMs - 90 * 86_400_000,
        endExclusiveMs: capturedAtMs - 30 * 86_400_000 + 1,
      },
    });
    expect(filterTime("time between [@range.start, @range.end]")).toEqual({
      explicit: true,
      empty: false,
      range: {
        startMs: queryRange.startMs,
        endExclusiveMs: queryRange.endExclusiveMs + 1,
      },
    });
  });

  it("represents upper-only Filter ranges without a synthetic start", () => {
    expect(filterTime("time lt @now-30d")).toEqual({
      explicit: true,
      empty: false,
      range: { endExclusiveMs: capturedAtMs - 30 * 86_400_000 },
    });
  });

  it("marks disjoint or future-only Filter ranges empty", () => {
    expect(filterTime("time gte @now-10d AND time lt @now-20d")).toEqual({
      explicit: true,
      empty: true,
    });
    expect(filterTime("time gte @now+1ms")).toEqual({
      explicit: true,
      empty: true,
    });
  });

  it("keeps query-window history for documents without Filter time", () => {
    expect(filterTime('event.name eq "purchase"')).toEqual({
      explicit: false,
      empty: false,
    });
    expect(history("count(event) gte 1")).toEqual({
      kind: "candidate-only",
    });
    expect(history("first(event) exists")).toEqual({
      kind: "full-history",
    });
    expect(history("")).toEqual({ kind: "candidate-only" });
  });

  it("uses Filter time as the base history bound for reducers and wrappers", () => {
    const startMs = capturedAtMs - 60 * 86_400_000;
    const endExclusiveMs = capturedAtMs - 30 * 86_400_000 + 1;
    expect(
      history(
        'time between [@now-60d, @now-30d] AND first(event).name eq "signup"',
      ),
    ).toEqual({ kind: "bounded", startMs, endExclusiveMs });
    expect(
      history(
        "time between [@now-60d, @now-30d] AND first(periods(event, 1d)) exists",
      ),
    ).toEqual({ kind: "bounded", startMs, endExclusiveMs });
    expect(
      history(
        'time between [@now-60d, @now-30d] AND count(event { event.name eq "purchase" }) gte 3',
      ),
    ).toEqual({ kind: "bounded", startMs, endExclusiveMs });
    expect(
      history(
        'time between [@now-60d, @now-30d] AND session { first(event).name eq "signup" } exists',
      ),
    ).toEqual({ kind: "bounded", startMs, endExclusiveMs });
  });

  it("extends the required read range when a window reaches beyond Filter time", () => {
    const startMs = capturedAtMs - 60 * 86_400_000;
    const filterEnd = capturedAtMs - 30 * 86_400_000 + 1;
    expect(
      history(
        "time between [@now-60d, @now-30d] AND count(window(event, first(event), [0d, 7d])) gte 1",
      ),
    ).toEqual({
      kind: "bounded",
      startMs,
      endExclusiveMs: Math.min(filterEnd + 7 * 86_400_000, capturedAtMs + 1),
    });
  });

  it("requires complete retained history for an unbounded lower Filter bound", () => {
    expect(history("time lt @now-30d AND first(event) exists")).toEqual({
      kind: "full-history",
    });
  });

  it("rejects equality operators for scope-level time", () => {
    for (const operator of ["eq", "neq"] as const) {
      expect(() =>
        parseFilterDsl(`time ${operator} @now`, analyticsFilterRegistry),
      ).toThrow(expect.objectContaining({ code: "invalid_time_scope" }));
    }
  });

  it("keeps ordinary reducers candidate-bound and positional reducers history-aware", () => {
    expect(history("countDistinct(bucket(page, 1d)) gte 1")).toEqual({
      kind: "candidate-only",
    });
    expect(history("count(periods(event, 1w)) gte 1")).toEqual({
      kind: "candidate-only",
    });
    expect(history("last(page) exists")).toEqual({ kind: "full-history" });
    expect(
      history("count(window(event, first(event), [0d, 7d])) gte 1"),
    ).toEqual({
      kind: "full-history",
    });
    expect(
      history(
        'nth(event { event.name eq "purchase" }.payload("/amount"), 3) eq 3',
      ),
    ).toEqual({ kind: "full-history" });
    expect(history("first(periods(event, 1w)) exists")).toEqual({
      kind: "full-history",
    });
  });

  it("carries bounded windows and relation steps through history analysis", () => {
    expect(
      history(
        "count(window(event, @range.start, [0ms, 10ms])) gte 1 AND count(event) gte 1",
      ),
    ).toEqual({ kind: "bounded", startMs: 80_000, endExclusiveMs: 80_011 });
    const boundedSequence =
      "sequence([window(event, @range.start, [0d, 1d]), window(event, @range.end, [-1d, 0d])])";
    expect(history(`without(${boundedSequence}, event) exists`)).toMatchObject({
      kind: "bounded",
      startMs: 90_000 - 86_400_000,
    });
    expect(history(`without(sequence([event, page]), event) exists`)).toEqual({
      kind: "full-history",
    });
    expect(history("adjacent(sequence([event, page])) exists")).toEqual({
      kind: "full-history",
    });
    expect(
      history(
        `without(${boundedSequence}, window(event, @range.start, [0d, 1d])) exists`,
      ),
    ).toMatchObject({ kind: "bounded" });
    expect(
      history(
        `without(${boundedSequence}, window(event, first(event), [0d, 7d])) exists`,
      ),
    ).toEqual({ kind: "full-history" });
    expect(
      history(
        "count(window(event, @range.start, [0d, 9007199254740991ms])) gte 1",
      ),
    ).toEqual({ kind: "full-history" });
    expect(
      history("count(window(event, @range.start, [0d, -7d])) gte 1"),
    ).toEqual({
      kind: "candidate-only",
    });
    expect(
      history(
        "time between [@now-30d, @now-10d] AND add(count(event), count(page)) gte 1",
      ),
    ).toMatchObject({ kind: "bounded" });
  });

  it("resolves supported endpoint forms and clips upper bounds to the captured clock", () => {
    expect(filterTime('time gte "1970-01-01T00:01:30Z"')).toEqual({
      explicit: true,
      empty: false,
      range: { startMs: 90_000, endExclusiveMs: capturedAtMs + 1 },
    });
    expect(filterTime("time gt @range.start")).toEqual({
      explicit: true,
      empty: false,
      range: {
        startMs: queryRange.startMs + 1,
        endExclusiveMs: capturedAtMs + 1,
      },
    });
    expect(filterTime("time lte @range.start")).toEqual({
      explicit: true,
      empty: false,
      range: { endExclusiveMs: queryRange.startMs + 1 },
    });
    expect(filterTime("time between [@range.start, @range.end]")).toEqual({
      explicit: true,
      empty: false,
      range: {
        startMs: queryRange.startMs,
        endExclusiveMs: queryRange.endExclusiveMs + 1,
      },
    });
  });

  it("treats unsupported or malformed temporal endpoints conservatively", () => {
    const unsupported = [
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
      ["neq", 80_000],
      ["contains", 80_000],
    ] as const;
    for (const [operator, value] of unsupported) {
      expect(rawTime(rawTimeCondition(operator, value))).toEqual({
        explicit: true,
        empty: false,
        range: { endExclusiveMs: capturedAtMs + 1 },
      });
    }
    expect(rawTime(rawTimeCondition("gte", 80_000, "not-time"))).toEqual({
      explicit: false,
      empty: false,
    });
  });

  it("keeps OR and NOT time predicates conservative and empty ranges candidate-only", () => {
    const time = rawTimeCondition("gte", 80_000);
    const other = parseFilterDsl(
      "page.path exists",
      analyticsFilterRegistry,
    ).root!;
    const or: FilterExpression = { kind: "or", children: [time, other] };
    const not: FilterExpression = { kind: "not", child: time };
    expect(rawTime(or)).toEqual({
      explicit: true,
      empty: false,
      range: { endExclusiveMs: capturedAtMs + 1 },
    });
    expect(rawHistory(or)).toEqual({ kind: "full-history" });
    expect(rawHistory(not)).toEqual({ kind: "full-history" });
    expect(
      analyzeFilterTimeRange(
        rawAnalysisForRoot(time),
        queryRange,
        Number.MAX_SAFE_INTEGER,
      ),
    ).toEqual({ explicit: true, empty: false, range: {} });
    expect(
      analyzeFilterHistory(
        analyzed("count(event) gte 1").analysis,
        queryRange,
        capturedAtMs,
        "visitor",
        { startMs: 90_000, endExclusiveMs: 90_000 },
      ),
    ).toEqual({ kind: "candidate-only" });
  });

  it("falls back to full-history for unsafe ranges and unsupported Window offsets", () => {
    const document = analyzed("count(event) gte 1");
    expect(
      analyzeFilterHistory(
        document.analysis,
        queryRange,
        Number.MAX_SAFE_INTEGER,
        "visitor",
        {
          startMs: 0,
          endExclusiveMs: Number.MAX_SAFE_INTEGER + 2,
        },
      ),
    ).toEqual({ kind: "full-history" });

    const overflowAnchor = rawTimeCondition("gte", {
      kind: "time-anchor",
      anchor: "now",
      offset: {
        kind: "duration",
        amount: Number.MAX_SAFE_INTEGER,
        unit: "ms",
      },
    });
    expect(rawHistory(overflowAnchor)).toEqual({ kind: "full-history" });

    const invalidWindow: FilterTargetExpression = {
      kind: "window",
      collection: { kind: "entity-root", entity: "event" },
      anchor: { kind: "time-anchor", anchor: "range.start" },
      startOffset: { kind: "duration", amount: 0, unit: "mo" },
      endOffset: { kind: "duration", amount: 1, unit: "d" },
    };
    expect(
      rawHistory({
        kind: "condition",
        target: invalidWindow,
        operator: "exists",
      }),
    ).toEqual({ kind: "full-history" });
  });
});
