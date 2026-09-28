import type { DatabaseSync, SQLInputValue } from "node:sqlite";

import type { DatabaseStatement } from "@/lib/db/types";

export function explainQueryPlan(
  database: DatabaseSync,
  statement: Pick<DatabaseStatement, "sql" | "bindings">,
): string[] {
  const bindings = Array.from(statement.bindings ?? [], (value) =>
    value instanceof ArrayBuffer ? new Uint8Array(value) : value,
  ) as SQLInputValue[];
  const rows = database
    .prepare(`EXPLAIN QUERY PLAN ${statement.sql}`)
    .all(...bindings) as Array<{ detail?: unknown }>;
  return rows.map((row) => String(row.detail ?? ""));
}
