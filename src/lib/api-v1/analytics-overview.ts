import {
  AnalysisDefinitionIntegrityError,
  AnalysisDefinitionReadCancelledError,
  type AnalysisDefinitionReader,
  type ResolvedSavedFilter,
} from "@/lib/api-v1/analysis-definition-reader";
import {
  type AnalyticsTimeRangeInputDto,
  type SiteAnalyticsQueryBaseDto,
  type SiteOverviewQueryDto,
  SiteOverviewQueryDtoSchema,
} from "@/lib/api-v1/dto/analytics";
import { createApiV1QueryApplicationAdapter } from "@/lib/api-v1/query-application";
import { createApiV1SiteQueryContext } from "@/lib/api-v1/query-context";
import { resolveApiV1TimeRange } from "@/lib/api-v1/time-range";
import {
  createOperationCacheKey,
  OperationResultCache,
} from "@/lib/edge/analytics/application/cache";
import type { AnalyticsProviderRegistry } from "@/lib/edge/analytics/application/provider-registry";
import type {
  AnalyticsServiceResult,
  QueryExecutionContext,
} from "@/lib/edge/analytics/application/service";
import {
  type AnalyticsResult,
  attachSavedFilterScopePreference,
  createQueryTime,
  createScopedFilterPlan,
  filterConditionCount,
  type FilterDocument,
  type FilterScopePreference,
  isReportingTimeZone,
  type OverviewQuery,
  type OverviewResult,
  parseApiV1FilterDocument,
  reconcileFilterScopePreferences,
  resolveFilterScope,
  savedFilterScopePreferenceFromDocument,
} from "@/lib/edge/analytics/contract";
import type { ApiKeyPrincipal } from "@/lib/edge/api-key-auth";
import { sha256Hex } from "@/lib/edge/utils";
import { analyticsFilterRegistry, parseFilterDsl } from "@/lib/filter-contract";

const MAX_BODY_BYTES = 64 * 1024;
const MAX_JSON_DEPTH = 16;
const MAX_JSON_NODES = 512;
export const aggregateCache = new OperationResultCache();
export const aggregateCachePolicy = { ttlMs: 30_000, maxEntries: 256 } as const;

export async function aggregateCacheKey(input: {
  readonly operation: "site.analytics.overview" | "site.analytics.timeseries";
  readonly context: ReturnType<typeof createApiV1SiteQueryContext> & {
    readonly ok: true;
  };
  readonly time: ReturnType<typeof createQueryTime>;
  readonly filters: FilterDocument;
  readonly scopePreference?: FilterScopePreference;
  readonly extra?: unknown;
}): Promise<string> {
  const operation =
    input.operation === "site.analytics.overview" ? "overview" : "trend";
  const requestedScope = input.scopePreference ?? "auto";
  const savedScope =
    savedFilterScopePreferenceFromDocument(input.filters) ?? "auto";
  let resolvedScope: string = "scope_conflict";
  let scopePlan: unknown = null;
  try {
    const reconciledScope = reconcileFilterScopePreferences(
      requestedScope,
      savedScope,
    );
    resolvedScope = resolveFilterScope(operation, reconciledScope) ?? "none";
    scopePlan = createScopedFilterPlan(
      operation,
      input.filters,
      reconciledScope,
    );
  } catch {
    // Invalid scope combinations are rejected by the application service;
    // keeping a distinct key here prevents an invalid request from sharing a
    // successful entry created for a different scope combination.
  }
  return createOperationCacheKey({
    contractRevision: "1",
    operation: input.operation,
    operationRevision: "1",
    subjectFingerprint: await sha256Hex(
      JSON.stringify(input.context.context.subject),
    ),
    policyRevision: input.context.context.policy.revision,
    query: {
      from: input.time.range.startMs,
      to: input.time.range.endExclusiveMs,
      timeZone: input.time.reportingTimeZone,
      filters: input.filters,
      resolvedScope,
      scopePlan,
      extra: input.extra ?? null,
    },
  });
}

export type ApiV1OverviewInputError =
  | { readonly kind: "invalid_input"; readonly reason: string }
  | { readonly kind: "missing_scope" | "site_not_found" | "token_inactive" }
  | { readonly kind: "saved_filter_not_available" | "internal_error" }
  | { readonly kind: "request_cancelled" | "deadline_exceeded" };

export type ApiV1OverviewAdapterResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: ApiV1OverviewInputError };

export type { AnalysisDefinitionReader, ResolvedSavedFilter };

function preflightJson(value: unknown): string | null {
  let serialized: string;
  try {
    serialized = JSON.stringify(value);
  } catch {
    return "body_not_serializable";
  }
  if (
    typeof serialized !== "string" ||
    new TextEncoder().encode(serialized).byteLength > MAX_BODY_BYTES
  ) {
    return "body_too_large";
  }

  let nodes = 0;
  const queue: Array<{ readonly value: unknown; readonly depth: number }> = [
    { value, depth: 0 },
  ];
  while (queue.length > 0) {
    const current = queue.pop();
    if (!current) break;
    nodes += 1;
    if (nodes > MAX_JSON_NODES) return "body_too_complex";
    if (current.depth > MAX_JSON_DEPTH) return "body_too_deep";
    if (Array.isArray(current.value)) {
      for (const child of current.value) {
        queue.push({ value: child, depth: current.depth + 1 });
      }
    } else if (current.value && typeof current.value === "object") {
      for (const child of Object.values(current.value)) {
        queue.push({ value: child, depth: current.depth + 1 });
      }
    }
  }
  return null;
}

