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
  savedFilterScopePreferenceFromDocument,
  scopedFilterMetadata,
} from "@/lib/edge/analytics/contract";
import { sitePksFromSiteIdsSql } from "@/lib/edge/site-identity-sql";

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

export function usesEventFilter(filters: FilterDocument): boolean {
  const visit = (expression: FilterExpression | null): boolean => {
    if (!expression) return false;
    if (expression.kind === "condition") {
      return (
        expression.target.kind === "event-payload" ||
        (expression.target.kind === "field" &&
          expression.target.field === "event.name")
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
  const scoped = scopedFilterMetadata(filters);
  if (scoped?.plan.mode === "entity") {
    const entity = buildEntityMembershipPredicate(scoped, alias);
    return { clause: `WHERE ${entity.clause}`, bindings: entity.bindings };
  }
  if (usesEventFilter(filters)) {
    const eventFilter = buildEventFilterSql(filters, "event_filter_source", {
      sessionSource: "visit_source",
    });
    const eventClause = eventFilter.clause.replace(/^WHERE\s+/i, "");
    return {
      clause: `WHERE EXISTS (
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
    WHERE ce.site_pk = ${alias}.site_pk
      AND ce.visit_id = ${alias}.visit_id
      ${scoped ? "AND ce.occurred_at >= ? AND ce.occurred_at < ?" : ""}
  ) event_filter_source
  WHERE ${eventClause}
)`,
      bindings: scoped
        ? [
            scoped.time.range.startMs,
            scoped.time.range.endExclusiveMs,
            ...eventFilter.bindings,
          ]
        : eventFilter.bindings,
    };
  }
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
  const scoped = scopedFilterMetadata(filters);
  const scopedPredicate =
    scoped?.plan.mode === "entity"
      ? buildEntityMembershipPredicate(scoped, alias)
      : null;
  const compiled = compileFilterDocument(filters, {
    alias,
    eventAlias: alias,
    sessionSource: options?.sessionSource,
  });
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

function conditionAppliesToVisit(condition: FilterExpression): boolean {
  if (condition.kind !== "condition") return true;
  if (condition.target.kind === "event-payload") return false;
  return analyticsFilterDefinition(condition.target.field)?.source !== "event";
}

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
    const visitCompiled = conditionAppliesToVisit(condition)
      ? compileFilterDocument(document, {
          alias: "v",
          eventAlias: "v",
          sessionSource: "scope_visit_source",
        })
      : { clause: "WHERE 0", bindings: [] as Array<string | number> };
    const eventCompiled = compileFilterDocument(document, {
      alias: "v",
      eventAlias: "v",
      sessionSource: "scope_visit_source",
    });
    const name = `scope_set_${index++}`;
    ctes.push(`
${name} AS (
  SELECT DISTINCT site_pk, ${entityColumn} AS entity_id
  FROM scope_visit_source v
  ${visitCompiled.clause}
  AND TRIM(COALESCE(v.${entityColumn}, '')) != ''
  UNION
  SELECT DISTINCT site_pk, ${entityColumn} AS entity_id
  FROM scope_event_source v
  ${eventCompiled.clause}
  AND TRIM(COALESCE(v.${entityColumn}, '')) != ''
)`);
    bindings.push(...visitCompiled.bindings);
    bindings.push(...eventCompiled.bindings);
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
