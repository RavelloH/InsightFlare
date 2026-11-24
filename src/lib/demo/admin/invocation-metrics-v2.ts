import type {
  InvocationAggregate,
  InvocationErrorAggregate,
  InvocationHotspot,
  InvocationRouteAggregate,
  InvocationSafeDetails,
  InvocationSafePhase,
  InvocationSample,
  InvocationWeightedMetric,
  InvocationWeightedMetrics,
} from "@/lib/edge/admin/observability/invocation-metrics-model";
import type { QueryVariant } from "@/lib/edge/analytics-engine/query-registry";

const DATASET = "insightflare_invocation_metrics";
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const VERSION = "0.7.1+abcdef123456";
const PREVIOUS_VERSION = "0.7.0+0f1e2d3c4b5a";

type Params = Record<string, string | number>;
type Source = "worker" | "do";
type Trigger = "request" | "alarm" | "scheduled" | "websocket";
type Granularity = InvocationHotspot["granularity"];

const SOURCES = ["worker", "do", "all"] as const;
const VIEWS = ["overview", "routes", "hotspots", "errors", "samples"] as const;
const STATUS_SCENARIOS = new Set([
  "no_data",
  "disabled",
  "query_failed",
  "reader_not_configured",
  "writer_not_bound",
]);

interface DemoQuery {
  id: string;
  variant: QueryVariant;
  filterShape: string | null;
  filterFamily: string | null;
  granularity: Granularity;
  owner: string;
  /** Per-call D1 wait, SQL engine time and rows read. */
  apiMs: number;
  engineMs: number;
  rows: number;
}

interface DemoRoute {
  source: Source;
  trigger: Trigger;
  routeKey: string;
  /** Invocations per hour at average load. */
  perHour: number;
  p50: number;
  p95: number;
  p99: number;
  statements: number;
  doCalls: number;
  doFetchMs: number;
  doSqlRows: number;
  phases: ReadonlyArray<[InvocationSafePhase, number]>;
  queries: readonly DemoQuery[];
  /** Share of invocations that run on the previous deployment. */
  previousShare: number;
}

const OVERVIEW_OWNER =
  "src/lib/edge/analytics/providers/d1/internal/overview.ts";
const INGEST_OWNER = "src/lib/edge/ingest/custom-event-flush.ts";

