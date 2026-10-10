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
      'min(EVENT -> payload("/value")) gt 15',
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
      ['first(EVENT -> payload("/value")) eq 100', "number"],
      ['first(EVENT -> payload("/value")) neq "100"', "string"],
      ['first(EVENT -> payload("/value")) in [true, false]', "boolean"],
      [
        'nth(EVENT { $.name eq "value" } -> payload("/value"), 2) notIn [1, 2]',
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
        'first(EVENT { $.name eq "value" } -> payload("/value")) eq 100',
        "number",
      ],
      [
        'first(EVENT { $.name eq "value" } -> payload("/value")) in ["a", "b"]',
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
      validate('first(EVENT -> payload("/value")) in [1, "1"]'),
    ).toThrow(expect.objectContaining({ code: "heterogeneous_set_values" }));
    expect(() => validate('first(EVENT -> payload("/value")) eq null')).toThrow(
      expect.objectContaining({ code: "null_requires_unary_operator" }),
    );
  });

  it("accepts registered entity members and the scope-level time field", () => {
    validate('first(EVENT).name eq "purchase"');
    validate('time gte "2026-09-01T00:00:00Z"');
    validate("first(PAGE).path exists");
    validate("first(SESSION).durationMs gt 5m");
    validate("first(VISITOR).sessions gte 3");
    validate('first(PAGE).geo.country eq "US"');
    validate("countDistinct(PAGE -> path) gte 10");
    validate('sum(EVENT -> payload("/amount")) gt 1000');
  });

  it("keeps current members lexical and requires explicit collection projections", () => {
    expect(() => validate('PAGE { page.path eq "/docs" } exists')).toThrow(
      expect.objectContaining({ code: "invalid_context_member" }),
    );
    expect(() => validate('PAGE { $.unknown eq "x" } exists')).toThrow(
      expect.objectContaining({ code: "invalid_context_member" }),
    );
    expect(() => validate('PAGE.path eq "/docs"')).toThrow(
      expect.objectContaining({ code: "unknown_field" }),
    );
    expect(() => validate("PAGE -> unknown exists")).toThrow(
      expect.objectContaining({ code: "invalid_member" }),
    );
    validate("count(PAGE -> geo.country) gte 1");

    for (const [target, code] of [
      [
        {
          kind: "member",
          object: { kind: "entity-root", entity: "page" },
          member: "path",
        },
        "invalid_member",
      ],
      [{ kind: "context-root", context: "current" }, "invalid_context_member"],
    ]) {
      const legacyDocument = {
        version: 1,
        root: { kind: "condition", target, operator: "exists" },
      } as unknown as FilterDocument;
      expect(() =>
        analyzeFilterDocument(legacyDocument, analyticsFilterRegistry),
      ).toThrow(expect.objectContaining({ code }));
    }

    const malformedProjection = {
      version: 1,
      root: {
        kind: "condition",
        target: {
          kind: "projection",
          collection: { kind: "entity-root", entity: "page" },
          member: "path/with/slash",
        },
        operator: "exists",
      },
    } as unknown as FilterDocument;
    expect(() =>
      normalizeFilterDocument(malformedProjection, analyticsFilterRegistry),
    ).toThrow(expect.objectContaining({ code: "invalid_member" }));
  });

  it("rejects collection-to-scalar comparisons in JSON filter documents", () => {
    const document: FilterDocument = {
      version: 1,
      root: {
        kind: "condition",
        target: {
          kind: "projection",
          collection: { kind: "entity-root", entity: "page" },
          member: "path",
        },
        operator: "eq",
        value: "/docs",
      },
    };
    const parsedJson = JSON.parse(JSON.stringify(document)) as FilterDocument;
    const normalized = normalizeFilterDocument(
      parsedJson,
      analyticsFilterRegistry,
    );

    expect(() =>
      validateFilterExpressionTypes(normalized, analyticsFilterRegistry),
    ).toThrow(expect.objectContaining({ code: "condition_type_mismatch" }));
  });

  it("applies registered operators to members in their entity context", () => {
    expect(() => validate('PAGE { $.durationMs contains "1" } exists')).toThrow(
      expect.objectContaining({ code: "operator_not_allowed" }),
    );

    const registry = new Map(analyticsFilterRegistry);
    const payload = registry.get("event.payload");
    if (!payload) throw new Error("missing_event_payload_field");
    registry.set("event.payload", {
      ...payload,
      operators: new Set(["eq"]),
    });
    expect(() =>
      parseFilterDsl(
        'EVENT { $.payload("/amount") contains "x" } exists',
        registry,
      ),
    ).toThrow(expect.objectContaining({ code: "operator_not_allowed" }));
  });

  it("limits current Event payload reads to an Event binding", () => {
    validate('EVENT { $.payload("/amount") gt 0 } exists');
    expect(() => validate('PAGE { $.payload("/amount") gt 0 } exists')).toThrow(
      expect.objectContaining({ code: "invalid_context_member" }),
    );
    expect(() => validate('$.payload("/amount") gt 0')).toThrow(
      expect.objectContaining({ code: "invalid_context_member" }),
    );
  });

  it("checks reducer input types and selector collection shape", () => {
    expect(() => validate("sum(PAGE -> path) gt 1")).toThrow(
      expect.objectContaining({ code: "reducer_type_mismatch" }),
    );
  });

  it("keeps elapsed windows separate from calendar period buckets", () => {
    validate("count(bucket(PAGE, 1mo)) gte 1");
    validate("countDistinct(bucket(PAGE, 1d)) gte 1");
    validate('countDistinct(bucket(PAGE { $.path eq "/docs" }, 1d)) gte 1');
    validate("count(window(EVENT, @range.start, [0d, 7d])) gte 1");
    validate("countDistinct(window(EVENT, @now, [-7d, 0d]) -> name) gte 3");
    expect(() =>
      validate("count(window(EVENT, first(EVENT), [0mo, 7d])) gte 1"),
    ).toThrow(
      expect.objectContaining({ code: "calendar_offset_not_supported" }),
    );
    expect(() =>
      validate(
        'count(window(EVENT, first(EVENT -> payload("/timestamp")), [0d, 7d])) gte 1',
      ),
    ).toThrow(expect.objectContaining({ code: "window_anchor_type_mismatch" }));
  });

  it("keeps bucket values opaque outside count aggregates", () => {
    for (const source of [
      "sum(bucket(PAGE, 1d)) gt 1",
      "avg(bucket(EVENT, 1d)) gt 1",
      "min(bucket(PAGE, 1d)) exists",
      "max(bucket(EVENT, 1d)) exists",
      "bucket(PAGE, 1d) exists",
    ])
      expect(() => validate(source), source).toThrow(
        expect.objectContaining({ code: "opaque_bucket_value" }),
      );
  });

  it("resolves relation anchors from query Scope or explicit selectors", () => {
    const source =
      'SESSION { sequence([EVENT { $.name eq "signup" }, EVENT { $.name eq "purchase" }]) { $span lte 7d } exists } exists';
    expect(() => validate(source)).not.toThrow();
    const topLevel = parseFilterDsl(
      'sequence([EVENT { $.name eq "signup" }, EVENT { $.name eq "purchase" }]) exists',
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
      'SESSION { sequence([EVENT { $.name eq "signup" }, EVENT { $.name eq "purchase" }]) exists } exists',
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
      'sub(sum(EVENT -> payload("/purchase")), sum(EVENT -> payload("/refund"))) gt 1000',
    );
    validate(
      'div(sub(sum(EVENT -> payload("/purchase")), sum(EVENT -> payload("/refund"))), count(EVENT)) gt 100',
    );
    const numeric = parseFilterDsl(
      'sub(sum(EVENT -> payload("/purchase")), sum(EVENT -> payload("/refund"))) gt 1000',
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
    expect(() => validate("first(EVENT).time exists")).toThrow(
      expect.objectContaining({ code: "invalid_member" }),
    );
  });

  it("allows only DateTime minus DateTime as a duration operation", () => {
    const document = parseFilterDsl(
      "sub(time(first(EVENT)), time(first(PAGE))) between [0d, 30d]",
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
      "sub(time(first(EVENT)), count(EVENT)) gt 1",
      "sub(count(EVENT), time(first(EVENT))) gt 1",
      "add(time(first(EVENT)), time(first(PAGE))) gt 1",
    ])
      expect(() => validate(source), source).toThrow(
        expect.objectContaining({ code: "arithmetic_type_mismatch" }),
      );
  });

  it("keeps $same in the canonical eq true condition form", () => {
    for (const source of [
      'sequence([EVENT, EVENT]) { $same($.payload("/id")) neq true } exists',
      'sequence([EVENT, EVENT]) { $same($.payload("/id")) eq false } exists',
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

  it("checks $same member availability across every bound entity step", () => {
    validate("sequence([PAGE, EVENT]) { $same($.geo.country) } exists");
    expect(() =>
      validate("sequence([PAGE, EVENT]) { $same($.path) } exists"),
    ).toThrow(expect.objectContaining({ code: "same_value_entity_mismatch" }));
    expect(() =>
      validate('EVENT { event.payload("/id") eq "x" } exists'),
    ).toThrow(expect.objectContaining({ code: "invalid_context_member" }));
  });

  it("requires $same to use a scalar value bound to each sequence occurrence", () => {
    expect(() =>
      validate("sequence([EVENT, EVENT]) { $same(EVENT) } exists"),
    ).toThrow(expect.objectContaining({ code: "same_value_type_mismatch" }));
    expect(() =>
      validate("sequence([EVENT, EVENT]) { $same(page.path) } exists"),
    ).toThrow(
      expect.objectContaining({ code: "same_target_not_per_occurrence" }),
    );
    expect(() =>
      validate('sequence([EVENT, PAGE]) { $same($.payload("/id")) } exists'),
    ).toThrow(expect.objectContaining({ code: "same_value_entity_mismatch" }));
  });

  it("accepts temporal ranges without allowing temporal set values", () => {
    validate("time between [@now-30d, @now]");
    expect(() => validate("time in [@now, 7d]")).toThrow();
  });

  it("rejects unregistered and removed structural members", () => {
    for (const source of [
      "first(EVENT).time exists",
      "first(PAGE).time exists",
      "first(EVENT).time exists",
      "sequence([EVENT, PAGE]).start exists",
      "sequence([EVENT, PAGE]).end exists",
      "sequence([EVENT, PAGE]).steps exists",
      "periods(EVENT, 1w).start exists",
      "periods(EVENT, 1w).end exists",
      "bucket(PAGE, 1d).start exists",
      "bucket(PAGE, 1d).end exists",
      "periods(EVENT, 1w) { $items.time exists } exists",
      "first(EVENT).payload exists",
      'PAGE { $.path eq "/pricing" } -> payload("/price") eq 1',
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

    for (const source of [
      "session.pages exists",
      "visitor.pages exists",
      "event.unknownField eq 1",
    ])
      expect(() => validate(source), source).toThrow(
        expect.objectContaining({ code: "unknown_field" }),
      );

    expect(() => validate('first(EVENT).payload("/price") eq 1')).toThrow(
      expect.objectContaining({ code: "explicit_projection_required" }),
    );

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
      "count(bucket(PAGE, 0d)) gte 1",
      "count(bucket(PAGE, -1d)) gte 1",
      "count(bucket(PAGE, 0.5d)) gte 1",
      "count(periods(EVENT, 0w)) gte 1",
      "count(periods(EVENT, 1.5w)) gte 1",
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
      checkScope("EVENT { time gte @now-30d } exists", "visitor"),
    ).toThrow(expect.objectContaining({ code: "invalid_time_scope" }));
    expect(() =>
      checkScope("PAGE { time gte @now-30d } exists", "session"),
    ).toThrow(expect.objectContaining({ code: "invalid_time_scope" }));
    expect(() =>
      checkScope("SESSION { time gte @now-30d } exists", "visitor"),
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
