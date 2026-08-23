import { AsyncLocalStorage } from "node:async_hooks";

export const OBSERVABILITY_LOG_VERSION = 1 as const;
// One record is emitted for each invocation. Keep this comfortably below the
// Workers log-size limit while preserving the start/end pair for real work.
export const MAX_INVOCATION_LOG_EVENTS = 512;
const MAX_LOG_VALUE_LENGTH = 160;
const MAX_ERROR_LOG_VALUE_LENGTH = 4_096;

export type InvocationSource = "worker" | "do";
export type InvocationTrigger = "request" | "alarm";
export type InvocationLogLevel = "info" | "warn" | "error";
export type InvocationOutcome = "ok" | "error" | "canceled";
export type InvocationCacheState = "HIT" | "MISS" | "BYPASS";
export type InvocationDataSource = "raw" | "rollup" | "mixed";

export interface InvocationRequest {
  route: string;
  method: string;
  status: number;
  outcome: InvocationOutcome;
}

export interface InvocationPerformance {
  durationMs: number;
  cache?: InvocationCacheState;
  dataSource?: InvocationDataSource;
  d1RowsRead?: number;
  /** Legacy handler-reported value; compare with binding-level total when present. */
  handlerD1RowsRead?: number;
  d1RowsReadAvailable?: boolean;
  d1Statements?: number;
  d1RowsWritten?: number;
  failedStatements?: number;
  flushedVisits?: number;
  flushedCustomEvents?: number;
  d1SqlDurationMs?: number;
  d1TotalAttempts?: number;
  d1Retries?: number;
  doSqlStatements?: number;
  doSqlRowsRead?: number;
  doSqlRowsWritten?: number;
  kvOperations?: number;
  r2Operations?: number;
  doCalls?: number;
  externalFetches?: number;
  failedExternalFetches?: number;
  webSocketDurationMs?: number;
  operations?: Record<string, InvocationOperationSummary>;
}

export type InvocationPerformancePatch = Omit<
  InvocationPerformance,
  "durationMs"
>;

export type InvocationPerformanceCounter =
  | "d1RowsRead"
  | "d1Statements"
  | "d1RowsWritten"
  | "failedStatements"
  | "flushedVisits"
  | "flushedCustomEvents"
  | "d1SqlDurationMs"
  | "d1TotalAttempts"
  | "d1Retries"
  | "doSqlStatements"
  | "doSqlRowsRead"
  | "doSqlRowsWritten"
  | "kvOperations"
  | "r2Operations"
  | "doCalls"
  | "externalFetches"
  | "failedExternalFetches";

export type InvocationLogValue = string | number | boolean | null;
export type InvocationLogData = Record<string, InvocationLogValue>;

function errorMessage(value: unknown): string {
  if (value instanceof Error) {
    return value.message || value.name || "Error";
  }
  if (typeof value === "string") return value || "Error";
  try {
    return JSON.stringify(value) || String(value);
  } catch {
    return String(value);
  }
}

/**
 * Preserve actionable error details in invocation logs without attaching
 * query text or request payloads at call sites.
 */
export function errorLogData(error: unknown): InvocationLogData {
  if (!(error instanceof Error)) {
    return {
      errorName: "NonError",
      errorMessage: errorMessage(error),
    };
  }

  const data: InvocationLogData = {
    errorName: error.name || "Error",
    errorMessage: errorMessage(error),
  };
  if (error.stack) data.errorStack = error.stack;

  const details = error as Error & { cause?: unknown; code?: unknown };
  if (details.cause !== undefined) {
    data.errorCause = errorMessage(details.cause);
  }
  if (typeof details.code === "string" || typeof details.code === "number") {
    data.errorCode = String(details.code);
  }
  return data;
}

export interface InvocationOperationSummary {
  count: number;
  durationMs: number;
  failed: number;
  d1Statements?: number;
  d1RowsRead?: number;
  d1RowsReadAvailable?: boolean;
  d1DurationMs?: number;
}

export interface InvocationD1OperationMetrics {
  durationMs: number;
  rowsRead?: number;
  rowsReadAvailable: boolean;
}

export interface InvocationLogEvent {
  timeMs: number;
  level: InvocationLogLevel;
  message: string;
  data?: InvocationLogData;
}

export interface InvocationSpan {
  end(data?: InvocationLogData): void;
  fail(data?: InvocationLogData): void;
}

export interface InvocationLogRecord {
  v: typeof OBSERVABILITY_LOG_VERSION;
  source: InvocationSource;
  trigger: InvocationTrigger;
  traceId?: string;
  startedAt: string;
  request?: InvocationRequest;
  performance: InvocationPerformance;
  logs: InvocationLogEvent[];
  logsTruncated?: true;
}

