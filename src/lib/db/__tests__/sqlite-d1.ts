import type { DatabaseSync, SQLInputValue } from "node:sqlite";

export interface SqliteD1Trace {
  readonly preparedSql: string[];
  readonly bindings: SQLInputValue[][];
  readonly batchStatements?: string[][];
}

export function createSqliteD1Database(
  database: DatabaseSync,
  trace?: SqliteD1Trace,
): D1Database {
  const statementSql = new WeakMap<object, string>();
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
      statementSql.set(prepared, sql);
      return prepared as unknown as D1PreparedStatement;
    },
    async batch(statements: D1PreparedStatement[]) {
      trace?.batchStatements?.push(
        statements.map((prepared) => statementSql.get(prepared) ?? ""),
      );
      database.exec("BEGIN");
      try {
        const results: D1Result[] = [];
        for (const prepared of statements) {
          results.push(await prepared.run());
        }
        database.exec("COMMIT");
        return results;
      } catch (error) {
        database.exec("ROLLBACK");
        throw error;
      }
    },
  } as D1Database;
}
