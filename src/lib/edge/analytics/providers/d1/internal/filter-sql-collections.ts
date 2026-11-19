import { resolveEntityMember } from "@/lib/filter-contract/filter-members";
import {
  analyticsFilterDefinition,
  analyticsFilterRegistry,
} from "@/lib/filter-contract/filter-registry";
import type {
  FilterCondition,
  FilterDocument,
  FilterExpression,
  FilterOperator,
  FilterTargetExpression,
  FilterValue,
} from "@/lib/filter-contract/filters";

import { compileFilterDocument } from "./filter-compiler";
import { compileExactJsonPointerPredicate } from "./filter-json-pointer";
import {
  boundCte,
  type BoundCteDefinition,
  type FilterQualificationSql,
  safeQualificationIdentifier,
} from "./filter-qualification";
import { buildScopedFactsCtes } from "./scoped-facts";

type EntityKind = "event" | "page" | "session" | "visitor";
type RootScope = "event" | "session" | "visitor";

/** Local source relations supplied by the authorized SQL dataset. */
export interface SqlQualificationSources {
  /** Candidate/Report observation range (Q). */
  readonly candidateVisits?: string;
  readonly candidateEvents?: string;
  /** Entity qualification universe (U), potentially different from Q. */
  readonly universeVisits?: string;
  readonly universeEvents?: string;
  /** Predicate activity range (F); may be historical. */
  readonly filterVisits?: string;
  readonly filterEvents?: string;
}

interface SqlFragment {
  readonly sql: string;
  readonly bindings: readonly (string | number | null)[];
}

interface PredicateFragment extends SqlFragment {
  readonly applicable: boolean;
}

interface SqlFrame {
  /** The parent entity to which root collections are correlated. */
  readonly anchorAlias: string;
  readonly anchorKind: EntityKind;
  /** The item whose fields/payload are read by the current predicate. */
  readonly currentAlias: string;
  readonly currentKind: EntityKind;
}

interface SqlCollectionRef extends SqlFragment {
  readonly entityKind: EntityKind;
}

function scalar(value: unknown): value is FilterValue {
  return (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean" ||
    (typeof value === "number" && Number.isFinite(value))
  );
}

function typedBinding(value: FilterValue): string | number | null {
  return typeof value === "boolean" ? Number(value) : value;
}

function compareScalar(
  left: SqlFragment,
  operator: FilterOperator,
  value: unknown,
): SqlFragment {
  switch (operator) {
    case "exists":
    case "notNull":
      return { sql: `${left.sql} IS NOT NULL`, bindings: left.bindings };
    case "notExists":
    case "isNull":
      return { sql: `${left.sql} IS NULL`, bindings: left.bindings };
    case "isEmpty":
    case "notEmpty":
      return {
        sql: `${left.sql} ${operator === "isEmpty" ? "=" : "!="} ''`,
        bindings: left.bindings,
      };
    case "between": {
      if (!Array.isArray(value) || value.length !== 2 || !value.every(scalar)) {
        throw new TypeError("SQL BETWEEN requires two scalar values.");
      }
      return {
        sql: `${left.sql} BETWEEN ? AND ?`,
        bindings: [
          ...left.bindings,
          typedBinding(value[0]),
          typedBinding(value[1]),
        ],
      };
    }
    case "in":
    case "notIn": {
      if (!Array.isArray(value) || !value.length || !value.every(scalar)) {
        throw new TypeError("SQL membership requires scalar values.");
      }
      return {
        sql: `${left.sql} ${operator === "in" ? "IN" : "NOT IN"} (${value.map(() => "?").join(", ")})`,
        bindings: [...left.bindings, ...value.map(typedBinding)],
      };
    }
    case "contains":
    case "startsWith":
    case "endsWith": {
      if (typeof value !== "string") throw new TypeError("Expected a string.");
      const escaped = value.replace(/[\\%_]/g, "\\$&");
      const pattern =
        operator === "contains"
          ? `%${escaped}%`
          : operator === "startsWith"
            ? `${escaped}%`
            : `%${escaped}`;
      return {
        sql: `${left.sql} LIKE ? ESCAPE '\\'`,
        bindings: [...left.bindings, pattern],
      };
    }
    default: {
      if (!scalar(value)) throw new TypeError("Expected a scalar comparison.");
      const comparison: Record<string, string> = {
        eq: "=",
        neq: "!=",
        gt: ">",
        gte: ">=",
        lt: "<",
        lte: "<=",
      };
      const symbol = comparison[operator];
      if (!symbol)
        throw new TypeError(`Unsupported scalar comparison: ${operator}`);
      return {
        sql: `${left.sql} ${symbol} ?`,
        bindings: [...left.bindings, typedBinding(value)],
      };
    }
  }
}