function parseInput(
  value: unknown,
): ApiV1OverviewAdapterResult<SiteOverviewQueryDto> {
  const preflightError = preflightJson(value);
  if (preflightError)
    return {
      ok: false,
      error: { kind: "invalid_input", reason: preflightError },
    };
  const parsed = SiteOverviewQueryDtoSchema.safeParse(value);
  if (!parsed.success) {
    return {
      ok: false,
      error: { kind: "invalid_input", reason: "schema_validation_failed" },
    };
  }
  return { ok: true, value: parsed.data };
}

export function toApiV1QueryTime(
  input: AnalyticsTimeRangeInputDto,
  capturedAtMs = Date.now(),
): ApiV1OverviewAdapterResult<ReturnType<typeof createQueryTime>> {
  const range = resolveApiV1TimeRange(input, capturedAtMs);
  if (!range) {
    return {
      ok: false,
      error: { kind: "invalid_input", reason: "invalid_time_range" },
    };
  }
  const startMs = Date.parse(range.from);
  const endExclusiveMs = Date.parse(range.to);
  const timeZone = range.timeZone;
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
  if (!isReportingTimeZone(timeZone)) {
    return {
      ok: false,
      error: { kind: "invalid_input", reason: "invalid_time_zone" },
    };
  }
  return {
    ok: true,
    value: createQueryTime(startMs, endExclusiveMs, timeZone, capturedAtMs),
  };
}

/**
 * Parse the human-readable API v1 filter surface through the shared DSL
 * contract, then apply the same API audience policy as the structured filter
 * surface. Every API handler should receive a canonical FilterDocument.
 */
export function parseApiV1FilterDsl(expression: string): FilterDocument {
  return parseApiV1FilterDocument(
    parseFilterDsl(expression, analyticsFilterRegistry),
  );
}

export async function resolveApiV1Filter(
  siteId: string,
  filter: SiteAnalyticsQueryBaseDto["filter"],
  definitions: AnalysisDefinitionReader | undefined,
  signal: AbortSignal | undefined,
): Promise<ApiV1OverviewAdapterResult<FilterDocument>> {
  if (!filter) {
    return { ok: true, value: { version: 1, root: null } };
  }
  if (filter.type === "saved") {
    if (!definitions)
      return { ok: false, error: { kind: "saved_filter_not_available" } };
    try {
      const definition = await definitions.resolveTeamVisibleSavedFilter({
        siteId,
        id: filter.id,
        signal,
      });
      if (!definition) return { ok: false, error: { kind: "site_not_found" } };
      return {
        ok: true,
        value: attachSavedFilterScopePreference(
          definition.document,
          definition.scopePreference ?? "auto",
        ),
      };
    } catch (error) {
      if (error instanceof AnalysisDefinitionReadCancelledError) {
        return { ok: false, error: { kind: "request_cancelled" } };
      }
      if (error instanceof AnalysisDefinitionIntegrityError) {
        return { ok: false, error: { kind: "internal_error" } };
      }
      return { ok: false, error: { kind: "internal_error" } };
    }
  }
  if (filter.type === "dsl") {
    try {
      return { ok: true, value: parseApiV1FilterDsl(filter.expression) };
    } catch {
      return {
        ok: false,
        error: { kind: "invalid_input", reason: "invalid_filter" },
      };
    }
  }
  try {
    return {
      ok: true,
      value: parseApiV1FilterDocument({
        version: 1,
        root: filter.expression,
      }),
    };
  } catch {
    return {
      ok: false,
      error: { kind: "invalid_input", reason: "invalid_filter" },
    };
  }
}

export async function executeApiV1SiteOverview(
  input: unknown,
  principal: ApiKeyPrincipal,
  siteId: string,
  providerRegistry: AnalyticsProviderRegistry,
  executionContext: QueryExecutionContext,
  definitions?: AnalysisDefinitionReader,
): Promise<
  ApiV1OverviewAdapterResult<
    AnalyticsServiceResult<AnalyticsResult<OverviewResult>>
  >
> {
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
  if (!context.ok) {
    return { ok: false, error: { kind: context.error } };
  }
  if (
    parsed.value.filter?.type === "saved" &&
    !principal.scopes.includes("analysis:read")
  ) {
    return { ok: false, error: { kind: "missing_scope" } };
  }
  const time = toApiV1QueryTime(parsed.value.timeRange, capturedAtMs);
  if (!time.ok) return time;
  const filter = await resolveApiV1Filter(
    siteId,
    parsed.value.filter,
    definitions,
    executionContext.signal,
  );
  if (!filter.ok) return filter;
  const metricCount = parsed.value.metrics?.length ?? 3;

  return {
    ok: true,
    value: await createApiV1QueryApplicationAdapter(aggregateCache).execute<
      OverviewQuery,
      AnalyticsResult<OverviewResult>
    >(
      {
        operation: "site.analytics.overview",
        context: context.context,
        query: {
          context: context.context,
          time: time.value,
          filters: filter.value,
          scopePreference: parsed.value.scope ?? "auto",
        },
        providerRegistry,
        cache: {
          key: await aggregateCacheKey({
            operation: "site.analytics.overview",
            context,
            time: time.value,
            filters: filter.value,
            scopePreference: parsed.value.scope ?? "auto",
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
          metricCount,
          dimensionCardinality: filterConditionCount(filter.value),
          projectionFields: metricCount,
          pageLimit: 1,
          provider: "d1",
          batchFanout: 1,
        },
      },
    ),
  };
}
