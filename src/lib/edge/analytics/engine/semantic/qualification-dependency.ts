/** Semantic reference for an Event filter that qualifies Page visit rows. */
export const EVENT_FILTER_PAGE_VISIT_DEPENDENCY =
  "event-filter-page-visit-membership-v1" as const;

/** Semantic reference for an Event filter that qualifies Event rows. */
export const EVENT_FILTER_EVENT_MEMBERSHIP_DEPENDENCY =
  "event-filter-event-membership-v1" as const;

export type QualificationDependencyRef =
  | typeof EVENT_FILTER_PAGE_VISIT_DEPENDENCY
  | typeof EVENT_FILTER_EVENT_MEMBERSHIP_DEPENDENCY;

export function isQualificationDependencyRef(
  value: unknown,
): value is QualificationDependencyRef {
  return (
    value === EVENT_FILTER_PAGE_VISIT_DEPENDENCY ||
    value === EVENT_FILTER_EVENT_MEMBERSHIP_DEPENDENCY
  );
}
