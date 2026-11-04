import {
  analyticsFilterRegistry,
  effectiveScopeForPagination,
  filterFingerprint,
  type QueryAudience,
  scopedFilterMetadata,
} from "@/lib/edge/analytics/contract";
import { queryWindowToTime } from "@/lib/edge/analytics/contract/helpers";
import type { ScopedFilterPlan } from "@/lib/edge/analytics/contract/scoped-filter";
import type { QueryTime } from "@/lib/edge/analytics/contract/types";
import {
  buildEventFieldValuesPagePlan,
  buildEventFieldValuesPlan,
  EVENT_FIELD_VALUES_OUTPUT,
  EVENT_FIELD_VALUES_PAGE_FIELDS,
  EVENT_FIELD_VALUES_PAGE_OUTPUT,
} from "@/lib/edge/analytics/engine/event-field-values-plan";
import {
  buildEventFieldsPagePlan,
  buildEventFieldsPlan,
  EVENT_FIELDS,
  EVENT_FIELDS_OUTPUT,
  EVENT_FIELDS_PAGE_OUTPUT,
} from "@/lib/edge/analytics/engine/event-fields-plan";
import { buildEventPayloadReportSource } from "@/lib/edge/analytics/engine/event-payload-report-source";
import {
  type DeferredEventFieldsQualification,
  type DeferredEventFieldValuesQualification,
  prepareDeferredEventQualificationFallback,
} from "@/lib/edge/analytics/providers/d1/internal/advanced-filter-execution";
import {
  type EventFieldsQualificationQuery,
  type EventFieldValuesQualificationQuery,
  executeEventFieldsQualificationProgram,
  executeEventFieldValuesQualificationProgram,
} from "@/lib/edge/analytics/providers/d1/internal/analytics-qualification-program";
import type { D1ReadDiagnostics } from "@/lib/edge/analytics/providers/d1/internal/diagnostics";
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
  return eventFieldsPageFromRows(
    env,
    siteId,
    window,
    filters,
    eventName,
    limit,
    audience,
    rows,
  );
}

