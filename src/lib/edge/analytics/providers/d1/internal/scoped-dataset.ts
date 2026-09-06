import {
  analyticsFilterDefinition,
  compileFilterDocument,
  type EntitySetExpression,
  type FilterCondition,
  type FilterDocument,
  type ObservationPredicatePlan,
  planObservationFilter,
  type ScopedDatasetSql,
  scopedFilterMetadata,
  type ScopedFilterPlan,
  type SqlBinding,
} from "@/lib/edge/analytics/contract";
import {
  SITE_PK_FROM_SITE_ID_SQL,
  sitePksFromSiteIdsSql,
} from "@/lib/edge/site-identity-sql";

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

function conditionDocument(condition: FilterCondition): FilterDocument {
  return {
    version: 1,
    root: condition,
  };
}

function compileMembershipCondition(condition: FilterCondition): {
  sql: string;
  bindings: Array<string | number>;
} {
  const fieldId =
    condition.target.kind === "field"
      ? condition.target.field
      : "event.payload";
  const observationKinds =
    analyticsFilterDefinition(fieldId)?.observationKinds ?? new Set();
  const branches: string[] = [];
  const bindings: Array<string | number> = [];

  if (observationKinds.has("visit")) {
    const compiled = compileFilterDocument(conditionDocument(condition), {
      alias: "v",
      eventAlias: "v",
      sessionSource: "scope_raw_visits",
    });
    branches.push(`
  SELECT DISTINCT v.site_pk, v.${"SESSION_COLUMN"} AS entity_id
  FROM scope_raw_visits v
  ${compiled.clause}
    AND TRIM(COALESCE(v.${"SESSION_COLUMN"}, '')) != ''`);
    bindings.push(...compiled.bindings);
  }

  if (observationKinds.has("event")) {
    const compiled = compileFilterDocument(conditionDocument(condition), {
      alias: "e",
      eventAlias: "e",
      sessionSource: "scope_raw_visits",
    });
    branches.push(`
  SELECT DISTINCT e.site_pk, e.${"SESSION_COLUMN"} AS entity_id
  FROM scope_raw_events e
  ${compiled.clause}
    AND TRIM(COALESCE(e.${"SESSION_COLUMN"}, '')) != ''`);
    bindings.push(...compiled.bindings);
  }

  return {
    sql: branches.join("\n  UNION\n"),
    bindings,
  };
}

interface MembershipSql {
  readonly relation: string;
  readonly ctes: string[];
  readonly bindings: Array<string | number>;
}

interface ObservationRelationSql {
  readonly cte: string;
  readonly bindings: Array<string | number>;
}

/**
 * The relations produced when an already-scoped dataset is narrowed by one
 * observation filter.  The dataset's final relations are deliberately the
 * only inputs to this bundle: callers can compose one independent bundle per
 * funnel step without accidentally re-applying the global filter.
 */
export interface ScopedObservationFilterSql {
  readonly ctes: string;
  readonly bindings: readonly SqlBinding[];
  readonly matchedVisitRelation: string;
  readonly matchedEventRelation: string;
  readonly sessionRelation: string;
  readonly visitorRelation: string;
  /** Plural aliases make the relation intent explicit at composition sites. */
  readonly matchedVisitsRelation: string;
  readonly matchedEventsRelation: string;
}

function safeSqlIdentifier(value: string, label: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(value)) {
    throw new TypeError(`${label} must be an internal SQL identifier.`);
  }
  return value;
}

/** Validate and return a CTE prefix before it is interpolated into SQL. */
export function assertSafeScopedObservationCtePrefix(prefix: string): string {
  return safeSqlIdentifier(prefix, "observation CTE prefix");
}

function scopedObservationRelation(
  relation: string,
  source: string,
  alias: string,
  predicate: ObservationPredicatePlan,
  sessionSource: string,
): ObservationRelationSql {
  if (predicate.kind === "all") {
    return {
      cte: `${relation} AS (SELECT * FROM ${source})`,
      bindings: [],
    };
  }
  if (predicate.kind === "none") {
    return {
      cte: `${relation} AS (SELECT * FROM ${source} WHERE 0)`,
      bindings: [],
    };
  }
  const compiled = compileFilterDocument(
    { version: 1, root: predicate.expression },
    {
      alias,
      eventAlias: alias,
      sessionSource,
    },
  );
  return {
    cte: `${relation} AS (SELECT ${alias}.* FROM ${source} ${alias} ${compiled.clause})`,
    bindings: [...compiled.bindings],
  };
}

/**
 * Apply one parsed/validated Observation Filter to an existing dataset.
 *
 * `planObservationFilter` projects the expression independently into the
 * visit and event domains.  This is important for mixed filters: a visit-only
 * step predicate must not be merged with, or evaluated against, the global
 * dataset's filter document.  `compileFilterDocument` then compiles each
 * projected predicate against the dataset final relations.
 */
