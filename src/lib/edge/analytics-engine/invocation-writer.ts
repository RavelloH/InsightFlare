import { isAnalyticsEngineDisabled } from "@/lib/edge/analytics-engine/config";
import type {
  InvocationLogger,
  InvocationSafeErrorSignal,
} from "@/lib/edge/observability/logger";
import type { InvocationSnapshot } from "@/lib/edge/observability/snapshot";
import type { Env } from "@/lib/edge/types";

import {
  addInvocationCoverageFlag,
  INV_FLAG_HANDLER_PRESENT,
  INV_FLAG_LOGS_TRUNCATED,
  INV_FLAG_STATUS_PRESENT,
  INV_FLAG_WS_PRESENT,
  INVOCATION_METRICS_SCHEMA_VERSION,
  type InvocationMetricsPoint,
  type InvocationResultClass,
} from "./invocation-schema";

const encoder = new TextEncoder();
const MAX_JSON_BYTES = 4_096;
const MAX_STRING_BYTES = 16_384;
const MAX_INDEX_BYTES = 96;
const MAX_OPS = 8;
const MAX_SIGNALS = 3;
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
type SafeError = {
  category: "database" | "application" | "infrastructure" | "unknown";
  code: string;
  operation: string;
  location: string;
  errorClass: string;
  severity: "error";
};
const ERROR_DEFINITIONS = {
  d1_operation_failed: { category: "database", errorClass: "database" },
  unhandled_request: { category: "application", errorClass: "unhandled" },
  do_alarm_failed: { category: "infrastructure", errorClass: "alarm" },
  scheduled_failed: { category: "infrastructure", errorClass: "scheduled" },
  websocket_failed: { category: "application", errorClass: "websocket" },
} as const;

