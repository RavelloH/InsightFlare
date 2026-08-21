import {
  type AnalysisDefinitionReader,
  type ApiV1OverviewAdapterResult,
  resolveApiV1Filter,
  toApiV1QueryTime,
} from "@/lib/api-v1/analytics-overview";
import {
  type SiteComparisonTimeseriesQueryDto,
  SiteComparisonTimeseriesQueryDtoSchema,
} from "@/lib/api-v1/dto/analytics";
import { createApiV1SiteQueryContext } from "@/lib/api-v1/query-context";
import { resolveApiV1ComparisonDatasetTimeRange } from "@/lib/api-v1/time-range";
import {
  AnalyticsQueryService,
  type AnalyticsServiceResult,
  type QueryExecutionContext,
} from "@/lib/edge/analytics/service";
import type { ApiKeyPrincipal } from "@/lib/edge/api-key-auth";
import {
  type AnalyticsResult,
  executeTrend,
  filterConditionCount,
  isReportingTimeZone,
  type OverviewReader,
  type QuerySource,
  type QueryTime,
  type TrendPoint,
  type TrendResult,
} from "@/lib/edge/query-contract";

export interface ComparisonTimeseriesData {
  readonly interval: TrendResult["interval"];
  readonly a: TrendResult;
  readonly b: TrendResult;
  readonly delta: readonly {
    readonly ordinal: number;
    readonly a: TrendPoint;
    readonly b: TrendPoint;
    readonly values: Readonly<
      Record<
        | "views"
        | "sessions"
        | "visitors"
        | "bounces"
        | "totalDurationMs"
        | "durationViews",
        number | null
      >
    >;
  }[];
  readonly aTime: QueryTime;
  readonly bTime: QueryTime;
  readonly source: QuerySource;
  readonly approximateVisitors: boolean;
}

type ComparisonExecution = ApiV1OverviewAdapterResult<
  AnalyticsServiceResult<AnalyticsResult<ComparisonTimeseriesData>>
>;

function relativeDelta(a: number, b: number): number | null {
  if (b === 0) return a === 0 ? 0 : null;
  return (a - b) / b;
}

function pointDelta(a: TrendPoint, b: TrendPoint) {
  return {
    views: relativeDelta(a.views, b.views),
    sessions: relativeDelta(a.sessions, b.sessions),
    visitors: relativeDelta(a.visitors, b.visitors),
    bounces: relativeDelta(a.bounces, b.bounces),
    totalDurationMs: relativeDelta(a.totalDurationMs, b.totalDurationMs),
    durationViews: relativeDelta(a.durationViews, b.durationViews),
  };
}

function inputError(reason: string): ComparisonExecution {
  return { ok: false, error: { kind: "invalid_input", reason } };
}

/**
 * Explicit site comparison with ordinal bucket alignment. The providers retain
 * each dataset's own bucket timestamps; only the delta projection is aligned.
 */
