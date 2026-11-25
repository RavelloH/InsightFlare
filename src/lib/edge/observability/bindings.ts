import type { SafeFilterShape } from "@/lib/edge/analytics-engine/filter-shape";
import { currentHotspotCollector } from "@/lib/edge/analytics-engine/hotspot-collector";
import {
  currentQueryFilterShape,
  currentQueryIdentity,
  type TrustedQueryIdentity,
} from "@/lib/edge/analytics-engine/query-registry";
import type { Env } from "@/lib/edge/types";

import type {
  InvocationD1RowsCoverage,
  InvocationLogData,
  InvocationLogger,
} from "./logger";
import { errorLogData } from "./logger";
const INSTRUMENTED_ENV = Symbol("insightflare.instrumented-env");
const INVOCATION_LOGGER = Symbol("insightflare.invocation-logger");
const RAW_D1_STATEMENT = new WeakMap<object, D1PreparedStatement>();
const D1_STATEMENT_IDENTITY = new WeakMap<object, TrustedQueryIdentity>();
const D1_STATEMENT_FILTER = new WeakMap<object, SafeFilterShape>();
const D1_META_STATE = new WeakMap<InvocationLogger, D1MetaState>();
type D1MetaLike = {
  /** Business mutation count; it is not a resource write-row metric. */
  changes?: unknown;
  rows_read?: unknown;
  rows_written?: unknown;
  timings?: { sql_duration_ms?: unknown };
  total_attempts?: unknown;
};
type D1MetaState = {
  /** Statements whose wrapper promise has settled, including missing batch slots. */
  accounted: number;
  /** Statement results actually returned by D1 (not inferred from batch length). */
  observedResults: number;
  rowsReadAvailable: number;
  rowsWrittenAvailable: number;
  sqlDurationAvailable: number;
  sqlDurationTotalMs: number;
  attemptsAvailable: number;
};

function newD1MetaState(): D1MetaState {
  return {
    accounted: 0,
    observedResults: 0,
    rowsReadAvailable: 0,
    rowsWrittenAvailable: 0,
    sqlDurationAvailable: 0,
    sqlDurationTotalMs: 0,
    attemptsAvailable: 0,
  };
}

function asNonNegativeInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : undefined;
}

function asNonNegativeDuration(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : undefined;
}

function statementKind(sql: string): string {
  const keyword = sql
    .trimStart()
    .match(/^([a-z]+)/i)?.[1]
    ?.toLowerCase();
  return keyword || "other";
}

function rowsCoverage(
  available: number,
  accounted: number,
): InvocationD1RowsCoverage {
  if (available === 0) return "unavailable";
  return available === accounted ? "complete" : "partial";
}

function publishD1State(logger: InvocationLogger, state: D1MetaState): void {
  D1_META_STATE.set(logger, state);
  logger.setPerformance({
    // A settled D1 Promise is not proof that each individual batch statement
    // returned. Never turn missing results or a rejected batch into successes.
    d1FinishedStatements: state.observedResults,
    d1UnobservedStatements: state.accounted - state.observedResults,
    d1SqlDurationCoverage: rowsCoverage(
      state.sqlDurationAvailable,
      state.accounted,
    ),
    d1AttemptsCoverage: rowsCoverage(state.attemptsAvailable, state.accounted),
    d1RowsReadAvailable: state.rowsReadAvailable > 0,
    d1RowsReadCoverage: rowsCoverage(state.rowsReadAvailable, state.accounted),
    d1RowsWrittenCoverage: rowsCoverage(
      state.rowsWrittenAvailable,
      state.accounted,
    ),
    ...(state.sqlDurationAvailable > 0
      ? { d1SqlDurationMs: state.sqlDurationTotalMs }
      : {}),
  });
}

