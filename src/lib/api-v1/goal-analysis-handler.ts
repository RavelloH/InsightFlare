import {
  AnalysisDefinitionReadCancelledError,
  type AnalysisDefinitionReader,
} from "@/lib/api-v1/analysis-definition-reader";
import { parseApiV1FilterDsl } from "@/lib/api-v1/analytics-overview";
import {
  type AnalyticsTimeRangeInputDto,
  SiteGoalSummaryQueryDtoSchema,
  SiteGoalTimeseriesQueryDtoSchema,
} from "@/lib/api-v1/dto/analytics";
import {
  fromInputIssues,
  fromRequestBodyError,
  fromZodIssues,
} from "@/lib/api-v1/errors";
import { createApiV1QueryApplicationAdapter } from "@/lib/api-v1/query-application";
import { readBoundedJson } from "@/lib/api-v1/request-budget";
import { resolveApiV1TimeRange } from "@/lib/api-v1/time-range";
import {
  jsonError,
  jsonSuccess,
  methodNotAllowed,
} from "@/lib/api-v1/wire-helpers";
import {
  createOperationCacheKey,
  OperationResultCache,
} from "@/lib/edge/analytics/application/cache";
import {
  GOAL_TIMESERIES_MAX_BUCKETS,
  goalQueryCost,
} from "@/lib/edge/analytics/application/goal-cost";
import type { AnalyticsProviderRegistry } from "@/lib/edge/analytics/application/provider-registry";
import { queryGoalDefinition } from "@/lib/edge/analytics/composition/d1/goals";
import {
  attachSavedFilterScopePreference,
  createScopedFilterPlan,
  EMPTY_FILTER_DOCUMENT,
  filterConditionCount,
  type FilterDocument,
  filterFingerprint,
  parseApiV1FilterDocument,
  parseGoalFilter,
  reconcileFilterScopePreferences,
  resolveFilterScope,
  savedFilterScopePreferenceFromDocument,
  siteQueryContext,
} from "@/lib/edge/analytics/contract";
import type { ApiKeyPrincipal } from "@/lib/edge/api-key-auth";
import { canAccessSiteId } from "@/lib/edge/api-key-auth";
import type { Env } from "@/lib/edge/types";
import { sha256Hex } from "@/lib/edge/utils";
import { analyticsFilterRegistry } from "@/lib/filter-contract";

const MAX_BODY_BYTES = 64 * 1024;
export const goalAggregateCache = new OperationResultCache();
export const goalAggregateCachePolicy = {
  ttlMs: 30_000,
  maxEntries: 256,
} as const;

type GoalQueryInput = {
  readonly goalId: string;
  readonly timeRange: AnalyticsTimeRangeInputDto;
  readonly filter?:
    | { readonly type: "inline"; readonly expression: unknown }
    | { readonly type: "dsl"; readonly expression: string }
    | { readonly type: "saved"; readonly id: string }
    | null;
  readonly scope?: "auto" | "event" | "session" | "visitor";
  readonly interval?: "minute" | "hour" | "day" | "week" | "month";
};

function acceptsJson(request: Request): boolean {
  const accept = request.headers.get("accept");
  if (!accept || !accept.trim()) return true;
  return accept.split(",").some((part) => {
    const type = part.split(";", 1)[0]?.trim().toLowerCase();
    return (
      type === "application/json" || type === "application/*" || type === "*/*"
    );
  });
}

async function filterForInput(
  input: GoalQueryInput,
  siteId: string,
  definitions: AnalysisDefinitionReader | undefined,
  signal: AbortSignal | undefined,
): Promise<FilterDocument | null> {
  if (!input.filter) return EMPTY_FILTER_DOCUMENT;
  if (input.filter.type === "saved") {
    if (!definitions) return null;
    const resolved = await definitions.resolveTeamVisibleSavedFilter({
      siteId,
      id: input.filter.id,
      signal,
    });
    return resolved
      ? attachSavedFilterScopePreference(
          resolved.document,
          resolved.scopePreference ?? "auto",
        )
      : null;
  }
  if (input.filter.type === "dsl") {
    try {
      return parseApiV1FilterDsl(input.filter.expression);
    } catch {
      return null;
    }
  }
  try {
    return parseApiV1FilterDocument({
      version: 1,
      root: input.filter.expression,
    });
  } catch {
    return null;
  }
}

