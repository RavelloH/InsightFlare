import {
  v2BooleanFlag,
  type V2Coverage,
} from "@/lib/edge/analytics-engine/invocation-schema-v2";
import {
  QUERY_REGISTRY,
  QUERY_VARIANTS,
  type QueryVariant,
  UNKNOWN_QUERY_ID,
} from "@/lib/edge/analytics-engine/query-registry";

import {
  HOTSPOT_KINDS,
  type HotspotKind,
  type InvocationView,
} from "./invocation-metrics-input";

export type InvocationMetricsStatus =
  "ready" | "no_data" | "insufficient_coverage";
export type InvocationResultName =
  | "summary"
  | "trend"
  | "legacy"
  | "routes"
  | "errors"
  | "samples"
  | HotspotKind;
export type InvocationMetricsResults = Partial<
  Record<InvocationResultName, Record<string, unknown>[]>
>;

export interface InvocationCountMetrics {
  retainedSamples: number;
  estimatedInvocations: number;
  maxSampleInterval: number | null;
}

export type InvocationWeightedCoverage = "complete" | "partial" | "unavailable";

export interface InvocationWeightedMetric {
  applicable: number;
  complete: number;
  partial: number;
  observed: number;
  /** Trusted value, or a lower bound when some applicable weight is unobserved. */
  value: number | null;
  coverage: InvocationWeightedCoverage;
  lowerBound: boolean;
}

export type InvocationCoveredMetricName =
  | "d1RowsRead"
  | "d1SqlEngineMs"
  | "d1ApiWallMs"
  | "doFetchWallMs"
  | "doSqlRowsRead";

export type InvocationWeightedMetrics = Record<
  InvocationCoveredMetricName,
  InvocationWeightedMetric
>;

export interface InvocationAggregate extends InvocationCountMetrics {
  handlerWeight: number;
  p50: number | null;
  p95: number | null;
  p99: number | null;
  invocationWallMs: number;
  workerD1Statements: number;
  doFetchCalls: number;
  weighted: InvocationWeightedMetrics;
}

export interface InvocationDimensions {
  source: "worker" | "do";
  trigger: "request" | "alarm" | "scheduled" | "websocket";
  routeKey: string;
  appVersion: string | null;
}

export interface InvocationOverviewData {
  summary: InvocationAggregate | null;
  trend: Array<InvocationAggregate & { bucket: number }>;
  legacy: { retainedSamples: number } | null;
}

export interface InvocationRouteAggregate
  extends InvocationDimensions, InvocationAggregate {}

export interface InvocationErrorAggregate
  extends InvocationDimensions, InvocationCountMetrics {
  resultClass: "ok" | "client_error" | "failure" | "canceled";
  category: string | null;
  code: string | null;
  operation: string | null;
}

export interface InvocationHotspot extends InvocationDimensions {
  queryId: string;
  variant: QueryVariant | null;
  filterShape: string | null;
  filterFamily: string | null;
  granularity:
    "provider-family" | "query-operation" | "sql-template" | "unknown";
  owner: string | null;
  retainedSamples: number;
  estimatedInvocations: number;
  maxSampleInterval: number | null;
  weightedValue: number;
}

export type InvocationSafePhase =
  | "route.handler"
  | "page.handler"
  | "page.middleware"
  | "server_function.handler"
  | "do.fetch.handler"
  | "do.schema_ready"
  | "do.maintenance"
  | "do.alarm.reconcile"
  | "do.websocket.initial_snapshot"
  | "d1.all"
  | "d1.first"
  | "d1.run"
  | "d1.raw"
  | "d1.exec"
  | "d1.batch"
  | "do.fetch"
  | "background.drain"
  | "event_type_context"
  | "event_type_detail.overview"
  | "event_type_detail.trend"
  | "event_type_detail.context_cards";

export interface InvocationSafeDetails {
  version: 2;
  phases: Array<{ id: InvocationSafePhase; count: number; wallMs: number }>;
  queries: Array<{
    id: string;
    variant: QueryVariant;
    granularity:
      "provider-family" | "query-operation" | "sql-template" | "unknown";
    count: number;
    apiWallMs: number;
    sqlEngineMs: number;
    rowsRead: number;
    rowsWritten: number;
    attempts: number;
    failed: boolean;
    coverage: Record<
      "api" | "engine" | "rowsRead" | "rowsWritten" | "attempts",
      V2Coverage
    >;
  }>;
  coverage: {
    query: "complete" | "partial";
    queryGranularity:
      "none" | "partial" | "sql-template" | "provider-family" | "mixed";
    templateStatements: number;
    familyStatements: number;
  } | null;
  truncation: {
    queriesDropped: number;
    phasesDropped: number;
    signalsDropped: number;
  } | null;
}

