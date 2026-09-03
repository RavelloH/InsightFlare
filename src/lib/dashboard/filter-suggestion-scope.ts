import type { FilterScope, FilterScopePreference } from "@/lib/filter-contract";

export function resolveSuggestionScope(
  scopePreference: FilterScopePreference,
  pageResolvedScope?: FilterScope,
): FilterScope | undefined {
  return scopePreference === "auto" ? pageResolvedScope : scopePreference;
}
