import type {
  InvocationCacheState,
  InvocationD1RowsCoverage,
  InvocationLogRecord,
  InvocationOperationSummary,
  InvocationOutcome,
  InvocationSafeErrorSignal,
  InvocationSource,
  InvocationTrigger,
} from "./logger";
import type { SqlSemanticObservation } from "./semantic";

/**
 * A deliberately smaller, allowlisted projection of InvocationLogRecord.
 * Never pass raw records (especially logs, trace IDs, routes or SQL data)
 * to completion consumers.
 */
export interface ObservedMetric {
  readonly coverage: InvocationD1RowsCoverage;
  /** Known accumulated value. Absent when no trustworthy D1 meta exists. */
  readonly value?: number;
}

export interface InvocationSqlCost {
  readonly statements: number;
  /** Per-statement D1 result objects actually observed; not inferred from a settled batch. */
  readonly finishedStatements: number;
  /** Attempted statements without a returned D1 result (outcome unconfirmed). */
  readonly unobservedStatements: number;
  /** Resolved or rejected D1 API calls; one batch is one operation. */
  readonly settledOperations: number;
  readonly failedStatements: number;
  readonly rowsRead: ObservedMetric;
  readonly rowsWritten: ObservedMetric;
  /** Sum of D1 engine durations, NOT user-visible/wall-clock latency. */
  readonly cumulativeSqlDurationMs: ObservedMetric;
  readonly totalAttempts: ObservedMetric;
  readonly retries: ObservedMetric;
}

export interface InvocationSafeOperation {
  readonly name: string;
  readonly count: number;
  readonly failed: number;
  /** Sum across operations; overlapping spans must not be interpreted as latency. */
  readonly cumulativeDurationMs: number;
}

export interface InvocationResourceSummary {
  readonly doCalls: number;
  readonly externalFetches: number;
  readonly failedExternalFetches: number;
  readonly kvOperations: number;
  readonly r2Operations: number;
  readonly doAlarmOperations: number;
  readonly doSqlStatements: number;
  readonly doSqlRowsRead: ObservedMetric;
  readonly doSqlRowsWritten: ObservedMetric;
}

export interface InvocationSnapshot {
  readonly version: 1;
  readonly source: InvocationSource;
  readonly trigger: InvocationTrigger;
  readonly outcome: InvocationOutcome;
  /** One of the fixed, coarse route groups; never the raw request path. */
  readonly routeGroup: "api" | "page" | "do" | "websocket" | "scheduled";
  /** Trusted router template/fixed lifecycle key; never derived from request URL. */
  readonly routeKey?: string;
  readonly method?:
    | "GET"
    | "POST"
    | "PUT"
    | "PATCH"
    | "DELETE"
    | "HEAD"
    | "OPTIONS"
    | "WEBSOCKET";
  readonly status?: number;
  readonly invocationDurationMs: number;
  /** An explicitly completed, single handler span, if observed. */
  readonly handlerDurationMs?: number;
  /** Only present for a WS close/error callback. Not request latency. */
  readonly webSocketConnectionDurationMs?: number;
  readonly cache?: InvocationCacheState;
  readonly dataSource?: "raw" | "rollup" | "mixed";
  readonly errorEvents: number;
  readonly logsTruncated: boolean;
  readonly sql: InvocationSqlCost;
  /** Sum of D1 operation wall times, not end-to-end latency. */
  readonly d1OperationCumulativeDurationMs: number;
  readonly resources: InvocationResourceSummary;
  /** Only fixed, typed event classifications (no message, stack, user payload). */
  readonly safeErrors: readonly InvocationSafeErrorSignal[];
  readonly operations: readonly InvocationSafeOperation[];
  /** Privileged opt-in only; never part of the default safe snapshot. */
  readonly sqlObservations?: readonly SqlSemanticObservation[];
}

const SAFE_METHODS = new Set([
  "GET",
  "POST",
  "PUT",
  "PATCH",
  "DELETE",
  "HEAD",
  "OPTIONS",
  "WEBSOCKET",
] as const);

const SAFE_OPERATIONS = new Set([
  "route.handler",
  "page.handler",
  "page.middleware",
  "server_function.handler",
  "do.fetch.handler",
  "do.schema_ready",
  "do.maintenance",
  "do.alarm.reconcile",
  "do.websocket.initial_snapshot",
  "d1.all",
  "d1.first",
  "d1.run",
  "d1.raw",
  "d1.exec",
  "d1.batch",
]);

function valueOrAbsent(
  coverage: InvocationD1RowsCoverage | undefined,
  value: number | undefined,
): ObservedMetric {
  const status = coverage ?? "unavailable";
  const metric =
    status === "unavailable"
      ? { coverage: status }
      : {
          coverage: status,
          value: Number.isFinite(value) && (value ?? 0) >= 0 ? value! : 0,
        };
  return Object.freeze(metric);
}

function safeOperation(
  name: string,
  summary: InvocationOperationSummary,
): InvocationSafeOperation {
  return Object.freeze({
    name,
    count: summary.count,
    failed: summary.failed,
    cumulativeDurationMs: summary.durationMs,
  });
}

function safeRouteGroup(
  record: InvocationLogRecord,
): InvocationSnapshot["routeGroup"] {
  if (record.trigger === "scheduled") return "scheduled";
  if (record.trigger === "websocket" || record.request?.method === "WEBSOCKET")
    return "websocket";
  if (record.source === "do") return "do";
  const route = record.request?.route ?? "";
  return route.startsWith("/api/") || route.startsWith("api.") ? "api" : "page";
}

