import { parseGeoLocationValue } from "@/lib/dashboard/geo-location";
import {
  analyticsFilterRegistry,
  attachFilterScopePreference,
  attachSavedFilterScopePreference,
  compileFilterDocument,
  type FilterDocument,
  type FilterExpression,
  filterScopePreferenceFromDocument,
  normalizeFilterDocument,
  planObservationFilter,
  savedFilterScopePreferenceFromDocument,
  scopedFilterMetadata,
} from "@/lib/edge/analytics/contract";

import type { EventRecordSortKey, ListSort, QueryWindow } from "./core-types";

export interface ParsedGeoFilter {
  country: string;
  regionCode?: string;
  regionName?: string;
  city?: string;
}

/** Presentation-only location decoder. It is not part of the SQL filter contract. */
export function parseGeoFilterValue(
  value: string | undefined,
): ParsedGeoFilter | null {
  const parsed = parseGeoLocationValue(value);
  if (!parsed) return null;
  return {
    country: parsed.countryCode,
    ...(parsed.regionCode ? { regionCode: parsed.regionCode } : {}),
    ...(parsed.regionName ? { regionName: parsed.regionName } : {}),
    ...(parsed.level === "locality" && parsed.localityName
      ? { city: parsed.localityName }
      : {}),
  };
}

function removeFields(
  expression: FilterExpression | null,
  fields: ReadonlySet<string>,
): FilterExpression | null {
  if (!expression) return null;
  if (expression.kind === "condition") {
    return expression.target.kind === "field" &&
      fields.has(expression.target.field)
      ? null
      : expression;
  }
  if (expression.kind === "not") {
    const child = removeFields(expression.child, fields);
    return child ? { kind: "not", child } : null;
  }
  const children = expression.children
    .map((child) => removeFields(child, fields))
    .filter((child): child is FilterExpression => child !== null);
  if (children.length === 0) return null;
  if (children.length === 1) return children[0]!;
  return { kind: expression.kind, children };
}

export function withoutFilterKey(
  filters: FilterDocument,
  field: string,
): FilterDocument {
  const normalized = normalizeFilterDocument(
    { version: 1, root: removeFields(filters.root, new Set([field])) },
    analyticsFilterRegistry,
  );
  const callerPreference = filterScopePreferenceFromDocument(filters);
  const savedPreference = savedFilterScopePreferenceFromDocument(filters);
  const withCallerPreference = callerPreference
    ? attachFilterScopePreference(normalized, callerPreference)
    : normalized;
  return savedPreference
    ? attachSavedFilterScopePreference(withCallerPreference, savedPreference)
    : withCallerPreference;
}

export function withoutGeoFilter(filters: FilterDocument): FilterDocument {
  return withoutFilterKey(
    withoutFilterKey(withoutFilterKey(filters, "geo.country"), "geo.region"),
    "geo.city",
  );
}

export function usesSessionBoundaryFilter(filters: FilterDocument): boolean {
  const visit = (expression: FilterExpression | null): boolean => {
    if (!expression) return false;
    if (expression.kind === "condition") {
      return (
        expression.target.kind === "field" &&
        (expression.target.field === "session.entryPath" ||
          expression.target.field === "session.exitPath")
      );
    }
    if (expression.kind === "not") return visit(expression.child);
    return expression.children.some(visit);
  };
  return visit(filters.root);
}

function compileObservationPredicate(
  filters: FilterDocument,
  observationKind: "visit" | "event",
  alias: string,
  sessionSource?: string,
): { clause: string; bindings: Array<string | number> } {
  const predicate = planObservationFilter(filters.root)[observationKind];
  if (predicate.kind === "all") return { clause: "", bindings: [] };
  if (predicate.kind === "none") return { clause: "WHERE 0", bindings: [] };
  const compiled = compileFilterDocument(
    { version: 1, root: predicate.expression },
    {
      alias,
      eventAlias: alias,
      sessionSource,
    },
  );
  return { clause: compiled.clause, bindings: [...compiled.bindings] };
}

