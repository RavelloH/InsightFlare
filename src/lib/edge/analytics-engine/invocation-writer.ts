import { isAnalyticsEngineDisabled } from "@/lib/edge/analytics-engine/config";
import { QUERY_REGISTRY } from "@/lib/edge/analytics-engine/query-registry";
import {
  decodeErrorDiagnostics,
  ERROR_DETAILS_BYTES,
  NORMAL_DETAILS_BYTES,
} from "@/lib/edge/observability/error-diagnostics";
import type {
  InvocationLogger,
  InvocationSafeErrorSignal,
} from "@/lib/edge/observability/logger";
import type { InvocationSnapshot } from "@/lib/edge/observability/snapshot";
import type { Env } from "@/lib/edge/types";

import {
  type InvocationHotspots,
  registerHotspotCollector,
} from "./hotspot-collector";
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
import {
  INVOCATION_METRICS_SCHEMA_V2,
  setV2BooleanFlag,
  setV2CoverageFlag,
} from "./invocation-schema-v2";

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
  "dashboard.bootstrap",
  "dashboard.profile",
  "dashboard.team_snapshot",
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
  "do.fetch",
  "background.drain",
  "event_type_context",
  "event_type_detail.overview",
  "event_type_detail.trend",
  "event_type_detail.context_cards",
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
  d1_operation_failed: {
    category: "database",
    errorClass: "database",
    operation: "d1.exec",
  },
  unhandled_request: {
    category: "application",
    errorClass: "unhandled",
    operation: "request",
  },
  do_alarm_failed: {
    category: "infrastructure",
    errorClass: "alarm",
    operation: "do.alarm",
  },
  scheduled_failed: {
    category: "infrastructure",
    errorClass: "scheduled",
    operation: "scheduled.tasks",
  },
  websocket_failed: {
    category: "application",
    errorClass: "websocket",
    operation: "do.websocket",
  },
  websocket_snapshot_failed: {
    category: "infrastructure",
    errorClass: "websocket_snapshot",
    operation: "do.websocket.initial_snapshot",
  },
  do_flush_visit_batch_failed: {
    category: "database",
    errorClass: "flush",
    operation: "do.flush.visit_batch",
  },
  do_flush_visit_failed: {
    category: "database",
    errorClass: "flush",
    operation: "do.flush.visit",
  },
  do_flush_custom_event_failed: {
    category: "database",
    errorClass: "flush",
    operation: "do.flush.custom_event",
  },
  query_application_failed: {
    category: "application",
    errorClass: "query",
    operation: "query.application",
  },
  ae_reader_invalid_query: {
    category: "application",
    errorClass: "ae_reader",
    operation: "ae.reader.sql",
  },
  ae_reader_auth_failed: {
    category: "infrastructure",
    errorClass: "ae_reader",
    operation: "ae.reader.sql",
  },
  ae_reader_rate_limited: {
    category: "infrastructure",
    errorClass: "ae_reader",
    operation: "ae.reader.sql",
  },
  ae_reader_timeout: {
    category: "infrastructure",
    errorClass: "ae_reader",
    operation: "ae.reader.sql",
  },
  ae_reader_upstream_failed: {
    category: "infrastructure",
    errorClass: "ae_reader",
    operation: "ae.reader.sql",
  },
  ae_reader_invalid_response: {
    category: "application",
    errorClass: "ae_reader",
    operation: "ae.reader.sql",
  },
  ae_reader_config_failed: {
    category: "infrastructure",
    errorClass: "ae_reader",
    operation: "ae.reader.sql",
  },
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
    /^(?:api:\/[A-Za-z0-9_./:{}*-]+|api\.other|page\.(?:other|dashboard\.(?:workspace|team|other))|server_function\.(?:handler|dashboard\.bootstrap)|do\.(?:ingest|snapshot|active|diagnostic|reconcile|flush|ws|other|alarm|websocket)|scheduled\.tasks)$/.test(
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
      code === "d1_operation_failed" &&
      SAFE_OPERATIONS.has(signal.operation) &&
      signal.operation.startsWith("d1.")
        ? signal.operation
        : definition.operation;
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
      : code.startsWith("do_flush_")
        ? 1
        : code === "do_alarm_failed"
          ? 2
          : code === "websocket_snapshot_failed"
            ? 3
            : code === "query_application_failed"
              ? 4
              : code === "scheduled_failed"
                ? 5
                : 6;
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
  if (snapshot.outcome === "error" || snapshot.errorEvents > 0)
    return "failure";
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
      code:
        (snapshot.status ?? 0) >= 500
          ? "unknown_5xx"
          : snapshot.errorEvents > 0 && snapshot.outcome === "ok"
            ? "unclassified_logged_error"
            : "unknown_failure",
      operation: "",
      location: "",
      errorClass:
        snapshot.errorEvents > 0 && snapshot.outcome === "ok"
          ? "logged_error"
          : "unknown",
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
  // Both values are injected by Vite at build time, never request-derived.
  const version: unknown = import.meta.env.VITE_APP_VERSION;
  const commit: unknown = import.meta.env.VITE_COMMIT_SHA;
  const safeVersion =
    typeof version === "string" &&
    version.length <= 48 &&
    /^\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?$/.test(version)
      ? version
      : "unknown";
  const safeCommit =
    typeof commit === "string" && /^[0-9a-f]{7,40}$/.test(commit)
      ? commit.slice(0, 12)
      : "";
  return safeCommit ? `${safeVersion}+${safeCommit}` : safeVersion;
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
  const collector = registerHotspotCollector(logger);
  const dataset = env.INVOCATION_METRICS;
  logger.onComplete(
    (snapshot) => {
      try {
        dataset.writeDataPoint(
          encodeInvocationMetricsPointV2(snapshot, collector.snapshot()),
        );
      } catch {
        // AE is strictly best effort and must not recurse into Workers Logs.
      }
    },
    { includeErrorDiagnostics: true },
  );
}