export interface CreateInvocationLoggerOptions {
  source: InvocationSource;
  trigger: InvocationTrigger;
  traceId?: string;
  startedAt?: string;
  now?: () => number;
  maxEvents?: number;
}

function defaultNow(): number {
  return globalThis.performance?.now() ?? Date.now();
}

function toTimeMs(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.round(value));
}

function toCounterValue(value: number): number | null {
  if (!Number.isFinite(value) || value <= 0) return null;
  return Math.trunc(value);
}

function resolveMaxEvents(value: number | undefined): number {
  if (value === undefined) return MAX_INVOCATION_LOG_EVENTS;
  if (!Number.isInteger(value) || value < 1) return MAX_INVOCATION_LOG_EVENTS;
  return Math.min(value, MAX_INVOCATION_LOG_EVENTS);
}

function consoleFor(record: InvocationLogRecord): typeof console.log {
  if (record.request?.status !== undefined && record.request.status >= 500) {
    return console.error;
  }
  if (record.logs.some((event) => event.level === "error")) {
    return console.error;
  }
  if (record.request?.status !== undefined && record.request.status >= 400) {
    return console.warn;
  }
  if (record.logs.some((event) => event.level === "warn")) {
    return console.warn;
  }
  return console.log;
}

export interface InvocationLogger {
  info(message: string, data?: InvocationLogData): void;
  warn(message: string, data?: InvocationLogData): void;
  error(message: string, data?: InvocationLogData): void;
  startSpan(operation: string, data?: InvocationLogData): InvocationSpan;
  measure<T>(
    operation: string,
    action: () => Promise<T>,
    data?: InvocationLogData,
  ): Promise<T>;
  track<T>(promise: Promise<T>): Promise<T>;
  setTraceId(traceId: string | undefined): void;
  setRequest(request: InvocationRequest): void;
  setPerformance(performance: InvocationPerformancePatch): void;
  increment(counter: InvocationPerformanceCounter, amount?: number): void;
  recordD1Operation(
    operation: string,
    metrics: InvocationD1OperationMetrics,
  ): void;
  build(): InvocationLogRecord;
  emit(): InvocationLogRecord;
  emitWhenComplete(): Promise<InvocationLogRecord>;
}

const invocationLoggerContext = new AsyncLocalStorage<InvocationLogger>();
const d1OperationContext = new AsyncLocalStorage<string>();

export function runWithInvocationLogger<T>(
  logger: InvocationLogger,
  action: () => T,
): T {
  return invocationLoggerContext.run(logger, action);
}

export function currentInvocationLogger(): InvocationLogger | undefined {
  return invocationLoggerContext.getStore();
}

export function runWithD1Operation<T>(operation: string, action: () => T): T {
  return d1OperationContext.run(operation, action);
}

export function currentD1Operation(): string | undefined {
  return d1OperationContext.getStore();
}

