import { addZonedInterval } from "@/lib/analytics/time-zone";
import { resolveEntityMember } from "@/lib/filter-contract/filter-members";
import { analyticsFilterRegistry } from "@/lib/filter-contract/filter-registry";
import type {
  FilterDurationTarget,
  FilterTargetExpression,
  FilterTimeAnchorTarget,
} from "@/lib/filter-contract/filters";

import { compileRegisteredFieldScalar } from "./filter-compiler";
import { compileJsonPointerValue } from "./filter-json-pointer-value";
import { sqlCalendarPeriods } from "./filter-sql-calendar";

type ScalarCollectionKind =
  "page" | "event" | "session" | "visitor" | "period" | "sequence";
export interface SqlScalarCollection {
  readonly sql: string;
  readonly bindings: readonly (string | number | null)[];
  readonly entityKind: ScalarCollectionKind;
}
export interface SqlScalarRef {
  readonly sql: string;
  readonly bindings: readonly (string | number | null)[];
  /** SQL NULL denotes Missing for the supported registered-field projection. */
  readonly type: "number" | "string" | "boolean" | "date" | "unknown";
}

export type ScalarCollectionCompiler = (
  target: FilterTargetExpression,
) => SqlScalarCollection;

function fieldProjection(
  kind: ScalarCollectionKind,
  member: string,
  alias: string,
): { readonly sql: string; readonly type: SqlScalarRef["type"] } {
  if (kind === "period" || kind === "sequence") {
    throw new TypeError(
      "Scalar Projection needs a registered Page/Event/Entity member.",
    );
  }
  const resolved = resolveEntityMember(kind, member, analyticsFilterRegistry);
  if (!resolved) {
    throw new TypeError(`No registered scalar member ${kind}.${member}.`);
  }
  const type = resolved.definition.valueKind;
  return {
    sql: compileRegisteredFieldScalar(resolved.fieldId, alias),
    type:
      type === "number"
        ? "number"
        : type === "boolean"
          ? "boolean"
          : type === "date" || type === "datetime"
            ? "date"
            : "string",
  };
}

interface ProjectedScalarRows {
  readonly sql: string;
  readonly bindings: readonly (string | number | null)[];
  readonly type: SqlScalarRef["type"];
  readonly payload: boolean;
}

function projectedScalarRows(
  projection: Extract<FilterTargetExpression, { kind: "projection" }>,
  compileCollection: ScalarCollectionCompiler,
): ProjectedScalarRows {
  const collection = compileCollection(projection.collection);
  const payload = projection.member === "payload";
  if (payload && (collection.entityKind !== "event" || !projection.path)) {
    throw new TypeError(
      "Payload Projection must select an Event JSON pointer.",
    );
  }
  const alias = "projection_item";
  const json = payload
    ? compileJsonPointerValue(alias, projection.path!)
    : null;
  const field = json
    ? null
    : fieldProjection(collection.entityKind, projection.member, alias);
  const time =
    collection.entityKind === "page"
      ? `${alias}.started_at`
      : collection.entityKind === "event"
        ? `${alias}.occurred_at`
        : "0";
  const id =
    collection.entityKind === "page"
      ? `${alias}.visit_id`
      : collection.entityKind === "event"
        ? `${alias}.event_id`
        : collection.entityKind === "session"
          ? `${alias}.session_id`
          : collection.entityKind === "visitor"
            ? `${alias}.visitor_id`
            : null;
  if (!id)
    throw new TypeError("Scalar Projection requires an entity collection.");
  return {
    sql: `SELECT ${json?.sql ?? field!.sql} AS projected,
      ${time} AS sort_time, ${id} AS sort_id
      FROM (${collection.sql}) ${alias}`,
    bindings: [...(json?.bindings ?? []), ...collection.bindings],
    type: field?.type ?? "unknown",
    payload,
  };
}

function memberPath(target: FilterTargetExpression): {
  readonly root: FilterTargetExpression;
  readonly member: string;
} {
  const parts: string[] = [];
  let root = target;
  while (root.kind === "member") {
    parts.unshift(root.member);
    root = root.object;
  }
  return { root, member: parts.join(".") };
}

