import {
  analyticsFilterRegistry,
  effectiveScopeForPagination,
  filterFingerprint,
  type QueryAudience,
  type QueryTime,
  scopedFilterMetadata,
} from "@/lib/edge/analytics/contract";
import { queryWindowToTime } from "@/lib/edge/analytics/contract/helpers";
import type { ScopedFilterPlan } from "@/lib/edge/analytics/contract/scoped-filter";
import {
  buildEventSummaryCardsPlan,
  EVENT_SUMMARY_CARD_OUTPUTS,
} from "@/lib/edge/analytics/engine/event-summary-cards-plan";
import {
  buildEventTypeSummaryPlan,
  EVENT_TYPE_SUMMARY_OUTPUTS,
  type EventNameDimensionListRequest,
} from "@/lib/edge/analytics/engine/event-type-summary-plan";
import type { Env } from "@/lib/edge/types";

import type {
  DeferredEventNameDimensionQualification,
  DeferredEventSummaryQualification,
  DeferredEventTypesQualification,
} from "./advanced-filter-execution";
import {
  prepareDeferredEventQualificationFallback,
  prepareDeferredEventSummaryFallback,
} from "./advanced-filter-execution";
import {
  executeEventNameDimensionQualificationProgram,
  executeEventSummaryQualificationProgram,
  executeEventTypesQualificationProgram,
} from "./analytics-qualification-program";
import {
  queryAnalyticsReportOutputRowsFromD1,
  queryAnalyticsReportOutputSetRowsFromD1,
} from "./analytics-report-query";
import type {
  DimensionRow,
  EventSummaryCards,
  EventSummaryRow,
  FilterDocument,
  QueryWindow,
} from "./core";
import type { D1ReadDiagnostics } from "./diagnostics";
import {
  type EventMembershipFallbackPlan,
  prepareEventMembershipFallbackPlan,
} from "./event-membership-fallback";
import {
  decodePageCursor,
  encodePageCursor,
  hasExactKeys,
  type PageResult,
  pageResult,
  paginationBindingForWindow,
} from "./pagination";

export interface EventTypeAggregateCursor {
  readonly views: number;
  readonly sessions: number;
  readonly value: string;
}

function eventTypeCursor(value: unknown): EventTypeAggregateCursor | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const candidate = value as Record<string, unknown>;
  return hasExactKeys(candidate, ["views", "sessions", "value"]) &&
    typeof candidate.views === "number" &&
    Number.isFinite(candidate.views) &&
    typeof candidate.sessions === "number" &&
    Number.isFinite(candidate.sessions) &&
    typeof candidate.value === "string"
    ? (candidate as unknown as EventTypeAggregateCursor)
    : null;
}

function eventTypeCursorBinding(
  siteId: string,
  window: QueryWindow,
  filters: FilterDocument,
  search?: string,
  audience: QueryAudience = "private-dashboard",
): Promise<string> {
  return paginationBindingForWindow(window, [
    "analytics-event-types-v1",
    audience,
    siteId,
    window.startMs,
    window.endExclusiveMs,
    window.timeZone,
    filterFingerprint(filters, analyticsFilterRegistry),
    effectiveScopeForPagination(filters),
    search?.trim().toLowerCase() ?? "",
  ]);
}

async function queryCustomEventNamesFromD1(
  env: Env,
  siteId: string,
  window: QueryWindow,
  filters: FilterDocument,
  limit: number,
  search?: string,
): Promise<DimensionRow[]> {
  const metadata = scopedFilterMetadata(filters);
  const plan = buildEventTypeSummaryPlan({
    siteId,
    queryTime: metadata?.time ?? queryWindowToTime(window),
    filters,
    ...(metadata ? { scopePlan: metadata.plan } : {}),
    query: { kind: "list", limit, ...(search !== undefined ? { search } : {}) },
  });
  const rows = await queryAnalyticsReportOutputRowsFromD1(
    env,
    plan,
    EVENT_TYPE_SUMMARY_OUTPUTS.list,
  );
  return rows.map((row) => ({
    value: String(row.value ?? ""),
    views: Number(row.views ?? 0),
    sessions: Number(row.sessions ?? 0),
    visitors: Number(row.visitors ?? 0),
  }));
}

export async function queryEventTypeAggregate(
  env: Env,
  siteId: string,
  window: QueryWindow,
  filters: FilterDocument,
  limit: number,
  search?: string,
): Promise<DimensionRow[]> {
  return queryCustomEventNamesFromD1(
    env,
    siteId,
    window,
    filters,
    limit,
    search,
  );
}

