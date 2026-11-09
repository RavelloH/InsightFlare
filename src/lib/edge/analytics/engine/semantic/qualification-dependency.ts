/** Semantic reference for an Event filter that qualifies Page visit rows. */
export const EVENT_FILTER_PAGE_VISIT_DEPENDENCY =
  "event-filter-page-visit-membership-v1" as const;

export type QualificationDependencyRef =
  typeof EVENT_FILTER_PAGE_VISIT_DEPENDENCY;

export function isQualificationDependencyRef(
  value: unknown,
): value is QualificationDependencyRef {
  return value === EVENT_FILTER_PAGE_VISIT_DEPENDENCY;
}