function orderedItems(
  collection: SqlScalarCollection,
  direction: "first" | "last" | "nth",
  index: number | undefined,
  projection: string,
): SqlScalarRef {
  const alias = "ordered_item";
  const time =
    collection.entityKind === "event"
      ? `${alias}.occurred_at`
      : collection.entityKind === "page"
        ? `${alias}.started_at`
        : collection.entityKind === "period"
          ? `${alias}.period_start`
          : collection.entityKind === "sequence"
            ? `${alias}.start_ms`
            : null;
  const id =
    collection.entityKind === "event"
      ? "event_id"
      : collection.entityKind === "page"
        ? "visit_id"
        : collection.entityKind === "period"
          ? "period_start"
          : collection.entityKind === "sequence"
            ? "sequence_positions"
            : collection.entityKind === "session"
              ? "session_id"
              : "visitor_id";
  const order = direction === "last" ? "DESC" : "ASC";
  const offset = direction === "nth" ? (index ?? 1) - 1 : 0;
  if (!Number.isSafeInteger(offset) || offset < 0) {
    throw new TypeError("nth index must be a positive safe integer.");
  }
  return {
    sql: `(SELECT ${projection} FROM (${collection.sql}) ${alias}
      ORDER BY ${time ? `${time} ${order},` : ""}
        ${alias}.${id} COLLATE BINARY ${order} LIMIT 1 OFFSET ${offset})`,
    bindings: collection.bindings,
    type: "unknown",
  };
}

export function durationMilliseconds(target: FilterDurationTarget): number {
  const multiplier: Record<string, number> = {
    ms: 1,
    s: 1_000,
    m: 60_000,
    h: 3_600_000,
    d: 86_400_000,
    w: 604_800_000,
  };
  const factor = multiplier[target.unit];
  if (!factor) {
    throw new TypeError(
      "Calendar month/year requires a timezone-aware interval.",
    );
  }
  const result = target.amount * factor;
  if (!Number.isFinite(result)) throw new TypeError("Invalid duration.");
  return result;
}

export interface SqlScalarTimeContext {
  readonly nowMs: number;
  readonly rangeStartMs: number;
  readonly rangeEndExclusiveMs: number;
  readonly timeZone: string;
}

/** Convert relative temporal literals once per query; never read activity in JS. */
export function boundTimeAnchorMs(
  target: FilterTimeAnchorTarget,
  clock?: SqlScalarTimeContext,
): number {
  if (!clock)
    throw new TypeError("Time anchor requires explicit query time context.");
  const base =
    target.anchor === "now"
      ? clock.nowMs
      : target.anchor === "range.start"
        ? clock.rangeStartMs
        : clock.rangeEndExclusiveMs;
  if (!target.offset) return base;
  const offset = target.offset;
  if (!["mo", "y"].includes(offset.unit)) {
    return base + durationMilliseconds(offset);
  }
  return addZonedInterval(
    base,
    "month",
    clock.timeZone,
    offset.amount * (offset.unit === "y" ? 12 : 1),
  );
}

/**
 * Compile local scalar/reducer targets over SQL collections, without a
 * general Query IR. Physical occurrence ordering is stable by time and
 * binary identifier, never by JS localeCompare.
 */
