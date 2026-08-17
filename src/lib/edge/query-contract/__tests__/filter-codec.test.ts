import { describe, expect, it } from "vitest";

import {
  analyticsFilterRegistry,
  type FilterDocument,
  parseFilterParams,
  serializeFilterParams,
} from "@/lib/edge/query-contract";

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
    expect([...serialized.keys()].some((key) => key.includes("or:0"))).toBe(
      true,
    );
    expect([...serialized.keys()].some((key) => key.includes("or:1"))).toBe(
      true,
    );
    expect(
      serializeFilterParams(
        parseFilterParams(serialized, analyticsFilterRegistry),
        analyticsFilterRegistry,
      ),
    ).toEqual(serialized);
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
});