function finite(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : 0;
}
function availableNumber(value: number | undefined, coverage: string): number {
  return coverage === "unavailable" ? 0 : finite(value);
}
const SAFE_METHODS = new Set([
  "GET",
  "HEAD",
  "POST",
  "PUT",
  "PATCH",
  "DELETE",
  "OPTIONS",
  "WEBSOCKET",
]);
function safeMethod(value: string | undefined): string {
  // HTTP methods originate in the request and can be attacker-controlled.
  return value === undefined ? "" : SAFE_METHODS.has(value) ? value : "OTHER";
}
function trustedRouteKey(snapshot: InvocationSnapshot): string {
  const fallback: Record<InvocationSnapshot["routeGroup"], string> = {
    api: "api.other",
    page: "page.other",
    do: "do.other",
    websocket: "do.websocket",
    scheduled: "scheduled.tasks",
  };
  const candidate = snapshot.routeKey;
  // Only an explicit trusted route template/fixed key may become an index.
  // The cap leaves space for the resultClass suffix (<=96 bytes in total).
  if (
    candidate &&
    encoder.encode(candidate).length <= 72 &&
    /^(?:api:\/[A-Za-z0-9_./:{}*-]+|api\.other|page\.other|server_function\.handler|do\.(?:ingest|snapshot|active|diagnostic|reconcile|flush|ws|other|alarm|websocket)|scheduled\.tasks)$/.test(
      candidate,
    )
  ) {
    return candidate;
  }
  return fallback[snapshot.routeGroup];
}
function trustedSignals(
  signals: readonly InvocationSafeErrorSignal[],
): SafeError[] {
  const out: SafeError[] = [];
  for (const signal of signals.slice(0, 16)) {
    if (!signal || !Object.hasOwn(ERROR_DEFINITIONS, signal.code)) continue;
    const code = signal.code as keyof typeof ERROR_DEFINITIONS;
    if (out.some((item) => item.code === code)) continue;
    const definition = ERROR_DEFINITIONS[code];
    const operation =
      code === "d1_operation_failed"
        ? SAFE_OPERATIONS.has(signal.operation) &&
          signal.operation.startsWith("d1.")
          ? signal.operation
          : "d1.exec"
        : code === "do_alarm_failed"
          ? "do.alarm"
          : code === "scheduled_failed"
            ? "scheduled.tasks"
            : code === "websocket_failed"
              ? "do.websocket"
              : "request";
    out.push({
      category: definition.category,
      code,
      operation,
      location: "",
      errorClass: definition.errorClass,
      severity: "error",
    });
    if (out.length >= MAX_SIGNALS) break;
  }
  // A trusted D1 failure outweighs a generic unhandled-request notification.
  const rank = (code: string) =>
    code === "d1_operation_failed"
      ? 0
      : code === "do_alarm_failed"
        ? 1
        : code === "scheduled_failed"
          ? 2
          : 3;
  return out.sort((a, b) => rank(a.code) - rank(b.code));
}
function classify(
  snapshot: InvocationSnapshot,
  errors: readonly SafeError[],
): InvocationResultClass {
  if (errors.length || snapshot.sql.failedStatements > 0) return "failure";
  if (snapshot.outcome === "canceled") return "canceled";
  if ((snapshot.status ?? 0) >= 500) return "failure";
  if ((snapshot.status ?? 0) >= 400 && (snapshot.status ?? 0) < 500)
    return "client_error";
  if (snapshot.outcome === "error") return "failure";
  return "ok";
}
function primaryError(
  snapshot: InvocationSnapshot,
  errors: readonly SafeError[],
  result: InvocationResultClass,
): SafeError | undefined {
  if (errors.length) return errors[0];
  if (snapshot.sql.failedStatements > 0)
    return {
      category: "database",
      code: "d1_operation_failed",
      operation: "d1.exec",
      location: "",
      errorClass: "database",
      severity: "error",
    };
  if (result === "failure")
    return {
      category: "unknown",
      code: (snapshot.status ?? 0) >= 500 ? "unknown_5xx" : "unknown_failure",
      operation: "",
      location: "",
      errorClass: "unknown",
      severity: "error",
    };
  return undefined;
}
function safeJson(
  snapshot: InvocationSnapshot,
  errors: readonly SafeError[],
): string {
  const operations = snapshot.operations
    .filter((op) => SAFE_OPERATIONS.has(op.name))
    .slice(0, MAX_OPS)
    .map((op) => ({
      key: op.name,
      count: finite(op.count),
      failed: finite(op.failed),
      sumMs: finite(op.cumulativeDurationMs),
    }));
  const resources = snapshot.resources;
  const details = {
    v: 1,
    ops: operations,
    do: {
      sqlCount: finite(resources.doSqlStatements),
      rowsRead: availableNumber(
        resources.doSqlRowsRead.value,
        resources.doSqlRowsRead.coverage,
      ),
      rowsWritten: availableNumber(
        resources.doSqlRowsWritten.value,
        resources.doSqlRowsWritten.coverage,
      ),
      rowsReadCoverage: resources.doSqlRowsRead.coverage,
      rowsWrittenCoverage: resources.doSqlRowsWritten.coverage,
      alarmOps: finite(resources.doAlarmOperations),
    },
    resources: {
      kvOps: finite(resources.kvOperations),
      r2Ops: finite(resources.r2Operations),
      failedExternalFetches: finite(resources.failedExternalFetches),
    },
    signals: errors.slice(0, MAX_SIGNALS).map((signal) => ({
      category: signal.category,
      code: signal.code,
      operation: signal.operation,
    })),
    truncated:
      snapshot.operations.length > operations.length ||
      snapshot.safeErrors.length > MAX_SIGNALS,
  };
  // Objects and keys are constructed exclusively above. Reduce only the
  // fixed ops array to preserve parseable JSON and never split UTF-8/JSON.
  let json = JSON.stringify(details);
  while (encoder.encode(json).length > MAX_JSON_BYTES && details.ops.length) {
    details.ops.pop();
    details.truncated = true;
    json = JSON.stringify(details);
  }
  return encoder.encode(json).length <= MAX_JSON_BYTES
    ? json
    : '{"v":1,"truncated":true}';
}
function appVersion(): string {
  // Replaced by Vite from the project's package.json at build time.
  const version: unknown = import.meta.env.VITE_APP_VERSION;
  return typeof version === "string" &&
    version.length <= 48 &&
    /^\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?$/.test(version)
    ? version
    : "unknown";
}

