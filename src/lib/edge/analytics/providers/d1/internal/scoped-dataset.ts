import {
  analyticsFilterDefinition,
  attachScopedFilterMetadata,
  createQueryTime,
  createScopedFilterPlan,
  type EntitySetExpression,
  factEntityKindsForFilter,
  type FilterCondition,
  type FilterDocument,
  type FilterExpression,
  type FilterValue,
  type ObservationPredicatePlan,
  planObservationFilter,
  type QueryOperation,
  type QueryTime,
  scopedFilterMetadata,
  type ScopedFilterPlan,
} from "@/lib/edge/analytics/contract";
import {
  SITE_PK_FROM_SITE_ID_SQL,
  sitePksFromSiteIdsSql,
} from "@/lib/edge/sites/identity-sql";
import {
  filterDocumentHasSimpleEventFacts,
  filterDocumentUsesAdvancedExpressions,
} from "@/lib/filter-contract/filter-types";
import type { FilterTargetExpression } from "@/lib/filter-contract/filters";
import type { FilterScope } from "@/lib/filter-contract/scope-preference";

import { buildVisitFilterSql } from "./core-filters";
import {
  buildEventAnalyticsSourceCte,
  buildVisitSourceCte,
  VISIT_SOURCE_COLUMNS,
} from "./core-sources";
import type { QueryWindow } from "./core-types";
import { compileFilterDocument } from "./filter-compiler";
import {
  boundCte,
  type BoundCteDefinition,
  composeBoundCtes,
  type FilterQualificationSql,
  type SqlBinding,
} from "./filter-qualification";
import {
  compileCollectionSqlQualification,
  type SqlQualificationSources,
} from "./filter-sql-collections";
import type { SqlScalarTimeContext } from "./filter-sql-scalars";

export type { SqlBinding } from "./filter-qualification";

export interface ScopedDatasetSql {
  readonly ctes: string;
  readonly bindings: readonly SqlBinding[];
  readonly visitRelation: string;
  readonly eventRelation: string;
  readonly sessionRelation: string;
  readonly visitorRelation: string;
  readonly scope: FilterScope;
  /** True only for the canonical materialized legacy Event qualification path. */
  readonly materializedEventFacts?: boolean;
  /** Canonical primary-key observations, with no amplifying qualification joins. */
  readonly uniqueObservationIds?: boolean;
}
import { buildScopedFactsCtes, type ScopedFactKind } from "./scoped-facts";
type ScopedDatasetTarget = {
  readonly type: "session" | "visitor";
  readonly value: string;
};

export interface ScopedDatasetCompilerInput {
  /** Optional restriction for a reader of one entity, not a user filter. */
  readonly target?: ScopedDatasetTarget;
  readonly filters: FilterDocument;
  readonly plan: ScopedFilterPlan;
  readonly siteIds: readonly string[];
  readonly window: QueryWindow;
  /**
   * Direct readers can be invoked against legacy analytics fixtures whose
   * custom_events table predates the structured-event columns.  They only
   * need event identity and visit context for scope expansion; canonical
   * callers keep the full structured projection.
   */
  readonly compatibilityEventSource?: boolean;
}

export function scopedDatasetFor(
  siteId: string,
  window: QueryWindow,
  filters: FilterDocument,
  target?: ScopedDatasetTarget,
): ScopedDatasetSql | null {
  const metadata = scopedFilterMetadata(filters);
  return metadata
    ? compileScopedDatasetSql({
        filters,
        plan: metadata.plan,
        siteIds: [siteId],
        window,
        target,
      })
    : null;
}
/**
 * Compatibility bridge for direct readers that still receive a normalized
 * filter document instead of an application-prepared document. Historical
 * readers expanded a non-empty filter to the complete matching entity; make
 * that scope explicit and feed it through the canonical compiler so the
 * fallback cannot drift from prepared scoped queries.
 *
 * Empty documents intentionally return null. Besides preserving the ordinary
 * unfiltered source path, this lets aggregate callers retain their hourly
 * rollup fast path.
 */
