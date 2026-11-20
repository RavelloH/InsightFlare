import type {
  FilterCondition,
  FilterValue,
} from "@/lib/filter-contract/filters";

import { safeQualificationIdentifier } from "./filter-qualification";
import { JSON_EACH_SET_THRESHOLD } from "./filter-sql-set";

export interface JsonPointerPredicateSql {
  readonly sql: string;
  readonly bindings: readonly (string | number)[];
}

/**
 * Decode *exact* RFC 6901 member tokens. The ingest path dictionary replaces
 * array subscripts with '*', so a path_id alone cannot identify '/items/0'.
 * Array steps are only canonical nonnegative decimal indices; for an Object
 * parent even '*' and '01' remain literal member names.
 */
export function jsonPointerSegments(
  pointer: string,
): readonly { readonly member: string; readonly arrayIndex: number | null }[] {
  if (pointer === "/") return [];
  if (!pointer.startsWith("/")) {
    throw new TypeError("Invalid JSON pointer: missing leading slash.");
  }
  return pointer
    .slice(1)
    .split("/")
    .map((token) => {
      if (/~(?![01])/.test(token)) {
        throw new TypeError("Invalid JSON pointer escape.");
      }
      const member = token.replace(/~1/g, "/").replace(/~0/g, "~");
      const index = /^(?:0|[1-9][0-9]*)$/.test(member) ? Number(member) : NaN;
      return {
        member,
        arrayIndex: Number.isSafeInteger(index) ? index : null,
      };
    });
}

function scalarType(value: FilterValue): number {
  if (value === null) return 0;
  if (typeof value === "string") return 1;
  if (typeof value === "number") return 2;
  return 3;
}

function scalarValue(value: FilterValue): string | number {
  if (typeof value === "boolean") return Number(value);
  if (typeof value === "number" || typeof value === "string") return value;
  throw new TypeError("Null has no typed SQL scalar column.");
}

function scalarColumn(type: number): string {
  if (type === 1) return "json_value.string_value";
  if (type === 2) return "json_value.number_value";
  if (type === 3) return "json_value.boolean_value";
  throw new TypeError("Expected a JSON scalar.");
}

function isValue(value: unknown): value is FilterValue {
  return (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean" ||
    (typeof value === "number" && Number.isFinite(value))
  );
}

/**
 * Returns a single correlated SQLite predicate. A recursive traversal walks
 * actual parent/child node IDs (and site-bound key IDs) rather than matching
 * the lossy normalized path dictionary.
 *
 * This has no imposed limits on the number of read rows or matching nodes.
 */