function recordD1Result(logger: InvocationLogger, result: unknown): void {
  const meta = (result as { meta?: D1MetaLike } | null)?.meta;
  const state = D1_META_STATE.get(logger) ?? newD1MetaState();
  state.accounted += 1;
  state.observedResults += 1;

  const sqlDuration = asNonNegativeDuration(meta?.timings?.sql_duration_ms);
  if (sqlDuration !== undefined) {
    const nextTotal = state.sqlDurationTotalMs + sqlDuration;
    // Never expose an overflowing total as a valid measurement.
    if (Number.isFinite(nextTotal)) {
      state.sqlDurationAvailable += 1;
      state.sqlDurationTotalMs = nextTotal;
    }
  }

  const attempts = asNonNegativeInteger(meta?.total_attempts);
  if (attempts !== undefined) {
    state.attemptsAvailable += 1;
    logger.increment("d1TotalAttempts", attempts);
    if (attempts > 1) logger.increment("d1Retries", attempts - 1);
  }

  const rowsRead = asNonNegativeInteger(meta?.rows_read);
  if (rowsRead !== undefined) {
    state.rowsReadAvailable += 1;
    logger.increment("d1RowsRead", rowsRead);
  }

  const rowsWritten = asNonNegativeInteger(meta?.rows_written);
  if (rowsWritten !== undefined) {
    state.rowsWrittenAvailable += 1;
    logger.increment("d1RowsWritten", rowsWritten);
  }

  publishD1State(logger, state);
}

/**
 * Missing slots, malformed batch responses and rejected calls are counted in
 * the metric coverage denominator, but NEVER in observed/finished results.
 */
function markUnobservedD1Results(
  logger: InvocationLogger,
  unobserved: number,
): void {
  if (unobserved <= 0) return;
  const state = D1_META_STATE.get(logger) ?? newD1MetaState();
  state.accounted += unobserved;
  publishD1State(logger, state);
}