const Q = {
  overviewSummary: {
    id: "analytics.overview.raw.summary",
    variant: "raw.filtered",
    filterShape: "basic.cx.1.1.o1",
    filterFamily: "basic",
    granularity: "sql-template",
    owner: OVERVIEW_OWNER,
    apiMs: 46,
    engineMs: 21,
    rows: 600,
  },
  overviewLatest: {
    id: "analytics.overview.raw.latest_activity",
    variant: "raw.unfiltered",
    filterShape: "none.x.0.0.o0",
    filterFamily: "none",
    granularity: "sql-template",
    owner: OVERVIEW_OWNER,
    apiMs: 12,
    engineMs: 3,
    rows: 27,
  },
  trendSeries: {
    id: "analytics.trend.raw.series",
    variant: "raw.filtered",
    filterShape: "basic.cx.1.1.o1",
    filterFamily: "basic",
    granularity: "sql-template",
    owner: OVERVIEW_OWNER,
    apiMs: 38,
    engineMs: 17,
    rows: 487,
  },
  rollupHourly: {
    id: "analytics.rollup.hourly_rows",
    variant: "rollup",
    filterShape: null,
    filterFamily: null,
    granularity: "sql-template",
    owner: "src/lib/edge/analytics/providers/d1/internal/rollup.ts",
    apiMs: 14,
    engineMs: 4,
    rows: 90,
  },
  dimension: {
    id: "analytics.dimension",
    variant: "raw.filtered",
    filterShape: "related-entity.ca.2.1.o2",
    filterFamily: "related-entity",
    granularity: "provider-family",
    owner: "src/lib/edge/analytics/providers/d1/operations/site-breakdown.ts",
    apiMs: 64,
    engineMs: 33,
    rows: 1200,
  },
  performance: {
    id: "analytics.performance",
    variant: "raw.unfiltered",
    filterShape: "none.x.0.0.o0",
    filterFamily: "none",
    granularity: "provider-family",
    owner: "src/lib/edge/analytics/providers/d1/operations/site-performance.ts",
    apiMs: 29,
    engineMs: 11,
    rows: 262,
  },
  apiKey: {
    id: "auth.api_keys.lookup_by_prefix",
    variant: "raw.unfiltered",
    filterShape: null,
    filterFamily: null,
    granularity: "sql-template",
    owner: "src/lib/edge/auth/api-key-store.ts",
    apiMs: 6,
    engineMs: 0.4,
    rows: 1,
  },
  siteLookup: {
    id: "ingest.site_identities.lookup",
    variant: "raw.unfiltered",
    filterShape: null,
    filterFamily: null,
    granularity: "sql-template",
    owner: "src/lib/edge/ingest/flush-types.ts",
    apiMs: 5,
    engineMs: 0.3,
    rows: 1,
  },
  flushVisits: {
    id: "ingest.flush.visits",
    variant: "batch",
    filterShape: null,
    filterFamily: null,
    granularity: "provider-family",
    owner: "src/lib/edge/ingest/flush.ts",
    apiMs: 31,
    engineMs: 9,
    rows: 17,
  },
  pathUpsert: {
    id: "ingest.dictionary.path.upsert",
    variant: "raw.unfiltered",
    filterShape: null,
    filterFamily: null,
    granularity: "sql-template",
    owner: INGEST_OWNER,
    apiMs: 8,
    engineMs: 1.1,
    rows: 12,
  },
  flushEvents: {
    id: "ingest.flush.custom_events",
    variant: "batch",
    filterShape: null,
    filterFamily: null,
    granularity: "provider-family",
    owner: INGEST_OWNER,
    apiMs: 18,
    engineMs: 5,
    rows: 60,
  },
} satisfies Record<string, DemoQuery>;

