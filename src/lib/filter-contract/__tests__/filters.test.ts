import { describe, expect, it } from "vitest";

import {
  ANALYTICS_FILTER_FIELD_IDS,
  analyticsFilterDefinition,
  analyticsFilterRegistry,
  assertFilterAudience,
  attachFilterScopePreference,
  filterConditionCount,
  filterConditionEntity,
  type FilterFieldDefinition,
  type FilterFieldRegistry,
  filterFingerprint,
  filterScopePreferenceFromDocument,
  hasEffectiveFilters,
  normalizeFilterDocument,
  queryPolicyForAudience,
  stripTopLevelFacet,
} from "@/lib/edge/analytics/contract";
import { parseFilterDsl } from "@/lib/filter-contract";

const allAudiences = new Set([
  "private-dashboard",
  "public-share",
  "api-v1",
] as const);
const privateAudiences = new Set(["private-dashboard", "api-v1"] as const);
const registryEntries: readonly (readonly [string, FilterFieldDefinition])[] = [
  [
    "page.path",
    {
      id: "page.path",
      valueKind: "string",
      operators: new Set(["eq", "neq", "in", "notIn", "contains"]),
      audiences: allAudiences,
    },
  ],
  [
    "geo.country",
    {
      id: "geo.country",
      valueKind: "string",
      operators: new Set(["eq", "in"]),
      audiences: allAudiences,
      singletonSetEquivalent: true,
      canonicalize: (value: string | number | boolean | null) =>
        String(value).trim().toUpperCase(),
    },
  ],
  [
    "event.score",
    {
      id: "event.score",
      valueKind: "number",
      operators: new Set(["eq", "between"]),
      audiences: privateAudiences,
    },
  ],
  [
    "event.payload",
    {
      id: "event.payload",
      valueKind: "json-scalar",
      operators: new Set([
        "eq",
        "exists",
        "notExists",
        "isNull",
        "notNull",
        "isEmpty",
        "notEmpty",
      ]),
      audiences: privateAudiences,
    },
  ],
  [
    "event.at",
    {
      id: "event.at",
      valueKind: "datetime",
      operators: new Set(["eq"]),
      audiences: privateAudiences,
    },
  ],
];
const registry: FilterFieldRegistry = new Map(registryEntries);

function fieldCondition(
  field: string,
  operator: string,
  value?: unknown,
): Record<string, unknown> {
  return {
    kind: "condition",
    target: { kind: "field", field },
    operator,
    ...(value === undefined ? {} : { value }),
  };
}

function payloadCondition(
  path: string,
  operator: string,
  value?: unknown,
): Record<string, unknown> {
  return {
    kind: "condition",
    target: { kind: "event-payload", path },
    operator,
    ...(value === undefined ? {} : { value }),
  };
}

