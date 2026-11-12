import { describe, expect, it } from "vitest";

import {
  analyticsFilterRegistry,
  evaluateFilterDocument,
  type FilterEvaluationDataset,
  type FilterEvaluationEntity,
  type FilterEvaluationOptions,
  parseFilterDsl,
} from "@/lib/filter-contract";

const DAY = 86_400_000;

function page(
  id: string,
  time: number,
  sessionId: string,
  visitorId: string,
  path = "/a",
): FilterEvaluationEntity {
  return {
    kind: "page",
    id,
    visitId: `visit-${id}`,
    sessionId,
    visitorId,
    time,
    fields: { "page.path": path },
  };
}

function event(
  id: string,
  name: string,
  time: number,
  sessionId: string,
  visitorId: string,
  payload: unknown = {},
): FilterEvaluationEntity {
  return {
    kind: "event",
    id,
    visitId: `visit-${id}`,
    sessionId,
    visitorId,
    time,
    fields: { "event.name": name },
    payload,
  };
}

const dataset: FilterEvaluationDataset = {
  pages: [page("p1", 10, "s1", "u1")],
  events: [
    event("e1", "signup", 10, "s1", "u1", {
      d: "2026-01-02",
      at: "2026-01-02T00:00:00Z",
      flag: true,
      n: 3,
      s: "x",
    }),
    event("e2", "purchase", 20, "s1", "u1", {
      d: "2026-01-03",
      at: "2026-01-03T00:00:00Z",
      flag: false,
      n: 4,
      s: "y",
    }),
  ],
  coverageRange: { startMs: -10 * DAY, endExclusiveMs: 100 * DAY },
};

const baseOptions = {
  candidateRange: { startMs: 0, endExclusiveMs: 100 },
  reportingTimeZone: "UTC",
  capturedAtMs: 80,
};

function run(
  source: string,
  scope: "event" | "session" | "visitor" = "visitor",
  data: FilterEvaluationDataset = dataset,
  extra: Partial<FilterEvaluationOptions> = {},
) {
  return evaluateFilterDocument(
    parseFilterDsl(source, analyticsFilterRegistry),
    data,
    { ...baseOptions, scope, ...extra },
  );
}

function visitors(source: string): string[] {
  return [...run(source).matchingScopeEntityIds];
}

describe("filter evaluator payload typing and reducers", () => {
  it.each([
    ['count(event { event.payload("/d") eq "2026-01-02" }) eq 1', ["u1"]],
    ['count(event { event.payload("/d") eq 1 }) eq 0', ["u1"]],
    [
      'count(event { event.payload("/at") gte "2026-01-03T00:00:00Z" }) eq 1',
      ["u1"],
    ],
    ['countDistinct(event.payload("/at")) eq 2', ["u1"]],
    ['countDistinct(event.payload("/flag")) eq 2', ["u1"]],
    ['countDistinct(event.payload("/s")) eq 2', ["u1"]],
    ['max(event.payload("/s")) eq "y"', ["u1"]],
    ['min(event.payload("/n")) eq 3', ["u1"]],
    ['max(event.payload("/flag")) eq true', ["u1"]],
    ['min(event.payload("/flag")) eq false', ["u1"]],
    ['avg(event.payload("/n")) eq 3.5', ["u1"]],
    ['sum(event.payload("/s")) eq 0', ["u1"]],
    ['avg(event.payload("/s")) eq 1', []],
    ['div(sum(event.payload("/n")), count(event)) eq 3.5', ["u1"]],
    ['sum(event.payload("/n")) eq 7', ["u1"]],
  ])("evaluates %s", (source, expected) => {
    expect(visitors(source)).toEqual(expected);
  });

  it("compares scalar reducer results by their own type", () => {
    expect(visitors('max(event.payload("/s")) lt "z"')).toEqual(["u1"]);
    expect(visitors('min(event.payload("/s")) gt "z"')).toEqual([]);
  });
});

describe("filter evaluator durations, windows and sequences", () => {
  it("computes duration differences between occurrence timestamps", () => {
    const sparse: FilterEvaluationDataset = {
      pages: [],
      events: [
        event("first", "first_team_event", 0, "s", "u"),
        event("signup", "signup", 10 * DAY, "s", "u"),
      ],
      coverageRange: { startMs: -DAY, endExclusiveMs: 30 * DAY },
    };
    const options: Partial<FilterEvaluationOptions> = {
      candidateRange: { startMs: -DAY, endExclusiveMs: 30 * DAY },
      capturedAtMs: 25 * DAY,
    };
    const forward = run(
      'sub(time(first(event { event.name eq "signup" })), time(first(event { event.name eq "first_team_event" }))) between [9d, 11d]',
      "visitor",
      sparse,
      options,
    );
    const backward = run(
      'sub(time(first(event { event.name eq "first_team_event" })), time(first(event { event.name eq "signup" }))) between [9d, 11d]',
      "visitor",
      sparse,
      options,
    );
    const missing = run(
      'sub(time(first(event { event.name eq "signup" })), time(first(event { event.name eq "nope" }))) between [9d, 11d]',
      "visitor",
      sparse,
      options,
    );
    expect([...forward.matchingScopeEntityIds]).toEqual(["u"]);
    expect([...backward.matchingScopeEntityIds]).toEqual([]);
    expect([...missing.matchingScopeEntityIds]).toEqual([]);
  });

  it("rejects windows whose start is not before the end", () => {
    expect(() =>
      run("count(window(event, first(event), [10ms, 0ms])) eq 0"),
    ).toThrow("invalid_window_range");
    expect(() =>
      run("count(window(event, first(event), [5ms, 5ms])) eq 0"),
    ).toThrow("invalid_window_range");
  });

  it("matches only sequences whose payload identity agrees", () => {
    const same = visitors(
      'sequence([event { event.name eq "signup" }, event { event.name eq "purchase" }]) { $same(event.payload("/s")) } exists',
    );
    expect(same).toEqual([]);
    const sameFlag = run(
      'sequence([event { event.name eq "a" }, event { event.name eq "b" }]) { $same(event.payload("/ok")) } exists',
      "visitor",
      {
        pages: [],
        events: [
          event("a", "a", 10, "s", "u", { ok: true }),
          event("b", "b", 20, "s", "u", { ok: true }),
          event("c", "a", 10, "s2", "u2", { ok: true }),
          event("d", "b", 20, "s2", "u2", { ok: Number.NaN }),
        ],
        coverageRange: { startMs: 0, endExclusiveMs: 100 },
      },
    );
    expect([...sameFlag.matchingScopeEntityIds]).toEqual(["u"]);
  });

  it("returns no sequence matches when a step has no candidates", () => {
    expect(
      visitors(
        'sequence([event { event.name eq "signup" }, event { event.name eq "never" }]) exists',
      ),
    ).toEqual([]);
  });

  it("returns a missing gap when a step index is outside the sequence", () => {
    expect(() =>
      run(
        'sequence([event { event.name eq "signup" }, event { event.name eq "purchase" }]) { $gap(1, 5) eq 10ms } exists',
      ),
    ).toThrow("invalid_sequence_gap");
  });
});