function sameEventNameDimensionRequestTime(
  left: QueryTime,
  right: QueryTime,
): boolean {
  const leftRead = left.readRange ?? left.range;
  const rightRead = right.readRange ?? right.range;
  return (
    left.range.startMs === right.range.startMs &&
    left.range.endExclusiveMs === right.range.endExclusiveMs &&
    leftRead.startMs === rightRead.startMs &&
    leftRead.endExclusiveMs === rightRead.endExclusiveMs &&
    JSON.stringify(left.filterRange) === JSON.stringify(right.filterRange) &&
    left.filterRangeEmpty === right.filterRangeEmpty &&
    left.fullHistory === right.fullHistory &&
    left.reportingTimeZone === right.reportingTimeZone &&
    left.capturedAtMs === right.capturedAtMs
  );
}

export async function queryEventNameDimensionFromD1(
  env: Env,
  siteId: string,
  window: QueryWindow,
  queryTime: QueryTime,
  filters: FilterDocument,
  request: EventNameDimensionListRequest,
  options?: {
    readonly deferredQualification?: DeferredEventNameDimensionQualification;
    readonly diagnostics?: D1ReadDiagnostics;
    readonly scopePlan?: ScopedFilterPlan;
  },
): Promise<DimensionRow[]> {
  let reportFilters = filters;
  let rows: Record<string, unknown>[] | undefined;
  let membership: EventMembershipFallbackPlan | undefined;
  const deferred = options?.deferredQualification;
  if (deferred) {
    const prepared = deferred.eventNameDimensionRequest;
    const scopePlanMatches =
      options?.scopePlan === undefined
        ? deferred.requestScopePlan === undefined
        : deferred.requestScopePlan !== undefined &&
          JSON.stringify(deferred.requestScopePlan) ===
            JSON.stringify(options.scopePlan);
    if (
      deferred.operation !== "event-name-dimension" ||
      deferred.siteId !== siteId ||
      deferred.filters !== filters ||
      !deferred.requestTime ||
      !sameEventNameDimensionRequestTime(deferred.requestTime, queryTime) ||
      !scopePlanMatches ||
      prepared.mode !== request.mode ||
      prepared.dimension !== request.dimension ||
      prepared.limit !== request.limit ||
      prepared.search !== request.search ||
      prepared.audience !== request.audience
    )
      throw new Error("event_name_dimension_qualification_request_mismatch");
    const result = await executeEventNameDimensionQualificationProgram({
      env,
      deferred,
      ...(options?.diagnostics ? { diagnostics: options.diagnostics } : {}),
    });
    if (result.kind === "executed") {
      rows = [...result.rows];
    } else {
      if (options?.diagnostics)
        options.diagnostics.advancedCountSqlFallbackReason =
          result.fallbackReason;
      membership = await prepareEventMembershipFallbackPlan({
        deferred,
        operation: "event-name-dimension",
        operations: ["event-name-dimension"],
        configuration: {
          mode: request.mode,
          dimension: request.dimension,
          limit: request.limit,
          search: request.search ?? null,
          audience: request.audience,
        },
        buildPlan: (context) =>
          buildEventTypeSummaryPlan({
            siteId,
            queryTime: context.queryTime,
            filters,
            scopePlan: context.scopePlan,
            qualificationDependencyRefs: context.qualificationDependencyRefs,
            query: {
              kind: "list",
              limit: request.limit,
              ...(request.search !== undefined
                ? { search: request.search }
                : {}),
            },
          }),
      });
      if (!membership)
        reportFilters =
          await prepareDeferredEventQualificationFallback(deferred);
    }
  }
  if (!rows && membership)
    rows = await queryAnalyticsReportOutputRowsFromD1(
      env,
      membership.plan,
      EVENT_TYPE_SUMMARY_OUTPUTS.list,
      undefined,
      undefined,
      membership.executionInputs,
    );
  if (!rows)
    return queryEventTypeAggregate(
      env,
      siteId,
      window,
      reportFilters,
      request.limit,
      request.search,
    );
  return rows.map((row) => ({
    value: String(row.value ?? ""),
    views: Number(row.views ?? 0),
    sessions: Number(row.sessions ?? 0),
    visitors: Number(row.visitors ?? 0),
  }));
}

