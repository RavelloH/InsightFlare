import {
  type AnalysisDefinitionReader,
  type ApiV1OverviewAdapterResult,
  resolveApiV1Filter,
} from "@/lib/api-v1/analytics-overview";
import {
  type SiteOverviewComparisonQueryDto,
  SiteOverviewComparisonQueryDtoSchema,
} from "@/lib/api-v1/dto/analytics";
import { createApiV1SiteQueryContext } from "@/lib/api-v1/query-context";
import {
  resolveApiV1ComparisonDatasetTimeRange,
  resolveApiV1PreviousPeriod,
  resolveApiV1TimeRange,
} from "@/lib/api-v1/time-range";
import {
  AnalyticsQueryService,
  type AnalyticsServiceResult,
  type QueryExecutionContext,
} from "@/lib/edge/analytics/service";
import type { ApiKeyPrincipal } from "@/lib/edge/api-key-auth";
import {
  type AnalyticsResult,
  createQueryTime,
  executeOverview,
  filterConditionCount,
  isReportingTimeZone,
  type OverviewMetrics,
  type OverviewReader,
  type QueryTime,
} from "@/lib/edge/query-contract";

export interface ComparisonOverviewData {
  readonly a: OverviewMetrics;
  readonly b: OverviewMetrics;
  readonly delta: Readonly<Record<keyof OverviewMetrics, number | null>>;
  readonly aTime: QueryTime;
  readonly bTime: QueryTime;
}

type ComparisonExecution = ApiV1OverviewAdapterResult<
  AnalyticsServiceResult<AnalyticsResult<ComparisonOverviewData>>
>;

function relativeDelta(a: number, b: number): number | null {
  if (b === 0) return a === 0 ? 0 : null;
  return (a - b) / b;
}

function overviewDelta(
  a: OverviewMetrics,
  b: OverviewMetrics,
): Readonly<Record<keyof OverviewMetrics, number | null>> {
  return {
    views: relativeDelta(a.views, b.views),
    sessions: relativeDelta(a.sessions, b.sessions),
    visitors: relativeDelta(a.visitors, b.visitors),
    bounces: relativeDelta(a.bounces, b.bounces),
    totalDurationMs: relativeDelta(a.totalDurationMs, b.totalDurationMs),
    durationViews: relativeDelta(a.durationViews, b.durationViews),
  };
}

function parseInput(
  input: unknown,
): ApiV1OverviewAdapterResult<SiteOverviewComparisonQueryDto> {
  const parsed = SiteOverviewComparisonQueryDtoSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      error: { kind: "invalid_input", reason: "schema_validation_failed" },
    };
  }
  return { ok: true, value: parsed.data };
}

function toQueryTime(
  range: {
    readonly from: string;
    readonly to: string;
    readonly timeZone: string;
  },
  capturedAtMs: number,
): ApiV1OverviewAdapterResult<QueryTime> {
  const startMs = Date.parse(range.from);
  const endExclusiveMs = Date.parse(range.to);
  if (
    !Number.isSafeInteger(startMs) ||
    !Number.isSafeInteger(endExclusiveMs) ||
    endExclusiveMs <= startMs
  ) {
    return {
      ok: false,
      error: { kind: "invalid_input", reason: "invalid_time_range" },
    };
  }
  if (!isReportingTimeZone(range.timeZone)) {
    return {
      ok: false,
      error: { kind: "invalid_input", reason: "invalid_time_zone" },
    };
  }
  return {
    ok: true,
    value: createQueryTime(
      startMs,
      endExclusiveMs,
      range.timeZone,
      capturedAtMs,
    ),
  };
}

/**
 * Execute both sides under one authenticated site context and one deadline.
 * The caller receives no partial comparison: any failed side makes the whole
 * operation fail before serialization.
 */
