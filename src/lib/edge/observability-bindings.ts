import type {
  InvocationLogData,
  InvocationLogger,
} from "./observability-logger";
import { errorLogData } from "./observability-logger";
import type { Env } from "./types";

const INSTRUMENTED_ENV = Symbol("insightflare.instrumented-env");
const INVOCATION_LOGGER = Symbol("insightflare.invocation-logger");
const RAW_D1_STATEMENT = new WeakMap<object, D1PreparedStatement>();
const D1_ROWS_READ_STATE = new WeakMap<InvocationLogger, boolean>();

type D1MetaLike = {
  changes?: unknown;
  rows_read?: unknown;
  timings?: { sql_duration_ms?: unknown };
  total_attempts?: unknown;
};

function asNonNegativeInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.trunc(value)
    : undefined;
}

function statementKind(sql: string): string {
  const keyword = sql
    .trimStart()
    .match(/^([a-z]+)/i)?.[1]
    ?.toLowerCase();
  return keyword || "other";
}

function recordD1Result(logger: InvocationLogger, result: unknown): void {
  const meta = (result as { meta?: D1MetaLike } | null)?.meta;
  if (!meta) {
    if (!D1_ROWS_READ_STATE.get(logger)) {
      logger.setPerformance({ d1RowsReadAvailable: false });
    }
    return;
  }
  const rowsRead = asNonNegativeInteger(meta.rows_read);
  if (rowsRead === undefined) {
    if (!D1_ROWS_READ_STATE.get(logger)) {
      logger.setPerformance({ d1RowsReadAvailable: false });
    }
  } else {
    D1_ROWS_READ_STATE.set(logger, true);
    logger.setPerformance({ d1RowsReadAvailable: true });
    logger.increment("d1RowsRead", rowsRead);
  }
  const rowsWritten = asNonNegativeInteger(meta.changes);
  if (rowsWritten !== undefined) logger.increment("d1RowsWritten", rowsWritten);
  const sqlDuration = asNonNegativeInteger(meta.timings?.sql_duration_ms);
  if (sqlDuration !== undefined)
    logger.increment("d1SqlDurationMs", sqlDuration);
  const attempts = asNonNegativeInteger(meta.total_attempts);
  if (attempts !== undefined) {
    logger.increment("d1TotalAttempts", attempts);
    if (attempts > 1) logger.increment("d1Retries", attempts - 1);
  }
}

async function measureD1<T>(
  logger: InvocationLogger,
  operation: string,
  data: InvocationLogData,
  statementCount: number,
  action: () => Promise<T>,
): Promise<T> {
  const span = logger.startSpan(operation, data);
  logger.increment("d1Statements", statementCount);
  try {
    const result = await action();
    if (Array.isArray(result)) {
      for (const item of result) recordD1Result(logger, item);
    } else {
      recordD1Result(logger, result);
    }
    span.end({ statementCount });
    return result;
  } catch (error) {
    logger.increment("failedStatements", statementCount);
    span.fail({ statementCount, ...errorLogData(error) });
    throw error;
  }
}

