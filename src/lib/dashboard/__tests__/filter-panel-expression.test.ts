import { describe, expect, it } from "vitest";

import {
  formatFilterPanelExpression,
  parseFilterPanelExpression,
} from "@/lib/dashboard/filter-panel-expression";
import { analyticsFilterRegistry } from "@/lib/filter-contract";

describe("filter panel expression", () => {
  it("round-trips typed values and nested boolean relationships", () => {
    const source =
      'page.path eq "/pricing" AND (referrer.domain eq "google.com" OR NOT client.deviceType in ["Mobile", "Tablet"])';
    const document = parseFilterPanelExpression(
      source,
      analyticsFilterRegistry,
    );
    const formatted = formatFilterPanelExpression(document);

    expect(document.root).toBeTruthy();
    expect(
      parseFilterPanelExpression(formatted, analyticsFilterRegistry),
    ).toEqual(document);
  });

  it("preserves null, numeric ranges, and valueless operators", () => {
    const source =
      'geo.region isNull OR (page.path exists AND event.payload("/score") between [120, 130])';
    const document = parseFilterPanelExpression(
      source,
      analyticsFilterRegistry,
    );

    expect(
      parseFilterPanelExpression(
        formatFilterPanelExpression(document),
        analyticsFilterRegistry,
      ),
    ).toEqual(document);
  });

  it("supports event payload targets without conflating their JSON path", () => {
    const source = 'event.payload("/metadata/score") gte 7';
    const document = parseFilterPanelExpression(
      source,
      analyticsFilterRegistry,
    );

    expect(formatFilterPanelExpression(document)).toBe(source);
  });

  it("keeps pasted condition order for the visual editor while validating it", () => {
    const source =
      'referrer.domain eq "google.com" AND page.path eq "/pricing" AND referrer.domain eq "google.com"';
    const document = parseFilterPanelExpression(
      source,
      analyticsFilterRegistry,
    );

    expect(formatFilterPanelExpression(document)).toBe(source);
  });

  it("retains explicit nested groups and JSON string-list values", () => {
    const source =
      'page.path eq "/pricing" AND (referrer.domain in ["news,example.com", ""] AND geo.region notNull)';
    const document = parseFilterPanelExpression(
      source,
      analyticsFilterRegistry,
    );

    expect(formatFilterPanelExpression(document)).toBe(
      'page.path eq "/pricing" AND (referrer.domain in ["news,example.com",""] AND geo.region notNull)',
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
    const document = parseFilterPanelExpression(
      source,
      analyticsFilterRegistry,
    );

    expect(formatFilterPanelExpression(document)).toBe(source);
  });

  it("rejects incomplete syntax", () => {
    expect(() =>
      parseFilterPanelExpression("page.path eq", analyticsFilterRegistry),
    ).toThrow("expected_value");
    expect(() =>
      parseFilterPanelExpression(
        'page.path eq "/" AND (client.browser eq "Chrome"',
        analyticsFilterRegistry,
      ),
    ).toThrow("missing_closing_parenthesis");
  });

  it("parses empty documents and escaped strings", () => {
    expect(
      parseFilterPanelExpression("   ", analyticsFilterRegistry),
    ).toMatchObject({ root: null });

    const document = parseFilterPanelExpression(
      'page.path eq "escaped \\"quote\\""',
      analyticsFilterRegistry,
    );

    expect(formatFilterPanelExpression(document)).toBe(
      'page.path eq "escaped \\"quote\\""',
    );
    expect(() =>
      parseFilterPanelExpression("geo.region eq null", analyticsFilterRegistry),
    ).toThrow("Use isNull or notNull instead of comparing to null");
  });

  it("validates parsed boolean values and empty value collections", () => {
    expect(() =>
      parseFilterPanelExpression("page.path eq false", analyticsFilterRegistry),
    ).toThrow();
    expect(() =>
      parseFilterPanelExpression(
        "client.browser in []",
        analyticsFilterRegistry,
      ),
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
      expect(() =>
        parseFilterPanelExpression(source, analyticsFilterRegistry),
      ).toThrow(message);
    }
  });
});
