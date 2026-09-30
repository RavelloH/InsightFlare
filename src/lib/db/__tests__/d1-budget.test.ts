import { describe, expect, it } from "vitest";

import {
  assertD1StatementBudget,
  D1_MAX_BOUND_PARAMETERS,
  D1_MAX_SQL_UTF8_BYTES,
  D1StatementBudgetError,
} from "@/lib/db/d1-budget";

describe("D1 statement budget", () => {
  it("accepts the exact SQL byte and bound-parameter limits", () => {
    expect(() =>
      assertD1StatementBudget({
        sql: "x".repeat(D1_MAX_SQL_UTF8_BYTES),
        bindings: Array.from({ length: D1_MAX_BOUND_PARAMETERS }, () => null),
      }),
    ).not.toThrow();
  });

  it("counts SQL as UTF-8 bytes and rejects the first byte above the limit", () => {
    expect(() =>
      assertD1StatementBudget({
        sql: "x".repeat(D1_MAX_SQL_UTF8_BYTES + 1),
      }),
    ).toThrowError(
      expect.objectContaining({
        item: "sql_bytes",
        actual: D1_MAX_SQL_UTF8_BYTES + 1,
        limit: D1_MAX_SQL_UTF8_BYTES,
      }),
    );

    const exactMultibyteSql = "é".repeat(D1_MAX_SQL_UTF8_BYTES / 2);
    expect(new TextEncoder().encode(exactMultibyteSql).byteLength).toBe(
      D1_MAX_SQL_UTF8_BYTES,
    );
    expect(() =>
      assertD1StatementBudget({ sql: exactMultibyteSql }),
    ).not.toThrow();

    const tooLongSql = `${exactMultibyteSql}é`;
    try {
      assertD1StatementBudget({ sql: tooLongSql, tag: "safe.tag" });
      throw new Error("expected SQL byte budget error");
    } catch (error) {
      expect(error).toBeInstanceOf(D1StatementBudgetError);
      expect(error).toMatchObject({
        code: "d1_statement_budget_exceeded",
        item: "sql_bytes",
        actual: D1_MAX_SQL_UTF8_BYTES + 2,
        limit: D1_MAX_SQL_UTF8_BYTES,
        tag: "safe.tag",
      });
    }
  });

  it("rejects the 101st binding without exposing values", () => {
    const secret = "binding-value-must-not-appear";
    try {
      assertD1StatementBudget({
        sql: "SELECT ?",
        bindings: Array.from(
          { length: D1_MAX_BOUND_PARAMETERS + 1 },
          () => secret,
        ),
      });
      throw new Error("expected binding budget error");
    } catch (error) {
      expect(error).toBeInstanceOf(D1StatementBudgetError);
      expect(error).toMatchObject({
        code: "d1_statement_budget_exceeded",
        item: "bindings",
        actual: D1_MAX_BOUND_PARAMETERS + 1,
        limit: D1_MAX_BOUND_PARAMETERS,
      });
      expect((error as Error).message).not.toContain(secret);
    }
  });
});
