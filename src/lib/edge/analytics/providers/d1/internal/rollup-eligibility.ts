import {
  type FilterDocument,
  filterScopePreferenceFromDocument,
  savedFilterScopePreferenceFromDocument,
  scopedFilterMetadata,
} from "@/lib/edge/analytics/contract";

/**
 * Only an unfiltered Event/observation query has the same semantics as the
 * site-level visit hourly rollup. A prepared Filter-SQL plan may exist even
 * for an empty AST; its existence alone does not demand a raw scan.
 *
 * An empty Session/Visitor scope is still entity-scoped, and must not be
 * silently interpreted as an unfiltered Event query.
 */
export function canUseHourlyRollupsForFilter(
  filters?: FilterDocument,
): boolean {
  if (!filters) return true;
  if (filters.root !== null) return false;

  const plan = scopedFilterMetadata(filters)?.plan;
  if (plan) {
    return (
      plan.scope === "event" &&
      plan.mode === "observation" &&
      !plan.requiresRawSource
    );
  }

  return (
    ["auto", "event"].includes(
      filterScopePreferenceFromDocument(filters) ?? "auto",
    ) &&
    ["auto", "event"].includes(
      savedFilterScopePreferenceFromDocument(filters) ?? "auto",
    )
  );
}
