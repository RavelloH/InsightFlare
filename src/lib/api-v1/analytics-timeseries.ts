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
import { createApiV1QueryApplicationAdapter } from "@/lib/api-v1/query-application";
import { createApiV1SiteQueryContext } from "@/lib/api-v1/query-context";
import type { AnalyticsProviderRegistry } from "@/lib/edge/analytics/application/provider-registry";
import type {
  AnalyticsServiceResult,
  QueryExecutionContext,
} from "@/lib/edge/analytics/application/service";
import type {
  AnalyticsResult,
  TrendQuery,
  TrendResult,
} from "@/lib/edge/analytics/contract";
import { filterConditionCount } from "@/lib/edge/analytics/contract";
import type { ApiKeyPrincipal } from "@/lib/edge/api-key-auth";

export async function executeApiV1SiteTimeseries(
  input: unknown,
  principal: ApiKeyPrincipal,
  siteId: string,
  providerRegistry: AnalyticsProviderRegistry,
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
    value: await createApiV1QueryApplicationAdapter(aggregateCache).execute<
      TrendQuery,
      AnalyticsResult<TrendResult>
    >(
      {
        operation: "site.analytics.timeseries",
        context: context.context,
        query: {
          context: context.context,
          time: time.value,
          filters: filter.value,
          scopePreference: parsed.data.scope ?? "auto",
          interval: parsed.data.interval,
        },
        providerRegistry,
        cache: {
          key: await aggregateCacheKey({
            operation: "site.analytics.timeseries",
            context,
            time: time.value,
            filters: filter.value,
            scopePreference: parsed.data.scope ?? "auto",
            extra: { interval: parsed.data.interval },
          }),
          policy: aggregateCachePolicy,
          isCacheable: (result) => result.ok,
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