/** Encode v2 from the same trusted v1-safe snapshot, never raw request data. */
export function encodeInvocationMetricsPointV2(
  snapshot: InvocationSnapshot,
  metrics: InvocationHotspots,
): InvocationMetricsPoint {
  const v1 = encodeInvocationMetricsPoint(snapshot);
  const n = (v: number | undefined) =>
    typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : 0;
  const cov = (
    observed: number,
    total: number,
  ): "unavailable" | "partial" | "complete" =>
    observed === 0 || total === 0
      ? "unavailable"
      : observed === total
        ? "complete"
        : "partial";
  // Never compare an independently measured SQL API wait with a Batch
  // statement's unmeasured API wait. SQL engine is only a fallback when
  // ALL candidates lack API wall and ALL have complete engine coverage.
  const candidatesComplete =
    metrics.queries.length > 0 && metrics.droppedQueries === 0;
  const allWall =
    candidatesComplete &&
    metrics.queries.every((q) => q.wallObserved === q.count);
  const allEngineOnly =
    candidatesComplete &&
    metrics.queries.every(
      (q) => q.wallObserved === 0 && q.engineObserved === q.count,
    );
  const basis = allWall
    ? "apiWall"
    : allEngineOnly
      ? "sqlEngine"
      : "unavailable";
  const hot =
    basis === "unavailable"
      ? undefined
      : [...metrics.queries].sort(
          (a, b) =>
            (basis === "apiWall"
              ? b.apiWallMs - a.apiWallMs
              : b.sqlEngineMs - a.sqlEngineMs) || a.id.localeCompare(b.id),
        )[0];
  const scan =
    !candidatesComplete ||
    metrics.queries.some((q) => q.readObserved !== q.count)
      ? undefined
      : [...metrics.queries].sort(
          (a, b) => b.rowsRead - a.rowsRead || a.id.localeCompare(b.id),
        )[0];
  const doFetch = snapshot.operations.find((op) => op.name === "do.fetch");
  const fetchCoverage =
    snapshot.resources.doCalls === 0 || !doFetch
      ? "unavailable"
      : doFetch.count === snapshot.resources.doCalls
        ? "complete"
        : "partial";
  const phases = snapshot.operations
    .filter((op) => SAFE_OPERATIONS.has(op.name))
    .map((op) => ({
      id: op.name,
      count: n(op.count),
      wallMs: n(op.cumulativeDurationMs),
    }));
  if (snapshot.backgroundDrainMs !== undefined)
    phases.push({
      id: "background.drain",
      count: 1,
      wallMs: n(snapshot.backgroundDrainMs),
    });
  phases.sort((a, b) => b.wallMs - a.wallMs || a.id.localeCompare(b.id));
  const candidates = [...metrics.queries].sort(
    (a, b) =>
      b.apiWallMs - a.apiWallMs ||
      b.rowsRead - a.rowsRead ||
      a.id.localeCompare(b.id),
  );
  const chosen: typeof candidates = [];
  for (const q of [hot, scan]) if (q && !chosen.includes(q)) chosen.push(q);
  for (const q of candidates) {
    if (chosen.length === 6) break;
    if (!chosen.includes(q)) chosen.push(q);
  }
  const queryDetails = chosen.map((q) => ({
    id: q.id,
    variant: q.variant,
    filterShape: q.filter?.code ?? "",
    granularity: QUERY_REGISTRY.get(q.id)?.granularity ?? "unknown",
    count: q.count,
    apiWallMs: n(q.apiWallMs),
    sqlEngineMs: n(q.sqlEngineMs),
    rowsRead: n(q.rowsRead),
    rowsWritten: n(q.rowsWritten),
    attempts: n(q.attempts),
    failed: q.failed,
    coverage: {
      api: cov(q.wallObserved, q.count),
      engine: cov(q.engineObserved, q.count),
      rowsRead: cov(q.readObserved, q.count),
      rowsWritten: cov(q.writeObserved, q.count),
      attempts: cov(q.attemptsObserved, q.count),
    },
  }));
  const templateStatements = metrics.queries.reduce(
    (sum, q) =>
      sum +
      (QUERY_REGISTRY.get(q.id)?.granularity === "sql-template" ? q.count : 0),
    0,
  );
  const familyStatements = metrics.queryCount - templateStatements;
  // Counts cover ALL observed statement groups, not just the six serialized
  // query details. Missing D1 meta is never silently converted to a zero.
  const rowsReadObservedStatements = metrics.queries.reduce(
    (sum, q) => sum + q.readObserved,
    0,
  );
  const rowsWrittenObservedStatements = metrics.queries.reduce(
    (sum, q) => sum + q.writeObserved,
    0,
  );
  const queryGranularity =
    metrics.queryCount === 0
      ? "none"
      : metrics.droppedQueries > 0
        ? "partial"
        : templateStatements === metrics.queryCount
          ? "sql-template"
          : templateStatements === 0
            ? "provider-family"
            : "mixed";
  // A family-level operation names a useful business family but is NOT proof
  // that an individual SQL template was identified.
  const attributionComplete =
    metrics.unknownCount === 0 &&
    metrics.droppedQueries === 0 &&
    metrics.queryCount === snapshot.sql.statements &&
    templateStatements === metrics.queryCount;
  const diagnostics = decodeErrorDiagnostics(snapshot.errorDiagnostics);
  const budget = diagnostics ? ERROR_DETAILS_BYTES : NORMAL_DETAILS_BYTES;
  const details = {
    v: 2,
    ...(diagnostics ? { errorDiagnostics: diagnostics } : {}),
    hotBasis: hot ? basis : "unavailable",
    rankingCoverage:
      metrics.droppedQueries > 0
        ? "truncated"
        : metrics.queries.length === 0
          ? "unavailable"
          : basis === "unavailable"
            ? "incomparable"
            : "complete",
    phases: phases.slice(0, 6),
    queries: queryDetails,
    ...(metrics.filter ? { filter: metrics.filter } : {}),
    resources: {
      externalFetches: n(snapshot.resources.externalFetches),
      kvOps: n(snapshot.resources.kvOperations),
      r2Ops: n(snapshot.resources.r2Operations),
      doSqlStatements: n(snapshot.resources.doSqlStatements),
      doSqlRowsWritten:
        snapshot.resources.doSqlRowsWritten.coverage === "unavailable"
          ? null
          : n(snapshot.resources.doSqlRowsWritten.value),
      doSqlRowsWrittenCoverage: snapshot.resources.doSqlRowsWritten.coverage,
      wsLifetimeMs: snapshot.webSocketConnectionDurationMs ?? null,
      d1Finished: n(snapshot.sql.finishedStatements),
      d1Unobserved: n(snapshot.sql.unobservedStatements),
      d1Settled: n(snapshot.sql.settledOperations),
      d1Attempts:
        snapshot.sql.totalAttempts.coverage === "unavailable"
          ? null
          : n(snapshot.sql.totalAttempts.value),
      errorEvents: n(snapshot.errorEvents),
    },
    coverage: {
      query: attributionComplete ? "complete" : "partial",
      queryGranularity,
      templateStatements,
      familyStatements,
      unknownStatements: metrics.unknownCount,
      rowsReadObservedStatements,
      rowsWrittenObservedStatements,
      // Ranking completeness refers to the candidate comparison, whereas
      // detail completeness refers only to the serialized top-six subset.
      queryDetails:
        metrics.droppedQueries > 0 || candidates.length > chosen.length
          ? "partial"
          : "complete",
      filter: metrics.filterAmbiguous
        ? "mixed"
        : metrics.filter
          ? "complete"
          : "unavailable",
    },
    signals: trustedSignals(snapshot.safeErrors)
      .slice(0, 3)
      .map((s) => ({ code: s.code, category: s.category })),
    truncation: {
      queriesDropped:
        metrics.droppedQueries + Math.max(0, candidates.length - chosen.length),
      phasesDropped: Math.max(0, phases.length - 6),
      signalsDropped: Math.max(0, snapshot.safeErrors.length - 3),
    },
  };
  const utf8 = new TextEncoder();
  const size = (s: string) => utf8.encode(s).length;
  let json = JSON.stringify(details);
  while (size(json) > budget && details.queries.length > 0) {
    details.queries.pop();
    details.truncation.queriesDropped++;
    details.coverage.queryDetails = "partial";
    json = JSON.stringify(details);
  }
  while (size(json) > budget && details.phases.length > 0) {
    details.phases.pop();
    details.truncation.phasesDropped++;
    json = JSON.stringify(details);
  }
  if (size(json) > budget) {
    details.truncation.signalsDropped += details.signals.length;
    details.signals.length = 0;
    json = JSON.stringify(details);
  }
  if (diagnostics) {
    while (size(json) > budget && diagnostics.errors.length > 1) {
      const removed = diagnostics.errors.pop()!;
      diagnostics.dropped = Math.min(
        1_000_000_000,
        diagnostics.dropped + removed.count,
      );
      json = JSON.stringify(details);
    }
  }
  if (size(json) > budget) {
    // Preserve the correlation ID even if the remaining diagnostic is too large.
    if (diagnostics) {
      diagnostics.dropped = Math.min(
        1_000_000_000,
        diagnostics.dropped +
          diagnostics.errors.reduce((sum, error) => sum + error.count, 0),
      );
      diagnostics.errors.length = 0;
    }
    details.truncation.queriesDropped = Math.max(
      details.truncation.queriesDropped,
      999,
    );
    json = JSON.stringify({
      v: 2,
      ...(diagnostics ? { errorDiagnostics: diagnostics } : {}),
      truncation: details.truncation,
    });
  }
  const truncated =
    (diagnostics?.dropped ?? 0) > 0 ||
    Object.values(details.truncation).some((value) => value > 0);
  let flags = 0;
  for (const [name, present] of [
    ["handlerPresent", snapshot.handlerDurationMs !== undefined],
    ["httpStatusPresent", snapshot.status !== undefined],
    ["backgroundDrainPresent", snapshot.backgroundDrainMs !== undefined],
    ["doFetchWallPresent", fetchCoverage !== "unavailable"],
    ["hotQueryPresent", Boolean(hot)],
    ["hotQueryApiWallPresent", Boolean(hot && hot.wallObserved === hot.count)],
    ["scanQueryPresent", Boolean(scan)],
    ["filterPresent", Boolean(metrics.filter)],
    ["detailsTruncated", truncated],
    ["queryAttributionComplete", attributionComplete],
  ] as const)
    flags = setV2BooleanFlag(flags, name, present);
  for (const [name, coverage] of [
    ["d1RowsRead", snapshot.sql.rowsRead.coverage],
    ["d1RowsWritten", snapshot.sql.rowsWritten.coverage],
    ["d1SqlEngine", snapshot.sql.cumulativeSqlDurationMs.coverage],
    ["d1Attempts", snapshot.sql.totalAttempts.coverage],
    [
      "d1ApiWall",
      metrics.d1ApiCallCount === 0
        ? "unavailable"
        : metrics.d1ApiCallCount === snapshot.sql.settledOperations
          ? "complete"
          : "partial",
    ],
    ["doSqlRowsRead", snapshot.resources.doSqlRowsRead.coverage],
    [
      "hotQueryEngine",
      hot ? cov(hot.engineObserved, hot.count) : "unavailable",
    ],
    [
      "hotQueryRowsRead",
      hot ? cov(hot.readObserved, hot.count) : "unavailable",
    ],
    [
      "scanQueryRowsRead",
      scan ? cov(scan.readObserved, scan.count) : "unavailable",
    ],
    ["doFetchWall", fetchCoverage],
  ] as const)
    flags = setV2CoverageFlag(flags, name, coverage);

  const point: InvocationMetricsPoint = {
    indexes: v1.indexes,
    blobs: [
      ...v1.blobs.slice(0, 13),
      hot?.id ?? "",
      hot?.variant ?? "",
      hot?.filter?.code ?? "",
      scan?.id ?? "",
      phases[0]?.id ?? "",
      json,
      hot?.filter?.family ??
        (metrics.filterAmbiguous
          ? "mixed"
          : (metrics.filter?.family ?? "none")),
    ],
    doubles: [
      n(snapshot.invocationDurationMs),
      n(snapshot.handlerDurationMs),
      n(snapshot.backgroundDrainMs),
      n(snapshot.sql.statements),
      n(snapshot.sql.failedStatements),
      snapshot.sql.rowsRead.coverage === "unavailable"
        ? 0
        : n(snapshot.sql.rowsRead.value),
      snapshot.sql.rowsWritten.coverage === "unavailable"
        ? 0
        : n(snapshot.sql.rowsWritten.value),
      snapshot.sql.cumulativeSqlDurationMs.coverage === "unavailable"
        ? 0
        : n(snapshot.sql.cumulativeSqlDurationMs.value),
      n(metrics.d1ApiWallSumMs),
      snapshot.sql.retries.coverage === "unavailable"
        ? 0
        : n(snapshot.sql.retries.value),
      n(snapshot.resources.doCalls),
      n(doFetch?.cumulativeDurationMs),
      snapshot.resources.doSqlRowsRead.coverage === "unavailable"
        ? 0
        : n(snapshot.resources.doSqlRowsRead.value),
      n(hot?.apiWallMs),
      n(hot && hot.engineObserved ? hot.sqlEngineMs : undefined),
      n(hot && hot.readObserved ? hot.rowsRead : undefined),
      n(scan && scan.readObserved ? scan.rowsRead : undefined),
      n(snapshot.status),
      flags,
      INVOCATION_METRICS_SCHEMA_V2,
    ],
  };
  if (
    point.blobs.length !== 20 ||
    point.doubles.length !== 20 ||
    point.blobs.reduce((sum, blob) => sum + size(blob), 0) > 16384
  )
    throw new Error("invalid invocation metrics v2 point");
  return point;
}
