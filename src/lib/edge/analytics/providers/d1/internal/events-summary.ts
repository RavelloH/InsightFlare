import {
  analyticsFilterRegistry,
  effectiveScopeForPagination,
  filterFingerprint,
  type QueryAudience,
  scopedFilterMetadata,
} from "@/lib/edge/analytics/contract";
import { queryWindowToTime } from "@/lib/edge/analytics/contract/helpers";
import {
  buildEventSummaryCardsPlan,
  EVENT_SUMMARY_CARD_OUTPUTS,
} from "@/lib/edge/analytics/engine/event-summary-cards-plan";
import {
  buildEventTypeSummaryPlan,
  EVENT_TYPE_SUMMARY_OUTPUTS,
} from "@/lib/edge/analytics/engine/event-type-summary-plan";
import type { Env } from "@/lib/edge/types";

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

export async function queryEventTypePageFromD1(
  env: Env,
  siteId: string,
  window: QueryWindow,
  filters: FilterDocument,
  limit: number,
  search?: string,
  cursor?: EventTypeAggregateCursor | null,
  audience: QueryAudience = "private-dashboard",
): Promise<PageResult<DimensionRow>> {
  const metadata = scopedFilterMetadata(filters);
  const plan = buildEventTypeSummaryPlan({
    siteId,
    queryTime: metadata?.time ?? queryWindowToTime(window),
    filters,
    ...(metadata ? { scopePlan: metadata.plan } : {}),
    query: {
      kind: "page",
      limit,
      ...(search !== undefined ? { search } : {}),
      ...(cursor ? { cursor } : {}),
    },
  });
  const rows = await queryAnalyticsReportOutputRowsFromD1(
    env,
    plan,
    EVENT_TYPE_SUMMARY_OUTPUTS.page,
  );
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
): Promise<{
  summary: EventSummaryRow;
  cards: EventSummaryCards;
}> {
  const metadata = scopedFilterMetadata(filters);
  const plan = buildEventSummaryCardsPlan({
    siteId,
    queryTime: metadata?.time ?? queryWindowToTime(window),
    filters,
    ...(metadata ? { scopePlan: metadata.plan } : {}),
  });
  const rows =
    (await queryAnalyticsReportOutputSetRowsFromD1(env, plan, {
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
    })) ?? [];
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
