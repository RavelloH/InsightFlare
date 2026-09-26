import { describe, expect, it } from "vitest";

import {
  analyticsFilterRegistry,
  type FilterDocument,
  type FilterFieldDefinition,
  type FilterFieldRegistry,
  normalizeFilterDocument,
  parseFilterParams,
  serializeFilterParams,
} from "@/lib/edge/analytics/contract";

describe("filter URL codec", () => {
  it("parses canonical dot-namespaced filters with typed values", () => {
    const document = parseFilterParams(
      "from=1&filter[geo.country]=US&filter[event.payload][/score]=gte:json:7&filter[event.payload][/paid]=json:false",
      analyticsFilterRegistry,
    );

    expect(document).toEqual({
      version: 1,
      root: {
        kind: "and",
        children: [
          {
            kind: "condition",
            target: { kind: "event-payload", path: "/paid" },
            operator: "eq",
            value: false,
          },
          {
            kind: "condition",
            target: { kind: "event-payload", path: "/score" },
            operator: "gte",
            value: 7,
          },
          {
            kind: "condition",
            target: { kind: "field", field: "geo.country" },
            operator: "eq",
            value: "us",
          },
        ],
      },
    });
  });

  it("accepts a leading question mark in the filter query string", () => {
    expect(
      parseFilterParams("?filter[geo.country]=US", analyticsFilterRegistry)
        .root,
    ).toMatchObject({
      kind: "condition",
      target: { kind: "field", field: "geo.country" },
      value: "us",
    });
  });

  it("round trips computed targets through stable filter URL keys", () => {
    const document = parseFilterParams(
      "filter[count(event)]=gte:5&filter[first(page).path]=eq:%2Fpricing",
      analyticsFilterRegistry,
    );
    const serialized = serializeFilterParams(document, analyticsFilterRegistry);
    expect(serialized.toString()).toBe(
      "filter%5Bcount%28event%29%5D=gte+5&filter%5Bfirst%28page%29.path%5D=eq+%22%2Fpricing%22",
    );
    expect(parseFilterParams(serialized, analyticsFilterRegistry)).toEqual(
      document,
    );

    const temporal = parseFilterParams(
      "filter[countDistinct(page.path)]=gte:10&filter[time]=gte:@now-30d",
      analyticsFilterRegistry,
    );
    const temporalSerialized = serializeFilterParams(
      temporal,
      analyticsFilterRegistry,
    );
    expect(
      parseFilterParams(temporalSerialized, analyticsFilterRegistry),
    ).toEqual(temporal);
  });

  it("preserves escaped set operands and reconstructs nested OR and NOT", () => {
    const document = parseFilterParams(
      "filter[page.path]=in:/a\\,/b,/docs\\\\notes&filter[page.title][or.0]=Guide&filter[page.title][or.1.not]=Draft",
      analyticsFilterRegistry,
    );

    expect(document.root).toEqual({
      kind: "and",
      children: [
        {
          kind: "or",
          children: [
            {
              kind: "not",
              child: {
                kind: "condition",
                target: { kind: "field", field: "page.title" },
                operator: "eq",
                value: "Draft",
              },
            },
            {
              kind: "condition",
              target: { kind: "field", field: "page.title" },
              operator: "eq",
              value: "Guide",
            },
          ],
        },
        {
          kind: "condition",
          target: { kind: "field", field: "page.path" },
          operator: "in",
          value: ["/a,/b", "/docs\\notes"],
        },
      ],
    });
  });

  it("keeps unknown backslash escapes in set values", () => {
    const document = parseFilterParams(
      String.raw`filter[page.path]=in:/a\q,/b`,
      analyticsFilterRegistry,
    );

    expect(document.root).toMatchObject({
      kind: "condition",
      target: { kind: "field", field: "page.path" },
      operator: "in",
      value: [String.raw`/a\q`, "/b"],
    });
  });

  it("preserves a trailing backslash in a set value", () => {
    const params = new URLSearchParams();
    params.set("filter[page.path]", "in:/first,/tail\\");
    const document = parseFilterParams(params, analyticsFilterRegistry);

    expect(document.root).toMatchObject({
      kind: "condition",
      target: { kind: "field", field: "page.path" },
      operator: "in",
      value: ["/first", "/tail\\"],
    });
  });

  it("round-trips a canonical document through URLSearchParams", () => {
    const source: FilterDocument = {
      version: 1,
      root: {
        kind: "and",
        children: [
          {
            kind: "condition",
            target: { kind: "field", field: "geo.country" as never },
            operator: "in",
            value: ["jp", "us"],
          },
          {
            kind: "not",
            child: {
              kind: "condition",
              target: {
                kind: "event-payload",
                path: "/metadata/plan" as never,
              },
              operator: "isNull",
            },
          },
        ],
      },
    };
    const params = serializeFilterParams(source, analyticsFilterRegistry);
    expect([...params.entries()]).toEqual([
      ["filter[event.payload][/metadata/plan][not]", "null"],
      ["filter[geo.country]", "in:jp,us"],
    ]);
    expect(
      serializeFilterParams(
        parseFilterParams(params, analyticsFilterRegistry),
        analyticsFilterRegistry,
      ),
    ).toEqual(params);
  });

  it("escapes equality values that look like predicate syntax", () => {
    const document = parseFilterParams(
      "filter[page.title]=eq:in:internal",
      analyticsFilterRegistry,
    );
    expect(document.root).toMatchObject({
      kind: "condition",
      operator: "eq",
      value: "in:internal",
    });
    expect(
      serializeFilterParams(document, analyticsFilterRegistry).get(
        "filter[page.title]",
      ),
    ).toBe("eq:in:internal");
  });

  it("preserves independent OR groups at the same logical scope", () => {
    const source: FilterDocument = {
      version: 1,
      root: {
        kind: "and",
        children: [
          {
            kind: "or",
            children: [
              {
                kind: "condition",
                target: { kind: "field", field: "page.path" as never },
                operator: "eq",
                value: "/docs",
              },
              {
                kind: "condition",
                target: { kind: "field", field: "page.path" as never },
                operator: "eq",
                value: "/blog",
              },
            ],
          },
          {
            kind: "or",
            children: [
              {
                kind: "condition",
                target: { kind: "field", field: "geo.country" as never },
                operator: "eq",
                value: "us",
              },
              {
                kind: "condition",
                target: { kind: "field", field: "geo.country" as never },
                operator: "eq",
                value: "jp",
              },
            ],
          },
        ],
      },
    };
    const serialized = serializeFilterParams(source, analyticsFilterRegistry);
    expect(
      parseFilterParams(serialized, analyticsFilterRegistry).root,
    ).toMatchObject({
      kind: "and",
      children: [
        {
          kind: "condition",
          target: { kind: "field", field: "geo.country" },
          operator: "in",
          value: ["jp", "us"],
        },
        {
          kind: "condition",
          target: { kind: "field", field: "page.path" },
          operator: "in",
          value: ["/blog", "/docs"],
        },
      ],
    });
    expect(
      serializeFilterParams(
        parseFilterParams(serialized, analyticsFilterRegistry),
        analyticsFilterRegistry,
      ),
    ).toEqual(serialized);
  });

  it("serializes OR branches that target different fields", () => {
    const document = normalizeFilterDocument(
      {
        version: 1,
        root: {
          kind: "or",
          children: [
            {
              kind: "condition",
              target: { kind: "field", field: "page.path" },
              operator: "eq",
              value: "/docs",
            },
            {
              kind: "condition",
              target: { kind: "field", field: "geo.country" },
              operator: "eq",
              value: "US",
            },
          ],
        },
      },
      analyticsFilterRegistry,
    );
    const params = serializeFilterParams(document, analyticsFilterRegistry);
    expect([...params.keys()]).toEqual([
      "filter[geo.country][or.0]",
      "filter[page.path][or.1]",
    ]);
    expect(parseFilterParams(params, analyticsFilterRegistry)).toEqual(
      document,
    );
  });

  it("round-trips every valueless operator and separately indexed negations", () => {
    const valueless: FilterDocument = {
      version: 1,
      root: {
        kind: "and",
        children: [
          "exists",
          "notExists",
          "isNull",
          "notNull",
          "isEmpty",
          "notEmpty",
        ].map((operator) => ({
          kind: "condition" as const,
          target: { kind: "field" as const, field: "page.path" as never },
          operator: operator as never,
        })),
      },
    };
    const normalized = normalizeFilterDocument(
      valueless,
      analyticsFilterRegistry,
    );
    const params = serializeFilterParams(normalized, analyticsFilterRegistry);

    expect(params.getAll("filter[page.path]")).toEqual([
      "empty",
      "ex",
      "nempty",
      "nex",
      "nnull",
      "null",
    ]);
    expect(parseFilterParams(params, analyticsFilterRegistry)).toEqual(
      normalized,
    );

    const negations: FilterDocument = {
      version: 1,
      root: {
        kind: "and",
        children: [
          {
            kind: "not",
            child: {
              kind: "condition",
              target: { kind: "field", field: "page.path" as never },
              operator: "eq",
              value: "/private",
            },
          },
          {
            kind: "not",
            child: {
              kind: "condition",
              target: { kind: "field", field: "geo.country" as never },
              operator: "eq",
              value: "US",
            },
          },
        ],
      },
    };
    const normalizedNegations = normalizeFilterDocument(
      negations,
      analyticsFilterRegistry,
    );
    const negationParams = serializeFilterParams(
      normalizedNegations,
      analyticsFilterRegistry,
    );
    expect([...negationParams.keys()]).toEqual([
      "filter[geo.country][not:0]",
      "filter[page.path][not:1]",
    ]);
    expect(parseFilterParams(negationParams, analyticsFilterRegistry)).toEqual(
      normalizedNegations,
    );
  });

  it("rejects malformed keys, payload targets, unsupported operators, and unsafe branches", () => {
    expect(() =>
      parseFilterParams(
        "filter[page.path][or.x]=/docs",
        analyticsFilterRegistry,
      ),
    ).toThrow(/branch/i);
    expect(() =>
      parseFilterParams("filter[event.payload]=x", analyticsFilterRegistry),
    ).toThrow(/JSON Pointer/);
    expect(() =>
      parseFilterParams("filter[geo.country]=c:US", analyticsFilterRegistry),
    ).toThrow(/not allowed/);
    expect(() =>
      parseFilterParams("filter[page.path]x=/docs", analyticsFilterRegistry),
    ).toThrow(/Malformed filter key/);
  });

  it("handles strict keys, typed parse failures, and invalid payload JSON", () => {
    const custom: FilterFieldRegistry = new Map([
      [
        "metric.number",
        {
          id: "metric.number",
          valueKind: "number",
          operators: new Set(["eq", "in", "between"]),
          audiences: new Set(["private-dashboard"]),
        },
      ],
      [
        "metric.boolean",
        {
          id: "metric.boolean",
          valueKind: "boolean",
          operators: new Set(["eq"]),
          audiences: new Set(["private-dashboard"]),
        },
      ],
    ]);
    for (const [input, registry, code] of [
      ["filter[metric.number]=eq:", custom, "invalid_number"],
      ["filter[metric.number]=eq:NaN", custom, "invalid_number"],
      ["filter[metric.boolean]=eq:yes", custom, "invalid_boolean"],
      [
        "filter[event.payload][/x]=json:{",
        analyticsFilterRegistry,
        "invalid_json_scalar",
      ],
      [
        "filter[event.payload][/x]=json:{}",
        analyticsFilterRegistry,
        "invalid_json_scalar",
      ],
      [
        "filter[unknown.field]=eq:value",
        analyticsFilterRegistry,
        "invalid_complex_filter",
      ],
      [
        "filter[page.path][or]=/a",
        analyticsFilterRegistry,
        "invalid_logic_path",
      ],
      [
        "filter[page.path][or:x]=/a",
        analyticsFilterRegistry,
        "invalid_logic_path",
      ],
    ] as const) {
      expect(() => parseFilterParams(input, registry)).toThrow(
        expect.objectContaining({ code }),
      );
    }

    expect(
      parseFilterParams("filter[page.path=/ignored", analyticsFilterRegistry, {
        strictFilterKeys: false,
      }).root,
    ).toBeNull();
    const fromUrl = parseFilterParams(
      new URL("https://example.test/?filter%5Bpage.path%5D=%2Fdocs"),
      analyticsFilterRegistry,
    );
    expect(fromUrl.root).toMatchObject({
      kind: "condition",
      target: { kind: "field", field: "page.path" },
      value: "/docs",
    });
    expect(() =>
      parseFilterParams(
        "filter[page.path]=/docs&filter[page.path]=/other",
        analyticsFilterRegistry,
        {
          limits: { maxConditions: 1 },
        },
      ),
    ).toThrow(expect.objectContaining({ code: "too_many_conditions" }));
  });
});

