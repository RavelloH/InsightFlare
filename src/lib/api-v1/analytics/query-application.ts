import type {
  AnalyticsEventFieldsData,
  AnalyticsEventFieldValuesData,
  AnalyticsEventsTimeseriesData,
  AnalyticsEventTypeDetailData,
  AnalyticsEventTypesData,
  AnalyticsFilterValuesData,
  AnalyticsRetentionCohortsData,
} from "@/lib/api-v1/contract/wire";
import type { OperationResultCache } from "@/lib/edge/analytics/application/cache";
import type { OperationCachePolicy } from "@/lib/edge/analytics/application/cache";
import type { AnalyticsOperationId } from "@/lib/edge/analytics/application/operation-registry";
import {
  type ApiV1CanonicalResult,
  type ApiV1InvocationQuery,
  canonicalQueryOperationFor,
  canonicalQueryVariantFor,
} from "@/lib/edge/analytics/application/query-operation-map";
import {
  type AnalyticsServiceResult,
  type QueryExecutionContext,
} from "@/lib/edge/analytics/application/service";
import type { AnalyticsQueryExecutor } from "@/lib/edge/analytics/composition/query-runtime";
import type {
  AnalyticsResult,
  QueryInput,
  QueryTime,
} from "@/lib/edge/analytics/contract";
import { createQueryTime } from "@/lib/edge/analytics/contract/helpers";
import { paginationBinding } from "@/lib/pagination";

type ApiV1FunnelAnalysisWireValue<Value> = Value extends {
  readonly funnel: infer Funnel;
}
  ? Omit<Value, "funnel"> & { readonly funnel: NonNullable<Funnel> }
  : Value;

interface ApiV1WireResultOverrides {
  readonly "site.analytics.filterValues": AnalyticsFilterValuesData;
  readonly "site.analytics.retentionCohorts": AnalyticsRetentionCohortsData;
  readonly "site.analytics.eventsTimeseries": AnalyticsEventsTimeseriesData;
  readonly "site.analytics.eventTypes": AnalyticsEventTypesData;
  readonly "site.analytics.eventFields": AnalyticsEventFieldsData;
  readonly "site.analytics.eventFieldValues": AnalyticsEventFieldValuesData;
  readonly "site.analytics.eventTypeDetail": AnalyticsEventTypeDetailData;
  readonly "site.analytics.funnelAnalysis": ApiV1FunnelAnalysisWireValue<
    ApiV1CanonicalResult<"site.analytics.funnelAnalysis">
  > | null;
}

/** The protocol result after API v1's operation-specific serialization. */
export type ApiV1WireResult<Operation extends AnalyticsOperationId> =
  Operation extends keyof ApiV1WireResultOverrides
    ? ApiV1WireResultOverrides[Operation]
    : ApiV1CanonicalResult<Operation>;

