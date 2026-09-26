import { validateTypedQueryFilters } from "@/lib/edge/analytics/contract/filter-validation";
import { EMPTY_FILTER_DOCUMENT } from "@/lib/edge/analytics/contract/helpers";
import type {
  AnalyticsDomainError,
  QueryInput,
  QueryOperation,
} from "@/lib/edge/analytics/contract/types";
import {
  filterDocumentUsesAdvancedExpressions,
  FilterValidationError,
  validateFilterExpressionTypes,
} from "@/lib/filter-contract";
import { analyticsFilterRegistry } from "@/lib/filter-contract/filter-registry";
import { assertFilterAudience } from "@/lib/filter-contract/filters";

import { planQueryOperation } from "./planner";
export { validateTypedQueryFilters };
function invalidFilterError(
  input: QueryInput,
  operation: QueryOperation,
): AnalyticsDomainError | null {
  const filters = input.filters ?? EMPTY_FILTER_DOCUMENT;
  try {
    assertFilterAudience(
      filters,
      analyticsFilterRegistry,
      input.context.policy.audience,
    );
  } catch {
    return {
      kind: "invalid-input",
      issues: [{ path: "filters", code: "invalid_or_unauthorized_filter" }],
    };
  }
  try {
    validateFilterExpressionTypes(filters, analyticsFilterRegistry);
    const unsupported = unsupportedFilterForOperation(operation, filters);
    if (unsupported) return unsupported;
    return null;
  } catch (error) {
    return {
      kind: "invalid-input",
      issues: [
        {
          path: "filters",
          code:
            error instanceof FilterValidationError
              ? error.code
              : "invalid_or_unauthorized_filter",
        },
      ],
    };
  }
}

function unsupportedFilterForOperation(
  operation: QueryOperation,
  filters: NonNullable<QueryInput["filters"]>,
): AnalyticsDomainError | null {
  if (!filterDocumentUsesAdvancedExpressions(filters)) return null;
  // Realtime snapshots are bounded and cannot provide complete selector or
  // relation semantics. Persisted Goal/Funnel step predicates intentionally
  // remain observation-only in Filter v1.
  const forbidden =
    operation === "realtime" ||
    operation === "funnel-analysis" ||
    operation === "goal-summary" ||
    operation === "goal-timeseries";
  return forbidden
    ? {
        kind: "invalid-input",
        issues: [
          {
            path: "filters",
            code: "filter_expression_unsupported_for_operation",
          },
        ],
      }
    : null;
}
export function validateTypedQueryInput(
  operation: QueryOperation,
  input: QueryInput,
): AnalyticsDomainError | null {
  const operationError = planQueryOperation(operation, input.context);
  if (operationError) return operationError;

  const filterAudienceError = invalidFilterError(input, operation);
  if (filterAudienceError) return filterAudienceError;

  return validateTypedQueryFilters(input.context, input.filters);
}