function observedHandlerMs(record: InvocationLogRecord): number | undefined {
  // A handler span is an actual waited path. Cumulative parallel SQL is not.
  for (const name of [
    "route.handler",
    "server_function.handler",
    "page.handler",
    "do.fetch.handler",
  ]) {
    const span = record.performance.operations?.[name];
    if (span?.count === 1 && Number.isFinite(span.durationMs)) {
      return span.durationMs;
    }
  }
  return undefined;
}

export function withSqlSemanticObservations(
  snapshot: InvocationSnapshot,
  observations: readonly SqlSemanticObservation[],
): InvocationSnapshot {
  return Object.freeze({
    ...snapshot,
    sqlObservations: Object.freeze([...observations]),
  });
}

export function toInvocationSnapshot(
  record: InvocationLogRecord,
  trusted: {
    routeKey?: string;
    safeErrors?: readonly InvocationSafeErrorSignal[];
  } = {},
): InvocationSnapshot {
  const perf = record.performance;
  const statements = perf.d1Statements ?? 0;
  const failed = perf.failedStatements ?? 0;
  const method = record.request?.method;
  const safeMethod =
    method && SAFE_METHODS.has(method as never)
      ? (method as InvocationSnapshot["method"])
      : undefined;
  const operations = Object.entries(perf.operations ?? {})
    .filter(([name]) => SAFE_OPERATIONS.has(name))
    .map(([name, summary]) => safeOperation(name, summary));
  const sql = Object.freeze({
    statements,
    finishedStatements: perf.d1FinishedStatements ?? 0,
    unobservedStatements: perf.d1UnobservedStatements ?? 0,
    settledOperations: perf.d1SettledOperations ?? 0,
    failedStatements: failed,
    rowsRead: valueOrAbsent(perf.d1RowsReadCoverage, perf.d1RowsRead),
    rowsWritten: valueOrAbsent(perf.d1RowsWrittenCoverage, perf.d1RowsWritten),
    cumulativeSqlDurationMs: valueOrAbsent(
      perf.d1SqlDurationCoverage,
      perf.d1SqlDurationMs,
    ),
    totalAttempts: valueOrAbsent(perf.d1AttemptsCoverage, perf.d1TotalAttempts),
    retries: valueOrAbsent(perf.d1AttemptsCoverage, perf.d1Retries),
  });
  const safeCount = (value: number | undefined): number =>
    typeof value === "number" && Number.isFinite(value) && value >= 0
      ? value
      : 0;
  const doSqlCoverage = (coverage: InvocationD1RowsCoverage | undefined) =>
    coverage ?? "unavailable";
  const resources: InvocationResourceSummary = Object.freeze({
    doCalls: safeCount(perf.doCalls),
    externalFetches: safeCount(perf.externalFetches),
    failedExternalFetches: safeCount(perf.failedExternalFetches),
    kvOperations: safeCount(perf.kvOperations),
    r2Operations: safeCount(perf.r2Operations),
    doAlarmOperations: safeCount(perf.doAlarmOperations),
    doSqlStatements: safeCount(perf.doSqlStatements),
    doSqlRowsRead: valueOrAbsent(
      doSqlCoverage(perf.doSqlRowsReadCoverage),
      perf.doSqlRowsRead,
    ),
    doSqlRowsWritten: valueOrAbsent(
      doSqlCoverage(perf.doSqlRowsWrittenCoverage),
      perf.doSqlRowsWritten,
    ),
  });
  const d1OperationCumulativeDurationMs = operations
    .filter((operation) => operation.name.startsWith("d1."))
    .reduce(
      (total, operation) => total + safeCount(operation.cumulativeDurationMs),
      0,
    );
  const handlerDurationMs = observedHandlerMs(record);
  const webSocketConnectionDurationMs =
    record.request?.method === "WEBSOCKET" &&
    Number.isFinite(perf.webSocketDurationMs)
      ? perf.webSocketDurationMs
      : undefined;
  return Object.freeze({
    version: 1 as const,
    source: record.source,
    trigger: record.trigger,
    outcome:
      record.request?.outcome ??
      (record.logs.some((log) => log.level === "error") ? "error" : "ok"),
    routeGroup: safeRouteGroup(record),
    ...(trusted.routeKey ? { routeKey: trusted.routeKey } : {}),
    ...(safeMethod ? { method: safeMethod } : {}),
    ...(record.request?.status !== undefined
      ? { status: record.request.status }
      : {}),
    invocationDurationMs: perf.durationMs,
    ...(handlerDurationMs !== undefined ? { handlerDurationMs } : {}),
    ...(webSocketConnectionDurationMs !== undefined
      ? { webSocketConnectionDurationMs }
      : {}),
    ...(perf.cache ? { cache: perf.cache } : {}),
    ...(perf.dataSource ? { dataSource: perf.dataSource } : {}),
    errorEvents: record.logs.filter((log) => log.level === "error").length,
    logsTruncated: Boolean(record.logsTruncated),
    sql,
    d1OperationCumulativeDurationMs,
    resources,
    safeErrors: Object.freeze([...(trusted.safeErrors ?? [])]),
    operations: Object.freeze(operations),
  });
}
