import type {
  InvocationAggregate,
  InvocationHotspot,
  InvocationSample,
  InvocationWeightedMetric,
} from "@/lib/edge/admin/observability/invocation-metrics-model";

const DATASET = "insightflare_invocation_metrics";
type Params = Record<string, string | number>;
const SOURCES = ["worker", "do", "all"] as const;
const VIEWS = ["overview", "routes", "hotspots", "errors", "samples"] as const;

const metric = (
  value: number | null,
  mode: "complete" | "partial" | "unavailable" = "complete",
): InvocationWeightedMetric => ({
  applicable: 100,
  complete: mode === "complete" ? 100 : mode === "partial" ? 60 : 0,
  partial: mode === "partial" ? 40 : 0,
  observed: value ?? 0,
  value: mode === "unavailable" ? null : value,
  coverage: mode,
  lowerBound: mode === "partial",
});

function aggregate(
  seed: number,
  scenario = "normal",
  source: "worker" | "do" = "worker",
): InvocationAggregate {
  const coverage = scenario === "partial" ? "partial" : "complete";
  const zero = scenario === "zero";
  const count = source === "worker" ? 220 : 75;
  return {
    retainedSamples: count,
    estimatedInvocations: count * (source === "worker" ? 9 : 3),
    maxSampleInterval: source === "worker" ? 9 : 3,
    handlerWeight: source === "worker" ? count * 9 : 0,
    p50: source === "worker" ? (zero ? 0 : 24 + seed) : null,
    p95: source === "worker" ? (zero ? 0 : 125 + seed * 4) : null,
    p99: source === "worker" ? (zero ? 0 : 390 + seed * 6) : null,
    invocationWallMs: zero ? 0 : 18000 + seed * 175,
    workerD1Statements: source === "worker" ? count * 3 : 0,
    doFetchCalls: source === "worker" ? count : 0,
    weighted: {
      d1RowsRead: metric(
        source === "worker" ? (zero ? 0 : 10400 + seed * 135) : null,
        source === "worker" ? coverage : "unavailable",
      ),
      d1SqlEngineMs: metric(
        source === "worker" ? (zero ? 0 : 2900 + seed * 25) : null,
        source === "worker" ? coverage : "unavailable",
      ),
      d1ApiWallMs: metric(
        source === "worker" ? (zero ? 0 : 5500 + seed * 20) : null,
        source === "worker" ? coverage : "unavailable",
      ),
      doFetchWallMs: metric(
        source === "worker" ? (zero ? 0 : 1600 + seed * 10) : null,
        source === "worker" ? coverage : "unavailable",
      ),
      doSqlRowsRead: metric(
        source === "do" ? (zero ? 0 : 4300 + seed * 100) : null,
        source === "do" ? coverage : "unavailable",
      ),
    },
  };
}

function hotspot(
  queryId: string,
  routeKey: string,
  value: number,
  source: "worker" | "do" = "worker",
): InvocationHotspot {
  return {
    source,
    trigger: "request",
    routeKey,
    appVersion: "0.7.1+abcdef123456",
    queryId,
    variant: "raw.filtered",
    filterShape: "basic.cx.1.1.o1",
    filterFamily: "basic",
    granularity: "sql-template",
    owner: "src/lib/edge/analytics/providers/d1/internal/overview.ts",
    retainedSamples: 34,
    estimatedInvocations: 306,
    maxSampleInterval: 9,
    weightedValue: value,
  };
}