export function scopedDatasetForUnpreparedReader(
  operation: QueryOperation,
  siteId: string,
  window: QueryWindow,
  filters: FilterDocument,
  scope: FilterScope,
): ScopedDatasetSql | null {
  if (filters.root === null) return null;
  if (filterDocumentUsesAdvancedExpressions(filters)) {
    // Direct compatibility readers do not carry authoritative Q/F/R history
    // or audience authorization; never approximate a Relation via visit SQL.
    throw new Error("advanced_filter_requires_prepared_scope");
  }

  const plan = createScopedFilterPlan(operation, filters, scope);
  if (!plan) return null;
  // The Visit-only compatibility bridge cannot match structured Event Payload.
  // Resolve ordinary Payloads through the canonical event-bearing dataset.
  if (
    factEntityKindsForFilter(filters.root).size === 0 &&
    !plan.requiredSources.has("payload")
  ) {
    return compileUnpreparedCompatibilityDataset(
      siteId,
      window,
      filters,
      plan,
      operation === "visitors" || operation === "sessions",
    );
  }
  const time = createQueryTime(
    window.startMs,
    window.endExclusiveMs,
    window.timeZone,
    window.nowMs,
  );
  const scopedFilters = attachScopedFilterMetadata(filters, {
    requestedScope: scope,
    resolvedScope: plan.scope,
    plan,
    time,
    siteIds: [siteId],
  });
  return compileScopedDatasetSql({
    filters: scopedFilters,
    plan,
    siteIds: [siteId],
    window,
    compatibilityEventSource: true,
  });
}
function emptyEventSourceCte(): string {
  return `
scope_raw_events AS MATERIALIZED (
  SELECT
    CAST(NULL AS INTEGER) AS event_pk,
    CAST(NULL AS TEXT) AS event_id,
    CAST(NULL AS TEXT) AS site_id,
    CAST(NULL AS INTEGER) AS site_pk,
    CAST(NULL AS TEXT) AS visit_id,
    CAST(NULL AS TEXT) AS event_data_json,
    CAST(NULL AS TEXT) AS event_name,
    CAST(NULL AS INTEGER) AS occurred_at,
    CAST(NULL AS TEXT) AS visitor_id,
    CAST(NULL AS TEXT) AS session_id,
    CAST(NULL AS TEXT) AS pathname,
    CAST(NULL AS TEXT) AS query_string,
    CAST(NULL AS TEXT) AS hash_fragment,
    CAST(NULL AS TEXT) AS hostname,
    CAST(NULL AS TEXT) AS title,
    CAST(NULL AS TEXT) AS referrer_url,
    CAST(NULL AS TEXT) AS referrer_host,
    CAST(NULL AS TEXT) AS utm_source,
    CAST(NULL AS TEXT) AS utm_medium,
    CAST(NULL AS TEXT) AS utm_campaign,
    CAST(NULL AS TEXT) AS utm_term,
    CAST(NULL AS TEXT) AS utm_content,
    CAST(NULL AS INTEGER) AS duration_ms,
    CAST(NULL AS TEXT) AS user_id,
    CAST(NULL AS TEXT) AS user_name,
    CAST(NULL AS INTEGER) AS is_eu,
    CAST(NULL AS TEXT) AS country,
    CAST(NULL AS TEXT) AS region,
    CAST(NULL AS TEXT) AS region_code,
    CAST(NULL AS TEXT) AS city,
    CAST(NULL AS TEXT) AS continent,
    CAST(NULL AS TEXT) AS browser,
    CAST(NULL AS TEXT) AS browser_version,
    CAST(NULL AS TEXT) AS os,
    CAST(NULL AS TEXT) AS os_version,
    CAST(NULL AS TEXT) AS device_type,
    CAST(NULL AS TEXT) AS language,
    CAST(NULL AS TEXT) AS timezone,
    CAST(NULL AS TEXT) AS as_organization,
    CAST(NULL AS INTEGER) AS screen_width,
    CAST(NULL AS INTEGER) AS screen_height,
    CAST(NULL AS INTEGER) AS perf_ttfb_ms,
    CAST(NULL AS INTEGER) AS perf_fcp_ms,
    CAST(NULL AS REAL) AS perf_lcp_ms,
    CAST(NULL AS REAL) AS perf_cls,
    CAST(NULL AS INTEGER) AS perf_inp_ms
  WHERE 0
)`;
}
function compileUnpreparedCompatibilityDataset(
  siteId: string,
  window: QueryWindow,
  filters: FilterDocument,
  plan: ScopedFilterPlan,
  includeEvents: boolean,
): ScopedDatasetSql {
  if (plan.scope === "event") {
    throw new TypeError(
      "Direct reader compatibility requires an entity scope.",
    );
  }
  const entityColumnName = entityColumn(plan.scope);
  const filter = buildVisitFilterSql(filters, "visit_source", { window });
  const eventCte = includeEvents
    ? eventSource([siteId], true)
    : emptyEventSourceCte();
  const eventBindings = includeEvents
    ? [siteId, window.startMs, window.endExclusiveMs]
    : [];
  const ctes = `
${buildVisitSourceCte().replace(
  "visit_source AS (",
  "visit_source AS MATERIALIZED (",
)},
scope_raw_visits AS (SELECT * FROM visit_source),
${eventCte},
scope_filtered_visits AS MATERIALIZED (
  SELECT *
  FROM visit_source
  ${filter.clause}
),
scope_entity_ids AS (
  SELECT DISTINCT site_pk, ${entityColumnName} AS entity_id
  FROM scope_filtered_visits
  WHERE TRIM(COALESCE(${entityColumnName}, '')) != ''
),
scope_final_visits AS (
  SELECT v.*
  FROM visit_source v
  INNER JOIN scope_entity_ids ids
    ON ids.site_pk = v.site_pk
   AND ids.entity_id = v.${entityColumnName}
  WHERE TRIM(COALESCE(v.${entityColumnName}, '')) != ''
),
scope_final_events AS (
  SELECT e.*
  FROM scope_raw_events e
  INNER JOIN scope_entity_ids ids
    ON ids.site_pk = e.site_pk
   AND ids.entity_id = e.${entityColumnName}
  WHERE TRIM(COALESCE(e.${entityColumnName}, '')) != ''
),
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
      siteId,
      window.startMs,
      window.endExclusiveMs,
      ...eventBindings,
      ...filter.bindings,
    ].map((value) => ({ value })),
    visitRelation: "scope_final_visits",
    eventRelation: "scope_final_events",
    sessionRelation: "scope_final_sessions",
    visitorRelation: "scope_final_visitors",
    scope: plan.scope,
  };
}
function siteIdsSql(siteIds: readonly string[]): string {
  if (siteIds.length === 0) throw new Error("scoped_dataset_requires_site");
  return sitePksFromSiteIdsSql(siteIds.length);
}
function visitSource(
  siteIds: readonly string[],
  target?: ScopedDatasetTarget,
): string {
  return `
scope_raw_visits AS MATERIALIZED (
  SELECT ${VISIT_SOURCE_COLUMNS}
  FROM visits
  WHERE site_pk IN ${siteIdsSql(siteIds)}
    AND started_at >= ? AND started_at < ?
    ${target ? "AND " + entityColumn(target.type) + " = ?" : ""}
)`;
}
function eventSource(
  siteIds: readonly string[],
  compatibility = false,
  target?: ScopedDatasetTarget,
): string {
  // Custom events are windowed by occurred_at. The linked visit supplies
  // identity and context even when that visit started outside the window.
  return buildEventAnalyticsSourceCte({
    cteName: "scope_raw_events",
    ...(target ? { visitTarget: target.type } : {}),
    ...(compatibility
      ? {
          selectColumns: `
    ce.event_pk,
    ce.event_id,
    ce.site_id,
    ce.site_pk,
    ce.visit_id,
    '{}' AS event_data_json,
    cen.name AS event_name,
    ce.occurred_at,
    v.visitor_id,
    v.session_id,
    v.pathname,
    v.query_string,
    v.hash_fragment,
    v.hostname,
    v.title,
    v.referrer_url,
    v.referrer_host,
    v.utm_source,
    v.utm_medium,
    v.utm_campaign,
    v.utm_term,
    v.utm_content,
    v.duration_ms,
    v.user_id,
    v.user_name,
    v.is_eu,
    v.country,
    v.region,
    v.region_code,
    v.city,
    v.continent,
    v.browser,
    v.browser_version,
    v.os,
    v.os_version,
    v.device_type,
    v.language,
    v.timezone,
    v.as_organization,
    v.screen_width,
    v.screen_height,
    v.perf_ttfb_ms,
    v.perf_fcp_ms,
    v.perf_lcp_ms,
    v.perf_cls,
    v.perf_inp_ms`,
        }
      : {}),
  })
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
function factKindForCondition(
  condition: FilterCondition,
): ScopedFactKind | null {
  if (condition.target.kind !== "field") return null;
  const definition = analyticsFilterDefinition(condition.target.field);
  if (!definition) return null;
  if (definition.evaluation === "session-fact") return "session";
  if (definition.evaluation === "visitor-fact") return "visitor";
  if (!definition.evaluation && definition.nativeEntity === "session") {
    return "session";
  }
  if (!definition.evaluation && definition.nativeEntity === "visitor") {
    return "visitor";
  }
  return null;
}
function factColumnName(condition: FilterCondition): string {
  if (condition.target.kind !== "field") {
    throw new TypeError("Fact filters require a field target.");
  }
  const definition = analyticsFilterDefinition(condition.target.field);
  const strategy = definition?.compilerStrategy?.startsWith("fact.")
    ? definition.compilerStrategy.slice("fact.".length)
    : definition?.compilerStrategy;
  if (strategy && /^[A-Za-z_][A-Za-z0-9_]*$/.test(strategy)) {
    return strategy;
  }
  const fallback: Readonly<Record<string, string>> = {
    "session.durationMs": "session_duration_ms",
    "session.views": "session_views",
    "session.events": "session_events",
    "session.bounce": "session_bounce",
    "visitor.sessions": "visitor_sessions",
    "visitor.views": "visitor_views",
    "visitor.events": "visitor_events",
  };
  const column = fallback[condition.target.field];
  if (!column) {
    throw new TypeError(
      `No fact SQL column strategy registered for ${condition.target.field}.`,
    );
  }
  return column;
}
function factBinding(value: FilterValue, valueKind: string): string | number {
  if (value === null) {
    throw new TypeError("Fact predicates require a non-null scalar binding.");
  }
  if (valueKind === "boolean") {
    if (typeof value !== "boolean") {
      throw new TypeError("Boolean fact filter values must be boolean.");
    }
    return value ? 1 : 0;
  }
  if (valueKind === "number") {
    if (typeof value !== "number" || !Number.isFinite(value)) {
      throw new TypeError("Numeric fact filter values must be finite numbers.");
    }
    return value;
  }
  if (typeof value !== "string") {
    throw new TypeError("Fact filter values must match the registered field.");
  }
  return value;
}
function compileFactPredicate(
  condition: FilterCondition,
  alias: string,
  bindings: Array<string | number>,
): string {
  if (condition.target.kind !== "field") {
    throw new TypeError("Fact predicates require a field target.");
  }
  const definition = analyticsFilterDefinition(condition.target.field);
  if (!definition) {
    throw new TypeError(`No filter definition for ${condition.target.field}.`);
  }
  const source = `${alias}.${factColumnName(condition)}`;
  const push = (value: FilterValue): string => {
    bindings.push(factBinding(value, definition.valueKind));
    return "?";
  };
  if (condition.operator === "exists" || condition.operator === "notNull") {
    return `${source} IS NOT NULL`;
  }
  if (condition.operator === "notExists" || condition.operator === "isNull") {
    return `${source} IS NULL`;
  }

  const value = condition.value;
  if (Array.isArray(value)) {
    if (condition.operator === "between") {
      return `${source} BETWEEN ${push(value[0]!)} AND ${push(value[1]!)}`;
    }
    const operator = condition.operator === "notIn" ? "NOT IN" : "IN";
    return `${source} ${operator} (${value.map((item) => push(item)).join(", ")})`;
  }
  const operator: Readonly<Record<string, string>> = {
    eq: "=",
    neq: "!=",
    gt: ">",
    gte: ">=",
    lt: "<",
    lte: "<=",
  };
  const sqlOperator = operator[condition.operator];
  if (!sqlOperator) {
    throw new TypeError(
      `Unsupported fact operator ${condition.operator} for ${condition.target.field}.`,
    );
  }
  return `${source} ${sqlOperator} ${push(value as FilterValue)}`;
}
function compileFactMembershipCondition(
  condition: FilterCondition,
  entityKind: ScopedFactKind,
): { sql: string; bindings: Array<string | number> } | null {
  const factKind = factKindForCondition(condition);
  if (!factKind) return null;
  const relation = `scope_${factKind}_facts`;
  const factAlias = factKind === "session" ? "sf" : "vf";
  const factEntityColumn = factKind === "session" ? "session_id" : "visitor_id";
  const bindings: Array<string | number> = [];
  const predicate = compileFactPredicate(condition, factAlias, bindings);
  if (factKind === entityKind) {
    return {
      sql: `
  SELECT DISTINCT ${factAlias}.site_pk, ${factAlias}.${factEntityColumn} AS entity_id
  FROM ${relation} ${factAlias}
  WHERE ${predicate}`,
      bindings,
    };
  }

  const identityColumn = entityKind === "session" ? "session_id" : "visitor_id";
  const otherColumn = factKind === "session" ? "session_id" : "visitor_id";
  const rawRelations = `
    SELECT site_pk, session_id, visitor_id
    FROM scope_raw_visits
    WHERE TRIM(COALESCE(${identityColumn}, '')) != ''
      AND TRIM(COALESCE(${otherColumn}, '')) != ''
    UNION
    SELECT site_pk, session_id, visitor_id
    FROM scope_raw_events
    WHERE TRIM(COALESCE(${identityColumn}, '')) != ''
      AND TRIM(COALESCE(${otherColumn}, '')) != ''`;
  return {
    sql: `
  SELECT DISTINCT identities.site_pk, identities.${identityColumn} AS entity_id
  FROM (${rawRelations}) identities
  INNER JOIN ${relation} ${factAlias}
    ON ${factAlias}.site_pk = identities.site_pk
   AND ${factAlias}.${factEntityColumn} = identities.${factEntityColumn}
  WHERE ${predicate}`,
    bindings,
  };
}
function compileMembershipCondition(
  condition: FilterCondition,
  entityKind: ScopedFactKind,
): {
  sql: string;
  bindings: Array<string | number>;
} {
  const fact = compileFactMembershipCondition(condition, entityKind);
  if (fact) return fact;
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
  readonly ctes: readonly BoundCteDefinition[];
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
/**
 * Keep base observations and conversion flags in one stream. Both domains
 * use the same projected predicates as the matched-relation compiler.
 * CASE treats SQL NULL exactly like a failed WHERE predicate.
 */
export function compileMarkedObservationSource(
  dataset: ScopedDatasetSql,
  filter: FilterDocument,
  includeObservedAt: boolean,
): { readonly cte: string; readonly bindings: readonly SqlBinding[] } {
  const visitSource = safeSqlIdentifier(
    dataset.visitRelation,
    "scoped visit relation",
  );
  const eventSource = safeSqlIdentifier(
    dataset.eventRelation,
    "scoped event relation",
  );
  const plan = planObservationFilter(filter.root);
  const bindings: SqlBinding[] = [];
  const select = (
    source: string,
    alias: string,
    predicate: ObservationPredicatePlan,
    observedAt: "started_at" | "occurred_at",
  ) => {
    let marker = "1";
    if (predicate.kind === "none") marker = "0";
    else if (predicate.kind === "expression") {
      const compiled = compileFilterDocument(
        { version: 1, root: predicate.expression },
        { alias, eventAlias: alias, sessionSource: visitSource },
      );
      // FilterSql.clause is either empty or starts with the compiler's WHERE.
      const condition = compiled.clause
        ? compiled.clause.slice("WHERE ".length)
        : "1";
      marker = `CASE WHEN (${condition}) THEN 1 ELSE 0 END`;
      bindings.push(
        ...compiled.bindings.map((value): SqlBinding => ({ value })),
      );
    }
    const timestamp = includeObservedAt
      ? `${alias}.${observedAt} AS observed_at, `
      : "";
    return `SELECT ${marker} AS is_goal, ${alias}.site_pk, ${timestamp}${alias}.session_id, ${alias}.visitor_id
  FROM ${source} ${alias}`;
  };
  const visits = select(
    visitSource,
    "goal_visit_filter",
    plan.visit,
    "started_at",
  );
  const events = select(
    eventSource,
    "goal_event_filter",
    plan.event,
    "occurred_at",
  );
  return {
    cte: `source_observations AS (
  ${visits}
  UNION ALL
  ${events}
)`,
    bindings,
  };
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
  observation: "visit" | "event",
  fullRows = false,
): BoundCteDefinition {
  const id = observation === "visit" ? "visit_id" : "event_id";
  const projection = fullRows
    ? `${alias}.*`
    : `${alias}.site_pk, ${alias}.${id}`;
  if (predicate.kind === "all") {
    return boundCte(
      name,
      `${name} AS (SELECT ${projection} FROM ${source} ${alias})`,
    );
  }
  if (predicate.kind === "none") {
    return boundCte(
      name,
      `${name} AS (SELECT ${projection} FROM ${source} ${alias} WHERE 0)`,
    );
  }
  const compiled = compileFilterDocument(
    { version: 1, root: predicate.expression },
    {
      alias,
      eventAlias: alias,
      sessionSource: "scope_raw_visits",
    },
  );
  return boundCte(
    name,
    `${name} AS (SELECT ${projection} FROM ${source} ${alias} ${compiled.clause})`,
    compiled.bindings,
  );
}
// Membership is existential per condition, not per observation: different
// observations of the same entity may satisfy different AND operands.
// Aggregate evidence independently before combining the Boolean expression.
function compileSharedEntityMembership(
  expression: EntitySetExpression,
  entityKind: ScopedFactKind,
): MembershipSql | null {
  const conditions: FilterCondition[] = [];
  let hasNegation = false;
  let hasConjunction = false;
  const compile = (node: EntitySetExpression): string | null => {
    if (node.kind === "condition") {
      if (!isVisitContextPredicate(node.condition)) return null;
      const index = conditions.push(node.condition) - 1;
      return `MAX(evidence_${index}) = 1`;
    }
    if (node.kind === "not") {
      hasNegation = true;
      const child = compile(node.child);
      return child === null ? null : `NOT (${child})`;
    }
    if (node.kind === "and") hasConjunction = true;
    const children = node.children.map(compile);
    if (children.some((child) => child === null)) return null;
    return `(${children.join(node.kind === "and" ? " AND " : " OR ")})`;
  };
  const predicate = compile(expression);
  if (predicate === null || conditions.length < 2) return null;
  const column = entityColumn(entityKind);
  const bindings: Array<string | number> = [];
  const relation = "scope_shared_membership";
  if (!hasNegation) {
    // A union of existential conditions is itself existential. Combine
    // pure OR branches before deduplication. Positive conjunctions may
    // have highly selective operands, so keep the original set joins.
    if (hasConjunction) return null;
    const document: FilterDocument = {
      version: 1,
      root: { kind: "or", children: conditions },
    };
    const source = (sourceRelation: string, alias: string) => {
      const compiled = compileFilterDocument(document, {
        alias,
        eventAlias: alias,
        sessionSource: "scope_raw_visits",
      });
      bindings.push(...compiled.bindings);
      return `SELECT ${alias}.site_pk, ${alias}.${column} AS entity_id
        FROM ${sourceRelation} ${alias}
        ${compiled.clause}
        AND TRIM(COALESCE(${alias}.${column}, '')) != ''`;
    };
    const sql = [
      source("scope_raw_visits", "v"),
      source("scope_raw_events", "e"),
    ].join("\n  UNION\n  ");
    return {
      relation,
      ctes: [boundCte(relation, `${relation} AS (\n  ${sql}\n)`, bindings)],
    };
  }
  const source = (relation: string, alias: string) => {
    const evidence = conditions.map((condition, index) => {
      const compiled = compileFilterDocument(conditionDocument(condition), {
        alias,
        eventAlias: alias,
        sessionSource: "scope_raw_visits",
      });
      bindings.push(...compiled.bindings);
      return `MAX(CASE WHEN ${compiled.clause.slice("WHERE ".length)} THEN 1 ELSE 0 END) AS evidence_${index}`;
    });
    return `SELECT ${alias}.site_pk, ${alias}.${column} AS entity_id,
      ${evidence.join(",\n      ")}
    FROM ${relation} ${alias}
    WHERE TRIM(COALESCE(${alias}.${column}, '')) != ''
    GROUP BY ${alias}.site_pk, ${alias}.${column}`;
  };
  const evidenceSql = [
    source("scope_raw_visits", "v"),
    source("scope_raw_events", "e"),
  ].join("\n  UNION ALL\n  ");
  return {
    relation,
    ctes: [
      boundCte(
        "scope_membership_evidence",
        `scope_membership_evidence AS (
  ${evidenceSql}
)`,
        bindings,
      ),
      boundCte(
        relation,
        `${relation} AS (
  SELECT site_pk, entity_id
  FROM scope_membership_evidence
  GROUP BY site_pk, entity_id
  HAVING ${predicate}
)`,
      ),
    ],
  };
}

/**
 * Only use the shared fact aggregate for the measured same-grain positive
 * conjunctions. Event-count, cross-grain, OR/NOT and advanced collections
 * retain the separate fact path, whose selectivity can be substantially better.
 */
function canShareFactAggregation(
  expression: EntitySetExpression | null,
  entityKind: ScopedFactKind,
): boolean {
  if (!expression) return false;
  if (expression.kind === "and") {
    return (
      expression.children.length > 0 &&
      expression.children.every((child) =>
        canShareFactAggregation(child, entityKind),
      )
    );
  }
  if (expression.kind !== "condition") return false;
  const { condition } = expression;
  if (
    condition.target.kind !== "field" ||
    factKindForCondition(condition) !== entityKind
  )
    return false;
  const fields =
    entityKind === "session"
      ? ["session.views", "session.durationMs", "session.bounce"]
      : ["visitor.views", "visitor.sessions"];
  return fields.includes(condition.target.field);
}

/**
 * A positive event-count predicate cannot match an entity with zero events.
 * Qualify it directly from the event grain instead of building every fact
 * row in the visit/event universe. Preserve the old site_id grouping and
 * DISTINCT membership key; cross-grain and zero-matching predicates fall back.
 */
function compilePositiveEventCountMembership(
  expression: EntitySetExpression | null,
  entityKind: ScopedFactKind,
): MembershipSql | null {
  if (expression?.kind !== "condition") return null;
  const { condition } = expression;
  if (
    condition.target.kind !== "field" ||
    condition.target.field !== `${entityKind}.events` ||
    typeof condition.value !== "number" ||
    !Number.isFinite(condition.value)
  )
    return null;
  const value = condition.value;
  const operator =
    condition.operator === "gt" && value >= 0
      ? ">"
      : condition.operator === "gte" && value > 0
        ? ">="
        : condition.operator === "eq" && value > 0
          ? "="
          : null;
  if (!operator) return null;
  const column = entityColumn(entityKind);
  const relation = "scope_membership_0";
  return {
    relation,
    ctes: [
      boundCte(
        relation,
        `${relation} AS (
  SELECT DISTINCT site_pk, entity_id
  FROM (
    SELECT site_pk, ${column} AS entity_id
    FROM scope_raw_events
    WHERE site_pk IS NOT NULL AND site_id IS NOT NULL
      AND TRIM(COALESCE(${column}, '')) != ''
    GROUP BY site_pk, site_id, ${column}
    HAVING COUNT(*) ${operator} ?
  )
)`,
        [value],
      ),
    ],
  };
}

function compileEntityMembership(
  expression: EntitySetExpression | null,
  entityKind: ScopedFactKind,
  factKinds: ReadonlySet<ScopedFactKind>,
): MembershipSql {
  const positiveEvents = compilePositiveEventCountMembership(
    expression,
    entityKind,
  );
  if (positiveEvents) return positiveEvents;
  if (expression && factKinds.size === 0) {
    const shared = compileSharedEntityMembership(expression, entityKind);
    if (shared) return shared;
  }
  const column = entityColumn(entityKind);
  // Fact builders may emit several adjacent top-level CTEs. Assign each
  // definition an identity before composing the qualification plan.
  const sharedKind = canShareFactAggregation(expression, entityKind)
    ? entityKind
    : undefined;
  const factCtes = buildScopedFactsCtes(factKinds, sharedKind).flatMap(
    (definition) => {
      const sections = definition
        .trim()
        .split(/\),\s*(?=scope_[a-z_]+ AS \()/g);
      return sections.map((section, index) => {
        const sql = index < sections.length - 1 ? `${section})` : section;
        const name = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s+AS\s*\(/.exec(sql)?.[1];
        if (!name) throw new TypeError("Invalid fact CTE definition.");
        return boundCte(name, sql);
      });
    },
  );
  const ctes: BoundCteDefinition[] = [
    ...factCtes,
    boundCte(
      "scope_universe",
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
    ),
  ];
  // Each old AND operand is an existential fact membership set. Group
  // by the actual membership key, not site_id, so even inconsistent legacy
  // fact rows cannot change intersection semantics.
  if (sharedKind && expression?.kind === "and") {
    const conditions: FilterCondition[] = [];
    const collect = (node: EntitySetExpression) => {
      if (node.kind === "condition") conditions.push(node.condition);
      else if (node.kind === "and") node.children.forEach(collect);
      else throw new TypeError("Expected a same-grain fact conjunction.");
    };
    collect(expression);
    if (conditions.length > 1) {
      const alias = sharedKind === "session" ? "sf" : "vf";
      const bindings: Array<string | number> = [];
      const evidence = conditions.map(
        (condition) =>
          `MAX(CASE WHEN (${compileFactPredicate(condition, alias, bindings)}) THEN 1 ELSE 0 END) = 1`,
      );
      const relation = "scope_shared_fact_membership";
      ctes.push(
        boundCte(
          relation,
          `${relation} AS (
  SELECT ${alias}.site_pk, ${alias}.${column} AS entity_id
  FROM scope_${sharedKind}_facts ${alias}
  WHERE ${alias}.site_pk IS NOT NULL
  GROUP BY ${alias}.site_pk, ${alias}.${column}
  HAVING ${evidence.join(" AND ")}
)`,
          bindings,
        ),
      );
      return { relation, ctes };
    }
  }
  let index = 0;

  const compile = (node: EntitySetExpression | null): string => {
    if (!node) return "scope_universe";
    if (node.kind === "condition") {
      const compiled = compileMembershipCondition(node.condition, entityKind);
      const name = `scope_membership_${index++}`;
      ctes.push(
        boundCte(
          name,
          `
