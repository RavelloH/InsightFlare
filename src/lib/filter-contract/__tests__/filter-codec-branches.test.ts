import { describe, expect, it } from "vitest";

import {
  analyticsFilterRegistry,
  applyFiltersToUrl,
  type FilterFieldRegistry,
  normalizeFilterDocument,
  parseFilterDsl,
  parseFilterParams,
  serializeFilterParams,
  serializeFilterQuery,
} from "@/lib/filter-contract";

function parse(
  query: string,
  options?: Parameters<typeof parseFilterParams>[2],
) {
  return parseFilterParams(query, analyticsFilterRegistry, options);
}

function codeOf(
  query: string,
  options?: Parameters<typeof parseFilterParams>[2],
) {
  try {
    parse(query, options);
  } catch (error) {
    return (error as { code?: string }).code;
  }
  return undefined;
}

const booleanRegistry: FilterFieldRegistry = new Map([
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

describe("filter codec value parsing", () => {
  it("parses false for boolean fields", () => {
    expect(
      parseFilterParams("filter[metric.boolean]=eq:false", booleanRegistry)
        .root,
    ).toMatchObject({
      kind: "condition",
      operator: "eq",
      value: false,
    });
  });

  it("rejects payload JSON numbers that are not finite", () => {
    expect(codeOf("filter[event.payload][/x]=json:1e999")).toBe(
      "invalid_json_scalar",
    );
  });

  it("parses valueless operator aliases for plain fields", () => {
    for (const [alias, operator] of [
      ["ex", "exists"],
      ["nex", "notExists"],
      ["null", "isNull"],
    ] as const) {
      expect(parse(`filter[geo.country]=${alias}`).root).toMatchObject({
        kind: "condition",
        target: { kind: "field", field: "geo.country" },
        operator,
      });
    }
  });

  it("keeps quoted computed values containing escaped quotes and marker-like text", () => {
    const quoted = parse('filter[first(page).path]=eq:"a\\"b"');
    expect(quoted.root).toMatchObject({ operator: "eq", value: 'a"b' });
    const marker = parse(
      'filter[first(page).path]=eq:"__insightflare_filter_url_ref_0__"',
    );
    expect(marker.root).toMatchObject({
      value: "__insightflare_filter_url_ref_0__",
    });
    // Serialization quotes the marker text so it survives a second parse.
    const params = serializeFilterParams(marker, analyticsFilterRegistry);
    expect(parseFilterParams(params, analyticsFilterRegistry)).toEqual(marker);
  });
});

describe("filter codec selector declarations", () => {
  it("rejects selectors that are referenced but never declared", () => {
    expect(codeOf("filter[count(event:0)]=gte:2")).toBe(
      "unbound_selector_reference",
    );
    expect(codeOf("filter[count(sequence:0)]=gte:1")).toBe(
      "unbound_selector_reference",
    );
    expect(
      codeOf(
        "filter[count(event:0)]=gte:2&filter[event:0][event.name]=a&filter[page:0][source]=page",
      ),
    ).toBe("unbound_selector_reference");
  });

  it("rejects selector keys with more than one logic path", () => {
    expect(
      codeOf(
        "filter[count(event:0)]=gte:2&filter[event:0][event.name][a][b]=purchase",
      ),
    ).toBe("invalid_filter_key");
    expect(
      codeOf(
        "filter[count(event:0)]=gte:2&filter[event:0][event.name][or.0][x]=purchase",
      ),
    ).toBe("invalid_filter_key");
    expect(codeOf("filter[event.name][a][b]=x")).toBe("invalid_filter_key");
  });

  it("rejects selector source declarations with an invalid path", () => {
    expect(
      codeOf(
        "filter[count(event:0)]=gte:2&filter[event:0][event.name]=purchase&filter[event:0][source][x]=event",
      ),
    ).toBe("invalid_filter_key");
  });

  it("rejects unknown complex targets and oversize selector values", () => {
    expect(
      codeOf('filter[count(event) gte 1 OR page.path eq "/a"]=exists'),
    ).toBe("invalid_complex_filter");
    expect(
      codeOf(
        "filter[count(event:0)]=gte:2&filter[event:0][event.name]=abcdef",
        { limits: { maxValueLength: 5 } },
      ),
    ).toBe("value_too_long");
  });

  it("rejects malformed filter keys unless strict key checking is disabled", () => {
    expect(codeOf("filter[page.path=/ignored")).toBe("invalid_filter_key");
    expect(
      parse("filter[page.path=/ignored", { strictFilterKeys: false }).root,
    ).toBeNull();
  });

  it("ignores selectors that no top-level condition references", () => {
    expect(parse("filter[event:0][event.name]=purchase").root).toBeNull();
  });

  it("nests selectors declared inside other selectors", () => {
    const document = parse(
      "filter[count(event:0)]=gte:2&filter[event:0][event:1]=exists&filter[event:1][event.name]=a",
    );
    expect(document.root).toMatchObject({
      kind: "condition",
      target: {
        kind: "reducer",
        reducer: "count",
        input: {
          kind: "selector",
          predicate: { kind: "condition", target: { kind: "selector" } },
        },
      },
    });
  });
});

describe("filter codec round trips", () => {
  const sources = [
    'count(event { event.name eq "a" } { event.payload("/x") gt 1 }) gte 1',
    'sub(count(event { event.name eq "a" }), count(event { event.name eq "b" })) gte 1',
    'sum(event { event.name eq "a" }.payload("/x")) gt 3',
    'countDistinct(event { event.name eq "a" }.payload("/x")) gt 3',
    'sequence([event { event.name eq "a" }, event { event.name eq "b" }]) { $same(event.payload("/x")) AND $gap(1, 2) lte 1h } exists',
    "time between [@now-1d, @now] AND session.views gt 1 AND visitor.sessions gt 2",
    "count(event) between [1, 5]",
    "count(event) notIn [1, 2]",
    'first(page).path in ["/a", "/b"]',
    'first(page).path startsWith "a"',
    "first(page).path isEmpty",
    "sub(time(first(event)), time(last(event))) gt 1d",
    'time gte "2026-01-01T00:00:00Z"',
  ];

  it.each(sources)("round-trips %s", (source) => {
    const document = normalizeFilterDocument(
      parseFilterDsl(source, analyticsFilterRegistry),
      analyticsFilterRegistry,
    );
    const params = serializeFilterParams(document, analyticsFilterRegistry);
    expect(parseFilterParams(params, analyticsFilterRegistry)).toEqual(
      document,
    );
    expect(serializeFilterQuery(document, analyticsFilterRegistry)).toBe(
      params.toString(),
    );
  });

  it("replaces existing filter parameters when applying a document to a URL", () => {
    const document = parse("filter[geo.country]=us");
    const url = applyFiltersToUrl(
      "https://example.test/dashboard?from=1&filter[page.path]=/old",
      document,
      analyticsFilterRegistry,
    );
    expect(url.searchParams.get("from")).toBe("1");
    expect(url.searchParams.get("filter[page.path]")).toBeNull();
    expect(url.searchParams.get("filter[geo.country]")).toBe("us");
  });
});

describe("filter codec computed operand fallbacks", () => {
  it("quotes operands that are not valid DSL literals", () => {
    expect(parse("filter[first(page).path]=eq:hello world").root).toMatchObject(
      { operator: "eq", value: "hello world" },
    );
    expect(parse("filter[first(page).path]=in:a b,c d").root).toMatchObject({
      operator: "in",
      value: ["a b", "c d"],
    });
  });

  it("treats a valueless alias with a trailing operand as the valueless operator", () => {
    expect(parse("filter[first(page).path]=ex:ignored").root).toMatchObject({
      operator: "exists",
    });
  });

  it("rejects computed targets that parse into more than one condition", () => {
    expect(codeOf('filter[count(event) gte 1 AND page.path]=eq "/a"')).toBe(
      "invalid_complex_filter",
    );
  });

  it("resolves selector references next to quoted strings and marker collisions", () => {
    const query =
      'filter[first(event:0).name]=eq:"a\\"b"&filter[event:0][event.name]=signup';
    expect(parse(query).root).toMatchObject({
      operator: "eq",
      value: 'a"b',
      target: {
        member: "name",
        object: { reducer: "first", input: { kind: "selector" } },
      },
    });
    const collision =
      'filter[first(event:0).name]=eq:"__insightflare_filter_url_ref_0__"&filter[event:0][event.name]=signup';
    expect(parse(collision).root).toMatchObject({
      value: "__insightflare_filter_url_ref_0__",
      target: { object: { input: { kind: "selector" } } },
    });
  });
});

describe("filter codec nested selectors in computed keys", () => {
  it("rewrites selector references inside literal selector predicates", () => {
    const query =
      'filter[count(event { NOT event:0 exists AND (event:0 exists OR event.name eq "x") })]=gte:1&filter[event:0][event.name]=a';
    const document = parse(query);
    const target = (document.root as { target: unknown }).target as {
      input: { predicate: { kind: string } };
    };
    expect(target.input.predicate.kind).toBe("and");
  });

  it("scans quoted brackets and escapes inside literal selector keys", () => {
    const query = 'filter[count(event { event.name eq "a]b\\"c" })]=gte:1';
    expect(parse(query).root).toMatchObject({
      operator: "gte",
      value: 1,
      target: { reducer: "count" },
    });
  });

  it("rejects nested selector keys with more than one logic path", () => {
    expect(
      codeOf(
        "filter[count(event:0)]=gte:1&filter[event:0][event:1]=exists&filter[event:1][event.name]=a&filter[event:0][event:1][event.name][a][b]=x",
      ),
    ).toBe("invalid_filter_key");
  });

  it("reports semantic problems found after parsing as codec errors", () => {
    expect(codeOf('filter[count(event)]=gte:"x"')).toBe(
      "condition_type_mismatch",
    );
  });
});

describe("filter codec computed value serialization", () => {
  it("round-trips field operands inside sequence payload identity", () => {
    for (const source of [
      'sequence([event { event.name eq "a" }, event { event.name eq "b" }]) { $same(client.browser) } exists',
    ]) {
      const document = normalizeFilterDocument(
        parseFilterDsl(source, analyticsFilterRegistry),
        analyticsFilterRegistry,
      );
      const params = serializeFilterParams(document, analyticsFilterRegistry);
      expect(parseFilterParams(params, analyticsFilterRegistry)).toEqual(
        document,
      );
    }
  });
});