export async function executeApiV1SiteTimeseriesComparison(
  input: unknown,
  principal: ApiKeyPrincipal,
  siteId: string,
  reader: OverviewReader,
  executionContext: QueryExecutionContext,
  definitions?: AnalysisDefinitionReader,
): Promise<ComparisonExecution> {
  const parsed = SiteComparisonTimeseriesQueryDtoSchema.safeParse(input);
  if (!parsed.success) return inputError("schema_validation_failed");
  const value: SiteComparisonTimeseriesQueryDto = parsed.data;
  if (executionContext.signal?.aborted)
    return { ok: false, error: { kind: "request_cancelled" } };
  const now = executionContext.now?.() ?? Date.now();
  const capturedAtMs = executionContext.capturedAtMs ?? now;
  if (
    typeof executionContext.deadlineMs === "number" &&
    now >= executionContext.deadlineMs
  )
    return { ok: false, error: { kind: "deadline_exceeded" } };
  if (!isReportingTimeZone(value.timeZone))
    return inputError("invalid_time_zone");
  const context = createApiV1SiteQueryContext(principal, siteId);
  if (!context.ok) return { ok: false, error: { kind: context.error } };
  if (
    (value.a.filter?.type === "saved" || value.b.filter?.type === "saved") &&
    !principal.scopes.includes("analysis:read")
  ) {
    return { ok: false, error: { kind: "missing_scope" } };
  }
  const aRange = resolveApiV1ComparisonDatasetTimeRange(
    value.a.timeRange,
    value.timeZone,
    capturedAtMs,
  );
  const bRange = resolveApiV1ComparisonDatasetTimeRange(
    value.b.timeRange,
    value.timeZone,
    capturedAtMs,
  );
  if (!aRange || !bRange) return inputError("invalid_time_range");
  const aTime = toApiV1QueryTime({ kind: "absolute", ...aRange }, capturedAtMs);
  const bTime = toApiV1QueryTime({ kind: "absolute", ...bRange }, capturedAtMs);
  if (!aTime.ok) return aTime;
  if (!bTime.ok) return bTime;
  const [aFilter, bFilter] = await Promise.all([
    resolveApiV1Filter(
      siteId,
      value.a.filter,
      definitions,
      executionContext.signal,
    ),
    resolveApiV1Filter(
      siteId,
      value.b.filter,
      definitions,
      executionContext.signal,
    ),
  ]);
  if (!aFilter.ok) return aFilter;
  if (!bFilter.ok) return bFilter;

  const service = new AnalyticsQueryService();
  const execution = await service.execute(
    {
      operation: "site.analytics.comparisonTimeseries",
      context: context.context,
      query: {
        aTime: aTime.value,
        aFilter: aFilter.value,
        bTime: bTime.value,
        bFilter: bFilter.value,
        interval: value.query.interval,
      },
      provider: {
        execute: ({ query: { aTime, aFilter, bTime, bFilter, interval } }) =>
          Promise.all([
            executeTrend(reader, {
              context: context.context,
              time: aTime,
              filters: aFilter,
              interval,
            }),
            executeTrend(reader, {
              context: context.context,
              time: bTime,
              filters: bFilter,
              interval,
            }),
          ]),
      },
    },
    {
      ...executionContext,
      operation: "site.analytics.comparisonTimeseries",
      cost: {
        rangeMs:
          aTime.value.range.endExclusiveMs -
          aTime.value.range.startMs +
          (bTime.value.range.endExclusiveMs - bTime.value.range.startMs),
        siteCount: 1,
        metricCount: 6,
        dimensionCardinality:
          filterConditionCount(aFilter.value) +
          filterConditionCount(bFilter.value),
        projectionFields: 6,
        pageLimit: 1,
        provider: "d1",
        batchFanout: 2,
      },
    },
  );
  if (!execution.ok) return { ok: true, value: execution };
  const [a, b] = execution.value;
  if (!a.ok) return { ok: true, value: { ok: true, value: a } };
  if (!b.ok) return { ok: true, value: { ok: true, value: b } };
  if (a.data.points.length !== b.data.points.length) {
    return {
      ok: true,
      value: {
        ok: true,
        value: {
          ok: false,
          error: { kind: "unsupported-operation", operation: "trend" },
        },
      },
    };
  }
  const delta = a.data.points.map((point, ordinal) => {
    const previous = b.data.points[ordinal]!;
    return {
      ordinal,
      a: point,
      b: previous,
      values: pointDelta(point, previous),
    };
  });
  const source = a.meta.source === b.meta.source ? a.meta.source : "mixed";
  return {
    ok: true,
    value: {
      ok: true,
      value: {
        ok: true,
        data: {
          interval: value.query.interval,
          a: a.data,
          b: b.data,
          delta,
          aTime: aTime.value,
          bTime: bTime.value,
          source,
          approximateVisitors:
            a.meta.approximateVisitors || b.meta.approximateVisitors,
        },
        meta: {
          time: aTime.value,
          source,
          approximateVisitors:
            a.meta.approximateVisitors || b.meta.approximateVisitors,
        },
      },
    },
  };
}