export async function queryEventTypePageFromD1(
  env: Env,
  siteId: string,
  window: QueryWindow,
  filters: FilterDocument,
  limit: number,
  search?: string,
  cursor?: EventTypeAggregateCursor | null,
  audience: QueryAudience = "private-dashboard",
  options?: {
    readonly deferredQualification?: DeferredEventTypesQualification;
    readonly diagnostics?: D1ReadDiagnostics;
  },
): Promise<PageResult<DimensionRow>> {
  let reportFilters = filters;
  let rows: Record<string, unknown>[] | undefined;
  let membership: EventMembershipFallbackPlan | undefined;
  const deferred = options?.deferredQualification;
  if (deferred) {
    if (
      deferred.operation !== "event-types" ||
      deferred.siteId !== siteId ||
      deferred.filters !== filters
    )
      throw new Error("event_types_qualification_request_mismatch");
    const query = {
      kind: "page" as const,
      limit,
      ...(search !== undefined ? { search } : {}),
      ...(cursor ? { cursor } : {}),
    };
    const result = await executeEventTypesQualificationProgram({
      env,
      deferred,
      query,
      ...(options?.diagnostics ? { diagnostics: options.diagnostics } : {}),
    });
    if (result.kind === "executed") {
      rows = [...result.rows];
    } else {
      if (options?.diagnostics)
        options.diagnostics.advancedCountSqlFallbackReason =
          result.fallbackReason;
      membership = await prepareEventMembershipFallbackPlan({
        deferred,
        operation: "event-types",
        operations: ["event-types"],
        configuration: {
          kind: "page",
          limit,
          search: search ?? null,
          cursor: cursor ?? null,
          audience,
        },
        buildPlan: (context) =>
          buildEventTypeSummaryPlan({
            siteId,
            queryTime: context.queryTime,
            filters,
            scopePlan: context.scopePlan,
            qualificationDependencyRefs: context.qualificationDependencyRefs,
            query: {
              kind: "page",
              limit,
              ...(search !== undefined ? { search } : {}),
              ...(cursor ? { cursor } : {}),
            },
          }),
      });
      if (!membership)
        reportFilters =
          await prepareDeferredEventQualificationFallback(deferred);
    }
  }
  if (!rows && membership) {
    rows = await queryAnalyticsReportOutputRowsFromD1(
      env,
      membership.plan,
      EVENT_TYPE_SUMMARY_OUTPUTS.page,
      undefined,
      options?.diagnostics,
      membership.executionInputs,
    );
  }
  if (!rows) {
    const metadata = scopedFilterMetadata(reportFilters);
    const plan = buildEventTypeSummaryPlan({
      siteId,
      queryTime: metadata?.time ?? queryWindowToTime(window),
      filters: reportFilters,
      ...(metadata ? { scopePlan: metadata.plan } : {}),
      query: {
        kind: "page",
        limit,
        ...(search !== undefined ? { search } : {}),
        ...(cursor ? { cursor } : {}),
      },
    });
    rows = await queryAnalyticsReportOutputRowsFromD1(
      env,
      plan,
      EVENT_TYPE_SUMMARY_OUTPUTS.page,
      undefined,
      options?.diagnostics,
    );
  }
  return eventTypePageResultFromRows({
    env,
    siteId,
    window,
    filters,
    rows,
    limit,
    search,
    audience,
  });
}