/** Fixtures represent sampled invocation metrics, never event age or transport latency. */
export function generateDemoInvocationMetrics(params: Params) {
  const now = Date.now();
  const view =
    VIEWS.find((item) => item === String(params.view || "overview")) ??
    "overview";
  const source =
    SOURCES.find((item) => item === String(params.source || "all")) ?? "all";
  const scenario = String(params.scenario || "normal");
  const from = Number(params.from || now - 86_400_000);
  const to = Number(params.to || now);
  const interval = String(params.interval || "hour");
  const timeZone = String(params.timeZone || "UTC");
  const limit = Math.max(1, Math.min(Number(params.limit || 50), 100));
  const routeKey = String(params.routeKey || "");
  const workerRoutes = [
    "api:/collect",
    "api:/v1/analytics/overview",
    "api:/v1/analytics/trend",
    "page.other",
  ];
  const doRoutes = ["do.ingest", "do.flush", "do.alarm"];
  const chosenRoutes =
    source === "do"
      ? doRoutes
      : source === "worker"
        ? workerRoutes
        : [...workerRoutes, ...doRoutes];
  const routes = chosenRoutes
    .filter((route) => !routeKey || route === routeKey)
    .map((route, index) => ({
      ...aggregate(
        index + 1,
        scenario,
        route.startsWith("do.") ? ("do" as const) : ("worker" as const),
      ),
      source: route.startsWith("do.") ? ("do" as const) : ("worker" as const),
      routeKey: route,
      trigger: route === "do.alarm" ? ("alarm" as const) : ("request" as const),
      appVersion: "0.7.1+abcdef123456",
    }));
  const status =
    scenario === "no_data"
      ? "no_data"
      : scenario === "disabled"
        ? "disabled"
        : scenario === "query_failed"
          ? "query_failed"
          : scenario === "reader_not_configured"
            ? "reader_not_configured"
            : scenario === "writer_not_bound"
              ? "writer_not_bound"
              : scenario === "partial"
                ? "insufficient_coverage"
                : "ready";
  const worker = aggregate(1, scenario);
  const doAggregate = aggregate(1, scenario, "do");
  const total: InvocationAggregate = source === "do" ? doAggregate : worker;
  const summary = {
    ...total,
    retainedSamples:
      source === "all"
        ? worker.retainedSamples + doAggregate.retainedSamples
        : total.retainedSamples,
    estimatedInvocations:
      source === "all"
        ? worker.estimatedInvocations + doAggregate.estimatedInvocations
        : total.estimatedInvocations,
    invocationWallMs:
      source === "all"
        ? worker.invocationWallMs + doAggregate.invocationWallMs
        : total.invocationWallMs,
    weighted:
      source === "all"
        ? {
            ...worker.weighted,
            doSqlRowsRead: doAggregate.weighted.doSqlRowsRead,
          }
        : total.weighted,
  };
  const timeBucket = Math.floor(
    to / (interval === "day" ? 86_400_000 : 3_600_000),
  );
  const trend = Array.from({ length: 12 }, (_, index) => ({
    ...aggregate(index % 5, scenario, source === "do" ? "do" : "worker"),
    bucket: (timeBucket - 11 + index) * (interval === "day" ? 86_400 : 3600),
  }));
  const allHot: InvocationHotspot[] =
    source === "do"
      ? []
      : [
          hotspot(
            "analytics.overview.raw.summary",
            "api:/v1/analytics/overview",
            3470,
          ),
          hotspot(
            "analytics.trend.raw.series",
            "api:/v1/analytics/trend",
            1800,
          ),
        ].filter((item) => !routeKey || item.routeKey === routeKey);
  // Batch without a comparable per-query wall must not be assigned an API-hot rank.
  const hot = scenario === "batch" ? [] : allHot;
  const rankings = {
    "api-hot": hot,
    "sql-engine-fallback":
      scenario === "batch"
        ? []
        : allHot.map((item) => ({
            ...item,
            weightedValue: item.weightedValue * 0.6,
          })),
    scan: allHot.map((item) => ({
      ...item,
      filterShape: null,
      filterFamily: null,
      variant: null,
      weightedValue: item.weightedValue * 4,
    })),
  };
  const errors = [
    {
      source: "worker",
      trigger: "request",
      routeKey: "api:/collect",
      appVersion: "0.7.1+abcdef123456",
      resultClass: "failure",
      category: "database",
      code: "d1_operation_failed",
      operation: "d1.all",
      retainedSamples: 3,
      estimatedInvocations: 27,
      maxSampleInterval: 9,
    },
  ];
  const samplePool: InvocationSample[] = [
    {
      source: "do",
      trigger: "alarm",
      routeKey: "do.alarm",
      appVersion: "0.7.1+abcdef123456",
      timestampSeconds: Math.floor(to / 1000),
      resultClass: "ok",
      category: null,
      code: null,
      operation: null,
      hotQueryId: null,
      variant: null,
      filterShape: null,
      scanQueryId: null,
      dominantPhase: "do.alarm.reconcile",
      details: null,
      filterFamily: null,
      sampleInterval: 3,
      invocationWallMs: 35,
      handlerWallMs: null,
      httpStatus: null,
      flags: 0,
      detailsTruncated: false,
    },
    {
      source: "worker",
      trigger: "request",
      routeKey: "api:/collect",
      appVersion: "0.7.1+abcdef123456",
      timestampSeconds: Math.floor(to / 1000) - 12,
      resultClass: "ok",
      category: null,
      code: null,
      operation: null,
      hotQueryId: null,
      variant: null,
      filterShape: null,
      scanQueryId: null,
      dominantPhase: "route.handler",
      details: null,
      filterFamily: null,
      sampleInterval: 9,
      invocationWallMs: 49,
      handlerWallMs: scenario === "zero" ? 0 : 38,
      httpStatus: 200,
      flags: 3,
      detailsTruncated: false,
    },
  ];
  const samples = samplePool.filter(
    (item) => source === "all" || item.source === source,
  );
  const data =
    view === "overview"
      ? { summary, trend, legacy: { retainedSamples: 9 } }
      : view === "routes"
        ? { routes }
        : view === "hotspots"
          ? {
              summary: {
                retainedSamples: summary.retainedSamples,
                estimatedInvocations: summary.estimatedInvocations,
                maxSampleInterval: summary.maxSampleInterval,
              },
              hotspots: rankings,
            }
          : view === "errors"
            ? { errors: source === "do" ? [] : errors }
            : { samples: samples.slice(0, limit) };
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
