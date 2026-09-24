import { filterConditionCount } from "@/lib/filter-contract/filters";

import { EMPTY_FILTER_DOCUMENT } from "./helpers";
import type { AnalyticsDomainError, QueryContext, QueryInput } from "./types";

/** Enforces the caller policy's maximum filter complexity for a canonical query. */
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