describe("typed filter contract", () => {
  it("freezes the canonical dot-namespaced field inventory and value kinds", () => {
    expect([...analyticsFilterRegistry.keys()]).toEqual([
      ...ANALYTICS_FILTER_FIELD_IDS,
    ]);
    expect(analyticsFilterRegistry.get("geo.country")?.valueKind).toBe("enum");
    expect(
      analyticsFilterRegistry.get("geo.country")?.operators.has("contains"),
    ).toBe(false);
    expect(analyticsFilterRegistry.get("page.path")?.valueKind).toBe("string");
    expect([
      ...(analyticsFilterDefinition("page.path")?.observationKinds ?? []),
    ]).toEqual(["visit", "event"]);
    expect([
      ...(analyticsFilterDefinition("event.name")?.observationKinds ?? []),
    ]).toEqual(["event"]);
    expect([
      ...(analyticsFilterDefinition("event.payload")?.observationKinds ?? []),
    ]).toEqual(["event"]);
    expect(analyticsFilterRegistry.get("event.payload")?.valueKind).toBe(
      "json-scalar",
    );
    expect(analyticsFilterRegistry.get("event.payload")).toMatchObject({
      source: "payload",
      presence: "json-pointer",
      empty: "raw-empty-string",
      comparison: "case-sensitive",
    });
    expect(filterConditionEntity(analyticsFilterDefinition("page.path"))).toBe(
      "page",
    );
    expect(filterConditionEntity(analyticsFilterDefinition("event.name"))).toBe(
      "event",
    );
    expect(
      filterConditionEntity(analyticsFilterDefinition("session.durationMs")),
    ).toBe("session");
    expect(
      filterConditionEntity(analyticsFilterDefinition("visitor.sessions")),
    ).toBe("visitor");
    expect(
      filterConditionEntity(analyticsFilterDefinition("geo.country")),
    ).toBe("activity");
    expect(filterConditionEntity(undefined)).toBeUndefined();
    expect(analyticsFilterRegistry.get("session.entryPath")).toMatchObject({
      source: "session",
      presence: "derived-session-value",
      empty: "unsupported",
    });
    expect("set" in analyticsFilterRegistry).toBe(false);
    expect(
      "add" in (analyticsFilterRegistry.get("page.path")?.operators ?? {}),
    ).toBe(false);
  });

  it("derives public filter visibility from the shared registry", () => {
    const publicPolicy = queryPolicyForAudience("public-share");
    expect(publicPolicy.allowedFilters.has("page.path")).toBe(true);
    expect(publicPolicy.allowedFilters.has("page.query")).toBe(false);
    expect(publicPolicy.allowedFilters.has("referrer.url")).toBe(false);
    expect(publicPolicy.allowedFilters.has("event.payload")).toBe(false);
    expect(analyticsFilterRegistry.has("geo.country")).toBe(true);

    const privateEventDocument = normalizeFilterDocument(
      {
        version: 1,
        root: fieldCondition("event.name", "eq", "purchase"),
      },
      analyticsFilterRegistry,
    );
    expect(() =>
      assertFilterAudience(
        privateEventDocument,
        analyticsFilterRegistry,
        "public-share",
      ),
    ).toThrow(/not allowed/);
    expect(() =>
      assertFilterAudience(
        privateEventDocument,
        analyticsFilterRegistry,
        "api-v1",
      ),
    ).not.toThrow();
  });

  it("normalizes dot-namespaced fields, values, and commutative groups", () => {
    const document = normalizeFilterDocument(
      {
        version: 1,
        root: {
          kind: "and",
          children: [
            fieldCondition("page.path", "eq", "/docs"),
            fieldCondition("geo.country", "in", ["us", "CA", "US"]),
            fieldCondition("page.path", "eq", "/docs"),
          ],
        },
      },
      registry,
    );

    expect(document).toEqual({
      version: 1,
      root: {
        kind: "and",
        children: [
          fieldCondition("geo.country", "in", ["CA", "US"]),
          fieldCondition("page.path", "eq", "/docs"),
        ],
      },
    });
    expect(hasEffectiveFilters(document)).toBe(true);
  });

  it("strips only top-level facet conditions after canonical normalization", () => {
    const target = fieldCondition("page.path", "eq", "/pricing");
    const other = fieldCondition("geo.country", "eq", "US");
    const root = normalizeFilterDocument(
      { version: 1, root: target },
      registry,
    );
    expect(stripTopLevelFacet(root, "page.path").root).toBeNull();

    const conjunction = normalizeFilterDocument(
      { version: 1, root: { kind: "and", children: [target, other] } },
      registry,
    );
    const scopedConjunction = attachFilterScopePreference(
      conjunction,
      "visitor",
    );
    const strippedConjunction = stripTopLevelFacet(
      scopedConjunction,
      "page.path",
    );
    expect(strippedConjunction.root).toEqual(other);
    expect(filterScopePreferenceFromDocument(strippedConjunction)).toBe(
      "visitor",
    );

    const nestedOr = normalizeFilterDocument(
      {
        version: 1,
        root: { kind: "or", children: [target, other] },
      },
      registry,
    );
    expect(stripTopLevelFacet(nestedOr, "page.path")).toEqual(nestedOr);

    const nestedNot = normalizeFilterDocument(
      { version: 1, root: { kind: "not", child: target } },
      registry,
    );
    expect(stripTopLevelFacet(nestedNot, "page.path")).toEqual(nestedNot);

    const threeChildren = normalizeFilterDocument(
      {
        version: 1,
        root: {
          kind: "and",
          children: [target, other, fieldCondition("event.score", "eq", 10)],
        },
      },
      registry,
    );
    expect(stripTopLevelFacet(threeChildren, "page.path").root).toMatchObject({
      kind: "and",
      children: [
        expect.objectContaining({
          target: expect.objectContaining({ field: "event.score" }),
        }),
        expect.objectContaining({
          target: expect.objectContaining({ field: "geo.country" }),
        }),
      ],
    });
    expect(
      stripTopLevelFacet({ version: 1, root: null }, "page.path").root,
    ).toBeNull();
  });

  it("converts one-item set predicates only after canonicalization", () => {
    expect(
      normalizeFilterDocument(
        {
          version: 1,
          root: fieldCondition("geo.country", "in", ["us", "US"]),
        },
        registry,
      ).root,
    ).toEqual(fieldCondition("geo.country", "eq", "US"));
  });

  it("applies lossless finite-set algebra within commutative groups", () => {
    const document = normalizeFilterDocument(
      {
        version: 1,
        root: {
          kind: "and",
          children: [
            fieldCondition("page.path", "in", ["/docs", "/pricing"]),
            fieldCondition("page.path", "eq", "/pricing"),
            fieldCondition("page.path", "notIn", ["/internal"]),
            fieldCondition("page.path", "notIn", ["/preview"]),
          ],
        },
      },
      registry,
    );

    expect(document.root).toEqual({
      kind: "and",
      children: [
        fieldCondition("page.path", "eq", "/pricing"),
        fieldCondition("page.path", "notIn", ["/internal", "/preview"]),
      ],
    });
  });

  it("unions positive set predicates in OR without rewriting negative sets", () => {
    const document = normalizeFilterDocument(
      {
        version: 1,
        root: {
          kind: "or",
          children: [
            fieldCondition("page.path", "eq", "/docs"),
            fieldCondition("page.path", "in", ["/pricing", "/docs"]),
            fieldCondition("page.path", "notIn", ["/internal"]),
            fieldCondition("page.path", "notIn", ["/preview"]),
          ],
        },
      },
      registry,
    );

    expect(document.root).toEqual({
      kind: "or",
      children: [
        fieldCondition("page.path", "in", ["/docs", "/pricing"]),
        fieldCondition("page.path", "notIn", ["/internal"]),
        fieldCondition("page.path", "notIn", ["/preview"]),
      ],
    });
  });

  it("does not introduce operators excluded by a field contract", () => {
    const document = normalizeFilterDocument(
      {
        version: 1,
        root: {
          kind: "or",
          children: [
            fieldCondition("event.score", "eq", 1),
            fieldCondition("event.score", "eq", 2),
          ],
        },
      },
      registry,
    );

    expect(document.root).toEqual({
      kind: "or",
      children: [
        fieldCondition("event.score", "eq", 1),
        fieldCondition("event.score", "eq", 2),
      ],
    });
  });

  it("does not create a set larger than the document limit", () => {
    const document = normalizeFilterDocument(
      {
        version: 1,
        root: {
          kind: "or",
          children: [
            fieldCondition("page.path", "eq", "/docs"),
            fieldCondition("page.path", "eq", "/pricing"),
            fieldCondition("page.path", "eq", "/blog"),
          ],
        },
      },
      registry,
      { maxSetValues: 2 },
    );

    expect(document.root).toEqual({
      kind: "or",
      children: [
        fieldCondition("page.path", "eq", "/blog"),
        fieldCondition("page.path", "eq", "/docs"),
        fieldCondition("page.path", "eq", "/pricing"),
      ],
    });
  });

  it("rejects unknown or unauthorized field/operator/value combinations", () => {
    expect(() =>
      normalizeFilterDocument(
        {
          version: 1,
          root: {
            kind: "condition",
            target: { kind: "field", field: "page.query" },
            operator: "eq",
            value: "a",
          },
        },
        registry,
      ),
    ).toThrow(/Unknown filter field/);
    expect(() =>
      normalizeFilterDocument(
        {
          version: 1,
          root: {
            kind: "condition",
            target: { kind: "field", field: "page.path" },
            operator: "gt",
            value: "/docs",
          },
        },
        registry,
      ),
    ).toThrow(/not allowed/);
    expect(() =>
      normalizeFilterDocument(
        {
          version: 1,
          root: {
            kind: "condition",
            target: { kind: "field", field: "event.score" },
            operator: "eq",
            value: "7",
          },
        },
        registry,
      ),
    ).toThrow(/finite numeric/);
  });

  it("enforces audience permissions through advanced members and entity roots", () => {
    const privatePageContext = parseFilterDsl(
      'first(page).referrer.url eq "example.com"',
      analyticsFilterRegistry,
    );
    expect(() =>
      assertFilterAudience(
        privatePageContext,
        analyticsFilterRegistry,
        "public-share",
      ),
    ).toThrow(expect.objectContaining({ code: "field_not_allowed" }));

    const customEventCount = parseFilterDsl(
      "count(event) gte 1",
      analyticsFilterRegistry,
    );
    expect(() =>
      assertFilterAudience(
        customEventCount,
        analyticsFilterRegistry,
        "public-share",
      ),
    ).toThrow(expect.objectContaining({ code: "field_not_allowed" }));
  });

  it("requires explicit unary semantics for null payload values", () => {
    expect(() =>
      normalizeFilterDocument(
        {
          version: 1,
          root: payloadCondition("/paid", "eq", null),
        },
        registry,
      ),
    ).toThrow(/isNull or notNull/);
    expect(() =>
      normalizeFilterDocument(
        {
          version: 1,
          root: payloadCondition("/paid", "exists", true),
        },
        registry,
      ),
    ).toThrow(/do not accept a value/);
    expect(
      normalizeFilterDocument(
        {
          version: 1,
          root: payloadCondition("/paid", "isNull"),
        },
        registry,
      ).root,
    ).toEqual(payloadCondition("/paid", "isNull"));
    expect(() =>
      normalizeFilterDocument(
        {
          version: 1,
          root: payloadCondition("paid", "exists"),
        },
        registry,
      ),
    ).toThrow(/JSON pointer/);
  });

  it("does not allow event.payload to bypass its explicit JSON pointer target", () => {
    expect(() =>
      normalizeFilterDocument(
        {
          version: 1,
          root: fieldCondition("event.payload", "eq", "x"),
        },
        registry,
      ),
    ).toThrow(/requires an event-payload target/);
  });

  it("rejects timezone-less datetimes and malformed groups", () => {
    expect(() =>
      normalizeFilterDocument(
        {
          version: 1,
          root: {
            kind: "condition",
            target: { kind: "field", field: "event.at" },
            operator: "eq",
            value: "2026-08-17T12:00:00",
          },
        },
        registry,
      ),
    ).toThrow(/RFC 3339/);
    expect(() =>
      normalizeFilterDocument(
        { version: 1, root: { kind: "or", children: [] } },
        registry,
      ),
    ).toThrow(/at least one child/);
  });

  it("rejects reversed between endpoints", () => {
    expect(() =>
      normalizeFilterDocument(
        {
          version: 1,
          root: fieldCondition("event.score", "between", [10, 1]),
        },
        registry,
      ),
    ).toThrow(/ordered from lower to upper/);
  });

  it("validates every typed target discriminator and its required properties", () => {
    const page = { kind: "entity-root", entity: "page" };
    const invalidTargets: readonly [unknown, string][] = [
      [null, "invalid_target"],
      [{ kind: "future-target" }, "invalid_target"],
      [{ kind: "entity-root", entity: "account" }, "invalid_entity_root"],
      [{ kind: "context-root", context: "unknown" }, "invalid_context_root"],
      [{ kind: "member", object: page, member: "bad/path" }, "invalid_member"],
      [{ kind: "selector", collection: page }, "missing_predicate"],
      [{ kind: "reducer", reducer: "median", input: page }, "invalid_reducer"],
      [
        { kind: "reducer", reducer: "nth", index: 0, input: page },
        "invalid_index",
      ],
      [
        { kind: "reducer", reducer: "count", index: 1, input: page },
        "unexpected_index",
      ],
      [
        { kind: "arithmetic", operator: "pow", left: page, right: page },
        "invalid_arithmetic",
      ],
      [
        { kind: "duration", amount: Number.POSITIVE_INFINITY, unit: "s" },
        "invalid_duration",
      ],
      [{ kind: "time-anchor", anchor: "tomorrow" }, "invalid_time_anchor"],
      [{ kind: "sequence", steps: [page] }, "invalid_sequence"],
      [{ kind: "field", field: "invalid field" }, "invalid_field"],
      [{ kind: "field", field: "unknown.field" }, "unknown_field"],
      [{ kind: "event-payload", path: "not-a-pointer" }, "invalid_json_path"],
      [{ kind: "event-payload", path: "/a/~2" }, "invalid_json_path"],
      [{ kind: "event-payload", path: "/a/" }, "invalid_json_path"],
      [
        { kind: "event-payload", path: `/${"x".repeat(240)}` },
        "invalid_json_path",
      ],
    ];

    for (const [target, code] of invalidTargets) {
      expect(() =>
        normalizeFilterDocument(
          {
            version: 1,
            root: { kind: "condition", target, operator: "exists" },
          },
          analyticsFilterRegistry,
        ),
      ).toThrow(expect.objectContaining({ code }));
    }
  });

  it("enforces target depth and positive normalization limits", () => {
    const document = {
      version: 1,
      root: {
        kind: "condition",
        target: {
          kind: "member",
          object: { kind: "entity-root", entity: "page" },
          member: "path",
        },
        operator: "exists",
      },
    };
    expect(() =>
      normalizeFilterDocument(document, analyticsFilterRegistry, {
        maxDepth: 1,
      }),
    ).toThrow(expect.objectContaining({ code: "too_deep" }));
    expect(() =>
      normalizeFilterDocument(document, analyticsFilterRegistry, {
        maxConditions: 0,
      }),
    ).toThrow(expect.objectContaining({ code: "invalid_limit" }));
  });

  it("canonicalizes negative zero in expression durations", () => {
    const document = normalizeFilterDocument(
      {
        version: 1,
        root: {
          kind: "condition",
          target: { kind: "duration", amount: -0, unit: "s" },
          operator: "gte",
          value: 0,
        },
      },
      analyticsFilterRegistry,
    );

    expect(document.root).toEqual({
      kind: "condition",
      target: { kind: "duration", amount: 0, unit: "s" },
      operator: "gte",
      value: 0,
    });
  });

  it("canonicalizes every Core and Relation target shape", () => {
    const page = { kind: "entity-root", entity: "page" } as const;
    const event = { kind: "entity-root", entity: "event" } as const;
    const sequence = {
      kind: "sequence",
      steps: [event, page],
    } as const;
    const targets = [
      page,
      { kind: "context-root", context: "current" },
      { kind: "member", object: page, member: "time" },
      { kind: "member", object: page, member: "path" },
      {
        kind: "selector",
        collection: page,
        predicate: fieldCondition("page.path", "eq", "/docs"),
      },
      { kind: "projection", collection: page, member: "time" },
      {
        kind: "projection",
        collection: event,
        member: "payload",
        path: "/amount",
      },
      { kind: "reducer", reducer: "count", input: page },
      { kind: "reducer", reducer: "nth", input: page, index: 2 },
      {
        kind: "arithmetic",
        operator: "add",
        left: { kind: "duration", amount: 1, unit: "s" },
        right: { kind: "duration", amount: 2, unit: "s" },
      },
      { kind: "duration", amount: 2, unit: "mo" },
      {
        kind: "time-anchor",
        anchor: "range.end",
        offset: { kind: "duration", amount: -1, unit: "h" },
      },
      {
        kind: "bucket",
        input: { kind: "projection", collection: page, member: "time" },
        interval: { kind: "duration", amount: 1, unit: "d" },
      },
      {
        kind: "window",
        collection: event,
        anchor: { kind: "time-anchor", anchor: "now" },
        startOffset: { kind: "duration", amount: -1, unit: "d" },
        endOffset: { kind: "duration", amount: 0, unit: "d" },
      },
      {
        kind: "periods",
        collection: page,
        interval: { kind: "duration", amount: 1, unit: "mo" },
      },
      sequence,
      { kind: "adjacent", sequence },
      { kind: "without", sequence, excluded: event },
    ] as const;

    for (const target of targets) {
      const document = normalizeFilterDocument(
        { version: 1, root: { kind: "condition", target, operator: "exists" } },
        analyticsFilterRegistry,
      );
      expect(document.root).toMatchObject({ kind: "condition", target });
      expect(filterConditionCount(document)).toBeGreaterThanOrEqual(1);
      expect(() =>
        assertFilterAudience(
          document,
          analyticsFilterRegistry,
          "private-dashboard",
        ),
      ).not.toThrow();
    }

    const publicEventRelation = normalizeFilterDocument(
      {
        version: 1,
        root: {
          kind: "condition",
          target: { kind: "sequence", steps: [event, page] },
          operator: "exists",
        },
      },
      analyticsFilterRegistry,
    );
    expect(() =>
      assertFilterAudience(
        publicEventRelation,
        analyticsFilterRegistry,
        "public-share",
      ),
    ).toThrow(expect.objectContaining({ code: "field_not_allowed" }));
  });

  it("validates dynamic temporal values and field-specific bounds", () => {
    const boundedRegistry: FilterFieldRegistry = new Map([
      [
        "metric.count",
        {
          id: "metric.count",
          valueKind: "number",
          operators: new Set(["eq", "between", "in"]),
          audiences: privateAudiences,
          number: { min: 0, max: 10, step: 2 },
        },
      ],
      [
        "metric.day",
        {
          id: "metric.day",
          valueKind: "date",
          operators: new Set(["eq"]),
          audiences: privateAudiences,
        },
      ],
      [
        "metric.at",
        {
          id: "metric.at",
          valueKind: "datetime",
          operators: new Set(["eq"]),
          audiences: privateAudiences,
        },
      ],
    ]);
    const normalizeValue = (field: string, value: unknown) =>
      normalizeFilterDocument(
        { version: 1, root: fieldCondition(field, "eq", value) },
        boundedRegistry,
      );

    expect(normalizeValue("metric.count", 4).root).toMatchObject({ value: 4 });
    expect(normalizeValue("metric.day", "2024-02-29").root).toMatchObject({
      value: "2024-02-29",
    });
    expect(
      normalizeValue("metric.at", "2024-01-01T02:00:00+02:00").root,
    ).toMatchObject({ value: "2024-01-01T00:00:00.000Z" });
    expect(() => normalizeValue("metric.count", 11)).toThrow(
      expect.objectContaining({ code: "number_above_maximum" }),
    );
    expect(() => normalizeValue("metric.count", 3)).toThrow(
      expect.objectContaining({ code: "number_not_on_step" }),
    );
    expect(() => normalizeValue("metric.day", "2024-02-30")).toThrow(
      expect.objectContaining({ code: "invalid_date" }),
    );
    expect(() => normalizeValue("metric.at", "2024-01-01T00:00:00")).toThrow(
      expect.objectContaining({ code: "invalid_datetime" }),
    );
    expect(() =>
      normalizeFilterDocument(
        {
          version: 1,
          root: {
            kind: "condition",
            target: {
              kind: "member",
              object: { kind: "context-root", context: "current" },
              member: "time",
            },
            operator: "gte",
            value: { kind: "time-anchor", anchor: "now" },
          },
        },
        analyticsFilterRegistry,
      ),
    ).not.toThrow();
  });

  it("rejects invalid scalar kinds, canonicalizer output, and size limits", () => {
    const valuesRegistry: FilterFieldRegistry = new Map([
      [
        "metric.number",
        {
          id: "metric.number",
          valueKind: "number",
          operators: new Set(["eq"]),
          audiences: privateAudiences,
          number: { min: 1 },
        },
      ],
      [
        "metric.boolean",
        {
          id: "metric.boolean",
          valueKind: "boolean",
          operators: new Set(["eq"]),
          audiences: privateAudiences,
        },
      ],
      [
        "metric.date",
        {
          id: "metric.date",
          valueKind: "date",
          operators: new Set(["eq"]),
          audiences: privateAudiences,
        },
      ],
      [
        "metric.datetime",
        {
          id: "metric.datetime",
          valueKind: "datetime",
          operators: new Set(["eq"]),
          audiences: privateAudiences,
        },
      ],
      [
        "metric.string",
        {
          id: "metric.string",
          valueKind: "string",
          operators: new Set(["eq"]),
          audiences: privateAudiences,
        },
      ],
    ]);
    const normalize = (field: string, value: unknown, maxValueLength = 4_096) =>
      normalizeFilterDocument(
        { version: 1, root: fieldCondition(field, "eq", value) },
        valuesRegistry,
        { maxValueLength },
      );

    const cases: readonly [string, unknown, string][] = [
      ["metric.number", "1", "invalid_number"],
      ["metric.number", 0, "number_below_minimum"],
      ["metric.boolean", 1, "invalid_boolean"],
      ["metric.date", 20240101, "invalid_date"],
      ["metric.datetime", 20240101, "invalid_datetime"],
      ["metric.string", false, "invalid_string"],
      ["metric.string", {}, "invalid_value"],
      ["metric.string", "long", "value_too_long"],
    ];
    for (const [field, value, code] of cases) {
      expect(() => normalize(field, value, 3)).toThrow(
        expect.objectContaining({ code }),
      );
    }

    for (const [definition, value, message] of [
      [
        {
          id: "metric.numeric-canonical",
          valueKind: "number",
          operators: new Set(["eq"]),
          audiences: privateAudiences,
          canonicalize: () => "not-a-number",
        },
        2,
        "non-numeric value",
      ],
      [
        {
          id: "metric.string-canonical",
          valueKind: "string",
          operators: new Set(["eq"]),
          audiences: privateAudiences,
          canonicalize: () => null,
        },
        "ok",
        "non-string value",
      ],
      [
        {
          id: "metric.long-canonical",
          valueKind: "string",
          operators: new Set(["eq"]),
          audiences: privateAudiences,
          canonicalize: () => "more-than-limit",
        },
        "ok",
        "Canonical filter value exceeds",
      ],
    ] as const) {
      const field = definition.id;
      const registryWithCanonicalizer: FilterFieldRegistry = new Map([
        [field, definition as unknown as FilterFieldDefinition],
      ]);
      expect(() =>
        normalizeFilterDocument(
          { version: 1, root: fieldCondition(field, "eq", value) },
          registryWithCanonicalizer,
          { maxValueLength: 3 },
        ),
      ).toThrow(message);
    }
  });

  it("enforces dynamic values, set sizes, condition counts, and group depth", () => {
    const time = {
      kind: "member",
      object: { kind: "context-root", context: "current" },
      member: "time",
    } as const;
    const condition = (operator: string, value: unknown) => ({
      kind: "condition",
      target: time,
      operator,
      value,
    });
    const normalize = (root: unknown, limits: Record<string, number> = {}) =>
      normalizeFilterDocument(
        { version: 1, root },
        analyticsFilterRegistry,
        limits,
      );
    const errors: readonly [unknown, Record<string, number>, string][] = [
      [condition("in", []), {}, "invalid_set"],
      [condition("in", [1, 2]), { maxSetValues: 1 }, "too_many_set_values"],
      [
        condition("in", [{ kind: "duration", amount: 1, unit: "d" }]),
        {},
        "invalid_set",
      ],
      [condition("between", [1]), {}, "invalid_range"],
      [
        condition("between", [{ kind: "time-anchor", anchor: "now" }, 2]),
        {},
        "invalid_range",
      ],
      [condition("between", [true, false]), {}, "invalid_range"],
      [condition("between", [3, 2]), {}, "reversed_range"],
      [condition("eq", [1, 2]), {}, "invalid_scalar"],
      [
        condition("eq", { kind: "entity-root", entity: "page" }),
        {},
        "invalid_condition_value",
      ],
      [condition("eq", { nope: true }), {}, "invalid_value"],
      [condition("eq", Number.POSITIVE_INFINITY), {}, "invalid_number"],
      [condition("eq", "too long"), { maxValueLength: 3 }, "value_too_long"],
    ];
    for (const [root, limits, code] of errors) {
      expect(() => normalize(root, limits)).toThrow(
        expect.objectContaining({ code }),
      );
    }

    const predicate = fieldCondition("page.path", "exists");
    expect(() =>
      normalize(
        { kind: "and", children: [predicate, predicate] },
        { maxConditions: 1 },
      ),
    ).toThrow(expect.objectContaining({ code: "too_many_conditions" }));
    expect(() =>
      normalize(
        {
          kind: "and",
          children: [
            {
              kind: "and",
              children: [predicate, fieldCondition("geo.country", "exists")],
            },
          ],
        },
        { maxGroups: 1 },
      ),
    ).toThrow(expect.objectContaining({ code: "too_many_groups" }));
  });

  it("creates semantic fingerprints and checks audience before readers run", () => {
    const first = normalizeFilterDocument(
      {
        version: 1,
        root: {
          kind: "and",
          children: [
            fieldCondition("page.path", "eq", "/docs"),
            fieldCondition("geo.country", "eq", "us"),
          ],
        },
      },
      registry,
    );
    const second = normalizeFilterDocument(
      {
        version: 1,
        root: {
          kind: "and",
          children: [
            fieldCondition("geo.country", "eq", "US"),
            fieldCondition("page.path", "eq", "/docs"),
          ],
        },
      },
      registry,
    );
    expect(filterFingerprint(first, registry)).toBe(
      filterFingerprint(second, registry),
    );
    const privateOnly = normalizeFilterDocument(
      {
        version: 1,
        root: {
          kind: "condition",
          target: { kind: "field", field: "event.score" },
          operator: "eq",
          value: 7,
        },
      },
      registry,
    );
    expect(() =>
      assertFilterAudience(privateOnly, registry, "public-share"),
    ).toThrow(/not allowed/);
    expect(() =>
      assertFilterAudience(privateOnly, registry, "api-v1"),
    ).not.toThrow();
  });
});