async function measureD1<T>(
  logger: InvocationLogger,
  operation: string,
  data: InvocationLogData,
  statementCount: number,
  action: () => Promise<T>,
  resultIsBatch = false,
  batchIdentities: readonly TrustedQueryIdentity[] = [],
  identityOverride?: TrustedQueryIdentity,
  filterOverride?: SafeFilterShape,
  batchFilters: readonly (SafeFilterShape | undefined)[] = [],
): Promise<T> {
  const collector = currentHotspotCollector(logger);
  const started = globalThis.performance?.now() ?? Date.now();
  const identity = identityOverride ?? currentQueryIdentity();
  const filter = filterOverride ?? currentQueryFilterShape();
  const span = logger.startSpan(operation, data);
  logger.increment("d1Statements", statementCount);
  try {
    const result = await action();
    if (resultIsBatch) {
      collector?.recordBatchApiWall(
        (globalThis.performance?.now() ?? Date.now()) - started,
      );
      if (Array.isArray(result)) {
        const slots = Math.min(statementCount, result.length);
        let observed = 0;
        for (let index = 0; index < slots; index += 1) {
          if (!(index in result) || result[index] == null) continue;
          recordD1Result(logger, result[index]);
          const meta = (result[index] as { meta?: D1MetaLike } | null)?.meta;
          collector?.record({
            identity: batchIdentities[index] ?? identity,
            batchSharedWall: true,
            ...(asNonNegativeInteger(meta?.rows_read) !== undefined
              ? { rowsRead: meta!.rows_read as number }
              : {}),
            ...(asNonNegativeInteger(meta?.rows_written) !== undefined
              ? { rowsWritten: meta!.rows_written as number }
              : {}),
            ...(asNonNegativeDuration(meta?.timings?.sql_duration_ms) !==
            undefined
              ? { sqlEngineMs: meta!.timings!.sql_duration_ms as number }
              : {}),
            ...(asNonNegativeInteger(meta?.total_attempts) !== undefined
              ? { attempts: meta!.total_attempts as number }
              : {}),
            ...((batchFilters[index] ?? filter)
              ? { filter: batchFilters[index] ?? filter }
              : {}),
          });
          observed += 1;
        }
        for (let index = 0; index < statementCount; index++) {
          if (index < slots && index in result && result[index] != null)
            continue;
          collector?.record({
            identity: batchIdentities[index] ?? identity,
            batchSharedWall: true,
            ...((batchFilters[index] ?? filter)
              ? { filter: batchFilters[index] ?? filter }
              : {}),
          });
        }
        markUnobservedD1Results(logger, statementCount - observed);
      } else {
        for (let i = 0; i < statementCount; i++)
          collector?.record({
            identity: batchIdentities[i] ?? identity,
            batchSharedWall: true,
            ...((batchFilters[i] ?? filter)
              ? { filter: batchFilters[i] ?? filter }
              : {}),
          });
        markUnobservedD1Results(logger, statementCount);
      }
    } else if (result != null) {
      recordD1Result(logger, result);
      const meta = (result as { meta?: D1MetaLike } | null)?.meta;
      collector?.record({
        identity,
        apiWallMs: (globalThis.performance?.now() ?? Date.now()) - started,
        ...(asNonNegativeInteger(meta?.rows_read) !== undefined
          ? { rowsRead: meta!.rows_read as number }
          : {}),
        ...(asNonNegativeInteger(meta?.rows_written) !== undefined
          ? { rowsWritten: meta!.rows_written as number }
          : {}),
        ...(asNonNegativeDuration(meta?.timings?.sql_duration_ms) !== undefined
          ? { sqlEngineMs: meta!.timings!.sql_duration_ms as number }
          : {}),
        ...(asNonNegativeInteger(meta?.total_attempts) !== undefined
          ? { attempts: meta!.total_attempts as number }
          : {}),
        ...(filter ? { filter } : {}),
      });
    } else {
      collector?.record({
        identity,
        apiWallMs: (globalThis.performance?.now() ?? Date.now()) - started,
        ...(filter ? { filter } : {}),
      });
      markUnobservedD1Results(logger, statementCount);
    }
    // One D1 API call settled; this is not the count of executed statements.
    logger.increment("d1SettledOperations");
    span.end({ statementCount });
    return result;
  } catch (error) {
    if (resultIsBatch) {
      collector?.recordBatchApiWall(
        (globalThis.performance?.now() ?? Date.now()) - started,
      );
      for (let i = 0; i < statementCount; i++)
        collector?.record({
          identity: batchIdentities[i] ?? identity,
          failed: true,
          batchSharedWall: true,
          ...((batchFilters[i] ?? filter)
            ? { filter: batchFilters[i] ?? filter }
            : {}),
        });
    } else {
      collector?.record({
        identity,
        failed: true,
        apiWallMs: (globalThis.performance?.now() ?? Date.now()) - started,
        ...(filter ? { filter } : {}),
      });
    }
    markUnobservedD1Results(logger, statementCount);
    logger.increment("d1SettledOperations");
    logger.increment("failedStatements", statementCount);
    span.fail({
      statementCount,
      // A rejected batch does not identify which statement failed.
      ...(!resultIsBatch
        ? { queryId: identity.id, variant: identity.variant }
        : {}),
      ...errorLogData(error),
    });
    throw error;
  }
}
function wrapD1Statement(
  statement: D1PreparedStatement,
  logger: InvocationLogger,
  kind: string,
  bindingCount = 0,
  trustedIdentity: TrustedQueryIdentity = currentQueryIdentity(),
  trustedFilter: SafeFilterShape | undefined = currentQueryFilterShape(),
): D1PreparedStatement {
  const proxy = new Proxy(statement, {
    get(target, property, receiver) {
      if (property === "bind") {
        return (...values: unknown[]) =>
          wrapD1Statement(
            target.bind(...values),
            logger,
            kind,
            values.length,
            trustedIdentity,
            trustedFilter,
          );
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
            false,
            [],
            trustedIdentity,
            trustedFilter,
          );
      }
      const value = Reflect.get(target, property, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  RAW_D1_STATEMENT.set(proxy, statement);
  D1_STATEMENT_IDENTITY.set(proxy, trustedIdentity);
  if (trustedFilter) D1_STATEMENT_FILTER.set(proxy, trustedFilter);
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
            true,
            statements.map(
              (item) =>
                D1_STATEMENT_IDENTITY.get(item) ?? currentQueryIdentity(),
            ),
            undefined,
            undefined,
            statements.map((item) => D1_STATEMENT_FILTER.get(item)),
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
              try {
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
              } catch (error) {
                // A synchronous fetch failure must also close the measured span.
                span.fail(errorLogData(error));
                throw error;
              }
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
  // Preserve binding identity inside this invocation without sharing wrappers
  // between loggers or reusing a wrapper after the underlying binding changes.
  let rawDb: D1Database | undefined;
  let observedDb: D1Database | undefined;
  return new Proxy(env, {
    get(target, property, receiver) {
      if (property === INSTRUMENTED_ENV) return true;
      if (property === INVOCATION_LOGGER) return logger;
      if (property === "DB") {
        const database = target.DB;
        if (!observedDb || rawDb !== database) {
          observedDb = wrapD1Database(database, logger);
          rawDb = database;
        }
        return observedDb;
      }
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