describe("filter evaluator limits", () => {
  it("rejects filter ranges that end before they start", () => {
    expect(() =>
      run("count(event) gte 1", "visitor", dataset, {
        filterRange: { startMs: 50, endExclusiveMs: 20 },
        readRange: { startMs: 0, endExclusiveMs: 100 },
      }),
    ).toThrow("invalid_filter_range");
    expect(() =>
      run("count(event) gte 1", "visitor", dataset, {
        filterRange: { startMs: 0.5, endExclusiveMs: 20 },
        readRange: { startMs: 0, endExclusiveMs: 100 },
      }),
    ).toThrow("invalid_filter_range");
  });

  it("counts candidates outside the read range against the workload", () => {
    expect(() =>
      run("count(event) gte 1", "visitor", dataset, {
        candidateRange: { startMs: 0, endExclusiveMs: 100 },
        readRange: { startMs: 15, endExclusiveMs: 25 },
        filterRange: { startMs: 15, endExclusiveMs: 25 },
        maxActivities: 2,
      }),
    ).toThrow("filter_activity_limit_exceeded");
  });
});

describe("filter evaluator subject resolution across scopes", () => {
  it.each([
    ["event", "event { session.views gt 0 } exists"],
    ["event", "page { visitor.sessions gt 0 } exists"],
    ["event", "session { session.views gt 0 } exists"],
    ["event", "visitor { visitor.sessions gt 0 } exists"],
  ] as const)("resolves %s scope selector %s", (scope, source) => {
    const result = run(source, scope);
    expect(result.matchingEventIds).toEqual(new Set(["e1", "e2"]));
    expect(result.matchingVisitIds).toEqual(
      new Set(["visit-p1", "visit-e1", "visit-e2"]),
    );
  });

  it("anchors Event scope activity conditions to each Event", () => {
    const result = run('event.payload("/n") eq 3', "event");
    expect(result.matchingEventIds).toEqual(new Set(["e1"]));
    expect(run('page.path eq "/a"', "event").matchingVisitIds).toEqual(
      new Set(["visit-p1"]),
    );
    expect(
      run('event.name eq "signup" AND count(page) gt 0', "event")
        .matchingEventIds,
    ).toEqual(new Set(["e1"]));
  });

  it("lifts Session and Visitor aggregate conditions from Events", () => {
    expect([
      ...run("count(event { session.views gt 0 }) gt 0", "session")
        .matchingScopeEntityIds,
    ]).toEqual(["s1"]);
    expect([
      ...run("count(event { visitor.views gt 0 }) gt 0", "visitor")
        .matchingScopeEntityIds,
    ]).toEqual(["u1"]);
    expect([
      ...run(
        "visitor { session { page { session.views gt 0 } exists } exists } exists",
      ).matchingScopeEntityIds,
    ]).toEqual(["u1"]);
    expect([
      ...run("session { visitor.sessions gt 0 } exists", "session")
        .matchingScopeEntityIds,
    ]).toEqual(["s1"]);
  });

  it("evaluates activity-level conditions for orphan Event activities", () => {
    const orphans: FilterEvaluationDataset = {
      pages: [
        { kind: "page", id: "op", time: 10, fields: { "page.path": "/o" } },
      ],
      events: [
        {
          kind: "event",
          id: "oe",
          time: 20,
          fields: { "event.name": "orphan" },
        },
      ],
      coverageRange: { startMs: 0, endExclusiveMs: 100 },
    };
    const result = run(
      'count(event { event.name eq "orphan" }) gte 1',
      "event",
      orphans,
    );
    expect(result.matchingEventIds).toEqual(new Set(["oe"]));
  });
});

describe("filter evaluator bucket and period collections", () => {
  it("groups buckets and periods and evaluates predicates over items", () => {
    expect(visitors("countDistinct(bucket(event, 1d)) eq 1")).toEqual(["u1"]);
    expect(
      visitors("count(periods(event, 1d) { count($items) eq 2 }) eq 1"),
    ).toEqual(["u1"]);
    expect(
      visitors("count(periods(event, 1d) { count($items) eq 3 }) eq 0"),
    ).toEqual(["u1"]);
  });
});
