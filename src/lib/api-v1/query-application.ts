import type { OperationResultCache } from "@/lib/edge/analytics/application/cache";
import type { OperationCachePolicy } from "@/lib/edge/analytics/application/cache";
import type { AnalyticsOperationId } from "@/lib/edge/analytics/application/operation-registry";
import type { AnalyticsProviderRegistry } from "@/lib/edge/analytics/application/provider-registry";
import { canonicalQueryOperationFor } from "@/lib/edge/analytics/application/query-operation-map";
import {
  type AnalyticsServiceResult,
  type QueryExecutionContext,
  TypedQueryApplicationService,
} from "@/lib/edge/analytics/application/service";
import type {
  AnalyticsResult,
  QueryInput,
  QueryTime,
} from "@/lib/edge/analytics/contract";
import { createQueryTime } from "@/lib/edge/analytics/contract/helpers";
import { paginationBinding } from "@/lib/pagination";

export interface ApiV1QueryInvocation<Query, Result> {
  readonly operation: AnalyticsOperationId;
  readonly context: QueryInput["context"];
  readonly query: Query;
  /** Canonical request DTO, before it is expanded into a provider query. */
  readonly rawRequest?: unknown;
  readonly providerRegistry: AnalyticsProviderRegistry;
  readonly cache?: {
    readonly key: string;
    readonly policy: OperationCachePolicy;
    readonly isCacheable?: (value: Result) => boolean;
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

function rawRequestWithoutCursor(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return value;
  }
  const record = value as Record<string, unknown>;
  const page = record.page;
  if (!page || typeof page !== "object" || Array.isArray(page)) {
    return value;
  }
  const pageRecord = page as Record<string, unknown>;
  const { cursor: _cursor, ...pageWithoutCursor } = pageRecord;
  return { ...record, page: pageWithoutCursor };
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
    "api-v1-request-pagination-v1",
    operation,
    context.policy.audience,
    canonicalSubject,
    rawRequestWithoutCursor(query),
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
  return {
    ok: false,
    error: { kind: "operation-not-allowed", operation },
  };
}

/**
 * API v1 adapter entry point. The external operation id is translated here;
 * the application service sees only a canonical QueryOperation and registry.
 */
export async function executeApiV1Query<Query, Result>(
  cache: OperationResultCache | undefined,
  invocation: ApiV1QueryInvocation<Query, Result>,
  executionContext: QueryExecutionContext,
): Promise<AnalyticsServiceResult<Result>> {
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
  if (!invocation.providerRegistry.resolve<Result>(operation)) {
    return {
      ok: false,
      error: {
        kind: "operation-not-allowed",
        operation: invocation.operation,
      },
    };
  }
  const rawRequest = invocation.rawRequest ?? invocation.query;
  const requestBinding = await apiV1RequestPaginationBinding(
    invocation.operation,
    rawRequest,
    invocation.context,
  );
  const query = {
    ...invocation.query,
    context: invocation.context,
    time: { ...time, paginationBinding: requestBinding },
  } as QueryInput;
  let providerError: unknown;
  const result = await new TypedQueryApplicationService(cache).execute(
    {
      kind: "typed-query",
      operation,
      query,
      providerRegistry: invocation.providerRegistry,
      cache: invocation.cache,
    },
    {
      ...executionContext,
      operation: invocation.operation,
      onProviderError: (error) => {
        providerError = error;
        executionContext.onProviderError?.(error);
      },
    },
  );
  return (
    serviceError(invocation.operation, result) ??
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
    execute<Query, Result>(
      invocation: ApiV1QueryInvocation<Query, Result>,
      executionContext: QueryExecutionContext,
    ): Promise<AnalyticsServiceResult<Result>> {
      return executeApiV1Query(cache, invocation, executionContext);
    },
  };
}
