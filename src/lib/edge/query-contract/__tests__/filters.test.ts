import { describe, expect, it } from "vitest";

import {
  ANALYTICS_FILTER_FIELD_IDS,
  analyticsFilterRegistry,
  assertFilterAudience,
  type FilterFieldDefinition,
  type FilterFieldRegistry,
  filterFingerprint,
  hasEffectiveFilters,
  normalizeFilterDocument,
  queryPolicyForAudience,
  stripTopLevelFacet,
} from "@/lib/edge/query-contract";

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
    expect(analyticsFilterRegistry.get("event.payload")?.valueKind).toBe(
      "json-scalar",
    );
    expect(analyticsFilterRegistry.get("event.payload")).toMatchObject({
      source: "payload",
      presence: "json-pointer",
      empty: "raw-empty-string",
      comparison: "case-sensitive",
    });
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
    expect(stripTopLevelFacet(conjunction, "page.path").root).toEqual(other);

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