export function compileSqlScalar(
  target: FilterTargetExpression,
  compileCollection: ScalarCollectionCompiler,
  clock?: SqlScalarTimeContext,
): SqlScalarRef {
  if (target.kind === "time-anchor") {
    return {
      sql: "?",
      bindings: [boundTimeAnchorMs(target, clock)],
      type: "date",
    };
  }
  if (target.kind === "duration") {
    return {
      sql: "?",
      bindings: [durationMilliseconds(target)],
      type: "number",
    };
  }
  if (target.kind === "member") {
    const { root, member } = memberPath(target);
    if (
      root.kind === "reducer" &&
      (root.reducer === "first" ||
        root.reducer === "last" ||
        root.reducer === "nth")
    ) {
      const collection = compileCollection(root.input);
      const field = fieldProjection(
        collection.entityKind,
        member,
        "ordered_item",
      );
      const ordered = orderedItems(
        collection,
        root.reducer,
        root.index,
        field.sql,
      );
      return { ...ordered, type: field.type };
    }
    throw new TypeError(`SQL scalar member not yet supported: ${root.kind}`);
  }
  if (target.kind === "occurrence-time") {
    const inner = target.input;
    if (
      inner.kind !== "reducer" ||
      !["first", "last", "nth"].includes(inner.reducer)
    ) {
      throw new TypeError("Occurrence-time SQL requires an ordered reducer.");
    }
    const collection = compileCollection(inner.input);
    const column =
      collection.entityKind === "event"
        ? "ordered_item.occurred_at"
        : collection.entityKind === "page"
          ? "ordered_item.started_at"
          : null;
    if (!column) throw new TypeError("Non-occurrence timestamp is undefined.");
    return {
      ...orderedItems(
        collection,
        inner.reducer as "first" | "last" | "nth",
        inner.index,
        column,
      ),
      type: "date",
    };
  }
  if (target.kind === "reducer") {
    if (
      target.input.kind === "projection" &&
      ["count", "first", "last", "nth"].includes(target.reducer)
    ) {
      const projected = projectedScalarRows(target.input, compileCollection);
      const rows = `(${projected.sql}) projected_items`;
      if (target.reducer === "count") {
        return {
          sql: `(SELECT COUNT(projected) FROM ${rows})`,
          bindings: projected.bindings,
          type: "number",
        };
      }
      const direction = target.reducer === "last" ? "DESC" : "ASC";
      const index = target.reducer === "nth" ? (target.index ?? 1) - 1 : 0;
      if (!Number.isSafeInteger(index) || index < 0) {
        throw new TypeError("Invalid nth projected item index.");
      }
      const value = projected.payload
        ? "json_extract(projected, '$.v')"
        : "projected";
      return {
        sql: `(SELECT ${value}
          FROM ${rows}
          WHERE projected IS NOT NULL
          ORDER BY sort_time ${direction}, sort_id COLLATE BINARY ${direction}
          LIMIT 1 OFFSET ${index})`,
        bindings: projected.bindings,
        type: projected.type,
      };
    }
    if (target.input.kind === "bucket") {
      if (!clock)
        throw new TypeError(
          "Bucket needs the requested IANA time zone and range.",
        );
      const bucket = target.input;
      const source = compileCollection(bucket.input);
      if (source.entityKind !== "page" && source.entityKind !== "event") {
        throw new TypeError("Bucket input requires Page or Event occurrences.");
      }
      const timeline = sqlCalendarPeriods(bucket.interval, clock);
      const time =
        source.entityKind === "page"
          ? "bucket_item.started_at"
          : "bucket_item.occurred_at";
      const label = `(SELECT json_extract(period.value, '$.start')
        FROM json_each(?) period
        WHERE ${time} >= json_extract(period.value, '$.start')
          AND ${time} < json_extract(period.value, '$.end')
        LIMIT 1)`;
      const rows = `(SELECT ${label} AS bucket_label FROM (${source.sql}) bucket_item)`;
      const bindings = [JSON.stringify(timeline), ...source.bindings];
      if (target.reducer === "countDistinct") {
        return {
          sql: `(SELECT COUNT(DISTINCT bucket_label) FROM ${rows})`,
          bindings,
          type: "number",
        };
      }
      if (target.reducer === "count") {
        return {
          sql: `(SELECT COUNT(*) FROM ${rows} WHERE bucket_label IS NOT NULL)`,
          bindings,
          type: "number",
        };
      }
      throw new TypeError(
        "Bucket only supports Count and CountDistinct reducers.",
      );
    }
    if (
      target.reducer === "first" ||
      target.reducer === "last" ||
      target.reducer === "nth"
    ) {
      const collection = compileCollection(target.input);
      const projection =
        collection.entityKind === "event"
          ? "ordered_item.occurred_at"
          : collection.entityKind === "page"
            ? "ordered_item.started_at"
            : collection.entityKind === "period"
              ? "ordered_item.period_start"
              : collection.entityKind === "sequence"
                ? "ordered_item.start_ms"
                : collection.entityKind === "session"
                  ? "ordered_item.session_id"
                  : collection.entityKind === "visitor"
                    ? "ordered_item.visitor_id"
                    : null;
      if (!projection)
        throw new TypeError("Ordered SQL entity must have an identity.");
      return {
        ...orderedItems(collection, target.reducer, target.index, projection),
        type: "date",
      };
    }
    if (target.reducer === "count") {
      const collection = compileCollection(target.input);
      return {
        sql: `(SELECT COUNT(*) FROM (${collection.sql}) scalar_items)`,
        bindings: collection.bindings,
        type: "number",
      };
    }
    if (
      ["sum", "avg", "min", "max", "countDistinct"].includes(target.reducer)
    ) {
      const projection = target.input;
      if (projection.kind !== "projection") {
        throw new TypeError("Aggregate SQL requires a typed Projection.");
      }
      const collection = compileCollection(projection.collection);
      const payload = projection.member === "payload";
      if (payload && (collection.entityKind !== "event" || !projection.path)) {
        throw new TypeError(
          "Typed Payload Projection requires an Event and an exact JSON pointer.",
        );
      }
      const json = payload
        ? compileJsonPointerValue("source_item", projection.path!)
        : null;
      const field = json
        ? null
        : fieldProjection(
            collection.entityKind,
            projection.member,
            "source_item",
          );
      // SQL placeholders in the SELECT projection precede placeholders
      // inside the FROM collection; keep positional bindings in text order.
      const source = `(
        SELECT ${json?.sql ?? field!.sql} AS projected
        FROM (${collection.sql}) source_item
      )`;
      const bindings = [...(json?.bindings ?? []), ...collection.bindings];
      const value = json ? "json_extract(projected, '$.v')" : "projected";
      const jsonType = "json_extract(projected, '$.t')";
      let expression: string;
      if (target.reducer === "countDistinct") {
        // JSON text includes explicit type tags. Number 1, string "1",
        // boolean true and JSON null have distinct typed encodings.
        expression = `(SELECT COUNT(DISTINCT projected) FROM ${source})`;
      } else if (target.reducer === "sum" || target.reducer === "avg") {
        if (!json && field!.type !== "number") {
          throw new TypeError("sum/avg require numeric Projection values.");
        }
        const numeric = json
          ? `CASE WHEN ${jsonType} = 2 THEN ${value} END`
          : value;
        expression = `(SELECT ${target.reducer === "sum" ? "COALESCE(SUM" : "AVG"}(${numeric})${target.reducer === "sum" ? ", 0)" : ""} FROM ${source})`;
      } else {
        // Ignore Missing and explicit JSON null. SQLite BINARY collation
        // defines deterministic text ordering without JS localeCompare.
        if (json) {
          expression = `(SELECT ${value} FROM ${source}
            WHERE ${jsonType} IN (1, 2, 3)
            ORDER BY ${jsonType} ${target.reducer === "min" ? "ASC" : "DESC"},
              ${value} COLLATE BINARY ${target.reducer === "min" ? "ASC" : "DESC"}
            LIMIT 1)`;
        } else {
          expression = `(SELECT ${target.reducer === "min" ? "MIN" : "MAX"}(${value})
            FROM ${source})`;
        }
      }
      return {
        sql: expression,
        bindings,
        type:
          target.reducer === "sum" ||
          target.reducer === "avg" ||
          target.reducer === "countDistinct"
            ? "number"
            : json
              ? "unknown"
              : field!.type,
      };
    }
    throw new TypeError(`Unsupported SQL scalar reducer: ${target.reducer}.`);
  }
  if (target.kind === "arithmetic") {
    const left = compileSqlScalar(target.left, compileCollection, clock);
    const right = compileSqlScalar(target.right, compileCollection, clock);
    if (left.type !== "number" || right.type !== "number") {
      throw new TypeError("Arithmetic requires numeric SQL Scalars.");
    }
    const symbols: Record<string, string> = {
      add: "+",
      sub: "-",
      mul: "*",
      div: "/",
    };
    const leftSql = `(${left.sql})`;
    const rightSql = `(${right.sql})`;
    // SQL NULL on division by zero is the documented typed Missing value.
    const sql = `(${leftSql} ${symbols[target.operator]} ${rightSql})`;
    return {
      sql,
      bindings: [...left.bindings, ...right.bindings],
      type: "number",
    };
  }
  throw new TypeError(`SQL scalar target not yet implemented: ${target.kind}.`);
}