/** Keeps the existing Event cursor family and page/token mapping in one place. */
export async function eventTypePageResultFromRows(input: {
  readonly env: Env;
  readonly siteId: string;
  readonly window: QueryWindow;
  readonly filters: FilterDocument;
  readonly rows: readonly {
    readonly value?: unknown;
    readonly views?: unknown;
    readonly sessions?: unknown;
    readonly visitors?: unknown;
  }[];
  readonly limit: number;
  readonly search?: string;
  readonly audience?: QueryAudience;
}): Promise<PageResult<DimensionRow>> {
  const {
    env,
    siteId,
    window,
    filters,
    rows,
    limit,
    search,
    audience = "private-dashboard",
  } = input;
  const mapped = rows.map((row) => ({
    value: String(row.value ?? ""),
    views: Number(row.views ?? 0),
    sessions: Number(row.sessions ?? 0),
    visitors: Number(row.visitors ?? 0),
  }));
  const page = pageResult(mapped, limit);
  const binding = await eventTypeCursorBinding(
    siteId,
    window,
    filters,
    search,
    audience,
  );
  const nextCursor =
    page.hasMore && page.last
      ? await encodePageCursor(env, binding, {
          views: page.last.views,
          sessions: page.last.sessions,
          value: page.last.value,
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

export async function decodeEventTypeCursor(
  env: Env,
  siteId: string,
  window: QueryWindow,
  filters: FilterDocument,
  search?: string,
  cursor?: string | null,
  audience: QueryAudience = "private-dashboard",
): Promise<EventTypeAggregateCursor | null> {
  return decodePageCursor<EventTypeAggregateCursor>(
    env,
    await eventTypeCursorBinding(siteId, window, filters, search, audience),
    cursor,
    "event-types",
    eventTypeCursor,
  );
}

export async function queryEventSummaryMetricsFromD1(
  env: Env,
  siteId: string,
  window: QueryWindow,
  filters: FilterDocument,
): Promise<EventSummaryRow> {
  const metadata = scopedFilterMetadata(filters);
  const plan = buildEventTypeSummaryPlan({
    siteId,
    queryTime: metadata?.time ?? queryWindowToTime(window),
    filters,
    ...(metadata ? { scopePlan: metadata.plan } : {}),
    query: { kind: "summary" },
  });
  const [summaryRow] = await queryAnalyticsReportOutputRowsFromD1(
    env,
    plan,
    EVENT_TYPE_SUMMARY_OUTPUTS.summary,
  );
  return summaryRow
    ? {
        events: Number(summaryRow.events ?? 0),
        eventTypes: Number(summaryRow.eventTypes ?? 0),
        sessions: Number(summaryRow.sessions ?? 0),
        visitors: Number(summaryRow.visitors ?? 0),
      }
    : { events: 0, eventTypes: 0, sessions: 0, visitors: 0 };
}

export async function queryEventsSummaryFromD1(
  env: Env,
  siteId: string,
  window: QueryWindow,
  filters: FilterDocument,
  options?: {
    readonly deferredQualification?: DeferredEventSummaryQualification;
    readonly diagnostics?: D1ReadDiagnostics;
  },
): Promise<{
  summary: EventSummaryRow;
  cards: EventSummaryCards;
}> {
  let reportFilters = filters;
  let membership: EventMembershipFallbackPlan | undefined;
  const deferred = options?.deferredQualification;
  if (deferred) {
    if (deferred.siteId !== siteId || deferred.filters !== filters)
      throw new Error("event_summary_qualification_request_mismatch");
    const result = await executeEventSummaryQualificationProgram({
      env,
      deferred,
      diagnostics: options?.diagnostics,
    });
    if (result.kind === "executed") return eventSummaryFromRows(result.rows);
    if (options?.diagnostics)
      options.diagnostics.advancedCountSqlFallbackReason =
        result.fallbackReason;
    membership = await prepareEventMembershipFallbackPlan({
      deferred,
      operation: "event-summary",
      operations: ["event-summary"],
      configuration: {},
      buildPlan: (context) =>
        buildEventSummaryCardsPlan({
          siteId,
          queryTime: context.queryTime,
          filters,
          scopePlan: context.scopePlan,
          qualificationDependencyRefs: context.qualificationDependencyRefs,
        }),
    });
    if (!membership)
      reportFilters = await prepareDeferredEventSummaryFallback(deferred);
  }
  const metadata = scopedFilterMetadata(reportFilters);
  const plan =
    membership?.plan ??
    buildEventSummaryCardsPlan({
      siteId,
      queryTime: metadata?.time ?? queryWindowToTime(window),
      filters: reportFilters,
      ...(metadata ? { scopePlan: metadata.plan } : {}),
    });
  const rows =
    (await queryAnalyticsReportOutputSetRowsFromD1(
      env,
      plan,
      {
        outputIds: [
          EVENT_SUMMARY_CARD_OUTPUTS.summary,
          EVENT_SUMMARY_CARD_OUTPUTS.event,
          EVENT_SUMMARY_CARD_OUTPUTS.path,
          EVENT_SUMMARY_CARD_OUTPUTS.title,
          EVENT_SUMMARY_CARD_OUTPUTS.hostname,
        ],
        fields: [
          "cardType",
          "value",
          "views",
          "eventTypes",
          "sessions",
          "visitors",
        ],
        orderBy: [
          { field: "cardType", direction: "asc", nulls: "first" },
          { field: "views", direction: "desc", nulls: "last" },
          { field: "sessions", direction: "desc", nulls: "last" },
          { field: "visitors", direction: "desc", nulls: "last" },
          { field: "value", direction: "asc", nulls: "first" },
        ],
      },
      options?.diagnostics,
      membership?.executionInputs,
    )) ?? [];
  return eventSummaryFromRows(rows);
}

function eventSummaryFromRows(rows: readonly Record<string, unknown>[]): {
  summary: EventSummaryRow;
  cards: EventSummaryCards;
} {
  const summaryRow = rows.find((row) => row.cardType === "__summary__");
  const summary: EventSummaryRow = summaryRow
    ? {
        events: Number(summaryRow.views ?? 0),
        eventTypes: Number(summaryRow.eventTypes ?? 0),
        sessions: Number(summaryRow.sessions ?? 0),
        visitors: Number(summaryRow.visitors ?? 0),
      }
    : { events: 0, eventTypes: 0, sessions: 0, visitors: 0 };
  const readDimension = (cardType: string): DimensionRow[] =>
    rows
      .filter((row) => row.cardType === cardType)
      .map((row) => ({
        value: String(row.value ?? ""),
        views: Number(row.views ?? 0),
        sessions: Number(row.sessions ?? 0),
        visitors: Number(row.visitors ?? 0),
      }));
  const eventNames = readDimension("event");
  const path = readDimension("path");
  const title = readDimension("title");
  const hostname = readDimension("hostname");

  return {
    summary,
    cards: {
      event: {
        name: eventNames,
      },
      page: {
        path,
        title,
        hostname,
      },
    },
  };
}