export interface InvocationSample extends InvocationDimensions {
  timestampSeconds: number;
  resultClass: "ok" | "client_error" | "failure" | "canceled";
  category: string | null;
  code: string | null;
  operation: string | null;
  hotQueryId: string | null;
  variant: QueryVariant | null;
  filterShape: string | null;
  scanQueryId: string | null;
  /** Highest cumulative observed phase wall time; not exclusive or critical-path time. */
  dominantPhase: InvocationSafePhase | null;
  details: InvocationSafeDetails | null;
  filterFamily: string | null;
  sampleInterval: number;
  invocationWallMs: number;
  handlerWallMs: number | null;
  httpStatus: number | null;
  flags: number;
  detailsTruncated: boolean;
}

export interface InvocationOverviewResult {
  view: "overview";
  status: InvocationMetricsStatus;
  data: InvocationOverviewData;
}
export interface InvocationRoutesResult {
  view: "routes";
  status: InvocationMetricsStatus;
  data: { routes: InvocationRouteAggregate[] };
}
export interface InvocationErrorsResult {
  view: "errors";
  status: InvocationMetricsStatus;
  data: { errors: InvocationErrorAggregate[] };
}
export interface InvocationHotspotsResult {
  view: "hotspots";
  status: InvocationMetricsStatus;
  data: {
    summary: InvocationCountMetrics | null;
    hotspots: Record<HotspotKind, InvocationHotspot[]>;
  };
}
export interface InvocationSamplesResult {
  view: "samples";
  status: InvocationMetricsStatus;
  data: { samples: InvocationSample[] };
}
export type InvocationMetricsResult =
  | InvocationOverviewResult
  | InvocationRoutesResult
  | InvocationHotspotsResult
  | InvocationErrorsResult
  | InvocationSamplesResult;

const INVALID_RESULT = "Invalid invocation metrics result";
const SOURCES = new Set(["worker", "do"]);
const TRIGGERS = new Set(["request", "alarm", "scheduled", "websocket"]);
const RESULT_CLASSES = new Set(["ok", "client_error", "failure", "canceled"]);
const SAFE_PHASES = new Set<InvocationSafePhase>([
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
  "do.fetch",
  "background.drain",
  "event_type_context",
  "event_type_detail.overview",
  "event_type_detail.trend",
  "event_type_detail.context_cards",
]);
const COVERED_METRICS: readonly InvocationCoveredMetricName[] = [
  "d1RowsRead",
  "d1SqlEngineMs",
  "d1ApiWallMs",
  "doFetchWallMs",
  "doSqlRowsRead",
];
const SAFE_SHAPE =
  /^(?:none|basic|boolean|related-entity|advanced-json|mixed|unknown)\.[cxaon](?:[aon]+|x)\.(?:0|1|2|3-4|5-8|9\+)\.(?:0|1|2|3-4|5-8|9\+)\.o[0-9a-z]+$/;
const SAFE_APP_VERSION =
  /^(?:unknown|\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?)(?:\+[A-Za-z0-9.-]+){0,2}$/;
const utf8 = new TextEncoder();

