export type DatabaseBinding = Parameters<D1PreparedStatement["bind"]>[number];

export interface DatabaseStatement {
  readonly sql: string;
  readonly bindings?: readonly DatabaseBinding[];
  readonly tag?: string;
}

export interface DatabaseRuntime {
  all<T extends object = Record<string, unknown>>(
    statement: DatabaseStatement,
  ): Promise<D1Result<T>>;
  first<T = Record<string, unknown>>(
    statement: DatabaseStatement,
    columnName?: string,
  ): Promise<T | null>;
  run(statement: DatabaseStatement): Promise<D1Result>;
  batch(statements: readonly DatabaseStatement[]): Promise<readonly D1Result[]>;
}
