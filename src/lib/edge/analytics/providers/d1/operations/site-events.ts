import "@tanstack/react-start/server-only";

import type {
  FilterDocument,
  QueryAudience,
} from "@/lib/edge/analytics/contract";
import type { QueryWindow } from "@/lib/edge/analytics/providers/d1/internal/core";
import {
  mapEventAnalyticsContextCards,
  mapEventField,
  mapEventFieldValue,
  mapEventSummaryCards,
  mapTabs,
} from "@/lib/edge/analytics/providers/d1/internal/core-mappers";
import { queryEventAnalyticsContextCardsFromD1 } from "@/lib/edge/analytics/providers/d1/internal/events-context";
import {
  decodeEventFieldCursor,
  decodeEventFieldValueCursor,
  queryEventFieldsFromD1,
  queryEventFieldsPageFromD1,
  queryEventFieldValuesPageFromD1,
} from "@/lib/edge/analytics/providers/d1/internal/events-fields";
import { queryEventTypeOverviewFromD1 } from "@/lib/edge/analytics/providers/d1/internal/events-overview";
import {
  decodeEventTypeCursor,
  queryEventsSummaryFromD1,
  queryEventTypePageFromD1,
} from "@/lib/edge/analytics/providers/d1/internal/events-summary";
import {
  queryEventsTrendFromD1,
  queryEventTypeTrendFromD1,
} from "@/lib/edge/analytics/providers/d1/internal/events-trend";
import type { Env } from "@/lib/edge/types";
import { InvalidCursorError } from "@/lib/pagination";

export interface ReadSiteEventsInput {
  readonly env: Env;
  readonly siteId: string;
  readonly window: QueryWindow;
  readonly filters: FilterDocument;
  readonly audience?: QueryAudience;
}

export interface ReadSiteEventsTimeseriesInput extends ReadSiteEventsInput {
  readonly interval: "minute" | "hour" | "day" | "week" | "month";
  readonly limit: number;
}

export interface ReadSiteEventTypesInput extends ReadSiteEventsInput {
  readonly search?: string;
  readonly page?: { readonly limit: number; readonly cursor?: string | null };
  readonly limit?: number;
}

export interface ReadSiteEventTypeDetailInput extends ReadSiteEventsInput {
  readonly eventName: string;
  readonly interval: "minute" | "hour" | "day" | "week" | "month";
}

export interface ReadSiteEventFieldsInput extends ReadSiteEventsInput {
  readonly eventName?: string;
  readonly page?: { readonly limit: number; readonly cursor?: string | null };
  readonly limit?: number;
}

export interface ReadSiteEventFieldValuesInput extends ReadSiteEventsInput {
  readonly eventName?: string;
  readonly fieldPath: string;
  readonly fieldValueType: string;
  readonly page?: { readonly limit: number; readonly cursor?: string | null };
  readonly limit?: number;
  readonly search?: string;
}

export async function readSiteEventsSummary(input: ReadSiteEventsInput) {
  const data = await queryEventsSummaryFromD1(
    input.env,
    input.siteId,
    input.window,
    input.filters,
  );
  const events = Number(data.summary.events ?? 0);
  const sessions = Number(data.summary.sessions ?? 0);
  return {
    summary: {
      events,
      eventTypes: Number(data.summary.eventTypes ?? 0),
      sessions,
      visitors: Number(data.summary.visitors ?? 0),
      avgEventsPerSession: sessions > 0 ? events / sessions : 0,
    },
    cards: mapEventSummaryCards(data.cards),
  };
}

export async function readSiteEventsTimeseries(
  input: ReadSiteEventsTimeseriesInput,
) {
  const result = await queryEventsTrendFromD1(
    input.env,
    input.siteId,
    input.window,
    input.interval,
    input.filters,
    input.limit,
  );
  return {
    interval: input.interval,
    series: result.series,
    points: result.data.map((point) => ({
      bucket: point.bucket,
      timestamp: new Date(point.timestampMs).toISOString(),
      totalEvents: point.totalEvents,
      eventsBySeries: point.eventsBySeries,
    })),
  };
}