async function eventFieldsPageFromRows(
  env: Env,
  siteId: string,
  window: QueryWindow,
  filters: FilterDocument,
  eventName: string | undefined,
  limit: number,
  audience: QueryAudience,
  rows: readonly EventFieldRow[],
): Promise<PageResult<EventFieldRow>> {
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

interface QualifiedEventFieldsPageInput {
  readonly env: Env;
  readonly siteId: string;
  readonly window: QueryWindow;
  readonly queryTime: QueryTime;
  readonly filters: FilterDocument;
  readonly scopePlan?: ScopedFilterPlan;
  readonly eventName?: string;
  readonly limit: number;
  readonly cursor: EventFieldCursor | null;
  readonly cursorToken: string | null;
  readonly audience: QueryAudience;
  readonly deferred: DeferredEventFieldsQualification;
  readonly diagnostics?: D1ReadDiagnostics;
}

async function executeQualifiedEventFields(
  input: QualifiedEventFieldsPageInput,
  cursor: EventFieldCursor | null,
) {
  const query: EventFieldsQualificationQuery = {
    env: input.env,
    siteId: input.siteId,
    queryTime: input.queryTime,
    filters: input.filters,
    ...(input.scopePlan ? { scopePlan: input.scopePlan } : {}),
    ...(input.eventName !== undefined ? { eventName: input.eventName } : {}),
    limit: input.limit,
    cursor,
    cursorToken: input.cursorToken,
    audience: input.audience,
  };
  return executeEventFieldsQualificationProgram({
    env: input.env,
    deferred: input.deferred,
    query,
    ...(input.diagnostics ? { diagnostics: input.diagnostics } : {}),
  });
}

function recordEventFieldsFallbackReason(
  input: QualifiedEventFieldsPageInput,
  result: Awaited<ReturnType<typeof executeQualifiedEventFields>>,
): void {
  if (result.kind !== "executed" && input.diagnostics)
    input.diagnostics.advancedCountSqlFallbackReason = result.fallbackReason;
}

/** Runs the fused Count and Event-field query, with one whole-operation fallback. */
export async function queryQualifiedEventFieldsPageFromD1(
  input: QualifiedEventFieldsPageInput,
): Promise<PageResult<EventFieldRow>> {
  const result = await executeQualifiedEventFields(input, input.cursor);
  recordEventFieldsFallbackReason(input, result);
  if (result.kind === "executed") {
    const rows = result.rows
      .filter((row) => row.outputId === EVENT_FIELDS_PAGE_OUTPUT)
      .map((row) => {
        const fields: Record<string, unknown> = {};
        for (const { name } of EVENT_FIELDS) fields[name] = row[name];
        return fields as unknown as EventFieldRow;
      });
    return eventFieldsPageFromRows(
      input.env,
      input.siteId,
      input.window,
      input.filters,
      input.eventName,
      input.limit,
      input.audience,
      rows,
    );
  }
  const fallbackFilters = await prepareDeferredEventQualificationFallback(
    input.deferred,
  );
  return queryEventFieldsPageFromD1(
    input.env,
    input.siteId,
    input.window,
    fallbackFilters,
    input.eventName,
    input.limit,
    input.cursor,
    input.audience,
  );
}

/** Preserves count/cap precedence when a supplied event-fields cursor is invalid. */
export async function preflightQualifiedEventFieldsCursorFromD1(
  input: QualifiedEventFieldsPageInput,
): Promise<void> {
  const result = await executeQualifiedEventFields(input, null);
  recordEventFieldsFallbackReason(input, result);
  if (result.kind !== "executed")
    await prepareDeferredEventQualificationFallback(input.deferred);
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
  return eventFieldValuesPageFromRows(
    env,
    siteId,
    window,
    filters,
    eventName,
    fieldPath,
    fieldValueType,
    limit,
    search,
    audience,
    rows,
  );
}

async function eventFieldValuesPageFromRows(
  env: Env,
  siteId: string,
  window: QueryWindow,
  filters: FilterDocument,
  eventName: string | undefined,
  fieldPath: string,
  fieldValueType: string,
  limit: number,
  search: string | undefined,
  audience: QueryAudience,
  rows: readonly EventFieldValueRow[],
): Promise<PageResult<EventFieldValueRow>> {
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

interface QualifiedEventFieldValuesPageInput {
  readonly env: Env;
  readonly siteId: string;
  readonly window: QueryWindow;
  readonly queryTime: QueryTime;
  readonly filters: FilterDocument;
  readonly scopePlan?: ScopedFilterPlan;
  readonly eventName?: string;
  readonly fieldPath: string;
  readonly fieldValueType: string;
  readonly search?: string;
  readonly limit: number;
  readonly cursor: EventFieldValueCursor | null;
  readonly cursorToken: string | null;
  readonly audience: QueryAudience;
  readonly deferred: DeferredEventFieldValuesQualification;
  readonly diagnostics?: D1ReadDiagnostics;
}

async function executeQualifiedEventFieldValues(
  input: QualifiedEventFieldValuesPageInput,
  cursor: EventFieldValueCursor | null,
) {
  const query: EventFieldValuesQualificationQuery = {
    env: input.env,
    siteId: input.siteId,
    queryTime: input.queryTime,
    filters: input.filters,
    ...(input.scopePlan ? { scopePlan: input.scopePlan } : {}),
    ...(input.eventName !== undefined ? { eventName: input.eventName } : {}),
    fieldPath: input.fieldPath,
    fieldValueType: input.fieldValueType,
    ...(input.search !== undefined ? { search: input.search } : {}),
    limit: input.limit,
    cursor,
    cursorToken: input.cursorToken,
    audience: input.audience,
  };
  return executeEventFieldValuesQualificationProgram({
    env: input.env,
    deferred: input.deferred,
    query,
    ...(input.diagnostics ? { diagnostics: input.diagnostics } : {}),
  });
}

function recordEventFieldValuesFallbackReason(
  input: QualifiedEventFieldValuesPageInput,
  result: Awaited<ReturnType<typeof executeQualifiedEventFieldValues>>,
): void {
  if (result.kind !== "executed" && input.diagnostics)
    input.diagnostics.advancedCountSqlFallbackReason = result.fallbackReason;
}

/** Runs Count and Event-field-values together, with one whole-operation fallback. */
export async function queryQualifiedEventFieldValuesPageFromD1(
  input: QualifiedEventFieldValuesPageInput,
): Promise<PageResult<EventFieldValueRow>> {
  const result = await executeQualifiedEventFieldValues(input, input.cursor);
  recordEventFieldValuesFallbackReason(input, result);
  if (result.kind === "executed") {
    const rows = result.rows
      .filter((row) => row.outputId === EVENT_FIELD_VALUES_PAGE_OUTPUT)
      .map((row) => {
        const fields: Record<string, unknown> = {};
        for (const name of EVENT_FIELD_VALUES_PAGE_FIELDS)
          fields[name] = row[name];
        return fields as unknown as EventFieldValueRow;
      });
    return eventFieldValuesPageFromRows(
      input.env,
      input.siteId,
      input.window,
      input.filters,
      input.eventName,
      input.fieldPath,
      input.fieldValueType,
      input.limit,
      input.search,
      input.audience,
      rows,
    );
  }
  const fallbackFilters = await prepareDeferredEventQualificationFallback(
    input.deferred,
  );
  return queryEventFieldValuesPageFromD1(
    input.env,
    input.siteId,
    input.window,
    fallbackFilters,
    input.eventName,
    input.fieldPath,
    input.fieldValueType,
    input.limit,
    input.search,
    input.cursor,
    input.audience,
  );
}

/** Preserves Count/cap precedence when a values cursor is invalid. */
export async function preflightQualifiedEventFieldValuesCursorFromD1(
  input: QualifiedEventFieldValuesPageInput,
): Promise<void> {
  const result = await executeQualifiedEventFieldValues(input, null);
  recordEventFieldValuesFallbackReason(input, result);
  if (result.kind !== "executed")
    await prepareDeferredEventQualificationFallback(input.deferred);
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
