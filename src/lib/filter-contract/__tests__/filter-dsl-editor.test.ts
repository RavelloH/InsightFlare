import { describe, expect, it } from "vitest";

import {
  analyticsFilterRegistry,
  assertFilterAudience,
  FILTER_DSL_EXAMPLES,
  filterDslDisplayTokens,
  filterDslFeatures,
  formatFilterDsl,
  formatFilterDslPretty,
  parseFilterDsl,
} from "@/lib/filter-contract";

describe("filter DSL editor integration", () => {
  it("round-trips typed values and nested boolean relationships", () => {
    const source =
      'page.path eq "/pricing" AND (referrer.domain eq "google.com" OR NOT client.deviceType in ["Mobile", "Tablet"])';
    const document = parseFilterDsl(source, analyticsFilterRegistry);
    const formatted = formatFilterDsl(document);

    expect(document.root).toBeTruthy();
    expect(parseFilterDsl(formatted, analyticsFilterRegistry)).toEqual(
      document,
    );
  });

  it("preserves null, numeric ranges, and valueless operators", () => {
    const source =
      'geo.region isNull OR (page.path exists AND event.payload("/score") between [120, 130])';
    const document = parseFilterDsl(source, analyticsFilterRegistry);

    expect(
      parseFilterDsl(formatFilterDsl(document), analyticsFilterRegistry),
    ).toEqual(document);
  });

  it("supports event payload targets without conflating their JSON path", () => {
    const source = 'event.payload("/metadata/score") gte 7';
    const document = parseFilterDsl(source, analyticsFilterRegistry);

    expect(formatFilterDsl(document)).toBe(source);
  });

  it("keeps pasted condition order for the visual editor while validating it", () => {
    const source =
      'referrer.domain eq "google.com" AND page.path eq "/pricing" AND referrer.domain eq "google.com"';
    const document = parseFilterDsl(source, analyticsFilterRegistry);

    expect(formatFilterDsl(document)).toBe(source);
  });

  it("retains explicit nested groups and JSON string-list values", () => {
    const source =
      'page.path eq "/pricing" AND (referrer.domain in ["news,example.com", ""] AND geo.region notNull)';
    const document = parseFilterDsl(source, analyticsFilterRegistry);

    expect(formatFilterDsl(document)).toBe(
      'page.path eq "/pricing" AND (referrer.domain in ["news,example.com", ""] AND geo.region notNull)',
    );
    expect(document.root).toMatchObject({
      kind: "and",
      children: [
        { kind: "condition" },
        {
          kind: "and",
          children: [
            {
              kind: "condition",
              value: ["news,example.com", ""],
            },
            { kind: "condition" },
          ],
        },
      ],
    });
  });

  it("supports an explicit single-condition boolean group", () => {
    const source = 'AND(page.path eq "/pricing")';
    const document = parseFilterDsl(source, analyticsFilterRegistry);

    expect(formatFilterDsl(document)).toBe(source);
  });

  it("rejects incomplete syntax", () => {
    expect(() =>
      parseFilterDsl("page.path eq", analyticsFilterRegistry),
    ).toThrow("expected_value");
    expect(() =>
      parseFilterDsl(
        'page.path eq "/" AND (client.browser eq "Chrome"',
        analyticsFilterRegistry,
      ),
    ).toThrow("missing_closing_parenthesis");
  });

  it("parses empty documents and escaped strings", () => {
    expect(parseFilterDsl("   ", analyticsFilterRegistry)).toMatchObject({
      root: null,
    });

    const document = parseFilterDsl(
      'page.path eq "escaped \\"quote\\""',
      analyticsFilterRegistry,
    );

    expect(formatFilterDsl(document)).toBe(
      'page.path eq "escaped \\"quote\\""',
    );
    expect(() =>
      parseFilterDsl("geo.region eq null", analyticsFilterRegistry),
    ).toThrow("Use isNull or notNull instead of comparing to null");
  });

  it("validates parsed boolean values and empty value collections", () => {
    expect(() =>
      parseFilterDsl("page.path eq false", analyticsFilterRegistry),
    ).toThrow();
    expect(() =>
      parseFilterDsl("client.browser in []", analyticsFilterRegistry),
    ).toThrow("Set operators require a non-empty value array");
  });

  it("reports malformed targets, values, and tokens", () => {
    const cases: readonly [string, string][] = [
      ["event.payload(1) eq 1", "expected_payload_path"],
      ['event.payload("/score" eq 1', "missing_payload_parenthesis"],
      ['page.path unexpected "value"', "unknown_operator"],
      ['page.path eq ["value"', "missing_list_bracket"],
      ["page.path eq @", "invalid_token"],
      ['"field" eq "value"', "expected_identifier"],
      ['page.path eq "value" "extra"', "unexpected_token"],
      ['page.path eq "unterminated', "unterminated_string"],
    ];

    for (const [source, message] of cases) {
      expect(() => parseFilterDsl(source, analyticsFilterRegistry)).toThrow(
        message,
      );
    }
  });
});

