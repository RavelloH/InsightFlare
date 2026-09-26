import type { ZodType } from "zod";

import {
  type AnalysisDefinitionReader,
  parseApiV1FilterDsl,
  resolveApiV1Filter,
} from "@/lib/api-v1/analytics/overview";
import { createApiV1QueryApplicationAdapter } from "@/lib/api-v1/analytics/query-application";
import { createApiV1SiteQueryContext } from "@/lib/api-v1/analytics/query-context";
import {
  resolveApiV1ComparisonDatasetTimeRange,
  resolveApiV1PreviousPeriod,
} from "@/lib/api-v1/analytics/time-range";
import { readBoundedJson } from "@/lib/api-v1/application/request-budget";
import {
  type ComparisonDatasetTimeRangeDto,
  type SiteComparisonBreakdownV2QueryDto,
  SiteComparisonBreakdownV2QueryDtoSchema,
  type SiteComparisonQueryDto,
  SiteComparisonQueryDtoSchema,
  type TeamComparisonBreakdownV2QueryDto,
  TeamComparisonBreakdownV2QueryDtoSchema,
  type TeamComparisonQueryDto,
  TeamComparisonQueryDtoSchema,
} from "@/lib/api-v1/contract/dto/analytics";
import {
  type ApiV1ErrorCode,
  type ApiV1ErrorIssue,
  apiV1ErrorRegistry,
  fromInputIssues,
  fromRequestBodyError,
  fromZodIssues,
} from "@/lib/api-v1/contract/errors";
import { OperationResultCache } from "@/lib/edge/analytics/application/cache";
import {
  comparisonCacheKey,
  comparisonCachePolicy,
} from "@/lib/edge/analytics/application/comparison-cache";
import {
  exceedsQueryCost,
  type QueryCostInput,
} from "@/lib/edge/analytics/application/cost";
import type { QueryExecutionContext } from "@/lib/edge/analytics/application/service";
import type { AnalyticsQueryRuntime } from "@/lib/edge/analytics/composition/query-runtime";
import {
  type AnalyticsDomainError,
  type ComparisonBreakdownQuery,
  type ComparisonMetricKey,
  type ComparisonQuery,
  type ComparisonResult,
  type ComparisonTrendQuery,
  type ComparisonTrendResult,
  createQueryTime,
  createScopedFilterPlan,
  filterConditionCount,
  type FilterDocument,
  type FilterScopePreference,
  isReportingTimeZone,
  parseApiV1FilterDocument,
  type QueryContext,
  type QueryResultMeta,
  reconcileFilterScopePreferences,
  savedFilterScopePreferenceFromDocument,
  teamQueryContext,
} from "@/lib/edge/analytics/contract";
import { ANALYTICS_DIMENSIONS } from "@/lib/edge/analytics/contract/catalog";
import { buildCalendarBucketPlan } from "@/lib/edge/analytics/contract/helpers";
import type { ApiKeyPrincipal } from "@/lib/edge/auth/api-key-auth";
import { filterUsesRequestClock } from "@/lib/filter-contract/filter-types";
const MAX_BODY_BYTES = 64 * 1024;
const MAX_COMPARISON_RANGE_MS = 366 * 24 * 60 * 60 * 1000;
const comparisonCache = new OperationResultCache();
type RequestExecutionContext = QueryExecutionContext & {
  readonly request: Request;
};
type SiteReportInput = SiteComparisonQueryDto;
type TeamReportInput = TeamComparisonQueryDto;
type SiteBreakdownInput = SiteComparisonBreakdownV2QueryDto;
type TeamBreakdownInput = TeamComparisonBreakdownV2QueryDto;
type SiteComparisonBaseInput = Pick<
  SiteReportInput,
  "current" | "reference" | "timeZone" | "scope"