describe("type-aware value encoding", () => {
  const all = new Set(["private-dashboard", "api-v1"] as const);
  const definition = (
    id: string,
    valueKind: FilterFieldDefinition["valueKind"],
  ): FilterFieldDefinition => ({
    id,
    valueKind,
    operators: new Set(["eq", "in", "between"]),
    audiences: all,
  });
  const custom: FilterFieldRegistry = new Map([
    ["metric.number", definition("metric.number", "number")],
    ["metric.boolean", definition("metric.boolean", "boolean")],
  ]);
  const typed = (root: unknown) =>
    normalizeFilterDocument({ version: 1, root }, custom);
  const payload = (root: unknown) =>
    normalizeFilterDocument({ version: 1, root }, analyticsFilterRegistry);

  it("round-trips typed number/boolean fields without a json: marker", () => {
    const numberParams = serializeFilterParams(
      typed({
        kind: "condition",
        target: { kind: "field", field: "metric.number" },
        operator: "between",
        value: [2, 50],
      }),
      custom,
    );
    expect(numberParams.get("filter[metric.number]")).toBe("bt:2,50");
    expect(
      serializeFilterParams(parseFilterParams(numberParams, custom), custom),
    ).toEqual(numberParams);

    const booleanParams = serializeFilterParams(
      typed({
        kind: "condition",
        target: { kind: "field", field: "metric.boolean" },
        operator: "eq",
        value: true,
      }),
      custom,
    );
    expect(booleanParams.get("filter[metric.boolean]")).toBe("true");
    expect(
      serializeFilterParams(parseFilterParams(booleanParams, custom), custom),
    ).toEqual(booleanParams);
  });

  it("parses typed number/boolean plain-text wire values", () => {
    expect(
      parseFilterParams("filter[metric.number]=between:2,50", custom).root,
    ).toMatchObject({
      kind: "condition",
      operator: "between",
      value: [2, 50],
    });
    expect(
      parseFilterParams("filter[metric.boolean]=eq:true", custom).root,
    ).toMatchObject({
      kind: "condition",
      operator: "eq",
      value: true,
    });
  });

  it("quotes payload strings so a leading json: is preserved on round-trip", () => {
    const source = {
      kind: "condition" as const,
      target: {
        kind: "event-payload" as const,
        path: "/metadata/note" as never,
      },
      operator: "eq" as const,
      value: "json:true",
    };
    const params = serializeFilterParams(
      payload(source),
      analyticsFilterRegistry,
    );
    expect(params.get("filter[event.payload][/metadata/note]")).toBe(
      'json:"json:true"',
    );
    expect(parseFilterParams(params, analyticsFilterRegistry).root).toEqual(
      source,
    );
  });

  it("round-trips payload strings with json: prefix and embedded commas in lists", () => {
    const source = {
      kind: "condition" as const,
      target: {
        kind: "event-payload" as const,
        path: "/metadata/tags" as never,
      },
      operator: "in" as const,
      value: ["c:d", "json:a,b", "plain"],
    };
    const params = serializeFilterParams(
      payload(source),
      analyticsFilterRegistry,
    );
    expect(params.get("filter[event.payload][/metadata/tags]")).toBe(
      'in:c:d,json:"json:a\\,b",plain',
    );
    expect(parseFilterParams(params, analyticsFilterRegistry).root).toEqual(
      source,
    );
  });

  it("preserves commas and backslashes in scalar payload and page strings", () => {
    const cases: Array<
      [
        string,
        { kind: "field" | "event-payload"; field?: string; path?: string },
      ]
    > = [
      ["filter[event.payload][/x]", { kind: "event-payload", path: "/x" }],
      ["filter[page.path]", { kind: "field", field: "page.path" }],
    ];
    for (const [key, target] of cases) {
      const source = {
        kind: "condition" as const,
        target: target as never,
        operator: "eq" as const,
        value: "a,b\\c",
      };
      const params = serializeFilterParams(
        payload(source),
        analyticsFilterRegistry,
      );
      expect(params.get(key)).toBe("a,b\\c");
      expect(parseFilterParams(params, analyticsFilterRegistry).root).toEqual(
        source,
      );
    }
  });

  it("still guards payload strings that collide with operator aliases", () => {
    const source = {
      kind: "condition" as const,
      target: { kind: "event-payload" as const, path: "/x" as never },
      operator: "eq" as const,
      value: "in:internal",
    };
    const params = serializeFilterParams(
      payload(source),
      analyticsFilterRegistry,
    );
    expect(params.get("filter[event.payload][/x]")).toBe("eq:in:internal");
    expect(parseFilterParams(params, analyticsFilterRegistry).root).toEqual(
      source,
    );
  });
});