function invalid(): never {
  throw new Error(INVALID_RESULT);
}
function row(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return invalid();
  return value as Record<string, unknown>;
}
function rows(
  results: InvocationMetricsResults,
  name: InvocationResultName,
): Record<string, unknown>[] {
  const value = results[name];
  if (value === undefined) return [];
  if (!Array.isArray(value)) return invalid();
  return value.map(row);
}
function number(value: unknown, allowNull = false): number | null {
  if (value === null && allowNull) return null;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0)
    return invalid();
  return value;
}
function integer(value: unknown): number {
  const result = number(value);
  if (!Number.isSafeInteger(result)) return invalid();
  return result as number;
}
function countNumber(value: unknown, empty: boolean): number {
  if (value === null && empty) return 0;
  return number(value) as number;
}
function sum(
  rowValue: Record<string, unknown>,
  key: string,
  empty: boolean,
): number {
  return countNumber(rowValue[key], empty);
}
function optionalSafeString(
  value: unknown,
  pattern: RegExp,
  maxLength = 160,
): string | null {
  if (value === "") return null;
  if (
    typeof value !== "string" ||
    value.length > maxLength ||
    !pattern.test(value)
  )
    return invalid();
  return value;
}
function dimensions(sourceRow: Record<string, unknown>): InvocationDimensions {
  const source = sourceRow.source;
  const trigger = sourceRow.trigger;
  const routeKey = sourceRow.routeKey;
  const appVersion = sourceRow.appVersion;
  if (typeof source !== "string" || !SOURCES.has(source)) return invalid();
  if (typeof trigger !== "string" || !TRIGGERS.has(trigger)) return invalid();
  if (
    typeof routeKey !== "string" ||
    routeKey.length > 256 ||
    (routeKey !== "" &&
      !/^(?:api:\/[A-Za-z0-9_./:{}*-]+|api\.other|page\.other|server_function\.handler|do\.(?:ingest|snapshot|active|diagnostic|reconcile|flush|ws|other|alarm|websocket)|scheduled\.tasks)$/.test(
        routeKey,
      ))
  )
    return invalid();
  if (appVersion === "")
    return {
      source: source as InvocationDimensions["source"],
      trigger: trigger as InvocationDimensions["trigger"],
      routeKey,
      appVersion: null,
    };
  if (
    typeof appVersion !== "string" ||
    appVersion.length > 61 ||
    !SAFE_APP_VERSION.test(appVersion)
  )
    return invalid();
  return {
    source: source as InvocationDimensions["source"],
    trigger: trigger as InvocationDimensions["trigger"],
    routeKey,
    appVersion,
  };
}
function countMetrics(
  sourceRow: Record<string, unknown>,
): InvocationCountMetrics {
  const retainedSamples = integer(sourceRow.retainedSamples);
  const empty = retainedSamples === 0;
  const estimatedInvocations = sum(sourceRow, "estimatedInvocations", empty);
  const maxSampleInterval = number(sourceRow.maxSampleInterval, empty);
  if (!empty && (maxSampleInterval === null || maxSampleInterval < 1))
    return invalid();
  return { retainedSamples, estimatedInvocations, maxSampleInterval };
}
function weightedMetric(
  sourceRow: Record<string, unknown>,
  name: InvocationCoveredMetricName,
  empty: boolean,
): InvocationWeightedMetric {
  const applicable = sum(sourceRow, `${name}Applicable`, empty);
  const complete = sum(sourceRow, `${name}Complete`, empty);
  const partial = sum(sourceRow, `${name}Partial`, empty);
  const observed = sum(sourceRow, `${name}Observed`, empty);
  const tolerance = Math.max(1, applicable) * 1e-9;
  if (
    complete > applicable + tolerance ||
    partial > applicable + tolerance ||
    complete + partial > applicable + tolerance
  )
    return invalid();
  if (applicable === 0)
    return {
      applicable,
      complete,
      partial,
      observed,
      value: null,
      coverage: "unavailable",
      lowerBound: false,
    };
  if (Math.abs(complete - applicable) <= tolerance)
    return {
      applicable,
      complete,
      partial,
      observed,
      value: observed,
      coverage: "complete",
      lowerBound: false,
    };
  if (complete + partial === 0)
    return {
      applicable,
      complete,
      partial,
      observed,
      value: null,
      coverage: "unavailable",
      lowerBound: false,
    };
  return {
    applicable,
    complete,
    partial,
    observed,
    value: observed,
    coverage: "partial",
    lowerBound: true,
  };
}
function aggregate(sourceRow: Record<string, unknown>): InvocationAggregate {
  const counts = countMetrics(sourceRow);
  const empty = counts.retainedSamples === 0;
  const handlerWeight = sum(sourceRow, "handlerWeight", empty);
  const percentile = (key: "p50" | "p95" | "p99"): number | null => {
    if (empty || handlerWeight === 0) return number(sourceRow[key], true);
    return number(sourceRow[key]) as number;
  };
  const weighted = Object.fromEntries(
    COVERED_METRICS.map((key) => [key, weightedMetric(sourceRow, key, empty)]),
  ) as InvocationWeightedMetrics;
  return {
    ...counts,
    handlerWeight,
    p50: percentile("p50"),
    p95: percentile("p95"),
    p99: percentile("p99"),
    invocationWallMs: sum(sourceRow, "invocationWallMs", empty),
    workerD1Statements: sum(sourceRow, "workerD1Statements", empty),
    doFetchCalls: sum(sourceRow, "doFetchCalls", empty),
    weighted,
  };
}
function countRowOrNull(
  resultRows: Record<string, unknown>[],
): InvocationCountMetrics | null {
  return resultRows.length ? countMetrics(resultRows[0]!) : null;
}
function safeCoverage(value: unknown): V2Coverage | null {
  return value === "complete" || value === "partial" || value === "unavailable"
    ? value
    : null;
}
function safeDetails(value: unknown): InvocationSafeDetails | null {
  if (typeof value !== "string" || utf8.encode(value).byteLength > 4096)
    return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed))
    return null;
  const input = parsed as Record<string, unknown>;
  if (input.v !== 2) return null;
  const phases: InvocationSafeDetails["phases"] = [];
  if (Array.isArray(input.phases)) {
    for (const item of input.phases.slice(0, 6)) {
      if (typeof item !== "object" || item === null || Array.isArray(item))
        continue;
      const phase = item as Record<string, unknown>;
      if (
        typeof phase.id !== "string" ||
        !SAFE_PHASES.has(phase.id as InvocationSafePhase)
      )
        continue;
      try {
        phases.push({
          id: phase.id as InvocationSafePhase,
          count: integer(phase.count),
          wallMs: number(phase.wallMs) as number,
        });
      } catch {
        /* omit malformed detail */
      }
    }
  }
  const queries: InvocationSafeDetails["queries"] = [];
  if (Array.isArray(input.queries)) {
    for (const item of input.queries.slice(0, 6)) {
      if (typeof item !== "object" || item === null || Array.isArray(item))
        continue;
      const query = item as Record<string, unknown>;
      const id = query.id;
      const registryEntry =
        typeof id === "string" ? QUERY_REGISTRY.get(id) : undefined;
      if (id !== UNKNOWN_QUERY_ID && !registryEntry) continue;
      if (
        typeof query.variant !== "string" ||
        !QUERY_VARIANTS.includes(query.variant as QueryVariant)
      )
        continue;
      const cov =
        typeof query.coverage === "object" &&
        query.coverage !== null &&
        !Array.isArray(query.coverage)
          ? (query.coverage as Record<string, unknown>)
          : {};
      try {
        queries.push({
          id: id as string,
          variant: query.variant as QueryVariant,
          granularity: registryEntry?.granularity ?? "unknown",
          count: integer(query.count),
          apiWallMs: number(query.apiWallMs) as number,
          sqlEngineMs: number(query.sqlEngineMs) as number,
          rowsRead: number(query.rowsRead) as number,
          rowsWritten: number(query.rowsWritten) as number,
          attempts: number(query.attempts) as number,
          failed: typeof query.failed === "boolean" ? query.failed : false,
          coverage: {
            api: safeCoverage(cov.api) ?? "unavailable",
            engine: safeCoverage(cov.engine) ?? "unavailable",
            rowsRead: safeCoverage(cov.rowsRead) ?? "unavailable",
            rowsWritten: safeCoverage(cov.rowsWritten) ?? "unavailable",
            attempts: safeCoverage(cov.attempts) ?? "unavailable",
          },
        });
      } catch {
        /* omit malformed detail */
      }
    }
  }
  let coverage: InvocationSafeDetails["coverage"] = null;
  if (
    typeof input.coverage === "object" &&
    input.coverage !== null &&
    !Array.isArray(input.coverage)
  ) {
    const item = input.coverage as Record<string, unknown>;
    if (
      (item.query === "complete" || item.query === "partial") &&
      ["none", "partial", "sql-template", "provider-family", "mixed"].includes(
        String(item.queryGranularity),
      )
    ) {
      try {
        coverage = {
          query: item.query,
          queryGranularity: item.queryGranularity as NonNullable<
            InvocationSafeDetails["coverage"]
          >["queryGranularity"],
          templateStatements: integer(item.templateStatements),
          familyStatements: integer(item.familyStatements),
        };
      } catch {
        /* omit malformed detail */
      }
    }
  }
  let truncation: InvocationSafeDetails["truncation"] = null;
  if (
    typeof input.truncation === "object" &&
    input.truncation !== null &&
    !Array.isArray(input.truncation)
  ) {
    const item = input.truncation as Record<string, unknown>;
    try {
      truncation = {
        queriesDropped: integer(item.queriesDropped),
        phasesDropped: integer(item.phasesDropped),
        signalsDropped: integer(item.signalsDropped),
      };
    } catch {
      /* omit malformed detail */
    }
  }
  const output: InvocationSafeDetails = {
    version: 2,
    phases,
    queries,
    coverage,
    truncation,
  };
  return utf8.encode(JSON.stringify(output)).byteLength <= 4096 ? output : null;
}
function sample(sourceRow: Record<string, unknown>): InvocationSample {
  const dims = dimensions(sourceRow);
  const timestampSeconds = integer(sourceRow.timestampSeconds);
  const flags = integer(sourceRow.flags);
  const resultClass = sourceRow.resultClass;
  if (
    timestampSeconds < 0 ||
    typeof resultClass !== "string" ||
    !RESULT_CLASSES.has(resultClass)
  )
    return invalid();
  const safeId = (value: unknown): string | null => {
    if (value === "") return null;
    if (
      typeof value !== "string" ||
      (value !== UNKNOWN_QUERY_ID && !QUERY_REGISTRY.has(value))
    )
      return invalid();
    return value;
  };
  const hasHotQuery = v2BooleanFlag(flags, "hotQueryPresent");
  const hasScanQuery = v2BooleanFlag(flags, "scanQueryPresent");
  const hasFilter = v2BooleanFlag(flags, "filterPresent");
  const hotQueryId = hasHotQuery ? safeId(sourceRow.hotQueryId) : null;
  const scanQueryId = hasScanQuery ? safeId(sourceRow.scanQueryId) : null;
  let variant: QueryVariant | null = null;
  if (hasHotQuery && sourceRow.variant !== "") {
    if (
      typeof sourceRow.variant !== "string" ||
      !QUERY_VARIANTS.includes(sourceRow.variant as QueryVariant)
    )
      return invalid();
    variant = sourceRow.variant as QueryVariant;
  }
  const filterShape = hasFilter
    ? optionalSafeString(sourceRow.filterShape, SAFE_SHAPE, 160)
    : null;
  const filterFamily = hasFilter
    ? optionalSafeString(
        sourceRow.filterFamily,
        /^(?:none|basic|boolean|related-entity|advanced-json|mixed|unknown)$/,
        32,
      )
    : null;
  const dominantPhase = optionalSafeString(
    sourceRow.dominantPhase,
    /^[a-z0-9_.]+$/,
    64,
  );
  if (
    dominantPhase !== null &&
    !SAFE_PHASES.has(dominantPhase as InvocationSafePhase)
  )
    return invalid();
  const sampleInterval = number(sourceRow.sampleInterval) as number;
  if (sampleInterval < 1) return invalid();
  const httpStatus = v2BooleanFlag(flags, "httpStatusPresent")
    ? integer(sourceRow.httpStatus)
    : null;
  if (httpStatus !== null && (httpStatus < 100 || httpStatus > 599))
    return invalid();
  const handlerWallMs = v2BooleanFlag(flags, "handlerPresent")
    ? number(sourceRow.handlerWallMs)
    : null;
  return {
    ...dims,
    timestampSeconds,
    resultClass: resultClass as InvocationSample["resultClass"],
    category: optionalSafeString(
      sourceRow.category,
      /^(?:database|application|infrastructure|unknown)$/,
      32,
    ),
    code: optionalSafeString(sourceRow.code, /^[a-z0-9_]{1,64}$/, 64),
    operation: optionalSafeString(
      sourceRow.operation,
      /^[a-z0-9_.]{1,64}$/,
      64,
    ),
    hotQueryId,
    variant,
    filterShape,
    scanQueryId,
    dominantPhase: dominantPhase as InvocationSafePhase | null,
    details: safeDetails(sourceRow.details),
    filterFamily,
    sampleInterval,
    invocationWallMs: number(sourceRow.invocationWallMs) as number,
    handlerWallMs: handlerWallMs as number | null,
    httpStatus,
    flags,
    detailsTruncated: v2BooleanFlag(flags, "detailsTruncated"),
  };
}
function hotspot(
  sourceRow: Record<string, unknown>,
  kind: HotspotKind,
): InvocationHotspot {
  const dims = dimensions(sourceRow);
  const queryId = sourceRow.queryId;
  if (
    typeof queryId !== "string" ||
    (queryId !== UNKNOWN_QUERY_ID && !QUERY_REGISTRY.has(queryId))
  )
    return invalid();
  const entry = QUERY_REGISTRY.get(queryId);
  const variant =
    kind === "scan"
      ? null
      : (optionalSafeString(
          sourceRow.variant,
          /^[a-z0-9.]+$/,
          32,
        ) as QueryVariant | null);
  if (variant !== null && !QUERY_VARIANTS.includes(variant)) return invalid();
  const filterShape =
    kind === "scan"
      ? null
      : optionalSafeString(sourceRow.filterShape, SAFE_SHAPE, 160);
  const filterFamily =
    kind === "scan"
      ? null
      : optionalSafeString(
          sourceRow.filterFamily,
          /^(?:none|basic|boolean|related-entity|advanced-json|mixed|unknown)$/,
          32,
        );
  return {
    ...dims,
    queryId,
    variant,
    filterShape,
    filterFamily,
    granularity: entry?.granularity ?? "unknown",
    owner: entry?.ownerModule ?? null,
    ...countMetrics(sourceRow),
    weightedValue: number(sourceRow.weightedValue) as number,
  };
}
function hasData(items: readonly { retainedSamples: number }[]): boolean {
  return items.some((item) => item.retainedSamples > 0);
}

