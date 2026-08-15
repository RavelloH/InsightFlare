import type { Env } from "@/lib/edge/types";

import type {
  DashboardFilters,
  EventFieldRow,
  EventFieldValueRow,
  QueryWindow,
} from "./core";
import {
  buildEventAnalyticsSourceCte,
  buildEventFilterSql,
  customEventJsonTypeCode,
  eventSourceBindings,
  queryD1All,
} from "./core";

export async function queryEventFieldsFromD1(
  env: Env,
  siteId: string,
  window: QueryWindow,
  filters: DashboardFilters,
  eventName: string,
  limit: number,
): Promise<EventFieldRow[]> {
  const filter = buildEventFilterSql(filters, "es");
  const sql = `
WITH
${buildEventAnalyticsSourceCte({ eventName })},
filtered_events AS (
  SELECT *
  FROM event_source es
  ${filter.clause}
),
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
  return queryD1All<EventFieldRow>(env, sql, [
    ...eventSourceBindings(siteId, window, eventName),
    ...filter.bindings,
    limit,
  ]);
}

export async function queryEventFieldValuesFromD1(
  env: Env,
  siteId: string,
  window: QueryWindow,
  filters: DashboardFilters,
  eventName: string,
  fieldPath: string,
  fieldValueType: string,
  limit: number,
): Promise<EventFieldValueRow[]> {
  const filter = buildEventFilterSql(filters, "es");
  const valueTypeCode = customEventJsonTypeCode(fieldValueType);
  if (valueTypeCode === null) return [];
  const sql = `
WITH
${buildEventAnalyticsSourceCte({ eventName })},
filtered_events AS (
  SELECT *
  FROM event_source es
  ${filter.clause}
),
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
    ...eventSourceBindings(siteId, window, eventName),
    ...filter.bindings,
    fieldPath,
    valueTypeCode,
    limit,
  ]);
}
