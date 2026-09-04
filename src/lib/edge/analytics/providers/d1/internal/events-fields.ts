import {
  analyticsFilterRegistry,
  filterFingerprint,
  type QueryAudience,
} from "@/lib/edge/analytics/contract";
import type { Env } from "@/lib/edge/types";

import type {
  EventFieldRow,
  EventFieldValueRow,
  FilterDocument,
  QueryWindow,
} from "./core";
import {
  decodePageCursor,
  encodePageCursor,
  type PageResult,
  pageResult,
  paginationBinding,
} from "./pagination";

export interface EventFieldCursor {
  readonly events: number;
  readonly occurrences: number;
  readonly path: string;
  readonly valueType: string;
}

export interface EventFieldValueCursor {
  readonly occurrences: number;
  readonly events: number;
  readonly stringValue: string;
  readonly numberValue: number;
  readonly booleanValue: number;
}

function eventFieldBinding(
  operation: string,
  siteId: string,
  window: QueryWindow,
  filters: FilterDocument,
  eventName?: string,
  fieldPath?: string,
  fieldValueType?: string,
  search?: string,
  audience: QueryAudience = "private-dashboard",
): Promise<string> {
  return paginationBinding([
    `analytics-${operation}-v1`,
    audience,
    siteId,
    window.startMs,
    window.endExclusiveMs,
    window.timeZone,
    filterFingerprint(filters, analyticsFilterRegistry),
    eventName ?? "",
    fieldPath ?? "",
    fieldValueType ?? "",
    search?.trim().toLowerCase() ?? "",
  ]);
}
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
  eventName: string | undefined,
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

export async function queryEventFieldsPageFromD1(
  env: Env,
  siteId: string,
  window: QueryWindow,
  filters: FilterDocument,
  eventName: string | undefined,
  limit: number,
  cursor?: EventFieldCursor | null,
  audience: QueryAudience = "private-dashboard",
): Promise<PageResult<EventFieldRow>> {
  const source = buildEventFilteredSourceCte(
    siteId,
    window,
    filters,
    eventName,
  );
  const cursorClause = cursor
    ? `
WHERE events < ?
   OR (events = ? AND occurrences < ?)
   OR (events = ? AND occurrences = ? AND path > ?)
   OR (events = ? AND occurrences = ? AND path = ? AND valueType > ?)`
    : "";
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
  INNER JOIN custom_event_json_paths p ON p.id = v.path_id
  INNER JOIN filtered_events fe ON fe.event_pk = v.event_pk
),
rollup AS (
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
)
SELECT path, valueType, events, occurrences, firstSeenAt, lastSeenAt,
  stringValue, numberValue, booleanValue
FROM rollup
${cursorClause}
ORDER BY events DESC, occurrences DESC, path ASC, valueType ASC
LIMIT ?
`;
  const cursorBindings = cursor
    ? [
        cursor.events,
        cursor.events,
        cursor.occurrences,
        cursor.events,
        cursor.occurrences,
        cursor.path,
        cursor.events,
        cursor.occurrences,
        cursor.path,
        cursor.valueType,
      ]
    : [];
  const rows = await queryD1All<EventFieldRow>(env, sql, [
    ...source.bindings,
    ...cursorBindings,
    limit + 1,
  ]);
  const page = pageResult(rows, limit);
  const binding = await eventFieldBinding(
    "event-fields",
    siteId,
    window,
    filters,
    eventName,
    undefined,
    undefined,
    undefined,
    audience,
  );
  const nextCursor =
    page.hasMore && page.last
      ? await encodePageCursor(env, binding, {
          events: Number(page.last.events),
          occurrences: Number(page.last.occurrences),
          path: page.last.path,
          valueType: page.last.valueType,
        })
      : null;
  return {
    items: page.rows,
    pagination: {
      limit,
      returned: page.rows.length,
      hasMore: page.hasMore,
      nextCursor,
    },
  };
}

export async function decodeEventFieldCursor(
  env: Env,
  siteId: string,
  window: QueryWindow,
  filters: FilterDocument,
  eventName?: string,
  cursor?: string | null,
  audience: QueryAudience = "private-dashboard",
): Promise<EventFieldCursor | null> {
  return decodePageCursor<EventFieldCursor>(
    env,
    await eventFieldBinding(
      "event-fields",
      siteId,
      window,
      filters,
      eventName,
      undefined,
      undefined,
      undefined,
      audience,
    ),
    cursor,
  );
}

export async function queryEventFieldValuesFromD1(
  env: Env,
  siteId: string,
  window: QueryWindow,
  filters: FilterDocument,
  eventName: string | undefined,
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

export async function queryEventFieldValuesPageFromD1(
  env: Env,
  siteId: string,
  window: QueryWindow,
  filters: FilterDocument,
  eventName: string | undefined,
  fieldPath: string,
  fieldValueType: string,
  limit: number,
  search?: string,
  cursor?: EventFieldValueCursor | null,
  audience: QueryAudience = "private-dashboard",
): Promise<PageResult<EventFieldValueRow>> {
  const source = buildEventFilteredSourceCte(
    siteId,
    window,
    filters,
    eventName,
  );
  const valueTypeCode = customEventJsonTypeCode(fieldValueType);
  if (valueTypeCode === null) {
    return {
      items: [],
      pagination: { limit, returned: 0, hasMore: false, nextCursor: null },
    };
  }
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
  const cursorClause = cursor
    ? `
