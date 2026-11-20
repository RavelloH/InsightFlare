import { jsonPointerSegments } from "./filter-json-pointer";
import { safeQualificationIdentifier } from "./filter-qualification";

/** Encoded, typed JSON scalar: SQL NULL means Missing; {"t":0} is JSON null. */
export interface SqlJsonValueRef {
  readonly sql: string;
  readonly bindings: readonly (string | number)[];
}

/**
 * Fetch one exact JSON pointer node. No normalized path dictionary lookup:
 * arrays must use numeric indexes and object members use their literal keys.
 * Stored JSON container nodes also have a value_type and are not Missing.
 */
export function compileJsonPointerValue(
  eventAlias: string,
  pointer: string,
): SqlJsonValueRef {
  const alias = safeQualificationIdentifier(eventAlias);
  const segments = jsonPointerSegments(pointer);
  return {
    sql: `(WITH RECURSIVE pointer_nodes(node_id, depth, value_type) AS (
      SELECT root.node_id, 0, root.value_type
      FROM custom_event_json_nodes root
      WHERE root.event_pk = ${alias}.event_pk AND root.parent_node_id IS NULL
      UNION ALL
      SELECT child.node_id, parent.depth + 1, child.value_type
      FROM pointer_nodes parent
      INNER JOIN json_each(?) segment ON CAST(segment.key AS INTEGER) = parent.depth
      INNER JOIN custom_event_json_nodes child
        ON child.event_pk = ${alias}.event_pk AND child.parent_node_id = parent.node_id
      LEFT JOIN custom_event_json_keys key_name
        ON key_name.id = child.key_id AND key_name.site_pk = ${alias}.site_pk
      WHERE (parent.value_type = 4 AND key_name.key = json_extract(segment.value, '$.member'))
         OR (parent.value_type = 5 AND child.array_index = json_extract(segment.value, '$.arrayIndex'))
    )
    SELECT json_object('t', resolved.value_type,
      'v', CASE resolved.value_type
        WHEN 1 THEN json_value.string_value
        WHEN 2 THEN json_value.number_value
        WHEN 3 THEN json_value.boolean_value
        ELSE NULL END
    )
    FROM pointer_nodes resolved
    LEFT JOIN custom_event_json_values json_value
      ON json_value.event_pk = ${alias}.event_pk
     AND json_value.node_id = resolved.node_id
     AND json_value.site_pk = ${alias}.site_pk
    WHERE resolved.depth = ? LIMIT 1)`,
    bindings: [JSON.stringify(segments), segments.length],
  };
}