function onlyApplicable(expression: PredicateFragment): PredicateFragment {
  return expression.applicable
    ? expression
    : { sql: "0", bindings: [], applicable: false };
}

class SqlCollectionCompiler {
  private aliasIndex = 0;

  constructor(private readonly sources: SqlQualificationSources) {}

  private alias(): string {
    return `filter_item_${++this.aliasIndex}`;
  }

  private anchorIdentity(kind: EntityKind, alias: string): string {
    if (kind === "visitor") return `${alias}.visitor_id`;
    if (kind === "session") return `${alias}.session_id`;
    return `${alias}.visit_id`;
  }

  private relationship(
    frame: SqlFrame,
    itemAlias: string,
    itemKind: EntityKind,
  ): string {
    const outer = frame.anchorAlias;
    const inner = itemAlias;
    const clauses = [`${inner}.site_pk = ${outer}.site_pk`];
    if (frame.anchorKind === "visitor" || itemKind === "visitor") {
      clauses.push(`${inner}.visitor_id = ${outer}.visitor_id`);
    } else if (frame.anchorKind === "session") {
      clauses.push(`${inner}.session_id = ${outer}.session_id`);
    } else if (itemKind === "session") {
      clauses.push(`${inner}.session_id = ${outer}.session_id`);
    } else {
      // Visit/Event roots in observation scope normally use the local
      // Session. For sessionless observations, only the same Visit is local.
      clauses.push(`(
        (TRIM(COALESCE(${outer}.session_id, '')) != ''
          AND ${inner}.session_id = ${outer}.session_id)
        OR (TRIM(COALESCE(${outer}.session_id, '')) = ''
          AND ${inner}.visit_id = ${outer}.visit_id)
      )`);
    }
    return clauses.join(" AND ");
  }

  private source(kind: EntityKind): string {
    switch (kind) {
      case "page":
        return this.sources.filterVisits ?? "scope_raw_visits";
      case "event":
        return this.sources.filterEvents ?? "scope_raw_events";
      case "session":
        return "scope_filter_sessions";
      case "visitor":
        return "scope_filter_visitors";
    }
  }

  private collection(
    target: FilterTargetExpression,
    frame: SqlFrame,
  ): SqlCollectionRef {
    if (target.kind === "entity-root") {
      const name = this.alias();
      const source = this.source(target.entity);
      return {
        sql: `SELECT ${name}.* FROM ${source} ${name}
          WHERE ${this.relationship(frame, name, target.entity)}`,
        bindings: [],
        entityKind: target.entity,
      };
    }
    if (target.kind === "selector") {
      const parent = this.collection(target.collection, frame);
      const alias = this.alias();
      const child: SqlFrame = {
        anchorAlias:
          parent.entityKind === "session" || parent.entityKind === "visitor"
            ? alias
            : frame.anchorAlias,
        anchorKind:
          parent.entityKind === "session" || parent.entityKind === "visitor"
            ? parent.entityKind
            : frame.anchorKind,
        currentAlias: alias,
        currentKind: parent.entityKind,
      };
      const predicate = onlyApplicable(
        this.expression(target.predicate, child),
      );
      return {
        sql: `SELECT ${alias}.* FROM (${parent.sql}) ${alias}
          WHERE ${predicate.sql}`,
        bindings: [...parent.bindings, ...predicate.bindings],
        entityKind: parent.entityKind,
      };
    }
    throw new TypeError(
      `SQL collection kind is not implemented: ${target.kind}`,
    );
  }

  private fieldCondition(
    condition: FilterCondition,
    frame: SqlFrame,
  ): PredicateFragment {
    const target = condition.target;
    if (target.kind !== "field") {
      throw new TypeError("Expected registered Field Condition.");
    }
    const definition = analyticsFilterDefinition(target.field);
    if (!definition) throw new TypeError("Unknown field.");
    const applicable =
      frame.currentKind === "event" || frame.currentKind === "page"
        ? definition.evaluation === "session-fact" ||
          definition.evaluation === "visitor-fact" ||
          definition.observationKinds.has(
            frame.currentKind === "event" ? "event" : "visit",
          )
        : definition.source === frame.currentKind;
    if (!applicable) return { sql: "0", bindings: [], applicable: false };
    if (
      definition.evaluation === "session-fact" ||
      definition.evaluation === "visitor-fact"
    ) {
      const session = definition.evaluation === "session-fact";
      const relation = session ? "scope_session_facts" : "scope_visitor_facts";
      const identity = session ? "session_id" : "visitor_id";
      if (!definition.compilerStrategy?.startsWith("fact.")) {
        throw new TypeError("Fact field has no registered SQL column.");
      }
      const column = safeQualificationIdentifier(
        definition.compilerStrategy.slice(5),
      );
      const factValue = {
        sql: `COALESCE((
          SELECT fact_value.${column} FROM ${relation} fact_value
          WHERE fact_value.site_pk = ${frame.currentAlias}.site_pk
            AND fact_value.${identity} = ${frame.currentAlias}.${identity}
        ), 0)`,
        bindings: [],
      };
      return {
        ...compareScalar(factValue, condition.operator, condition.value),
        applicable: true,
      };
    }
    const compiled = compileFilterDocument(
      { version: 1, root: condition },
      {
        alias: frame.currentAlias,
        eventAlias: frame.currentAlias,
        sessionSource: "scope_raw_visits",
      },
    );
    const clause = compiled.clause.replace(/^\s*WHERE\s+/i, "").trim();
    if (!clause) throw new TypeError("Field predicate has no SQL condition.");
    return { sql: clause, bindings: compiled.bindings, applicable: true };
  }

