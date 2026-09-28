import type { DatabaseSync, SQLInputValue } from "node:sqlite";

export interface SqliteD1Trace {
  readonly preparedSql: string[];
  readonly bindings: SQLInputValue[][];
}

export function createSqliteD1Database(
  database: DatabaseSync,
  trace?: SqliteD1Trace,
): D1Database {
  return {
    prepare(sql: string) {
      trace?.preparedSql.push(sql);
      const statement = database.prepare(sql);
      let bindings: SQLInputValue[] = [];
      const prepared = {
        bind(...values: SQLInputValue[]) {
          bindings = values;
          trace?.bindings.push(values);
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