const ROUTES: readonly DemoRoute[] = [
  {
    source: "worker",
    trigger: "request",
    routeKey: "api:/collect",
    perHour: 1350,
    p50: 7,
    p95: 24,
    p99: 61,
    statements: 0.2,
    doCalls: 1,
    doFetchMs: 4,
    doSqlRows: 0,
    phases: [
      ["route.handler", 6],
      ["do.fetch", 4],
      ["d1.first", 1.5],
    ],
    queries: [Q.siteLookup],
    previousShare: 0.04,
  },
  {
    source: "worker",
    trigger: "request",
    routeKey: "api:/v1/analytics/overview",
    perHour: 105,
    p50: 96,
    p95: 340,
    p99: 780,
    statements: 6,
    doCalls: 0,
    doFetchMs: 0,
    doSqlRows: 0,
    phases: [
      ["route.handler", 118],
      ["d1.batch", 74],
      ["d1.all", 41],
      ["d1.first", 9],
    ],
    queries: [Q.overviewSummary, Q.overviewLatest, Q.rollupHourly],
    previousShare: 0.08,
  },
  {
    source: "worker",
    trigger: "request",
    routeKey: "api:/v1/analytics/trend",
    perHour: 95,
    p50: 72,
    p95: 260,
    p99: 590,
    statements: 3,
    doCalls: 0,
    doFetchMs: 0,
    doSqlRows: 0,
    phases: [
      ["route.handler", 86],
      ["d1.all", 52],
    ],
    queries: [Q.trendSeries, Q.rollupHourly],
    previousShare: 0.08,
  },
  {
    source: "worker",
    trigger: "request",
    routeKey: "api:/v1/analytics/dimension",
    perHour: 152,
    p50: 81,
    p95: 410,
    p99: 940,
    statements: 2,
    doCalls: 0,
    doFetchMs: 0,
    doSqlRows: 0,
    phases: [
      ["route.handler", 94],
      ["d1.all", 70],
    ],
    queries: [Q.dimension],
    previousShare: 0.06,
  },
  {
    source: "worker",
    trigger: "request",
    routeKey: "api:/v1/analytics/performance",
    perHour: 35,
    p50: 58,
    p95: 190,
    p99: 420,
    statements: 2,
    doCalls: 0,
    doFetchMs: 0,
    doSqlRows: 0,
    phases: [
      ["route.handler", 64],
      ["d1.all", 33],
    ],
    queries: [Q.performance],
    previousShare: 0.05,
  },
  {
    source: "worker",
    trigger: "request",
    routeKey: "api:/v1/realtime/snapshot",
    perHour: 65,
    p50: 19,
    p95: 64,
    p99: 140,
    statements: 0,
    doCalls: 1,
    doFetchMs: 14,
    doSqlRows: 0,
    phases: [
      ["route.handler", 21],
      ["do.fetch", 15],
    ],
    queries: [],
    previousShare: 0.03,
  },
  {
    source: "worker",
    trigger: "request",
    routeKey: "page.other",
    perHour: 225,
    p50: 32,
    p95: 118,
    p99: 260,
    statements: 1,
    doCalls: 0,
    doFetchMs: 0,
    doSqlRows: 0,
    phases: [
      ["page.handler", 30],
      ["page.middleware", 6],
      ["d1.first", 5],
    ],
    queries: [Q.apiKey],
    previousShare: 0.05,
  },
  {
    source: "worker",
    trigger: "scheduled",
    routeKey: "scheduled.tasks",
    perHour: 2,
    p50: 1_850,
    p95: 6_400,
    p99: 7_100,
    statements: 48,
    doCalls: 12,
    doFetchMs: 22,
    doSqlRows: 0,
    phases: [
      ["background.drain", 1_400],
      ["d1.batch", 820],
      ["do.fetch", 260],
    ],
    queries: [Q.rollupHourly],
    previousShare: 0,
  },
  {
    source: "do",
    trigger: "request",
    routeKey: "do.ingest",
    perHour: 1300,
    p50: 3,
    p95: 9,
    p99: 22,
    statements: 0,
    doCalls: 0,
    doFetchMs: 0,
    doSqlRows: 6,
    phases: [
      ["do.fetch.handler", 3],
      ["do.schema_ready", 0.4],
    ],
    queries: [],
    previousShare: 0.04,
  },
  {
    source: "do",
    trigger: "alarm",
    routeKey: "do.alarm",
    perHour: 52,
    p50: 28,
    p95: 96,
    p99: 210,
    statements: 4,
    doCalls: 0,
    doFetchMs: 0,
    doSqlRows: 180,
    phases: [
      ["do.alarm.reconcile", 34],
      ["d1.batch", 26],
      ["do.maintenance", 4],
    ],
    queries: [Q.flushVisits, Q.flushEvents, Q.pathUpsert],
    previousShare: 0.02,
  },
  {
    source: "do",
    trigger: "request",
    routeKey: "do.snapshot",
    perHour: 68,
    p50: 6,
    p95: 21,
    p99: 48,
    statements: 0,
    doCalls: 0,
    doFetchMs: 0,
    doSqlRows: 340,
    phases: [["do.fetch.handler", 7]],
    queries: [],
    previousShare: 0.03,
  },
  {
    source: "do",
    trigger: "websocket",
    routeKey: "do.websocket",
    perHour: 24,
    p50: 4,
    p95: 15,
    p99: 33,
    statements: 0,
    doCalls: 0,
    doFetchMs: 0,
    doSqlRows: 120,
    phases: [["do.websocket.initial_snapshot", 5]],
    queries: [],
    previousShare: 0,
  },
];

const ERRORS: ReadonlyArray<
  Omit<
    InvocationErrorAggregate,
    | "retainedSamples"
    | "estimatedInvocations"
    | "maxSampleInterval"
    | "appVersion"
  > & {
    perHour: number;
  }
