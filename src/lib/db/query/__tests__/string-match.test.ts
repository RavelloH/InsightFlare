import { type SQLInputValue } from "node:sqlite";

import { describe, expect, it } from "vitest";

import { createMigratedDatabase } from "@/../scripts/schema/database";
import {
  caseWhen,
  compileD1Query,
  eq,
  param,
  project,
  scan,
  textContains,
  textEndsWith,
  textStartsWith,
} from "@/lib/db";
import { schema } from "@/lib/db/schema";

type MatchOperation = "contains" | "starts-with" | "ends-with";

function evaluate(
  db: ReturnType<typeof createMigratedDatabase>,
  relation: ReturnType<typeof scan<typeof schema.site_identities>>,
  operation: MatchOperation,
  input: string,
  pattern: string,
): {
  readonly value: number | null;
  readonly sql: string;
  readonly bindings: readonly unknown[];
} {
  const inputExpression = param(input);
  const expression =
    operation === "contains"
      ? textContains(inputExpression, pattern)
      : operation === "starts-with"
        ? textStartsWith(inputExpression, pattern)
        : textEndsWith(inputExpression, pattern);
  const query = compileD1Query(project(relation, { matched: expression }));
  const row = db
    .prepare(query.sql)
    .get(...((query.bindings ?? []) as SQLInputValue[])) as
    { matched: number | null } | undefined;
  if (!row) throw new Error("string match fixture query returned no rows");
  return { value: row.matched, sql: query.sql, bindings: query.bindings ?? [] };
}

describe("typed literal string matching", () => {
  it("matches exact UTF-8 bytes, including empty strings and embedded NULs", () => {
    const db = createMigratedDatabase();
    try {
      db.prepare("INSERT INTO site_identities (site_id) VALUES (?)").run(
        "string-match-test",
      );
      const identities = scan(schema.site_identities);
      const cases: readonly {
        readonly operation: MatchOperation;
        readonly input: string;
        readonly pattern: string;
        readonly expected: boolean;
      }[] = [
        { operation: "contains", input: "abc", pattern: "b", expected: true },
        { operation: "contains", input: "abc", pattern: "B", expected: false },
        {
          operation: "contains",
          input: "value %_\\' OR 1=1 -- end",
          pattern: "%_\\' OR 1=1 --",
          expected: true,
        },
        { operation: "contains", input: "😀雪", pattern: "雪", expected: true },
        {
          operation: "contains",
          input: "a\0b\0c",
          pattern: "\0b",
          expected: true,
        },
        {
          operation: "starts-with",
          input: "\0head-tail",
          pattern: "\0head",
          expected: true,
        },
        { operation: "starts-with", input: "", pattern: "x", expected: false },
        {
          operation: "ends-with",
          input: "prefix\0tail",
          pattern: "tail",
          expected: true,
        },
        {
          operation: "ends-with",
          input: "prefix\0",
          pattern: "\0",
          expected: true,
        },
        { operation: "ends-with", input: "abc", pattern: "B", expected: false },
        { operation: "contains", input: "", pattern: "", expected: true },
        { operation: "starts-with", input: "abc", pattern: "", expected: true },
        { operation: "ends-with", input: "abc", pattern: "", expected: true },
      ];
      for (const item of cases) {
        const result = evaluate(
          db,
          identities,
          item.operation,
          item.input,
          item.pattern,
        );
        const javaScriptExpected =
          item.operation === "contains"
            ? item.input.includes(item.pattern)
            : item.operation === "starts-with"
              ? item.input.startsWith(item.pattern)
              : item.input.endsWith(item.pattern);
        expect(
          result.value,
          `JavaScript differential: ${JSON.stringify(item)}`,
        ).toBe(javaScriptExpected ? 1 : 0);
        expect(result.value, JSON.stringify(item)).toBe(item.expected ? 1 : 0);
        expect(result.sql).not.toMatch(/\bLIKE\b|\bGLOB\b|COLLATE\s+NOCASE/i);
      }

      const ecmaWhitespace = [
        "\u0009",
        "\u000a",
        "\u000b",
        "\u000c",
        "\u000d",
        "\u0020",
        "\u00a0",
        "\u1680",
        "\u2000",
        "\u2001",
        "\u2002",
        "\u2003",
        "\u2004",
        "\u2005",
        "\u2006",
        "\u2007",
        "\u2008",
        "\u2009",
        "\u200a",
        "\u2028",
        "\u2029",
        "\u202f",
        "\u205f",
        "\u3000",
        "\ufeff",
      ];
      for (const character of ecmaWhitespace) {
        const result = evaluate(
          db,
          identities,
          "contains",
          `left${character}right`,
          character,
        );
        expect(result.value, `U+${character.charCodeAt(0).toString(16)}`).toBe(
          1,
        );
      }
    } finally {
      db.close();
    }
  });

  it("uses only necessary bindings and preserves NULL through empty patterns", () => {
    const db = createMigratedDatabase();
    try {
      db.prepare("INSERT INTO site_identities (site_id) VALUES (?)").run(
        "string-match-empty-test",
      );
      const identities = scan(schema.site_identities);
      expect(evaluate(db, identities, "contains", "abc", "").bindings).toEqual([
        "abc",
      ]);
      expect(
        evaluate(db, identities, "starts-with", "abc", "").bindings,
      ).toEqual(["abc"]);
      expect(evaluate(db, identities, "ends-with", "abc", "").bindings).toEqual(
        ["abc"],
      );
      expect(evaluate(db, identities, "contains", "abc", "b").bindings).toEqual(
        ["abc", "b"],
      );
      expect(
        evaluate(db, identities, "starts-with", "abc", "a").bindings,
      ).toEqual(["abc", "a"]);
      expect(
        evaluate(db, identities, "ends-with", "abc", "c").bindings,
      ).toEqual(["abc", "c", "c"]);

      const identitiesWithNullableText = scan(schema.site_identities);
      const nullableInput = caseWhen(
        [{ when: eq(param(1), param(2)), then: param("unreachable") }],
        param(null),
      );
      const query = compileD1Query(
        project(identitiesWithNullableText, {
          nonempty: textContains(nullableInput, "x"),
          empty: textEndsWith(nullableInput, ""),
        }),
      );
      const row = db
        .prepare(query.sql)
        .get(...((query.bindings ?? []) as SQLInputValue[])) as
        { nonempty: number | null; empty: number | null } | undefined;
      expect(row).toEqual({ nonempty: null, empty: null });
    } finally {
      db.close();
    }
  });

  it("rejects unpaired UTF-16 surrogates with their pattern index", () => {
    expect(() => textContains(param("input"), "prefix\ud800tail")).toThrow(
      /textContains\(\).*unpaired UTF-16 surrogate at index 6/,
    );
    expect(() => textStartsWith(param("input"), "\udc00")).toThrow(
      /textStartsWith\(\).*unpaired UTF-16 surrogate at index 0/,
    );
    expect(() => textEndsWith(param("input"), "😀")).not.toThrow();
  });
});
