import { analyticsFilterRegistry } from "@/lib/edge/analytics/contract/filter-registry";
import {
  assertFilterAudience,
  filterConditionCount,
} from "@/lib/edge/analytics/contract/filters";
import { EMPTY_FILTER_DOCUMENT } from "@/lib/edge/analytics/contract/helpers";
import type {
  AnalyticsDomainError,
  QueryContext,
  QueryInput,
  QueryOperation,
} from "@/lib/edge/analytics/contract/types";

import { planQueryOperation } from "./planner";

export function validateTypedQueryFilters(
  context: QueryContext,
  filters: QueryInput["filters"],
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

function invalidFilterError(input: QueryInput): AnalyticsDomainError | null {
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
  input: QueryInput,
): AnalyticsDomainError | null {
  const operationError = planQueryOperation(operation, input.context);
  if (operationError) return operationError;

  const filterAudienceError = invalidFilterError(input);
  if (filterAudienceError) return filterAudienceError;

  return validateTypedQueryFilters(input.context, input.filters);
}