export async function executeApiV1SiteOverviewComparison(
  input: unknown,
  principal: ApiKeyPrincipal,
  siteId: string,
  reader: OverviewReader,
  executionContext: QueryExecutionContext,
  definitions?: AnalysisDefinitionReader,
): Promise<ComparisonExecution> {
  const parsed = parseInput(input);
  if (!parsed.ok) return parsed;
  if (executionContext.signal?.aborted) {
    return { ok: false, error: { kind: "request_cancelled" } };
  }
  const now = executionContext.now?.() ?? Date.now();
  const capturedAtMs = executionContext.capturedAtMs ?? now;
  if (
    typeof executionContext.deadlineMs === "number" &&
    now >= executionContext.deadlineMs
  ) {
    return { ok: false, error: { kind: "deadline_exceeded" } };
  }

  const context = createApiV1SiteQueryContext(principal, siteId);
  if (!context.ok) return { ok: false, error: { kind: context.error } };

  const inputValue = parsed.value;
  const ranges =
    inputValue.mode === "previous-period"
      ? (() => {
          const current = resolveApiV1TimeRange(
            inputValue.timeRange,
            capturedAtMs,
          );
          return current ? resolveApiV1PreviousPeriod(current) : null;
        })()
      : (() => {
          if (!isReportingTimeZone(inputValue.timeZone)) return null;
          const a = resolveApiV1ComparisonDatasetTimeRange(
            inputValue.a.timeRange,
            inputValue.timeZone,
            capturedAtMs,
          );
          const b = resolveApiV1ComparisonDatasetTimeRange(
            inputValue.b.timeRange,
            inputValue.timeZone,
            capturedAtMs,
          );
          return a && b ? { a, b } : null;
        })();
  if (!ranges) {
    return {
      ok: false,
      error: { kind: "invalid_input", reason: "invalid_time_range" },
    };
  }
  const aTime = toQueryTime(ranges.a, capturedAtMs);
  const bTime = toQueryTime(ranges.b, capturedAtMs);
  if (!aTime.ok) return aTime;
  if (!bTime.ok) return bTime;

  const aInput =
    inputValue.mode === "previous-period"
      ? { filter: inputValue.filter }
      : inputValue.a;
  const bInput =
    inputValue.mode === "previous-period"
      ? { filter: inputValue.filter }
      : inputValue.b;
  if (
    (aInput.filter?.type === "saved" || bInput.filter?.type === "saved") &&
    !principal.scopes.includes("analysis:read")
  ) {
    return { ok: false, error: { kind: "missing_scope" } };
  }
  const [aFilter, bFilter] = await Promise.all([
    resolveApiV1Filter(
      siteId,
      aInput.filter,
      definitions,
      executionContext.signal,
    ),
    resolveApiV1Filter(
      siteId,
      bInput.filter,
      definitions,
      executionContext.signal,
    ),
  ]);
  if (!aFilter.ok) return aFilter;
  if (!bFilter.ok) return bFilter;

  const combinedRangeMs =
    aTime.value.range.endExclusiveMs -
    aTime.value.range.startMs +
    (bTime.value.range.endExclusiveMs - bTime.value.range.startMs);
  const service = new AnalyticsQueryService();
  const execution = await service.execute(
    {
      operation: "site.analytics.comparisonOverview",
      context: context.context,
      query: {
        aTime: aTime.value,
        aFilter: aFilter.value,
        bTime: bTime.value,
        bFilter: bFilter.value,
      },
      provider: {
        execute: ({ query: { aTime, aFilter, bTime, bFilter } }) =>
          Promise.all([
            executeOverview(reader, {
              context: context.context,
              time: aTime,
              filters: aFilter,
            }),
            executeOverview(reader, {
              context: context.context,
              time: bTime,
              filters: bFilter,
            }),
          ]),
      },
    },
    {
      ...executionContext,
      operation: "site.analytics.comparisonOverview",
      cost: {
        rangeMs: combinedRangeMs,
        siteCount: 1,
        metricCount: inputValue.query.metrics?.length ?? 3,
        dimensionCardinality:
          filterConditionCount(aFilter.value) +
          filterConditionCount(bFilter.value),
        projectionFields: inputValue.query.metrics?.length ?? 3,
        pageLimit: 1,
        provider: "d1",
        batchFanout: 2,
      },
    },
  );
  if (!execution.ok) return { ok: true, value: execution };
  const [aResult, bResult] = execution.value;
  if (!aResult.ok) {
    return {
      ok: true,
      value: { ok: true, value: { ok: false, error: aResult.error } },
    };
  }
  if (!bResult.ok) {
    return {
      ok: true,
      value: { ok: true, value: { ok: false, error: bResult.error } },
    };
  }

  const a = aResult.data.current;
  const b = bResult.data.current;
  return {
    ok: true,
    value: {
      ok: true,
      value: {
        ok: true,
        data: {
          a,
          b,
          delta: overviewDelta(a, b),
          aTime: aTime.value,
          bTime: bTime.value,
        },
        meta: {
          time: aTime.value,
          source:
            aResult.meta.source === bResult.meta.source
              ? aResult.meta.source
              : "mixed",
          approximateVisitors:
            aResult.meta.approximateVisitors ||
            bResult.meta.approximateVisitors,
        },
      },
    },
  };
}
