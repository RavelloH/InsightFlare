import { type TypedQueryProviderRegistry } from "@/lib/edge/analytics/application/provider-registry";
import {
  currentInvocationLogger,
  errorLogData,
} from "@/lib/edge/observability-logger";

import { analyticsFilterRegistry } from "./filter-registry";
import { assertFilterAudience, filterConditionCount } from "./filters";
import { EMPTY_FILTER_DOCUMENT } from "./helpers";
import { assertOperationAllowed } from "./policy";
import type {
  AnalyticsDomainError,
  AnalyticsResult,
  BaseQuery,
  QueryOperation,
} from "./types";

export type {
  TypedQueryProvider,
  TypedQueryProviderResult,
  TypedQueryResultProvider,
} from "@/lib/edge/analytics/application/provider-registry";
export {
  createTypedQueryProviderRegistry,
  createTypedQueryResultProviderRegistry,
  typedQueryProvider,
  TypedQueryProviderRegistry,
  typedQueryResultProvider,
} from "@/lib/edge/analytics/application/provider-registry";

export function validateTypedQueryFilters(
  context: BaseQuery["context"],
  filters: BaseQuery["filters"],
): AnalyticsDomainError | null {
  const max = context.policy.limits.maxFilterClauses;
  if (
    typeof max === "number" &&
    filterConditionCount(filters ?? EMPTY_FILTER_DOCUMENT) > max
  ) {
    return {
      kind: "invalid-input",
      issues: [{ path: "filters", code: "too_many_filter_clauses" }],
    };
  }
  return null;
}

function invalidFilterError(
  input: BaseQuery,
  filters: NonNullable<BaseQuery["filters"]>,
): AnalyticsDomainError | null {
  try {
    assertFilterAudience(
      filters,
      analyticsFilterRegistry,
      input.context.policy.audience,
    );
    return null;
  } catch {
    return {
      kind: "invalid-input",
      issues: [
        {
          path: "filters",
          code: "invalid_or_unauthorized_filter",
        },
      ],
    };
  }
}

/**
 * The single typed application operation entry point for dashboard and share
 * adapters. HTTP parsing, authentication and response serialization happen
 * outside this function; providers receive only canonical query data.
 */
export async function executeTypedApplicationOperation<T>(
  operation: QueryOperation,
  input: BaseQuery,
  providerRegistry: TypedQueryProviderRegistry,
): Promise<AnalyticsResult<T>> {
  const operationError = assertOperationAllowed(input.context, operation);
  if (operationError) return { ok: false, error: operationError };

  const filters = input.filters ?? EMPTY_FILTER_DOCUMENT;
  const filterAudienceError = invalidFilterError(input, filters);
  if (filterAudienceError) {
    return { ok: false, error: filterAudienceError };
  }

  const filterError = validateTypedQueryFilters(input.context, filters);
  if (filterError) return { ok: false, error: filterError };

  const resolvedProvider = providerRegistry.resolve<T>(operation);
  if (!resolvedProvider) {
    return {
      ok: false,
      error: { kind: "internal", operation },
    };
  }

  try {
    const result = await resolvedProvider.execute(input);
    return {
      ok: true,
      data: result.value,
      meta: {
        time: input.time,
        source: result.source ?? "raw",
        approximateVisitors: Boolean(result.approximateVisitors),
      },
    };
  } catch (error) {
    currentInvocationLogger()?.error("query.application-operation.failed", {
      operation,
      ...errorLogData(error),
    });
    return { ok: false, error: { kind: "internal", operation } };
  }
}

/**
 * Runs an already-composed typed core operation through the same application
 * gate. This is used by composite cores such as overview and pages, where the
 * provider itself returns an AnalyticsResult rather than a single row value.
 */
export async function executeTypedApplicationResult<T>(
  operation: QueryOperation,
  input: BaseQuery,
  providerRegistry: TypedQueryProviderRegistry,
): Promise<AnalyticsResult<T>> {
  const operationError = assertOperationAllowed(input.context, operation);
  if (operationError) return { ok: false, error: operationError };
  const filters = input.filters ?? EMPTY_FILTER_DOCUMENT;
  const filterAudienceError = invalidFilterError(input, filters);
  if (filterAudienceError) return { ok: false, error: filterAudienceError };
  const filterError = validateTypedQueryFilters(input.context, filters);
  if (filterError) return { ok: false, error: filterError };
  try {
    const provider = providerRegistry.resolveResult<T>(operation);
    if (!provider) {
      return { ok: false, error: { kind: "internal", operation } };
    }
    return await provider.execute(input);
  } catch (error) {
    currentInvocationLogger()?.error("query.application-operation.failed", {
      operation,
      ...errorLogData(error),
    });
    return { ok: false, error: { kind: "internal", operation } };
  }
}
