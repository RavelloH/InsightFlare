import {
  analyticsFilterDefinition,
  attachScopedFilterMetadata,
  compileFilterDocument,
  createQueryTime,
  createScopedFilterPlan,
  type EntitySetExpression,
  factEntityKindsForFilter,
  type FilterCondition,
  type FilterDocument,
  type FilterScope,
  type FilterValue,
  type ObservationPredicatePlan,
  planObservationFilter,
  type QueryOperation,
  type ScopedDatasetSql,
  scopedFilterMetadata,
  type ScopedFilterPlan,
  type SqlBinding,
} from "@/lib/edge/analytics/contract";
import {
  SITE_PK_FROM_SITE_ID_SQL,
  sitePksFromSiteIdsSql,
} from "@/lib/edge/site-identity-sql";

import { buildVisitFilterSql } from "./core-filters";
import {
  buildEventAnalyticsSourceCte,
  buildVisitSourceCte,
  VISIT_SOURCE_COLUMNS,
} from "./core-sources";
import type { QueryWindow } from "./core-types";
import { buildScopedFactsCtes, type ScopedFactKind } from "./scoped-facts";

export interface ScopedDatasetCompilerInput {
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

  const plan = createScopedFilterPlan(operation, filters, scope);
  if (!plan) return null;
  if (factEntityKindsForFilter(filters.root).size === 0) {
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

function visitSource(siteIds: readonly string[]): string {
  return `
scope_raw_visits AS MATERIALIZED (
  SELECT ${VISIT_SOURCE_COLUMNS}
  FROM visits
  WHERE site_pk IN ${siteIdsSql(siteIds)}
    AND started_at >= ? AND started_at < ?
)`;
}

function eventSource(
  siteIds: readonly string[],
  compatibility = false,
): string {
  // Custom events are windowed by occurred_at. The linked visit supplies
  // identity and context even when that visit started outside the window.
  return buildEventAnalyticsSourceCte({
    cteName: "scope_raw_events",
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
  entityKind: ScopedFactKind,
  factKinds: ReadonlySet<ScopedFactKind>,
): MembershipSql {
  const column = entityColumn(entityKind);
  const ctes: string[] = [
    ...buildScopedFactsCtes(factKinds),
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
      const compiled = compileMembershipCondition(node.condition, entityKind);
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
    .map((child, childIndex) => {
      const alias = `next_child_${childIndex}`;
      return `INNER JOIN ${child} ${alias} ON ${alias}.site_pk = first_child.site_pk AND ${alias}.entity_id = first_child.entity_id`;
    })
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
          factEntityKindsForFilter(input.filters.root),
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
${eventSource(input.siteIds, input.compatibilityEventSource)},
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