export function normalizeInvocationView(
  view: "overview",
  results: InvocationMetricsResults,
): InvocationOverviewResult;
export function normalizeInvocationView(
  view: "routes",
  results: InvocationMetricsResults,
): InvocationRoutesResult;
export function normalizeInvocationView(
  view: "hotspots",
  results: InvocationMetricsResults,
): InvocationHotspotsResult;
export function normalizeInvocationView(
  view: "errors",
  results: InvocationMetricsResults,
): InvocationErrorsResult;
export function normalizeInvocationView(
  view: "samples",
  results: InvocationMetricsResults,
): InvocationSamplesResult;
export function normalizeInvocationView(
  view: InvocationView,
  results: InvocationMetricsResults,
): InvocationMetricsResult;
export function normalizeInvocationView(
  view: InvocationView,
  results: InvocationMetricsResults,
): InvocationMetricsResult {
  switch (view) {
    case "overview": {
      const summaryRows = rows(results, "summary");
      const trend = rows(results, "trend").map((item) => {
        const bucket = integer(item.bucket);
        return { ...aggregate(item), bucket };
      });
      const summary = summaryRows.length ? aggregate(summaryRows[0]!) : null;
      const legacyRows = rows(results, "legacy");
      const legacy = legacyRows.length
        ? { retainedSamples: integer(legacyRows[0]!.retainedSamples) }
        : null;
      const data = { summary, trend, legacy };
      const hasV2Data = (summary?.retainedSamples ?? 0) > 0 || hasData(trend);
      const status: InvocationMetricsStatus = hasV2Data
        ? "ready"
        : (legacy?.retainedSamples ?? 0) > 0
          ? "insufficient_coverage"
          : "no_data";
      return { view, status, data };
    }
    case "routes": {
      const routes = rows(results, "routes").map((item) => ({
        ...dimensions(item),
        ...aggregate(item),
      }));
      return {
        view,
        status: routes.length ? "ready" : "no_data",
        data: { routes },
      };
    }
    case "errors": {
      const errors = rows(results, "errors").map((item) => {
        const dims = dimensions(item);
        const resultClass = item.resultClass;
        if (typeof resultClass !== "string" || !RESULT_CLASSES.has(resultClass))
          return invalid();
        const counts = countMetrics(item);
        return {
          ...dims,
          ...counts,
          resultClass: resultClass as InvocationErrorAggregate["resultClass"],
          category: optionalSafeString(
            item.category,
            /^(?:database|application|infrastructure|unknown)$/,
            32,
          ),
          code: optionalSafeString(item.code, /^[a-z0-9_]{1,64}$/, 64),
          operation: optionalSafeString(
            item.operation,
            /^[a-z0-9_.]{1,64}$/,
            64,
          ),
        };
      });
      return {
        view,
        status: errors.length ? "ready" : "no_data",
        data: { errors },
      };
    }
    case "hotspots": {
      const summary = countRowOrNull(rows(results, "summary"));
      const hotspots = Object.fromEntries(
        HOTSPOT_KINDS.map((kind) => [
          kind,
          rows(results, kind).map((item) => hotspot(item, kind)),
        ]),
      ) as Record<HotspotKind, InvocationHotspot[]>;
      const anyHotspot = HOTSPOT_KINDS.some(
        (kind) => hotspots[kind].length > 0,
      );
      return {
        view,
        status: anyHotspot ? "ready" : "no_data",
        data: { summary, hotspots },
      };
    }
    case "samples": {
      const samples = rows(results, "samples").map(sample);
      return {
        view,
        status: samples.length ? "ready" : "no_data",
        data: { samples },
      };
    }
  }
}
