import { describe, expect, it } from "vitest";

import {
  analyticsFilterRegistry,
  analyzeFilterDocument,
  legacyConditionValue,
  normalizeFilterDocument,
  parseFilterDsl,
  validateFilterExpressionTypes,
  validateFilterRelationDomains,
} from "@/lib/filter-contract";

function validate(source: string): void {
  validateFilterExpressionTypes(
    parseFilterDsl(source, analyticsFilterRegistry),
    analyticsFilterRegistry,
  );
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

  it("rejects heterogeneous advanced sets and null equality", () => {
    expect(() =>
      validate('first(event.payload("/value")) in [1, "1"]'),
    ).toThrow(expect.objectContaining({ code: "heterogeneous_set_values" }));
    expect(() => validate('first(event.payload("/value")) eq null')).toThrow(
      expect.objectContaining({ code: "null_requires_unary_operator" }),
    );
  });

  it("accepts collection comparisons, datetime literals, and temporal arithmetic", () => {
    validate('first(event).name eq "purchase"');
    validate('time gte "2026-09-01T00:00:00Z"');
    validate("sub(first(event).time, first(page).time) lte 7d");
    validate("countDistinct(page.path) gte 10");
    validate('sum(event.payload("/amount")) gt 1000');
  });

  it("checks reducer input types and selector collection shape", () => {
    expect(() => validate("sum(page.path) gt 1")).toThrow(
      expect.objectContaining({ code: "reducer_type_mismatch" }),
    );
  });

  it("keeps elapsed windows separate from calendar period buckets", () => {
    validate("count(bucket(page.time, 1mo)) gte 1");
    expect(() =>
      validate("count(window(event, first(event).time, [0mo, 7d])) gte 1"),
    ).toThrow(
      expect.objectContaining({ code: "calendar_offset_not_supported" }),
    );
  });

  it("resolves relation anchors from query Scope or explicit selectors", () => {
    const source =
      'session { sequence([event { event.name eq "signup" }, event { event.name eq "purchase" }]) { sequence.span lte 7d } exists } exists';
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

  it("distinguishes numeric subtraction from elapsed-time subtraction", () => {
    validate(
      'sub(sum(event.payload("/purchase")), sum(event.payload("/refund"))) gt 1000',
    );
    validate(
      'div(sub(sum(event.payload("/purchase")), sum(event.payload("/refund"))), count(event)) gt 100',
    );
    validate("sub(first(event).time, first(page).time) lte 7d");
    const numeric = parseFilterDsl(
      'sub(sum(event.payload("/purchase")), sum(event.payload("/refund"))) gt 1000',
      analyticsFilterRegistry,
    );
    const temporal = parseFilterDsl(
      "sub(first(event).time, first(page).time) lte 7d",
      analyticsFilterRegistry,
    );
    const numericTarget =
      numeric.root?.kind === "condition" ? numeric.root.target : null;
    const temporalTarget =
      temporal.root?.kind === "condition" ? temporal.root.target : null;
    expect(numericTarget).not.toBeNull();
    expect(temporalTarget).not.toBeNull();
    expect(
      numericTarget &&
        analyzeFilterDocument(numeric, analyticsFilterRegistry).targetTypes.get(
          numericTarget,
        ),
    ).toMatchObject({ kind: "scalar", scalar: "number" });
    expect(
      temporalTarget &&
        analyzeFilterDocument(
          temporal,
          analyticsFilterRegistry,
        ).targetTypes.get(temporalTarget),
    ).toMatchObject({ kind: "scalar", scalar: "duration" });
    expect(() =>
      validate('sub(first(event).time, sum(event.payload("/amount"))) gt 0'),
    ).toThrow(expect.objectContaining({ code: "arithmetic_type_mismatch" }));
    expect(() =>
      validate('sub(sum(event.payload("/amount")), first(event).time) gt 0'),
    ).toThrow(expect.objectContaining({ code: "arithmetic_type_mismatch" }));
  });

  it("accepts temporal ranges without allowing temporal set values", () => {
    validate("sub(first(event).time, first(page).time) between [0d, 30d]");
    validate("time between [@now-30d, @now]");
    expect(() =>
      validate("sub(first(event).time, first(page).time) between [30d, 0d]"),
    ).toThrow(expect.objectContaining({ code: "reversed_range" }));
    expect(() => validate("time in [@now, 7d]")).toThrow();
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