export async function measureCurrentExternalFetch(
  operation: string,
  action: () => Promise<Response>,
): Promise<Response> {
  const logger = currentInvocationLogger();
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

export function createInvocationLogger(
  options: CreateInvocationLoggerOptions,
): InvocationLogger {
  const now = options.now ?? defaultNow;
  const startedAt = options.startedAt ?? new Date().toISOString();
  const startedAtMs = now();
  const maxEvents = resolveMaxEvents(options.maxEvents);
  const events: InvocationLogEvent[] = [];
  let traceId = options.traceId;
  let request: InvocationRequest | undefined;
  let performance: InvocationPerformancePatch = {};
  let logsTruncated = false;
  let emitted: InvocationLogRecord | undefined;
  const background = new Set<Promise<unknown>>();

  function sanitizeData(
    data: InvocationLogData | undefined,
  ): InvocationLogData | undefined {
    if (!data) return undefined;
    const entries: Array<[string, InvocationLogValue]> = [];
    for (const [key, value] of Object.entries(data)) {
      if (entries.length >= 12) break;
      if (key.length === 0 || key.length > 64) continue;
      if (typeof value === "number" && !Number.isFinite(value)) continue;
      if (typeof value !== "string") {
        entries.push([key, value]);
        continue;
      }
      const maxLength = key.startsWith("error")
        ? MAX_ERROR_LOG_VALUE_LENGTH
        : MAX_LOG_VALUE_LENGTH;
      entries.push([
        key,
        value.length > maxLength
          ? `${value.slice(0, maxLength - 14)}...[truncated]`
          : value,
      ]);
    }
    return entries.length > 0 ? Object.fromEntries(entries) : undefined;
  }

  function record(
    level: InvocationLogLevel,
    message: string,
    data?: InvocationLogData,
  ): void {
    if (events.length >= maxEvents) {
      logsTruncated = true;
      return;
    }
    const safeData = sanitizeData(data);
    events.push({
      timeMs: toTimeMs(now() - startedAtMs),
      level,
      message,
      ...(safeData ? { data: safeData } : {}),
    });
  }

  function addOperation(
    operation: string,
    durationMs: number,
    failed: boolean,
  ): void {
    const prior = performance.operations?.[operation] ?? {
      count: 0,
      durationMs: 0,
      failed: 0,
    };
    performance = {
      ...performance,
      operations: {
        ...performance.operations,
        [operation]: {
          ...prior,
          count: prior.count + 1,
          durationMs: prior.durationMs + durationMs,
          failed: prior.failed + (failed ? 1 : 0),
        },
      },
    };
  }

  function startSpan(
    operation: string,
    data?: InvocationLogData,
  ): InvocationSpan {
    const startedAtSpan = now();
    let completed = false;
    record("info", `${operation}.started`, data);
    const finish = (failed: boolean, result?: InvocationLogData) => {
      if (completed) return;
      completed = true;
      const durationMs = toTimeMs(now() - startedAtSpan);
      addOperation(operation, durationMs, failed);
      record(
        failed ? "error" : "info",
        `${operation}.${failed ? "failed" : "completed"}`,
        {
          ...result,
          durationMs,
        },
      );
    };
    return {
      end: (result) => finish(false, result),
      fail: (result) => finish(true, result),
    };
  }

  function build(): InvocationLogRecord {
    const record: InvocationLogRecord = {
      v: OBSERVABILITY_LOG_VERSION,
      source: options.source,
      trigger: options.trigger,
      ...(traceId ? { traceId } : {}),
      startedAt,
      ...(request ? { request: { ...request } } : {}),
      performance: {
        durationMs: toTimeMs(now() - startedAtMs),
        ...performance,
      },
      logs: events.map((event) => ({ ...event })),
      ...(logsTruncated ? { logsTruncated: true as const } : {}),
    };
    return record;
  }

  return {
    info(message, data) {
      record("info", message, data);
    },
    warn(message, data) {
      record("warn", message, data);
    },
    error(message, data) {
      record("error", message, data);
    },
    startSpan,
    async measure(operation, action, data) {
      const span = startSpan(operation, data);
      try {
        const result = await action();
        span.end();
        return result;
      } catch (error) {
        span.fail(errorLogData(error));
        throw error;
      }
    },
    track(promise) {
      background.add(promise);
      void promise.then(
        () => background.delete(promise),
        () => background.delete(promise),
      );
      return promise;
    },
    setTraceId(nextTraceId) {
      traceId = nextTraceId;
    },
    setRequest(nextRequest) {
      request = { ...nextRequest };
    },
    setPerformance(nextPerformance) {
      performance = { ...performance, ...nextPerformance };
    },
    increment(counter, amount = 1) {
      const incrementBy = toCounterValue(amount);
      if (incrementBy === null) return;
      performance = {
        ...performance,
        [counter]: (performance[counter] ?? 0) + incrementBy,
      };
    },
    recordD1Operation(operation, metrics) {
      const prior = performance.operations?.[operation] ?? {
        count: 0,
        durationMs: 0,
        failed: 0,
      };
      const durationMs = toTimeMs(metrics.durationMs);
      const rowsRead = toCounterValue(metrics.rowsRead ?? 0);
      const rowsReadAvailable =
        prior.d1RowsReadAvailable !== false && metrics.rowsReadAvailable;
      performance = {
        ...performance,
        operations: {
          ...performance.operations,
          [operation]: {
            ...prior,
            d1Statements: (prior.d1Statements ?? 0) + 1,
            d1DurationMs: (prior.d1DurationMs ?? 0) + durationMs,
            ...(rowsRead !== null
              ? { d1RowsRead: (prior.d1RowsRead ?? 0) + rowsRead }
              : {}),
            d1RowsReadAvailable: rowsReadAvailable,
          },
        },
      };
    },
    build,
    emit() {
      if (emitted) return emitted;
      emitted = build();
      consoleFor(emitted)(emitted);
      return emitted;
    },
    async emitWhenComplete() {
      // Background tasks are registered by the request handler before its
      // middleware unwinds. Capture all of them in this invocation record.
      while (background.size > 0) {
        await Promise.allSettled([...background]);
      }
      return this.emit();
    },
  };
}