export function compileExactJsonPointerPredicate(
  condition: FilterCondition,
  eventAlias: string,
): JsonPointerPredicateSql {
  const target = condition.target;
  if (target.kind !== "event-payload" && target.kind !== "current-payload") {
    throw new TypeError("Expected an Event JSON payload target.");
  }
  const alias = safeQualificationIdentifier(eventAlias);
  const segments = jsonPointerSegments(target.path);
  const bindings: Array<string | number> = [
    JSON.stringify(segments),
    segments.length,
  ];
  const scalar = (input: unknown): FilterValue => {
    if (!isValue(input)) {
      throw new TypeError("Unsupported JSON payload comparison value.");
    }
    return input;
  };
  let test: string;
  const operator = condition.operator;
  const value = condition.value;

  if (operator === "exists" || operator === "notExists") {
    test = "1";
  } else if (operator === "isNull") {
    test = "resolved.value_type = 0";
  } else if (operator === "notNull") {
    test = "resolved.value_type != 0";
  } else if (operator === "isEmpty" || operator === "notEmpty") {
    const empty = `(
      (resolved.value_type = 1 AND json_value.string_value = '')
      OR (resolved.value_type IN (4, 5) AND NOT EXISTS (
        SELECT 1 FROM custom_event_json_nodes child
        WHERE child.event_pk = ${alias}.event_pk
          AND child.parent_node_id = resolved.node_id
      ))
    )`;
    test = operator === "isEmpty" ? empty : `NOT ${empty}`;
  } else if (operator === "in" || operator === "notIn") {
    if (!Array.isArray(value) || value.length === 0 || !value.every(isValue)) {
      throw new TypeError("Payload membership comparison needs scalar values.");
    }
    const values = value as readonly FilterValue[];
    const groups = new Map<number, FilterValue[]>();
    for (const item of values) {
      const kind = scalarType(item);
      const group = groups.get(kind) ?? [];
      group.push(item);
      groups.set(kind, group);
    }
    const matches: string[] = [];
    for (const [kind, group] of groups) {
      if (kind === 0) {
        matches.push("resolved.value_type = 0");
      } else {
        let set: string;
        if (group.length >= JSON_EACH_SET_THRESHOLD) {
          bindings.push(JSON.stringify(group.map(scalarValue)));
          set = "SELECT value FROM json_each(?)";
        } else {
          bindings.push(...group.map(scalarValue));
          set = group.map(() => "?").join(", ");
        }
        matches.push(
          `(resolved.value_type = ${kind} AND ${scalarColumn(kind)} IN (${set}))`,
        );
      }
    }
    const membership = `(${matches.join(" OR ")})`;
    // Missing is excluded by EXISTS; containers are not JSON scalar values.
    test =
      operator === "in"
        ? membership
        : `resolved.value_type IN (0, 1, 2, 3) AND NOT ${membership}`;
  } else if (operator === "between") {
    if (!Array.isArray(value) || value.length !== 2) {
      throw new TypeError("JSON BETWEEN requires two endpoints.");
    }
    const left = scalar(value[0]);
    const right = scalar(value[1]);
    const type = scalarType(left);
    if (type === 0 || type !== scalarType(right)) {
      throw new TypeError(
        "JSON BETWEEN endpoints require the same scalar type.",
      );
    }
    bindings.push(scalarValue(left), scalarValue(right));
    test = `resolved.value_type = ${type} AND ${scalarColumn(type)} BETWEEN ? AND ?`;
  } else if (
    operator === "contains" ||
    operator === "startsWith" ||
    operator === "endsWith"
  ) {
    const input = scalar(value);
    if (typeof input !== "string") {
      throw new TypeError("String comparison requires a string.");
    }
    if (operator === "contains") {
      bindings.push(input);
      test =
        "resolved.value_type = 1 AND INSTR(json_value.string_value, ?) > 0";
    } else if (operator === "startsWith") {
      bindings.push(input, input);
      test =
        "resolved.value_type = 1 AND SUBSTR(json_value.string_value, 1, LENGTH(?)) = ?";
    } else {
      bindings.push(input, input, input);
      test =
        "resolved.value_type = 1 AND (LENGTH(?) = 0 OR SUBSTR(json_value.string_value, -LENGTH(?)) = ?)";
    }
  } else {
    const input = scalar(value);
    const type = scalarType(input);
    const sqlOperator: Record<string, string> = {
      eq: "=",
      neq: "!=",
      gt: ">",
      gte: ">=",
      lt: "<",
      lte: "<=",
    };
    const symbol = sqlOperator[operator];
    if (!symbol) throw new TypeError(`Unsupported JSON operator: ${operator}`);
    if (type === 0) {
      test = `resolved.value_type ${symbol} 0`;
    } else if (operator === "neq") {
      // A present, non-null JSON scalar of another type is unequal even if
      // its typed value column is NULL. Explicit Null, containers and Missing
      // remain outside the non-null scalar comparison domain.
      bindings.push(scalarValue(input));
      test = `resolved.value_type IN (1, 2, 3) AND
        (resolved.value_type != ${type} OR ${scalarColumn(type)} != ?)`;
    } else {
      bindings.push(scalarValue(input));
      test = `resolved.value_type = ${type} AND ${scalarColumn(type)} ${symbol} ?`;
    }
  }

  const exists = `EXISTS (
    WITH RECURSIVE pointer_nodes(node_id, depth, value_type) AS (
      SELECT root.node_id, 0, root.value_type
      FROM custom_event_json_nodes root
      WHERE root.event_pk = ${alias}.event_pk AND root.parent_node_id IS NULL
      UNION ALL
      SELECT child.node_id, parent.depth + 1, child.value_type
      FROM pointer_nodes parent
      INNER JOIN json_each(?) segment
        ON CAST(segment.key AS INTEGER) = parent.depth
      INNER JOIN custom_event_json_nodes child
        ON child.event_pk = ${alias}.event_pk
       AND child.parent_node_id = parent.node_id
      LEFT JOIN custom_event_json_keys key_name
        ON key_name.id = child.key_id
       AND key_name.site_pk = ${alias}.site_pk
      WHERE (
        parent.value_type = 4
        AND key_name.key = json_extract(segment.value, '$.member')
      ) OR (
        parent.value_type = 5
        AND child.array_index = json_extract(segment.value, '$.arrayIndex')
      )
    )
    SELECT 1
    FROM pointer_nodes resolved
    LEFT JOIN custom_event_json_values json_value
      ON json_value.event_pk = ${alias}.event_pk
     AND json_value.node_id = resolved.node_id
     AND json_value.site_pk = ${alias}.site_pk
    WHERE resolved.depth = ?
      AND ${test}
  )`;

  return {
    sql: operator === "notExists" ? `NOT ${exists}` : exists,
    bindings,
  };
}
