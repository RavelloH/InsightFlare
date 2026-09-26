import { describe, expect, it } from "vitest";

import {
  analyticsFilterRegistry,
  evaluateFilterDocument,
  type FilterEvaluationDataset,
  type FilterEvaluationEntity,
  parseFilterDsl,
} from "@/lib/filter-contract";

function page(
  id: string,
  time: number,
  sessionId: string,
  visitorId: string,
  path = `/${id}`,
): FilterEvaluationEntity {
  return {
    kind: "page",
    id,
    visitId: id,
    sessionId,
    visitorId,
    time,
    fields: { "page.path": path, "client.browser": "Chrome" },
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
    fields: { "event.name": name, "client.browser": "Chrome" },
    payload,
  };
}

const fixture: FilterEvaluationDataset = {
  pages: [
    page("v-a-1", 10, "s-a", "u-a", "/start"),
    page("v-a-2", 25, "s-a", "u-a", "/between"),
    page("v-b-1", 15, "s-b", "u-b", "/start"),
  ],
  events: [
    event("a-signup", "signup", 10, "s-a", "u-a"),
    event("a-purchase-low", "purchase", 27, "s-a", "u-a", { amount: 5 }),
    event("a-purchase-high", "purchase", 30, "s-a", "u-a", {
      amount: 50,
      explicitNull: null,
    }),
    event("a-cancel-before", "cancellation", 5, "s-a", "u-a"),
    event("b-signup", "signup", 15, "s-b", "u-b"),
    event("b-purchase", "purchase", 40, "s-b", "u-b", { amount: 10 }),
  ],
  coverageRange: { startMs: 0, endExclusiveMs: 100 },
};

function evaluate(
  source: string,
  scope: "event" | "session" | "visitor" = "visitor",
) {
  return evaluateFilterDocument(
    parseFilterDsl(source, analyticsFilterRegistry),
    fixture,
    {
      scope,
      candidateRange: { startMs: 0, endExclusiveMs: 100 },
      reportingTimeZone: "UTC",
      capturedAtMs: 80,
    },
  );
}

