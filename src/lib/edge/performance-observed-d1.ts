import {
  type PerformanceQueryObserver,
  recordD1All,
  recordD1Batch,
  recordD1FirstOrRun,
} from "./performance-query-observer";

export interface ObservedD1Statement {
  all<T = Record<string, unknown>>(): Promise<D1Result<T>>;
  bind(...values: unknown[]): ObservedD1Statement;
  first<T = Record<string, unknown>>(colName?: string): Promise<T | null>;
  raw<T = unknown[]>(options: {
    columnNames: true;
  }): Promise<[string[], ...T[]]>;
  raw<T = unknown[]>(options?: { columnNames?: false }): Promise<T[]>;
  run<T = Record<string, unknown>>(): Promise<D1Result<T>>;
  unwrap(): D1PreparedStatement;
}

export interface ObservedD1Database {
  batch<T = unknown>(statements: ObservedD1Statement[]): Promise<D1Result<T>[]>;
  exec(query: string): Promise<D1ExecResult>;
  prepare(query: string): ObservedD1Statement;
  probe<T>(operation: () => Promise<D1Result<T>>): Promise<D1Result<T>>;
}

class StatementObserver implements ObservedD1Statement {
  constructor(
    private readonly statement: D1PreparedStatement,
    private readonly observer: PerformanceQueryObserver,
  ) {}

  bind(...values: unknown[]): ObservedD1Statement {
    return new StatementObserver(this.statement.bind(...values), this.observer);
  }

  async all<T = Record<string, unknown>>(): Promise<D1Result<T>> {
    const result = await this.statement.all<T>();
    recordD1All(this.observer, result);
    return result;
  }

  async first<T = unknown>(colName?: string): Promise<T | null> {
    recordD1FirstOrRun(this.observer);
    if (colName === undefined) return this.statement.first<T>();
    return this.statement.first<T>(colName);
  }

  async run<T = Record<string, unknown>>(): Promise<D1Result<T>> {
    recordD1FirstOrRun(this.observer);
    return this.statement.run<T>();
  }

  raw<T = unknown[]>(options: {
    columnNames: true;
  }): Promise<[string[], ...T[]]>;
  raw<T = unknown[]>(options?: { columnNames?: false }): Promise<T[]>;
  async raw<T = unknown[]>(options?: {
    columnNames?: boolean;
  }): Promise<T[] | [string[], ...T[]]> {
    recordD1FirstOrRun(this.observer);
    if (options?.columnNames) {
      return this.statement.raw<T>({ columnNames: true });
    }
    return this.statement.raw<T>();
  }

  unwrap(): D1PreparedStatement {
    return this.statement;
  }
}

/**
 * Wraps future v2 D1 calls in request-scoped accounting. It deliberately
 * treats every operation without `D1Result.meta.rows_read` as unavailable;
 * rollout gates therefore cannot pass on a partial total.
 */
export function observeD1(
  database: D1Database,
  observer: PerformanceQueryObserver,
): ObservedD1Database {
  return {
    prepare(query) {
      return new StatementObserver(database.prepare(query), observer);
    },
    async batch<T>(statements: ObservedD1Statement[]): Promise<D1Result<T>[]> {
      recordD1Batch(observer, statements.length);
      return database.batch<T>(
        statements.map((statement) => statement.unwrap()),
      );
    },
    async exec(query: string): Promise<D1ExecResult> {
      recordD1FirstOrRun(observer);
      return database.exec(query);
    },
    async probe<T>(
      operation: () => Promise<D1Result<T>>,
    ): Promise<D1Result<T>> {
      const result = await operation();
      recordD1All(observer, result);
      return result;
    },
  };
}