>;
type ResolvedSide = {
  readonly time: ReturnType<typeof createQueryTime>;
  readonly filters: FilterDocument;
  readonly from: string;
  readonly to: string;
  readonly scopePreference: FilterScopePreference;
};
type ComparisonReportResult = ComparisonResult & {
  readonly trend?: ComparisonTrendResult;
};
type ComparisonQueryRuntime = Pick<AnalyticsQueryRuntime, "execute"> & {
  readonly readSiteCount: () => Promise<number>;
};
function response(
  status: number,
  body: unknown,
  requestId = crypto.randomUUID(),
) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
      "X-Request-Id": requestId,
    },
  });
}
function errorResponse(
  code: ApiV1ErrorCode,
  request: Request,
  issues?: readonly ApiV1ErrorIssue[],
): Response {
  const requestId = crypto.randomUUID();
  const definition = apiV1ErrorRegistry[code];
  return response(
    definition.status,
    {
      error: {
        code,
        message: definition.message,
        retryable: definition.retryable,
        ...(issues && issues.length > 0 ? { issues } : {}),
      },
      meta: { requestId },
    },
    requestId,
  );
}
function acceptsJson(request: Request): boolean {
  const accept = request.headers.get("accept");
  if (!accept || accept.trim() === "") return true;
  return accept.split(",").some((part) => {
    const type = part.split(";", 1)[0]?.trim().toLowerCase();
    return (
      type === "application/json" || type === "application/*" || type === "*/*"
    );
  });
}
async function parseBody<T>(
  request: Request,
  schema: ZodType<T>,
): Promise<T | Response> {
  if (request.method !== "POST") {
    const result = errorResponse("method_not_allowed", request);
    result.headers.set("Allow", "POST");
    return result;
  }
  if (request.headers.has("content-encoding")) {
    return errorResponse("unsupported_media_type", request);
  }
  if (
    request.headers
      .get("content-type")
      ?.split(";", 1)[0]
      ?.trim()
      .toLowerCase() !== "application/json"
  ) {
    return errorResponse("unsupported_media_type", request);
  }
  if (!acceptsJson(request)) return errorResponse("not_acceptable", request);
  try {
    const parsed = schema.safeParse(
      await readBoundedJson(request, MAX_BODY_BYTES),
    );
    if (!parsed.success) {
      return errorResponse(
        "validation_failed",
        request,
        fromZodIssues(parsed.error.issues),
      );
    }
    return parsed.data;
  } catch (error) {
    return errorResponse(
      "validation_failed",
      request,
      fromRequestBodyError(error),
    );
  }
}
function isResponse(value: unknown): value is Response {
  return value instanceof Response;
}
function emptyFilter(): FilterDocument {
  return { version: 1, root: null };
}
async function resolveSiteFilter(
  siteId: string,
  filter: SiteReportInput["current"]["filter"],
  definitions: AnalysisDefinitionReader | undefined,
  signal: AbortSignal | undefined,
): Promise<FilterDocument | Error> {
  const result = await resolveApiV1Filter(siteId, filter, definitions, signal);
  if (result.ok) return result.value;
  if (result.error.kind === "missing_scope") return new Error("missing_scope");
  if (
    result.error.kind === "site_not_found" ||
    result.error.kind === "saved_filter_not_available"
  ) {
    return new Error("resource_not_found");
  }
  if (result.error.kind === "request_cancelled")
    return new Error("request_cancelled");
  if (result.error.kind === "invalid_input")
    return new Error("validation_failed");
  return new Error("internal_error");
}
function resolveTeamFilter(
  filter: TeamReportInput["current"]["filter"],
): FilterDocument {
  if (!filter) return emptyFilter();
  if (filter.type === "dsl") return parseApiV1FilterDsl(filter.expression);
  return parseApiV1FilterDocument({ version: 1, root: filter.expression });
}
function sideRange(
  input: {
    readonly timeRange: ComparisonDatasetTimeRangeDto;
  },
  timeZone: string,
  capturedAtMs: number,
) {
  return resolveApiV1ComparisonDatasetTimeRange(
    input.timeRange,
    timeZone,
    capturedAtMs,
  );
}
function toSide(
  range: {
    readonly from: string;
    readonly to: string;
    readonly timeZone: string;
  },
  filters: FilterDocument,
  scopePreference: FilterScopePreference,
  capturedAtMs: number,
): ResolvedSide | null {
  const fromMs = Date.parse(range.from);
  const toMs = Date.parse(range.to);
  if (
    !Number.isSafeInteger(fromMs) ||
    !Number.isSafeInteger(toMs) ||
    toMs <= fromMs
  )
    return null;
  return {
    time: createQueryTime(fromMs, toMs, range.timeZone, capturedAtMs),
    filters,
    from: range.from,
    to: range.to,
    scopePreference,
  };
}
function resolveSides(
  input: {
    readonly current: SiteReportInput["current"] | TeamReportInput["current"];
    readonly reference:
      SiteReportInput["reference"] | TeamReportInput["reference"];
    readonly timeZone: string;
    readonly scope?: FilterScopePreference;
  },
  filters: {
    readonly current: FilterDocument;
    readonly reference: FilterDocument;
  },
  capturedAtMs: number,
) {
  if (!isReportingTimeZone(input.timeZone)) return null;
  const currentRange = sideRange(input.current, input.timeZone, capturedAtMs);
  if (!currentRange) return null;
  const referenceRange =
    input.reference.timeRange.kind === "previous_period"
      ? resolveApiV1PreviousPeriod(currentRange)?.b
      : sideRange(
          { timeRange: input.reference.timeRange },
          input.timeZone,
          capturedAtMs,
        );
  if (!referenceRange) return null;
  const scopePreference = input.scope ?? "auto";
  const current = toSide(
    currentRange,
    filters.current,
    scopePreference,
    capturedAtMs,
  );
  const reference = toSide(
    referenceRange,
    filters.reference,
    scopePreference,
    capturedAtMs,
  );
  return current && reference ? { current, reference } : null;
}
function rangeMs(side: ResolvedSide) {
  return side.time.range.endExclusiveMs - side.time.range.startMs;
}
function validateRangeSize(current: ResolvedSide, reference: ResolvedSide) {
  return (
    rangeMs(current) <= MAX_COMPARISON_RANGE_MS &&
    rangeMs(reference) <= MAX_COMPARISON_RANGE_MS
  );
}
function trendInterval(input: SiteReportInput | TeamReportInput) {
  return input.select.trend?.interval;
}
function trendMetrics(input: SiteReportInput | TeamReportInput) {
  return input.select.trend?.metrics as
    readonly ComparisonMetricKey[] | undefined;
}
function metricKeys(input: SiteReportInput | TeamReportInput) {
  return input.select.metrics as readonly ComparisonMetricKey[];
}
function sideIssue(path: string, code: string) {
  return fromInputIssues([{ path, code }]);
}
function contextForSite(
  principal: ApiKeyPrincipal,
  siteId: string,
): QueryContext | Error {
  const result = createApiV1SiteQueryContext(principal, siteId);
  if (result.ok) return result.context;
  return new Error(result.error);
}
function subjectFingerprint(context: QueryContext) {
  return JSON.stringify(context.subject);
}
function domainErrorCode(error: { readonly kind: string }): ApiV1ErrorCode {
  if (error.kind === "query-cost-exceeded") return "query_too_expensive";
  if (error.kind === "request-cancelled") return "request_cancelled";
  if (error.kind === "deadline-exceeded") return "deadline_exceeded";
  if (error.kind === "comparison-alignment-mismatch")
    return "comparison_alignment_mismatch";
  if (error.kind === "dimension-not-supported")
    return "dimension_not_supported";
  if (error.kind === "range-not-supported") {
    return (error as AnalyticsDomainError & { readonly reason?: string })
      .reason === "too-many-buckets"
      ? "too_many_buckets"
      : "range_too_wide";
  }
  if (error.kind === "capability-denied") return "dimension_not_supported";
  if (error.kind === "invalid-input") return "validation_failed";
  if (error.kind === "data-unavailable") return "data_unavailable";
  return "internal_error";
}
function domainErrorResponse(
  error: {
    readonly kind: string;
    readonly issues?: readonly {
      readonly path: string;
      readonly code: string;
      readonly message?: string;
    }[];
  },
  request: Request,
): Response {
  return errorResponse(
    domainErrorCode(error),
    request,
    error.issues ? fromInputIssues(error.issues) : undefined,
  );
}
function queryCost(input: {
  readonly current: ResolvedSide;
  readonly reference: ResolvedSide;
  readonly context: QueryContext;
  readonly metricCount: number;
  readonly trendBuckets: number;
  readonly breakdownLimit?: number;
  readonly siteCount?: number;
}): QueryCostInput {
  return {
    rangeMs: rangeMs(input.current) + rangeMs(input.reference),
    sideCount: 2,
    siteCount:
      input.siteCount ??
      (input.context.subject.kind === "team"
        ? Math.max(1, input.context.subject.authorizedSiteIds.length)
        : 1),
    metricCount: input.metricCount,
    bucketCount: input.trendBuckets,
    dimensionCardinality: input.breakdownLimit ? 500 : 1,
    filterComplexity:
      filterConditionCount(input.current.filters) +
      filterConditionCount(input.reference.filters),
    breakdownLimit: input.breakdownLimit,
    projectionFields: input.metricCount,
    pageLimit: input.breakdownLimit ?? 1,
    provider: "d1",
    batchFanout: 2,
  };
}
function cacheQuery(input: {
  readonly current: ResolvedSide;
  readonly reference: ResolvedSide;
  readonly context: QueryContext;
  readonly selection: unknown;
  readonly operation: string;
  readonly dimension?: string;
  readonly sort?: unknown;
  readonly limit?: number;
}) {
  const scopeSemantics = (side: ResolvedSide) => {
    try {
      const reconciledScope = reconcileFilterScopePreferences(
        side.scopePreference,
        savedFilterScopePreferenceFromDocument(side.filters) ?? "auto",
      );
      const plan = createScopedFilterPlan(
        "comparison",
        side.filters,
        reconciledScope,
      );
      return plan
        ? { resolvedScope: plan.scope, scopePlan: plan }
        : { resolvedScope: "none", scopePlan: null };
    } catch {
      return { resolvedScope: "conflict", scopePlan: null };
    }
  };
  const currentScope = scopeSemantics(input.current);
  const referenceScope = scopeSemantics(input.reference);
  return comparisonCacheKey({
    operation: input.operation,
    subjectFingerprint:
      input.context.subject.kind === "team"
        ? JSON.stringify({
            kind: "team",
            teamId: input.context.subject.teamId,
            authorizedSiteIds: [
              ...input.context.subject.authorizedSiteIds,
            ].sort(),
          })
        : subjectFingerprint(input.context),
    policyRevision: input.context.policy.revision,
    query: {
      current: {
        from: input.current.from,
        to: input.current.to,
        timeZone: input.current.time.reportingTimeZone,
        filters: input.current.filters,
        ...(filterUsesRequestClock(input.current.filters)
          ? { capturedAtMs: input.current.time.capturedAtMs }
          : {}),
        ...currentScope,
      },
      reference: {
        from: input.reference.from,
        to: input.reference.to,
        timeZone: input.reference.time.reportingTimeZone,
        filters: input.reference.filters,
        ...(filterUsesRequestClock(input.reference.filters)
          ? { capturedAtMs: input.reference.time.capturedAtMs }
          : {}),
        ...referenceScope,
      },
      selection: input.selection,
      dimension: input.dimension ?? null,
      sort: input.sort ?? null,
      limit: input.limit ?? null,
    },
  });
}
function rangeWire(side: ResolvedSide) {
  return {
    from: side.from,
    to: side.to,
    timeZone: side.time.reportingTimeZone,
  };
}
function reportWire(
  result: ComparisonReportResult,
  sides: { readonly current: ResolvedSide; readonly reference: ResolvedSide },
  requestId: string,
  filterScope?: QueryResultMeta["filterScope"],
  queryMeta?: QueryResultMeta,
) {
  const trendData = result.trend ?? null;
  return {
    data: {
      current: { metrics: result.current },
      reference: { metrics: result.reference },
      change: result.change,
      ...(trendData
        ? {
            trend: {
              interval: trendData.interval,
              alignment: "period_index" as const,
              points: trendData.points.map((point) => ({
                index: point.index,
                current: {
                  from: new Date(point.current.fromMs).toISOString(),
                  to: new Date(point.current.toMs).toISOString(),
                  metrics: point.current.metrics,
                },
                reference: {
                  from: new Date(point.reference.fromMs).toISOString(),
                  to: new Date(point.reference.toMs).toISOString(),
                  metrics: point.reference.metrics,
                },
                change: point.change,
              })),
            },
          }
        : {}),
    },
    meta: {
      requestId,
      generatedAt: new Date().toISOString(),
      current: {
        range: rangeWire(sides.current),
        source: queryMeta?.source ?? "raw",
        accuracy: queryMeta?.approximateVisitors ? "approximate" : "exact",
      },
      reference: {
        range: rangeWire(sides.reference),
        source: queryMeta?.source ?? "raw",
        accuracy: queryMeta?.approximateVisitors ? "approximate" : "exact",
      },
      ...(filterScope ? { filterScope } : {}),
    },
  };
}
async function executeReport(
  runtime: ComparisonQueryRuntime,
  context: QueryContext,
  sides: { readonly current: ResolvedSide; readonly reference: ResolvedSide },
  metrics: readonly ComparisonMetricKey[],
  interval: ComparisonTrendQuery["interval"] | undefined,
  selectedTrendMetrics: readonly ComparisonMetricKey[] | undefined,
  operation: "site.analytics.comparison" | "team.analytics.comparison",
  executionContext: QueryExecutionContext,
  cacheKey: string,
) {
  const query: ComparisonQuery & {
    readonly interval?: ComparisonTrendQuery["interval"];
    readonly trendMetrics?: readonly ComparisonMetricKey[];
  } = {
    context,
    scopePreference: sides.current.scopePreference,
    current: { time: sides.current.time, filters: sides.current.filters },
    reference: { time: sides.reference.time, filters: sides.reference.filters },
    metrics,
    ...(interval
      ? {
          interval,
          trendMetrics: selectedTrendMetrics ?? metrics,
        }
      : {}),
  };
  const service = createApiV1QueryApplicationAdapter(comparisonCache);
  return service.execute(
    {
      operation,
      context,
      query,
      cache: {
        key: cacheKey,
        policy: comparisonCachePolicy,
      },
      executor: runtime,
    },
    executionContext,
  );
}
async function executeBreakdown(
  runtime: ComparisonQueryRuntime,
  context: QueryContext,
  sides: { readonly current: ResolvedSide; readonly reference: ResolvedSide },
  dimension: string,
  limit: number,
  sort: ComparisonBreakdownQuery["sort"],
  operation:
    "site.analytics.comparisonBreakdown" | "team.analytics.comparisonBreakdown",
  executionContext: QueryExecutionContext,
  cacheKey: string,
) {
  const query: ComparisonBreakdownQuery = {
    context,
    scopePreference: sides.current.scopePreference,
    current: { time: sides.current.time, filters: sides.current.filters },
    reference: { time: sides.reference.time, filters: sides.reference.filters },
    metrics: ["views", "sessions", "visitors"],
    dimension,
    limit,
    sort,
  };
  return createApiV1QueryApplicationAdapter(comparisonCache).execute(
    {
      operation,
      context,
      query,
      cache: {
        key: cacheKey,
        policy: comparisonCachePolicy,
      },
      executor: runtime,
    },
    executionContext,
  );
}
async function prepareSiteReport(
  input: SiteComparisonBaseInput,
  principal: ApiKeyPrincipal,
  siteId: string,
  definitions: AnalysisDefinitionReader | undefined,
  executionContext: RequestExecutionContext,
): Promise<
  | {
      readonly ok: true;
      readonly context: QueryContext;
      readonly sides: { current: ResolvedSide; reference: ResolvedSide };
    }
  | { readonly ok: false; readonly response: Response }