export interface ApiV1QueryInvocation<Operation extends AnalyticsOperationId> {
  readonly operation: Operation;
  readonly context: QueryInput["context"];
  readonly query: ApiV1InvocationQuery<Operation>;
  /** Canonical request DTO, before it is expanded into a provider query. */
  readonly rawRequest?: unknown;
  readonly executor: AnalyticsQueryExecutor;
  readonly cache?: {
    readonly key: string;
    readonly policy: OperationCachePolicy;
    readonly isCacheable?: (value: ApiV1CanonicalResult<Operation>) => boolean;
  };
}
function queryTime(
  input: unknown,
  executionContext: QueryExecutionContext,
): QueryTime | undefined {
  if (!input || typeof input !== "object") return undefined;
  const value = input as Record<string, unknown>;
  if ("time" in value && value.time) return value.time as QueryTime;
  if (
    "current" in value &&
    value.current &&
    typeof value.current === "object" &&
    "time" in value.current &&
    value.current.time
  ) {
    return (value.current as { readonly time: QueryTime }).time;
  }
  const window =
    "window" in value && value.window && typeof value.window === "object"
      ? (value.window as Record<string, unknown>)
      : value;
  const startMs = window.startMs;
  const endExclusiveMs = window.endExclusiveMs;
  const reportingTimeZone = window.timeZone;
  if (
    typeof startMs === "number" &&
    typeof endExclusiveMs === "number" &&
    typeof reportingTimeZone === "string"
  ) {
    try {
      return createQueryTime(
        startMs,
        endExclusiveMs,
        reportingTimeZone,
        executionContext.capturedAtMs ?? Date.now(),
      );
    } catch {
      return undefined;
    }
  }
  return undefined;
}
function rawRequestWithoutPaging(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return value;
  }
  const record = value as Record<string, unknown>;
  const page = record.page;
  if (!page || typeof page !== "object" || Array.isArray(page)) {
    return value;
  }
  const pageRecord = page as Record<string, unknown>;
  const { cursor: _cursor, limit: _limit, ...pageWithoutPaging } = pageRecord;
  return { ...record, page: pageWithoutPaging };
}
async function apiV1RequestPaginationBinding(
  operation: AnalyticsOperationId,
  query: unknown,
  context: QueryInput["context"],
): Promise<string> {
  const subject = context.subject;
  const canonicalSubject =
    subject.kind === "site"
      ? subject
      : {
          ...subject,
          authorizedSiteIds: [...subject.authorizedSiteIds].sort(),
        };
  return paginationBinding([
    "api-v1-request-pagination-v2",
    operation,
    context.policy.audience,
    context.policy.revision,
    canonicalSubject,
    rawRequestWithoutPaging(query),
  ]);
}
function serviceError<Result>(
  operation: AnalyticsOperationId,
  result: AnalyticsResult<Result>,
): AnalyticsServiceResult<Result> | null {
  if (result.ok) return { ok: true, value: result.data, meta: result.meta };
  if (result.error.kind === "request-cancelled") {
    return { ok: false, error: { kind: "request-cancelled" } };
  }
  if (result.error.kind === "deadline-exceeded") {
    return { ok: false, error: { kind: "deadline-exceeded" } };
  }
  if (result.error.kind === "query-cost-exceeded") {
    return {
      ok: false,
      error: { kind: "query-cost-exceeded", cost: result.error.cost },
    };
  }
  if (result.error.kind === "invalid-input") {
    return {
      ok: false,
      error: { kind: "invalid-input", issues: result.error.issues },
    };
  }
  if (result.error.kind === "invalid-cursor") {
    return {
      ok: false,
      error: { kind: "invalid-cursor", cursorKind: result.error.cursorKind },
    };
  }
  if (result.error.kind === "internal") {
    return null;
  }
  if (
    operation === "site.analytics.comparison" ||
    operation === "team.analytics.comparison" ||
    operation === "site.analytics.comparisonBreakdown" ||
    operation === "team.analytics.comparisonBreakdown"
  ) {
    return { ok: false, error: { kind: "domain-error", error: result.error } };
  }
  return {
    ok: false,
    error: { kind: "operation-not-allowed", operation },
  };
}
function serializeApiV1Result<Operation extends AnalyticsOperationId>(
  operation: Operation,
  value: ApiV1CanonicalResult<Operation>,
): ApiV1WireResult<Operation>;
function serializeApiV1Result(
  operation: AnalyticsOperationId,
  value: unknown,
): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const result = value as Record<string, unknown>;
  if (
    operation === "site.analytics.filterValues" &&
    result.data &&
    typeof result.data === "object" &&
    !Array.isArray(result.data)
  ) {
    const data = result.data as Record<string, unknown>;
    return {
      field: result.field,
      items: data.items,
      pagination: data.pagination,
    };
  }
  if (operation === "site.analytics.retentionCohorts") {
    const cohorts = Array.isArray(result.cohorts) ? result.cohorts : [];
    return {
      granularity: result.granularity,
      cohorts: cohorts.map((cohort) => {
        if (!cohort || typeof cohort !== "object" || Array.isArray(cohort)) {
          return cohort;
        }
        const { bucket, ...fields } = cohort as Record<string, unknown>;
        return {
          ...fields,
          start:
            typeof bucket === "number"
              ? new Date(bucket).toISOString()
              : fields.start,
        };
      }),
    };
  }
  if (operation === "site.analytics.eventsTimeseries") {
    const data = Array.isArray(result.data) ? result.data : [];
    return {
      interval: result.interval,
      series: result.series,
      points: data.map((point) => {
        if (!point || typeof point !== "object" || Array.isArray(point)) {
          return point;
        }
        const row = point as Record<string, unknown>;
        const { timestampMs, ...fields } = row;
        return {
          ...fields,
          timestamp:
            typeof timestampMs === "number"
              ? new Date(timestampMs).toISOString()
              : row.timestamp,
        };
      }),
    };
  }
  if (
    operation === "site.analytics.eventTypes" &&
    Array.isArray(result.items)
  ) {
    return {
      ...result,
      items: result.items.map((item) => {
        if (!item || typeof item !== "object" || Array.isArray(item)) {
          return item;
        }
        const row = item as Record<string, unknown>;
        const key =
          typeof row.key === "string"
            ? row.key
            : typeof row.label === "string"
              ? row.label
              : "";
        const { views, ...fields } = row;
        return {
          ...fields,
          key,
          events:
            typeof row.events === "number"
              ? row.events
              : typeof views === "number"
                ? views
                : 0,
        };
      }),
    };
  }
  if (
    operation === "site.analytics.eventFields" &&
    result.data &&
    typeof result.data === "object" &&
    !Array.isArray(result.data)
  ) {
    const data = result.data as Record<string, unknown>;
    return {
      eventName: result.eventName,
      items: data.items,
      pagination: data.pagination,
    };
  }
  if (
    operation === "site.analytics.eventFieldValues" &&
    result.data &&
    typeof result.data === "object" &&
    !Array.isArray(result.data)
  ) {
    const data = result.data as Record<string, unknown>;
    return {
      eventName: result.eventName,
      fieldPath: result.fieldPath,
      fieldValueType: result.fieldValueType,
      items: data.items,
      pagination: data.pagination,
    };
  }
  if (operation === "site.analytics.eventTypeDetail") {
    const trend = result.trend;
    if (!trend || typeof trend !== "object" || Array.isArray(trend)) {
      return value;
    }
    const trendRecord = trend as Record<string, unknown>;
    const data = Array.isArray(trendRecord.data) ? trendRecord.data : [];
    return {
      ...result,
      trend: {
        ...trendRecord,
        data: data.map((point) => {
          if (!point || typeof point !== "object" || Array.isArray(point)) {
            return point;
          }
          const row = point as Record<string, unknown>;
          const { timestampMs, ...fields } = row;
          return {
            ...fields,
            timestamp:
              typeof timestampMs === "number"
                ? new Date(timestampMs).toISOString()
                : row.timestamp,
          };
        }),
      },
    };
  }
  if (operation === "site.analytics.funnelAnalysis" && result.funnel === null) {
    return null;
  }
  return value;
}
/**
 * API v1 adapter entry point. The external operation id is translated here;
 * the runtime sees only a canonical QueryOperation and canonical query.
 */
