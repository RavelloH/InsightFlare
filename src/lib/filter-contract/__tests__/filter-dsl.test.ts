import { describe, expect, it } from "vitest";

import {
  analyticsFilterRegistry,
  FILTER_DSL_EXAMPLES,
  FILTER_DSL_MAX_LENGTH,
  FILTER_DSL_OPERATOR_IDS,
  FILTER_DSL_SYNTAX,
  FILTER_DSL_VERSION,
  FilterDslParseError,
  type FilterFieldRegistry,
  FilterValidationError,
  formatFilterDsl,
  parseFilterDsl,
} from "@/lib/filter-contract";

function parseError(source: string): FilterDslParseError {
  try {
    parseFilterDsl(source, analyticsFilterRegistry);
  } catch (error) {
    if (error instanceof FilterDslParseError) return error;
    throw error;
  }
  throw new Error("Expected parseFilterDsl to fail.");
}

describe("filter DSL v1", () => {
  it("publishes self-consistent syntax help for API discovery", () => {
    expect(FILTER_DSL_VERSION).toBe(1);
    expect(FILTER_DSL_MAX_LENGTH).toBe(65_536);
    expect(FILTER_DSL_OPERATOR_IDS).toContain("startsWith");
    expect(FILTER_DSL_SYNTAX.condition).toBe("<field> <operator> <value>");
    for (const example of FILTER_DSL_EXAMPLES) {
      expect(parseFilterDsl(example, analyticsFilterRegistry).version).toBe(1);
    }
  });

  it("exposes version 1 and round-trips the dashboard expression syntax", () => {
    const source =
      'page.path eq "/pricing" AND (referrer.domain eq "google.com" OR NOT client.deviceType in ["Mobile", "Tablet"])';
    const document = parseFilterDsl(source, analyticsFilterRegistry);

    expect(FILTER_DSL_VERSION).toBe(1);
    expect(document.version).toBe(1);
    expect(formatFilterDsl(document)).toBe(
      'page.path eq "/pricing" AND (referrer.domain eq "google.com" OR NOT client.deviceType in ["Mobile","Tablet"])',
    );
    expect(
      parseFilterDsl(formatFilterDsl(document), analyticsFilterRegistry),
    ).toEqual(document);
  });

  it("supports every v1 operator spelling, typed values, precedence, and payload targets", () => {
    const numberRegistry: FilterFieldRegistry = new Map([
      [
        "metric.number",
        {
          id: "metric.number",
          valueKind: "number",
          operators: new Set([
            "eq",
            "neq",
            "in",
            "notIn",
            "gt",
            "gte",
            "lt",
            "lte",
            "between",
            "exists",
            "notExists",
            "isNull",
            "notNull",
          ]),
          audiences: new Set(["private-dashboard"]),
        },
      ],
      ["event.payload", analyticsFilterRegistry.get("event.payload")!],
    ]);
    const expressions = [
      "metric.number eq 1",
      "metric.number neq 1",
      "metric.number in [1,2]",
      "metric.number notIn [1,2]",
      "metric.number gt 1",
      "metric.number gte 1",
      "metric.number lt 2",
      "metric.number lte 2",
      "metric.number between [1,2]",
      "metric.number exists",
      "metric.number notExists",
      "metric.number isNull",
      "metric.number notNull",
      'event.payload("/metadata/enabled") eq true',
      'event.payload("/metadata/value") isNull',
      'page.path contains "docs"',
      'page.path startsWith "/docs"',
      'page.path endsWith "guide"',
      "page.path isEmpty",
      "page.path notEmpty",
    ];

    for (const source of expressions) {
      const registry =
        source.startsWith("metric") || source.startsWith("event")
          ? numberRegistry
          : analyticsFilterRegistry;
      const document = parseFilterDsl(source, registry);
      expect(formatFilterDsl(document)).toBe(source);
    }

    const precedence = parseFilterDsl(
      'NOT page.path eq "private" AND page.path eq "docs" OR page.path eq "public"',
      analyticsFilterRegistry,
    );
    expect(precedence.root?.kind).toBe("or");
    expect(formatFilterDsl(precedence)).toBe(
      'NOT page.path eq "private" AND page.path eq "docs" OR page.path eq "public"',
    );
  });

  it("retains explicit boolean groups and empty documents", () => {
    const document = parseFilterDsl(
      'AND(page.path eq "/pricing")',
      analyticsFilterRegistry,
    );
    expect(formatFilterDsl(document)).toBe('AND(page.path eq "/pricing")');
    expect(
      formatFilterDsl(parseFilterDsl("   ", analyticsFilterRegistry)),
    ).toBe("");
  });

  it("reports syntax failures with stable codes and source offsets", () => {
    const cases: readonly [string, string, number, number][] = [
      ["page.path eq", "expected_value", "page.path eq".length, 0],
      [
        'page.path unexpected "value"',
        "unknown_operator",
        'page.path unexpected "value"'.indexOf("unexpected"),
        "unexpected".length,
      ],
      [
        "event.payload(1) eq 1",
        "expected_payload_path",
        "event.payload(1) eq 1".indexOf("1"),
        1,
      ],
      [
        'event.payload("/score" eq 1',
        "missing_payload_parenthesis",
        'event.payload("/score" eq 1'.indexOf("eq"),
        2,
      ],
      [
        'page.path eq ["value"',
        "missing_list_bracket",
        'page.path eq ["value"'.length,
        0,
      ],
      ["page.path eq @", "invalid_token", 13, 1],
      ['page.path eq "unterminated', "unterminated_string", 13, 13],
      [
        'page.path eq "/" AND (client.browser eq "Chrome"',
        "missing_closing_parenthesis",
        'page.path eq "/" AND (client.browser eq "Chrome"'.length,
        0,
      ],
    ];

    for (const [source, code, offset, length] of cases) {
      const error = parseError(source);
      expect(error.code).toBe(code);
      expect(error.offset).toBe(offset);
      expect(error.length).toBe(length);
      expect(error.source).toBe(source);
      expect(error.message).toContain(code);
    }
  });

  it("wraps unified registry validation with the offending source location", () => {
    const invalidBoolean = parseError("page.path eq false");
    expect(invalidBoolean.code).toBe("invalid_string");
    expect(invalidBoolean.offset).toBe("page.path eq ".length);
    expect(invalidBoolean.message).toContain("Expected a string");
    expect(invalidBoolean.cause).toBeInstanceOf(FilterValidationError);

    const invalidTarget = parseError(
      'event.payload("/metadata//value") exists',
    );
    expect(invalidTarget.code).toBe("invalid_json_path");
    expect(invalidTarget.offset).toBe(
      'event.payload("/metadata//value") exists'.indexOf('"/metadata'),
    );

    const unknownField = parseError('missing.field eq "value"');
    expect(unknownField.code).toBe("unknown_field");
    expect(unknownField.offset).toBe(0);
    expect(unknownField.cause).toBeInstanceOf(FilterValidationError);

    const disallowedOperator = parseError('session.entryPath contains "/docs"');
    expect(disallowedOperator.code).toBe("operator_not_allowed");
    expect(disallowedOperator.offset).toBe(
      'session.entryPath contains "/docs"'.indexOf("contains"),
    );

    const invalidNull = parseError("page.path eq null");
    expect(invalidNull.code).toBe("null_requires_unary_operator");
    expect(invalidNull.offset).toBe("page.path eq ".length);
  });

  it("exposes the expected token and original source for syntax errors", () => {
    const source = "page.path eq";
    const error = parseError(source);

    expect(error).toMatchObject({
      code: "expected_value",
      offset: source.length,
      length: 0,
      expected: "a JSON scalar value",
      source,
    });
    expect(error.message).toContain(
      "Expected a JSON string, number, boolean, or null value.",
    );
  });

  it("covers parser boundaries and preserves complete error details", () => {
    const cases: readonly [string, string, string][] = [
      [
        "page.path",
        "expected_identifier",
        "Expected a filter field or operator identifier.",
      ],
      [
        'AND(page.path eq "/pricing"',
        "missing_closing_parenthesis",
        "Missing closing parenthesis for boolean group.",
      ],
      [
        'page.path eq "value" "extra"',
        "unexpected_token",
        "Unexpected token after the filter expression.",
      ],
      [
        "page.path eq 1e999",
        "invalid_number",
        "JSON number is outside the supported finite range.",
      ],
      [
        'page.path eq ["one", "two"]',
        "invalid_scalar",
        "Scalar operators require one scalar value.",
      ],
      [
        'event.payload eq "value"',
        "invalid_target",
        "event.payload requires an event-payload target with a JSON pointer path.",
      ],
    ];

    for (const [source, code, message] of cases) {
      const error = parseError(source);
      expect(error.code).toBe(code);
      expect(error.message).toContain(message);
      expect(error.source).toBe(source);
      expect(error.message).toContain(`at offset ${error.offset}`);
    }
  });

  it("reports validation locations through negation, groups, lists, and ranges", () => {
    const numberRegistry: FilterFieldRegistry = new Map([
      [
        "metric.number",
        {
          id: "metric.number",
          valueKind: "number",
          operators: new Set(["in", "between"]),
          audiences: new Set(["private-dashboard"]),
        },
      ],
    ]);

    const negated = parseError("NOT page.path eq false");
    expect(negated.code).toBe("invalid_string");
    expect(negated.offset).toBe("NOT page.path eq ".length);

    const grouped = parseError('page.path eq "/ok" AND page.path eq false');
    expect(grouped.code).toBe("invalid_string");
    expect(grouped.offset).toBe('page.path eq "/ok" AND page.path eq '.length);

    const invalidList = (() => {
      try {
        parseFilterDsl('metric.number in ["not-a-number"]', numberRegistry);
      } catch (error) {
        if (error instanceof FilterDslParseError) return error;
        throw error;
      }
      throw new Error("Expected parseFilterDsl to fail.");
    })();
    expect(invalidList.code).toBe("invalid_number");
    expect(invalidList.offset).toBe(
      'metric.number in ["not-a-number"]'.indexOf('"not-a-number"'),
    );

    for (const [source, code, message] of [
      [
        "metric.number between [1]",
        "invalid_range",
        "Between requires exactly two values.",
      ],
      [
        "metric.number between [2, 1]",
        "reversed_range",
        "Between endpoints must be ordered from lower to upper.",
      ],
    ] as const) {
      const error = (() => {
        try {
          parseFilterDsl(source, numberRegistry);
        } catch (caught) {
          if (caught instanceof FilterDslParseError) return caught;
          throw caught;
        }
        throw new Error("Expected parseFilterDsl to fail.");
      })();
      expect(error.code).toBe(code);
      expect(error.message).toContain(message);
    }
  });

  it("covers alternate groups, JSON scalar ranges, and invalid literals", () => {
    const grouped = parseFilterDsl(
      'OR(page.path eq "/a" OR page.path eq "/b")',
      analyticsFilterRegistry,
    );
    expect(formatFilterDsl(grouped)).toBe(
      'OR(page.path eq "/a" OR page.path eq "/b")',
    );

    const nestedNot = parseFilterDsl(
      "NOT NOT page.path exists",
      analyticsFilterRegistry,
    );
    expect(formatFilterDsl(nestedNot)).toBe("NOT NOT page.path exists");

    const payload = parseFilterDsl(
      'event.payload("/metadata/value") eq "ready"',
      analyticsFilterRegistry,
    );
    expect(formatFilterDsl(payload)).toBe(
      'event.payload("/metadata/value") eq "ready"',
    );

    const mixedPayloadRange = parseError(
      'event.payload("/score") between [1, "2"]',
    );
    expect(mixedPayloadRange.code).toBe("invalid_range");
    expect(mixedPayloadRange.message).toContain(
      "JSON scalar ranges require two values of the same ordered type.",
    );

    const invalidLiteral = parseError('page.path eq "\\uZZZZ"');
    expect(invalidLiteral.code).toBe("invalid_string");
    expect(invalidLiteral.message).toContain("Invalid JSON string literal.");

    const constructed = new FilterDslParseError("Manual error", {
      code: "manual",
      offset: 0,
    });
    expect(constructed.length).toBe(1);
    expect(constructed.message).toContain("at offset 0 (end of input).");
  });

  it("keeps safe source locations for nested validator paths", () => {
    const parseWithValidationPath = (source: string, path: string) => {
      const registry: FilterFieldRegistry = new Map([
        [
          "test.field",
          {
            id: "test.field",
            valueKind: "string",
            operators: new Set(["eq"]),
            audiences: new Set(["private-dashboard"]),
            canonicalize: () => {
              throw new FilterValidationError(
                "synthetic_validation",
                path,
                "Synthetic validation failure.",
              );
            },
          },
        ],
      ]);

      try {
        parseFilterDsl(source, registry);
      } catch (error) {
        if (error instanceof FilterDslParseError) return error;
        throw error;
      }
      throw new Error("Expected parseFilterDsl to fail.");
    };

    const condition = 'test.field eq "value"';
    const group = `AND(${condition})`;
    const cases: readonly [string, string][] = [
      [condition, "not.root"],
      [condition, "root.children"],
      [condition, "root.children[0]"],
      [group, "root.children[99]"],
      [group, "root.target.field"],
      [group, "root.target.path"],
      [group, "root.target"],
      [group, "root.operator"],
      [group, "root.value[0]"],
      [group, "root.children[0].value[99]"],
      [group, "root.field"],
      [group, "root.path"],
      [group, "root.kind"],
      [group, "root.unknown"],
    ];

    for (const [source, path] of cases) {
      const error = parseWithValidationPath(source, path);
      expect(error).toMatchObject({
        code: "synthetic_validation",
        source,
        cause: expect.any(FilterValidationError),
      });
      expect(error.message).toContain("Synthetic validation failure.");
      expect(error.offset).toBeGreaterThanOrEqual(0);
      expect(error.offset).toBeLessThanOrEqual(source.length);
    }
  });
});