> = [
  {
    source: "worker",
    trigger: "request",
    routeKey: "api:/v1/analytics/overview",
    resultClass: "client_error",
    category: "application",
    code: "invalid_filter",
    operation: null,
    perHour: 4.2,
  },
  {
    source: "worker",
    trigger: "request",
    routeKey: "api:/collect",
    resultClass: "failure",
    category: "infrastructure",
    code: "do_fetch_timeout",
    operation: "do.fetch",
    perHour: 2.6,
  },
  {
    source: "worker",
    trigger: "request",
    routeKey: "api:/v1/analytics/dimension",
    resultClass: "failure",
    category: "database",
    code: "d1_operation_failed",
    operation: "d1.all",
    perHour: 1.1,
  },
  {
    source: "do",
    trigger: "alarm",
    routeKey: "do.alarm",
    resultClass: "failure",
    category: "database",
    code: "d1_batch_failed",
    operation: "d1.batch",
    perHour: 0.4,
  },
  {
    source: "worker",
    trigger: "request",
    routeKey: "api:/v1/analytics/trend",
    resultClass: "canceled",
    category: "unknown",
    code: "client_disconnected",
    operation: null,
    perHour: 0.9,
  },
  {
    source: "worker",
    trigger: "request",
    routeKey: "api:/v1/analytics/overview",
    resultClass: "client_error",
    category: "application",
    code: "range_too_large",
    operation: null,
    perHour: 0.5,
  },
];

