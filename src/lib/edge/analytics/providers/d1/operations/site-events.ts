import "@tanstack/react-start/server-only";

import type { FilterDocument } from "@/lib/edge/analytics/contract";
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
  queryEventFieldsFromD1,
  queryEventFieldValuesFromD1,
} from "@/lib/edge/analytics/providers/d1/internal/events-fields";
import { queryEventTypeOverviewFromD1 } from "@/lib/edge/analytics/providers/d1/internal/events-overview";
import {
  queryEventsSummaryFromD1,
  queryEventTypeAggregate,
} from "@/lib/edge/analytics/providers/d1/internal/events-summary";
import {
  queryEventsTrendFromD1,
  queryEventTypeTrendFromD1,
} from "@/lib/edge/analytics/providers/d1/internal/events-trend";
import type { Env } from "@/lib/edge/types";

export interface ReadSiteEventsInput {
  readonly env: Env;
  readonly siteId: string;
  readonly window: QueryWindow;
  readonly filters: FilterDocument;
}

export interface ReadSiteEventsTimeseriesInput extends ReadSiteEventsInput {
  readonly interval: "minute" | "hour" | "day" | "week" | "month";
  readonly limit: number;
}

export interface ReadSiteEventTypesInput extends ReadSiteEventsInput {
  readonly search?: string;
  readonly limit: number;
}

export interface ReadSiteEventTypeDetailInput extends ReadSiteEventsInput {
  readonly eventName: string;
  readonly interval: "minute" | "hour" | "day" | "week" | "month";
}

export interface ReadSiteEventFieldsInput extends ReadSiteEventsInput {
  readonly eventName: string;
  readonly limit: number;
}

export interface ReadSiteEventFieldValuesInput extends ReadSiteEventsInput {
  readonly eventName: string;
  readonly fieldPath: string;
  readonly fieldValueType: string;
  readonly limit: number;
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
  return {
    items: (
      await queryEventTypeAggregate(
        input.env,
        input.siteId,
        input.window,
        input.filters,
        input.limit,
        input.search,
      )
    ).map((row) => ({
      key: row.value,
      label: row.value,
      events: row.views,
      sessions: row.sessions,
      visitors: row.visitors,
    })),
    page: { limit: input.limit },
  };
}

export async function readSiteEventFields(input: ReadSiteEventFieldsInput) {
  return {
    eventName: input.eventName,
    fields: (
      await queryEventFieldsFromD1(
        input.env,
        input.siteId,
        input.window,
        input.filters,
        input.eventName,
        input.limit,
      )
    ).map(mapEventField),
    page: { limit: input.limit },
  };
}

export async function readSiteEventFieldValues(
  input: ReadSiteEventFieldValuesInput,
) {
  return {
    eventName: input.eventName,
    fieldPath: input.fieldPath,
    fieldValueType: input.fieldValueType,
    items: (
      await queryEventFieldValuesFromD1(
        input.env,
        input.siteId,
        input.window,
        input.filters,
        input.eventName,
        input.fieldPath,
        input.fieldValueType,
        input.limit,
        input.search,
      )
    ).map(mapEventFieldValue),
    page: { limit: input.limit },
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