  private currentMember(
    target: FilterTargetExpression,
    kind: EntityKind,
  ): string | null {
    if (target.kind !== "member") return null;
    const parts: string[] = [];
    let current: FilterTargetExpression = target;
    while (current.kind === "member") {
      parts.unshift(current.member);
      current = current.object;
    }
    if (current.kind !== "context-root" || current.context !== "current") {
      return null;
    }
    return (
      resolveEntityMember(kind, parts.join("."), analyticsFilterRegistry)
        ?.fieldId ?? null
    );
  }

  private condition(
    condition: FilterCondition,
    frame: SqlFrame,
  ): PredicateFragment {
    const target = condition.target;
    if (target.kind === "field") return this.fieldCondition(condition, frame);
    if (target.kind === "event-payload" || target.kind === "current-payload") {
      if (frame.currentKind !== "event") {
        return { sql: "0", bindings: [], applicable: false };
      }
      const compiled = compileExactJsonPointerPredicate(
        condition,
        frame.currentAlias,
      );
      return { ...compiled, applicable: true };
    }
    if (target.kind === "member") {
      const fieldId = this.currentMember(target, frame.currentKind);
      if (fieldId) {
        return this.fieldCondition(
          {
            ...condition,
            target: { kind: "field", field: fieldId as never },
          },
          frame,
        );
      }
      let root: FilterTargetExpression = target;
      while (root.kind === "member") root = root.object;
      if (root.kind !== "context-root" || root.context !== "current") {
        throw new TypeError("SQL member target is not implemented.");
      }
      return { sql: "0", bindings: [], applicable: false };
    }
    if (target.kind === "selector" || target.kind === "entity-root") {
      const collection = this.collection(target, frame);
      const found = `EXISTS (SELECT 1 FROM (${collection.sql}) matched)`;
      if (condition.operator === "exists") {
        return { sql: found, bindings: collection.bindings, applicable: true };
      }
      if (condition.operator === "notExists") {
        return {
          sql: `NOT ${found}`,
          bindings: collection.bindings,
          applicable: true,
        };
      }
      throw new TypeError("Collection predicates need EXISTS or NOT EXISTS.");
    }
    if (target.kind === "reducer" && target.reducer === "count") {
      const collection = this.collection(target.input, frame);
      const count: SqlFragment = {
        sql: `(SELECT COUNT(*) FROM (${collection.sql}) counted)`,
        bindings: collection.bindings,
      };
      return {
        ...compareScalar(count, condition.operator, condition.value),
        applicable: true,
      };
    }
    throw new TypeError(
      `SQL predicate kind is not implemented: ${target.kind}`,
    );
  }

  expression(
    expression: FilterExpression | null,
    frame: SqlFrame,
  ): PredicateFragment {
    if (!expression) return { sql: "1", bindings: [], applicable: true };
    if (expression.kind === "condition") {
      return this.condition(expression, frame);
    }
    if (expression.kind === "not") {
      const child = onlyApplicable(this.expression(expression.child, frame));
      return child.applicable
        ? {
            sql: `NOT (${child.sql})`,
            bindings: child.bindings,
            applicable: true,
          }
        : child;
    }
    const children = expression.children.map((child) =>
      onlyApplicable(this.expression(child, frame)),
    );
    if (expression.kind === "and") {
      if (children.some((child) => !child.applicable)) {
        return { sql: "0", bindings: [], applicable: false };
      }
      return {
        sql: children.map((child) => `(${child.sql})`).join(" AND ") || "1",
        bindings: children.flatMap((child) => child.bindings),
        applicable: true,
      };
    }
    const applicable = children.filter((child) => child.applicable);
    return {
      sql: applicable.map((child) => `(${child.sql})`).join(" OR ") || "0",
      bindings: applicable.flatMap((child) => child.bindings),
      applicable: applicable.length > 0,
    };
  }
}

