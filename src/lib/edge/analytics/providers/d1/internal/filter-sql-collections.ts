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

import {
  compileFilterDocument,
  compileRegisteredFieldScalar,
} from "./filter-compiler";
import { compileExactJsonPointerPredicate } from "./filter-json-pointer";
import { compileJsonPointerValue } from "./filter-json-pointer-value";
import {
  boundCte,
  type BoundCteDefinition,
  type FilterQualificationSql,
  safeQualificationIdentifier,
} from "./filter-qualification";
import { sqlCalendarPeriods } from "./filter-sql-calendar";
import {
  boundTimeAnchorMs,
  compileSqlScalar,
  durationMilliseconds,
  type SqlScalarTimeContext,
} from "./filter-sql-scalars";
import {
  compileAdjacentMatches,
  compileSequenceMatches,
  compileWithoutMatches,
  timelineCte,
} from "./filter-sql-sequences";
import { JSON_EACH_SET_THRESHOLD } from "./filter-sql-set";
import { buildScopedFactsCtes } from "./scoped-facts";

type EntityKind =
  "event" | "page" | "session" | "visitor" | "period" | "sequence";
type RootEntityKind = Exclude<EntityKind, "period" | "sequence">;
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
  /** Complete authorized read range R, used by Window and full timeline. */
  readonly readVisits?: string;
  readonly readEvents?: string;
  /** Optional complete local timeline, including position-only evidence. */
  readonly timelineVisits?: string;
  readonly timelineEvents?: string;
  /** Canonical target-local sources have unique occurrence IDs. */
  readonly uniqueLocalOccurrences?: boolean;
  /** Canonical global sources have unique occurrences within the read range. */
  readonly uniqueGlobalOccurrences?: boolean;
  /** Canonical physical visits in the authorized R domain. */
  readonly indexedGlobalTimelineVisits?: boolean;
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
  readonly anchorKind: RootEntityKind;
  /** The item whose fields/payload are read by the current predicate. */
  readonly currentAlias: string;
  readonly currentKind: EntityKind;
  readonly periodAlias?: string;
  readonly periodItems?: SqlCollectionRef;
  readonly sequenceAlias?: string;
}

