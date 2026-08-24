import { analyticsFilterRegistry } from "@/lib/edge/analytics/contract/filter-registry";
import {
  assertFilterAudience,
  filterConditionCount,
} from "@/lib/edge/analytics/contract/filters";
import { EMPTY_FILTER_DOCUMENT } from "@/lib/edge/analytics/contract/helpers";
import { assertOperationAllowed } from "@/lib/edge/analytics/contract/policy";
import type {
  AnalyticsDomainError,
  BaseQuery,
  QueryContext,
  QueryOperation,
} from "@/lib/edge/analytics/contract/types";

export function validateTypedQueryFilters(
  context: QueryContext,
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

function invalidFilterError(input: BaseQuery): AnalyticsDomainError | null {
  const filters = input.filters ?? EMPTY_FILTER_DOCUMENT;
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

export function validateTypedQueryInput(
  operation: QueryOperation,
  input: BaseQuery,
): AnalyticsDomainError | null {
  const operationError = assertOperationAllowed(input.context, operation);
  if (operationError) return operationError;

  const filterAudienceError = invalidFilterError(input);
  if (filterAudienceError) return filterAudienceError;

  return validateTypedQueryFilters(input.context, input.filters);
}
