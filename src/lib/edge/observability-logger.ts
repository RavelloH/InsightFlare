export const OBSERVABILITY_LOG_VERSION = 1 as const;
export const MAX_INVOCATION_LOG_EVENTS = 32;

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
  d1RowsReadAvailable?: boolean;
  d1Statements?: number;
  d1RowsWritten?: number;
  failedStatements?: number;
  flushedVisits?: number;
  flushedCustomEvents?: number;
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
  | "flushedCustomEvents";

export interface InvocationLogEvent {
  timeMs: number;
  level: InvocationLogLevel;
  message: string;
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
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
  setRequest(request: InvocationRequest): void;
  setPerformance(performance: InvocationPerformancePatch): void;
  increment(counter: InvocationPerformanceCounter, amount?: number): void;
  build(): InvocationLogRecord;
  emit(): InvocationLogRecord;
}

export function createInvocationLogger(
  options: CreateInvocationLoggerOptions,
): InvocationLogger {
  const now = options.now ?? defaultNow;
  const startedAt = options.startedAt ?? new Date().toISOString();
  const startedAtMs = now();
  const maxEvents = resolveMaxEvents(options.maxEvents);
  const events: InvocationLogEvent[] = [];
  let request: InvocationRequest | undefined;
  let performance: InvocationPerformancePatch = {};
  let logsTruncated = false;
  let emitted: InvocationLogRecord | undefined;

  function record(level: InvocationLogLevel, message: string): void {
    if (events.length >= maxEvents) {
      logsTruncated = true;
      return;
    }
    events.push({
      timeMs: toTimeMs(now() - startedAtMs),
      level,
      message,
    });
  }

  function build(): InvocationLogRecord {
    const record: InvocationLogRecord = {
      v: OBSERVABILITY_LOG_VERSION,
      source: options.source,
      trigger: options.trigger,
      ...(options.traceId ? { traceId: options.traceId } : {}),
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
    info(message) {
      record("info", message);
    },
    warn(message) {
      record("warn", message);
    },
    error(message) {
      record("error", message);
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
    build,
    emit() {
      if (emitted) return emitted;
      emitted = build();
      consoleFor(emitted)(emitted);
      return emitted;
    },
  };
}
