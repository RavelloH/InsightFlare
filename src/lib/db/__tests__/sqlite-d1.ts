import type { DatabaseSync, SQLInputValue } from "node:sqlite";

export function createSqliteD1Database(database: DatabaseSync): D1Database {
  return {
    prepare(sql: string) {
      const statement = database.prepare(sql);
      let bindings: SQLInputValue[] = [];
      const prepared = {
        bind(...values: SQLInputValue[]) {
          bindings = values;
          return prepared;
        },
        async first<Row>() {
          return (statement.get(...bindings) as Row | undefined) ?? null;
        },
        async all<Row>() {
          return {
            success: true,
            results: statement.all(...bindings) as Row[],
          } as D1Result<Row>;
        },
        async run() {
          const result = statement.run(...bindings);
          return {
            success: true,
            meta: { changes: Number(result.changes) },
          } as D1Result;
        },
      };
      return prepared as unknown as D1PreparedStatement;
    },
  } as D1Database;
}