${name} AS (
${compiled.sql.replaceAll("SESSION_COLUMN", column)}
)`,
          compiled.bindings,
        ),
      );
      return name;
    }

    if (node.kind === "not") {
      const child = compile(node.child);
      const name = `scope_membership_${index++}`;
      ctes.push(
        boundCte(
          name,
          `
${name} AS (
  SELECT u.site_pk, u.entity_id
  FROM scope_universe u
  WHERE NOT EXISTS (
    SELECT 1
    FROM ${child} child
    WHERE child.site_pk = u.site_pk
      AND child.entity_id = u.entity_id
  )
)`,
        ),
      );
      return name;
    }

    const children = node.children.map(compile);
    const name = `scope_membership_${index++}`;
    if (node.kind === "or") {
      ctes.push(
        boundCte(
          name,
          `
${name} AS (
  ${children.map((child) => `SELECT site_pk, entity_id FROM ${child}`).join("\n  UNION\n  ")}
)`,
        ),
      );
    } else {
      ctes.push(
        boundCte(
          name,
          `
${name} AS (
      SELECT first_child.site_pk, first_child.entity_id
  FROM ${children[0]} first_child
  ${children
    .slice(1)
    .map((child, childIndex) => {
      const alias = `next_child_${childIndex}`;
      return `INNER JOIN ${child} ${alias} ON ${alias}.site_pk = first_child.site_pk AND ${alias}.entity_id = first_child.entity_id`;
    })
    .join("\n  ")}
)`,
        ),
      );
    }
    return name;
  };

  return { relation: compile(expression), ctes };
}

interface FilterSqlDomains {
  readonly definitions: readonly BoundCteDefinition[];
  readonly sources: SqlQualificationSources;
  readonly clock: SqlScalarTimeContext;
}

/**
 * The report query window Q is never silently widened by Filter history.
 * R supplies authorized historical activities, F supplies predicate facts,
 * and U supplies the entity universe for NOT/count=0. SQL ultimately
 * maps the qualified identity to Q for final reporting.
 */
function buildFilterSqlDomains(
  input: ScopedDatasetCompilerInput,
  time: QueryTime,
  target?: ScopedDatasetTarget,
  preserveSessionTimeline = false,
): FilterSqlDomains {
  const queryStart = input.window.startMs;
  const queryEnd = input.window.endExclusiveMs;
  const requestedFilter = time.filterRange;
  const filterStart =
    requestedFilter?.startMs ??
    (requestedFilter ? Number.MIN_SAFE_INTEGER : queryStart);
  const filterEnd =
    requestedFilter?.endExclusiveMs ??
    (requestedFilter ? time.capturedAtMs + 1 : queryEnd);
  const explicitReadStart =
    time.readRange?.startMs ??
    (time.fullHistory ? Number.MIN_SAFE_INTEGER : queryStart);
  const explicitReadEnd =
    time.readRange?.endExclusiveMs ??
    (time.fullHistory ? time.capturedAtMs + 1 : queryEnd);
  const readStart = Math.min(explicitReadStart, filterStart);
  const readEnd = Math.max(explicitReadEnd, filterEnd);
  if (
    !Number.isSafeInteger(readStart) ||
    !Number.isSafeInteger(readEnd) ||
    readEnd > time.capturedAtMs + 1 ||
    readStart >= readEnd
  ) {
    throw new RangeError("filter_evaluation_range_unavailable");
  }

  const clock: SqlScalarTimeContext = {
    nowMs: time.capturedAtMs,
    rangeStartMs: queryStart,
    rangeEndExclusiveMs: queryEnd,
    timeZone: time.reportingTimeZone,
    filterRangeExplicit: Boolean(requestedFilter),
    filterRangeEmpty: Boolean(time.filterRangeEmpty),
    filterStartMs: filterStart,
    filterEndExclusiveMs: filterEnd,
    readStartMs: readStart,
    readEndExclusiveMs: readEnd,
  };
  const readSameAsQuery = readStart === queryStart && readEnd === queryEnd;
  const readVisits = "scope_filter_read_visits";
  const readEvents = "scope_filter_read_events";
  const filterVisits = "scope_filter_evaluation_visits";
  const filterEvents = "scope_filter_evaluation_events";
  const definitions: BoundCteDefinition[] = [];
  if (readSameAsQuery) {
    definitions.push(
      boundCte(readVisits, `${readVisits} AS (SELECT * FROM scope_raw_visits)`),
      boundCte(readEvents, `${readEvents} AS (SELECT * FROM scope_raw_events)`),
    );
  } else {
    definitions.push(
      boundCte(
        readVisits,
        visitSource(input.siteIds, target).replace(
          "scope_raw_visits AS MATERIALIZED",
          `${readVisits} AS MATERIALIZED`,
        ),
        [
          ...input.siteIds,
          readStart,
          readEnd,
          ...(target ? [target.value] : []),
        ],
      ),
      boundCte(
        readEvents,
        eventSource(
          input.siteIds,
          input.compatibilityEventSource,
          target,
        ).replace(
          "scope_raw_events AS MATERIALIZED",
          `${readEvents} AS MATERIALIZED`,
        ),
        [
          ...input.siteIds,
          readStart,
          readEnd,
          ...(target ? [target.value] : []),
        ],
      ),
    );
  }

  if (time.filterRangeEmpty) {
    definitions.push(
      boundCte(
        filterVisits,
        `${filterVisits} AS (SELECT * FROM ${readVisits} WHERE 0)`,
      ),
      boundCte(
        filterEvents,
        `${filterEvents} AS (SELECT * FROM ${readEvents} WHERE 0)`,
      ),
    );
  } else if (requestedFilter) {
    definitions.push(
      boundCte(
        filterVisits,
        `${filterVisits} AS (SELECT * FROM ${readVisits}
          WHERE started_at >= ? AND started_at < ?)`,
        [filterStart, filterEnd],
      ),
      boundCte(
        filterEvents,
        `${filterEvents} AS (SELECT * FROM ${readEvents}
          WHERE occurred_at >= ? AND occurred_at < ?)`,
        [filterStart, filterEnd],
      ),
    );
  } else {
    definitions.push(
      boundCte(
        filterVisits,
        `${filterVisits} AS (SELECT * FROM scope_raw_visits)`,
      ),
      boundCte(
        filterEvents,
        `${filterEvents} AS (SELECT * FROM scope_raw_events)`,
      ),
    );
  }
  // Sessionless visits use visit_id as their timeline key. Preserve only
  // the possible collision and its events in R, not in F or U or Q.
  const collisionTimeline =
    target?.type === "session" && preserveSessionTimeline;
  const timelineVisits = collisionTimeline
    ? "scope_filter_timeline_visits"
    : readVisits;
  const timelineEvents = collisionTimeline
    ? "scope_filter_timeline_events"
    : readEvents;
  if (collisionTimeline) {
    definitions.push(
      boundCte(
        timelineVisits,
        `${timelineVisits} AS (
          SELECT site_pk, session_id, visitor_id, visit_id, started_at FROM ${readVisits}
          UNION ALL
          SELECT site_pk, session_id, visitor_id, visit_id, started_at FROM visits
          WHERE site_pk IN ${siteIdsSql(input.siteIds)} AND visit_id = ?
            AND (session_id IS NULL OR session_id = '')
            AND started_at >= ? AND started_at < ?
        )`,
        [...input.siteIds, target.value, readStart, readEnd],
      ),
      boundCte(
        timelineEvents,
        `${timelineEvents} AS (
          SELECT site_pk, session_id, visitor_id, visit_id, event_pk, event_id, occurred_at FROM ${readEvents}
          UNION ALL
          SELECT ce.site_pk, v.session_id, v.visitor_id, ce.visit_id, ce.event_pk, ce.event_id, ce.occurred_at
          FROM visits v
          INNER JOIN custom_events ce ON ce.site_pk = v.site_pk AND ce.visit_id = v.visit_id
          INNER JOIN custom_event_names cen ON cen.id = ce.event_name_id
          WHERE v.site_pk IN ${siteIdsSql(input.siteIds)} AND v.visit_id = ?
            AND (v.session_id IS NULL OR v.session_id = '')
            AND ce.occurred_at >= ? AND ce.occurred_at < ?
        )`,
        [...input.siteIds, target.value, readStart, readEnd],
      ),
    );
  }
  const hasExplicitQualificationRange = Boolean(
    requestedFilter || time.filterRangeEmpty,
  );
  return {
    definitions,
    sources: {
      candidateVisits: "scope_raw_visits",
      candidateEvents: "scope_raw_events",
      universeVisits: hasExplicitQualificationRange
        ? filterVisits
        : "scope_raw_visits",
      universeEvents: hasExplicitQualificationRange
        ? filterEvents
        : "scope_raw_events",
      filterVisits,
      filterEvents,
      readVisits,
      readEvents,
      ...(collisionTimeline ? { timelineVisits, timelineEvents } : {}),
      uniqueLocalOccurrences:
        target !== undefined && !input.compatibilityEventSource,
      uniqueGlobalOccurrences:
        target === undefined && !input.compatibilityEventSource,
    },
    clock,
  };
}

/**
 * Compile validated basic Filter SQL into typed, site-scoped qualification
 * relations. The read sources and authorization belong to the enclosing
 * Scoped Dataset, not to the expression compiler.
 *
 * Advanced AST expressions continue through the historical path until P5;
 * unsupported expressions must never be treated as a match-all.
 */
export function compileSqlQualification(
  filters: FilterDocument,
  plan: ScopedFilterPlan,
  domains?: FilterSqlDomains,
): FilterQualificationSql {
  if (filterDocumentUsesAdvancedExpressions(filters)) {
    if (!domains)
      throw new TypeError("Advanced SQL requires authorized time domains.");
    return compileCollectionSqlQualification(
      filters,
      plan.scope,
      domains.sources,
      domains.clock,
    );
  }
  if (plan.mode === "entity" && plan.membership.kind === "entity") {
    const membership = compileEntityMembership(
      plan.membership.expression,
      plan.membership.entityKind,
      factEntityKindsForFilter(filters.root),
    );
    return {
      kind: "entity",
      entityKind: plan.membership.entityKind,
      qualifiedEntityRelation: membership.relation,
      ctes: membership.ctes,
    };
  }
  return compileObservationQualification(filters);
}

function compileObservationQualification(
  filters: FilterDocument,
  fullRows = false,
): FilterQualificationSql {
  const observationPlan = planObservationFilter(filters.root);
  return {
    kind: "observation",
    matchedVisitRelation: "scope_matching_visits",
    matchedEventRelation: "scope_matching_events",
    ctes: [
      compileObservationRelation(
        "scope_matching_visits",
        "scope_raw_visits",
        "v",
        observationPlan.visit,
        "visit",
        fullRows,
      ),
      compileObservationRelation(
        "scope_matching_events",
        "scope_raw_events",
        "e",
        observationPlan.event,
        "event",
        fullRows,
      ),
    ],
  };
}

// These strategies use only columns copied unchanged from the linked Visit
// into the Event source. Keep this allowlist explicit: a new registered
// strategy may use event-specific or entity-wide evidence.
const VISIT_CONTEXT_STRATEGIES = new Set([
  "column.pathname",
  "column.title",
  "column.hostname",
  "column.query_string",
  "column.hash_fragment",
  "column.referrer_host",
  "column.referrer_url",
  "column.utm_source",
  "column.utm_medium",
  "column.utm_campaign",
  "column.utm_term",
  "column.utm_content",
  "column.browser",
  "column.browser_version",
  "column.os",
  "column.device_type",
  "column.language",
  "column.country",
  "column.region",
  "column.city",
  "column.continent",
  "column.timezone",
  "column.as_organization",
  "column.duration_ms",
  "column.perf_ttfb_ms",
  "column.perf_fcp_ms",
  "column.perf_lcp_ms",
  "column.perf_cls",
  "column.perf_inp_ms",
  "column.user_id",
  "column.user_name",
  "column.screen_width",
  "column.screen_height",
  "column.is_eu",
  "derived.trafficChannel",
  "derived.browserEngine",
  "derived.osVersion",
  "derived.screenSize",
]);

function isVisitContextPredicate(expression: FilterExpression): boolean {
  if (expression.kind === "not")
    return isVisitContextPredicate(expression.child);
  if (expression.kind !== "condition") {
    return expression.children.every(isVisitContextPredicate);
  }
  if (expression.target.kind !== "field") return false;
  const definition = analyticsFilterDefinition(expression.target.field);
  return Boolean(
    definition &&
    definition.source === "visit" &&
    definition.evaluation === "observation" &&
    definition.observationKinds.has("visit") &&
    definition.observationKinds.has("event") &&
    VISIT_CONTEXT_STRATEGIES.has(definition.compilerStrategy),
  );
}

/**
 * Membership commutes with restriction to one identity only when every
 * predicate reads evidence local to that identity. Keep explicit strategies
 * for observations and facts; do not infer locality from a field prefix.
 * Pure positive Event predicates can already be cheaper on sparse sites.
 */
function targetMembershipEvidence(
  expression: FilterExpression,
  kind: ScopedFactKind,
): { local: boolean; broad: boolean } {
  if (isVisitContextPredicate(expression)) return { local: true, broad: true };
  if (expression.kind === "not") {
    const child = targetMembershipEvidence(expression.child, kind);
    return { local: child.local, broad: true };
  }
  if (expression.kind !== "condition") {
    const children = expression.children.map((child) =>
      targetMembershipEvidence(child, kind),
    );
    return {
      local: children.every((child) => child.local),
      broad: children.some((child) => child.broad),
    };
  }
  const target = expression.target;
  if (
    target.kind === "event-payload" ||
    (target.kind === "field" && target.field === "event.name")
  )
    return { local: true, broad: false };
  const fields =
    kind === "session"
      ? [
          "session.views",
          "session.durationMs",
          "session.events",
          "session.bounce",
        ]
      : ["visitor.views", "visitor.sessions", "visitor.events"];
  const sameGrain =
    target.kind === "field" &&
    fields.includes(target.field) &&
    factKindForCondition(expression) === kind;
  return { local: sameGrain, broad: sameGrain };
}
/**
 * A deliberately small proof of locality for advanced collection predicates.
 * Page/Event roots stay correlated to the original entity anchor; selectors
 * over Session/Visitor could change that anchor and must not be narrowed.
 * Preserve the full authorized time domains even when narrowing identity.
 */
type LocalOccurrenceKind = "page" | "event";
interface LocalRelationProof {
  needsAdjacency: boolean;
}
function localOccurrenceCollection(
  target: FilterTargetExpression,
  proof: LocalRelationProof,
): LocalOccurrenceKind | null {
  if (target.kind === "entity-root")
    return target.entity === "page" || target.entity === "event"
      ? target.entity
      : null;
  if (target.kind === "selector") {
    const kind = localOccurrenceCollection(target.collection, proof);
    return kind && localRelationExpression(target.predicate, proof, kind)
      ? kind
      : null;
  }
  if (target.kind === "window") {
    const kind = localOccurrenceCollection(target.collection, proof);
    const anchor = target.anchor;
    const localAnchor =
      anchor.kind === "time-anchor" ||
      (anchor.kind === "reducer" &&
        ["first", "last", "nth"].includes(anchor.reducer) &&
        localOccurrenceCollection(anchor.input, proof) !== null) ||
      (anchor.kind === "occurrence-time" &&
        localRelationTarget(anchor, null, proof));
    return kind && localAnchor ? kind : null;
  }
  return null;
}
/** Derived selectors cannot change the anchor, but may introduce new evidence.
 * Admit only intrinsics whose SQL reads the already selected occurrences. */
function localDerivedPredicate(
  expression: FilterExpression,
  kind: "sequence" | "period",
): boolean {
  if (expression.kind === "not")
    return localDerivedPredicate(expression.child, kind);
  if (expression.kind !== "condition")
    return expression.children.every((child) =>
      localDerivedPredicate(child, kind),
    );
  const target = expression.target;
  if (kind === "period")
    return (
      target.kind === "reducer" &&
      target.reducer === "count" &&
      target.input.kind === "context-intrinsic" &&
      target.input.intrinsic === "items"
    );
  if (target.kind !== "context-intrinsic" || target.context !== "sequence")
    return false;
  if (target.intrinsic === "span" || target.intrinsic === "gap") return true;
  const input = target.input;
  return (
    input.kind === "current-payload" ||
    (input.kind === "member" &&
      input.object.kind === "context-root" &&
      input.object.context === "current" &&
      (input.member === "name" || input.member === "path"))
  );
}
function localPeriodCollection(
  target: FilterTargetExpression,
  proof: LocalRelationProof,
): boolean {
  if (target.kind === "periods")
    return localOccurrenceCollection(target.collection, proof) !== null;
  return (
    target.kind === "selector" &&
    localPeriodCollection(target.collection, proof) &&
    localDerivedPredicate(target.predicate, "period")
  );
}
function localSequenceCollection(
  target: FilterTargetExpression,
  proof: LocalRelationProof,
): boolean {
  if (target.kind === "selector")
    return (
      localSequenceCollection(target.collection, proof) &&
      localDerivedPredicate(target.predicate, "sequence")
    );
  if (target.kind === "sequence")
    return target.steps.every(
      (step) => localOccurrenceCollection(step, proof) !== null,
    );
  if (target.kind === "without")
    return (
      localSequenceCollection(target.sequence, proof) &&
      localOccurrenceCollection(target.excluded, proof) !== null
    );
  if (target.kind === "adjacent") {
    proof.needsAdjacency = true;
    return localSequenceCollection(target.sequence, proof);
  }
  return false;
}
function localRelationTarget(
  target: FilterTargetExpression,
  current: LocalOccurrenceKind | null,
  proof: LocalRelationProof,
): boolean {
  switch (target.kind) {
    case "entity-root":
    case "window":
      return localOccurrenceCollection(target, proof) !== null;
    case "selector":
      return (
        localOccurrenceCollection(target, proof) !== null ||
        localSequenceCollection(target, proof) ||
        localPeriodCollection(target, proof)
      );
    case "sequence":
    case "without":
    case "adjacent":
      return localSequenceCollection(target, proof);
    case "periods":
      return localPeriodCollection(target, proof);
    case "event-payload":
    case "current-payload":
      return current === "event";
    case "field":
      return (
        current !== null &&
        (target.field === "event.name" ||
          isVisitContextPredicate({
            kind: "condition",
            target,
            operator: "exists",
          }))
      );
    case "reducer":
      return (
        target.reducer === "count" &&
        (localOccurrenceCollection(target.input, proof) !== null ||
          localSequenceCollection(target.input, proof) ||
          localPeriodCollection(target.input, proof))
      );
    case "member": {
      const root = target.object;
      const kind =
        root.kind === "context-root" && root.context === "current"
          ? current
          : root.kind === "reducer" &&
              ["first", "last", "nth"].includes(root.reducer)
            ? localOccurrenceCollection(root.input, proof)
            : null;
      return (
        kind !== null &&
        ((target.member === "time" && root.kind === "context-root") ||
          (kind === "event" && target.member === "name") ||
          (kind === "page" && target.member === "path"))
      );
    }
    case "occurrence-time":
      return (
        target.input.kind === "reducer" &&
        ["first", "last", "nth"].includes(target.input.reducer) &&
        localOccurrenceCollection(target.input.input, proof) !== null
      );
    case "arithmetic":
      return (
        localRelationTarget(target.left, current, proof) &&
        localRelationTarget(target.right, current, proof)
      );
    case "time-anchor":
    case "duration":
      return true;
    default:
      return false;
  }
}
function localRelationExpression(
  expression: FilterExpression,
  proof: LocalRelationProof,
  current: LocalOccurrenceKind | null = null,
): boolean {
  if (expression.kind === "not")
    return localRelationExpression(expression.child, proof, current);
  if (expression.kind !== "condition")
    return expression.children.every((child) =>
      localRelationExpression(child, proof, current),
    );
  return localRelationTarget(expression.target, current, proof);
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

  const advanced =
    input.filters.root !== null &&
    filterDocumentUsesAdvancedExpressions(input.filters);
  const targetEvidence =
    input.target && input.filters.root && !advanced
      ? targetMembershipEvidence(input.filters.root, input.target.type)
      : null;
  const relationProof: LocalRelationProof = { needsAdjacency: false };
  const target =
    input.target &&
    input.siteIds.length === 1 &&
    input.plan.scope === input.target.type &&
    input.plan.mode === "entity" &&
    input.plan.membership.kind === "entity" &&
    input.plan.membership.entityKind === input.target.type &&
    input.filters.root !== null &&
    (advanced
      ? !input.compatibilityEventSource &&
        localRelationExpression(input.filters.root, relationProof)
      : targetEvidence?.local &&
        targetEvidence.broad &&
        !compilePositiveEventCountMembership(
          input.plan.membership.expression,
          input.target.type,
        ))
      ? input.target
      : undefined;
  const domains = advanced
    ? buildFilterSqlDomains(
        input,
        metadata!.time,
        target,
        relationProof.needsAdjacency,
      )
    : undefined;
  // Both observation predicates read the same linked Visit columns. An
  // Event matching such a predicate cannot qualify a nonmatching in-window
  // Visit. Events outside the Visit window still remain independently
  // eligible by occurred_at. Do not apply this rule to explicit entity
  // scopes, Event payloads, boundary facts or advanced expressions.
  const directVisitContext =
    input.plan.scope === "event" &&
    input.plan.mode === "observation" &&
    input.filters.root !== null &&
    !domains &&
    isVisitContextPredicate(input.filters.root);
  const qualification = directVisitContext
    ? compileObservationQualification(input.filters, true)
    : compileSqlQualification(input.filters, input.plan, domains);
  const entityColumnName =
    input.plan.mode === "entity" && input.plan.membership.kind === "entity"
      ? entityColumn(input.plan.membership.entityKind)
      : null;
  // In an unfiltered observation scope every raw Visit and Event already
  // qualifies. Rejoining identity sets cannot add rows to these time-bounded,
  // authorized relations; it only forces scans of unrelated observations.
  // Explicit entity scopes still apply their nonempty identity constraints.
  const matchesAllObservations =
    input.filters.root === null &&
    input.plan.scope === "event" &&
    input.plan.mode === "observation";
  // Empty entity membership equals the universe of nonempty identities.
  // Each raw row with a valid identity already contributes to that universe,
  // so a join to it is redundant even for Event-only entities.
  const matchesAllEntities =
    input.filters.root === null &&
    input.plan.mode === "entity" &&
    input.plan.membership.kind === "entity" &&
    input.plan.membership.expression === null &&
    entityColumnName !== null;
  const allowSourceInlining =
    matchesAllObservations || matchesAllEntities || directVisitContext;
  const finalVisitRelation = matchesAllObservations
    ? "scope_final_visits AS (SELECT * FROM scope_raw_visits)"
    : matchesAllEntities
      ? `scope_final_visits AS (SELECT * FROM scope_raw_visits WHERE TRIM(COALESCE(${entityColumnName}, '')) != '')`
      : directVisitContext
        ? "scope_final_visits AS (SELECT * FROM scope_matching_visits)"
        : input.plan.mode === "entity"
          ? `
