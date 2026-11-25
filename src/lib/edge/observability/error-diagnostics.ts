import {
  QUERY_REGISTRY,
  QUERY_VARIANTS,
  type QueryVariant,
} from "@/lib/edge/analytics-engine/query-registry";

/**
 * AE diagnostics are a closed vocabulary, never a copy of raw exception text.
 * Both writer and reader enforce the same safe projection.
 */
export const NORMAL_DETAILS_BYTES = 4096;
export const ERROR_DETAILS_BYTES = 8192;
const MAX_ERRORS = 3;
const MAX_FRAMES = 8;
const MAX_CAUSES = 3;

const NAMES = [
  "Error",
  "TypeError",
  "RangeError",
  "SyntaxError",
  "ReferenceError",
  "AbortError",
  "TimeoutError",
  "AggregateError",
  "NonError",
  "Unknown",
] as const;
const CODES = [
  "d1_operation_failed",
  "unhandled_request",
  "do_alarm_failed",
  "scheduled_failed",
  "websocket_failed",
  "websocket_snapshot_failed",
  "do_flush_visit_batch_failed",
  "do_flush_visit_failed",
  "do_flush_custom_event_failed",
  "query_application_failed",
  "ae_reader_invalid_query",
  "ae_reader_auth_failed",
  "ae_reader_rate_limited",
  "ae_reader_timeout",
  "ae_reader_upstream_failed",
  "ae_reader_invalid_response",
  "ae_reader_config_failed",
  "unclassified_logged_error",
] as const;
const OPERATIONS = [
  "d1.all",
  "d1.first",
  "d1.run",
  "d1.raw",
  "d1.exec",
  "d1.batch",
  "request",
  "do.alarm",
  "scheduled.tasks",
  "do.websocket",
  "do.websocket.initial_snapshot",
  "do.flush.visit_batch",
  "do.flush.visit",
  "do.flush.custom_event",
  "query.application",
  "ae.reader.sql",
] as const;
const CATEGORIES = [
  "database",
  "application",
  "infrastructure",
  "unknown",
] as const;

// Never retain matched substrings, even quoted SQL identifiers.
const MESSAGE_RULES = [
  ["Missing database column", /no such column|unknown column/i],
  ["Missing database table", /no such table|unknown table/i],
  [
    "Database constraint violation",
    /constraint failed|unique constraint|not null constraint/i,
  ],
  ["Operation timed out", /timed?\s*out|timeout|deadline exceeded/i],
  [
    "Resource limit exceeded",
    /resource limit|too many sql variables|too many terms in compound select|too many requests|quota exceeded|database is full/i,
  ],
  [
    "Database busy or locked",
    /database is (?:busy|locked)|sqlite_busy|sqlite_locked/i,
  ],
  [
    "Connection or network failure",
    /network error|fetch failed|connection (?:reset|refused)|socket disconnected/i,
  ],
  [
    "Invalid property access",
    /cannot read properties of|cannot set properties of/i,
  ],
  ["Operation aborted", /abort(?:ed|error)/i],
  ["SQL syntax error", /sql syntax|syntax error|parse error/i],
] as const;
const MESSAGES = MESSAGE_RULES.map(([message]) => message);

// Fixed code-owned paths. No arbitrary function name, URL or path prefix.
const FILES = [
  "index.js",
  "index.mjs",
  "worker.js",
  "worker.mjs",
  "server.js",
  "server.mjs",
  "src/lib/edge/observability/logger.ts",
  "src/lib/edge/observability/bindings.ts",
  "src/lib/edge/analytics/composition/query-application-service.ts",
  "src/lib/edge/analytics-engine/invocation-writer.ts",
  "src/lib/edge/admin/observability/invocation-metrics.ts",
  "src/lib/edge/admin/observability/invocation-metrics-sql.ts",
  "src/lib/edge/admin/observability/invocation-metrics-transport.ts",
  "src/lib/edge/ingest/durable-object.ts",
  "src/lib/edge/ingest/sql-access.ts",
  "src/lib/edge/ingest/alarm-sweep.ts",
  "src/lib/hono/middleware/error-boundary.ts",
  "src/lib/hono/middleware/observability.ts",
  "src/lib/hono/routes/public/widgets.ts",
] as const;
const VIEWS = ["overview", "routes", "hotspots", "errors", "samples"] as const;
const STATEMENTS = [
  "summary",
  "trend",
  "legacy",
  "routes",
  "api-hot",
  "sql-engine-fallback",
  "scan",
  "errors",
  "samples",
] as const;
const REASONS = [
  "invalid_count_arguments",
  "invalid_column",
  "type_mismatch",
  "sql_parse_error",
  "invalid_query",
] as const;
const READER_CODES = [
  "invalid_request",
  "invalid_query",
  "concurrency_limited",
  "rate_limited",
  "unauthorized",
  "forbidden",
  "service_unavailable",
  "insufficient_storage",
  "timeout",
  "aborted",
  "malformed_response",
  "response_too_large",
  "too_many_rows",
  "redirect_rejected",
  "upstream_error",
  "network_error",
  "reader_config_failed",
  "reader_decryption_failed",
  "invalid_query_result",
] as const;