export async function executeApiV1Query<Operation extends AnalyticsOperationId>(
  cache: OperationResultCache | undefined,
  invocation: ApiV1QueryInvocation<Operation>,
  executionContext: QueryExecutionContext,
): Promise<AnalyticsServiceResult<ApiV1WireResult<Operation>>> {
  const time = queryTime(invocation.query, executionContext);
  if (!time) {
    return {
      ok: false,
      error: {
        kind: "operation-not-allowed",
        operation: invocation.operation,
      },
    };
  }

  const operation = canonicalQueryOperationFor(invocation.operation);
  const rawRequest = invocation.rawRequest ?? invocation.query;
  const requestBinding = await apiV1RequestPaginationBinding(
    invocation.operation,
    rawRequest,
    invocation.context,
  );
  const canonicalVariant = canonicalQueryVariantFor(invocation.operation);
  const canonicalQuery = {
    ...invocation.query,
    context: invocation.context,
    time: { ...time, paginationBinding: requestBinding },
    ...(canonicalVariant ? { mode: canonicalVariant } : {}),
  };
  let providerError: unknown;
  const canonicalResult = await invocation.executor.execute(
    operation,
    canonicalQuery,
    {
      ...executionContext,
      operation: invocation.operation,
      ...(invocation.cache
        ? {
            cache: {
              ...invocation.cache,
              isCacheable: (value: unknown) =>
                invocation.cache?.isCacheable?.(
                  value as ApiV1CanonicalResult<Operation>,
                ) ?? true,
            },
          }
        : {}),
      ...(cache ? { cacheStore: cache } : {}),
      onProviderError: (error) => {
        providerError = error;
        executionContext.onProviderError?.(error);
      },
    },
  );
  const result = canonicalResult;
  if (!result.ok && result.error.kind === "internal") {
    if (providerError) {
      return Promise.reject(
        providerError instanceof Error
          ? providerError
          : new Error("data-unavailable"),
      );
    }
    return {
      ok: false,
      error: {
        kind: "operation-not-allowed",
        operation: invocation.operation,
      },
    };
  }
  const protocolResult: AnalyticsResult<ApiV1WireResult<Operation>> = result.ok
    ? {
        ...result,
        data: serializeApiV1Result(invocation.operation, result.data),
      }
    : result;
  return (
    serviceError(invocation.operation, protocolResult) ??
    Promise.reject(
      providerError instanceof Error
        ? providerError
        : new Error("data-unavailable"),
    )
  );
}
export function createApiV1QueryApplicationAdapter(
  cache?: OperationResultCache,
) {
  return {
    execute<Operation extends AnalyticsOperationId>(
      invocation: ApiV1QueryInvocation<Operation>,
      executionContext: QueryExecutionContext,
    ): Promise<AnalyticsServiceResult<ApiV1WireResult<Operation>>> {
      return executeApiV1Query(cache, invocation, executionContext);
    },
  };
}

/** Preserve API v1's envelope while consuming the canonical provider result. */
export function createApiV1AnalyticsResultAdapter(
  cache?: OperationResultCache,
) {
  const adapter = createApiV1QueryApplicationAdapter(cache);
  return {
    async execute<Operation extends AnalyticsOperationId>(
      invocation: ApiV1QueryInvocation<Operation>,
      executionContext: QueryExecutionContext,
    ): Promise<
      AnalyticsServiceResult<AnalyticsResult<ApiV1WireResult<Operation>>>
    > {
      const result = await adapter.execute(invocation, executionContext);
      if (!result.ok) return result;
      if (!result.meta) throw new Error("analytics_result_metadata_missing");
      return {
        ...result,
        value: {
          ok: true,
          data: result.value,
          meta: result.meta,
        },
      };
    },
  };
}