function matchingEventExistsSql(
  filters: FilterDocument,
  outerAlias: string,
  scoped: NonNullable<ReturnType<typeof scopedFilterMetadata>> | undefined,
  window?: QueryWindow,
): { clause: string; bindings: Array<string | number> } | null {
  const eventPredicate = compileObservationPredicate(
    filters,
    "event",
    "event_filter_source",
    "visit_source",
  );
  if (!eventPredicate.clause) return null;
  const eventClause = eventPredicate.clause.replace(/^WHERE\s+/i, "");
  const eventWindow =
    scoped?.time.range ??
    (window
      ? { startMs: window.startMs, endExclusiveMs: window.endExclusiveMs }
      : undefined);
  const timePredicate = eventWindow
    ? "AND ce.occurred_at >= ? AND ce.occurred_at < ?"
    : "";
  return {
    clause: `EXISTS (
  SELECT 1
  FROM (
    SELECT
      ce.event_pk,
      cen.name AS event_name,
      v.*
    FROM custom_events ce
    INNER JOIN custom_event_names cen
      ON cen.id = ce.event_name_id
    INNER JOIN visits v
      ON v.site_pk = ce.site_pk
     AND v.visit_id = ce.visit_id
    WHERE ce.site_pk = ${outerAlias}.site_pk
      AND ce.visit_id = ${outerAlias}.visit_id
      ${timePredicate}
  ) event_filter_source
  WHERE ${eventClause}
)`,
    bindings: eventWindow
      ? [
          eventWindow.startMs,
          eventWindow.endExclusiveMs,
          ...eventPredicate.bindings,
        ]
      : eventPredicate.bindings,
  };
}

export function buildVisitFilterSql(
  filters: FilterDocument,
  alias = "visit_source",
  options?: {
    readonly includeEventBranch?: boolean;
    readonly window?: QueryWindow;
  },
): { clause: string; bindings: Array<string | number> } {
  const scoped = scopedFilterMetadata(filters);
  const visitPredicate = compileObservationPredicate(filters, "visit", alias);
  const eventExists =
    options?.includeEventBranch === false
      ? null
      : matchingEventExistsSql(filters, alias, scoped, options?.window);
  const clauses = [
    ...(visitPredicate.clause
      ? [visitPredicate.clause.replace(/^WHERE\s+/i, "")]
      : []),
    ...(eventExists ? [eventExists.clause] : []),
  ];
  const bindings = [
    ...visitPredicate.bindings,
    ...(eventExists?.bindings ?? []),
  ];
  if (clauses.length === 0) {
    return planObservationFilter(filters.root).visit.kind === "all"
      ? { clause: "", bindings }
      : { clause: "WHERE 0", bindings };
  }
  return { clause: `WHERE (${clauses.join(" OR ")})`, bindings };
}

export function buildEventFilterSql(
  filters: FilterDocument,
  alias = "es",
  options?: {
    eventName?: string;
    search?: string;
    sessionSource?: string;
  },
): { clause: string; bindings: Array<string | number> } {
  const compiled = compileObservationPredicate(
    filters,
    "event",
    alias,
    options?.sessionSource,
  );
  const clauses = compiled.clause
    ? [compiled.clause.replace(/^WHERE\s+/i, "")]
    : [];
  const bindings: Array<string | number> = [...compiled.bindings];
  if (options?.eventName) {
    clauses.push(`TRIM(COALESCE(${alias}.event_name, '')) = ?`);
    bindings.push(options.eventName);
  }
  if (options?.search) {
    const escaped = options.search
      .toLowerCase()
      .replaceAll("\\", "\\\\")
      .replaceAll("%", "\\%")
      .replaceAll("_", "\\_");
    const token = `%${escaped}%`;
    clauses.push(
      `(LOWER(TRIM(COALESCE(${alias}.event_name, ''))) LIKE ? ESCAPE '\\' OR LOWER(TRIM(COALESCE(${alias}.event_id, ''))) LIKE ? ESCAPE '\\' OR LOWER(TRIM(COALESCE(${alias}.visit_id, ''))) LIKE ? ESCAPE '\\' OR LOWER(TRIM(COALESCE(${alias}.session_id, ''))) LIKE ? ESCAPE '\\' OR LOWER(TRIM(COALESCE(${alias}.visitor_id, ''))) LIKE ? ESCAPE '\\' OR LOWER(TRIM(COALESCE(${alias}.pathname, ''))) LIKE ? ESCAPE '\\' OR LOWER(TRIM(COALESCE(${alias}.title, ''))) LIKE ? ESCAPE '\\' OR LOWER(TRIM(COALESCE(${alias}.hostname, ''))) LIKE ? ESCAPE '\\')`,
    );
    bindings.push(token, token, token, token, token, token, token, token);
  }
  return clauses.length > 0
    ? { clause: `WHERE ${clauses.join(" AND ")}`, bindings }
    : { clause: "", bindings };
}

export function eventRecordOrderBy(sort: ListSort<EventRecordSortKey>): string {
  const direction = sort.direction === "asc" ? "ASC" : "DESC";
  if (sort.key === "eventName")
    return `eventName ${direction}, occurredAt DESC, eventId DESC, eventPk DESC`;
  if (sort.key === "pathname")
    return `pathname ${direction}, occurredAt DESC, eventId DESC, eventPk DESC`;
  return `occurredAt ${direction}, eventId ${direction}, eventPk ${direction}`;
}