scope_final_visits AS (
  SELECT rv.*
  FROM scope_raw_visits rv
  INNER JOIN ${qualification.kind === "entity" ? qualification.qualifiedEntityRelation : "scope_universe"} matching_entities
    ON matching_entities.site_pk = rv.site_pk
   AND matching_entities.entity_id = rv.${entityColumnName}
  WHERE TRIM(COALESCE(rv.${entityColumnName}, '')) != ''
)`
          : `
scope_final_visits AS (
  SELECT rv.*
  FROM scope_raw_visits rv
  INNER JOIN scope_matching_visit_ids matching_visits
    ON matching_visits.site_pk = rv.site_pk
   AND matching_visits.visit_id = rv.visit_id
)`;
  const finalEventRelation = matchesAllObservations
    ? "scope_final_events AS (SELECT * FROM scope_raw_events)"
    : matchesAllEntities
      ? `scope_final_events AS (SELECT * FROM scope_raw_events WHERE TRIM(COALESCE(${entityColumnName}, '')) != '')`
      : directVisitContext
        ? "scope_final_events AS (SELECT * FROM scope_matching_events)"
        : input.plan.mode === "entity"
          ? `
scope_final_events AS (
  SELECT re.*
  FROM scope_raw_events re
  INNER JOIN ${qualification.kind === "entity" ? qualification.qualifiedEntityRelation : "scope_universe"} matching_entities
    ON matching_entities.site_pk = re.site_pk
   AND matching_entities.entity_id = re.${entityColumnName}
  WHERE TRIM(COALESCE(re.${entityColumnName}, '')) != ''
)`
          : `