AND (
  occurrences < ?
  OR (occurrences = ? AND events < ?)
  OR (occurrences = ? AND events = ? AND valueString > ?)
  OR (occurrences = ? AND events = ? AND valueString = ? AND valueNumber > ?)
  OR (occurrences = ? AND events = ? AND valueString = ? AND valueNumber = ? AND valueBoolean > ?)
)`
    : "";
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
  INNER JOIN custom_event_json_paths p ON p.id = v.path_id
  INNER JOIN filtered_events fe ON fe.event_pk = v.event_pk
  WHERE p.path = ? AND v.value_type = ?
  ${searchPattern ? `AND LOWER(TRIM(COALESCE(${searchExpression}, ''))) LIKE ? ESCAPE '\\'` : ""}
),
rollup AS (
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
)
SELECT valueType, events, occurrences, firstSeenAt, lastSeenAt,
  stringValue, numberValue, booleanValue,
  COALESCE(stringValue, '') AS valueString,
  COALESCE(numberValue, -9223372036854775808) AS valueNumber,
  COALESCE(booleanValue, -1) AS valueBoolean
FROM rollup
WHERE 1 = 1
${cursorClause}
ORDER BY occurrences DESC, events DESC, valueString ASC, valueNumber ASC, valueBoolean ASC
LIMIT ?
`;
  const cursorBindings = cursor
    ? [
        cursor.occurrences,
        cursor.occurrences,
        cursor.events,
        cursor.occurrences,
        cursor.events,
        cursor.stringValue,
        cursor.occurrences,
        cursor.events,
        cursor.stringValue,
        cursor.numberValue,
        cursor.occurrences,
        cursor.events,
        cursor.stringValue,
        cursor.numberValue,
        cursor.booleanValue,
      ]
    : [];
  const rows = await queryD1All<EventFieldValueRow>(env, sql, [
    ...source.bindings,
    fieldPath,
    valueTypeCode,
    ...(searchPattern ? [searchPattern] : []),
    ...cursorBindings,
    limit + 1,
  ]);
  const page = pageResult(rows, limit);
  const binding = await eventFieldBinding(
    "event-field-values",
    siteId,
    window,
    filters,
    eventName,
    fieldPath,
    fieldValueType,
    search,
    audience,
  );
  const nextCursor =
    page.hasMore && page.last
      ? await encodePageCursor(env, binding, {
          occurrences: Number(page.last.occurrences),
          events: Number(page.last.events),
          stringValue: String(page.last.stringValue ?? ""),
          numberValue: Number(page.last.numberValue ?? -9223372036854775808),
          booleanValue: Number(page.last.booleanValue ?? -1),
        })
      : null;
  return {
    items: page.rows,
    pagination: {
      limit,
      returned: page.rows.length,
      hasMore: page.hasMore,
      nextCursor,
    },
  };
}

export async function decodeEventFieldValueCursor(
  env: Env,
  siteId: string,
  window: QueryWindow,
  filters: FilterDocument,
  eventName: string | undefined,
  fieldPath: string,
  fieldValueType: string,
  search?: string,
  cursor?: string | null,
  audience: QueryAudience = "private-dashboard",
): Promise<EventFieldValueCursor | null> {
  return decodePageCursor<EventFieldValueCursor>(
    env,
    await eventFieldBinding(
      "event-field-values",
      siteId,
      window,
      filters,
      eventName,
      fieldPath,
      fieldValueType,
      search,
      audience,
    ),
    cursor,
  );
}
