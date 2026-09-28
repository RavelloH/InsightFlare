import type { DatabaseRuntime, DatabaseStatement } from "./types";

function prepare(database: D1Database, statement: DatabaseStatement) {
  const prepared = database.prepare(statement.sql);
  return statement.bindings === undefined
    ? prepared
    : prepared.bind(...statement.bindings);
}

export function createDatabaseRuntime(database: D1Database): DatabaseRuntime {
  return {
    all<T extends object>(statement: DatabaseStatement): Promise<D1Result<T>> {
      return prepare(database, statement).all<T>();
    },
    first<T>(
      statement: DatabaseStatement,
      columnName?: string,
    ): Promise<T | null> {
      const prepared = prepare(database, statement);
      return columnName === undefined
        ? prepared.first<T>()
        : prepared.first<T>(columnName);
    },
    run(statement: DatabaseStatement): Promise<D1Result> {
      return prepare(database, statement).run();
    },
    batch(
      statements: readonly DatabaseStatement[],
    ): Promise<readonly D1Result[]> {
      return database.batch(
        statements.map((statement) => prepare(database, statement)),
      );
    },
  };
}
