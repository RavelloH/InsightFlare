import {
  analyticsFilterRegistry,
  effectiveScopeForPagination,
  filterFingerprint,
  type QueryAudience,
  scopedFilterMetadata,
} from "@/lib/edge/analytics/contract";
import { queryWindowToTime } from "@/lib/edge/analytics/contract/helpers";
import {
  buildEventFieldValuesPagePlan,
  buildEventFieldValuesPlan,
  EVENT_FIELD_VALUES_OUTPUT,
  EVENT_FIELD_VALUES_PAGE_OUTPUT,
} from "@/lib/edge/analytics/engine/event-field-values-plan";
import {
  buildEventFieldsPagePlan,
  buildEventFieldsPlan,
  EVENT_FIELDS_OUTPUT,
  EVENT_FIELDS_PAGE_OUTPUT,
} from "@/lib/edge/analytics/engine/event-fields-plan";
import { buildEventPayloadReportSource } from "@/lib/edge/analytics/engine/event-payload-report-source";
import type { Env } from "@/lib/edge/types";

import { queryAnalyticsReportOutputRowsFromD1 } from "./analytics-report-query";
import type {
  EventFieldRow,
  EventFieldValueRow,
  FilterDocument,
  QueryWindow,
} from "./core";
import {
  decodePageCursor,
  encodePageCursor,
  hasExactKeys,
  type PageResult,
  pageResult,
  paginationBindingForWindow,
} from "./pagination";

export interface EventFieldCursor {
  readonly events: number;
  readonly occurrences: number;
  readonly path: string;
  readonly valueType: number;
}

export interface EventFieldValueCursor {
  readonly occurrences: number;
  readonly events: number;
  readonly stringValue: string;
  readonly numberValue: number;
  readonly booleanValue: number;
}

function eventFieldCursor(value: unknown): EventFieldCursor | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const candidate = value as Record<string, unknown>;
  return hasExactKeys(candidate, [
    "events",
    "occurrences",
    "path",
    "valueType",
  ]) &&
    typeof candidate.events === "number" &&
    Number.isFinite(candidate.events) &&
    typeof candidate.occurrences === "number" &&
    Number.isFinite(candidate.occurrences) &&
    typeof candidate.path === "string" &&
    typeof candidate.valueType === "number" &&
    Number.isSafeInteger(candidate.valueType)
    ? (candidate as unknown as EventFieldCursor)
    : null;
}

function eventFieldValueCursor(value: unknown): EventFieldValueCursor | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const candidate = value as Record<string, unknown>;
  return hasExactKeys(candidate, [
    "occurrences",
    "events",
    "stringValue",
    "numberValue",
    "booleanValue",
  ]) &&
    typeof candidate.occurrences === "number" &&
    Number.isFinite(candidate.occurrences) &&
    typeof candidate.events === "number" &&
    Number.isFinite(candidate.events) &&
    typeof candidate.stringValue === "string" &&
    typeof candidate.numberValue === "number" &&
    Number.isFinite(candidate.numberValue) &&
    typeof candidate.booleanValue === "number" &&
    Number.isFinite(candidate.booleanValue)
    ? (candidate as unknown as EventFieldValueCursor)
    : null;
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
  return paginationBindingForWindow(window, [
    `analytics-${operation}-v1`,
    audience,
    siteId,
    window.startMs,
    window.endExclusiveMs,
    window.timeZone,
    filterFingerprint(filters, analyticsFilterRegistry),
    effectiveScopeForPagination(filters),
    eventName ?? "",
    fieldPath ?? "",
    fieldValueType ?? "",
    search?.trim().toLowerCase() ?? "",
  ]);
}
import { customEventJsonTypeCode } from "./core";

export async function queryEventFieldsFromD1(
  env: Env,
  siteId: string,
  window: QueryWindow,
  filters: FilterDocument,
  eventName: string | undefined,
  limit: number,
): Promise<EventFieldRow[]> {
  const metadata = scopedFilterMetadata(filters);
  const plan = buildEventFieldsPlan({
    siteId,
    queryTime: queryWindowToTime(window),
    filters,
    ...(metadata ? { scopePlan: metadata.plan } : {}),
    ...(eventName !== undefined ? { eventName } : {}),
    limit,
  });
  const rows = await queryAnalyticsReportOutputRowsFromD1(
    env,
    plan,
    EVENT_FIELDS_OUTPUT,
  );
  return rows as unknown as EventFieldRow[];
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
  const metadata = scopedFilterMetadata(filters);
  const plan = buildEventFieldsPagePlan({
    siteId,
    queryTime: queryWindowToTime(window),
    filters,
    ...(metadata ? { scopePlan: metadata.plan } : {}),
    ...(eventName !== undefined ? { eventName } : {}),
    limit,
    ...(cursor ? { cursor } : {}),
  });
  const rows = (await queryAnalyticsReportOutputRowsFromD1(
    env,
    plan,
    EVENT_FIELDS_PAGE_OUTPUT,
  )) as unknown as EventFieldRow[];
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
    "event-fields",
    eventFieldCursor,
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
  const metadata = scopedFilterMetadata(filters);
  const source = buildEventPayloadReportSource({
    siteId,
    queryTime: queryWindowToTime(window),
    filters,
    ...(metadata ? { scopePlan: metadata.plan } : {}),
    ...(eventName !== undefined ? { eventName } : {}),
  });
  const valueTypeCode = customEventJsonTypeCode(fieldValueType);
  if (valueTypeCode === null) return [];
  const plan = buildEventFieldValuesPlan({
    source,
    fieldPath,
    valueTypeCode,
    limit,
    ...(search !== undefined ? { search } : {}),
  });
  const rows = await queryAnalyticsReportOutputRowsFromD1(
    env,
    plan,
    EVENT_FIELD_VALUES_OUTPUT,
  );
  return rows as unknown as EventFieldValueRow[];
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
  const metadata = scopedFilterMetadata(filters);
  const source = buildEventPayloadReportSource({
    siteId,
    queryTime: queryWindowToTime(window),
    filters,
    ...(metadata ? { scopePlan: metadata.plan } : {}),
    ...(eventName !== undefined ? { eventName } : {}),
  });
  const valueTypeCode = customEventJsonTypeCode(fieldValueType);
  if (valueTypeCode === null) {
    return {
      items: [],
      pagination: { limit, returned: 0, hasMore: false, nextCursor: null },
    };
  }
  const plan = buildEventFieldValuesPagePlan({
    source,
    fieldPath,
    valueTypeCode,
    limit,
    ...(search !== undefined ? { search } : {}),
    ...(cursor ? { cursor } : {}),
  });
  const rows = (await queryAnalyticsReportOutputRowsFromD1(
    env,
    plan,
    EVENT_FIELD_VALUES_PAGE_OUTPUT,
  )) as unknown as EventFieldValueRow[];
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
    "event-field-values",
    eventFieldValueCursor,
  );
}
