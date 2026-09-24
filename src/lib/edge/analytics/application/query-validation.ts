import { validateTypedQueryFilters } from "@/lib/edge/analytics/contract/filter-validation";
import { EMPTY_FILTER_DOCUMENT } from "@/lib/edge/analytics/contract/helpers";
import type {
  AnalyticsDomainError,
  QueryInput,
  QueryOperation,
} from "@/lib/edge/analytics/contract/types";
import { analyticsFilterRegistry } from "@/lib/filter-contract/filter-registry";
import { assertFilterAudience } from "@/lib/filter-contract/filters";

import { planQueryOperation } from "./planner";
export { validateTypedQueryFilters };
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
