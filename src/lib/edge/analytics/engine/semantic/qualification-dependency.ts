/** Semantic reference for an Event filter that qualifies Page visit rows. */
export const EVENT_FILTER_PAGE_VISIT_DEPENDENCY =
  "event-filter-page-visit-membership-v1" as const;

/** Semantic reference for an Event filter that qualifies Event rows. */
export const EVENT_FILTER_EVENT_MEMBERSHIP_DEPENDENCY =
  "event-filter-event-membership-v1" as const;

/** Semantic reference for a session/visitor filter that qualifies entities. */
export const EVENT_FILTER_ENTITY_MEMBERSHIP_DEPENDENCY =
  "event-filter-entity-membership-v1" as const;

export type QualificationDependencyRef =
  | typeof EVENT_FILTER_PAGE_VISIT_DEPENDENCY
  | typeof EVENT_FILTER_EVENT_MEMBERSHIP_DEPENDENCY
  | typeof EVENT_FILTER_ENTITY_MEMBERSHIP_DEPENDENCY;

/**
 * Observation-scope filters qualify Page visits and Events; session/visitor
 * entity-scope filters qualify entities. The two never mix in one Source.
 */
export function qualificationDependencyRefsMatchScope(
  refs: readonly QualificationDependencyRef[],
  mode: "observation" | "entity",
): boolean {
  return mode === "entity"
    ? refs.length === 1 && refs[0] === EVENT_FILTER_ENTITY_MEMBERSHIP_DEPENDENCY
    : refs.every((ref) => ref !== EVENT_FILTER_ENTITY_MEMBERSHIP_DEPENDENCY);
}

/**
 * Page-role report plans read their Page Source through the Page visit
 * membership for event-scope filters and through the entity membership for
 * session/visitor filters.
 */
export function pageRoleDependencyRefs(
  scopePlan: { readonly mode: "observation" | "entity" } | undefined,
): readonly QualificationDependencyRef[] {
  return scopePlan?.mode === "entity"
    ? [EVENT_FILTER_ENTITY_MEMBERSHIP_DEPENDENCY]
    : [EVENT_FILTER_PAGE_VISIT_DEPENDENCY];
}

export function isQualificationDependencyRef(
  value: unknown,
): value is QualificationDependencyRef {
  return (
    value === EVENT_FILTER_PAGE_VISIT_DEPENDENCY ||
    value === EVENT_FILTER_EVENT_MEMBERSHIP_DEPENDENCY ||
    value === EVENT_FILTER_ENTITY_MEMBERSHIP_DEPENDENCY
  );
}