export function applyObservationFilterToScopedDataset(
  dataset: ScopedDatasetSql,
  filter: FilterDocument,
  ctePrefix: string,
): ScopedObservationFilterSql {
  const prefix = assertSafeScopedObservationCtePrefix(ctePrefix);
  const visitSource = safeSqlIdentifier(
    dataset.visitRelation,
    "scoped visit relation",
  );
  const eventSource = safeSqlIdentifier(
    dataset.eventRelation,
    "scoped event relation",
  );
  const sessionSource = visitSource;
  const sessionRelation = `${prefix}_sessions`;
  const visitorRelation = `${prefix}_visitors`;
  const matchedVisitRelation = `${prefix}_matched_visits`;
  const matchedEventRelation = `${prefix}_matched_events`;
  const plan = planObservationFilter(filter.root);
  const visits = scopedObservationRelation(
    matchedVisitRelation,
    visitSource,
    `${prefix}_visit_filter`,
    plan.visit,
    sessionSource,
  );
  const events = scopedObservationRelation(
    matchedEventRelation,
    eventSource,
    `${prefix}_event_filter`,
    plan.event,
    sessionSource,
  );

  const ctes = `
${visits.cte},
${events.cte},
${sessionRelation} AS (
  SELECT DISTINCT site_pk, session_id
  FROM ${matchedVisitRelation}
  WHERE site_pk IS NOT NULL
    AND TRIM(COALESCE(session_id, '')) != ''
  UNION
  SELECT DISTINCT site_pk, session_id
  FROM ${matchedEventRelation}
  WHERE site_pk IS NOT NULL
    AND TRIM(COALESCE(session_id, '')) != ''
),
${visitorRelation} AS (
  SELECT DISTINCT site_pk, visitor_id
  FROM ${matchedVisitRelation}
  WHERE site_pk IS NOT NULL
    AND TRIM(COALESCE(visitor_id, '')) != ''
  UNION
  SELECT DISTINCT site_pk, visitor_id
  FROM ${matchedEventRelation}
  WHERE site_pk IS NOT NULL
    AND TRIM(COALESCE(visitor_id, '')) != ''
)`;
  const bindings = [...visits.bindings, ...events.bindings].map(
    (value): SqlBinding => ({ value }),
  );

  return {
    ctes,
    bindings,
    matchedVisitRelation,
    matchedEventRelation,
    sessionRelation,
    visitorRelation,
    matchedVisitsRelation: matchedVisitRelation,
    matchedEventsRelation: matchedEventRelation,
  };
}

/**
 * Canonical name for the shared Funnel/analysis primitive. Keep the longer
 * `apply...` export above for callers that describe this operation as a
 * compiler step, but expose the execution-oriented name in the contract.
 */
export const executeObservationFilterOnScopedDataset =
  applyObservationFilterToScopedDataset;

/** Concise alias for callers that already operate on a scoped dataset. */
export const compileScopedObservationFilterSql =
  applyObservationFilterToScopedDataset;

function compileObservationRelation(
  name: string,
  source: string,
  alias: string,
  predicate: ObservationPredicatePlan,
): ObservationRelationSql {
  if (predicate.kind === "all") {
    return { cte: `${name} AS (SELECT * FROM ${source})`, bindings: [] };
  }
  if (predicate.kind === "none") {
    return {
      cte: `${name} AS (SELECT * FROM ${source} WHERE 0)`,
      bindings: [],
    };
  }
  const compiled = compileFilterDocument(
    { version: 1, root: predicate.expression },
    {
      alias,
      eventAlias: alias,
      sessionSource: "scope_raw_visits",
    },
  );
  return {
    cte: `${name} AS (SELECT ${alias}.* FROM ${source} ${alias} ${compiled.clause})`,
    bindings: [...compiled.bindings],
  };
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
${compiled.sql.replaceAll("SESSION_COLUMN", column)}
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
  // Empty Funnel base datasets are intentionally allowed to be compiled
  // without request metadata. A no-filter query has no caller-selected scope,
  // but the Funnel planner still needs the canonical relation bundle before
  // applying each Step Observation Filter. Non-empty unprepared documents
  // remain rejected so ordinary providers cannot bypass query preparation.
  if (
    (!metadata && input.filters.root !== null) ||
    (metadata && metadata.plan !== input.plan)
  ) {
    throw new Error("scoped_dataset_metadata_required");
  }

  const entityMembership =
    input.plan.mode === "entity" && input.plan.membership.kind === "entity"
      ? compileEntityMembership(
          input.plan.membership.expression,
          input.plan.membership.entityKind,
        )
      : null;
  const observationPlan =
    input.plan.mode === "observation"
      ? planObservationFilter(input.filters.root)
      : null;
  const matchingVisits = observationPlan
    ? compileObservationRelation(
        "scope_matching_visits",
        "scope_raw_visits",
        "v",
        observationPlan.visit,
      )
    : null;
  const matchingEvents = observationPlan
    ? compileObservationRelation(
        "scope_matching_events",
        "scope_raw_events",
        "e",
        observationPlan.event,
      )
    : null;
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
scope_matching_visit_ids AS (
  SELECT site_pk, visit_id
  FROM scope_matching_visits
  UNION
  SELECT site_pk, visit_id
  FROM scope_matching_events
),
scope_final_visits AS (
  SELECT rv.*
  FROM scope_raw_visits rv
  INNER JOIN scope_matching_visit_ids matching_visits
    ON matching_visits.site_pk = rv.site_pk
   AND matching_visits.visit_id = rv.visit_id
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
  SELECT *
  FROM scope_matching_events
)`;
  const ctes = `
${visitSource(input.siteIds)},
${eventSource(input.siteIds)},
visit_source AS (SELECT * FROM scope_raw_visits),
${entityMembership ? `${entityMembership.ctes.join(",")},` : ""}
${matchingVisits ? `${matchingVisits.cte},` : ""}
${matchingEvents ? `${matchingEvents.cte},` : ""}
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
      ...(matchingVisits?.bindings ?? []),
      ...(matchingEvents?.bindings ?? []),
    ].map((value) => ({ value })),
    visitRelation: "scope_final_visits",
    eventRelation: "scope_final_events",
    sessionRelation: "scope_final_sessions",
    visitorRelation: "scope_final_visitors",
    scope: input.plan.scope,
  };
}
