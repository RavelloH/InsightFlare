import {
  currentInvocationLogger,
  errorLogData,
  type InvocationLogger,
} from "@/lib/edge/observability/logger";

import { initializeIngestSqlSchema } from "./schema";
import type { SqlBinding } from "./sql";
interface SqlCursorLike {
  toArray(): unknown[];
  readonly rowsRead?: unknown;
  readonly rowsWritten?: unknown;
}
interface SqlExecutionResult<T> {
  readonly rows: T[];
  readonly rowsRead?: number;
  readonly rowsWritten?: number;
}
function sqlMetric(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.trunc(value)
    : undefined;
}
export class IngestSqlAccess {
  constructor(private readonly doState: DurableObjectState) {}

  initializeSchema(): void {
    const storage = this.doState.storage;
    initializeIngestSqlSchema(
      storage.sql,
      typeof storage.transactionSync === "function"
        ? {
            transactionSync: (closure) => storage.transactionSync(closure),
          }
        : undefined,
    );
  }

  sqlAll<T>(query: string, ...bindings: SqlBinding[]): T[] {
    const logger = currentInvocationLogger();
    if (logger) return this.measuredSqlAll<T>(logger, query, ...bindings);
    return this.rawSqlAll<T>(query, ...bindings);
  }

  rawSqlAll<T>(query: string, ...bindings: SqlBinding[]): T[] {
    return this.rawSqlAllWithMetrics<T>(query, ...bindings).rows;
  }

  rawSqlAllWithMetrics<T>(
    query: string,
    ...bindings: SqlBinding[]
  ): SqlExecutionResult<T> {
    const cursor = this.doState.storage.sql.exec(
      query,
      ...bindings,
    ) as unknown as SqlCursorLike;
    // A DO cursor's resource counters are only final after its result has
    // been fully consumed. Keep this as the single execution boundary so a
    // metrics read can never issue a second SQL statement.
    const rows = cursor.toArray() as T[];
    return {
      rows,
      ...(sqlMetric(cursor.rowsRead) !== undefined
        ? { rowsRead: sqlMetric(cursor.rowsRead) }
        : {}),
      ...(sqlMetric(cursor.rowsWritten) !== undefined
        ? { rowsWritten: sqlMetric(cursor.rowsWritten) }
        : {}),
    };
  }

  sqlOne<T>(query: string, ...bindings: SqlBinding[]): T | null {
    const rows = this.sqlAll<T>(query, ...bindings);
    return rows[0] ?? null;
  }

  sqlRun(query: string, ...bindings: SqlBinding[]): number {
    const logger = currentInvocationLogger();
    if (logger) return this.measuredSqlRun(logger, query, ...bindings);
    return this.rawSqlRun(query, ...bindings);
  }

  rawSqlRun(query: string, ...bindings: SqlBinding[]): number {
    return this.rawSqlRunWithMetrics(query, ...bindings).rowsWritten ?? 0;
  }

  rawSqlRunWithMetrics(
    query: string,
    ...bindings: SqlBinding[]
  ): SqlExecutionResult<never> {
    const cursor = this.doState.storage.sql.exec(
      query,
      ...bindings,
    ) as unknown as SqlCursorLike;
    // Consume write cursors as well: UPDATE/DELETE may scan rows even when
    // their mutation count is zero, and rowsRead is finalized on consumption.
    cursor.toArray();
    return {
      rows: [],
      ...(sqlMetric(cursor.rowsRead) !== undefined
        ? { rowsRead: sqlMetric(cursor.rowsRead) }
        : {}),
      ...(sqlMetric(cursor.rowsWritten) !== undefined
        ? { rowsWritten: sqlMetric(cursor.rowsWritten) }
        : {}),
    };
  }

  measuredSqlAll<T>(
    logger: InvocationLogger,
    query: string,
    ...bindings: SqlBinding[]
  ): T[] {
    const span = logger.startSpan("do_sql.all", {
      statementKind:
        query
          .trimStart()
          .match(/^([a-z]+)/i)?.[1]
          ?.toLowerCase() || "other",
      bindingCount: bindings.length,
    });
    logger.increment("doSqlStatements");
    try {
      const result = this.rawSqlAllWithMetrics<T>(query, ...bindings);
      logger.recordDoSqlOperation(result);
      span.end({
        rowCount: result.rows.length,
        ...(result.rowsRead !== undefined ? { rowsRead: result.rowsRead } : {}),
        ...(result.rowsWritten !== undefined
          ? { rowsWritten: result.rowsWritten }
          : {}),
      });
      return result.rows;
    } catch (error) {
      span.fail(errorLogData(error));
      throw error;
    }
  }

  measuredSqlOne<T>(
    logger: InvocationLogger,
    query: string,
    ...bindings: SqlBinding[]
  ): T | null {
    return this.measuredSqlAll<T>(logger, query, ...bindings)[0] ?? null;
  }

  measuredSqlRun(
    logger: InvocationLogger,
    query: string,
    ...bindings: SqlBinding[]
  ): number {
    const span = logger.startSpan("do_sql.run", {
      statementKind:
        query
          .trimStart()
          .match(/^([a-z]+)/i)?.[1]
          ?.toLowerCase() || "other",
      bindingCount: bindings.length,
    });
    logger.increment("doSqlStatements");
    try {
      const result = this.rawSqlRunWithMetrics(query, ...bindings);
      logger.recordDoSqlOperation(result);
      const rowsWritten = result.rowsWritten ?? 0;
      span.end({
        rowsWritten,
        ...(result.rowsRead !== undefined ? { rowsRead: result.rowsRead } : {}),
      });
      return rowsWritten;
    } catch (error) {
      span.fail(errorLogData(error));
      throw error;
    }
  }
}
