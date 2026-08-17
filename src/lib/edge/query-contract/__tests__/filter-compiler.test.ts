import { describe, expect, it } from "vitest";

import {
  analyticsFilterRegistry,
  compileFilterDocument,
  normalizeFilterDocument,
} from "@/lib/edge/query-contract";

function document(root: unknown) {
  return normalizeFilterDocument({ version: 1, root }, analyticsFilterRegistry);
}

describe("filter SQL compiler", () => {
  it("compiles nested visit predicates with bound values and escaped LIKE", () => {
    const result = compileFilterDocument(
      document({
        kind: "and",
        children: [
          {
            kind: "condition",
            target: { kind: "field", field: "geo.country" },
            operator: "eq",
            value: "US",
          },
          {
            kind: "not",
            child: {
              kind: "condition",
              target: { kind: "field", field: "page.title" },
              operator: "contains",
              value: "100%_ready\\go",
            },
          },
        ],
      }),
      { alias: "vs" },
    );

    expect(result.clause).toContain("WHERE (");
    expect(result.clause).toContain(
      "LOWER(TRIM(COALESCE(vs.country, ''))) = ?",
    );
    expect(result.clause).toContain("LIKE ? ESCAPE '\\'");
    expect(result.clause).toContain("NOT (");
    expect(result.bindings).toEqual(["%100\\%\\_ready\\\\go%", "us"]);
  });

  it("compresses large sets into one json_each binding", () => {
    const values = Array.from({ length: 8 }, (_, index) => `/path-${index}`);
    const result = compileFilterDocument(
      document({
        kind: "condition",
        target: { kind: "field", field: "page.path" },
        operator: "in",
        value: values,
      }),
      { alias: "vs" },
    );

    expect(result.clause).toContain(
      "TRIM(COALESCE(vs.pathname, '')) IN (SELECT value FROM json_each(?))",
    );
    expect(result.clause).not.toContain("pathname IN (?,");
    expect(result.bindings).toEqual([JSON.stringify(values)]);
  });

  it("keeps payload set type checks while compressing string sets", () => {
    const values = Array.from({ length: 8 }, (_, index) => `value-${index}`);
    const result = compileFilterDocument(
      document({
        kind: "condition",
        target: { kind: "event-payload", path: "/plan" },
        operator: "in",
        value: values,
      }),
      { alias: "es", eventAlias: "es" },
    );

    expect(result.clause).toContain("json_each(?)");
    expect(result.bindings).toEqual(["/plan", JSON.stringify(values), 1]);
  });

  it("keeps payload missing, JSON null, empty, false, and zero distinct", () => {
    const result = compileFilterDocument(
      document({
        kind: "and",
        children: [
          {
            kind: "condition",
            target: { kind: "event-payload", path: "/missing" },
            operator: "notExists",
          },
          {
            kind: "condition",
            target: { kind: "event-payload", path: "/null" },
            operator: "isNull",
          },
          {
            kind: "condition",
            target: { kind: "event-payload", path: "/empty" },
            operator: "isEmpty",
          },
          {
            kind: "condition",
            target: { kind: "event-payload", path: "/paid" },
            operator: "eq",
            value: false,
          },
          {
            kind: "condition",
            target: { kind: "event-payload", path: "/score" },
            operator: "eq",
            value: 0,
          },
        ],
      }),
      { alias: "es", eventAlias: "es" },
    );

    expect(result.clause).toContain("NOT EXISTS");
    expect(result.clause).toContain("value_type = 0");
    expect(result.clause).toContain("string_value = ''");
    expect(result.clause).toContain("boolean_value = ?");
    expect(result.clause).toContain("number_value = ?");
    expect(result.bindings).toEqual([
      "/empty",
      "/missing",
      "/null",
      "/paid",
      3,
      0,
      "/score",
      2,
      0,
    ]);
  });

  it("uses the stable session-boundary strategy and rejects dynamic aliases", () => {
    const entry = compileFilterDocument(
      document({
        kind: "condition",
        target: { kind: "field", field: "session.entryPath" },
        operator: "eq",
        value: "/pricing",
      }),
      { alias: "visit_source" },
    );
    expect(entry.clause).toContain("ROW_NUMBER() OVER");
    expect(entry.clause).toContain(
      "ORDER BY edge.started_at ASC, edge.visit_id ASC",
    );
    expect(entry.bindings).toEqual(["/pricing"]);
    expect(() =>
      compileFilterDocument(
        document({
          kind: "condition",
          target: { kind: "field", field: "page.path" },
          operator: "eq",
          value: "/",
        }),
        {
          alias: "vs; drop table visits",
        },
      ),
    ).toThrow(/internal SQL identifier/);
  });

  it("compiles the direct referrer sentinel as an empty stored referrer", () => {
    const result = compileFilterDocument(
      document({
        kind: "condition",
        target: { kind: "field", field: "referrer.domain" },
        operator: "eq",
        value: "__direct__",
      }),
      { alias: "vs" },
    );
    expect(result.clause).toContain(
      "LOWER(TRIM(COALESCE(vs.referrer_host, ''))) = ''",
    );
    expect(result.bindings).toEqual([]);
  });
});