function allowed<T extends string>(
  values: readonly T[],
  value: unknown,
): T | null {
  return typeof value === "string" &&
    (values as readonly string[]).includes(value)
    ? (value as T)
    : null;
}
function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}
function integer(value: unknown, max: number, min = 0): number | null {
  return typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= min &&
    value <= max
    ? value
    : null;
}
export interface SafeErrorFrame {
  file: string;
  line: number;
  column: number;
}
export interface SafeErrorContext {
  view?: string;
  statement?: string;
  providerStatus?: number;
  reason?: string;
  errorCode?: string;
  retryable?: boolean;
  durationMs?: number;
  queryId?: string;
  variant?: QueryVariant;
  statementCount?: number;
}
export interface SafeErrorDiagnostic {
  category: string;
  code: string;
  operation: string | null;
  name: string;
  message: string | null;
  messageRedacted: true;
  stack: SafeErrorFrame[];
  causes: string[];
  context: SafeErrorContext;
  fingerprint: string;
  count: number;
}
export interface ErrorDiagnostics {
  version: 1;
  diagnosticId: string;
  errors: SafeErrorDiagnostic[];
  dropped: number;
}

function safeContext(
  code: string,
  input: Record<string, unknown>,
): SafeErrorContext {
  if (code === "d1_operation_failed") {
    const queryId =
      typeof input.queryId === "string" && QUERY_REGISTRY.has(input.queryId)
        ? input.queryId
        : undefined;
    const variant = queryId ? allowed(QUERY_VARIANTS, input.variant) : null;
    const statementCount = integer(input.statementCount, 100_000, 1);
    return {
      ...(queryId && variant ? { queryId, variant } : {}),
      ...(statementCount !== null ? { statementCount } : {}),
    };
  }
  if (!code.startsWith("ae_reader_")) return {};
  const view = allowed(VIEWS, input.view);
  const statement = allowed(STATEMENTS, input.statement);
  const reason = allowed(REASONS, input.reason);
  const errorCode = allowed(READER_CODES, input.errorCode);
  const providerStatus = integer(input.providerStatus, 599, 100);
  const durationMs = integer(input.durationMs, 3_600_000);
  return {
    ...(view ? { view } : {}),
    ...(statement ? { statement } : {}),
    ...(reason ? { reason } : {}),
    ...(errorCode ? { errorCode } : {}),
    ...(providerStatus !== null ? { providerStatus } : {}),
    ...(typeof input.retryable === "boolean"
      ? { retryable: input.retryable }
      : {}),
    ...(durationMs !== null ? { durationMs } : {}),
  };
}
function messageTemplate(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const bounded = value.slice(0, 4096);
  return (
    MESSAGE_RULES.find(([, pattern]) => pattern.test(bounded))?.[0] ?? null
  );
}
function parseStack(value: unknown): SafeErrorFrame[] {
  if (typeof value !== "string") return [];
  const frames: SafeErrorFrame[] = [];
  for (const line of value.slice(0, 8192).split("\n").slice(1, 40)) {
    const match = /^\s*at\s+(?:.*\s+\()?([^()\s]+):(\d+):(\d+)\)?\s*$/.exec(
      line,
    );
    if (!match) continue;
    const path = match[1]!.replaceAll("\\", "/");
    if (/^[a-z]+:\/\//i.test(path) && !path.startsWith("file:///")) continue;
    const file = FILES.find(
      (candidate) => path === candidate || path.endsWith("/" + candidate),
    );
    const row = integer(Number(match[2]), 10_000_000, 1);
    const column = integer(Number(match[3]), 10_000_000, 1);
    if (!file || row === null || column === null) continue;
    frames.push({ file, line: row, column });
    if (frames.length === MAX_FRAMES) break;
  }
  return frames;
}

// Grouping hint over categorical facts, not a hash of private raw text.
function fingerprint(
  error: Omit<SafeErrorDiagnostic, "fingerprint" | "count">,
): string {
  const text = JSON.stringify([
    error.category,
    error.code,
    error.operation,
    error.name,
    error.message,
    error.stack.slice(0, 3),
    error.causes,
    error.context.view,
    error.context.statement,
    error.context.reason,
    error.context.errorCode,
    error.context.providerStatus,
    error.context.queryId,
    error.context.variant,
    error.context.statementCount,
  ]);
  let hash = 2166136261;
  for (let i = 0; i < text.length; i++)
    hash = Math.imul(hash ^ text.charCodeAt(i), 16777619);
  return (hash >>> 0).toString(16).padStart(8, "0");
}

export function captureErrorDiagnostic(
  signal: { category: string; code: string; operation: string } | undefined,
  data: Record<string, unknown> = {},
): SafeErrorDiagnostic {
  const code = allowed(CODES, signal?.code) ?? "unclassified_logged_error";
  const error = {
    category: allowed(CATEGORIES, signal?.category) ?? "unknown",
    code,
    operation: allowed(OPERATIONS, signal?.operation),
    name: allowed(NAMES, data.errorName) ?? "Unknown",
    message: messageTemplate(data.errorMessage),
    messageRedacted: true as const,
    stack: parseStack(data.errorStack),
    causes: [data.errorCause, data.errorCause2, data.errorCause3]
      .map(messageTemplate)
      .filter((item): item is string => item !== null),
    context: safeContext(code, data),
  };
  return { ...error, fingerprint: fingerprint(error), count: 1 };
}

export function appendErrorDiagnostic(
  state: ErrorDiagnostics,
  error: SafeErrorDiagnostic,
): void {
  const existing = state.errors.find(
    (item) =>
      item.fingerprint === error.fingerprint &&
      item.code === error.code &&
      item.operation === error.operation &&
      item.message === error.message &&
      JSON.stringify(item.stack) === JSON.stringify(error.stack) &&
      JSON.stringify(item.causes) === JSON.stringify(error.causes) &&
      item.context.reason === error.context.reason &&
      item.context.statement === error.context.statement &&
      item.context.errorCode === error.context.errorCode &&
      item.context.view === error.context.view &&
      item.context.providerStatus === error.context.providerStatus &&
      item.context.queryId === error.context.queryId &&
      item.context.variant === error.context.variant &&
      item.context.statementCount === error.context.statementCount,
  );
  if (existing) {
    existing.count = Math.min(1_000_000_000, existing.count + 1);
    return;
  }
  if (state.errors.length < MAX_ERRORS) {
    state.errors.push(error);
    return;
  }
  const unknown = state.errors.findIndex(
    (item) => item.code === "unclassified_logged_error",
  );
  if (unknown >= 0 && error.code !== "unclassified_logged_error") {
    state.dropped = Math.min(
      1_000_000_000,
      state.dropped + state.errors[unknown]!.count,
    );
    state.errors[unknown] = error;
  } else {
    state.dropped = Math.min(1_000_000_000, state.dropped + 1);
  }
}

/** Revalidate stored records; never pass unknown JSON to the administrator. */
export function decodeErrorDiagnostics(
  value: unknown,
): ErrorDiagnostics | null {
  const input = object(value);
  if (
    !input ||
    input.version !== 1 ||
    typeof input.diagnosticId !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
      input.diagnosticId,
    ) ||
    !Array.isArray(input.errors) ||
    input.errors.length > MAX_ERRORS
  )
    return null;
  const dropped = integer(input.dropped, 1_000_000_000);
  if (dropped === null) return null;
  const errors: SafeErrorDiagnostic[] = [];
  for (const value of input.errors) {
    const row = object(value);
    if (!row) continue;
    const code = allowed(CODES, row.code);
    const category = allowed(CATEGORIES, row.category);
    const name = allowed(NAMES, row.name);
    const count = integer(row.count, 1_000_000_000, 1);
    if (!code || !category || !name || count === null) continue;
    const stack: SafeErrorFrame[] = [];
    for (const value of Array.isArray(row.stack)
      ? row.stack.slice(0, MAX_FRAMES)
      : []) {
      const frame = object(value);
      if (!frame) continue;
      const file = allowed(FILES, frame.file);
      const line = integer(frame.line, 10_000_000, 1);
      const column = integer(frame.column, 10_000_000, 1);
      if (file && line !== null && column !== null)
        stack.push({ file, line, column });
    }
    const error = {
      category,
      code,
      operation: allowed(OPERATIONS, row.operation),
      name,
      message: allowed(MESSAGES, row.message),
      messageRedacted: true as const,
      stack,
      causes: (Array.isArray(row.causes) ? row.causes.slice(0, MAX_CAUSES) : [])
        .map((cause) => allowed(MESSAGES, cause))
        .filter((item): item is NonNullable<typeof item> => item !== null),
      context: safeContext(code, object(row.context) ?? {}),
    };
    errors.push({ ...error, fingerprint: fingerprint(error), count });
  }
  return { version: 1, diagnosticId: input.diagnosticId, errors, dropped };
}