describe("filter evaluator", () => {
  it("treats an empty document as matching every in-range Event activity", () => {
    const dataset: FilterEvaluationDataset = {
      pages: [
        page("page-in", 10, "s-a", "u-a"),
        { kind: "page", id: "orphan-page", time: 20, fields: {} },
      ],
      events: [
        event("event-in", "signup", 15, "s-a", "u-a"),
        {
          kind: "event",
          id: "orphan-event",
          time: 25,
          fields: { "event.name": "orphan" },
        },
        event("outside", "signup", 100, "s-a", "u-a"),
      ],
      coverageRange: { startMs: 0, endExclusiveMs: 200 },
    };
    const result = evaluateFilterDocument(
      parseFilterDsl("", analyticsFilterRegistry),
      dataset,
      {
        scope: "event",
        candidateRange: { startMs: 0, endExclusiveMs: 50 },
        reportingTimeZone: "UTC",
        capturedAtMs: 80,
      },
    );

    expect(result.matchingScopeEntityIds).toEqual(new Set());
    expect(result.matchingVisitIds).toEqual(
      new Set(["page-in", "visit-event-in"]),
    );
    expect(result.matchingEventIds).toEqual(
      new Set(["event-in", "orphan-event"]),
    );
  });

  it("evaluates all conditions in a Selector against the same event", () => {
    const result = evaluate(
      'count(event { event.name eq "purchase" AND event.payload("/amount") gt 20 }) eq 1',
    );
    expect(result.matchingScopeEntityIds).toEqual(new Set(["u-a"]));
  });

  it("lifts Session descendant fields over every Page and Event in the Session", () => {
    const dataset: FilterEvaluationDataset = {
      pages: [
        page("first-page", 10, "s-a", "u-a", "/home"),
        page("later-page", 20, "s-a", "u-a", "/pricing"),
      ],
      events: [
        event("first-event", "signup", 11, "s-a", "u-a"),
        event("later-event", "purchase", 30, "s-a", "u-a"),
      ],
      coverageRange: { startMs: 0, endExclusiveMs: 100 },
    };
    const evaluateSession = (source: string) =>
      evaluateFilterDocument(
        parseFilterDsl(source, analyticsFilterRegistry),
        dataset,
        {
          scope: "session",
          candidateRange: { startMs: 0, endExclusiveMs: 100 },
          reportingTimeZone: "UTC",
          capturedAtMs: 80,
        },
      );

    expect(
      evaluateSession('session { page.path eq "/pricing" } exists')
        .matchingScopeEntityIds,
    ).toEqual(new Set(["s-a"]));
    expect(
      evaluateSession('session { event.name eq "purchase" } exists')
        .matchingScopeEntityIds,
    ).toEqual(new Set(["s-a"]));
    expect(
      evaluateSession(
        'session { page.path eq "/pricing" AND event.name eq "purchase" } exists',
      ).matchingScopeEntityIds,
    ).toEqual(new Set(["s-a"]));
  });

  it("keeps bare descendant conditions independent while nested selectors anchor one Page", () => {
    const dataset: FilterEvaluationDataset = {
      pages: [
        {
          ...page("page-a", 10, "s-a", "u-a", "/pricing"),
          fields: { "page.path": "/pricing", "page.title": "Home" },
        },
        {
          ...page("page-b", 20, "s-a", "u-a", "/home"),
          fields: { "page.path": "/home", "page.title": "Checkout" },
        },
      ],
      events: [],
      coverageRange: { startMs: 0, endExclusiveMs: 100 },
    };
    const evaluateSession = (source: string) =>
      evaluateFilterDocument(
        parseFilterDsl(source, analyticsFilterRegistry),
        dataset,
        {
          scope: "session",
          candidateRange: { startMs: 0, endExclusiveMs: 100 },
          reportingTimeZone: "UTC",
          capturedAtMs: 80,
        },
      );

    expect(
      evaluateSession(
        'session { page.path eq "/pricing" AND page.title eq "Checkout" } exists',
      ).matchingScopeEntityIds,
    ).toEqual(new Set(["s-a"]));
    expect(
      evaluateSession(
        'session { page { page.path eq "/pricing" AND page.title eq "Checkout" } exists } exists',
      ).matchingScopeEntityIds,
    ).toEqual(new Set());
  });

  it("distinguishes negated equality from existential inequality", () => {
    const dataset: FilterEvaluationDataset = {
      pages: [
        page("page-home", 10, "s-a", "u-a", "/home"),
        page("page-pricing", 20, "s-a", "u-a", "/pricing"),
      ],
      events: [],
      coverageRange: { startMs: 0, endExclusiveMs: 100 },
    };
    const evaluateSession = (source: string) =>
      evaluateFilterDocument(
        parseFilterDsl(source, analyticsFilterRegistry),
        dataset,
        {
          scope: "session",
          candidateRange: { startMs: 0, endExclusiveMs: 100 },
          reportingTimeZone: "UTC",
          capturedAtMs: 80,
        },
      );

    expect(
      evaluateSession('session { NOT page.path eq "/admin" } exists')
        .matchingScopeEntityIds,
    ).toEqual(new Set(["s-a"]));
    expect(
      evaluateSession('session { NOT page.path eq "/pricing" } exists')
        .matchingScopeEntityIds,
    ).toEqual(new Set());
    expect(
      evaluateSession('session { page.path neq "/pricing" } exists')
        .matchingScopeEntityIds,
    ).toEqual(new Set(["s-a"]));
  });

  it("lifts Visitor conditions to descendant Sessions and Events", () => {
    const dataset: FilterEvaluationDataset = {
      pages: [
        page("session-a-page", 10, "s-a", "u-a", "/home"),
        page("session-b-page", 30, "s-b", "u-a", "/pricing"),
      ],
      events: [event("purchase", "purchase", 40, "s-b", "u-a")],
      sessions: [
        {
          kind: "session",
          id: "s-a",
          time: 10,
          sessionId: "s-a",
          visitorId: "u-a",
          fields: { "session.durationMs": 1_000 },
        },
        {
          kind: "session",
          id: "s-b",
          time: 30,
          sessionId: "s-b",
          visitorId: "u-a",
          fields: { "session.durationMs": 400_000 },
        },
      ],
      coverageRange: { startMs: 0, endExclusiveMs: 1_000_000 },
    };
    const evaluateVisitor = (source: string) =>
      evaluateFilterDocument(
        parseFilterDsl(source, analyticsFilterRegistry),
        dataset,
        {
          scope: "visitor",
          candidateRange: { startMs: 0, endExclusiveMs: 1_000_000 },
          reportingTimeZone: "UTC",
          capturedAtMs: 800_000,
        },
      );

    expect(
      evaluateVisitor('visitor { event.name eq "purchase" } exists')
        .matchingScopeEntityIds,
    ).toEqual(new Set(["u-a"]));
    expect(
      evaluateVisitor("visitor { session.durationMs gt 5m } exists")
        .matchingScopeEntityIds,
    ).toEqual(new Set(["u-a"]));
  });

  it("uses registry entity domains for aggregate and activity selectors", () => {
    const dataset: FilterEvaluationDataset = {
      pages: [
        {
          ...page(
            "domain-page",
            10,
            "domain-session",
            "domain-visitor",
            "/pricing",
          ),
          fields: {
            "page.path": "/pricing",
            "page.time": 10,
            "geo.country": "US",
          },
        },
      ],
      events: [
        {
          ...event(
            "domain-event",
            "purchase",
            20,
            "domain-session",
            "domain-visitor",
          ),
          fields: { "event.name": "purchase", "geo.country": "US" },
        },
      ],
      sessions: [
        {
          kind: "session",
          id: "domain-session",
          time: 10,
          sessionId: "domain-session",
          visitorId: "domain-visitor",
          fields: { "session.durationMs": 1_200 },
        },
      ],
      visitors: [
        {
          kind: "visitor",
          id: "domain-visitor",
          time: 10,
          visitorId: "domain-visitor",
          fields: { "visitor.sessions": 1, "visitor.views": 1 },
        },
      ],
      coverageRange: { startMs: 0, endExclusiveMs: 100 },
    };
    const run = (source: string, scope: "event" | "session" | "visitor") =>
      evaluateFilterDocument(
        parseFilterDsl(source, analyticsFilterRegistry),
        dataset,
        {
          scope,
          candidateRange: { startMs: 0, endExclusiveMs: 100 },
          reportingTimeZone: "UTC",
          capturedAtMs: 80,
        },
      );

    expect(
      run(
        'visitor { session.durationMs gte 1s AND visitor.sessions eq 1 AND page.path eq "/pricing" AND event.name eq "purchase" AND geo.country eq "US" } exists',
        "visitor",
      ).matchingScopeEntityIds,
    ).toEqual(new Set(["domain-visitor"]));
    expect(
      run(
        'session { visitor.views eq 1 AND page { page.time eq "1970-01-01T00:00:00.010Z" AND geo.country eq "US" } exists AND event { event.time eq "1970-01-01T00:00:00.020Z" AND geo.country eq "US" } exists } exists',
        "session",
      ).matchingScopeEntityIds,
    ).toEqual(new Set(["domain-session"]));
    expect(
      run(
        'visitor { time eq "1970-01-01T00:00:00.010Z" AND time eq "1970-01-01T00:00:00.020Z" } exists',
        "visitor",
      ).matchingScopeEntityIds,
    ).toEqual(new Set(["domain-visitor"]));
  });

  it("rejects Page and Event sibling fields inside a single-activity selector", () => {
    expect(() =>
      evaluate(
        'event { event.name eq "purchase" AND page.path eq "/pricing" } exists',
      ),
    ).toThrow(
      expect.objectContaining({ code: "invalid_condition_entity_domain" }),
    );
    expect(() => evaluate('page { event.name eq "purchase" } exists')).toThrow(
      expect.objectContaining({ code: "invalid_condition_entity_domain" }),
    );
  });

  it("uses contextual JSON payload narrowing and keeps JSON scalar types distinct", () => {
    const dataset: FilterEvaluationDataset = {
      pages: [],
      events: [
        event("string", "api_request", 10, "s-a", "u-a", {
          amount: "0",
          productId: "123",
        }),
        event("number-1", "api_request", 20, "s-a", "u-a", {
          amount: 150,
          productId: 123,
        }),
        event("number-2", "api_request", 30, "s-a", "u-a", {
          amount: 200,
          productId: "123",
        }),
      ],
      coverageRange: { startMs: 0, endExclusiveMs: 100 },
    };
    const options = {
      scope: "visitor" as const,
      candidateRange: { startMs: 0, endExclusiveMs: 100 },
      reportingTimeZone: "UTC",
      capturedAtMs: 80,
    };
    const minimum = evaluateFilterDocument(
      parseFilterDsl(
        'min(event.payload("/amount")) gt 100',
        analyticsFilterRegistry,
      ),
      dataset,
      options,
    );
    const distinct = evaluateFilterDocument(
      parseFilterDsl(
        'countDistinct(event.payload("/productId")) eq 2',
        analyticsFilterRegistry,
      ),
      dataset,
      options,
    );
    const numericArithmetic = evaluateFilterDocument(
      parseFilterDsl(
        'div(sub(sum(event.payload("/amount")), sum(event.payload("/refund"))), count(event)) gt 50',
        analyticsFilterRegistry,
      ),
      dataset,
      options,
    );
    const stringMinimum = evaluateFilterDocument(
      parseFilterDsl(
        'min(event.payload("/value")) gt "alpha"',
        analyticsFilterRegistry,
      ),
      {
        pages: [],
        events: [
          event("number-first", "api_request", 10, "s-text", "u-text", {
            value: 500,
          }),
          event("text-min", "api_request", 20, "s-text", "u-text", {
            value: "beta",
          }),
          event("text-max", "api_request", 30, "s-text", "u-text", {
            value: "zeta",
          }),
        ],
        coverageRange: { startMs: 0, endExclusiveMs: 100 },
      },
      options,
    );

    expect(minimum.matchingScopeEntityIds).toEqual(new Set(["u-a"]));
    expect(distinct.matchingScopeEntityIds).toEqual(new Set(["u-a"]));
    expect(numericArithmetic.matchingScopeEntityIds).toEqual(new Set(["u-a"]));
    expect(stringMinimum.matchingScopeEntityIds).toEqual(new Set(["u-text"]));
  });

  it("narrows payload collections from equality and homogeneous set comparisons", () => {
    const dataset: FilterEvaluationDataset = {
      pages: [],
      events: [
        event("legacy", "value", 10, "s-a", "u-a", { value: "legacy" }),
        event("number-1", "value", 20, "s-a", "u-a", { value: 100 }),
        event("number-2", "value", 30, "s-a", "u-a", { value: 200 }),
      ],
      coverageRange: { startMs: 0, endExclusiveMs: 100 },
    };
    const evaluatePayload = (source: string) =>
      evaluateFilterDocument(
        parseFilterDsl(source, analyticsFilterRegistry),
        dataset,
        {
          scope: "visitor",
          candidateRange: { startMs: 0, endExclusiveMs: 100 },
          reportingTimeZone: "UTC",
          capturedAtMs: 80,
        },
      ).matchingScopeEntityIds;

    expect(evaluatePayload('first(event.payload("/value")) eq 100')).toEqual(
      new Set(["u-a"]),
    );
    expect(
      evaluatePayload('first(event.payload("/value")) eq "legacy"'),
    ).toEqual(new Set(["u-a"]));
    expect(
      evaluatePayload(
        'nth(event { event.name eq "value" }.payload("/value"), 2) eq 200',
      ),
    ).toEqual(new Set(["u-a"]));
    expect(evaluatePayload('min(event.payload("/value")) eq 100')).toEqual(
      new Set(["u-a"]),
    );
    expect(
      evaluatePayload('first(event.payload("/value")) in [100, 200]'),
    ).toEqual(new Set(["u-a"]));
    expect(evaluatePayload('last(event.payload("/value")) neq 99')).toEqual(
      new Set(["u-a"]),
    );
    expect(
      evaluatePayload('first(event.payload("/value")) notIn ["legacy"]'),
    ).toEqual(new Set());
    expect(
      evaluatePayload('countDistinct(event.payload("/value")) eq 3'),
    ).toEqual(new Set(["u-a"]));
  });

  it("keeps aggregate member comparisons anchored to the current query entity", () => {
    const dataset: FilterEvaluationDataset = {
      pages: [
        {
          ...page("first", 10, "s-a", "u-a", "/first"),
          fields: {
            "page.path": "/first",
            "referrer.domain": "google.com",
          },
        },
        {
          ...page("last", 20, "s-a", "u-a", "/last"),
          fields: {
            "page.path": "/last",
            "referrer.domain": "bing.com",
          },
        },
      ],
      events: [],
      coverageRange: { startMs: 0, endExclusiveMs: 100 },
    };
    const options = {
      scope: "visitor" as const,
      candidateRange: { startMs: 0, endExclusiveMs: 100 },
      reportingTimeZone: "UTC",
      capturedAtMs: 80,
    };

    for (const expression of [
      'first(page).referrer.domain eq "google.com"',
      'last(page).time eq "1970-01-01T00:00:00.020Z"',
      'page.time eq "1970-01-01T00:00:00.010Z"',
    ]) {
      expect(
        evaluateFilterDocument(
          parseFilterDsl(expression, analyticsFilterRegistry),
          dataset,
          options,
        ).matchingScopeEntityIds,
      ).toEqual(new Set(["u-a"]));
    }
  });

  it("returns no match for division by an empty aggregate", () => {
    const dataset: FilterEvaluationDataset = {
      pages: [page("candidate", 10, "s-a", "u-a")],
      events: [],
      coverageRange: { startMs: 0, endExclusiveMs: 100 },
    };
    const result = evaluateFilterDocument(
      parseFilterDsl(
        "div(count(event), count(event)) eq 0",
        analyticsFilterRegistry,
      ),
      dataset,
      {
        scope: "visitor",
        candidateRange: { startMs: 0, endExclusiveMs: 100 },
        reportingTimeZone: "UTC",
        capturedAtMs: 80,
      },
    );
    expect(result.matchingScopeEntityIds).toEqual(new Set());
  });

  it("resolves aggregate roots from their indexed anchors", () => {
    const dataset: FilterEvaluationDataset = {
      pages: [
        {
          kind: "page",
          id: "orphan-page",
          time: 10,
          visitId: "orphan-page",
          fields: { "page.path": "/orphan" },
        },
        page("session-page", 20, "session-a", "visitor-a"),
      ],
      events: [],
      coverageRange: { startMs: 0, endExclusiveMs: 100 },
    };
    const run = (source: string, scope: "event" | "session" | "visitor") =>
      evaluateFilterDocument(
        parseFilterDsl(source, analyticsFilterRegistry),
        dataset,
        {
          scope,
          candidateRange: { startMs: 0, endExclusiveMs: 100 },
          reportingTimeZone: "UTC",
          capturedAtMs: 80,
        },
      );

    expect(run("count(page) eq 1", "event").matchingVisitIds).toEqual(
      new Set(["orphan-page", "session-page"]),
    );
    expect(
      run("count(page) eq 1 AND count(visitor) eq 1", "event").matchingVisitIds,
    ).toEqual(new Set(["session-page"]));
    expect(
      run("count(visitor) eq 1 OR count(session) eq 1", "visitor")
        .matchingScopeEntityIds,
    ).toEqual(new Set(["visitor-a"]));
    expect(
      run("session { count(visitor) eq 1 } exists", "session")
        .matchingScopeEntityIds,
    ).toEqual(new Set(["session-a"]));
  });

  it("narrows boolean payloads without coercing other JSON scalar types", () => {
    const dataset: FilterEvaluationDataset = {
      pages: [],
      events: [
        event("bool", "value", 10, "s-a", "u-a", { value: false }),
        event("bool-true", "value", 15, "s-a", "u-a", { value: true }),
        event("number", "value", 20, "s-a", "u-a", { value: 0 }),
      ],
      coverageRange: { startMs: 0, endExclusiveMs: 100 },
    };
    const result = evaluateFilterDocument(
      parseFilterDsl(
        'first(event.payload("/value")) eq false',
        analyticsFilterRegistry,
      ),
      dataset,
      {
        scope: "visitor",
        candidateRange: { startMs: 0, endExclusiveMs: 100 },
        reportingTimeZone: "UTC",
        capturedAtMs: 80,
      },
    );
    expect(result.matchingScopeEntityIds).toEqual(new Set(["u-a"]));
    expect(
      evaluateFilterDocument(
        parseFilterDsl(
          'min(event.payload("/value")) eq false',
          analyticsFilterRegistry,
        ),
        dataset,
        {
          scope: "visitor",
          candidateRange: { startMs: 0, endExclusiveMs: 100 },
          reportingTimeZone: "UTC",
          capturedAtMs: 80,
        },
      ).matchingScopeEntityIds,
    ).toEqual(new Set(["u-a"]));
  });

  it("exposes sequence steps and preserves sequence identity in reducers", () => {
    const dataset: FilterEvaluationDataset = {
      pages: [page("candidate", 10, "s-a", "u-a")],
      events: [
        event("signup", "signup", 20, "s-a", "u-a"),
        event("purchase", "purchase", 30, "s-a", "u-a"),
      ],
      coverageRange: { startMs: 0, endExclusiveMs: 100 },
    };
    const sequence =
      'sequence([event { event.name eq "signup" }, event { event.name eq "purchase" }])';
    const result = evaluateFilterDocument(
      parseFilterDsl(
        `count(first(${sequence}).steps) eq 2`,
        analyticsFilterRegistry,
      ),
      dataset,
      {
        scope: "visitor",
        candidateRange: { startMs: 0, endExclusiveMs: 100 },
        reportingTimeZone: "UTC",
        capturedAtMs: 80,
      },
    );
    expect(result.matchingScopeEntityIds).toEqual(new Set(["u-a"]));
  });

  it("buckets ISO datetime payloads without coercing their values", () => {
    const dataset: FilterEvaluationDataset = {
      pages: [],
      events: [
        event("at-a", "timestamp", 10, "s-a", "u-a", {
          at: "1970-01-01T00:00:00.010Z",
        }),
        event("at-b", "timestamp", 20, "s-a", "u-a", {
          at: "1970-01-01T12:00:00.020Z",
        }),
      ],
      coverageRange: { startMs: 0, endExclusiveMs: 100_000_000 },
    };
    const result = evaluateFilterDocument(
      parseFilterDsl(
        'count(bucket(event.payload("/at"), 1d)) eq 2',
        analyticsFilterRegistry,
      ),
      dataset,
      {
        scope: "visitor",
        candidateRange: { startMs: 0, endExclusiveMs: 100_000_000 },
        reportingTimeZone: "UTC",
        capturedAtMs: 80_000_000,
      },
    );
    expect(result.matchingScopeEntityIds).toEqual(new Set(["u-a"]));
  });

  it("resolves bare Page and Event time members in their native domains", () => {
    const dataset: FilterEvaluationDataset = {
      pages: [page("page-time", 10, "s-a", "u-a")],
      events: [event("event-time", "purchase", 20, "s-a", "u-a")],
      coverageRange: { startMs: 0, endExclusiveMs: 100 },
    };
    const result = evaluateFilterDocument(
      parseFilterDsl(
        'page.time eq "1970-01-01T00:00:00.010Z" AND event.time eq "1970-01-01T00:00:00.020Z"',
        analyticsFilterRegistry,
      ),
      dataset,
      {
        scope: "visitor",
        candidateRange: { startMs: 0, endExclusiveMs: 100 },
        reportingTimeZone: "UTC",
        capturedAtMs: 80,
      },
    );
    expect(result.matchingScopeEntityIds).toEqual(new Set(["u-a"]));
  });

  it("evaluates duration and request-clock range endpoints as typed values", () => {
    expect(
      evaluate(
        'sub(first(event { event.name eq "purchase" }).time, first(event { event.name eq "signup" }).time) eq 17ms',
        "visitor",
      ).matchingScopeEntityIds,
    ).toEqual(new Set(["u-a"]));
    expect(
      evaluate(
        "sub(last(event).time, first(page).time) between [0d, 30d]",
        "visitor",
      ).matchingScopeEntityIds,
    ).toEqual(new Set(["u-a", "u-b"]));
    expect(
      evaluate("time between [@now-30d, @now]", "event").matchingEventIds,
    ).toEqual(
      new Set([
        "a-cancel-before",
        "a-signup",
        "a-purchase-low",
        "a-purchase-high",
        "b-signup",
        "b-purchase",
      ]),
    );
  });

  it("keeps legacy string operator behavior equal when Advanced forces the evaluator", () => {
    const dataset: FilterEvaluationDataset = {
      pages: [page("page", 10, "s-a", "u-a", "/docs")],
      events: [event("event", "purchase", 11, "s-a", "u-a")],
      coverageRange: { startMs: 0, endExclusiveMs: 100 },
    };
    const options = {
      scope: "visitor" as const,
      candidateRange: { startMs: 0, endExclusiveMs: 100 },
      reportingTimeZone: "UTC",
      capturedAtMs: 80,
    };
    const legacy = evaluateFilterDocument(
      parseFilterDsl('page.path startsWith "/Docs"', analyticsFilterRegistry),
      dataset,
      options,
    );
    const advanced = evaluateFilterDocument(
      parseFilterDsl(
        'page.path startsWith "/Docs" AND count(event) gte 0',
        analyticsFilterRegistry,
      ),
      dataset,
      options,
    );
    expect(advanced.matchingScopeEntityIds).toEqual(
      legacy.matchingScopeEntityIds,
    );
  });

  it("keeps every Legacy operator stable when combined with an Advanced expression", () => {
    const dataset: FilterEvaluationDataset = {
      pages: [
        page(
          "matrix-page-a",
          10,
          "matrix-session",
          "matrix-visitor",
          "/Docs/start",
        ),
        page(
          "matrix-page-b",
          20,
          "matrix-session",
          "matrix-visitor",
          "/pricing",
        ),
      ].map((record, index) => ({
        ...record,
        fields: {
          ...record.fields,
          "page.durationMs": 5 + index,
          "page.title": index === 0 ? "" : "Pricing",
        },
      })),
      events: [
        event(
          "matrix-event",
          "purchase",
          15,
          "matrix-session",
          "matrix-visitor",
        ),
      ],
      coverageRange: { startMs: 0, endExclusiveMs: 100 },
    };
    const conditions = [
      'page.path eq "/Docs/start"',
      'page.path neq "/elsewhere"',
      'page.path in ["/Docs/start", "/pricing"]',
      'page.path notIn ["/elsewhere"]',
      'page.path contains "Docs"',
      'page.path startsWith "/Docs"',
      'page.path endsWith "start"',
      "page.durationMs gt 5",
      "page.durationMs gte 5",
      "page.durationMs lt 7",
      "page.durationMs lte 6",
      "page.durationMs between [5, 6]",
      "page.path exists",
      "page.path notExists",
      "page.path isNull",
      "page.path notNull",
      "page.title isEmpty",
      "page.title notEmpty",
    ];
    const options = {
      scope: "visitor" as const,
      candidateRange: { startMs: 0, endExclusiveMs: 100 },
      reportingTimeZone: "UTC",
      capturedAtMs: 80,
    };

    for (const condition of conditions) {
      const legacy = evaluateFilterDocument(
        parseFilterDsl(condition, analyticsFilterRegistry),
        dataset,
        options,
      );
      const advanced = evaluateFilterDocument(
        parseFilterDsl(
          `${condition} AND count(event) gte 0`,
          analyticsFilterRegistry,
        ),
        dataset,
        options,
      );
      expect(advanced.matchingScopeEntityIds, condition).toEqual(
        legacy.matchingScopeEntityIds,
      );
    }
  });

  it("allows a Visitor relation to cross sessions but keeps Session relations local", () => {
    const dataset: FilterEvaluationDataset = {
      pages: [],
      events: [
        event("signup", "signup", 10, "session-a", "visitor-a"),
        event("purchase", "purchase", 20, "session-b", "visitor-a"),
      ],
      coverageRange: { startMs: 0, endExclusiveMs: 100 },
    };
    const visitorResult = evaluateFilterDocument(
      parseFilterDsl(
        'visitor { sequence([event { event.name eq "signup" }, event { event.name eq "purchase" }]) exists } exists',
        analyticsFilterRegistry,
      ),
      dataset,
      {
        scope: "visitor",
        candidateRange: { startMs: 0, endExclusiveMs: 100 },
        reportingTimeZone: "UTC",
        capturedAtMs: 80,
      },
    );
    const sessionResult = evaluateFilterDocument(
      parseFilterDsl(
        'session { sequence([event { event.name eq "signup" }, event { event.name eq "purchase" }]) exists } exists',
        analyticsFilterRegistry,
      ),
      dataset,
      {
        scope: "session",
        candidateRange: { startMs: 0, endExclusiveMs: 100 },
        reportingTimeZone: "UTC",
        capturedAtMs: 80,
      },
    );
    const nestedSessionResult = evaluateFilterDocument(
      parseFilterDsl(
        'visitor { session { event { event.name eq "signup" } exists AND event { event.name eq "purchase" } exists } exists } exists',
        analyticsFilterRegistry,
      ),
      dataset,
      {
        scope: "visitor",
        candidateRange: { startMs: 0, endExclusiveMs: 100 },
        reportingTimeZone: "UTC",
        capturedAtMs: 80,
      },
    );
    expect(visitorResult.matchingScopeEntityIds).toEqual(
      new Set(["visitor-a"]),
    );
    expect(sessionResult.matchingScopeEntityIds).toEqual(new Set());
    expect(nestedSessionResult.matchingScopeEntityIds).toEqual(new Set());
  });

  it("keeps the resolved relation anchor through nested Event selectors", () => {
    const dataset: FilterEvaluationDataset = {
      pages: [],
      events: [
        event("signup", "signup", 10, "session-a", "visitor-a"),
        event("purchase", "purchase", 20, "session-b", "visitor-a"),
      ],
      coverageRange: { startMs: 0, endExclusiveMs: 100 },
    };
    const document = parseFilterDsl(
      'event { event.name eq "signup" AND sequence([event { event.name eq "signup" }, event { event.name eq "purchase" }]) exists } exists',
      analyticsFilterRegistry,
    );
    const result = evaluateFilterDocument(document, dataset, {
      scope: "visitor",
      candidateRange: { startMs: 0, endExclusiveMs: 100 },
      reportingTimeZone: "UTC",
      capturedAtMs: 80,
    });

    expect(result.matchingScopeEntityIds).toEqual(new Set(["visitor-a"]));
  });

  it("rejects root Relations when evaluated in Event Scope", () => {
    const document = parseFilterDsl(
      'sequence([event { event.name eq "signup" }, event { event.name eq "purchase" }]) exists',
      analyticsFilterRegistry,
    );

    expect(() =>
      evaluateFilterDocument(document, fixture, {
        scope: "event",
        candidateRange: { startMs: 0, endExclusiveMs: 100 },
        reportingTimeZone: "UTC",
        capturedAtMs: 80,
      }),
    ).toThrow(
      expect.objectContaining({
        code: "relation_requires_session_or_visitor_scope",
      }),
    );
  });

  it("evaluates the complete visitor Core and Relation DSL sample", () => {
    const day = 86_400_000;
    const visitorId = "visitor-sample";
    const pageRows = [
      page("first-page", 0, "session-1", visitorId, "/first"),
      ...Array.from({ length: 20 }, (_, index) =>
        page(
          `bucket-page-${index}`,
          (60 + index) * day,
          `session-${(index % 4) + 1}`,
          visitorId,
          `/bucket-${index}`,
        ),
      ),
      page("last-page", 90 * day, "session-4", visitorId, "/last"),
    ].map((record) => ({
      ...record,
      fields: {
        ...record.fields,
        "referrer.domain": "google.com",
        "geo.country": "US",
        "client.deviceType": "desktop",
      },
    }));
    const purchases = [
      ["purchase-1", 33, "session-1", 600, "product-a"],
      ["purchase-2", 40, "session-2", 600, "product-b"],
      ["purchase-3", 45, "session-3", 500, "product-c"],
      ["purchase-4", 50, "session-1", 100, "product-d"],
      ["purchase-5", 55, "session-2", 100, "product-e"],
    ] as const;
    const eventRows: FilterEvaluationEntity[] = [
      event("signup", "signup", 30 * day, "session-1", visitorId),
      event(
        "project-created",
        "project_created",
        31 * day,
        "session-1",
        visitorId,
      ),
      event(
        "first-team-event",
        "first_team_event",
        32 * day,
        "session-1",
        visitorId,
      ),
      event("invite-sent", "invite_sent", 32 * day, "session-1", visitorId),
      ...purchases.map(([id, atDay, sessionId, amount, productId]) =>
        event(id, "purchase", atDay * day, sessionId, visitorId, {
          currency: "USD",
          amount,
          productId,
        }),
      ),
      ...[35, 36, 37].map((atDay, index) =>
        event(
          `insight-saved-${index + 1}`,
          "insight_saved",
          atDay * day,
          "session-2",
          visitorId,
        ),
      ),
      ...[20, 21, 22, 27, 28, 29, 34, 35, 36].map((atDay, index) =>
        event(
          `shared-insight-${index + 1}`,
          "shared_insight",
          atDay * day,
          `session-${(index % 3) + 1}`,
          visitorId,
        ),
      ),
      event("refund", "refund", 56 * day, "session-3", visitorId, {
        amount: 100,
      }),
      event("api-request", "api_request", 77 * day, "session-3", visitorId, {
        latency: 300,
      }),
      event(
        "old-cancellation",
        "cancellation",
        29 * day,
        "session-1",
        visitorId,
      ),
      event("failed-1", "payment_failed", 70 * day, "session-4", visitorId),
      event("failed-2", "payment_failed", 71 * day, "session-4", visitorId),
    ].map((record) => ({
      ...record,
      fields: {
        ...record.fields,
        "geo.country": "US",
        "client.deviceType": "desktop",
      },
    }));
    const dataset: FilterEvaluationDataset = {
      pages: pageRows,
      events: eventRows,
      coverageRange: { startMs: 0, endExclusiveMs: 101 * day },
    };
    const dsl = `
      geo.country in ["US", "GB", "CA"]
      AND client.deviceType neq "bot"
      AND event {
        event.name eq "purchase"
        AND event.payload("/currency") eq "USD"
        AND event.payload("/amount") gt 0
      } exists
      AND event { event.name eq "fraud_flag" } notExists
      AND count(event {
        event.name eq "purchase"
        AND event.payload("/currency") eq "USD"
        AND event.payload("/amount") gt 0
        AND time gte @now-90d
      }) gte 5
      AND countDistinct(event {
        event.name eq "purchase"
        AND time gte @now-90d
      }.payload("/productId")) gte 3
      AND countDistinct(bucket(page { time gte @now-90d }.time, 1d)) gte 20
      AND sub(
        sum(event { event.name eq "purchase" AND time gte @now-90d }.payload("/amount")),
        sum(event { event.name eq "refund" AND time gte @now-90d }.payload("/amount"))
      ) gt 1000
      AND div(
        sum(event { event.name eq "refund" AND time gte @now-90d }.payload("/amount")),
        sum(event { event.name eq "purchase" AND time gte @now-90d }.payload("/amount"))
      ) lt 0.3
      AND avg(event {
        event.name eq "api_request"
        AND event.payload("/latency") exists
        AND time gte @now-30d
      }.payload("/latency")) lt 500
      AND first(page).referrer.domain eq "google.com"
      AND last(page).time gte @now-14d
      AND sub(
        first(event { event.name eq "first_team_event" }).time,
        first(event { event.name eq "signup" }).time
      ) between [0d, 30d]
      AND sub(
        nth(event { event.name eq "insight_saved" }, 3).time,
        first(event { event.name eq "signup" }).time
      ) between [0d, 30d]
      AND count(session) gte 4
      AND div(
        count(session { event { event.name eq "purchase" } exists }),
        count(session)
      ) gt 0.5
      AND count(periods(
        event { event.name eq "shared_insight" AND time gte @now-12w },
        1w
      ) { count(period.items) gte 3 }) gte 3
      AND sequence([
        event { event.name eq "signup" },
        event { event.name eq "project_created" },
        event { event.name eq "invite_sent" },
        event { event.name eq "purchase" }
      ]) { sequence.span lte 14d } exists
      AND without(
        sequence([
          event { event.name eq "signup" },
          event { event.name eq "purchase" }
        ]),
        event { event.name eq "cancellation" }
      ) { sequence.span lte 7d } exists
      AND count(session {
        count(event { event.name eq "payment_failed" }) gte 2
        AND event { event.name eq "purchase" } notExists
      }) lte 1
    `;
    const result = evaluateFilterDocument(
      parseFilterDsl(dsl, analyticsFilterRegistry),
      dataset,
      {
        scope: "visitor",
        candidateRange: { startMs: 0, endExclusiveMs: 101 * day },
        reportingTimeZone: "UTC",
        capturedAtMs: 100 * day,
      },
    );

    expect([...result.matchingScopeEntityIds]).toEqual([visitorId]);
  });

  it("distinguishes explicit JSON null from a missing payload path", () => {
    expect(
      evaluate(
        'event { event.payload("/explicitNull") isNull } exists',
        "session",
      ).matchingScopeEntityIds,
    ).toEqual(new Set(["s-a"]));
    expect(
      evaluate(
        'event { event.payload("/explicitNull") notExists } exists',
        "session",
      ).matchingScopeEntityIds,
    ).toEqual(new Set(["s-a", "s-b"]));
  });

  it("preserves explicit null through projections and first", () => {
    expect(
      evaluate('first(event.payload("/explicitNull")) isNull', "session")
        .matchingScopeEntityIds,
    ).toEqual(new Set(["s-a"]));
  });

  it("applies the registered string operators to event fields", () => {
    const cases = [
      [
        'event.name eq "purchase"',
        ["a-purchase-low", "a-purchase-high", "b-purchase"],
      ],
      [
        'event.name neq "purchase"',
        ["a-signup", "a-cancel-before", "b-signup"],
      ],
      [
        'event.name in ["signup", "purchase"]',
        [
          "a-signup",
          "a-purchase-low",
          "a-purchase-high",
          "b-signup",
          "b-purchase",
        ],
      ],
      [
        'event.name notIn ["purchase"]',
        ["a-signup", "a-cancel-before", "b-signup"],
      ],
      [
        'event.name contains "has"',
        ["a-purchase-low", "a-purchase-high", "b-purchase"],
      ],
      [
        'event.name startsWith "pur"',
        ["a-purchase-low", "a-purchase-high", "b-purchase"],
      ],
      [
        'event.name endsWith "ase"',
        ["a-purchase-low", "a-purchase-high", "b-purchase"],
      ],
    ] as const;

    for (const [source, expected] of cases) {
      expect(evaluate(source, "event").matchingEventIds).toEqual(
        new Set(expected),
      );
    }
  });

  it("compares dynamic payload scalars and decodes escaped JSON pointers", () => {
    const dataset: FilterEvaluationDataset = {
      pages: [],
      events: [
        event("one", "value", 10, "s-a", "u-a", {
          score: 1,
          empty: "",
          explicitNull: null,
          "a/b": { "~key": "escaped" },
        }),
        event("two", "value", 20, "s-b", "u-b", {
          score: 2,
          empty: "value",
        }),
        event("missing", "value", 30, "s-c", "u-c", {}),
      ],
      coverageRange: { startMs: 0, endExclusiveMs: 100 },
    };
    const evaluatePayload = (source: string) =>
      evaluateFilterDocument(
        parseFilterDsl(source, analyticsFilterRegistry),
        dataset,
        {
          scope: "event",
          candidateRange: { startMs: 0, endExclusiveMs: 100 },
          reportingTimeZone: "UTC",
          capturedAtMs: 80,
        },
      ).matchingEventIds;

    expect(evaluatePayload('event.payload("/score") between [1, 2]')).toEqual(
      new Set(["one", "two"]),
    );
    expect(evaluatePayload('event.payload("/score") gte 2')).toEqual(
      new Set(["two"]),
    );
    expect(
      evaluatePayload('event.payload("/a~1b/~0key") eq "escaped"'),
    ).toEqual(new Set(["one"]));
    expect(evaluatePayload('event.payload("/empty") isEmpty')).toEqual(
      new Set(["one"]),
    );
    expect(evaluatePayload('event.payload("/empty") notEmpty')).toEqual(
      new Set(["two"]),
    );
    expect(evaluatePayload('event.payload("/explicitNull") exists')).toEqual(
      new Set(["one"]),
    );
    expect(evaluatePayload('event.payload("/explicitNull") notExists')).toEqual(
      new Set(["two", "missing"]),
    );
    expect(evaluatePayload('event.payload("/score") notNull')).toEqual(
      new Set(["one", "two"]),
    );
  });

  it("derives session and visitor facts from mixed page and event activity", () => {
    const dataset: FilterEvaluationDataset = {
      pages: [
        {
          ...page("entry", 100, "s-a", "u-a", "/entry"),
          fields: { "page.path": "/entry", "page.durationMs": 40 },
        },
        {
          ...page("exit", 200, "s-a", "u-a", "/exit"),
          fields: { "page.path": "/exit", "page.durationMs": 60 },
        },
        page("bounce", 300, "s-b", "u-a", "/bounce"),
        page("orphan", 350, "", "", "/orphan"),
      ],
      events: [
        event("first", "signup", 150, "s-a", "u-a"),
        event("second", "purchase", 190, "s-a", "u-a"),
      ],
      coverageRange: { startMs: 0, endExclusiveMs: 500 },
    };
    const options = {
      candidateRange: { startMs: 0, endExclusiveMs: 500 },
      reportingTimeZone: "UTC",
      capturedAtMs: 400,
    } as const;
    const sessions = evaluateFilterDocument(
      parseFilterDsl(
        'session { session.views eq 2 AND session.events eq 2 AND session.durationMs eq 100 AND session.entryPath eq "/entry" AND session.exitPath eq "/exit" AND session.bounce eq false } exists',
        analyticsFilterRegistry,
      ),
      dataset,
      { ...options, scope: "session" },
    );
    const visitors = evaluateFilterDocument(
      parseFilterDsl(
        "visitor { visitor.sessions eq 2 AND visitor.views eq 3 AND visitor.events eq 2 } exists",
        analyticsFilterRegistry,
      ),
      dataset,
      { ...options, scope: "visitor" },
    );
    const bounces = evaluateFilterDocument(
      parseFilterDsl(
        "session { session.bounce eq true } exists",
        analyticsFilterRegistry,
      ),
      dataset,
      { ...options, scope: "session" },
    );

    expect(sessions.matchingScopeEntityIds).toEqual(new Set(["s-a"]));
    expect(visitors.matchingScopeEntityIds).toEqual(new Set(["u-a"]));
    expect(bounces.matchingScopeEntityIds).toEqual(new Set(["s-b"]));
  });

  it("evaluates the complete operator matrix over typed payload and event values", () => {
    const dataset: FilterEvaluationDataset = {
      pages: [],
      events: [
        event("matrix", "purchase", 10, "session-a", "visitor-a", {
          number: 5,
          text: "Alpha Beta",
          nullish: null,
          empty: "",
        }),
      ],
      coverageRange: { startMs: 0, endExclusiveMs: 100 },
    };
    const expressions = [
      'event.payload("/number") exists',
      'event.payload("/missing") notExists',
      'event.payload("/nullish") isNull',
      'event.payload("/number") notNull',
      'event.payload("/empty") isEmpty',
      'event.payload("/text") notEmpty',
      'event.payload("/number") eq 5',
      'event.payload("/number") neq 4',
      'event.payload("/number") in [3, 5]',
      'event.payload("/number") notIn [3, 4]',
      'event.payload("/number") between [1, 5]',
      'event.name contains "rch"',
      'event.name startsWith "pur"',
      'event.name endsWith "ase"',
      'event.payload("/number") gt 4',
      'event.payload("/number") gte 5',
      'event.payload("/number") lt 6',
      'event.payload("/number") lte 5',
    ];

    for (const source of expressions) {
      const result = evaluateFilterDocument(
        parseFilterDsl(source, analyticsFilterRegistry),
        dataset,
        {
          scope: "event",
          candidateRange: { startMs: 0, endExclusiveMs: 100 },
          reportingTimeZone: "UTC",
          capturedAtMs: 80,
        },
      );
      expect(result.matchingEventIds, source).toEqual(new Set(["matrix"]));
    }
  });

  it("distinguishes missing, null, empty, mismatched, and target-comparison values", () => {
    const dataset: FilterEvaluationDataset = {
      pages: [page("page", 10, "s-number", "u-number")],
      events: [
        event("number", "purchase", 10, "s-number", "u-number", {
          value: 2,
          empty: "",
          nullish: null,
          array: [],
          text: "Alpha",
          expected: "purchase",
        }),
        event("string", "purchase", 20, "s-string", "u-string", {
          value: "2",
          text: "Beta",
          expected: "signup",
        }),
        event("missing", "other", 30, "s-missing", "u-missing", {}),
        {
          ...event("region", "visit", 40, "s-region", "u-region"),
          fields: { "event.name": "visit", "geo.region": " California " },
        },
      ],
      coverageRange: { startMs: 0, endExclusiveMs: 100 },
    };
    const cases = [
      [
        'event.payload("/missing") notExists',
        ["number", "string", "missing", "region"],
      ],
      ['event.payload("/nullish") isNull', ["number"]],
      ['event.payload("/value") notNull', ["number", "string"]],
      ['event.payload("/empty") isEmpty', ["number"]],
      ['event.payload("/text") notEmpty', ["number", "string"]],
      ['event.payload("/array") exists', []],
      [
        'event.payload("/array") notExists',
        ["number", "string", "missing", "region"],
      ],
      ['event.payload("/value") eq 2', ["number"]],
      ['event.payload("/value") neq 2', ["string"]],
      ['event.payload("/value") in [1, 2]', ["number"]],
      ['event.payload("/value") notIn [1]', ["number", "string"]],
      ['event.payload("/value") contains "2"', ["string"]],
      ['event.payload("/text") startsWith "Al"', ["number"]],
      ['event.payload("/text") endsWith "ta"', ["string"]],
      ['event.payload("/value") gt 3', []],
      ['event.name eq "purchase"', ["number", "string"]],
    ] as const;

    for (const [source, expected] of cases) {
      const result = evaluateFilterDocument(
        parseFilterDsl(source, analyticsFilterRegistry),
        dataset,
        {
          scope: "event",
          candidateRange: { startMs: 0, endExclusiveMs: 100 },
          reportingTimeZone: "UTC",
          capturedAtMs: 80,
        },
      );
      expect(result.matchingEventIds, source).toEqual(new Set(expected));
    }

    const caseInsensitive = evaluateFilterDocument(
      parseFilterDsl('geo.region eq "california"', analyticsFilterRegistry),
      dataset,
      {
        scope: "event",
        candidateRange: { startMs: 0, endExclusiveMs: 100 },
        reportingTimeZone: "UTC",
        capturedAtMs: 80,
      },
    );
    expect(caseInsensitive.matchingEventIds).toEqual(new Set(["region"]));
  });

  it("evaluates sequence and bucket members and respects supplied aggregate facts", () => {
    const dataset: FilterEvaluationDataset = {
      pages: [
        page("page-a", 10, "session-a", "visitor-a"),
        page("page-b", 25, "session-a", "visitor-a"),
      ],
      events: [
        event("signup", "signup", 10, "session-a", "visitor-a"),
        event("purchase", "purchase", 30, "session-a", "visitor-a"),
      ],
      sessions: [
        {
          kind: "session",
          id: "session-a",
          sessionId: "session-a",
          visitorId: "visitor-a",
          time: 10,
          fields: { "session.durationMs": 999 },
        },
      ],
      visitors: [
        {
          kind: "visitor",
          id: "visitor-a",
          visitorId: "visitor-a",
          time: 10,
          fields: { "visitor.sessions": 7 },
        },
      ],
      coverageRange: { startMs: 0, endExclusiveMs: 100 },
    };
    const options = {
      candidateRange: { startMs: 0, endExclusiveMs: 100 },
      reportingTimeZone: "UTC",
      capturedAtMs: 80,
    } as const;
    const sequence = evaluateFilterDocument(
      parseFilterDsl(
        'visitor { sequence([event { event.name eq "signup" }, event { event.name eq "purchase" }]) { sequence.start gte "1970-01-01T00:00:00.010Z" AND sequence.end lte "1970-01-01T00:00:00.040Z" AND sequence.span gte 20ms } exists } exists',
        analyticsFilterRegistry,
      ),
      dataset,
      { ...options, scope: "visitor" },
    );
    const bucket = evaluateFilterDocument(
      parseFilterDsl(
        'countDistinct(bucket(page.time, 1d) { bucket.start eq "1970-01-01T00:00:00.000Z" AND bucket.end eq "1970-01-02T00:00:00.000Z" }) eq 1',
        analyticsFilterRegistry,
      ),
      dataset,
      { ...options, scope: "visitor" },
    );
    const session = evaluateFilterDocument(
      parseFilterDsl(
        "session { session.durationMs eq 999 } exists",
        analyticsFilterRegistry,
      ),
      dataset,
      { ...options, scope: "session" },
    );
    const visitor = evaluateFilterDocument(
      parseFilterDsl(
        "visitor { visitor.sessions eq 7 } exists",
        analyticsFilterRegistry,
      ),
      dataset,
      { ...options, scope: "visitor" },
    );
    const nestedMember = evaluateFilterDocument(
      parseFilterDsl(
        "count(page.client.browser) eq 2",
        analyticsFilterRegistry,
      ),
      dataset,
      { ...options, scope: "visitor" },
    );

    expect(sequence.matchingScopeEntityIds).toEqual(new Set(["visitor-a"]));
    expect(bucket.matchingScopeEntityIds).toEqual(new Set(["visitor-a"]));
    expect(session.matchingScopeEntityIds).toEqual(new Set(["session-a"]));
    expect(visitor.matchingScopeEntityIds).toEqual(new Set(["visitor-a"]));
    expect(nestedMember.matchingScopeEntityIds).toEqual(new Set(["visitor-a"]));
  });

  it("uses evaluation-range fields inside selectors and candidate fields for legacy predicates", () => {
    const document = parseFilterDsl(
      'count(page { page.path eq "/historical" }) gte 1',
      analyticsFilterRegistry,
    );
    const dataset: FilterEvaluationDataset = {
      pages: [
        {
          ...page("historical", 10, "session-a", "visitor-a"),
          fields: { "page.path": "/historical" },
          candidateFields: { "page.path": "/candidate" },
        },
        {
          ...page("candidate", 60, "session-a", "visitor-a"),
          fields: { "page.path": "/candidate" },
          candidateFields: { "page.path": "/candidate" },
        },
      ],
      events: [],
      coverageRange: { startMs: 0, endExclusiveMs: 100 },
    };
    const options = {
      scope: "session" as const,
      candidateRange: { startMs: 50, endExclusiveMs: 70 },
      evaluationRange: { startMs: 0, endExclusiveMs: 40 },
      reportingTimeZone: "UTC",
      capturedAtMs: 80,
    };
    expect(
      evaluateFilterDocument(document, dataset, options).matchingScopeEntityIds,
    ).toEqual(new Set(["session-a"]));
    expect(
      evaluateFilterDocument(
        parseFilterDsl('page.path eq "/candidate"', analyticsFilterRegistry),
        dataset,
        options,
      ).matchingScopeEntityIds,
    ).toEqual(new Set(["session-a"]));
  });

  it("evaluates relative anchors from the fixed request clock and candidate range", () => {
    const result = evaluate(
      '(@now eq "1970-01-01T00:00:00.080Z" AND @now-10ms eq "1970-01-01T00:00:00.070Z") AND @range.start eq "1970-01-01T00:00:00.000Z" AND @range.end eq "1970-01-01T00:00:00.100Z"',
    );

    expect(result.matchingScopeEntityIds).toEqual(new Set(["u-a", "u-b"]));
  });

  it("orders activity collections chronologically before positional reducers", () => {
    const dataset: FilterEvaluationDataset = {
      // Deliberately use generator order rather than event time order.
      pages: [
        page("late-page", 30, "session-a", "visitor-a", "/late"),
        page("early-page", 10, "session-a", "visitor-a", "/early"),
        page("middle-page", 20, "session-a", "visitor-a", "/middle"),
      ],
      events: [
        event("late-event", "third", 30, "session-a", "visitor-a"),
        event("early-event", "first", 10, "session-a", "visitor-a"),
        event("middle-event", "second", 20, "session-a", "visitor-a"),
      ],
      coverageRange: { startMs: 0, endExclusiveMs: 100 },
    };
    const result = evaluateFilterDocument(
      parseFilterDsl(
        'first(page).path eq "/early" AND last(page).path eq "/late" AND nth(event, 3).name eq "third"',
        analyticsFilterRegistry,
      ),
      dataset,
      {
        scope: "visitor",
        candidateRange: { startMs: 0, endExclusiveMs: 100 },
        reportingTimeZone: "UTC",
        capturedAtMs: 80,
      },
    );

    expect(result.matchingScopeEntityIds).toEqual(new Set(["visitor-a"]));
  });

  it("orders page and event activity together for adjacent sequences", () => {
    const result = evaluate(
      'visitor { session { adjacent(sequence([event { event.name eq "signup" }, event { event.name eq "purchase" }])) exists } exists } exists',
    );
    // The Page at t=25 interrupts the signup-to-purchase activity sequence.
    expect(result.matchingScopeEntityIds).toEqual(new Set(["u-b"]));
  });

  it("orders same-millisecond Page before Event regardless of their ids", () => {
    const dataset: FilterEvaluationDataset = {
      pages: [page("z-page", 10, "session-a", "visitor-a", "/same")],
      events: [event("a-event", "purchase", 10, "session-a", "visitor-a")],
      coverageRange: { startMs: 0, endExclusiveMs: 100 },
    };
    const options = {
      scope: "visitor" as const,
      candidateRange: { startMs: 0, endExclusiveMs: 100 },
      reportingTimeZone: "UTC",
      capturedAtMs: 80,
    };
    const pageThenEvent = evaluateFilterDocument(
      parseFilterDsl(
        'visitor { session { adjacent(sequence([page { page.path eq "/same" }, event { event.name eq "purchase" }])) exists } exists } exists',
        analyticsFilterRegistry,
      ),
      dataset,
      options,
    );
    const eventThenPage = evaluateFilterDocument(
      parseFilterDsl(
        'visitor { session { sequence([event { event.name eq "purchase" }, page { page.path eq "/same" }]) exists } exists } exists',
        analyticsFilterRegistry,
      ),
      dataset,
      options,
    );
    expect(pageThenEvent.matchingScopeEntityIds).toEqual(
      new Set(["visitor-a"]),
    );
    expect(eventThenPage.matchingScopeEntityIds).toEqual(new Set());
  });

  it("uses empty-collection reducer and division-by-zero semantics", () => {
    const dataset: FilterEvaluationDataset = {
      pages: [page("candidate", 10, "session-a", "visitor-a")],
      events: [],
      coverageRange: { startMs: 0, endExclusiveMs: 100 },
    };
    const result = evaluateFilterDocument(
      parseFilterDsl(
        'count(event) eq 0 AND sum(event.payload("/amount")) eq 0 AND avg(event.payload("/amount")) isNull AND min(event.payload("/amount")) isNull AND max(event.payload("/amount")) isNull AND first(event) notExists AND last(page) exists AND nth(event, 2) notExists AND countDistinct(event.payload("/amount")) eq 0 AND div(count(event), count(event)) isNull',
        analyticsFilterRegistry,
      ),
      dataset,
      {
        scope: "visitor",
        candidateRange: { startMs: 0, endExclusiveMs: 100 },
        reportingTimeZone: "UTC",
        capturedAtMs: 80,
      },
    );
    expect(result.matchingScopeEntityIds).toEqual(new Set(["visitor-a"]));
  });

  it("evaluates reducers over non-empty projected event values", () => {
    const cases = [
      [
        'sum(event { event.name eq "purchase" }.payload("/amount")) eq 55',
        ["s-a"],
      ],
      [
        'avg(event { event.name eq "purchase" }.payload("/amount")) eq 27.5',
        ["s-a"],
      ],
      [
        'min(event { event.name eq "purchase" }.payload("/amount")) eq 5',
        ["s-a"],
      ],
      [
        'max(event { event.name eq "purchase" }.payload("/amount")) eq 50',
        ["s-a"],
      ],
      [
        'first(event { event.name eq "purchase" }.payload("/amount")) eq 5',
        ["s-a"],
      ],
      [
        'last(event { event.name eq "purchase" }.payload("/amount")) eq 50',
        ["s-a"],
      ],
      [
        'nth(event { event.name eq "purchase" }.payload("/amount"), 2) eq 50',
        ["s-a"],
      ],
      [
        'countDistinct(event { event.name eq "purchase" }.payload("/amount")) eq 2',
        ["s-a"],
      ],
    ] as const;

    for (const [source, expected] of cases) {
      expect(evaluate(source, "session").matchingScopeEntityIds).toEqual(
        new Set(expected),
      );
    }
  });

  it("evaluates arithmetic over reducer results", () => {
    const result = evaluate(
      "add(count(event), count(event)) eq 8 AND mul(count(event), count(event)) eq 16 AND div(count(event), count(event)) eq 1",
    );
    expect(result.matchingScopeEntityIds).toEqual(new Set(["u-a"]));
  });

  it("does not coerce dynamic payload strings into numbers", () => {
    const dataset: FilterEvaluationDataset = {
      pages: [],
      events: [
        event("number", "value", 10, "session-number", "visitor-number", {
          value: 7,
        }),
        event("string", "value", 11, "session-string", "visitor-string", {
          value: "7",
        }),
        event("null", "value", 12, "session-null", "visitor-null", {
          value: null,
        }),
        event("missing", "value", 13, "session-missing", "visitor-missing"),
      ],
      coverageRange: { startMs: 0, endExclusiveMs: 100 },
    };
    const result = evaluateFilterDocument(
      parseFilterDsl('event.payload("/value") eq 7', analyticsFilterRegistry),
      dataset,
      {
        scope: "event",
        candidateRange: { startMs: 0, endExclusiveMs: 100 },
        reportingTimeZone: "UTC",
        capturedAtMs: 80,
      },
    );
    expect(result.matchingEventIds).toEqual(new Set(["number"]));
  });

  it("uses half-open ranges for both candidates and evaluated activities", () => {
    const dataset: FilterEvaluationDataset = {
      pages: [page("candidate", 10, "session-a", "visitor-a")],
      events: [event("at-end", "purchase", 20, "session-a", "visitor-a")],
      coverageRange: { startMs: 0, endExclusiveMs: 100 },
    };
    const result = evaluateFilterDocument(
      parseFilterDsl("count(event) eq 0", analyticsFilterRegistry),
      dataset,
      {
        scope: "visitor",
        candidateRange: { startMs: 0, endExclusiveMs: 20 },
        reportingTimeZone: "UTC",
        capturedAtMs: 80,
      },
    );
    expect(result.matchingScopeEntityIds).toEqual(new Set(["visitor-a"]));
    expect(result.matchingEventIds).toEqual(new Set());
  });

  it("uses reporting-timezone DST boundaries for calendar day buckets", () => {
    const assertBucketLength = (timestamp: number, expected: string) => {
      const dataset: FilterEvaluationDataset = {
        pages: [page("candidate", timestamp, "session-a", "visitor-a")],
        events: [],
        coverageRange: {
          startMs: timestamp - 1,
          endExclusiveMs: timestamp + 1,
        },
      };
      const expressions = [
        `sub(first(bucket(page.time, 1d)).end, first(bucket(page.time, 1d)).start) eq ${expected}`,
        `sub(first(periods(page, 1d)).end, first(periods(page, 1d)).start) eq ${expected}`,
      ];
      for (const expression of expressions) {
        const result = evaluateFilterDocument(
          parseFilterDsl(expression, analyticsFilterRegistry),
          dataset,
          {
            scope: "visitor",
            candidateRange: {
              startMs: timestamp - 1,
              endExclusiveMs: timestamp + 1,
            },
            reportingTimeZone: "America/Los_Angeles",
            capturedAtMs: timestamp,
          },
        );
        expect(result.matchingScopeEntityIds).toEqual(new Set(["visitor-a"]));
      }
    };

    // March 8, 2026 is a 23-hour day in Los Angeles; November 1 is 25 hours.
    assertBucketLength(Date.parse("2026-03-08T20:00:00Z"), "23h");
    assertBucketLength(Date.parse("2026-11-01T20:00:00Z"), "25h");
  });

  it("groups hourly, monthly, and yearly periods and exposes period items", () => {
    const january = Date.parse("2024-01-15T12:30:00Z");
    const february = Date.parse("2024-02-15T12:30:00Z");
    const dataset: FilterEvaluationDataset = {
      pages: [
        page("jan-a", january, "s-a", "u-a"),
        page("jan-b", january + 1, "s-a", "u-a"),
        page("feb", february, "s-a", "u-a"),
      ],
      events: [],
      coverageRange: { startMs: january - 1, endExclusiveMs: february + 1 },
    };
    const options = {
      scope: "visitor" as const,
      candidateRange: { startMs: january - 1, endExclusiveMs: february + 1 },
      reportingTimeZone: "UTC",
      capturedAtMs: february + 1,
    };
    const assertions = [
      ["countDistinct(bucket(page.time, 1h)) eq 2", new Set(["u-a"])],
      ["count(periods(page, 1mo)) eq 2", new Set(["u-a"])],
      [
        "count(periods(page, 1mo) { count(period.items) gte 1 }) eq 2",
        new Set(["u-a"]),
      ],
      ["count(periods(page, 1y)) eq 1", new Set(["u-a"])],
      [
        "sub(first(bucket(page.time, 1y)).end, first(bucket(page.time, 1y)).start) eq 366d",
        new Set(["u-a"]),
      ],
    ] as const;

    for (const [source, expected] of assertions) {
      expect(
        evaluateFilterDocument(
          parseFilterDsl(source, analyticsFilterRegistry),
          dataset,
          options,
        ).matchingScopeEntityIds,
      ).toEqual(expected);
    }
  });

  it("starts natural weeks on Monday in the reporting timezone", () => {
    const sunday = Date.parse("2026-03-08T20:00:00Z");
    const saturday = Date.parse("2026-03-14T20:00:00Z");
    const dataset: FilterEvaluationDataset = {
      pages: [
        page("sunday", sunday, "session-a", "visitor-a"),
        page("saturday", saturday, "session-a", "visitor-a"),
      ],
      events: [],
      coverageRange: { startMs: sunday - 1, endExclusiveMs: saturday + 1 },
    };
    const result = evaluateFilterDocument(
      parseFilterDsl("count(periods(page, 1w)) eq 2", analyticsFilterRegistry),
      dataset,
      {
        scope: "visitor",
        candidateRange: { startMs: sunday - 1, endExclusiveMs: saturday + 1 },
        reportingTimeZone: "America/Los_Angeles",
        capturedAtMs: saturday + 1,
      },
    );
    expect(result.matchingScopeEntityIds).toEqual(new Set(["visitor-a"]));
  });

  it("uses a half-open elapsed window around its datetime anchor", () => {
    const dataset: FilterEvaluationDataset = {
      pages: [page("anchor", 20, "session-a", "visitor-a")],
      events: [
        event("start", "purchase", 10, "session-a", "visitor-a"),
        event("inside", "purchase", 20, "session-a", "visitor-a"),
        event("end", "purchase", 30, "session-a", "visitor-a"),
      ],
      coverageRange: { startMs: 0, endExclusiveMs: 100 },
    };
    const result = evaluateFilterDocument(
      parseFilterDsl(
        'session { count(window(event { event.name eq "purchase" }, first(page).time, [-10ms, 10ms])) eq 2 } exists',
        analyticsFilterRegistry,
      ),
      dataset,
      {
        scope: "session",
        candidateRange: { startMs: 0, endExclusiveMs: 100 },
        reportingTimeZone: "UTC",
        capturedAtMs: 80,
      },
    );
    expect(result.matchingScopeEntityIds).toEqual(new Set(["session-a"]));
  });

  it("checks without only between sequence endpoints", () => {
    const result = evaluate(
      'visitor { session { without(sequence([event { event.name eq "signup" }, event { event.name eq "purchase" }]), event { event.name eq "cancellation" }) exists } exists } exists',
    );
    expect(result.matchingScopeEntityIds).toEqual(new Set(["u-a", "u-b"]));
  });

  it("excludes a behavior only when it occurs between sequence endpoints", () => {
    const dataset: FilterEvaluationDataset = {
      pages: [],
      events: [
        event("signup-a", "signup", 10, "s-a", "u-a"),
        event("cancel-a", "cancellation", 20, "s-a", "u-a"),
        event("purchase-a", "purchase", 30, "s-a", "u-a"),
        event("signup-b", "signup", 10, "s-b", "u-b"),
        event("purchase-b", "purchase", 30, "s-b", "u-b"),
      ],
      coverageRange: { startMs: 0, endExclusiveMs: 100 },
    };
    const result = evaluateFilterDocument(
      parseFilterDsl(
        'visitor { session { without(sequence([event { event.name eq "signup" }, event { event.name eq "purchase" }]), event { event.name eq "cancellation" }) exists } exists } exists',
        analyticsFilterRegistry,
      ),
      dataset,
      {
        scope: "visitor",
        candidateRange: { startMs: 0, endExclusiveMs: 100 },
        reportingTimeZone: "UTC",
        capturedAtMs: 80,
      },
    );
    expect(result.matchingScopeEntityIds).toEqual(new Set(["u-b"]));
  });

  it("rejects relation search work beyond the shared execution budget", () => {
    expect(() =>
      evaluateFilterDocument(
        parseFilterDsl(
          'sequence([event { event.name eq "signup" }, event { event.name eq "purchase" }]) exists',
          analyticsFilterRegistry,
        ),
        fixture,
        {
          scope: "visitor",
          candidateRange: { startMs: 0, endExclusiveMs: 100 },
          reportingTimeZone: "UTC",
          capturedAtMs: 80,
          maxSequenceWork: 1,
        },
      ),
    ).toThrow("filter_sequence_work_limit_exceeded");
  });

  it("rejects an evaluation range outside the declared source coverage", () => {
    expect(() =>
      evaluateFilterDocument(
        parseFilterDsl("count(event) gte 1", analyticsFilterRegistry),
        fixture,
        {
          scope: "visitor",
          candidateRange: { startMs: 10, endExclusiveMs: 20 },
          evaluationRange: { startMs: -1, endExclusiveMs: 20 },
          reportingTimeZone: "UTC",
          capturedAtMs: 80,
        },
      ),
    ).toThrow("filter_evaluation_range_unavailable");
  });

  it("rejects invalid ranges and activity volumes before evaluating", () => {
    const document = parseFilterDsl(
      "count(event) gte 1",
      analyticsFilterRegistry,
    );
    expect(() =>
      evaluateFilterDocument(document, fixture, {
        scope: "visitor",
        candidateRange: { startMs: 10, endExclusiveMs: 10 },
        reportingTimeZone: "UTC",
        capturedAtMs: 80,
      }),
    ).toThrow("invalid_evaluation_range");
    expect(() =>
      evaluateFilterDocument(document, fixture, {
        scope: "visitor",
        candidateRange: { startMs: 0, endExclusiveMs: 100 },
        reportingTimeZone: "UTC",
        capturedAtMs: 80,
        maxActivities: 1,
      }),
    ).toThrow("filter_activity_limit_exceeded");
  });

  it("enforces the relation match-count limit", () => {
    expect(() =>
      evaluateFilterDocument(
        parseFilterDsl(
          'sequence([event { event.name eq "signup" }, event { event.name eq "purchase" }]) exists',
          analyticsFilterRegistry,
        ),
        fixture,
        {
          scope: "visitor",
          candidateRange: { startMs: 0, endExclusiveMs: 100 },
          reportingTimeZone: "UTC",
          capturedAtMs: 80,
          maxSequenceMatches: 1,
        },
      ),
    ).toThrow("filter_sequence_match_limit_exceeded");
  });
});