/** Deterministic hash → [0, 1). */
function noise(...parts: Array<string | number>): number {
  let hash = 2166136261;
  for (const char of parts.join("|")) {
    hash ^= char.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return ((hash >>> 0) % 10_000) / 10_000;
}

/** Daily traffic curve: quiet at night, peaks in the afternoon (UTC). */
function load(timestampMs: number): number {
  const hour = (timestampMs / HOUR) % 24;
  return 0.55 + 0.45 * Math.sin(((hour - 8) / 24) * Math.PI * 2) + 0.25;
}

function sampleInterval(source: Source, perHour: number) {
  if (perHour > 600) return source === "worker" ? 20 : 25;
  if (perHour > 80) return 4;
  return 1;
}

function weightedMetric(
  value: number | null,
  coverage: "complete" | "partial" | "unavailable",
): InvocationWeightedMetric {
  if (coverage === "unavailable" || value === null)
    return {
      applicable: 0,
      complete: 0,
      partial: 0,
      observed: 0,
      value: null,
      coverage: "unavailable",
      lowerBound: false,
    };
  return {
    applicable: 100,
    complete: coverage === "complete" ? 100 : 70,
    partial: coverage === "partial" ? 30 : 0,
    observed: value,
    value,
    coverage,
    lowerBound: coverage === "partial",
  };
}

interface Scenario {
  zero: boolean;
  partial: boolean;
}

function aggregateRoutes(
  routes: ReadonlyArray<{
    route: DemoRoute;
    invocations: number;
    scale: number;
  }>,
  scenario: Scenario,
): InvocationAggregate {
  const coverage = scenario.partial ? "partial" : "complete";
  let invocations = 0;
  let samples = 0;
  let maxInterval = 0;
  let handlerWeight = 0;
  let p50 = 0;
  let p95 = 0;
  let p99 = 0;
  let wall = 0;
  let statements = 0;
  let doCalls = 0;
  let d1Rows = 0;
  let d1Engine = 0;
  let d1Api = 0;
  let doFetch = 0;
  let doRows = 0;
  let hasWorker = false;
  let hasDo = false;
  for (const { route, invocations: count, scale } of routes) {
    const interval = sampleInterval(route.source, route.perHour);
    invocations += count;
    samples += Math.max(count > 0 ? 1 : 0, Math.round(count / interval));
    maxInterval = Math.max(maxInterval, interval);
    wall += count * route.p50 * 1.35 * scale;
    if (route.source === "worker") {
      hasWorker = true;
      handlerWeight += count;
      p50 += count * route.p50 * scale;
      p95 += count * route.p95 * scale;
      p99 += count * route.p99 * scale;
      statements += count * route.statements;
      doCalls += count * route.doCalls;
      doFetch += count * route.doCalls * route.doFetchMs * scale;
    } else {
      hasDo = true;
      doRows += count * route.doSqlRows;
    }
    for (const query of route.queries) {
      d1Rows += count * query.rows * (route.source === "worker" ? 1 : 0.4);
      d1Engine += count * query.engineMs * scale;
      d1Api += count * query.apiMs * scale;
    }
  }
  const zero = scenario.zero;
  const round = (value: number) => (zero ? 0 : Math.round(value));
  const percentile = (total: number) =>
    handlerWeight > 0 ? (zero ? 0 : Math.round(total / handlerWeight)) : null;
  return {
    retainedSamples: samples,
    estimatedInvocations: Math.round(invocations),
    maxSampleInterval: maxInterval || null,
    handlerWeight: Math.round(handlerWeight),
    p50: percentile(p50),
    p95: percentile(p95),
    p99: percentile(p99),
    invocationWallMs: round(wall),
    workerD1Statements: Math.round(statements),
    doFetchCalls: Math.round(doCalls),
    weighted: {
      d1RowsRead: weightedMetric(
        hasWorker ? round(d1Rows) : null,
        hasWorker ? coverage : "unavailable",
      ),
      d1SqlEngineMs: weightedMetric(
        hasWorker ? round(d1Engine) : null,
        hasWorker ? coverage : "unavailable",
      ),
      d1ApiWallMs: weightedMetric(
        hasWorker ? round(d1Api) : null,
        hasWorker ? coverage : "unavailable",
      ),
      doFetchWallMs: weightedMetric(
        hasWorker ? round(doFetch) : null,
        hasWorker ? coverage : "unavailable",
      ),
      doSqlRowsRead: weightedMetric(
        hasDo ? round(doRows) : null,
        hasDo ? coverage : "unavailable",
      ),
    } satisfies InvocationWeightedMetrics,
  };
}

function routeInvocations(route: DemoRoute, from: number, to: number) {
  const hours = Math.max((to - from) / HOUR, 1 / 60);
  const midpoint = from + (to - from) / 2;
  const shape = hours >= 24 ? 1 : load(midpoint);
  return (
    route.perHour *
    hours *
    shape *
    (0.9 + noise(route.routeKey, Math.floor(from / HOUR)) * 0.2)
  );
}

function sampleDetails(
  route: DemoRoute,
  scale: number,
  seed: number,
  failingQuery: string | null,
): InvocationSafeDetails | null {
  if (!route.phases.length && !route.queries.length) return null;
  return {
    version: 2,
    phases: route.phases.map(([id, wallMs]) => ({
      id,
      count:
        id === "d1.first" || id === "d1.all" ? 1 + Math.floor(seed * 3) : 1,
      wallMs: Math.round(wallMs * scale * 10) / 10,
    })),
    queries: route.queries.map((query, index) => {
      const jitter = 0.6 + noise(query.id, seed) * 1.2;
      return {
        id: query.id,
        variant: query.variant,
        granularity: query.granularity,
        count:
          query.variant === "batch"
            ? 1
            : 1 + (index === 0 && seed > 0.7 ? 1 : 0),
        apiWallMs: Math.round(query.apiMs * jitter * scale * 10) / 10,
        sqlEngineMs: Math.round(query.engineMs * jitter * scale * 10) / 10,
        rowsRead: Math.round(query.rows * jitter),
        rowsWritten:
          query.variant === "batch" ? Math.round(query.rows * 0.8) : 0,
        attempts: failingQuery === query.id ? 2 : 1,
        failed: failingQuery === query.id,
        coverage: {
          api: "complete",
          engine: query.variant === "batch" ? "partial" : "complete",
          rowsRead: "complete",
          rowsWritten: "complete",
          attempts: "complete",
        },
      };
    }),
    coverage: {
      query: "complete",
      queryGranularity: route.queries.length ? "sql-template" : "none",
      templateStatements: route.queries.length,
      familyStatements: 0,
    },
    truncation: null,
  };
}

function hottest(route: DemoRoute, kind: "api" | "scan"): DemoQuery | null {
  if (!route.queries.length) return null;
  return [...route.queries].sort((a, b) =>
    kind === "api" ? b.apiMs - a.apiMs : b.rows - a.rows,
  )[0]!;
}

/** Fixtures represent sampled invocation metrics, never event age or transport latency. */
export function generateDemoInvocationMetrics(params: Params) {
  const now = Date.now();
  const view =
    VIEWS.find((item) => item === String(params.view || "overview")) ??
    "overview";
  const source =
    SOURCES.find((item) => item === String(params.source || "all")) ?? "all";
  const scenarioName = String(params.scenario || "normal");
  const scenario: Scenario = {
    zero: scenarioName === "zero",
    partial: scenarioName === "partial",
  };
  const to = Number(params.to || now);
  const from = Number(params.from || to - DAY);
  const span = Math.max(to - from, 60_000);
  const interval = String(
    params.interval || (span <= 2 * DAY ? "hour" : "day"),
  );
  const timeZone = String(params.timeZone || "UTC");
  const limit = Math.max(1, Math.min(Number(params.limit || 50), 100));
  const routeKey = String(params.routeKey || "");
  const appVersion = String(params.appVersion || "");
  const trigger = String(params.trigger || "");
  const resultClass = String(params.resultClass || "");
  const sampleQueryId = String(params.sampleQueryId || "");
  const sampleKind = String(params.sampleKind || "");
  const sampleErrorCode = String(params.sampleErrorCode || "");
  const kindParam = String(params.kind || "");

  const status = STATUS_SCENARIOS.has(scenarioName)
    ? scenarioName
    : scenario.partial
      ? "insufficient_coverage"
      : "ready";

  const routes = ROUTES.filter(
    (route) =>
      (source === "all" || route.source === source) &&
      (!routeKey || route.routeKey === routeKey) &&
      (!trigger || route.trigger === trigger),
  );
  const versionShare = (route: DemoRoute, version: string) =>
    version === PREVIOUS_VERSION
      ? route.previousShare
      : version === VERSION
        ? 1 - route.previousShare
        : version
          ? 0
          : 1;
  const counted = routes
    .map((route) => ({
      route,
      invocations:
        routeInvocations(route, from, to) * versionShare(route, appVersion),
      scale: 1,
    }))
    .filter((item) => item.invocations > 0);

  const bucketMs =
    interval === "minute" ? 60_000 : interval === "day" ? DAY : HOUR;
  const firstBucket = Math.floor(from / bucketMs) * bucketMs;
  const bucketStarts: number[] = [];
  for (let start = firstBucket; start < to; start += bucketMs)
    bucketStarts.push(start);
  // Same shape as the SQL view: newest bucket first, capped by `limit`.
  const trend = bucketStarts
    .slice(-limit)
    .reverse()
    .map((start) => {
      const bucketEnd = Math.max(
        Math.min(start + bucketMs, to),
        start + 60_000,
      );
      const pressure = bucketMs >= DAY ? 1 : load(start);
      const spike = noise("spike", start) > 0.97 ? 1.6 : 1;
      const scale = (0.85 + pressure * 0.2) * spike;
      return {
        ...aggregateRoutes(
          counted.map(({ route }) => ({
            route,
            invocations:
              routeInvocations(route, start, bucketEnd) *
              versionShare(route, appVersion),
            scale,
          })),
          scenario,
        ),
        bucket: Math.floor(start / 1000),
      };
    });

  const routeRows: InvocationRouteAggregate[] = counted
    .flatMap(({ route, invocations }) =>
      [VERSION, PREVIOUS_VERSION]
        .filter((version) => !appVersion || version === appVersion)
        .map((version) => {
          const share = appVersion ? 1 : versionShare(route, version);
          return { route, version, invocations: invocations * share };
        }),
    )
    .filter((item) => item.invocations >= 1)
    .map(({ route, version, invocations }) => ({
      source: route.source,
      trigger: route.trigger,
      routeKey: route.routeKey,
      appVersion: version,
      ...aggregateRoutes(
        [
          {
            route,
            invocations,
            scale: version === PREVIOUS_VERSION ? 1.15 : 1,
          },
        ],
        scenario,
      ),
    }))
    .sort((a, b) => b.estimatedInvocations - a.estimatedInvocations)
    .slice(0, limit);

  const hotspotRows = (kind: "api-hot" | "sql-engine-fallback" | "scan") =>
    counted
      .flatMap(({ route, invocations }) =>
        route.queries.map((query) => ({ route, query, invocations })),
      )
      .filter(({ route, query }) =>
        kind === "scan"
          ? hottest(route, "scan")?.id === query.id
          : hottest(route, "api")?.id === query.id || query.apiMs >= 20,
      )
      .map(({ route, query, invocations }): InvocationHotspot => ({
        source: route.source,
        trigger: route.trigger,
        routeKey: route.routeKey,
        appVersion: appVersion || VERSION,
        queryId: query.id,
        variant: kind === "scan" ? null : query.variant,
        filterShape: kind === "scan" ? null : query.filterShape,
        filterFamily: kind === "scan" ? null : query.filterFamily,
        granularity: query.granularity,
        owner: query.owner,
        retainedSamples: Math.max(
          1,
          Math.round(invocations / sampleInterval(route.source, route.perHour)),
        ),
        estimatedInvocations: Math.round(invocations),
        maxSampleInterval: sampleInterval(route.source, route.perHour),
        weightedValue: Math.round(
          invocations *
            (kind === "api-hot"
              ? query.apiMs
              : kind === "sql-engine-fallback"
                ? query.engineMs
                : query.rows),
        ),
      }))
      .sort((a, b) => b.weightedValue - a.weightedValue)
      .slice(0, limit);
  // Batch without a comparable per-query wall must not be assigned an API-hot rank.
  const batch = scenarioName === "batch";
  const hotspots = {
    "api-hot": batch ? [] : hotspotRows("api-hot"),
    "sql-engine-fallback": batch ? [] : hotspotRows("sql-engine-fallback"),
    scan: hotspotRows("scan"),
  };
  const selectedHotspots =
    kindParam === "api-hot" ||
    kindParam === "sql-engine-fallback" ||
    kindParam === "scan"
      ? { [kindParam]: hotspots[kindParam] }
      : hotspots;

  const hours = Math.max(span / HOUR, 1 / 60);
  const errors: InvocationErrorAggregate[] = ERRORS.filter(
    (item) =>
      (source === "all" || item.source === source) &&
      (!routeKey || item.routeKey === routeKey) &&
      (!trigger || item.trigger === trigger) &&
      (!resultClass || item.resultClass === resultClass),
  )
    .map(({ perHour, ...item }) => {
      const estimated = Math.round(
        perHour * hours * (0.7 + noise(item.code ?? "", from) * 0.6),
      );
      return {
        ...item,
        appVersion: appVersion || VERSION,
        retainedSamples: estimated,
        estimatedInvocations: estimated,
        maxSampleInterval: 1,
      };
    })
    .filter((item) => item.estimatedInvocations > 0)
    .sort((a, b) => b.estimatedInvocations - a.estimatedInvocations)
    .slice(0, limit);

  const sampleSpacing = Math.max(1_000, Math.floor(span / 240));
  const samples: InvocationSample[] = [];
  for (let index = 0; samples.length < limit && index < 400; index++) {
    const seed = noise("sample", index, Math.floor(to / 60_000));
    const pool = counted.length ? counted : [];
    if (!pool.length) break;
    const total = pool.reduce(
      (sum, item) => sum + Math.sqrt(item.invocations),
      0,
    );
    let pick = seed * total;
    const chosen =
      pool.find((item) => (pick -= Math.sqrt(item.invocations)) <= 0) ??
      pool[pool.length - 1]!;
    const route = chosen.route;
    const errorSeed = noise("error", index);
    const routeErrors = ERRORS.filter(
      (item) => item.routeKey === route.routeKey,
    );
    const error =
      routeErrors.length && errorSeed > 0.86 ? routeErrors[0]! : null;
    const result = error?.resultClass ?? "ok";
    if (resultClass && result !== resultClass) continue;
    if (sampleErrorCode && error?.code !== sampleErrorCode) continue;
    const hotQuery = hottest(route, "api");
    const scanQuery = hottest(route, "scan");
    if (
      sampleQueryId &&
      !(
        (sampleKind !== "scan" && hotQuery?.id === sampleQueryId) ||
        ((sampleKind === "scan" || !sampleKind) &&
          scanQuery?.id === sampleQueryId)
      )
    )
      continue;
    const tail =
      seed > 0.97
        ? route.p99 / route.p50
        : seed > 0.85
          ? route.p95 / route.p50
          : 0.6 + seed;
    const scale = scenario.zero ? 0 : tail;
    const handler =
      route.source === "worker"
        ? Math.round(route.p50 * scale * 10) / 10
        : null;
    const wall = Math.round(route.p50 * scale * 1.25 * 10) / 10;
    const dominant =
      [...route.phases].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
    const failing =
      error?.operation?.startsWith("d1.") && hotQuery ? hotQuery.id : null;
    samples.push({
      source: route.source,
      trigger: route.trigger,
      routeKey: route.routeKey,
      appVersion:
        appVersion ||
        (noise("ver", index) < route.previousShare
          ? PREVIOUS_VERSION
          : VERSION),
      timestampSeconds: Math.floor(
        (to - index * sampleSpacing - seed * sampleSpacing) / 1000,
      ),
      resultClass: result,
      category: error?.category ?? null,
      code: error?.code ?? null,
      operation: error?.operation ?? null,
      hotQueryId: hotQuery?.id ?? null,
      variant: hotQuery?.variant ?? null,
      filterShape: hotQuery?.filterShape ?? null,
      scanQueryId: scanQuery?.id ?? null,
      dominantPhase: dominant,
      details: sampleDetails(route, scale, seed, failing),
      filterFamily: hotQuery?.filterFamily ?? null,
      sampleInterval: sampleInterval(route.source, route.perHour),
      invocationWallMs: wall,
      handlerWallMs: handler,
      httpStatus:
        route.trigger !== "request"
          ? null
          : result === "failure"
            ? 500
            : result === "client_error"
              ? 400
              : result === "canceled"
                ? 499
                : 200,
      flags: 3,
      detailsTruncated: false,
    });
  }
  samples.sort((a, b) => b.timestampSeconds - a.timestampSeconds);

  const summary = aggregateRoutes(counted, scenario);
  const data =
    view === "overview"
      ? { summary, trend, legacy: null }
      : view === "routes"
        ? { routes: routeRows }
        : view === "hotspots"
          ? {
              summary: {
                retainedSamples: summary.retainedSamples,
                estimatedInvocations: summary.estimatedInvocations,
                maxSampleInterval: summary.maxSampleInterval,
              },
              hotspots: selectedHotspots,
            }
          : view === "errors"
            ? { errors }
            : { samples };
  return {
    dataset: DATASET,
    schemaVersion: 2,
    view,
    status,
    window: {
      from,
      to,
      effectiveFrom: Math.ceil(from / 1000) * 1000,
      effectiveTo: Math.ceil(to / 1000) * 1000,
    },
    interval,
    timeZone,
    limit,
    resultLimitsReached: [],
    sampling: {
      aggregatesWeighted: true,
      detailsAreRetainedSamples: true,
      invocationIsNotExternalRequest: true,
    },
    data:
      status === "ready" || status === "insufficient_coverage" ? data : null,
    ...(status === "query_failed"
      ? {
          error: {
            code: "service_unavailable",
            retryable: true,
            retryAfterSeconds: 30,
          },
        }
      : {}),
  };
}
