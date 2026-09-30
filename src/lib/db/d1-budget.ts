import type { DatabaseStatement } from "./types";

export const D1_MAX_SQL_UTF8_BYTES = 100_000;
export const D1_MAX_BOUND_PARAMETERS = 100;

export type D1StatementBudgetItem = "sql_bytes" | "bindings";

/** A stable, value-free error for statements that cannot be sent to D1. */
export class D1StatementBudgetError extends Error {
  readonly code = "d1_statement_budget_exceeded";

  constructor(
    readonly item: D1StatementBudgetItem,
    readonly actual: number,
    readonly limit: number,
    readonly tag?: string,
  ) {
    super(
      item === "sql_bytes"
        ? `D1 SQL statement is ${actual} UTF-8 bytes; the limit is ${limit}.`
        : `D1 statement has ${actual} bound parameters; the limit is ${limit}.`,
    );
    this.name = "D1StatementBudgetError";
  }
}

/** Validate one prepared D1 statement without inspecting SQL or binding values. */
export function assertD1StatementBudget(statement: DatabaseStatement): void {
  const sqlBytes = new TextEncoder().encode(statement.sql).byteLength;
  if (sqlBytes > D1_MAX_SQL_UTF8_BYTES)
    throw new D1StatementBudgetError(
      "sql_bytes",
      sqlBytes,
      D1_MAX_SQL_UTF8_BYTES,
      statement.tag,
    );

  const bindingCount = statement.bindings?.length ?? 0;
  if (bindingCount > D1_MAX_BOUND_PARAMETERS)
    throw new D1StatementBudgetError(
      "bindings",
      bindingCount,
      D1_MAX_BOUND_PARAMETERS,
      statement.tag,
    );
}