scope_final_events AS (
  SELECT re.*
  FROM scope_raw_events re
  INNER JOIN ${qualification.kind === "observation" ? qualification.matchedEventRelation : "scope_matching_events"} matching_events
    ON matching_events.site_pk = re.site_pk
   AND matching_events.event_id = re.event_id
)`;
  const definitions: BoundCteDefinition[] = [
    boundCte(
      "scope_raw_visits",
      allowSourceInlining
        ? visitSource(input.siteIds, target).replace(
            "scope_raw_visits AS MATERIALIZED (",
            "scope_raw_visits AS (",
          )
        : visitSource(input.siteIds, target),
      [
        ...input.siteIds,
        input.window.startMs,
        input.window.endExclusiveMs,
        ...(target ? [target.value] : []),
      ],
    ),
    boundCte(
      "scope_raw_events",
      allowSourceInlining
        ? eventSource(
            input.siteIds,
            input.compatibilityEventSource,
            target,
          ).replace(
            "scope_raw_events AS MATERIALIZED (",
            "scope_raw_events AS (",
          )
        : eventSource(input.siteIds, input.compatibilityEventSource, target),
      [
        ...input.siteIds,
        input.window.startMs,
        input.window.endExclusiveMs,
        ...(target ? [target.value] : []),
      ],
    ),
    boundCte(
      "visit_source",
      "visit_source AS (SELECT * FROM scope_raw_visits)",
    ),
    ...(domains?.definitions ?? []),
    ...(qualification?.ctes ?? []),
  ];
  if (
    qualification.kind === "observation" &&
    !matchesAllObservations &&
    !directVisitContext
  ) {
    // An Event qualifies its associated Visit for report output; the Visit
    // does not thereby match the Event predicate itself.
    definitions.push(
      boundCte(
        "scope_matching_visit_ids",
        `
