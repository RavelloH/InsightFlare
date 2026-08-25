import type { Env } from "@/lib/edge/types";

import type {
  EventFieldRow,
  EventFieldValueRow,
  FilterDocument,
  QueryWindow,
} from "./core";
import {
  buildEventFilteredSourceCte,
  customEventJsonTypeCode,
  queryD1All,
} from "./core";

export async function queryEventFieldsFromD1(
  env: Env,
  siteId: string,
  window: QueryWindow,
  filters: FilterDocument,
  eventName: string,
  limit: number,
): Promise<EventFieldRow[]> {
  const source = buildEventFilteredSourceCte(
    siteId,
    window,
    filters,
    eventName,
  );
  const sql = `
${source.cte},
field_rows AS (
  SELECT
    p.path,
    v.value_type AS valueType,
    v.event_pk,
    v.occurred_at,
    v.string_value AS stringValue,
    v.number_value AS numberValue,
    v.boolean_value AS booleanValue
  FROM custom_event_json_values v
  INNER JOIN custom_event_json_paths p
    ON p.id = v.path_id
  INNER JOIN filtered_events fe
    ON fe.event_pk = v.event_pk
)
SELECT
  path,
  valueType,
  count(DISTINCT event_pk) AS events,
  count(*) AS occurrences,
  MIN(occurred_at) AS firstSeenAt,
  MAX(occurred_at) AS lastSeenAt,
  MIN(stringValue) AS stringValue,
  MIN(numberValue) AS numberValue,
  MIN(booleanValue) AS booleanValue
FROM field_rows
GROUP BY path, valueType
ORDER BY events DESC, occurrences DESC, path ASC
LIMIT ?
  `;
  return queryD1All<EventFieldRow>(env, sql, [...source.bindings, limit]);
}

export async function queryEventFieldValuesFromD1(
  env: Env,
  siteId: string,
  window: QueryWindow,
  filters: FilterDocument,
  eventName: string,
  fieldPath: string,
  fieldValueType: string,
  limit: number,
  search?: string,
): Promise<EventFieldValueRow[]> {
  const source = buildEventFilteredSourceCte(
    siteId,
    window,
    filters,
    eventName,
  );
  const valueTypeCode = customEventJsonTypeCode(fieldValueType);
  if (valueTypeCode === null) return [];
  const normalizedSearch = search?.trim().toLowerCase();
  const searchExpression =
    valueTypeCode === 1
      ? "v.string_value"
      : valueTypeCode === 2
        ? "CAST(v.number_value AS TEXT)"
        : valueTypeCode === 3
          ? "CASE v.boolean_value WHEN 1 THEN 'true' ELSE 'false' END"
          : "''";
  const searchPattern = normalizedSearch
    ? `%${normalizedSearch.replaceAll("\\", "\\\\").replaceAll("%", "\\%").replaceAll("_", "\\_")}%`
    : null;
  const sql = `
${source.cte},
field_rows AS (
  SELECT
    v.value_type AS valueType,
    v.event_pk,
    v.occurred_at,
    v.string_value AS stringValue,
    v.number_value AS numberValue,
    v.boolean_value AS booleanValue
  FROM custom_event_json_values v
  INNER JOIN custom_event_json_paths p
    ON p.id = v.path_id
  INNER JOIN filtered_events fe
    ON fe.event_pk = v.event_pk
  WHERE p.path = ? AND v.value_type = ?
  ${searchPattern ? `AND LOWER(TRIM(COALESCE(${searchExpression}, ''))) LIKE ? ESCAPE '\\'` : ""}
)
SELECT
  valueType,
  count(DISTINCT event_pk) AS events,
  count(*) AS occurrences,
  MIN(occurred_at) AS firstSeenAt,
  MAX(occurred_at) AS lastSeenAt,
  MIN(stringValue) AS stringValue,
  MIN(numberValue) AS numberValue,
  MIN(booleanValue) AS booleanValue
FROM field_rows
GROUP BY valueType, stringValue, numberValue, booleanValue
ORDER BY occurrences DESC, events DESC, stringValue ASC, numberValue ASC, booleanValue ASC
LIMIT ?
  `;
  return queryD1All<EventFieldValueRow>(env, sql, [
    ...source.bindings,
    fieldPath,
    valueTypeCode,
    ...(searchPattern ? [searchPattern] : []),
    limit,
  ]);
}
