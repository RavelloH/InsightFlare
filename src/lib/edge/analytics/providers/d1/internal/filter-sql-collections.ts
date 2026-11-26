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

  private condition(
    condition: FilterCondition,
    frame: SqlFrame,
  ): PredicateFragment {
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
    { filterVisits, filterEvents, readVisits, readEvents },
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