> {
  const context = contextForSite(principal, siteId);
  if (context instanceof Error) {
    const code: ApiV1ErrorCode =
      context.message === "missing_scope" ||
      context.message === "token_inactive"
        ? "missing_scope"
        : context.message === "site_not_found"
          ? "resource_not_found"
          : "internal_error";
    return {
      ok: false,
      response: errorResponse(code, executionContext.request),
    };
  }
  if (
    (input.current.filter?.type === "saved" ||
      input.reference.filter?.type === "saved") &&
    !principal.scopes.includes("analysis:read")
  ) {
    return {
      ok: false,
      response: errorResponse("missing_scope", executionContext.request),
    };
  }
  const request = executionContext.request;
  const filters = await Promise.all([
    resolveSiteFilter(
      siteId,
      input.current.filter,
      definitions,
      executionContext.signal,
    ),
    resolveSiteFilter(
      siteId,
      input.reference.filter,
      definitions,
      executionContext.signal,
    ),
  ]);
  if (filters.some((value) => value instanceof Error)) {
    const errorIndex = filters.findIndex((value) => value instanceof Error);
    const error = filters[errorIndex] as Error;
    return {
      ok: false,
      response: errorResponse(
        error.message as ApiV1ErrorCode,
        request,
        error.message === "validation_failed"
          ? sideIssue(
              `${errorIndex === 0 ? "current" : "reference"}.filter`,
              "invalid_filter",
            )
          : undefined,
      ),
    };
  }
  const sides = resolveSides(
    input,
    {
      current: filters[0] as FilterDocument,
      reference: filters[1] as FilterDocument,
    },
    executionContext.capturedAtMs ?? Date.now(),
  );
  if (!sides) {
    return {
      ok: false,
      response: errorResponse(
        "validation_failed",
        request,
        sideIssue("timeRange", "invalid_time_range"),
      ),
    };
  }
  return { ok: true, context, sides };
}
function prepareTeamSides(
  input: TeamReportInput | TeamBreakdownInput,
  principal: ApiKeyPrincipal,
  executionContext: QueryExecutionContext,
):
  | {
      readonly ok: true;
      readonly context: QueryContext;
      readonly sides: { current: ResolvedSide; reference: ResolvedSide };
    }
  | {
      readonly ok: false;
      readonly error: ApiV1ErrorCode;
      readonly issues?: readonly ApiV1ErrorIssue[];
    } {
  let filters: {
    readonly current: FilterDocument;
    readonly reference: FilterDocument;
  };
  try {
    filters = {
      current: resolveTeamFilter(input.current.filter),
      reference: resolveTeamFilter(input.reference.filter),
    };
  } catch {
    return {
      ok: false,
      error: "validation_failed",
      issues: sideIssue("filter", "invalid_filter"),
    };
  }
  const sides = resolveSides(
    input,
    filters,
    executionContext.capturedAtMs ?? Date.now(),
  );
  if (!sides) {
    return {
      ok: false,
      error: "validation_failed",
      issues: sideIssue("timeRange", "invalid_time_range"),
    };
  }
  return {
    ok: true,
    context: teamQueryContext(
      principal.teamId,
      "api-v1",
      [...principal.siteIds].sort(),
    ),
    sides,
  };
}
async function reportHandler(
  request: Request,
  runtime: ComparisonQueryRuntime,
  input: SiteReportInput | TeamReportInput,
  context: QueryContext,
  sides: { readonly current: ResolvedSide; readonly reference: ResolvedSide },
  operation: "site.analytics.comparison" | "team.analytics.comparison",
): Promise<Response> {
  if (!validateRangeSize(sides.current, sides.reference))
    return errorResponse(
      "range_too_wide",
      request,
      sideIssue("current.timeRange", "range_too_wide"),
    );
  const interval = trendInterval(input);
  let bucketCount = 0;
  if (interval) {
    try {
      const currentPlan = buildCalendarBucketPlan({
        range: sides.current.time.range,
        granularity: interval,
        reportingTimeZone: sides.current.time.reportingTimeZone,
      });
      const referencePlan = buildCalendarBucketPlan({
        range: sides.reference.time.range,
        granularity: interval,
        reportingTimeZone: sides.reference.time.reportingTimeZone,
      });
      if (currentPlan.truncated || referencePlan.truncated)
        return errorResponse(
          "too_many_buckets",
          request,
          sideIssue("select.trend", "too_many_buckets"),
        );
      if (currentPlan.buckets.length !== referencePlan.buckets.length)
        return errorResponse(
          "comparison_alignment_mismatch",
          request,
          sideIssue("select.trend", "comparison_alignment_mismatch"),
        );
      bucketCount = currentPlan.buckets.length + referencePlan.buckets.length;
    } catch {
      return errorResponse(
        "too_many_buckets",
        request,
        sideIssue("select.trend", "too_many_buckets"),
      );
    }
  }
  const selectedMetrics = new Set<ComparisonMetricKey>([
    ...metricKeys(input),
    ...(trendMetrics(input) ?? []),
  ]);
  const cost = queryCost({
    current: sides.current,
    reference: sides.reference,
    context,
    metricCount: selectedMetrics.size,
    trendBuckets: bucketCount,
    siteCount: await runtime.readSiteCount(),
  });
  if (exceedsQueryCost(cost))
    return errorResponse(
      "query_too_expensive",
      request,
      sideIssue("select", "estimated_cost_exceeded"),
    );
  const cacheKey = await cacheQuery({
    current: sides.current,
    reference: sides.reference,
    context,
    selection: input.select,
    operation,
  });
  let result;
  try {
    result = await executeReport(
      runtime,
      context,
      sides,
      metricKeys(input),
      interval,
      trendMetrics(input),
      operation,
      { ...executionContextFor(request), cost },
      cacheKey,
    );
  } catch {
    return errorResponse("internal_error", request);
  }
  if (!result.ok) {
    if (result.error.kind === "domain-error") {
      return domainErrorResponse(result.error.error, request);
    }
    const code =
      result.error.kind === "query-cost-exceeded"
        ? "query_too_expensive"
        : result.error.kind === "request-cancelled"
          ? "request_cancelled"
          : result.error.kind === "deadline-exceeded"
            ? "deadline_exceeded"
            : result.error.kind === "invalid-input" &&
                result.error.issues.some(
                  (issue) => issue.code === "scope_conflict",
                )
              ? "conflict"
              : result.error.kind === "invalid-input"
                ? "validation_failed"
                : "internal_error";
    return errorResponse(
      code,
      request,
      result.error.kind === "invalid-input"
        ? fromInputIssues(result.error.issues)
        : undefined,
    );
  }
  const domain = result.value;
  const requestId = crypto.randomUUID();
  return response(
    200,
    reportWire(domain, sides, requestId, result.meta?.filterScope, result.meta),
    requestId,
  );
}
function executionContextFor(
  request: Request,
): QueryExecutionContext & { readonly request: Request } {
  return { request, signal: request.signal, capturedAtMs: Date.now() };
}
async function breakdownHandler(
  request: Request,
  runtime: ComparisonQueryRuntime,
  input: SiteBreakdownInput | TeamBreakdownInput,
  context: QueryContext,
  sides: { readonly current: ResolvedSide; readonly reference: ResolvedSide },
  dimension: string,
  operation:
    "site.analytics.comparisonBreakdown" | "team.analytics.comparisonBreakdown",
): Promise<Response> {
  if (
    !ANALYTICS_DIMENSIONS.includes(
      dimension as (typeof ANALYTICS_DIMENSIONS)[number],
    )
  )
    return errorResponse(
      "dimension_not_supported",
      request,
      sideIssue("dimension", "dimension_not_supported"),
    );
  if (!validateRangeSize(sides.current, sides.reference))
    return errorResponse(
      "range_too_wide",
      request,
      sideIssue("current.timeRange", "range_too_wide"),
    );
  const cost = queryCost({
    current: sides.current,
    reference: sides.reference,
    context,
    metricCount: 3,
    trendBuckets: 0,
    breakdownLimit: input.limit,
    siteCount: await runtime.readSiteCount(),
  });
  if (exceedsQueryCost(cost))
    return errorResponse(
      "query_too_expensive",
      request,
      sideIssue("limit", "estimated_cost_exceeded"),
    );
  const cacheKey = await cacheQuery({
    current: sides.current,
    reference: sides.reference,
    context,
    selection: { metrics: ["views", "sessions", "visitors"] },
    operation,
    dimension,
    sort: input.sort,
    limit: input.limit,
  });
  let result;
  try {
    result = await executeBreakdown(
      runtime,
      context,
      sides,
      dimension,
      input.limit,
      input.sort,
      operation,
      { ...executionContextFor(request), cost },
      cacheKey,
    );
  } catch {
    return errorResponse("internal_error", request);
  }
  if (!result.ok) {
    if (result.error.kind === "domain-error") {
      return domainErrorResponse(result.error.error, request);
    }
    const code =
      result.error.kind === "query-cost-exceeded"
        ? "query_too_expensive"
        : result.error.kind === "request-cancelled"
          ? "request_cancelled"
          : result.error.kind === "deadline-exceeded"
            ? "deadline_exceeded"
            : result.error.kind === "invalid-input" &&
                result.error.issues.some(
                  (issue) => issue.code === "scope_conflict",
                )
              ? "conflict"
              : result.error.kind === "invalid-input"
                ? "validation_failed"
                : "internal_error";
    return errorResponse(
      code,
      request,
      result.error.kind === "invalid-input"
        ? fromInputIssues(result.error.issues)
        : undefined,
    );
  }
  const domain = result.value;
  const requestId = crypto.randomUUID();
  return response(
    200,
    {
      data: {
        dimension,
        items: domain.items,
        coverage: {
          complete: domain.complete,
          strategy: "full_comparison_aggregate",
        },
      },
      meta: {
        requestId,
        generatedAt: new Date().toISOString(),
        current: {
          range: rangeWire(sides.current),
          source: result.meta?.source ?? "raw",
          accuracy: "exact",
        },
        reference: {
          range: rangeWire(sides.reference),
          source: result.meta?.source ?? "raw",
          accuracy: "exact",
        },
        ...(result.meta?.filterScope
          ? { filterScope: result.meta.filterScope }
          : {}),
      },
    },
    requestId,
  );
}
export async function handleSiteComparison(
  request: Request,
  principal: ApiKeyPrincipal,
  runtime: ComparisonQueryRuntime,
  siteId: string,
  definitions?: AnalysisDefinitionReader,
): Promise<Response> {
  const parsed = await parseBody<SiteReportInput>(
    request,
    SiteComparisonQueryDtoSchema,
  );
  if (isResponse(parsed)) return parsed;
  const prepared = await prepareSiteReport(
    parsed,
    principal,
    siteId,
    definitions,
    executionContextFor(request),
  );
  if (!prepared.ok) return prepared.response;
  return reportHandler(
    request,
    runtime,
    parsed,
    prepared.context,
    prepared.sides,
    "site.analytics.comparison",
  );
}
export async function handleTeamComparison(
  request: Request,
  principal: ApiKeyPrincipal,
  runtime: ComparisonQueryRuntime,
): Promise<Response> {
  const parsed = await parseBody<TeamReportInput>(
    request,
    TeamComparisonQueryDtoSchema,
  );
  if (isResponse(parsed)) return parsed;
  const prepared = prepareTeamSides(
    parsed,
    principal,
    executionContextFor(request),
  );
  if (!prepared.ok)
    return errorResponse(prepared.error, request, prepared.issues);
  return reportHandler(
    request,
    runtime,
    parsed,
    prepared.context,
    prepared.sides,
    "team.analytics.comparison",
  );
}
export async function handleSiteComparisonBreakdown(
  request: Request,
  principal: ApiKeyPrincipal,
  runtime: ComparisonQueryRuntime,
  siteId: string,
  dimension: string,
  definitions?: AnalysisDefinitionReader,
): Promise<Response> {
  const parsed = await parseBody<SiteBreakdownInput>(
    request,
    SiteComparisonBreakdownV2QueryDtoSchema,
  );
  if (isResponse(parsed)) return parsed;
  const prepared = await prepareSiteReport(
    parsed,
    principal,
    siteId,
    definitions,
    executionContextFor(request),
  );
  if (!prepared.ok) return prepared.response;
  return breakdownHandler(
    request,
    runtime,
    parsed,
    prepared.context,
    prepared.sides,
    dimension,
    "site.analytics.comparisonBreakdown",
  );
}
export async function handleTeamComparisonBreakdown(
  request: Request,
  principal: ApiKeyPrincipal,
  runtime: ComparisonQueryRuntime,
  dimension: string,
): Promise<Response> {
  const parsed = await parseBody<TeamBreakdownInput>(
    request,
    TeamComparisonBreakdownV2QueryDtoSchema,
  );
  if (isResponse(parsed)) return parsed;
  const prepared = prepareTeamSides(
    parsed,
    principal,
    executionContextFor(request),
  );
  if (!prepared.ok)
    return errorResponse(prepared.error, request, prepared.issues);
  return breakdownHandler(
    request,
    runtime,
    parsed,
    prepared.context,
    prepared.sides,
    dimension,
    "team.analytics.comparisonBreakdown",
  );
}