export async function readSiteEventTypes(input: ReadSiteEventTypesInput) {
  const requestedPage = input.page ?? {
    limit: input.limit ?? 20,
    cursor: null,
  };
  const cursor = await decodeEventTypeCursor(
    input.env,
    input.siteId,
    input.window,
    input.filters,
    input.search,
    requestedPage.cursor,
    input.audience,
  );
  if (requestedPage.cursor && !cursor)
    throw new InvalidCursorError("event-types");
  const result = await queryEventTypePageFromD1(
    input.env,
    input.siteId,
    input.window,
    input.filters,
    requestedPage.limit,
    input.search,
    cursor,
    input.audience,
  );
  return {
    items: result.items.map((row) => ({
      key: row.value,
      label: row.value,
      events: row.views,
      sessions: row.sessions,
      visitors: row.visitors,
    })),
    pagination: result.pagination,
  };
}

export async function readSiteEventFields(input: ReadSiteEventFieldsInput) {
  const requestedPage = input.page ?? {
    limit: input.limit ?? 100,
    cursor: null,
  };
  const cursor = await decodeEventFieldCursor(
    input.env,
    input.siteId,
    input.window,
    input.filters,
    input.eventName,
    requestedPage.cursor,
    input.audience,
  );
  if (requestedPage.cursor && !cursor)
    throw new InvalidCursorError("event-fields");
  const result = await queryEventFieldsPageFromD1(
    input.env,
    input.siteId,
    input.window,
    input.filters,
    input.eventName,
    requestedPage.limit,
    cursor,
    input.audience,
  );
  return {
    eventName: input.eventName ?? "",
    items: result.items.map(mapEventField),
    pagination: result.pagination,
  };
}

export async function readSiteEventFieldValues(
  input: ReadSiteEventFieldValuesInput,
) {
  const requestedPage = input.page ?? {
    limit: input.limit ?? 25,
    cursor: null,
  };
  const cursor = await decodeEventFieldValueCursor(
    input.env,
    input.siteId,
    input.window,
    input.filters,
    input.eventName,
    input.fieldPath,
    input.fieldValueType,
    input.search,
    requestedPage.cursor,
    input.audience,
  );
  if (requestedPage.cursor && !cursor)
    throw new InvalidCursorError("event-field-values");
  const result = await queryEventFieldValuesPageFromD1(
    input.env,
    input.siteId,
    input.window,
    input.filters,
    input.eventName,
    input.fieldPath,
    input.fieldValueType,
    requestedPage.limit,
    input.search,
    cursor,
    input.audience,
  );
  return {
    eventName: input.eventName ?? "",
    fieldPath: input.fieldPath,
    fieldValueType: input.fieldValueType,
    items: result.items.map(mapEventFieldValue),
    pagination: result.pagination,
  };
}

export async function readSiteEventTypeDetail(
  input: ReadSiteEventTypeDetailInput,
) {
  const [overview, trend, fields, cards] = await Promise.all([
    queryEventTypeOverviewFromD1(
      input.env,
      input.siteId,
      input.window,
      input.filters,
      input.eventName,
      { includeBreakdowns: true },
    ),
    queryEventTypeTrendFromD1(
      input.env,
      input.siteId,
      input.window,
      input.interval,
      input.filters,
      input.eventName,
    ),
    queryEventFieldsFromD1(
      input.env,
      input.siteId,
      input.window,
      input.filters,
      input.eventName,
      100,
    ),
    queryEventAnalyticsContextCardsFromD1(
      input.env,
      input.siteId,
      input.window,
      input.filters,
      100,
      input.eventName,
    ),
  ]);
  return {
    eventName: input.eventName,
    summary: overview.summary,
    trend: {
      data: trend.data.map((point) => ({
        bucket: point.bucket,
        timestamp: new Date(point.timestampMs).toISOString(),
        events: point.events,
        visitors: point.visitors,
      })),
    },
    breakdowns: {
      pages: mapTabs(overview.breakdowns.pages).map((item) => ({ ...item })),
      countries: mapTabs(overview.breakdowns.countries).map((item) => ({
        ...item,
      })),
      devices: mapTabs(overview.breakdowns.devices).map((item) => ({
        ...item,
      })),
      browsers: mapTabs(overview.breakdowns.browsers).map((item) => ({
        ...item,
      })),
    },
    cards: mapEventAnalyticsContextCards(cards),
    fields: fields.map(mapEventField),
  };
}
