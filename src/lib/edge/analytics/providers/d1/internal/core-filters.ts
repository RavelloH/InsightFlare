import { parseGeoLocationValue } from "@/lib/dashboard/geo-location";
import {
  analyticsFilterDefinition,
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
import { sitePksFromSiteIdsSql } from "@/lib/edge/site-identity-sql";

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
  if (scoped?.plan.mode === "entity") {
    const entity = buildEntityMembershipPredicate(scoped, alias);
    return { clause: `WHERE ${entity.clause}`, bindings: entity.bindings };
  }
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
  const scoped = scopedFilterMetadata(filters);
  const scopedPredicate =
    scoped?.plan.mode === "entity"
      ? buildEntityMembershipPredicate(scoped, alias)
      : null;
  const compiled = compileObservationPredicate(
    filters,
    "event",
    alias,
    options?.sessionSource,
  );
  const clauses = scopedPredicate
    ? [scopedPredicate.clause]
    : compiled.clause
      ? [compiled.clause.replace(/^WHERE\s+/i, "")]
      : [];
  const bindings: Array<string | number> = scopedPredicate
    ? [...scopedPredicate.bindings]
    : [...compiled.bindings];
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

interface EntityMembershipSql {
  readonly clause: string;
  readonly bindings: Array<string | number>;
}

function sourceColumn(entityKind: "session" | "visitor"): string {
  return entityKind === "session" ? "session_id" : "visitor_id";
}

/**
 * Legacy direct-reader compatibility only. Canonical typed queries are
 * prepared by the application service and must consume scoped-dataset.ts;
 * they must never reconstruct entity membership through this predicate.
 */
function membershipSetSql(
  metadata: NonNullable<ReturnType<typeof scopedFilterMetadata>>,
): EntityMembershipSql {
  const entityColumn = sourceColumn(
    metadata.plan.membership.kind === "entity"
      ? metadata.plan.membership.entityKind
      : "session",
  );
  const entityExpression =
    metadata.plan.membership.kind === "entity"
      ? metadata.plan.membership.expression
      : null;
  const sitePredicate = (alias: string) =>
    `${alias}.site_pk IN ${sitePksFromSiteIdsSql(metadata.siteIds.length)}`;
  const visitSource = `
scope_visit_source AS (
  SELECT v.*
  FROM visits v
  WHERE ${sitePredicate("v")}
    AND v.started_at >= ? AND v.started_at < ?
)`;
  const eventSource = `
scope_event_source AS (
  SELECT ce.event_pk, '{}' AS event_data_json, cen.name AS event_name, v.*
  FROM custom_events ce
  INNER JOIN custom_event_names cen
    ON cen.id = ce.event_name_id
  INNER JOIN visits v
    ON v.site_pk = ce.site_pk AND v.visit_id = ce.visit_id
  WHERE ${sitePredicate("ce")}
    AND ce.occurred_at >= ? AND ce.occurred_at < ?
)`;
  const universe = `
scope_universe AS (
  SELECT site_pk, ${entityColumn} AS entity_id
  FROM scope_visit_source
  WHERE TRIM(COALESCE(${entityColumn}, '')) != ''
  UNION
  SELECT site_pk, ${entityColumn} AS entity_id
  FROM scope_event_source
  WHERE TRIM(COALESCE(${entityColumn}, '')) != ''
)`;
  const empty = `
scope_empty AS (
  SELECT site_pk, entity_id
  FROM scope_universe
  WHERE 0
)`;
  const ctes = [visitSource, eventSource, universe, empty];
  const bindings: Array<string | number> = [
    ...metadata.siteIds,
    metadata.time.range.startMs,
    metadata.time.range.endExclusiveMs,
    ...metadata.siteIds,
    metadata.time.range.startMs,
    metadata.time.range.endExclusiveMs,
  ];
  let index = 0;

  const atom = (condition: FilterExpression): string => {
    const document = { version: 1 as const, root: condition };
    const fieldId =
      condition.kind === "condition" && condition.target.kind === "field"
        ? condition.target.field
        : "event.payload";
    const observationKinds =
      analyticsFilterDefinition(fieldId)?.observationKinds ?? new Set();
    const branches: string[] = [];
    if (observationKinds.has("visit")) {
      const compiled = compileFilterDocument(document, {
        alias: "v",
        eventAlias: "v",
        sessionSource: "scope_visit_source",
      });
      branches.push(`
    SELECT DISTINCT v.site_pk, v.${entityColumn} AS entity_id
    FROM scope_visit_source v
    ${compiled.clause}
    AND TRIM(COALESCE(v.${entityColumn}, '')) != ''`);
      bindings.push(...compiled.bindings);
    }
    if (observationKinds.has("event")) {
      const compiled = compileFilterDocument(document, {
        alias: "e",
        eventAlias: "e",
        sessionSource: "scope_visit_source",
      });
      branches.push(`
    SELECT DISTINCT e.site_pk, e.${entityColumn} AS entity_id
    FROM scope_event_source e
    ${compiled.clause}
    AND TRIM(COALESCE(e.${entityColumn}, '')) != ''`);
      bindings.push(...compiled.bindings);
    }
    const name = `scope_set_${index++}`;
    ctes.push(`
${name} AS (
  ${branches.length > 0 ? branches.join("\n  UNION") : "SELECT site_pk, entity_id FROM scope_empty"}
)`);
    return `SELECT site_pk, entity_id FROM ${name}`;
  };

  const build = (expression: typeof entityExpression): string => {
    if (!expression) return "SELECT site_pk, entity_id FROM scope_universe";
    if (expression.kind === "condition") return atom(expression.condition);
    const childQueries =
      expression.kind === "not"
        ? [build(expression.child)]
        : expression.children.map(build);
    const name = `scope_set_${index++}`;
    if (expression.kind === "not") {
      ctes.push(`
${name} AS (
  SELECT u.site_pk, u.entity_id
  FROM scope_universe u
  WHERE NOT EXISTS (
    SELECT 1 FROM (${childQueries[0]}) child
    WHERE child.site_pk = u.site_pk AND child.entity_id = u.entity_id
  )
)`);
    } else if (expression.kind === "or") {
      ctes.push(`
${name} AS (
  ${childQueries.join("\n  UNION\n  ")}
)`);
    } else {
      ctes.push(`
${name} AS (
  SELECT first_child.site_pk, first_child.entity_id
  FROM (${childQueries[0]}) first_child
  ${childQueries
    .slice(1)
    .map(
      (query) =>
        `INNER JOIN (${query}) next_child ON next_child.site_pk = first_child.site_pk AND next_child.entity_id = first_child.entity_id`,
    )
    .join("\n  ")}
)`);
    }
    return `SELECT site_pk, entity_id FROM ${name}`;
  };

  const root = build(entityExpression);
  const relation = `
WITH
${ctes.join(",")}
SELECT 1
FROM (${root}) entity_membership
WHERE entity_membership.site_pk = __OUTER__.site_pk
  AND entity_membership.entity_id = __OUTER__.${entityColumn}`;
  return {
    clause: `EXISTS (${relation.replaceAll("__OUTER__", "__ALIAS__")})`,
    bindings,
  };
}

function buildEntityMembershipPredicate(
  metadata: NonNullable<ReturnType<typeof scopedFilterMetadata>>,
  alias: string,
): EntityMembershipSql {
  const result = membershipSetSql(metadata);
  return {
    clause: result.clause.replaceAll("__ALIAS__", alias),
    bindings: result.bindings,
  };
}

export function eventRecordOrderBy(sort: ListSort<EventRecordSortKey>): string {
  const direction = sort.direction === "asc" ? "ASC" : "DESC";
  if (sort.key === "eventName")
    return `eventName ${direction}, occurredAt DESC, eventId DESC, eventPk DESC`;
  if (sort.key === "pathname")
    return `pathname ${direction}, occurredAt DESC, eventId DESC, eventPk DESC`;
  return `occurredAt ${direction}, eventId ${direction}, eventPk ${direction}`;
}