function factCtes(
  filterVisits: string,
  filterEvents: string,
): readonly BoundCteDefinition[] {
  return buildScopedFactsCtes(new Set(["session", "visitor"])).flatMap(
    (source) => {
      const sql = source
        .replace(/\bscope_raw_visits\b/g, filterVisits)
        .replace(/\bscope_raw_events\b/g, filterEvents);
      const parts = sql.trim().split(/\),\s*(?=scope_[a-z_]+ AS \()/g);
      return parts.map((part, index) => {
        const body = index < parts.length - 1 ? `${part})` : part;
        const name = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s+AS\s*\(/.exec(body)?.[1];
        if (!name) throw new TypeError("Malformed scoped fact CTE.");
        return boundCte(name, body);
      });
    },
  );
}

/**
 * Compile a validated Core selector/count expression to site-typed SQL sets.
 * Its sources are provided by the enclosing Scoped Dataset and must already
 * enforce source authorization. No advanced JS evaluation occurs here.
 *
 * P2 deliberately throws for future P3/P4 scalar/temporal targets rather
 * than generating incomplete or match-all SQL.
 */
export function compileCollectionSqlQualification(
  document: FilterDocument,
  scope: RootScope,
  sources: SqlQualificationSources = {},
): FilterQualificationSql {
  // SQL identifiers cannot come from the Filter DSL or user input.
  const candidateVisits = safeQualificationIdentifier(
    sources.candidateVisits ?? "scope_raw_visits",
  );
  const candidateEvents = safeQualificationIdentifier(
    sources.candidateEvents ?? "scope_raw_events",
  );
  const universeVisits = safeQualificationIdentifier(
    sources.universeVisits ?? candidateVisits,
  );
  const universeEvents = safeQualificationIdentifier(
    sources.universeEvents ?? candidateEvents,
  );
  const filterVisits = safeQualificationIdentifier(
    sources.filterVisits ?? universeVisits,
  );
  const filterEvents = safeQualificationIdentifier(
    sources.filterEvents ?? universeEvents,
  );
  const compiler = new SqlCollectionCompiler({ filterVisits, filterEvents });
  const ctes: BoundCteDefinition[] = [
    ...factCtes(filterVisits, filterEvents),
    boundCte(
      "scope_filter_sessions",
      `scope_filter_sessions AS (
      SELECT site_pk, session_id, MIN(visitor_id) AS visitor_id
      FROM (
        SELECT site_pk, session_id, visitor_id FROM ${universeVisits}
        UNION ALL
        SELECT site_pk, session_id, visitor_id FROM ${universeEvents}
      )
      WHERE TRIM(COALESCE(session_id, '')) != ''
      GROUP BY site_pk, session_id
    )`,
    ),
    boundCte(
      "scope_filter_visitors",
      `scope_filter_visitors AS (
      SELECT site_pk, visitor_id
      FROM ${universeVisits}
      WHERE TRIM(COALESCE(visitor_id, '')) != ''
      UNION
      SELECT site_pk, visitor_id
      FROM ${universeEvents}
      WHERE TRIM(COALESCE(visitor_id, '')) != ''
    )`,
    ),
  ];

  if (scope === "event") {
    const visit = compiler.expression(document.root, {
      anchorAlias: "v",
      anchorKind: "page",
      currentAlias: "v",
      currentKind: "page",
    });
    const event = compiler.expression(document.root, {
      anchorAlias: "e",
      anchorKind: "event",
      currentAlias: "e",
      currentKind: "event",
    });
    ctes.push(
      boundCte(
        "scope_filter_matched_visits",
        `scope_filter_matched_visits AS (
        SELECT v.site_pk, v.visit_id FROM ${candidateVisits} v WHERE ${visit.sql}
      )`,
        visit.bindings,
      ),
      boundCte(
        "scope_filter_matched_events",
        `scope_filter_matched_events AS (
        SELECT e.site_pk, e.event_id FROM ${candidateEvents} e WHERE ${event.sql}
      )`,
        event.bindings,
      ),
    );
    return {
      kind: "observation",
      ctes,
      matchedVisitRelation: "scope_filter_matched_visits",
      matchedEventRelation: "scope_filter_matched_events",
    };
  }
  const relation =
    scope === "session" ? "scope_filter_sessions" : "scope_filter_visitors";
  const identifier = scope === "session" ? "session_id" : "visitor_id";
  const predicate = compiler.expression(document.root, {
    anchorAlias: "candidate",
    anchorKind: scope,
    currentAlias: "candidate",
    currentKind: scope,
  });
  ctes.push(
    boundCte(
      "scope_filter_qualified_entities",
      `scope_filter_qualified_entities AS (
    SELECT candidate.site_pk, candidate.${identifier} AS entity_id
    FROM ${relation} candidate WHERE ${predicate.sql}
  )`,
      predicate.bindings,
    ),
  );
  return {
    kind: "entity",
    entityKind: scope,
    ctes,
    qualifiedEntityRelation: "scope_filter_qualified_entities",
  };
}