function requestError(
  request: Request,
  code:
    | "validation_failed"
    | "missing_scope"
    | "resource_not_found"
    | "internal_error"
    | "data_unavailable"
    | "unsupported_query"
    | "deadline_exceeded"
    | "not_acceptable"
    | "unsupported_media_type",
  message: string,
  status: number,
  issues?: readonly { path: string; code: string; message: string }[],
) {
  return jsonError(code, message, status, undefined, request, issues);
}

async function executeGoalQuery(
  env: Env,
  request: Request,
  principal: ApiKeyPrincipal,
  siteId: string,
  providerRegistry: AnalyticsProviderRegistry,
  definitions: AnalysisDefinitionReader | undefined,
  kind: "summary" | "timeseries",
  execution: {
    readonly signal?: AbortSignal;
    readonly deadlineMs?: number;
    readonly capturedAtMs?: number;
  },
): Promise<Response> {
  if (request.method !== "POST") return methodNotAllowed(request, "POST");
  if (request.headers.has("content-encoding"))
    return requestError(
      request,
      "unsupported_media_type",
      "Content-Encoding is not supported",
      415,
    );
  if (
    request.headers
      .get("content-type")
      ?.split(";", 1)[0]
      ?.trim()
      .toLowerCase() !== "application/json"
  )
    return requestError(
      request,
      "unsupported_media_type",
      "Expected application/json",
      415,
    );
  if (!acceptsJson(request))
    return requestError(
      request,
      "not_acceptable",
      "Only application/json is supported",
      406,
    );
  if (!principal.scopes.includes("analytics:read"))
    return requestError(
      request,
      "missing_scope",
      "The API key lacks analytics:read",
      403,
    );
  if (!canAccessSiteId(principal, siteId))
    return requestError(request, "resource_not_found", "Site not found", 404);

  let raw: unknown;
  try {
    raw = await readBoundedJson(request, MAX_BODY_BYTES);
  } catch (error) {
    return requestError(
      request,
      "validation_failed",
      "Request validation failed",
      422,
      fromRequestBodyError(error),
    );
  }
  const parsed = (
    kind === "summary"
      ? SiteGoalSummaryQueryDtoSchema
      : SiteGoalTimeseriesQueryDtoSchema
  ).safeParse(raw);
  if (!parsed.success)
    return requestError(
      request,
      "validation_failed",
      "Request validation failed",
      400,
      fromZodIssues(parsed.error.issues),
    );
  const value = parsed.data as GoalQueryInput;
  if (
    value.filter?.type === "saved" &&
    !principal.scopes.includes("analysis:read")
  )
    return requestError(
      request,
      "missing_scope",
      "The API key lacks analysis:read",
      403,
    );
  const resolved = resolveApiV1TimeRange(
    value.timeRange,
    execution.capturedAtMs ?? Date.now(),
  );
  if (!resolved)
    return requestError(
      request,
      "validation_failed",
      "Invalid time range",
      400,
      fromInputIssues([{ path: "timeRange", code: "invalid_time_range" }]),
    );
  let filters: FilterDocument | null;
  try {
    filters = await filterForInput(
      value,
      siteId,
      definitions,
      execution.signal,
    );
  } catch (error) {
    if (error instanceof AnalysisDefinitionReadCancelledError)
      return requestError(
        request,
        "data_unavailable",
        "Request cancelled",
        499,
      );
    return requestError(
      request,
      "internal_error",
      "Unable to resolve saved filter",
      500,
    );
  }
  if (!filters)
    return requestError(
      request,
      value.filter?.type === "saved"
        ? "resource_not_found"
        : "validation_failed",
      value.filter?.type === "saved"
        ? "Saved filter not found"
        : "Invalid filter",
      value.filter?.type === "saved" ? 404 : 400,
    );

  let goal;
  try {
    goal = await queryGoalDefinition(env, siteId, value.goalId);
  } catch {
    return requestError(
      request,
      "data_unavailable",
      "Goal data is unavailable",
      503,
    );
  }
  if (!goal)
    return requestError(request, "resource_not_found", "Goal not found", 404);

  const operation =
    kind === "summary"
      ? "site.analytics.goalSummary"
      : "site.analytics.goalTimeseries";
  const startMs = Date.parse(resolved.from);
  const endExclusiveMs = Date.parse(resolved.to);
  const cost = goalQueryCost({
    filters,
    startMs,
    endExclusiveMs,
    timeZone: resolved.timeZone,
    goalFilterComplexity: filterConditionCount(parseGoalFilter(goal)),
    ...(kind === "timeseries" ? { interval: value.interval } : {}),
  });
  if ((cost.bucketCount ?? 1) > GOAL_TIMESERIES_MAX_BUCKETS)
    return requestError(
      request,
      "validation_failed",
      "The requested time range contains too many buckets",
      422,
    );
  const query = {
    siteId,
    goalId: value.goalId,
    filters,
    scopePreference: value.scope ?? "auto",
    ...(kind === "timeseries" ? { interval: value.interval } : {}),
    window: {
      startMs,
      endExclusiveMs,
      nowMs: execution.capturedAtMs ?? Date.now(),
      timeZone: resolved.timeZone,
    },
  };
  const context = siteQueryContext(siteId, "api-v1");
  const requestedScope = value.scope ?? "auto";
  const savedScope = savedFilterScopePreferenceFromDocument(filters) ?? "auto";
  let resolvedScope = "scope_conflict";
  let scopePlan: unknown = null;
  try {
    const reconciledScope = reconcileFilterScopePreferences(
      requestedScope,
      savedScope,
    );
    const canonicalOperation =
      kind === "summary" ? "goal-summary" : "goal-timeseries";
    resolvedScope =
      resolveFilterScope(canonicalOperation, reconciledScope) ?? "none";
    scopePlan = createScopedFilterPlan(
      canonicalOperation,
      filters,
      reconciledScope,
    );
  } catch {
    // The typed application service owns the public validation response. Keep
    // invalid scope combinations isolated from successful cache entries.
  }
  const cacheKey = await createOperationCacheKey({
    contractRevision: "1",
    operation,
    operationRevision: "1",
    subjectFingerprint: await sha256Hex(JSON.stringify(context.subject)),
    policyRevision: context.policy.revision,
    query: {
      siteId,
      goalSemanticFingerprint: goal.semanticFingerprint,
      globalFilterFingerprint: filterFingerprint(
        filters,
        analyticsFilterRegistry,
      ),
      from: startMs,
      to: endExclusiveMs,
      timeZone: resolved.timeZone,
      resolvedScope,
      scopePlan,
      ...(kind === "timeseries" ? { interval: value.interval } : {}),
    },
  });
  try {
    const result = await createApiV1QueryApplicationAdapter(
      goalAggregateCache,
    ).execute(
      {
        operation,
        context,
        query,
        providerRegistry,
        cache: {
          key: cacheKey,
          policy: goalAggregateCachePolicy,
          isCacheable: (value) => Boolean(value),
        },
      },
      { ...execution, cost },
    );
    if (!result.ok) {
      if (result.error.kind === "deadline-exceeded")
        return requestError(
          request,
          "deadline_exceeded",
          "The analytics query exceeded its deadline",
          504,
        );
      if (result.error.kind === "invalid-input")
        return requestError(
          request,
          "validation_failed",
          "Request validation failed",
          400,
          fromInputIssues(result.error.issues),
        );
      if (result.error.kind === "request-cancelled")
        return requestError(
          request,
          "data_unavailable",
          "Request cancelled",
          499,
        );
      return requestError(
        request,
        "unsupported_query",
        "The query exceeds the configured cost budget",
        422,
      );
    }
    if (!result.value)
      return requestError(request, "resource_not_found", "Goal not found", 404);
    return jsonSuccess(result.value, {
      request,
      meta: {
        timeRange: resolved,
        source: "raw",
        accuracy: "exact",
        ...(result.meta?.filterScope
          ? { filterScope: result.meta.filterScope }
          : {}),
      },
    });
  } catch {
    return requestError(
      request,
      "data_unavailable",
      "Goal data is unavailable",
      503,
    );
  }
}

export function handlePlannedSiteGoalSummary(
  env: Env,
  request: Request,
  principal: ApiKeyPrincipal,
  siteId: string,
  providerRegistry: AnalyticsProviderRegistry,
  definitions?: AnalysisDefinitionReader,
  execution: {
    readonly signal?: AbortSignal;
    readonly deadlineMs?: number;
    readonly capturedAtMs?: number;
  } = {},
) {
  return executeGoalQuery(
    env,
    request,
    principal,
    siteId,
    providerRegistry,
    definitions,
    "summary",
    execution,
  );
}

export function handlePlannedSiteGoalTimeseries(
  env: Env,
  request: Request,
  principal: ApiKeyPrincipal,
  siteId: string,
  providerRegistry: AnalyticsProviderRegistry,
  definitions?: AnalysisDefinitionReader,
  execution: {
    readonly signal?: AbortSignal;
    readonly deadlineMs?: number;
    readonly capturedAtMs?: number;
  } = {},
) {
  return executeGoalQuery(
    env,
    request,
    principal,
    siteId,
    providerRegistry,
    definitions,
    "timeseries",
    execution,
  );
}