interface SqlCollectionRef extends SqlFragment {
  readonly entityKind: EntityKind;
  readonly periodItems?: SqlCollectionRef;
  readonly sequenceAlias?: string;
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

/** Compare a projected Event JSON value by its original tagged type.
 * A Boolean true and Number 1 both have SQLite numeric value 1, so
 * unwrapping JSON before EQ/NEQ/IN/NOT IN loses public Payload semantics.
 */
function compareTypedJsonScalar(
  left: SqlFragment & { readonly typedSql?: string },
  operator: FilterOperator,
  value: unknown,
): SqlFragment | null {
  if (!left.typedSql || !["eq", "neq", "in", "notIn"].includes(operator))
    return null;

  const kindOf = (input: FilterValue): number =>
    input === null
      ? 0
      : typeof input === "string"
        ? 1
        : typeof input === "number"
          ? 2
          : 3;
  const valueType = "json_extract(typed_value, '$.t')";
  const actual = "json_extract(typed_value, '$.v')";
  const values: Array<string | number> = [];
  let predicate: string;

  if (operator === "eq" || operator === "neq") {
    if (!scalar(value) || value === null)
      throw new TypeError("JSON scalar comparison needs a non-null scalar.");
    const expectedType = kindOf(value);
    values.push(typedBinding(value) as string | number);
    predicate =
      operator === "eq"
        ? "(" + valueType + " = " + expectedType + " AND " + actual + " = ?)"
        : "(" +
          valueType +
          " IN (1, 2, 3) AND (" +
          valueType +
          " != " +
          expectedType +
          " OR " +
          actual +
          " != ?))";
  } else {
    if (!Array.isArray(value) || !value.length || !value.every(scalar))
      throw new TypeError("JSON membership needs a nonempty scalar set.");
    const groups = new Map<number, FilterValue[]>();
    for (const item of value as FilterValue[]) {
      const kind = kindOf(item);
      const group = groups.get(kind) ?? [];
      group.push(item);
      groups.set(kind, group);
    }
    const comparisons: string[] = [];
    for (const [kind, group] of groups) {
      if (kind === 0) {
        comparisons.push(valueType + " = 0");
      } else {
        let set: string;
        if (group.length >= JSON_EACH_SET_THRESHOLD) {
          values.push(JSON.stringify(group.map((item) => typedBinding(item))));
          set = "SELECT value FROM json_each(?)";
        } else {
          values.push(
            ...group.map((item) => typedBinding(item) as string | number),
          );
          set = group.map(() => "?").join(", ");
        }
        comparisons.push(
          "(" +
            valueType +
            " = " +
            kind +
            " AND " +
            actual +
            " IN (" +
            set +
            "))",
        );
      }
    }
    const membership = "(" + comparisons.join(" OR ") + ")";
    predicate =
      operator === "in"
        ? membership
        : "(" + valueType + " IN (0, 1, 2, 3) AND NOT " + membership + ")";
  }
  return {
    sql:
      "(SELECT COALESCE(" +
      predicate +
      ", 0) FROM (SELECT " +
      left.typedSql +
      " AS typed_value))",
    // SELECT predicate placeholders precede nested FROM pointer placeholders.
    bindings: [...values, ...left.bindings],
  };
}

function compareScalar(
  left: SqlFragment & { readonly typedSql?: string },
  operator: FilterOperator,
  value: unknown,
  clock?: SqlScalarTimeContext,
): SqlFragment {
  const typed = compareTypedJsonScalar(left, operator, value);
  if (typed) return typed;
  const parameter = (input: unknown): string | number | null => {
    if (scalar(input)) return typedBinding(input);
    if (input && typeof input === "object" && "kind" in input) {
      if (input.kind === "time-anchor")
        return boundTimeAnchorMs(input as never, clock);
      if (input.kind === "duration")
        return durationMilliseconds(input as never);
    }
    throw new TypeError("Expected a scalar, Duration or Time Anchor.");
  };
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
      if (!Array.isArray(value) || value.length !== 2) {
        throw new TypeError("SQL BETWEEN requires two endpoints.");
      }
      return {
        sql: `${left.sql} BETWEEN ? AND ?`,
        bindings: [...left.bindings, parameter(value[0]), parameter(value[1])],
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
      if (operator === "contains") {
        return {
          sql: `INSTR(${left.sql}, ?) > 0`,
          bindings: [...left.bindings, value],
        };
      }
      if (operator === "startsWith") {
        return {
          sql: `SUBSTR(${left.sql}, 1, LENGTH(?)) = ?`,
          bindings: [...left.bindings, value, value],
        };
      }
      return {
        sql: `(LENGTH(?) = 0 OR SUBSTR(${left.sql}, -LENGTH(?)) = ?)`,
        bindings: [value, ...left.bindings, value, value],
      };
    }
    default: {
      const right = parameter(value);
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
        bindings: [...left.bindings, right],
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
  readonly globalSequenceCtes: BoundCteDefinition[] = [];

  constructor(
    private readonly sources: SqlQualificationSources,
    private readonly clock?: SqlScalarTimeContext,
  ) {}

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

  private source(kind: EntityKind, readMode = false): string {
    switch (kind) {
      case "page":
        return readMode
          ? (this.sources.readVisits ??
              this.sources.filterVisits ??
              "scope_raw_visits")
          : (this.sources.filterVisits ?? "scope_raw_visits");
      case "event":
        return readMode
          ? (this.sources.readEvents ??
              this.sources.filterEvents ??
              "scope_raw_events")
          : (this.sources.filterEvents ?? "scope_raw_events");
      case "session":
        return "scope_filter_sessions";
      case "visitor":
        return "scope_filter_visitors";
      case "period":
      case "sequence":
        throw new TypeError(
          "Derived Period/Sequence is not a source relation.",
        );
    }
  }

  private collection(
    target: FilterTargetExpression,
    frame: SqlFrame,
    readMode = false,
  ): SqlCollectionRef {
    if (target.kind === "entity-root") {
      const name = this.alias();
      const source = this.source(target.entity, readMode);
      return {
        sql: `SELECT ${name}.* FROM ${source} ${name}
          WHERE ${this.relationship(frame, name, target.entity)}`,
        bindings: [],
        entityKind: target.entity,
      };
    }
    if (target.kind === "sequence") {
      const steps = target.steps.map((step) =>
        this.collection(
          step,
          frame,
          readMode || !this.clock?.filterRangeExplicit,
        ),
      );
      const anchor = frame.anchorKind;
      if (
        steps.some(
          (step) => step.entityKind !== "page" && step.entityKind !== "event",
        )
      ) {
        throw new TypeError("Sequence requires Page/Event step collections.");
      }
      return compileSequenceMatches(steps as never, anchor);
    }
    if (target.kind === "adjacent") {
      const seq = this.collection(target.sequence, frame, readMode);
      if (seq.entityKind !== "sequence") {
        throw new TypeError("Adjacent must wrap a Sequence.");
      }
      return compileAdjacentMatches(seq as never);
    }
    if (target.kind === "without") {
      const seq = this.collection(target.sequence, frame, readMode);
      if (seq.entityKind !== "sequence") {
        throw new TypeError("Without must wrap a Sequence.");
      }
      const excluded = this.collection(target.excluded, frame, true);
      if (excluded.entityKind !== "page" && excluded.entityKind !== "event") {
        throw new TypeError("Without excluded set must contain occurrences.");
      }
      return compileWithoutMatches(
        seq as never,
        excluded as never,
        frame.anchorKind,
      );
    }
    if (target.kind === "context-intrinsic" && target.intrinsic === "items") {
      if (!frame.periodAlias || !frame.periodItems) {
        throw new TypeError(
          "Period items require a currently bound Period Selector.",
        );
      }
      const source = frame.periodItems;
      const alias = this.alias();
      const time =
        source.entityKind === "page"
          ? `${alias}.started_at`
          : source.entityKind === "event"
            ? `${alias}.occurred_at`
            : null;
      if (!time)
        throw new TypeError("Period items require Page/Event occurrences.");
      return {
        sql: `SELECT ${alias}.* FROM (${source.sql}) ${alias}
          WHERE ${time} >= ${frame.periodAlias}.period_start
            AND ${time} < ${frame.periodAlias}.period_end`,
        bindings: source.bindings,
        entityKind: source.entityKind,
      };
    }
    if (target.kind === "periods") {
      if (!this.clock) {
        throw new TypeError(
          "Natural Periods require the query's IANA time context.",
        );
      }
      const source = this.collection(target.collection, frame, readMode);
      const kind = source.entityKind;
      if (kind !== "page" && kind !== "event") {
        throw new TypeError("Periods require Page/Event occurrences.");
      }
      const item = this.alias();
      const period = this.alias();
      const time =
        kind === "page" ? `${item}.started_at` : `${item}.occurred_at`;
      const clock = this.clock;
      const start = readMode
        ? (clock.readStartMs ?? clock.rangeStartMs)
        : (clock.filterStartMs ?? clock.rangeStartMs);
      const end = readMode
        ? (clock.readEndExclusiveMs ?? clock.rangeEndExclusiveMs)
        : (clock.filterEndExclusiveMs ?? clock.rangeEndExclusiveMs);
      // Natural IANA boundaries cannot be enumerated for unknown unbounded
      // retained history. Raise a visible error rather than querying only Q.
      if (
        !Number.isSafeInteger(start) ||
        start < -8_640_000_000_000_000 ||
        !Number.isSafeInteger(end) ||
        end > 8_640_000_000_000_000
      ) {
        throw new RangeError("filter_calendar_history_requires_retained_start");
      }
      const calendar = sqlCalendarPeriods(target.interval, {
        ...clock,
        rangeStartMs: start,
        rangeEndExclusiveMs: end,
      });
      const periodStart = `json_extract(${period}.value, '$.start')`;
      const periodEnd = `json_extract(${period}.value, '$.end')`;
      return {
        entityKind: "period",
        periodItems: source,
        sql: `SELECT ${periodStart} AS period_start, ${periodEnd} AS period_end
          FROM json_each(?) ${period}
          WHERE EXISTS (
            SELECT 1 FROM (${source.sql}) ${item}
            WHERE ${time} >= ${periodStart}
              AND ${time} < ${periodEnd}
          )`,
        bindings: [JSON.stringify(calendar), ...source.bindings],
      };
    }
    if (target.kind === "window") {
      const source = this.collection(target.collection, frame, true);
      if (source.entityKind !== "page" && source.entityKind !== "event") {
        throw new TypeError("Window requires Page or Event occurrences.");
      }
      const alias = this.alias();
      const time =
        source.entityKind === "page"
          ? `${alias}.started_at`
          : `${alias}.occurred_at`;
      const anchor = compileSqlScalar(
        target.anchor,
        (collection, useReadRange) =>
          this.collection(collection, frame, useReadRange),
        this.clock,
      );
      if (anchor.type !== "date" && anchor.type !== "number") {
        throw new TypeError("Window anchor must have a temporal value.");
      }
      const startOffset = durationMilliseconds(target.startOffset);
      const endOffset = durationMilliseconds(target.endOffset);
      if (startOffset >= endOffset)
        throw new TypeError("Invalid half-open Window offsets.");
      return {
        entityKind: source.entityKind,
        sql: `SELECT ${alias}.* FROM (${source.sql}) ${alias}
          WHERE ${time} >= (${anchor.sql}) + ?
            AND ${time} < (${anchor.sql}) + ?`,
        bindings: [
          ...source.bindings,
          ...anchor.bindings,
          startOffset,
          ...anchor.bindings,
          endOffset,
        ],
      };
    }
    if (target.kind === "selector") {
      const parent = this.collection(target.collection, frame, readMode);
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
        periodAlias: parent.entityKind === "period" ? alias : frame.periodAlias,
        periodItems:
          parent.entityKind === "period"
            ? parent.periodItems
            : frame.periodItems,
        sequenceAlias:
          parent.entityKind === "sequence" ? alias : frame.sequenceAlias,
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

  private sequenceSame(
    input: FilterTargetExpression,
    frame: SqlFrame,
  ): SqlFragment {
    if (!frame.sequenceAlias) {
      throw new TypeError("$same requires a bound Sequence item.");
    }
    const step = "same_step";
    const event = "same_event";
    const visit = "same_visit";
    let encoded: string;
    let bindings: readonly (string | number | null)[] = [];
    if (input.kind === "current-payload") {
      const payload = compileJsonPointerValue(event, input.path);
      encoded = `CASE WHEN json_extract(${step}.value, '$.kind') = 'event'
        THEN ${payload.sql} ELSE NULL END`;
      bindings = payload.bindings;
    } else if (input.kind === "member") {
      const members: string[] = [];
      let root: FilterTargetExpression = input;
      while (root.kind === "member") {
        members.unshift(root.member);
        root = root.object;
      }
      if (root.kind !== "context-root" || root.context !== "current") {
        throw new TypeError("$same must read the current Sequence occurrence.");
      }
      const member = members.join(".");
      const eventMember = resolveEntityMember(
        "event",
        member,
        analyticsFilterRegistry,
      );
      const pageMember = resolveEntityMember(
        "page",
        member,
        analyticsFilterRegistry,
      );
      if (!eventMember && !pageMember) {
        throw new TypeError("Unknown Sequence member for $same.");
      }
      const scalar = (fieldId: string, alias: string): string => {
        const sql = compileRegisteredFieldScalar(fieldId, alias);
        const definition = analyticsFilterDefinition(fieldId)!;
        const type =
          definition.valueKind === "boolean"
            ? 3
            : definition.valueKind === "number"
              ? 2
              : 1;
        return `CASE WHEN ${sql} IS NOT NULL
          THEN json_object('t', ${type}, 'v', ${sql})
          ELSE NULL END`;
      };
      encoded = `CASE
        WHEN json_extract(${step}.value, '$.kind') = 'event' THEN
          ${eventMember || pageMember ? scalar((eventMember ?? pageMember)!.fieldId, event) : "NULL"}
        WHEN json_extract(${step}.value, '$.kind') = 'page' THEN
          ${pageMember ? scalar(pageMember.fieldId, visit) : "NULL"}
        ELSE NULL END`;
    } else {
      throw new TypeError("Unsupported $same scalar target.");
    }
    const tokens = `SELECT ${encoded} AS typed_value
      FROM json_each(${frame.sequenceAlias}.sequence_steps) ${step}
      LEFT JOIN ${this.source("event", true)} ${event}
        ON ${event}.site_pk = json_extract(${step}.value, '$.site_pk')
       AND ${event}.event_pk = json_extract(${step}.value, '$.event_pk')
       AND json_extract(${step}.value, '$.kind') = 'event'
      LEFT JOIN ${this.source("page", true)} ${visit}
        ON ${visit}.site_pk = json_extract(${step}.value, '$.site_pk')
       AND ${visit}.visit_id = json_extract(${step}.value, '$.visit_id')
       AND json_extract(${step}.value, '$.kind') = 'page'`;
    return {
      sql: `(SELECT CASE WHEN
        COUNT(typed_value) = json_array_length(${frame.sequenceAlias}.sequence_steps)
        AND COUNT(DISTINCT typed_value) = 1
        AND SUM(CASE WHEN json_extract(typed_value, '$.t') IN (1, 2, 3)
          THEN 1 ELSE 0 END) = json_array_length(${frame.sequenceAlias}.sequence_steps)
        THEN 1 ELSE 0 END
        FROM (${tokens}) same_values)`,
      bindings,
    };
  }

  /**
   * Identical steps need only a sufficient number of occurrences sharing
   * one typed value; distinct pairs need only their ordering extrema. Keep the
   * ordinary enumerator for counts, mixed predicates and unproven sources.
   */
  private localSameSequenceExists(
    condition: FilterCondition,
    frame: SqlFrame,
  ): PredicateFragment | null {
    const target = condition.target;
    if (
      !this.sources.uniqueLocalOccurrences ||
      (frame.anchorKind !== "session" && frame.anchorKind !== "visitor") ||
      (condition.operator !== "exists" && condition.operator !== "notExists") ||
      target.kind !== "selector" ||
      target.collection.kind !== "sequence" ||
      target.collection.steps.length < 2 ||
      target.predicate.kind !== "condition"
    )
      return null;
    const predicate = target.predicate;
    const same = predicate.target;
    if (
      same.kind !== "context-intrinsic" ||
      same.context !== "sequence" ||
      same.intrinsic !== "same" ||
      predicate.operator !== "eq" ||
      predicate.value !== true
    )
      return null;
    const sequenceSteps = target.collection.steps;
    const count = sequenceSteps.length;
    const identical = sequenceSteps.every(
      (step) => JSON.stringify(step) === JSON.stringify(sequenceSteps[0]),
    );
    if (!identical && count !== 2) return null;
    const steps = (
      identical ? target.collection.steps.slice(0, 1) : target.collection.steps
    ).map((step) =>
      this.collection(step, frame, !this.clock?.filterRangeExplicit),
    );
    const input = same.input;
    const payload = input.kind === "current-payload";
    const member =
      input.kind === "member" &&
      input.object.kind === "context-root" &&
      input.object.context === "current" &&
      (input.member === "name" || input.member === "path");
    if (!payload && !member) return null;
    if (
      steps.some(
        (step) =>
          step.entityKind !== "event" &&
          !(identical && member && step.entityKind === "page"),
      )
    )
      return null;
    const token = (step: SqlCollectionRef, item: string): SqlFragment => {
      if (input.kind === "current-payload")
        return compileJsonPointerValue(item, input.path);
      const field =
        this.currentMember(input, step.entityKind) ??
        (step.entityKind === "event"
          ? this.currentMember(input, "page")
          : null);
      if (!field) return { sql: "NULL", bindings: [] };
      const scalar = compileRegisteredFieldScalar(field, item);
      return {
        sql: `CASE WHEN ${scalar} IS NOT NULL
          THEN json_object('t', 1, 'v', ${scalar}) ELSE NULL END`,
        bindings: [],
      };
    };
    if (identical && member) {
      const step = steps[0]!;
      const item = this.alias();
      const field = this.currentMember(input, step.entityKind);
      if (!field) return null;
      const scalar = compileRegisteredFieldScalar(field, item);
      // Both supported fields are strings. Group directly with binary
      // collation rather than re-encoding the same scalar as typed JSON.
      const found = `EXISTS (SELECT 1 FROM (${step.sql}) ${item}
        WHERE ${scalar} IS NOT NULL
        GROUP BY ${scalar} COLLATE BINARY HAVING COUNT(*) >= ${count})`;
      return {
        sql: condition.operator === "notExists" ? `NOT ${found}` : found,
        bindings: step.bindings,
        applicable: true,
      };
    }
    if (identical) {
      // Identical steps admit any selection of distinct matching
      // occurrences in strict timeline order. Each occurs once.
      const step = steps[0]!;
      const item = this.alias();
      const candidates = this.alias();
      const payload = token(step, item);
      const found = `EXISTS (WITH ${candidates} AS MATERIALIZED (
        SELECT ${item}.site_pk,
          ${item}.${frame.anchorKind === "visitor" ? "visitor_id" : "session_id"} AS anchor_id,
          ${payload.sql} AS typed_value FROM (${step.sql}) ${item}
      )
      SELECT 1 FROM ${candidates}
      WHERE json_extract(typed_value, '$.t') IN (1, 2, 3)
      GROUP BY site_pk, anchor_id, typed_value HAVING COUNT(*) >= ${count})`;
      return {
        sql: condition.operator === "notExists" ? `NOT ${found}` : found,
        bindings: [...payload.bindings, ...step.bindings],
        applicable: true,
      };
    }
    const bindings: Array<string | number | null> = [];
    const branches = steps.map((step, index) => {
      const item = this.alias();
      const payload = token(step, item);
      bindings.push(...payload.bindings, ...step.bindings);
      return `SELECT ${index} AS step_index, ${item}.site_pk,
        ${item}.${frame.anchorKind === "visitor" ? "visitor_id" : "session_id"} AS anchor_id,
        ${item}.occurred_at, ${item}.event_id,
        ${payload.sql} AS typed_value
        FROM (${step.sql}) ${item}`;
    });
    const candidates = this.alias();
    const byTime = this.alias();
    // Both steps are Events. Their strict relative order is exactly the
    // original timeline's (occurred_at, event_id COLLATE BINARY) order.
    // Compare IDs only within an equal timestamp; never reuse one event.
    const found = `EXISTS (WITH ${candidates} AS MATERIALIZED (
        ${branches.join(" UNION ALL ")}
      ), ${byTime} AS (
        SELECT site_pk, anchor_id, typed_value, occurred_at,
          MIN(CASE WHEN step_index = 0 THEN event_id END COLLATE BINARY) AS first_id,
          MAX(CASE WHEN step_index = 1 THEN event_id END COLLATE BINARY) AS last_id
        FROM ${candidates}
        WHERE json_extract(typed_value, '$.t') IN (1, 2, 3)
        GROUP BY site_pk, anchor_id, typed_value, occurred_at
      )
      SELECT 1 FROM ${byTime}
      GROUP BY site_pk, anchor_id, typed_value
      HAVING MIN(CASE WHEN first_id IS NOT NULL THEN occurred_at END) <
        MAX(CASE WHEN last_id IS NOT NULL THEN occurred_at END)
        OR MAX(first_id COLLATE BINARY < last_id COLLATE BINARY) = 1)`;
    return {
      sql: condition.operator === "notExists" ? `NOT ${found}` : found,
      bindings,
      applicable: true,
    };
  }
  /**
   * Global root qualification over canonical occurrences. Identical
   * unconstrained steps reduce to cardinality; distinct Event pairs use
   * strict predecessors, and repeated Event bounds use feasible extrema.
   * The original universe still determines which entities may qualify.
   */
  private globalSequenceExists(
    condition: FilterCondition,
    frame: SqlFrame,
  ): PredicateFragment | null {
    const target = condition.target;
    if (
      !this.sources.uniqueGlobalOccurrences ||
      this.sources.uniqueLocalOccurrences ||
      frame.anchorAlias !== "candidate" ||
      frame.currentAlias !== frame.anchorAlias ||
      frame.currentKind !== frame.anchorKind ||
      (frame.anchorKind !== "session" && frame.anchorKind !== "visitor") ||
      (condition.operator !== "exists" && condition.operator !== "notExists")
    )
      return null;
    const adjacent =
      target.kind === "adjacent" && target.sequence.kind === "sequence";
    const without =
      target.kind === "without" && target.sequence.kind === "sequence";
    const sequence =
      adjacent || without
        ? target.sequence
        : target.kind === "sequence"
          ? target
          : target.kind === "selector" && target.collection.kind === "sequence"
            ? target.collection
            : null;
    if (!sequence || sequence.steps.length < 2) return null;
    const steps = sequence.steps;
    const count = steps.length;
    const identical = steps.every(
      (step) => JSON.stringify(step) === JSON.stringify(steps[0]),
    );
    const bound = target.kind === "selector" ? target.predicate : null;
    // Narrow report universes can seek only their own historical Event
    // witnesses instead of grouping every entity in the retained history.
    // The time ratio, step count and probe cap are cost guards, not
    // restrictions on the authorized historical range.
    const start = this.clock?.readStartMs;
    const end = this.clock?.readEndExclusiveMs;
    const qStart = this.clock?.rangeStartMs;
    const qEnd = this.clock?.rangeEndExclusiveMs;
    const firstStep = steps[0]!;
    const historyRoot =
      firstStep.kind === "selector" ? firstStep.collection : firstStep;
    const getNameSelector = (step: FilterTargetExpression) =>
      step.kind === "selector" &&
      step.collection.kind === "entity-root" &&
      step.collection.entity === "event" &&
      step.predicate.kind === "condition" &&
      this.currentMember(step.predicate.target, "event") === "event.name" &&
      ["eq", "exists"].includes(step.predicate.operator)
        ? step.predicate
        : null;
    const nameSelector = getNameSelector(firstStep);
    if (
      this.sources.indexedGlobalTimelineVisits &&
      target.kind === "sequence" &&
      identical &&
      count <= 5 &&
      historyRoot.kind === "entity-root" &&
      historyRoot.entity === "event" &&
      (firstStep.kind === "entity-root" || nameSelector !== null) &&
      !this.clock?.filterRangeExplicit &&
      start !== undefined &&
      end !== undefined &&
      qStart !== undefined &&
      qEnd !== undefined &&
      qEnd > qStart &&
      qEnd - qStart <= 3600000 &&
      end - start >= 24 * (qEnd - qStart)
    ) {
      const identity =
        frame.anchorKind === "session" ? "session_id" : "visitor_id";
      const name = `scope_global_sequence_${this.globalSequenceCtes.length}`;
      const universe =
        frame.anchorKind === "session"
          ? "scope_filter_sessions"
          : "scope_filter_visitors";
      const anchor = frame.anchorAlias;
      const namePredicate = (alias: string) =>
        nameSelector
          ? onlyApplicable(
              this.expression(nameSelector, {
                ...frame,
                currentAlias: alias,
                currentKind: "event",
              }),
            )
          : { sql: "1", bindings: [], applicable: true };
      const seekPredicate = namePredicate("history_name");
      const found = `EXISTS (
        SELECT 1 FROM visits history_visit
        CROSS JOIN custom_events history_event
        INNER JOIN ${nameSelector ? "(SELECT id,name AS event_name FROM custom_event_names)" : "custom_event_names"} history_name ON history_name.id=history_event.event_name_id
        WHERE history_visit.site_pk=${anchor}.site_pk AND history_visit.${identity}=${anchor}.${identity}
          AND history_event.site_pk=history_visit.site_pk AND history_event.visit_id=history_visit.visit_id
          AND history_event.occurred_at>=? AND history_event.occurred_at<?
          ${nameSelector ? `AND (${seekPredicate.sql})` : ""}
        LIMIT 1 OFFSET ${count - 1})`;
      const item = this.alias();
      const setPredicate = namePredicate(item);
      // Bound the number of independent history probes. CASE is lazy in
      // SQLite: a dense report universe retains the set-based scan, and a
      // small universe never evaluates that historical aggregate.
      this.globalSequenceCtes.push(
        boundCte(
          name,
          `${name} AS (
          SELECT ${item}.site_pk, ${item}.${identity} AS entity_id
          FROM ${this.source("event", true)} ${item}
          WHERE ${item}.site_pk IS NOT NULL AND TRIM(COALESCE(${item}.${identity},''))!=''
            ${nameSelector ? `AND (${setPredicate.sql})` : ""}
          GROUP BY ${item}.site_pk,${item}.${identity}
          HAVING COUNT(*) >= ${count})`,
          setPredicate.bindings,
        ),
      );
      const membership = `CASE WHEN EXISTS (SELECT 1 FROM ${universe} LIMIT 1 OFFSET 64)
        THEN COALESCE((${anchor}.site_pk,${anchor}.${identity}) IN (SELECT site_pk,entity_id FROM ${name}),0)
        ELSE ${found} END`;
      return {
        sql:
          condition.operator === "notExists"
            ? `NOT (${membership})`
            : membership,
        bindings: [start, end, ...seekPredicate.bindings],
        applicable: true,
      };
    }

    if (
      adjacent &&
      (count > 5 ||
        (this.clock?.filterRangeExplicit &&
          (this.source("page") !== this.source("page", true) ||
            this.source("event") !== this.source("event", true))) ||
        (this.sources.timelineVisits &&
          this.sources.timelineVisits !== this.source("page", true)) ||
        (this.sources.timelineEvents &&
          this.sources.timelineEvents !== this.source("event", true)))
    )
      return null;
    if (
      without &&
      (count > 5 ||
        (this.clock?.filterRangeExplicit &&
          (this.source("page") !== this.source("page", true) ||
            this.source("event") !== this.source("event", true))) ||
        (this.sources.timelineVisits &&
          this.sources.timelineVisits !== this.source("page", true)) ||
        (this.sources.timelineEvents &&
          this.sources.timelineEvents !== this.source("event", true)))
    )
      return null;
    const multiStage = !adjacent && !without && !identical && count > 2;
    if (multiStage && (bound || count > 5)) return null;
    const same =
      bound?.kind === "condition" &&
      bound.target.kind === "context-intrinsic" &&
      bound.target.context === "sequence" &&
      bound.target.intrinsic === "same" &&
      bound.operator === "eq" &&
      bound.value === true
        ? bound.target.input
        : null;
    if (
      same &&
      !(
        same.kind === "current-payload" ||
        (same.kind === "member" &&
          same.object.kind === "context-root" &&
          same.object.context === "current" &&
          same.member === "name")
      )
    )
      return null;
    if (
      bound &&
      !same &&
      (bound.kind !== "condition" ||
        bound.target.kind !== "context-intrinsic" ||
        bound.target.context !== "sequence" ||
        (bound.target.intrinsic !== "span" &&
          !(
            bound.target.intrinsic === "gap" &&
            bound.target.from >= 1 &&
            bound.target.from < bound.target.to &&
            bound.target.to <= count
          )) ||
        !["lt", "lte", "gt", "gte"].includes(bound.operator))
    )
      return null;
    const upper =
      bound?.kind === "condition" &&
      (bound.operator === "lt" || bound.operator === "lte");
    const identity =
      frame.anchorKind === "session" ? "session_id" : "visitor_id";
    const compileStep = (
      step: FilterTargetExpression,
      sharedAlias?: string,
    ) => {
      const root = step.kind === "selector" ? step.collection : step;
      if (
        root.kind !== "entity-root" ||
        (root.entity !== "page" && root.entity !== "event")
      )
        return null;
      const kind = root.entity;
      if (
        kind === "page" &&
        !adjacent &&
        !without &&
        (!identical ||
          bound ||
          step.kind !== "selector" ||
          step.predicate.kind !== "condition" ||
          step.predicate.operator !== "eq" ||
          step.predicate.target.kind !== "member" ||
          step.predicate.target.member !== "path" ||
          step.predicate.target.object.kind !== "context-root" ||
          step.predicate.target.object.context !== "current")
      )
        return null;
      const localPredicate = (expression: FilterExpression): boolean => {
        if (expression.kind === "not") return localPredicate(expression.child);
        if (expression.kind !== "condition")
          return expression.children.every(localPredicate);
        const value = expression.target;
        if (value.kind === "current-payload") return kind === "event";
        return (
          value.kind === "member" &&
          value.object.kind === "context-root" &&
          value.object.context === "current" &&
          (value.member === "time" ||
            (kind === "page" && value.member === "path") ||
            (kind === "event" && value.member === "name"))
        );
      };
      if (step.kind === "selector" && !localPredicate(step.predicate))
        return null;
      const item = sharedAlias ?? this.alias();
      const predicate =
        step.kind === "selector"
          ? onlyApplicable(
              this.expression(step.predicate, {
                ...frame,
                currentAlias: item,
                currentKind: kind,
              }),
            )
          : { sql: "1", bindings: [], applicable: true };
      const relation = this.source(kind, !this.clock?.filterRangeExplicit);
      return {
        item,
        kind,
        bindings: predicate.bindings,
        predicate: predicate.sql,
        relation,
        from: `FROM ${relation} ${item}
          WHERE ${item}.site_pk IS NOT NULL
            AND TRIM(COALESCE(${item}.${identity}, '')) != ''
            AND (${predicate.sql})`,
        key: `${item}.site_pk, ${item}.${identity} AS entity_id`,
      };
    };
    const first = compileStep(steps[0]!);
    if (!first) return null;
    let sql: string;
    let withoutSqlForSource: ((source: string) => string) | undefined;
    let adjacentLocal: SqlFragment | undefined;
    const bindings = [...first.bindings];
    const compared =
      bound?.kind === "condition" && !same
        ? compareScalar(
            { sql: "span_delta", bindings: [] },
            bound.operator,
            bound.value,
            this.clock,
          )
        : null;
    if (without && count > 2) {
      const matched = [
        first,
        ...steps.slice(1).map((step) => compileStep(step, first.item)),
      ];
      const excluded = compileStep(target.excluded, first.item);
      if (
        matched.some((step) => step?.kind !== "event") ||
        excluded?.kind !== "event"
      )
        return null;
      const stages = matched as (typeof first)[];
      const item = first.item;
      bindings.length = 0;
      const flags = [...stages, excluded].map((step, index) => {
        bindings.push(...step.bindings);
        return `CASE WHEN (${step.predicate}) THEN 1 ELSE 0 END AS ${index === count ? "excluded" : "match_" + index}`;
      });
      const partition = "PARTITION BY site_pk, entity_id";
      const previous = `${partition} ORDER BY position ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING`;
      // A start may itself be excluded, but every interior witness must
      // be non-excluded. An end may be excluded too. A reachable prefix
      // remains usable until the next strictly intervening exclusion.
      const ranked = (source: string) => `ranked AS (
        SELECT *, ROW_NUMBER() OVER (${partition} ORDER BY activity_time, activity_id COLLATE BINARY) AS position
        FROM (SELECT ${first.key}, ${item}.occurred_at AS activity_time,
          ${item}.event_id AS activity_id, ${flags.join(", ")}
          FROM ${source} ${item}
          WHERE ${item}.site_pk IS NOT NULL AND TRIM(COALESCE(${item}.${identity}, '')) != '')
        WHERE excluded = 1 OR ${stages.map((_, i) => `match_${i} = 1`).join(" OR ")}
      )`;
      const ctes = [
        `prefix_0 AS (
        SELECT *, MAX(CASE WHEN excluded = 1 THEN position END) OVER (${previous}) AS last_excluded,
          match_0 AS reachable
        FROM ranked
      )`,
      ];
      let prefix = "prefix_0";
      for (let index = 1; index < count; index++) {
        const next = `prefix_${index}`;
        // The latest reachable predecessor suffices: if it lies before
        // the last exclusion, all earlier predecessors are invalid too.
        const remaining = stages
          .slice(index + 1)
          .map((_, i) => `match_${index + i + 1}`);
        ctes.push(`${next} AS (
          SELECT site_pk, entity_id, position, excluded, last_excluded,
            ${remaining.length ? remaining.join(", ") + "," : ""}
            CASE WHEN match_${index} = 1 ${index < count - 1 ? "AND excluded = 0" : ""}
              AND last_reachable >= COALESCE(last_excluded, 0)
              THEN 1 ELSE 0 END AS reachable
          FROM (SELECT *, MAX(CASE WHEN reachable = 1 THEN position END) OVER (${previous}) AS last_reachable FROM ${prefix})
        )`);
        prefix = next;
      }
      withoutSqlForSource = (source) =>
        `WITH ${[ranked(source), ...ctes].join(", ")} SELECT DISTINCT site_pk, entity_id FROM ${prefix} WHERE reachable = 1`;
      sql = withoutSqlForSource(this.source("event", true));
    } else if (without) {
      const last = compileStep(steps[1]!, first.item);
      const excluded = compileStep(target.excluded, first.item);
      if (
        first.kind !== "event" ||
        last?.kind !== "event" ||
        excluded?.kind !== "event"
      )
        return null;
      const stages = [first, last, excluded];
      const item = first.item;
      bindings.length = 0;
      const flags = stages.map((step, index) => {
        bindings.push(...step.bindings);
        return `CASE WHEN (${step.predicate}) THEN 1 ELSE 0 END AS match_${index}`;
      });
      const events = (source: string) => `SELECT ${first.key},
          ${item}.occurred_at AS activity_time, 1 AS kind_rank,
          ${item}.event_id AS activity_id,
          ${flags.join(", ")}
          FROM ${source} ${item}
          WHERE ${item}.site_pk IS NOT NULL
            AND TRIM(COALESCE(${item}.${identity}, '')) != ''`;
      // Only matching endpoints and exclusions affect existence. Other
      // activities (including sessionless collisions) cannot be witnesses
      // or excluded items for this entity. An exclusion at either endpoint
      // is allowed; use strictly preceding rows and inclusive >=.
      const partition = "PARTITION BY site_pk, entity_id";
      const order =
        "ORDER BY activity_time, kind_rank, activity_id COLLATE BINARY";
      const previous = `${partition} ORDER BY position ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING`;
      withoutSqlForSource = (source) => `WITH ranked AS (
        SELECT *, ROW_NUMBER() OVER (${partition} ${order}) AS position
        FROM (${events(source)})
        WHERE match_0 = 1 OR match_1 = 1 OR match_2 = 1
      ), predecessors AS (
        SELECT site_pk, entity_id, match_1,
          MAX(CASE WHEN match_0 = 1 THEN position END) OVER (${previous}) AS last_start,
          MAX(CASE WHEN match_2 = 1 THEN position END) OVER (${previous}) AS last_excluded
        FROM ranked
      )
      SELECT DISTINCT site_pk, entity_id FROM predecessors
      WHERE match_1 = 1 AND last_start >= COALESCE(last_excluded, 0)`;
      sql = withoutSqlForSource(this.source("event", true));
    } else if (adjacent) {
      const matched = identical
        ? [first]
        : [
            first,
            ...steps.slice(1).map((step) => compileStep(step, first.item)),
          ];
      if (matched.some((step) => !step)) return null;
      const stages = matched as (typeof first)[];
      // Limit this fast path to the measured Event and mixed-pair families.
      if (
        !stages.some((step) => step.kind === "event") ||
        (count > 2 && stages.some((step) => step.kind === "page"))
      )
        return null;
      const item = first.item;
      const partitionKey =
        frame.anchorKind === "session"
          ? `COALESCE(NULLIF(${item}.session_id, ''), ${item}.visit_id)`
          : `${item}.visitor_id`;
      // Do not discard any intervening activity before computing the
      // window. A sessionless row may share a real session's timeline key
      // but must never provide a matching stage to that session.
      const eligible = `TRIM(COALESCE(${item}.${identity}, '')) != ''`;
      // Only entities with a matching Event can qualify. Retain the
      // complete timeline for each candidate, including sessionless rows
      // whose visit IDs collide with candidate session IDs.
      const eventStage = stages.find((step) => step.kind === "event")!;
      const eventStages = stages.filter((step) => step.kind === "event");
      // Each distinct Event stage needs a witness and the entity must
      // contain enough occurrences. Overlapping predicates may still
      // share a witness here: the complete timeline checks strict order.
      const hasPayload = (expression: FilterExpression): boolean => {
        if (expression.kind === "not") return hasPayload(expression.child);
        if (expression.kind === "condition")
          return expression.target.kind === "current-payload";
        return expression.children.some(hasPayload);
      };
      // Payload traversal can be expensive on unrelated events. Keep the
      // original candidate path for those selectors until separately measured.
      const stronger =
        !identical &&
        eventStages.length > 1 &&
        steps.every(
          (step) => step.kind !== "selector" || !hasPayload(step.predicate),
        );
      const candidateSql = stronger
        ? `SELECT ${eventStage.key} FROM ${eventStage.relation} ${item}
          WHERE ${item}.site_pk IS NOT NULL AND ${eligible}
          GROUP BY ${item}.site_pk, ${item}.${identity}
          HAVING COUNT(*) >= ${eventStages.length}
            AND ${eventStages.map((step) => `MAX(CASE WHEN (${step.predicate}) THEN 1 ELSE 0 END) = 1`).join(" AND ")}`
        : `SELECT ${eventStage.key} ${eventStage.from}
          GROUP BY ${eventStage.item}.site_pk, ${eventStage.item}.${identity}
          ${identical ? `HAVING COUNT(*) >= ${count}` : ""}`;
      bindings.length = 0;
      bindings.push(
        ...(stronger
          ? eventStages.flatMap((step) => step.bindings)
          : eventStage.bindings),
      );
      const readStart = this.clock?.readStartMs;
      const readEnd = this.clock?.readEndExclusiveMs;
      const indexedPages =
        this.sources.indexedGlobalTimelineVisits &&
        readStart !== undefined &&
        readEnd !== undefined;
      const branches = (["page", "event"] as const).map((kind) => {
        if (kind === "page" && indexedPages) {
          const flags = stages.map((step, index) => {
            if (step.kind !== "page") return `0 AS match_${index}`;
            bindings.push(...step.bindings);
            return `CASE WHEN ${eligible} AND (${step.predicate}) THEN 1 ELSE 0 END AS match_${index}`;
          });
          const project = (
            flags: readonly string[],
          ) => `SELECT ${item}.site_pk, candidate.entity_id,
            ${item}.started_at AS activity_time, 0 AS kind_rank,
            ${item}.visit_id AS activity_id, ${flags.join(", ")}
            FROM candidate_entities candidate CROSS JOIN visits ${item}
            WHERE ${item}.site_pk = candidate.site_pk AND ${item}.started_at >= ? AND ${item}.started_at < ?`;
          bindings.push(readStart, readEnd);
          const direct = `${project(flags)} AND ${item}.${identity} = candidate.entity_id`;
          if (frame.anchorKind !== "session") return direct;
          // The disjoint sessionless branch keeps position-only collision
          // blockers while allowing both physical keys to use their indexes.
          bindings.push(readStart, readEnd);
          return `${direct} UNION ALL ${project(stages.map((_, i) => `0 AS match_${i}`))}
            AND ${item}.visit_id = candidate.entity_id
            AND (${item}.session_id IS NULL OR ${item}.session_id = '')`;
        }
        const flags = stages.map((step, index) => {
          if (step.kind !== kind) return `0 AS match_${index}`;
          bindings.push(...step.bindings);
          return `CASE WHEN ${eligible} AND (${step.predicate}) THEN 1 ELSE 0 END AS match_${index}`;
        });
        return `SELECT ${item}.site_pk, ${partitionKey} AS entity_id,
          ${item}.${kind === "page" ? "started_at" : "occurred_at"} AS activity_time,
          ${kind === "page" ? 0 : 1} AS kind_rank,
          ${item}.${kind === "page" ? "visit_id" : "event_id"} AS activity_id,
          ${flags.join(", ")}
          FROM ${this.source(kind, true)} ${item}
          WHERE ${item}.site_pk IS NOT NULL
            AND (${item}.site_pk, ${partitionKey}) IN (SELECT site_pk, entity_id FROM candidate_entities)`;
      });
      const order =
        "PARTITION BY site_pk, entity_id ORDER BY activity_time, kind_rank, activity_id COLLATE BINARY";
      const checks = identical
        ? [
            `SUM(match_0) OVER (${order} ROWS BETWEEN CURRENT ROW AND ${count - 1} FOLLOWING) = ${count} AS qualifies`,
          ]
        : [
            `match_0 AND ${stages
              .slice(1)
              .map(
                (_, i) => `LEAD(match_${i + 1}, ${i + 1}) OVER (${order}) = 1`,
              )
              .join(" AND ")} AS qualifies`,
          ];
      sql = `WITH candidate_entities AS MATERIALIZED (${candidateSql}) SELECT DISTINCT site_pk,entity_id FROM (
        SELECT site_pk,entity_id,${checks.join(", ")}
        FROM (${branches.join(" UNION ALL ")})
      ) WHERE qualifies = 1`;
      const simpleStep = (step: FilterTargetExpression) =>
        step.kind === "entity-root" ||
        getNameSelector(step) !== null ||
        (step.kind === "selector" &&
          step.collection.kind === "entity-root" &&
          step.collection.entity === "page" &&
          step.predicate.kind === "condition" &&
          this.currentMember(step.predicate.target, "page") === "page.path" &&
          ["eq", "exists", "contains"].includes(step.predicate.operator));
      if (
        indexedPages &&
        !this.clock?.filterRangeExplicit &&
        steps.every(simpleStep) &&
        start !== undefined &&
        end !== undefined &&
        qStart !== undefined &&
        qEnd !== undefined &&
        qEnd > qStart &&
        qEnd - qStart <= 3600000 &&
        end - start >= 24 * (qEnd - qStart)
      ) {
        const anchor = frame.anchorAlias;
        const localBindings: (string | number | null)[] = [];
        const localBranches: string[] = [];
        for (const kind of ["page", "event"] as const) {
          const flags = stages.map((stage, index) => {
            if (stage.kind !== kind) return `0 AS match_${index}`;
            localBindings.push(...stage.bindings);
            return `CASE WHEN ${eligible} AND (${stage.predicate}) THEN 1 ELSE 0 END AS match_${index}`;
          });
          const project = (columns: readonly string[], collision: boolean) => {
            const key = collision
              ? `history_visit.visit_id=${anchor}.${identity} AND (history_visit.session_id IS NULL OR history_visit.session_id='')`
              : `history_visit.${identity}=${anchor}.${identity}`;
            const physical =
              kind === "page"
                ? `SELECT history_visit.* FROM visits history_visit WHERE history_visit.site_pk=${anchor}.site_pk AND ${key} AND history_visit.started_at>=? AND history_visit.started_at<?`
                : `SELECT history_event.site_pk,history_visit.session_id,history_visit.visitor_id,history_visit.visit_id,history_event.occurred_at,history_event.event_id,history_name.name AS event_name
                FROM visits history_visit CROSS JOIN custom_events history_event
                INNER JOIN custom_event_names history_name ON history_name.id=history_event.event_name_id
                WHERE history_visit.site_pk=${anchor}.site_pk AND ${key}
                AND history_event.site_pk=history_visit.site_pk AND history_event.visit_id=history_visit.visit_id
                AND history_event.occurred_at>=? AND history_event.occurred_at<?`;
            localBindings.push(start, end);
            return `SELECT ${item}.site_pk,${anchor}.${identity} AS entity_id,
              ${item}.${kind === "page" ? "started_at" : "occurred_at"} AS activity_time,
              ${kind === "page" ? 0 : 1} AS kind_rank,
              ${item}.${kind === "page" ? "visit_id" : "event_id"} AS activity_id,
              ${columns.join(", ")} FROM (${physical}) ${item}`;
          };
          localBranches.push(project(flags, false));
          if (frame.anchorKind === "session")
            localBranches.push(
              project(
                stages.map((_, i) => `0 AS match_${i}`),
                true,
              ),
            );
        }
        adjacentLocal = {
          sql: `EXISTS(SELECT 1 FROM (
          SELECT ${checks.join(", ")} FROM (${localBranches.join(" UNION ALL ")})
        ) WHERE qualifies=1)`,
          bindings: localBindings,
        };
      }
    } else if (multiStage) {
      if (first.kind !== "event") return null;
      const matched = steps
        .slice(1)
        .map((step) => compileStep(step, first.item));
      if (matched.some((step) => !step || step.kind !== "event")) return null;
      const stages = [first, ...matched] as (typeof first)[];
      // The earliest reachable occurrence of each prefix dominates every
      // later witness for plain existence. Reuse one ordered Event source
      // and propagate the minimum rank, never materialize combinations.
      const partition = "PARTITION BY site_pk, entity_id";
      const projections = stages.map(
        (step, index) =>
          `CASE WHEN (${step.predicate}) THEN 1 ELSE 0 END AS match_${index}`,
      );
      const ctes = [
        `ranked AS (
        SELECT ${first.key},
          ROW_NUMBER() OVER (PARTITION BY ${first.item}.site_pk, ${first.item}.${identity}
            ORDER BY ${first.item}.occurred_at, ${first.item}.event_id COLLATE BINARY) AS position,
          ${projections.join(", ")}
        FROM ${first.relation} ${first.item}
        WHERE ${first.item}.site_pk IS NOT NULL
          AND TRIM(COALESCE(${first.item}.${identity}, '')) != ''
      )`,
      ];
      let previous = "ranked";
      for (let index = 0; index < count - 1; index++) {
        const name = `reachable_${index}`;
        ctes.push(`${name} AS (
          SELECT *, MIN(CASE WHEN match_${index} = 1 THEN position END)
            OVER (${partition}) AS reached_${index}
          FROM ${previous}
          ${index === 0 ? "" : `WHERE position > reached_${index - 1}`}
        )`);
        previous = name;
      }
      sql = `WITH ${ctes.join(", ")}
        SELECT DISTINCT site_pk, entity_id FROM ${previous}
        WHERE match_${count - 1} = 1 AND position > reached_${count - 2}`;
      bindings.push(...stages.slice(1).flatMap((step) => step.bindings));
    } else if (same) {
      if (first.kind !== "event") return null;
      const token = (step: typeof first): SqlFragment => {
        if (same.kind === "current-payload")
          return compileJsonPointerValue(step.item, same.path);
        const field = this.currentMember(same, step.kind);
        if (!field) return { sql: "NULL", bindings: [] };
        return {
          sql: compileRegisteredFieldScalar(field, step.item),
          bindings: [],
        };
      };
      const valid =
        same.kind === "current-payload"
          ? "json_extract(typed_value, '$.t') IN (1, 2, 3)"
          : "typed_value IS NOT NULL";
      const firstToken = token(first);
      if (identical) {
        // Keep exact typed JSON encoding, including Missing/null exclusion.
        // Project once before grouping; name uses binary string equality.
        sql = `WITH candidates AS MATERIALIZED (
          SELECT ${first.key}, ${firstToken.sql} AS typed_value ${first.from}
        ) SELECT DISTINCT site_pk, entity_id FROM candidates
        WHERE ${valid}
        GROUP BY site_pk, entity_id, typed_value COLLATE BINARY
        HAVING COUNT(*) >= ${count}`;
        bindings.unshift(...firstToken.bindings);
      } else {
        const last = compileStep(steps[1]!);
        if (!last || last.kind !== "event") return null;
        const lastToken = token(last);
        const projection = (
          step: typeof first,
          value: SqlFragment,
          index: number,
        ) =>
          `SELECT ${step.key}, ${step.item}.occurred_at AS activity_time,
            ${step.item}.event_id COLLATE BINARY AS activity_id,
            ${index} AS step_index, ${value.sql} AS typed_value ${step.from}`;
        sql = `WITH candidates AS MATERIALIZED (
          ${projection(first, firstToken, 0)} UNION ALL ${projection(last, lastToken, 1)}
        ), by_time AS (
          SELECT site_pk, entity_id, typed_value COLLATE BINARY AS typed_value, activity_time,
            MIN(CASE WHEN step_index = 0 THEN activity_id END COLLATE BINARY) AS first_id,
            MAX(CASE WHEN step_index = 1 THEN activity_id END COLLATE BINARY) AS last_id
          FROM candidates WHERE ${valid}
          GROUP BY site_pk, entity_id, typed_value COLLATE BINARY, activity_time
        ) SELECT DISTINCT site_pk, entity_id FROM by_time
        GROUP BY site_pk, entity_id, typed_value COLLATE BINARY
        HAVING MIN(CASE WHEN first_id IS NOT NULL THEN activity_time END) <
          MAX(CASE WHEN last_id IS NOT NULL THEN activity_time END)
          OR MAX(first_id COLLATE BINARY < last_id COLLATE BINARY) = 1`;
        bindings.unshift(...firstToken.bindings);
        bindings.push(...lastToken.bindings, ...last.bindings);
      }
    } else if (identical && !compared) {
      sql = `SELECT ${first.key} ${first.from}
        GROUP BY ${first.item}.site_pk, ${first.item}.${identity}
        HAVING COUNT(*) >= ${count}`;
    } else if (identical && compared) {
      const time = `${first.item}.occurred_at`;
      const intrinsic = bound?.kind === "condition" ? bound.target : null;
      const internal =
        intrinsic?.kind === "context-intrinsic" &&
        intrinsic.intrinsic === "gap" &&
        (intrinsic.from !== 1 || intrinsic.to !== count);
      if (internal) {
        // An internal pair must reserve its preceding and following
        // occurrences. For an upper bound the nearest feasible pair is
        // separated by exactly to-from ranks; for a lower bound the
        // first and last feasible endpoints attain the maximum gap.
        const from = intrinsic.from;
        const to = intrinsic.to;
        const suffix = count - to;
        const partition = `PARTITION BY ${first.item}.site_pk, ${first.item}.${identity}`;
        const order = `ORDER BY ${time}, ${first.item}.event_id COLLATE BINARY`;
        const ranked = `SELECT ${first.key}, ${time} AS activity_time,
          ROW_NUMBER() OVER (${partition} ${order}) AS position,
          COUNT(*) OVER (${partition}) AS total
          ${upper ? `, ${time} - LAG(${time}, ${to - from}) OVER (${partition} ${order}) AS span_delta` : ""}
          ${first.from}`;
        sql = upper
          ? `SELECT DISTINCT site_pk, entity_id FROM (${ranked})
            WHERE position >= ${to} AND position <= total - ${suffix}
              AND ${compared.sql}`
          : `SELECT site_pk, entity_id FROM (
            SELECT site_pk, entity_id,
              MAX(CASE WHEN position <= total - ${suffix} THEN activity_time END)
              - MIN(CASE WHEN position >= ${from} THEN activity_time END) AS span_delta
            FROM (${ranked}) GROUP BY site_pk, entity_id
            HAVING MAX(total) >= ${count}
          ) WHERE ${compared.sql}`;
      } else {
        sql = upper
          ? `SELECT DISTINCT site_pk, entity_id FROM (
          SELECT ${first.key}, ${time} - LAG(${time}, ${count - 1})
            OVER (PARTITION BY ${first.item}.site_pk, ${first.item}.${identity} ORDER BY ${time}) AS span_delta
          ${first.from}
        ) WHERE ${compared.sql}`
          : `SELECT site_pk, entity_id FROM (
          SELECT ${first.key}, MAX(${time}) - MIN(${time}) AS span_delta
          ${first.from}
          GROUP BY ${first.item}.site_pk, ${first.item}.${identity}
          HAVING COUNT(*) >= ${count}
        ) WHERE ${compared.sql}`;
      }
      bindings.push(...compared.bindings);
    } else {
      const last = compileStep(steps[1]!);
      if (!last || first.kind !== "event" || last.kind !== "event") return null;
      const projection = (step: typeof first, index: number) =>
        `SELECT ${step.key}, ${step.item}.occurred_at AS activity_time,
          ${step.item}.event_id COLLATE BINARY AS activity_id, ${index} AS step_index
          ${step.from}`;
      // Exclude the entire current occurrence peer group: a single Event
      // may satisfy both selectors but cannot witness both sequence steps.
      sql = `SELECT DISTINCT site_pk, entity_id FROM (
        SELECT site_pk, entity_id, step_index, activity_time -
          ${upper ? "MAX" : "MIN"}(CASE WHEN step_index = 0 THEN activity_time END)
          OVER (PARTITION BY site_pk, entity_id ORDER BY activity_time, activity_id COLLATE BINARY
            GROUPS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING) AS span_delta
        FROM (${projection(first, 0)} UNION ALL ${projection(last, 1)})
      ) WHERE step_index = 1 AND ${compared?.sql ?? "span_delta IS NOT NULL"}`;
      bindings.push(...last.bindings, ...(compared?.bindings ?? []));
    }
    const name = `scope_global_sequence_${this.globalSequenceCtes.length}`;
    this.globalSequenceCtes.push(
      boundCte(name, `${name} AS (${sql})`, bindings),
    );
    let found = `COALESCE((${frame.anchorAlias}.site_pk, ${frame.anchorAlias}.${identity})
      IN (SELECT site_pk, entity_id FROM ${name}), 0)`;
    const firstName = getNameSelector(steps[0]!);
    const lastName = getNameSelector(steps[1]!);
    const seekBindings: (string | number | null)[] = [];
    if (adjacentLocal) {
      const universe =
        frame.anchorKind === "session"
          ? "scope_filter_sessions"
          : "scope_filter_visitors";
      found = `CASE WHEN EXISTS(SELECT 1 FROM ${universe} LIMIT 1 OFFSET 64)
        THEN ${found} ELSE ${adjacentLocal.sql} END`;
      seekBindings.push(...adjacentLocal.bindings);
    }
    const simpleEventStep = (step: FilterTargetExpression) =>
      (step.kind === "entity-root" && step.entity === "event") ||
      getNameSelector(step) !== null;
    if (
      withoutSqlForSource &&
      without &&
      target.kind === "without" &&
      this.sources.indexedGlobalTimelineVisits &&
      steps.every(simpleEventStep) &&
      simpleEventStep(target.excluded) &&
      !this.clock?.filterRangeExplicit &&
      start !== undefined &&
      end !== undefined &&
      qStart !== undefined &&
      qEnd !== undefined &&
      qEnd > qStart &&
      qEnd - qStart <= 3600000 &&
      end - start >= 24 * (qEnd - qStart)
    ) {
      const universe =
        frame.anchorKind === "session"
          ? "scope_filter_sessions"
          : "scope_filter_visitors";
      // The original window logic already preserves strict exclusion boundaries.
      // Restrict only its input to the current report entity, not the history.
      const physical = `(SELECT history_event.site_pk, history_visit.${identity},
          history_event.occurred_at, history_event.event_id, history_name.name AS event_name
        FROM visits history_visit
        CROSS JOIN custom_events history_event
        INNER JOIN custom_event_names history_name ON history_name.id=history_event.event_name_id
        WHERE history_visit.site_pk=${frame.anchorAlias}.site_pk
          AND history_visit.${identity}=${frame.anchorAlias}.${identity}
          AND history_event.site_pk=history_visit.site_pk
          AND history_event.visit_id=history_visit.visit_id
          AND history_event.occurred_at>=? AND history_event.occurred_at<?)`;
      const localSql = withoutSqlForSource(physical);
      seekBindings.push(...bindings, start, end);
      found = `CASE WHEN EXISTS (SELECT 1 FROM ${universe} LIMIT 1 OFFSET 64)
        THEN ${found} ELSE EXISTS(SELECT 1 FROM (${localSql})) END`;
    }

    if (
      this.sources.indexedGlobalTimelineVisits &&
      target.kind === "sequence" &&
      !identical &&
      count === 2 &&
      firstName &&
      lastName &&
      !this.clock?.filterRangeExplicit &&
      start !== undefined &&
      end !== undefined &&
      qStart !== undefined &&
      qEnd !== undefined &&
      qEnd > qStart &&
      qEnd - qStart <= 3600000 &&
      end - start >= 24 * (qEnd - qStart)
    ) {
      const universe =
        frame.anchorKind === "session"
          ? "scope_filter_sessions"
          : "scope_filter_visitors";
      const extreme = (
        selector: FilterCondition,
        direction: "ASC" | "DESC",
      ) => {
        const predicate = onlyApplicable(
          this.expression(selector, {
            ...frame,
            currentAlias: "history_name",
            currentKind: "event",
          }),
        );
        seekBindings.push(start, end, ...predicate.bindings);
        return `(SELECT history_event.occurred_at, history_event.event_id COLLATE BINARY
          FROM visits history_visit
          CROSS JOIN custom_events history_event
          INNER JOIN (SELECT id,name AS event_name FROM custom_event_names) history_name ON history_name.id=history_event.event_name_id
          WHERE history_visit.site_pk=${frame.anchorAlias}.site_pk AND history_visit.${identity}=${frame.anchorAlias}.${identity}
          AND history_event.site_pk=history_visit.site_pk AND history_event.visit_id=history_visit.visit_id
          AND history_event.occurred_at>=? AND history_event.occurred_at<?
          AND (${predicate.sql})
          ORDER BY history_event.occurred_at ${direction}, history_event.event_id COLLATE BINARY ${direction} LIMIT 1)`;
      };
      const earliest = extreme(firstName, "ASC");
      const latest = extreme(lastName, "DESC");
      found = `CASE WHEN EXISTS(SELECT 1 FROM ${universe} LIMIT 1 OFFSET 64)
        THEN ${found} ELSE COALESCE(${earliest} < ${latest},0) END`;
    }

    if (
      this.sources.indexedGlobalTimelineVisits &&
      target.kind === "selector" &&
      !identical &&
      count === 2 &&
      firstName &&
      lastName &&
      compared &&
      upper &&
      historyRoot.kind === "entity-root" &&
      historyRoot.entity === "event" &&
      !this.clock?.filterRangeExplicit &&
      start !== undefined &&
      end !== undefined &&
      qStart !== undefined &&
      qEnd !== undefined &&
      qEnd > qStart &&
      qEnd - qStart <= 3600000 &&
      end - start >= 24 * (qEnd - qStart)
    ) {
      const universe =
        frame.anchorKind === "session"
          ? "scope_filter_sessions"
          : "scope_filter_visitors";
      const anchor = frame.anchorAlias;
      const flags = [firstName, lastName].map((selector, index) => {
        const predicate = onlyApplicable(
          this.expression(selector, {
            ...frame,
            currentAlias: "history_name",
            currentKind: "event",
          }),
        );
        seekBindings.push(...predicate.bindings);
        return `CASE WHEN (${predicate.sql}) THEN 1 ELSE 0 END AS match_${index}`;
      });
      seekBindings.push(start, end);
      // Physical Event occurrences are unique. The latest strictly earlier
      // first-stage witness minimizes the gap for each second-stage witness.
      // One source with two flags avoids visiting the same history twice.
      const ranked = `SELECT match_1, activity_time -
        MAX(CASE WHEN match_0=1 THEN activity_time END) OVER (
          ORDER BY activity_time,activity_id COLLATE BINARY
          ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING) AS span_delta
        FROM (SELECT history_event.occurred_at AS activity_time,
          history_event.event_id AS activity_id,${flags.join(", ")}
          FROM visits history_visit
          CROSS JOIN custom_events history_event
          INNER JOIN (SELECT id,name AS event_name FROM custom_event_names) history_name
            ON history_name.id=history_event.event_name_id
          WHERE history_visit.site_pk=${anchor}.site_pk
            AND history_visit.${identity}=${anchor}.${identity}
            AND history_event.site_pk=history_visit.site_pk
            AND history_event.visit_id=history_visit.visit_id
            AND history_event.occurred_at>=? AND history_event.occurred_at<?)`;
      const local = `EXISTS(SELECT 1 FROM (${ranked})
        WHERE match_1=1 AND ${compared.sql})`;
      seekBindings.push(...compared.bindings);
      found = `CASE WHEN EXISTS(SELECT 1 FROM ${universe} LIMIT 1 OFFSET 64)
        THEN ${found} ELSE ${local} END`;
    }

    if (
      this.sources.indexedGlobalTimelineVisits &&
      identical &&
      count <= 5 &&
      compared &&
      historyRoot.kind === "entity-root" &&
      historyRoot.entity === "event" &&
      (firstStep.kind === "entity-root" || nameSelector !== null) &&
      !this.clock?.filterRangeExplicit &&
      start !== undefined &&
      end !== undefined &&
      qStart !== undefined &&
      qEnd !== undefined &&
      qEnd > qStart &&
      qEnd - qStart <= 3600000 &&
      end - start >= 24 * (qEnd - qStart)
    ) {
      const universe =
        frame.anchorKind === "session"
          ? "scope_filter_sessions"
          : "scope_filter_visitors";
      const predicate = nameSelector
        ? onlyApplicable(
            this.expression(nameSelector, {
              ...frame,
              currentAlias: "history_name",
              currentKind: "event",
            }),
          )
        : { sql: "1", bindings: [] };
      const physical = () => {
        seekBindings.push(start, end, ...predicate.bindings);
        return `FROM visits history_visit
          CROSS JOIN custom_events history_event
          INNER JOIN ${nameSelector ? "(SELECT id,name AS event_name FROM custom_event_names)" : "custom_event_names"} history_name ON history_name.id=history_event.event_name_id
          WHERE history_visit.site_pk=${frame.anchorAlias}.site_pk AND history_visit.${identity}=${frame.anchorAlias}.${identity}
          AND history_event.site_pk=history_visit.site_pk AND history_event.visit_id=history_visit.visit_id
          AND history_event.occurred_at>=? AND history_event.occurred_at<?
          AND (${predicate.sql})`;
      };
      const intrinsic = bound?.kind === "condition" ? bound.target : null;
      const from =
        intrinsic?.kind === "context-intrinsic" && intrinsic.intrinsic === "gap"
          ? intrinsic.from
          : 1;
      const to =
        intrinsic?.kind === "context-intrinsic" && intrinsic.intrinsic === "gap"
          ? intrinsic.to
          : count;
      let local: string;
      if (upper) {
        // An upper bound is satisfied by the tightest feasible N-occurrence
        // window. Use the same (time, binary event ID) ordering as sequence
        // evaluation, then compare the time delta between the requested steps.
        const distance = to - from;
        const suffix = count - to;
        const order =
          "ORDER BY history_event.occurred_at, history_event.event_id COLLATE BINARY";
        const prefixGuard =
          from > 1
            ? `, LAG(history_event.event_id, ${to - 1}) OVER (${order}) IS NOT NULL AS has_prefix`
            : "";
        const suffixGuard =
          suffix > 0
            ? `, LEAD(history_event.event_id, ${suffix}) OVER (${order}) IS NOT NULL AS has_suffix`
            : "";
        const guards = [
          ...(from > 1 ? ["has_prefix"] : []),
          ...(suffix > 0 ? ["has_suffix"] : []),
        ];
        const ranked = `SELECT
            history_event.occurred_at -
              LAG(history_event.occurred_at, ${distance}) OVER (${order}) AS span_delta
            ${prefixGuard}${suffixGuard}
          ${physical()}`;
        local = `EXISTS(SELECT 1 FROM (${ranked})
          WHERE ${compared.sql}${guards.map((guard) => ` AND ${guard}`).join("")})`;
        seekBindings.push(...compared.bindings);
      } else if (from === 1 && to === count) {
        local = `EXISTS(SELECT 1 FROM (SELECT MAX(history_event.occurred_at)-MIN(history_event.occurred_at) AS span_delta
          ${physical()} HAVING COUNT(*)>=${count}) WHERE ${compared.sql})`;
        seekBindings.push(...compared.bindings);
      } else {
        const enough = `EXISTS(SELECT 1 ${physical()} LIMIT 1 OFFSET ${count - 1})`;
        const extreme = (
          direction: "ASC" | "DESC",
          offset: number,
        ) => `(SELECT history_event.occurred_at ${physical()}
          ORDER BY history_event.occurred_at ${direction},history_event.event_id COLLATE BINARY ${direction} LIMIT 1 OFFSET ${offset})`;
        const last = extreme("DESC", count - to);
        const first = extreme("ASC", from - 1);
        local = `CASE WHEN ${enough} THEN EXISTS(SELECT 1 FROM (SELECT ${last}-${first} AS span_delta) WHERE ${compared.sql}) ELSE 0 END`;
        seekBindings.push(...compared.bindings);
      }
      found = `CASE WHEN EXISTS(SELECT 1 FROM ${universe} LIMIT 1 OFFSET 64) THEN ${found} ELSE (${local}) END`;
    }

    if (
      this.sources.indexedGlobalTimelineVisits &&
      multiStage &&
      target.kind === "sequence" &&
      steps.every((step) => getNameSelector(step) !== null) &&
      !this.clock?.filterRangeExplicit &&
      start !== undefined &&
      end !== undefined &&
      qStart !== undefined &&
      qEnd !== undefined &&
      qEnd > qStart &&
      qEnd - qStart <= 3600000 &&
      end - start >= 24 * (qEnd - qStart)
    ) {
      const universe =
        frame.anchorKind === "session"
          ? "scope_filter_sessions"
          : "scope_filter_visitors";
      const flags = steps.map((step, index) => {
        const predicate = onlyApplicable(
          this.expression(getNameSelector(step)!, {
            ...frame,
            currentAlias: "history_name",
            currentKind: "event",
          }),
        );
        seekBindings.push(...predicate.bindings);
        return `CASE WHEN (${predicate.sql}) THEN 1 ELSE 0 END AS match_${index}`;
      });
      seekBindings.push(start, end);
      // One ordered source per entity; the earliest reachable prefix
      // dominates every later witness for an unconstrained sequence.
      // Reusing strict positions also prevents overlapping selectors from
      // matching the same occurrence twice.
      const ranked = `history_ranked AS (
        SELECT ROW_NUMBER() OVER (ORDER BY history_event.occurred_at,history_event.event_id COLLATE BINARY) AS position,
          ${flags.join(", ")}
        FROM visits history_visit
        CROSS JOIN custom_events history_event
        INNER JOIN (SELECT id,name AS event_name FROM custom_event_names) history_name ON history_name.id=history_event.event_name_id
        WHERE history_visit.site_pk=${frame.anchorAlias}.site_pk AND history_visit.${identity}=${frame.anchorAlias}.${identity}
          AND history_event.site_pk=history_visit.site_pk AND history_event.visit_id=history_visit.visit_id
          AND history_event.occurred_at>=? AND history_event.occurred_at<?)`;
      const ctes = [ranked];
      let previous = "history_ranked";
      for (let index = 0; index < count - 1; index++) {
        const next = `history_reachable_${index}`;
        ctes.push(`${next} AS (
          SELECT *, MIN(CASE WHEN match_${index}=1 THEN position END) OVER () AS reached_${index}
          FROM ${previous} ${index === 0 ? "" : `WHERE position > reached_${index - 1}`})`);
        previous = next;
      }
      const local = `EXISTS(WITH ${ctes.join(", ")}
        SELECT 1 FROM ${previous} WHERE match_${count - 1}=1 AND position > reached_${count - 2})`;
      found = `CASE WHEN EXISTS(SELECT 1 FROM ${universe} LIMIT 1 OFFSET 64) THEN ${found} ELSE ${local} END`;
    }

    return {
      sql: condition.operator === "notExists" ? `NOT (${found})` : found,
      bindings: seekBindings,
      applicable: true,
    };
  }

  /**
   * Identical unconstrained steps need only N distinct occurrences; a
   * two-step sequence can use its first minimum and last maximum.
   * Keep Page-only distinct pairs and other shapes on the full enumerator.
   */
  private localSequenceExists(
    condition: FilterCondition,
    frame: SqlFrame,
  ): PredicateFragment | null {
    const target = condition.target;
    if (
      !this.sources.uniqueLocalOccurrences ||
      (frame.anchorKind !== "session" && frame.anchorKind !== "visitor") ||
      (condition.operator !== "exists" && condition.operator !== "notExists") ||
      target.kind !== "sequence" ||
      target.steps.length < 2
    )
      return null;
    const steps = target.steps.map((step) =>
      this.collection(step, frame, !this.clock?.filterRangeExplicit),
    );
    if (
      steps.some(
        (step) => step.entityKind !== "page" && step.entityKind !== "event",
      )
    )
      return null;
    const identical = target.steps.every(
      (step) => JSON.stringify(step) === JSON.stringify(target.steps[0]),
    );
    if (identical) {
      // The same unique occurrence collection can satisfy N identical
      // steps iff it contains at least N distinct occurrences.
      const step = steps[0]!;
      const found = `EXISTS (SELECT 1 FROM (${step.sql}) ${this.alias()}
        LIMIT 1 OFFSET ${steps.length - 1})`;
      return {
        sql: condition.operator === "notExists" ? `NOT ${found}` : found,
        bindings: step.bindings,
        applicable: true,
      };
    }
    if (steps.length === 2 && steps[0]!.entityKind !== steps[1]!.entityKind) {
      // At equal timestamps every Page precedes every Event. For a
      // heterogeneous pair no occurrence ID comparison is needed.
      const first = steps[0]!;
      const last = steps[1]!;
      const time = (step: SqlCollectionRef) =>
        step.entityKind === "event" ? "occurred_at" : "started_at";
      const earliest = `(SELECT MIN(${time(first)}) FROM (${first.sql}) ${this.alias()})`;
      const latest = `(SELECT MAX(${time(last)}) FROM (${last.sql}) ${this.alias()})`;
      const found = `EXISTS (SELECT 1 WHERE ${earliest}
        ${first.entityKind === "page" ? "<=" : "<"} ${latest})`;
      return {
        sql: condition.operator === "notExists" ? `NOT ${found}` : found,
        bindings: [...first.bindings, ...last.bindings],
        applicable: true,
      };
    }
    if (steps.length !== 2 || steps[0]!.entityKind !== "event") return null;
    // Distinct Event steps use independent extrema with strict binary
    // ordering. Distinct Page pairs keep the established lookup path.
    const first = steps[0]!;
    const last = steps[1]!;
    const time = "occurred_at";
    const id = "event_id COLLATE BINARY";
    const extreme = (step: SqlCollectionRef, direction: "ASC" | "DESC") =>
      `(SELECT ${time}, ${id} FROM (${step.sql}) ${this.alias()}
        ORDER BY ${time} ${direction}, ${id} ${direction} LIMIT 1)`;
    const found = `EXISTS (SELECT 1 WHERE ${extreme(first, "ASC")}
      < ${extreme(last, "DESC")})`;
    return {
      sql: condition.operator === "notExists" ? `NOT ${found}` : found,
      bindings: [...first.bindings, ...last.bindings],
      applicable: true,
    };
  }

  /**
   * For N identical steps the smallest possible span is attained by
   * N consecutive occurrences within the filtered collection. Given at
   * least N occurrences, the largest span is attained by its time extrema.
   * This does not imply Adjacent on the unfiltered timeline.
   */
  private localSequenceSpanExists(
    condition: FilterCondition,
    frame: SqlFrame,
  ): PredicateFragment | null {
    const target = condition.target;
    if (
      !this.sources.uniqueLocalOccurrences ||
      (frame.anchorKind !== "session" && frame.anchorKind !== "visitor") ||
      (condition.operator !== "exists" && condition.operator !== "notExists") ||
      target.kind !== "selector" ||
      target.collection.kind !== "sequence" ||
      target.collection.steps.length < 2 ||
      target.predicate.kind !== "condition"
    )
      return null;
    const sequenceSteps = target.collection.steps;
    const identical = sequenceSteps.every(
      (step) => JSON.stringify(step) === JSON.stringify(sequenceSteps[0]),
    );
    const count = sequenceSteps.length;
    if (!identical && count !== 2) return null;
    const predicate = target.predicate;
    const intrinsic = predicate.target;
    if (
      intrinsic.kind !== "context-intrinsic" ||
      intrinsic.context !== "sequence" ||
      (intrinsic.intrinsic !== "span" &&
        !(
          intrinsic.intrinsic === "gap" &&
          intrinsic.from >= 1 &&
          intrinsic.from < intrinsic.to &&
          intrinsic.to <= count
        )) ||
      !["lt", "lte", "gt", "gte"].includes(predicate.operator)
    )
      return null;
    if (!identical) {
      const steps = sequenceSteps.map((step) =>
        this.collection(step, frame, !this.clock?.filterRangeExplicit),
      );
      if (
        steps.some(
          (step) => step.entityKind !== "event" && step.entityKind !== "page",
        )
      )
        return null;
      const upper = predicate.operator === "lt" || predicate.operator === "lte";
      const firstKind = steps[0]!.entityKind;
      const lastKind = steps[1]!.entityKind;
      // Mixed sources and distinct Page selectors can cost more than
      // the existing enumerator when a selector is highly selective.
      if (firstKind !== "event" || lastKind !== "event") return null;
      const projection = (step: SqlCollectionRef, index: number) => {
        const item = this.alias();
        return `SELECT ${item}.occurred_at AS activity_time,
          ${item}.event_id COLLATE BINARY AS activity_id,
          ${index} AS step_index FROM (${step.sql}) ${item}`;
      };
      const first = projection(steps[0]!, 0);
      const last = projection(steps[1]!, 1);
      const compared = compareScalar(
        { sql: "span_delta", bindings: [] },
        predicate.operator,
        predicate.value,
        this.clock,
      );
      // Peer groups represent the very same occurrence, including when it
      // matches both selectors. Exclude the entire peer group, not just
      // the previous row, to retain strict original timeline ordering.
      const found = upper
        ? `EXISTS (SELECT 1 FROM (
          SELECT step_index, activity_time - MAX(CASE WHEN step_index = 0 THEN activity_time END)
            OVER (ORDER BY activity_time, activity_id COLLATE BINARY
              GROUPS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING) AS span_delta
          FROM (${first} UNION ALL ${last})
        ) WHERE step_index = 1 AND ${compared.sql})`
        : `EXISTS (SELECT 1 FROM (
          SELECT b.activity_time - a.activity_time AS span_delta
          FROM (SELECT * FROM (${first}) ORDER BY activity_time, activity_id COLLATE BINARY LIMIT 1) a
          CROSS JOIN (SELECT * FROM (${last}) ORDER BY activity_time DESC, activity_id COLLATE BINARY DESC LIMIT 1) b
          WHERE (a.activity_time, a.activity_id COLLATE BINARY)
            < (b.activity_time, b.activity_id COLLATE BINARY)
        ) WHERE ${compared.sql})`;
      return {
        sql: condition.operator === "notExists" ? `NOT ${found}` : found,
        bindings: [
          ...steps[0]!.bindings,
          ...steps[1]!.bindings,
          ...compared.bindings,
        ],
        applicable: true,
      };
    }
    const step = this.collection(
      target.collection.steps[0]!,
      frame,
      !this.clock?.filterRangeExplicit,
    );
    if (step.entityKind !== "event" && step.entityKind !== "page") return null;
    const item = this.alias();
    const time = step.entityKind === "event" ? "occurred_at" : "started_at";
    const upper = predicate.operator === "lt" || predicate.operator === "lte";
    if (
      intrinsic.intrinsic === "gap" &&
      (intrinsic.from !== 1 || intrinsic.to !== count)
    ) {
      // Page lower bounds can stop earlier in the existing enumerator.
      if (!upper && step.entityKind === "page") return null;
      const from = intrinsic.from;
      const to = intrinsic.to;
      const suffix = count - to;
      const distance = to - from;
      // A valid pair must leave enough matching occurrences for the
      // preceding and following sequence steps. For an upper bound,
      // consecutive positions separated by distance minimize the gap.
      // For a lower bound, the first and last feasible endpoints maximize it.
      const compared = compareScalar(
        { sql: "span_delta", bindings: [] },
        predicate.operator,
        predicate.value,
        this.clock,
      );
      const ranked = `SELECT ${time} AS activity_time,
        ROW_NUMBER() OVER (ORDER BY ${time}) AS position,
        COUNT(*) OVER () AS total
        ${upper ? `, ${time} - LAG(${time}, ${distance}) OVER (ORDER BY ${time}) AS span_delta` : ""}
        FROM (${step.sql}) ${item}`;
      const found = upper
        ? `EXISTS (SELECT 1 FROM (${ranked})
          WHERE position >= ${to} AND position <= total - ${suffix} AND ${compared.sql})`
        : `EXISTS (SELECT 1 FROM (
          SELECT MAX(CASE WHEN position <= total - ${suffix} THEN activity_time END)
            - MIN(CASE WHEN position >= ${from} THEN activity_time END) AS span_delta
          FROM (${ranked}) HAVING MAX(total) >= ${count}
        ) WHERE ${compared.sql})`;
      return {
        sql: condition.operator === "notExists" ? `NOT ${found}` : found,
        bindings: [...step.bindings, ...compared.bindings],
        applicable: true,
      };
    }
    const compared = compareScalar(
      {
        sql: upper ? "span_delta" : `MAX(${time}) - MIN(${time})`,
        bindings: [],
      },
      predicate.operator,
      predicate.value,
      this.clock,
    );
    const found = upper
      ? `EXISTS (SELECT 1 FROM (
          SELECT ${time} - LAG(${time}, ${count - 1}) OVER (ORDER BY ${time}) AS span_delta
          FROM (${step.sql}) ${item}
        ) WHERE ${compared.sql})`
      : `EXISTS (SELECT COUNT(*) FROM (${step.sql}) ${item}
        HAVING COUNT(*) >= ${count} AND ${compared.sql})`;
    return {
      sql: condition.operator === "notExists" ? `NOT ${found}` : found,
      bindings: [...step.bindings, ...compared.bindings],
      applicable: true,
    };
  }

  private condition(
    condition: FilterCondition,
    frame: SqlFrame,
  ): PredicateFragment {
    const globalSequence = this.globalSequenceExists(condition, frame);
    if (globalSequence) return globalSequence;
    const optimizedSame = this.localSameSequenceExists(condition, frame);
    if (optimizedSame) return optimizedSame;
    const optimizedSpan = this.localSequenceSpanExists(condition, frame);
    if (optimizedSpan) return optimizedSpan;
    const optimizedSequence = this.localSequenceExists(condition, frame);
    if (optimizedSequence) return optimizedSequence;
    const target = condition.target;
    if (target.kind === "context-intrinsic" && target.context === "sequence") {
      if (!frame.sequenceAlias)
        throw new TypeError("Sequence intrinsic outside Sequence item.");
      const alias = frame.sequenceAlias;
      let value: SqlFragment;
      if (target.intrinsic === "span") {
        value = { sql: `(${alias}.end_ms - ${alias}.start_ms)`, bindings: [] };
      } else if (target.intrinsic === "gap") {
        const from = target.from - 1;
        const to = target.to - 1;
        value = {
          sql: `(json_extract(${alias}.sequence_steps, '$[${to}].time')
            - json_extract(${alias}.sequence_steps, '$[${from}].time'))`,
          bindings: [],
        };
      } else {
        value = this.sequenceSame(target.input, frame);
      }
      return {
        ...compareScalar(
          value,
          condition.operator,
          condition.value,
          this.clock,
        ),
        applicable: true,
      };
    }
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
      if (
        target.member === "time" &&
        target.object.kind === "context-root" &&
        target.object.context === "current"
      ) {
        if (frame.currentKind === "page" || frame.currentKind === "event") {
          const column =
            frame.currentKind === "page" ? "started_at" : "occurred_at";
          const test = compareScalar(
            { sql: `${frame.currentAlias}.${column}`, bindings: [] },
            condition.operator,
            condition.value,
            this.clock,
          );
          return { ...test, applicable: true };
        }
        if (
          frame.currentKind === "session" ||
          frame.currentKind === "visitor"
        ) {
          const relation =
            frame.currentKind === "session" ? "session_id" : "visitor_id";
          const clauses = (kind: "page" | "event") => {
            const alias =
              kind === "page" ? "scope_time_page" : "scope_time_event";
            const test = compareScalar(
              {
                sql: `${alias}.${kind === "page" ? "started_at" : "occurred_at"}`,
                bindings: [],
              },
              condition.operator,
              condition.value,
              this.clock,
            );
            return {
              sql: `EXISTS (SELECT 1 FROM ${this.source(kind)} ${alias}
                WHERE ${alias}.site_pk = ${frame.currentAlias}.site_pk
                  AND ${alias}.${relation} = ${frame.currentAlias}.${relation}
                  AND ${test.sql})`,
              bindings: test.bindings,
            };
          };
          const visits = clauses("page");
          const events = clauses("event");
          return {
            sql: `(${visits.sql} OR ${events.sql})`,
            bindings: [...visits.bindings, ...events.bindings],
            applicable: true,
          };
        }
        throw new TypeError(
          "Time context must bind a Page, Event, Session or Visitor.",
        );
      }
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
        const scalar = compileSqlScalar(
          target,
          (collection, useReadRange) =>
            this.collection(collection, frame, useReadRange),
          this.clock,
        );
        return {
          ...compareScalar(
            scalar,
            condition.operator,
            condition.value,
            this.clock,
          ),
          applicable: true,
        };
      }
      return { sql: "0", bindings: [], applicable: false };
    }
    if (
      target.kind === "selector" ||
      target.kind === "entity-root" ||
      target.kind === "sequence" ||
      target.kind === "adjacent" ||
      target.kind === "without" ||
      target.kind === "periods"
    ) {
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
    if (
      target.kind === "reducer" ||
      target.kind === "arithmetic" ||
      target.kind === "occurrence-time" ||
      target.kind === "duration" ||
      target.kind === "time-anchor"
    ) {
      const scalar = compileSqlScalar(
        target,
        (collection, useReadRange) =>
          this.collection(collection, frame, useReadRange),
        this.clock,
      );
      return {
        ...compareScalar(
          scalar,
          condition.operator,
          condition.value,
          this.clock,
        ),
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
  clock?: SqlScalarTimeContext,
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
  const readVisits = safeQualificationIdentifier(
    sources.readVisits ?? filterVisits,
  );
  const readEvents = safeQualificationIdentifier(
    sources.readEvents ?? filterEvents,
  );
  // A future-only (proven empty) Filter domain must not let historical
  // Sequence, Window or WITHOUT reads qualify any report entities.
  if (clock?.filterRangeEmpty) {
    if (scope === "event") {
      return {
        kind: "observation",
        matchedVisitRelation: "scope_filter_matched_visits",
        matchedEventRelation: "scope_filter_matched_events",
        ctes: [
          boundCte(
            "scope_filter_matched_visits",
            `scope_filter_matched_visits AS (
              SELECT site_pk, visit_id FROM ${candidateVisits} WHERE 0)`,
          ),
          boundCte(
            "scope_filter_matched_events",
            `scope_filter_matched_events AS (
              SELECT site_pk, event_id FROM ${candidateEvents} WHERE 0)`,
          ),
        ],
      };
    }
    return {
      kind: "entity",
      entityKind: scope,
      qualifiedEntityRelation: "scope_filter_qualified_entities",
      ctes: [
        boundCte(
          "scope_filter_qualified_entities",
          `scope_filter_qualified_entities AS (
            SELECT site_pk, ${scope === "session" ? "session_id" : "visitor_id"} AS entity_id
            FROM ${candidateVisits} WHERE 0)`,
        ),
      ],
    };
  }
  const compiler = new SqlCollectionCompiler(
    {
      filterVisits,
      filterEvents,
      readVisits,
      readEvents,
      timelineVisits: sources.timelineVisits,
      timelineEvents: sources.timelineEvents,
      uniqueLocalOccurrences: sources.uniqueLocalOccurrences,
      uniqueGlobalOccurrences: sources.uniqueGlobalOccurrences,
      indexedGlobalTimelineVisits: sources.indexedGlobalTimelineVisits,
    },
    clock,
  );
  const ctes: BoundCteDefinition[] = [
    ...factCtes(filterVisits, filterEvents),
    timelineCte(
      safeQualificationIdentifier(sources.timelineVisits ?? readVisits),
      safeQualificationIdentifier(sources.timelineEvents ?? readEvents),
    ),
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
    ...compiler.globalSequenceCtes,
    boundCte(
      "scope_filter_qualified_entities",
      `scope_filter_qualified_entities AS ${compiler.globalSequenceCtes.length > 0 ? "MATERIALIZED " : ""}(
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