describe("read-only DSL presentation", () => {
  it.each(FILTER_DSL_EXAMPLES)(
    "formats without changing the parsed document: %s",
    (source) => {
      const document = parseFilterDsl(source, analyticsFilterRegistry);
      const pretty = formatFilterDslPretty(document, analyticsFilterRegistry);
      expect(parseFilterDsl(pretty, analyticsFilterRegistry)).toEqual(document);
      expect(
        formatFilterDslPretty(
          parseFilterDsl(pretty, analyticsFilterRegistry),
          analyticsFilterRegistry,
        ),
      ).toBe(pretty);
    },
  );
  it("preserves quoted keywords and source whitespace in highlighting", () => {
    const source =
      'page.path eq "/AND OR NOT" AND\n  geo.country in ["US", "GB"]';
    const tokens = filterDslDisplayTokens(source);
    expect(tokens.map((token) => token.text).join("")).toBe(source);
    expect(
      tokens
        .filter((token) => token.kind === "keyword")
        .map((token) => token.text),
    ).toEqual(["AND"]);
    expect(tokens.find((token) => token.kind === "string")?.text).toBe(
      '"/AND OR NOT"',
    );
    expect(
      formatFilterDslPretty(
        parseFilterDsl(source, analyticsFilterRegistry),
        analyticsFilterRegistry,
      ),
    ).toContain("AND\n");
  });
  it("keeps invalid source readable", () => {
    const source = 'page.path eq "unfinished';
    expect(
      filterDslDisplayTokens(source)
        .map((token) => token.text)
        .join(""),
    ).toBe(source);
  });
});

it("derives feature tags from AST instead of matching words in strings", () => {
  const document = parseFilterDsl(
    'sequence([EVENT { $.name eq "count" }, EVENT { $.name eq "purchase" }]) { $span lte 14d } exists',
    analyticsFilterRegistry,
  );
  expect(filterDslFeatures(document)).toEqual(
    expect.arrayContaining(["sequence", "selector", "$span"]),
  );
  expect(filterDslFeatures(document)).not.toContain("count");
});

it("uses conventional delimiters and trailing boolean connectors", () => {
  const source =
    '(page.path eq "/a" OR page.path eq "/b") AND client.deviceType eq "mobile"';
  expect(
    formatFilterDslPretty(
      parseFilterDsl(source, analyticsFilterRegistry),
      analyticsFilterRegistry,
    ),
  ).toBe(
    '(\n  page.path eq "/a" OR\n  page.path eq "/b"\n) AND\nclient.deviceType eq "mobile"',
  );
});
it("keeps preceding tokens colored during incomplete strings", () => {
  const source = 'page.path eq "/unfinished';
  const tokens = filterDslDisplayTokens(source);
  expect(tokens.map((t) => t.text).join("")).toBe(source);
  expect(tokens.find((t) => t.text === "eq")?.kind).toBe("operator");
  expect(tokens.at(-1)?.kind).toBe("string");
});

it("checks countDistinct against its numeric result without bypassing field audience", () => {
  for (const source of [
    "countDistinct(PAGE -> path) gte 4",
    "countDistinct(PAGE -> client.deviceType) gte 2",
    "countDistinct(PAGE -> referrer.domain) gte 2",
  ]) {
    const doc = parseFilterDsl(source, analyticsFilterRegistry);
    expect(() =>
      assertFilterAudience(doc, analyticsFilterRegistry, "public-share"),
    ).not.toThrow();
  }
  const privateDoc = parseFilterDsl(
    'countDistinct(EVENT -> payload("/sku")) gte 2',
    analyticsFilterRegistry,
  );
  expect(() =>
    assertFilterAudience(privateDoc, analyticsFilterRegistry, "public-share"),
  ).toThrow();
});