function wrapD1Statement(
  statement: D1PreparedStatement,
  logger: InvocationLogger,
  kind: string,
  bindingCount = 0,
): D1PreparedStatement {
  const proxy = new Proxy(statement, {
    get(target, property, receiver) {
      if (property === "bind") {
        return (...values: unknown[]) =>
          wrapD1Statement(target.bind(...values), logger, kind, values.length);
      }
      if (
        property === "all" ||
        property === "run" ||
        property === "first" ||
        property === "raw"
      ) {
        return (...args: unknown[]) =>
          measureD1(
            logger,
            `d1.${String(property)}`,
            { statementKind: kind, bindingCount },
            1,
            () =>
              (target[property] as (...values: unknown[]) => Promise<unknown>)(
                ...args,
              ),
          );
      }
      const value = Reflect.get(target, property, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  RAW_D1_STATEMENT.set(proxy, statement);
  return proxy;
}

function unwrapD1Statement(
  statement: D1PreparedStatement,
): D1PreparedStatement {
  return RAW_D1_STATEMENT.get(statement) ?? statement;
}

function wrapD1Database(
  database: D1Database,
  logger: InvocationLogger,
): D1Database {
  return new Proxy(database, {
    get(target, property, receiver) {
      if (property === "prepare") {
        return (sql: string) =>
          wrapD1Statement(target.prepare(sql), logger, statementKind(sql));
      }
      if (property === "batch") {
        return <T>(statements: D1PreparedStatement[]) =>
          measureD1(
            logger,
            "d1.batch",
            { statementCount: statements.length },
            statements.length,
            () => target.batch<T>(statements.map(unwrapD1Statement)),
          );
      }
      if (property === "exec") {
        return (sql: string) =>
          measureD1(
            logger,
            "d1.exec",
            { statementKind: statementKind(sql) },
            1,
            () => target.exec(sql),
          );
      }
      const value = Reflect.get(target, property, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  }) as D1Database;
}

function wrapAsyncBinding<T extends object>(
  binding: T,
  logger: InvocationLogger,
  resource: "kv" | "r2",
): T {
  return new Proxy(binding, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver);
      if (typeof value !== "function") return value;
      return (...args: unknown[]) => {
        const operation = `${resource}.${String(property)}`;
        const span = logger.startSpan(operation);
        logger.increment(resource === "kv" ? "kvOperations" : "r2Operations");
        try {
          const result = value.apply(target, args);
          if (!(result instanceof Promise)) {
            span.end();
            return result;
          }
          return result.then(
            (resolved) => {
              span.end();
              return resolved;
            },
            (error) => {
              span.fail(errorLogData(error));
              throw error;
            },
          );
        } catch (error) {
          span.fail(errorLogData(error));
          throw error;
        }
      };
    },
  });
}

function wrapDurableObjectNamespace(
  namespace: DurableObjectNamespace,
  logger: InvocationLogger,
): DurableObjectNamespace {
  return new Proxy(namespace, {
    get(target, property, receiver) {
      if (property !== "get") {
        const value = Reflect.get(target, property, receiver);
        return typeof value === "function" ? value.bind(target) : value;
      }
      return (...args: Parameters<DurableObjectNamespace["get"]>) => {
        const stub = target.get(...args);
        return new Proxy(stub, {
          get(stubTarget, stubProperty, stubReceiver) {
            const value = Reflect.get(stubTarget, stubProperty, stubReceiver);
            if (stubProperty !== "fetch" || typeof value !== "function") {
              return typeof value === "function"
                ? value.bind(stubTarget)
                : value;
            }
            return (...fetchArgs: Parameters<DurableObjectStub["fetch"]>) => {
              const span = logger.startSpan("do.fetch");
              logger.increment("doCalls");
              return value.apply(stubTarget, fetchArgs).then(
                (response: Response) => {
                  span.end({ status: response.status });
                  return response;
                },
                (error: unknown) => {
                  span.fail(errorLogData(error));
                  throw error;
                },
              );
            };
          },
        });
      };
    },
  }) as DurableObjectNamespace;
}

/**
 * Binds request-scoped instrumentation without mutating Cloudflare bindings.
 * The proxy is installed only on the Hono context or server request context.
 */
export function instrumentEnv(env: Env, logger: InvocationLogger): Env {
  if ((env as Env & { [INSTRUMENTED_ENV]?: boolean })[INSTRUMENTED_ENV]) {
    return env;
  }
  return new Proxy(env, {
    get(target, property, receiver) {
      if (property === INSTRUMENTED_ENV) return true;
      if (property === INVOCATION_LOGGER) return logger;
      if (property === "DB") return wrapD1Database(target.DB, logger);
      if (property === "INGEST_DO") {
        return wrapDurableObjectNamespace(target.INGEST_DO, logger);
      }
      if (property === "SITE_SETTINGS_KV" && target.SITE_SETTINGS_KV) {
        return wrapAsyncBinding(target.SITE_SETTINGS_KV, logger, "kv");
      }
      if (property === "ARCHIVE_BUCKET" && target.ARCHIVE_BUCKET) {
        return wrapAsyncBinding(target.ARCHIVE_BUCKET, logger, "r2");
      }
      return Reflect.get(target, property, receiver);
    },
  }) as Env;
}

export function getInvocationLogger(env: Env): InvocationLogger | undefined {
  return (env as Env & { [INVOCATION_LOGGER]?: InvocationLogger })[
    INVOCATION_LOGGER
  ];
}

export async function measureExternalFetch(
  logger: InvocationLogger | undefined,
  operation: string,
  action: () => Promise<Response>,
): Promise<Response> {
  if (!logger) return action();
  const span = logger.startSpan(operation);
  logger.increment("externalFetches");
  try {
    const response = await action();
    if (response.status >= 500) logger.increment("failedExternalFetches");
    span.end({ status: response.status });
    return response;
  } catch (error) {
    logger.increment("failedExternalFetches");
    span.fail(errorLogData(error));
    throw error;
  }
}
