import { describe, expect, it } from "vitest";

import {
  analyticsFilterRegistry,
  analyzeFilterDocument,
  legacyConditionValue,
  normalizeFilterDocument,
  parseFilterDsl,
  validateFilterConditionDomains,
  validateFilterExpressionTypes,
  validateFilterRelationDomains,
} from "@/lib/filter-contract";
import type {
  CanonicalJsonPath,
  FilterDocument,
  FilterTargetExpression,
} from "@/lib/filter-contract/filters";

function validate(source: string): void {
  const document = parseFilterDsl(source, analyticsFilterRegistry);
  analyzeFilterDocument(document, analyticsFilterRegistry);
  validateFilterExpressionTypes(document, analyticsFilterRegistry);
}

describe("Filter v1 expression types", () => {
  it("keeps dynamic JSON scalar distinct from an unknown value and narrows contextually", () => {
    const source = parseFilterDsl(
      'min(event.payload("/value")) gt 15',
      analyticsFilterRegistry,
    );
    const root = source.root;
    if (root?.kind !== "condition") throw new Error("expected_condition");
    const analysis = analyzeFilterDocument(source, analyticsFilterRegistry);

    expect(analysis.targetTypes.get(root.target)).toEqual({
      kind: "scalar",
      scalar: "json-scalar",
    });
    expect(analysis.expectedTargetTypes.get(root.target)).toBe("number");
  });

  it("propagates eq, neq, and homogeneous set types into positional payload reducers", () => {
    for (const [source, expected] of [
      ['first(event.payload("/value")) eq 100', "number"],
      ['first(event.payload("/value")) neq "100"', "string"],
      ['first(event.payload("/value")) in [true, false]', "boolean"],
      [
        'nth(event { event.name eq "value" }.payload("/value"), 2) notIn [1, 2]',
        "number",
      ],
    ] as const) {
      const document = parseFilterDsl(source, analyticsFilterRegistry);
      const root = document.root;
      if (root?.kind !== "condition") throw new Error("expected_condition");
      expect(
        analyzeFilterDocument(
          document,
          analyticsFilterRegistry,
        ).expectedTargetTypes.get(root.target),
      ).toBe(expected);
    }
  });

  it("narrows payload projections after an entity selector", () => {
    for (const [source, expected] of [
      [
        'first(event { event.name eq "value" }.payload("/value")) eq 100',
        "number",
      ],
      [
        'first(event { event.name eq "value" }.payload("/value")) in ["a", "b"]',
        "string",
      ],
    ] as const) {
      const document = parseFilterDsl(source, analyticsFilterRegistry);
      const root = document.root;
      if (root?.kind !== "condition") throw new Error("expected_condition");
      const analysis = analyzeFilterDocument(document, analyticsFilterRegistry);
      const reducer = root.target;
      if (reducer.kind !== "reducer") throw new Error("expected_reducer");

      expect(analysis.expectedTargetTypes.get(reducer.input)).toBe(expected);
    }

    const projection: FilterTargetExpression = {
      kind: "projection",
      collection: { kind: "entity-root", entity: "event" },
      member: "payload",
      path: "/value" as CanonicalJsonPath,
    };
    const target: FilterTargetExpression = {
      kind: "reducer",
      reducer: "first",
      input: projection,
    };
    const projectedDocument: FilterDocument = {
      version: 1,
      root: {
        kind: "condition",
        target,
        operator: "eq",
        value: 100,
      },
    };
    const projectedAnalysis = analyzeFilterDocument(
      projectedDocument,
      analyticsFilterRegistry,
    );
    expect(projectedAnalysis.expectedTargetTypes.get(projection)).toBe(
      "number",
    );
  });

  it("rejects heterogeneous advanced sets and null equality", () => {
    expect(() =>
      validate('first(event.payload("/value")) in [1, "1"]'),
    ).toThrow(expect.objectContaining({ code: "heterogeneous_set_values" }));
    expect(() => validate('first(event.payload("/value")) eq null')).toThrow(
      expect.objectContaining({ code: "null_requires_unary_operator" }),
    );
  });

  it("accepts registered entity members and the scope-level time field", () => {
    validate('first(event).name eq "purchase"');
    validate('time gte "2026-09-01T00:00:00Z"');
    validate("first(page).path exists");
    validate("first(session).durationMs gt 5m");
    validate("first(visitor).sessions gte 3");
    validate('first(page).geo.country eq "US"');
    validate("countDistinct(page.path) gte 10");
    validate('sum(event.payload("/amount")) gt 1000');
  });

  it("checks reducer input types and selector collection shape", () => {
    expect(() => validate("sum(page.path) gt 1")).toThrow(
      expect.objectContaining({ code: "reducer_type_mismatch" }),
    );
  });

  it("keeps elapsed windows separate from calendar period buckets", () => {
    validate("count(bucket(page, 1mo)) gte 1");
    validate("countDistinct(bucket(page, 1d)) gte 1");
    validate('countDistinct(bucket(page { page.path eq "/docs" }, 1d)) gte 1');
    validate("count(window(event, @range.start, [0d, 7d])) gte 1");
    expect(() =>
      validate("count(window(event, first(event), [0mo, 7d])) gte 1"),
    ).toThrow(
      expect.objectContaining({ code: "calendar_offset_not_supported" }),
    );
    expect(() =>
      validate(
        'count(window(event, first(event.payload("/timestamp")), [0d, 7d])) gte 1',
      ),
    ).toThrow(expect.objectContaining({ code: "window_anchor_type_mismatch" }));
  });

  it("keeps bucket values opaque outside count aggregates", () => {
    for (const source of [
      "sum(bucket(page, 1d)) gt 1",
      "avg(bucket(event, 1d)) gt 1",
      "min(bucket(page, 1d)) exists",
      "max(bucket(event, 1d)) exists",
      "bucket(page, 1d) exists",
    ])
      expect(() => validate(source), source).toThrow(
        expect.objectContaining({ code: "opaque_bucket_value" }),
      );
  });

  it("resolves relation anchors from query Scope or explicit selectors", () => {
    const source =
      'session { sequence([event { event.name eq "signup" }, event { event.name eq "purchase" }]) { $span lte 7d } exists } exists';
    expect(() => validate(source)).not.toThrow();
    const topLevel = parseFilterDsl(
      'sequence([event { event.name eq "signup" }, event { event.name eq "purchase" }]) exists',
      analyticsFilterRegistry,
    );
    expect(() =>
      validateFilterExpressionTypes(topLevel, analyticsFilterRegistry),
    ).not.toThrow();
    const analysis = analyzeFilterDocument(topLevel, analyticsFilterRegistry);
    expect(() =>
      validateFilterRelationDomains(topLevel, "visitor", analysis),
    ).not.toThrow();
    expect(() =>
      validateFilterRelationDomains(topLevel, "session", analysis),
    ).not.toThrow();
    expect(() =>
      validateFilterRelationDomains(topLevel, "event", analysis),
    ).toThrow(
      expect.objectContaining({
        code: "relation_requires_session_or_visitor_scope",
      }),
    );
    const explicit = parseFilterDsl(
      'session { sequence([event { event.name eq "signup" }, event { event.name eq "purchase" }]) exists } exists',
      analyticsFilterRegistry,
    );
    expect(() =>
      validateFilterRelationDomains(
        explicit,
        "event",
        analyzeFilterDocument(explicit, analyticsFilterRegistry),
      ),
    ).not.toThrow();
  });

  it("allows numeric arithmetic but does not expose entity timestamps", () => {
    validate(
      'sub(sum(event.payload("/purchase")), sum(event.payload("/refund"))) gt 1000',
    );
    validate(
      'div(sub(sum(event.payload("/purchase")), sum(event.payload("/refund"))), count(event)) gt 100',
    );
    const numeric = parseFilterDsl(
      'sub(sum(event.payload("/purchase")), sum(event.payload("/refund"))) gt 1000',
      analyticsFilterRegistry,
    );
    const numericTarget =
      numeric.root?.kind === "condition" ? numeric.root.target : null;
    expect(numericTarget).not.toBeNull();
    expect(
      numericTarget &&
        analyzeFilterDocument(numeric, analyticsFilterRegistry).targetTypes.get(
          numericTarget,
        ),
    ).toMatchObject({ kind: "scalar", scalar: "number" });
    expect(() => validate("first(event).time exists")).toThrow(
      expect.objectContaining({ code: "invalid_member" }),
    );
  });

  it("allows only DateTime minus DateTime as a duration operation", () => {
    const document = parseFilterDsl(
      "sub(time(first(event)), time(first(page))) between [0d, 30d]",
      analyticsFilterRegistry,
    );
    const root = document.root;
    if (root?.kind !== "condition") throw new Error("expected_condition");
    expect(
      analyzeFilterDocument(document, analyticsFilterRegistry).targetTypes.get(
        root.target,
      ),
    ).toMatchObject({ kind: "scalar", scalar: "duration" });

    for (const source of [
      "sub(time(first(event)), count(event)) gt 1",
      "sub(count(event), time(first(event))) gt 1",
      "add(time(first(event)), time(first(page))) gt 1",
    ])
      expect(() => validate(source), source).toThrow(
        expect.objectContaining({ code: "arithmetic_type_mismatch" }),
      );
  });

  it("keeps $same in the canonical eq true condition form", () => {
    for (const source of [
      'sequence([event, event]) { $same(event.payload("/id")) neq true } exists',
      'sequence([event, event]) { $same(event.payload("/id")) eq false } exists',
    ])
      expect(
        () => parseFilterDsl(source, analyticsFilterRegistry),
        source,
      ).toThrow(
        expect.objectContaining({
          code: "invalid_context_intrinsic_condition",
        }),
      );
  });

  it("accepts temporal ranges without allowing temporal set values", () => {
    validate("time between [@now-30d, @now]");
    expect(() => validate("time in [@now, 7d]")).toThrow();
  });

  it("rejects unregistered and removed structural members", () => {
    for (const source of [
      "event.time exists",
      "page.time exists",
      "first(event).time exists",
      "sequence([event, page]).start exists",
      "sequence([event, page]).end exists",
      "sequence([event, page]).steps exists",
      "periods(event, 1w).start exists",
      "periods(event, 1w).end exists",
      "bucket(page, 1d).start exists",
      "bucket(page, 1d).end exists",
      "session.pages exists",
      "visitor.pages exists",
      "periods(event, 1w) { $items.time exists } exists",
      "first(event).payload exists",
      'page { page.path eq "/pricing" }.payload("/price") eq 1',
      'first(event).payload("/price") eq 1',
      "event.unknownField eq 1",
    ]) {
      expect(() => validate(source), source).toThrow(
        expect.objectContaining({ code: "invalid_member" }),
      );
    }
    for (const source of [
      "event.payload exists",
      'page.payload("/price") eq 1',
      'session.payload("/price") eq 1',
      'visitor.payload("/price") eq 1',
    ])
      expect(() => validate(source), source).toThrow();

    const rawUnknownField = {
      version: 1,
      root: {
        kind: "condition",
        target: { kind: "field", field: "event.unregistered" },
        operator: "eq",
        value: "value",
      },
    } as unknown as FilterDocument;
    expect(() =>
      analyzeFilterDocument(rawUnknownField, analyticsFilterRegistry),
    ).toThrow(expect.objectContaining({ code: "invalid_member" }));
  });

  it("keeps registered aggregate fact members scalar", () => {
    for (const source of [
      "session.events gte 1",
      "visitor.events gte 1",
      "visitor.sessions gte 1",
    ])
      expect(() => validate(source), source).not.toThrow();

    for (const source of [
      "session.events gte 1",
      "visitor.events gte 1",
      "visitor.sessions gte 1",
    ]) {
      const document = parseFilterDsl(source, analyticsFilterRegistry);
      const target =
        document.root?.kind === "condition" ? document.root.target : null;
      expect(
        target &&
          analyzeFilterDocument(
            document,
            analyticsFilterRegistry,
          ).targetTypes.get(target),
      ).toMatchObject({ kind: "scalar", scalar: "number" });
    }
  });

  it("requires positive safe-integer bucket and period intervals", () => {
    for (const source of [
      "count(bucket(page, 0d)) gte 1",
      "count(bucket(page, -1d)) gte 1",
      "count(bucket(page, 0.5d)) gte 1",
      "count(periods(event, 0w)) gte 1",
      "count(periods(event, 1.5w)) gte 1",
    ])
      expect(() => validate(source), source).toThrow();
  });

  it("restricts scope-level time to top-level AND in Session or Visitor Scope", () => {
    const checkScope = (
      source: string,
      scope: "event" | "session" | "visitor",
    ) => {
      const document = parseFilterDsl(source, analyticsFilterRegistry);
      validateFilterConditionDomains(document, scope, analyticsFilterRegistry);
    };
    expect(() =>
      checkScope("time gte @now-30d AND visitor.sessions gte 3", "visitor"),
    ).not.toThrow();
    expect(() => checkScope("time gte @now-30d", "event")).toThrow(
      expect.objectContaining({ code: "invalid_time_scope" }),
    );
    expect(() =>
      checkScope("event { time gte @now-30d } exists", "visitor"),
    ).toThrow(expect.objectContaining({ code: "invalid_time_scope" }));
    expect(() =>
      checkScope("page { time gte @now-30d } exists", "session"),
    ).toThrow(expect.objectContaining({ code: "invalid_time_scope" }));
    expect(() =>
      checkScope("session { time gte @now-30d } exists", "visitor"),
    ).toThrow(expect.objectContaining({ code: "invalid_time_scope" }));
    expect(() => checkScope("NOT time gte @now-30d", "session")).toThrow(
      expect.objectContaining({ code: "invalid_time_scope" }),
    );
    expect(() => checkScope("time exists", "visitor")).toThrow(
      expect.objectContaining({ code: "invalid_time_scope" }),
    );
    expect(() => checkScope("time isNull", "session")).toThrow(
      expect.objectContaining({ code: "invalid_time_scope" }),
    );
    expect(() =>
      checkScope('time gte @now-30d OR event.name eq "purchase"', "visitor"),
    ).toThrow(expect.objectContaining({ code: "invalid_time_scope" }));
  });

  it("rejects computed values inside set filters", () => {
    expect(() =>
      normalizeFilterDocument(
        {
          version: 1,
          root: {
            kind: "condition",
            target: {
              kind: "member",
              object: { kind: "entity-root", entity: "page" },
              member: "path",
            },
            operator: "in",
            value: [{ kind: "time-anchor", anchor: "now" }],
          },
        },
        analyticsFilterRegistry,
      ),
    ).toThrow(
      expect.objectContaining({
        code: "invalid_set",
      }),
    );
  });

  it("rejects malformed programmatic ASTs at the normalization boundary", () => {
    const condition = (
      target: unknown,
      value: unknown = "us",
      operator = "eq",
    ) => ({ kind: "condition", target, operator, value });

    expect(() =>
      normalizeFilterDocument({ version: 1 }, analyticsFilterRegistry),
    ).toThrow(expect.objectContaining({ code: "missing_root" }));
    expect(() =>
      normalizeFilterDocument(
        { version: 1, root: condition(null) },
        analyticsFilterRegistry,
      ),
    ).toThrow(expect.objectContaining({ code: "invalid_target" }));
    expect(() =>
      normalizeFilterDocument(
        { version: 1, root: condition({ kind: "future-target" }) },
        analyticsFilterRegistry,
      ),
    ).toThrow(expect.objectContaining({ code: "invalid_target" }));
    expect(() =>
      normalizeFilterDocument(
        {
          version: 1,
          root: condition(
            { kind: "event-payload", path: "/amount" },
            [null, "x"],
            "between",
          ),
        },
        analyticsFilterRegistry,
      ),
    ).toThrow(expect.objectContaining({ code: "invalid_range" }));
    expect(() =>
      normalizeFilterDocument(
        {
          version: 1,
          root: {
            kind: "not",
            child: {
              kind: "not",
              child: condition({ kind: "field", field: "geo.country" }),
            },
          },
        },
        analyticsFilterRegistry,
        { maxGroups: 1 },
      ),
    ).toThrow(expect.objectContaining({ code: "too_many_groups" }));
    expect(() =>
      normalizeFilterDocument(
        {
          version: 1,
          root: condition({ kind: "event-payload", path: "/amount" }),
        },
        new Map(),
      ),
    ).toThrow(expect.objectContaining({ code: "unknown_field" }));
    expect(() => legacyConditionValue({ kind: "duration" } as never)).toThrow(
      "unsupported_filter_condition_value",
    );
  });
});