scope_matching_visit_ids AS (
  SELECT site_pk, visit_id FROM ${qualification.matchedVisitRelation}
  UNION
  SELECT e.site_pk, e.visit_id
  FROM scope_raw_events e
  INNER JOIN ${qualification.matchedEventRelation} matched
    ON matched.site_pk = e.site_pk AND matched.event_id = e.event_id
)`,
      ),
    );
  }
  definitions.push(
    boundCte("scope_final_visits", finalVisitRelation),
    boundCte("scope_final_events", finalEventRelation),
    boundCte(
      "scope_final_sessions",
      `
scope_final_sessions AS (
  SELECT DISTINCT site_pk, session_id
  FROM scope_final_visits
  WHERE TRIM(COALESCE(session_id, '')) != ''
  UNION
  SELECT DISTINCT site_pk, session_id
  FROM scope_final_events
  WHERE TRIM(COALESCE(session_id, '')) != ''
)`,
    ),
    boundCte(
      "scope_final_visitors",
      `
scope_final_visitors AS (
  SELECT DISTINCT site_pk, visitor_id
  FROM scope_final_visits
  WHERE TRIM(COALESCE(visitor_id, '')) != ''
  UNION
  SELECT DISTINCT site_pk, visitor_id
  FROM scope_final_events
  WHERE TRIM(COALESCE(visitor_id, '')) != ''
)`,
    ),
  );
  const composed = composeBoundCtes(definitions);
  return {
    ctes: composed.ctes,
    bindings: composed.bindings,
    visitRelation: "scope_final_visits",
    eventRelation: "scope_final_events",
    sessionRelation: "scope_final_sessions",
    visitorRelation: "scope_final_visitors",
    scope: input.plan.scope,
    // Canonical raw Visits and Events have unique primary/source IDs.
    // Observation qualification projects those IDs with WHERE predicates;
    // matching Visit IDs use UNION. Entity membership leaves deduplicate
    // their (site_pk, entity_id) keys, AND joins unique sets, OR uses UNION,
    // and NOT filters a unique universe. Advanced membership likewise
    // filters a grouped/unioned universe. None of these final joins can
    // multiply a canonical observation. Stage filters only narrow rows.
    // Basic entity facts can change the SQLite plan for empty matches.
    // Keep their conservative path until that cost is independently proven.
    // Compatibility and externally supplied datasets retain the old guard.
    uniqueObservationIds:
      !input.compatibilityEventSource &&
      (allowSourceInlining ||
        domains !== undefined ||
        factEntityKindsForFilter(input.filters.root).size === 0),
    materializedEventFacts:
      input.plan.scope === "event" &&
      !allowSourceInlining &&
      filterDocumentHasSimpleEventFacts(input.filters),
  };
}
