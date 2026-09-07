import {
  buildSessionFactsSql,
  buildVisitorFactsSql,
} from "./journey-aggregation-sql";

export type ScopedFactKind = "session" | "visitor";

/**
 * Build only the fact relations needed by the current scoped filter.  The
 * source names are internal constants: raw relations have already applied
 * the same site and time-window predicates as the final dataset.
 */
export function buildScopedFactsCtes(
  requiredKinds: ReadonlySet<ScopedFactKind>,
): readonly string[] {
  const options = {
    visitsRelation: "scope_raw_visits",
    eventsRelation: "scope_raw_events",
  } as const;
  const ctes: string[] = [];
  if (requiredKinds.has("session")) {
    ctes.push(buildSessionFactsSql(options));
  }
  if (requiredKinds.has("visitor")) {
    ctes.push(buildVisitorFactsSql(options));
  }
  return ctes;
}
