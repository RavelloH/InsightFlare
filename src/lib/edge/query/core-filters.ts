import { parseGeoLocationValue } from "@/lib/dashboard/geo-location";
import {
  analyticsFilterRegistry,
  compileFilterDocument,
  type FilterDocument,
  type FilterExpression,
  normalizeFilterDocument,
} from "@/lib/edge/query-contract";

import type { EventRecordSortKey, ListSort } from "./core-types";

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
  return normalizeFilterDocument(
    { version: 1, root: removeFields(filters.root, new Set([field])) },
    analyticsFilterRegistry,
  );
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

export function buildVisitFilterSql(
  filters: FilterDocument,
  alias = "visit_source",
): { clause: string; bindings: Array<string | number> } {
  const compiled = compileFilterDocument(filters, { alias });
  return { clause: compiled.clause, bindings: [...compiled.bindings] };
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
  const compiled = compileFilterDocument(filters, {
    alias,
    eventAlias: alias,
    sessionSource: options?.sessionSource,
  });
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
