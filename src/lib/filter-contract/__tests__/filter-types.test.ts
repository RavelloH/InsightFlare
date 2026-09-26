import { describe, expect, it } from "vitest";

import {
  analyticsFilterRegistry,
  normalizeFilterDocument,
  parseFilterDsl,
  validateFilterExpressionTypes,
} from "@/lib/filter-contract";

function validate(source: string): void {
  validateFilterExpressionTypes(
    parseFilterDsl(source, analyticsFilterRegistry),
    analyticsFilterRegistry,
  );
}

describe("Filter v1 expression types", () => {
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

  it("requires Relation inside a session or visitor selector", () => {
    const source =
      'session { sequence([event { event.name eq "signup" }, event { event.name eq "purchase" }]) { sequence.span lte 7d } exists } exists';
    expect(() => validate(source)).not.toThrow();
    expect(() =>
      validate(
        'sequence([event { event.name eq "signup" }, event { event.name eq "purchase" }]) exists',
      ),
    ).toThrow(
      expect.objectContaining({
        code: "relation_requires_session_or_visitor_selector",
      }),
    );
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
});
