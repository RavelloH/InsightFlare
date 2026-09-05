import {
  analyticsFilterDefinition,
  compileFilterDocument,
  type EntitySetExpression,
  type FilterCondition,
  type FilterDocument,
  type ScopedDatasetSql,
  scopedFilterMetadata,
  type ScopedFilterPlan,
} from "@/lib/edge/analytics/contract";
import {
  SITE_PK_FROM_SITE_ID_SQL,
  sitePksFromSiteIdsSql,
} from "@/lib/edge/site-identity-sql";

import { buildEventFilterSql, buildVisitFilterSql } from "./core-filters";
import {
  buildEventAnalyticsSourceCte,
  VISIT_SOURCE_COLUMNS,
} from "./core-sources";
import type { QueryWindow } from "./core-types";

export interface ScopedDatasetCompilerInput {
  readonly filters: FilterDocument;
  readonly plan: ScopedFilterPlan;
  readonly siteIds: readonly string[];
  readonly window: QueryWindow;
}

export function scopedDatasetFor(
  siteId: string,
  window: QueryWindow,
  filters: FilterDocument,
): ScopedDatasetSql | null {
  const metadata = scopedFilterMetadata(filters);
  return metadata
    ? compileScopedDatasetSql({
        filters,
        plan: metadata.plan,
        siteIds: [siteId],
        window,
      })
    : null;
}

function siteIdsSql(siteIds: readonly string[]): string {
  if (siteIds.length === 0) throw new Error("scoped_dataset_requires_site");
  return sitePksFromSiteIdsSql(siteIds.length);
}

function visitSource(siteIds: readonly string[]): string {
  return `
scope_raw_visits AS MATERIALIZED (
  SELECT ${VISIT_SOURCE_COLUMNS}
  FROM visits
  WHERE site_pk IN ${siteIdsSql(siteIds)}
    AND started_at >= ? AND started_at < ?
)`;
}

function eventSource(siteIds: readonly string[]): string {
  // Custom events are windowed by occurred_at. The linked visit supplies
  // identity and context even when that visit started outside the window.
  return buildEventAnalyticsSourceCte({ cteName: "scope_raw_events" })
    .replace("scope_raw_events AS (", "scope_raw_events AS MATERIALIZED (")
    .replace(
      `ce.site_pk = ${SITE_PK_FROM_SITE_ID_SQL}`,
      `ce.site_pk IN ${siteIdsSql(siteIds)}`,
    );
}

function entityColumn(entityKind: "session" | "visitor"): string {
  return entityKind === "session" ? "session_id" : "visitor_id";
}

function conditionSource(condition: FilterCondition): "visit" | "event" {
  if (condition.target.kind === "event-payload") return "event";
  const source = analyticsFilterDefinition(condition.target.field)?.source;
  return source === "event" || source === "payload" ? "event" : "visit";
}

function conditionDocument(condition: FilterCondition): FilterDocument {
  return {
    version: 1,
    root: condition,
  };
}

function compileMembershipCondition(condition: FilterCondition): {
  source: "scope_raw_visits" | "scope_raw_events";
  alias: string;
  clause: string;
  bindings: Array<string | number>;
} {
  const source = conditionSource(condition);
  const alias = source === "event" ? "e" : "v";
  const compiled = compileFilterDocument(conditionDocument(condition), {
    alias,
    eventAlias: alias,
    sessionSource: "scope_raw_visits",
  });
  return {
    source: source === "event" ? "scope_raw_events" : "scope_raw_visits",
    alias,
    clause: compiled.clause,
    bindings: [...compiled.bindings],
  };
}

interface MembershipSql {
  readonly relation: string;
  readonly ctes: string[];
  readonly bindings: Array<string | number>;
}

function compileEntityMembership(
  expression: EntitySetExpression | null,
  entityKind: "session" | "visitor",
): MembershipSql {
  const column = entityColumn(entityKind);
  const ctes: string[] = [
    `
scope_universe AS (
  SELECT DISTINCT site_pk, ${column} AS entity_id
  FROM scope_raw_visits
  WHERE TRIM(COALESCE(${column}, '')) != ''
  UNION
  SELECT DISTINCT site_pk, ${column} AS entity_id
  FROM scope_raw_events
  WHERE TRIM(COALESCE(${column}, '')) != ''
)`,
  ];
  const bindings: Array<string | number> = [];
  let index = 0;

  const compile = (node: EntitySetExpression | null): string => {
    if (!node) return "scope_universe";
    if (node.kind === "condition") {
      const compiled = compileMembershipCondition(node.condition);
      const name = `scope_membership_${index++}`;
      ctes.push(`
${name} AS (
  SELECT DISTINCT ${compiled.alias}.site_pk, ${compiled.alias}.${column} AS entity_id
  FROM ${compiled.source} ${compiled.alias}
  ${compiled.clause}
    AND TRIM(COALESCE(${compiled.alias}.${column}, '')) != ''
)`);
      bindings.push(...compiled.bindings);
      return name;
    }

    if (node.kind === "not") {
      const child = compile(node.child);
      const name = `scope_membership_${index++}`;
      ctes.push(`
${name} AS (
  SELECT u.site_pk, u.entity_id
  FROM scope_universe u
  WHERE NOT EXISTS (
    SELECT 1
    FROM ${child} child
    WHERE child.site_pk = u.site_pk
      AND child.entity_id = u.entity_id
  )
)`);
      return name;
    }

    const children = node.children.map(compile);
    const name = `scope_membership_${index++}`;
    if (node.kind === "or") {
      ctes.push(`
${name} AS (
  ${children.map((child) => `SELECT site_pk, entity_id FROM ${child}`).join("\n  UNION\n  ")}
)`);
    } else {
      ctes.push(`
${name} AS (
  SELECT first_child.site_pk, first_child.entity_id
  FROM ${children[0]} first_child
  ${children
    .slice(1)
    .map(
      (child) =>
        `INNER JOIN ${child} next_child ON next_child.site_pk = first_child.site_pk AND next_child.entity_id = first_child.entity_id`,
    )
    .join("\n  ")}
)`);
    }
    return name;
  };

  return { relation: compile(expression), ctes, bindings };
}

