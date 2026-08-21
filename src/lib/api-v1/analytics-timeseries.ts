import {
  aggregateCache,
  aggregateCacheKey,
  aggregateCachePolicy,
  type AnalysisDefinitionReader,
  type ApiV1OverviewAdapterResult,
  resolveApiV1Filter,
  toApiV1QueryTime,
} from "@/lib/api-v1/analytics-overview";
import { SiteTimeseriesQueryDtoSchema } from "@/lib/api-v1/dto/analytics";
import { createApiV1SiteQueryContext } from "@/lib/api-v1/query-context";
import {
  AnalyticsQueryService,
  type AnalyticsServiceResult,
  type QueryExecutionContext,
} from "@/lib/edge/analytics/service";
import type { ApiKeyPrincipal } from "@/lib/edge/api-key-auth";
import type {
  AnalyticsResult,
  OverviewReader,
  TrendResult,
} from "@/lib/edge/query-contract";
import { filterConditionCount } from "@/lib/edge/query-contract";

export async function executeApiV1SiteTimeseries(
  input: unknown,
  principal: ApiKeyPrincipal,
  siteId: string,
  reader: OverviewReader,
  executionContext: QueryExecutionContext,
  definitions?: AnalysisDefinitionReader,
): Promise<
  ApiV1OverviewAdapterResult<
    AnalyticsServiceResult<AnalyticsResult<TrendResult>>
  >
> {
  const parsed = SiteTimeseriesQueryDtoSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      error: { kind: "invalid_input", reason: "schema_validation_failed" },
    };
  }
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
  if (
    parsed.data.filter?.type === "saved" &&
    !principal.scopes.includes("analysis:read")
  ) {
    return { ok: false, error: { kind: "missing_scope" } };
  }
  const time = toApiV1QueryTime(parsed.data.timeRange, capturedAtMs);
  if (!time.ok) return time;
  const filter = await resolveApiV1Filter(
    siteId,
    parsed.data.filter,
    definitions,
    executionContext.signal,
  );
  if (!filter.ok) return filter;
  return {
    ok: true,
    value: await new AnalyticsQueryService(aggregateCache).trend(
      reader,
      {
        context: context.context,
        time: time.value,
        filters: filter.value,
        interval: parsed.data.interval,
        cache: {
          key: await aggregateCacheKey({
            operation: "site.analytics.timeseries",
            context,
            time: time.value,
            filters: filter.value,
            extra: { interval: parsed.data.interval },
          }),
          policy: aggregateCachePolicy,
        },
      },
      {
        ...executionContext,
        cost: {
          rangeMs: time.value.range.endExclusiveMs - time.value.range.startMs,
          siteCount: 1,
          metricCount: 3,
          dimensionCardinality: filterConditionCount(filter.value),
          projectionFields: 3,
          pageLimit: 1,
          provider: "d1",
          batchFanout: 1,
        },
      },
    ),
  };
}
