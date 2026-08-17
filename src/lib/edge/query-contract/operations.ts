import { analyticsFilterRegistry } from "./filter-registry";
import { assertFilterAudience, filterConditionCount } from "./filters";
import { EMPTY_FILTER_DOCUMENT } from "./helpers";
import { assertOperationAllowed } from "./policy";
import type {
  AnalyticsDomainError,
  AnalyticsResult,
  BaseQuery,
  QueryOperation,
  QuerySource,
} from "./types";

export function validateQueryFilters(
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

export interface OperationReaderResult<T> {
  readonly value: T;
  readonly source?: QuerySource;
  readonly approximateVisitors?: boolean;
}

/**
 * Shared pure-service gate for the families whose detailed typed payloads are
 * still intentionally opaque until the follow-up filter redesign.
 */
export async function executeQueryOperation<T>(
  operation: QueryOperation,
  input: BaseQuery,
  reader: () => Promise<OperationReaderResult<T>>,
): Promise<AnalyticsResult<T>> {
  const operationError = assertOperationAllowed(input.context, operation);
  if (operationError) return { ok: false, error: operationError };

  const filters = input.filters ?? EMPTY_FILTER_DOCUMENT;
  const filterAudienceError = (() => {
    try {
      assertFilterAudience(
        filters,
        analyticsFilterRegistry,
        input.context.policy.audience,
      );
      return null;
    } catch {
      return {
        kind: "invalid-input" as const,
        issues: [
          {
            path: "filters",
            code: "invalid_or_unauthorized_filter",
          },
        ],
      };
    }
  })();
  if (filterAudienceError) {
    return {
      ok: false,
      error: filterAudienceError,
    };
  }

  const filterError = validateQueryFilters(input.context, filters);
  if (filterError) return { ok: false, error: filterError };

  try {
    const result = await reader();
    return {
      ok: true,
      data: result.value,
      meta: {
        time: input.time,
        source: result.source ?? "raw",
        approximateVisitors: Boolean(result.approximateVisitors),
      },
    };
  } catch {
    return { ok: false, error: { kind: "internal", operation } };
  }
}