/**
 * Compile the one relation bundle consumed by historical D1 providers.
 * Raw sources, entity universes, and membership sets stay inside this
 * compiler; the returned relations are already resolved to one scope.
 */
export function compileScopedDatasetSql(
  input: ScopedDatasetCompilerInput,
): ScopedDatasetSql {
  const metadata = scopedFilterMetadata(input.filters);
  if (!metadata || metadata.plan !== input.plan) {
    throw new Error("scoped_dataset_metadata_required");
  }

  const entityMembership =
    input.plan.mode === "entity" && input.plan.membership.kind === "entity"
      ? compileEntityMembership(
          input.plan.membership.expression,
          input.plan.membership.entityKind,
        )
      : null;
  const visitFilter =
    input.plan.mode === "observation"
      ? buildVisitFilterSql(input.filters, "rv")
      : { clause: "", bindings: [] as Array<string | number> };
  const eventFilter =
    input.plan.mode === "observation"
      ? buildEventFilterSql(input.filters, "re", {
          sessionSource: "scope_raw_visits",
        })
      : { clause: "", bindings: [] as Array<string | number> };
  const entityColumnName =
    input.plan.mode === "entity" && input.plan.membership.kind === "entity"
      ? entityColumn(input.plan.membership.entityKind)
      : null;
  const finalVisitRelation =
    input.plan.mode === "entity"
      ? `
scope_final_visits AS (
  SELECT rv.*
  FROM scope_raw_visits rv
  INNER JOIN ${entityMembership?.relation ?? "scope_universe"} matching_entities
    ON matching_entities.site_pk = rv.site_pk
   AND matching_entities.entity_id = rv.${entityColumnName}
  WHERE TRIM(COALESCE(rv.${entityColumnName}, '')) != ''
)`
      : `
scope_final_visits AS (
  SELECT rv.*
  FROM scope_raw_visits rv
  ${visitFilter.clause}
)`;
  const finalEventRelation =
    input.plan.mode === "entity"
      ? `
scope_final_events AS (
  SELECT re.*
  FROM scope_raw_events re
  INNER JOIN ${entityMembership?.relation ?? "scope_universe"} matching_entities
    ON matching_entities.site_pk = re.site_pk
   AND matching_entities.entity_id = re.${entityColumnName}
  WHERE TRIM(COALESCE(re.${entityColumnName}, '')) != ''
)`
      : `
scope_final_events AS (
  SELECT re.*
  FROM scope_raw_events re
  ${eventFilter.clause}
)`;
  const ctes = `
${visitSource(input.siteIds)},
${eventSource(input.siteIds)},
visit_source AS (SELECT * FROM scope_raw_visits),
${entityMembership ? `${entityMembership.ctes.join(",")},` : ""}
${finalVisitRelation},
${finalEventRelation},
scope_final_sessions AS (
  SELECT DISTINCT site_pk, session_id
  FROM scope_final_visits
  WHERE TRIM(COALESCE(session_id, '')) != ''
  UNION
  SELECT DISTINCT site_pk, session_id
  FROM scope_final_events
  WHERE TRIM(COALESCE(session_id, '')) != ''
),
scope_final_visitors AS (
  SELECT DISTINCT site_pk, visitor_id
  FROM scope_final_visits
  WHERE TRIM(COALESCE(visitor_id, '')) != ''
  UNION
  SELECT DISTINCT site_pk, visitor_id
  FROM scope_final_events
  WHERE TRIM(COALESCE(visitor_id, '')) != ''
)`;

  return {
    ctes,
    bindings: [
      ...input.siteIds,
      input.window.startMs,
      input.window.endExclusiveMs,
      ...input.siteIds,
      input.window.startMs,
      input.window.endExclusiveMs,
      ...(entityMembership?.bindings ?? []),
      ...visitFilter.bindings,
      ...eventFilter.bindings,
    ].map((value) => ({ value })),
    visitRelation: "scope_final_visits",
    eventRelation: "scope_final_events",
    sessionRelation: "scope_final_sessions",
    visitorRelation: "scope_final_visitors",
    scope: input.plan.scope,
  };
}