/** Immutable, schema-versioned AE point. Never serialize raw logs or errors. */
export function encodeInvocationMetricsPoint(
  snapshot: InvocationSnapshot,
): InvocationMetricsPoint {
  const errors = trustedSignals(snapshot.safeErrors);
  const resultClass = classify(snapshot, errors);
  const primary = primaryError(snapshot, errors, resultClass);
  const routeKey = trustedRouteKey(snapshot);
  const index = `${routeKey}:${resultClass}`;
  const sortedOps = [...snapshot.operations]
    .filter((op) => SAFE_OPERATIONS.has(op.name))
    .sort(
      (a, b) => finite(b.cumulativeDurationMs) - finite(a.cumulativeDurationMs),
    );
  let flags = 0;
  if (
    snapshot.handlerDurationMs !== undefined &&
    Number.isFinite(snapshot.handlerDurationMs)
  )
    flags |= INV_FLAG_HANDLER_PRESENT;
  if (snapshot.status !== undefined && Number.isFinite(snapshot.status))
    flags |= INV_FLAG_STATUS_PRESENT;
  if (
    snapshot.webSocketConnectionDurationMs !== undefined &&
    Number.isFinite(snapshot.webSocketConnectionDurationMs)
  )
    flags |= INV_FLAG_WS_PRESENT;
  if (snapshot.logsTruncated) flags |= INV_FLAG_LOGS_TRUNCATED;
  flags = addInvocationCoverageFlag(
    flags,
    "rowsRead",
    snapshot.sql.rowsRead.coverage,
  );
  flags = addInvocationCoverageFlag(
    flags,
    "rowsWritten",
    snapshot.sql.rowsWritten.coverage,
  );
  flags = addInvocationCoverageFlag(
    flags,
    "sqlDuration",
    snapshot.sql.cumulativeSqlDurationMs.coverage,
  );
  flags = addInvocationCoverageFlag(
    flags,
    "attempts",
    snapshot.sql.totalAttempts.coverage,
  );
  flags = addInvocationCoverageFlag(
    flags,
    "doSqlRowsRead",
    snapshot.resources.doSqlRowsRead.coverage,
  );
  flags = addInvocationCoverageFlag(
    flags,
    "doSqlRowsWritten",
    snapshot.resources.doSqlRowsWritten.coverage,
  );

  const point: InvocationMetricsPoint = {
    indexes: [index],
    blobs: [
      snapshot.source,
      snapshot.trigger,
      snapshot.routeGroup,
      routeKey,
      safeMethod(snapshot.method),
      resultClass,
      snapshot.outcome,
      snapshot.cache ?? "",
      snapshot.dataSource ?? "",
      appVersion(),
      primary?.category ?? "",
      primary?.code ?? "",
      primary?.operation ?? "",
      primary?.location ?? "",
      primary?.errorClass ?? "",
      sortedOps[0]?.name ?? "",
      primary?.severity ?? "",
      errors
        .filter((error) => error.code !== primary?.code)
        .slice(0, 2)
        .map((error) => error.code)
        .join(","),
      safeJson(snapshot, errors),
      "",
    ],
    doubles: [
      finite(snapshot.invocationDurationMs),
      finite(snapshot.handlerDurationMs),
      finite(snapshot.webSocketConnectionDurationMs),
      finite(snapshot.sql.statements),
      finite(snapshot.sql.finishedStatements),
      finite(snapshot.sql.unobservedStatements),
      finite(snapshot.sql.settledOperations),
      finite(snapshot.sql.failedStatements),
      availableNumber(
        snapshot.sql.rowsRead.value,
        snapshot.sql.rowsRead.coverage,
      ),
      availableNumber(
        snapshot.sql.rowsWritten.value,
        snapshot.sql.rowsWritten.coverage,
      ),
      availableNumber(
        snapshot.sql.cumulativeSqlDurationMs.value,
        snapshot.sql.cumulativeSqlDurationMs.coverage,
      ),
      availableNumber(
        snapshot.sql.totalAttempts.value,
        snapshot.sql.totalAttempts.coverage,
      ),
      availableNumber(
        snapshot.sql.retries.value,
        snapshot.sql.retries.coverage,
      ),
      finite(snapshot.d1OperationCumulativeDurationMs),
      finite(snapshot.resources.doCalls),
      finite(snapshot.resources.externalFetches),
      finite(snapshot.errorEvents),
      finite(snapshot.status),
      flags,
      INVOCATION_METRICS_SCHEMA_VERSION,
    ],
  };
  if (
    encoder.encode(index).length > MAX_INDEX_BYTES ||
    point.blobs.length !== 20 ||
    point.doubles.length !== 20 ||
    point.blobs.reduce((sum, blob) => sum + encoder.encode(blob).length, 0) >
      MAX_STRING_BYTES
  ) {
    // Avoid writing a malformed point; write handler catches and isolates it.
    throw new Error("invalid invocation metrics point");
  }
  return point;
}

const installed = new WeakSet<InvocationLogger>();

/**
 * Register exactly once on an actual invocation's existing Logger.
 * No additional D1 reads, no SQL-level or collector-level AE writes.
 * Callback exceptions are swallowed; the original HTTP/DO Alarm outcome wins.
 */
export function registerInvocationMetrics(
  env: Pick<
    Env,
    "INVOCATION_METRICS" | "INSIGHTFLARE_ANALYTICS_ENGINE_DISABLED"
  >,
  logger: InvocationLogger,
): void {
  if (
    isAnalyticsEngineDisabled(env as Env) ||
    !env.INVOCATION_METRICS ||
    installed.has(logger)
  )
    return;
  installed.add(logger);
  const dataset = env.INVOCATION_METRICS;
  logger.onComplete((snapshot) => {
    try {
      dataset.writeDataPoint(encodeInvocationMetricsPoint(snapshot));
    } catch {
      // AE is strictly best effort and must not recurse into Workers Logs.
    }
  });
}
