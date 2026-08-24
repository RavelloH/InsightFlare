import "@tanstack/react-start/server-only";

import type { QueryWindow } from "@/lib/edge/query/core";
import {
  mapEventAnalyticsContextCards,
  mapEventField,
  mapEventFieldValue,
  mapEventSummaryCards,
  mapTabs,
} from "@/lib/edge/query/core-mappers";
import { queryEventAnalyticsContextCardsFromD1 } from "@/lib/edge/query/events-context";
import {
  queryEventFieldsFromD1,
  queryEventFieldValuesFromD1,
} from "@/lib/edge/query/events-fields";
import { queryEventTypeOverviewFromD1 } from "@/lib/edge/query/events-overview";
import { queryEventsSummaryFromD1 } from "@/lib/edge/query/events-summary";
import { queryEventTypeAggregate } from "@/lib/edge/query/events-summary";
import { queryEventsTrendFromD1 } from "@/lib/edge/query/events-trend";
import { queryEventTypeTrendFromD1 } from "@/lib/edge/query/events-trend";
import {
  analyticsFilterRegistry,
  assertFilterAudience,
  executeTypedApplicationOperation,
  type FilterDocument,
  siteQueryContext,
  validateTypedQueryFilters,
} from "@/lib/edge/query-contract";
import { createQueryTime } from "@/lib/edge/query-contract/helpers";
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

function inputBase(input: ReadSiteEventsInput) {
  const context = siteQueryContext(input.siteId, "api-v1");
  const filterError = validateTypedQueryFilters(context, input.filters);
  if (filterError) throw new Error(filterError.kind);
  try {
    assertFilterAudience(
      input.filters,
      analyticsFilterRegistry,
      context.policy.audience,
    );
  } catch {
    throw new Error("invalid-input");
  }
  return {
    context,
    time: createQueryTime(
      input.window.startMs,
      input.window.endExclusiveMs,
      input.window.timeZone,
      input.window.nowMs,
    ),
    filters: input.filters,
  };
}

export async function readSiteEventsSummary(input: ReadSiteEventsInput) {
  const result = await executeTypedApplicationOperation(
    "event-summary",
    inputBase(input),
    async () => {
      const data = await queryEventsSummaryFromD1(
        input.env,
        input.siteId,
        input.window,
        input.filters,
      );
      const events = Number(data.summary.events ?? 0);
      const sessions = Number(data.summary.sessions ?? 0);
      return {
        value: {
          summary: {
            events,
            eventTypes: Number(data.summary.eventTypes ?? 0),
            sessions,
            visitors: Number(data.summary.visitors ?? 0),
            avgEventsPerSession: sessions > 0 ? events / sessions : 0,
          },
          cards: mapEventSummaryCards(data.cards),
        },
      };
    },
  );
  if (!result.ok) throw new Error(result.error.kind);
  return result.data;
}

export async function readSiteEventsTimeseries(
  input: ReadSiteEventsTimeseriesInput,
) {
  const result = await executeTypedApplicationOperation(
    "event-trend",
    inputBase(input),
    async () => ({
      value: await queryEventsTrendFromD1(
        input.env,
        input.siteId,
        input.window,
        input.interval,
        input.filters,
        input.limit,
      ),
    }),
  );
  if (!result.ok) throw new Error(result.error.kind);
  return {
    interval: input.interval,
    series: result.data.series,
    points: result.data.data.map((point) => ({
      bucket: point.bucket,
      timestamp: new Date(point.timestampMs).toISOString(),
      totalEvents: point.totalEvents,
      eventsBySeries: point.eventsBySeries,
    })),
  };
}

export async function readSiteEventTypes(input: ReadSiteEventTypesInput) {
  const result = await executeTypedApplicationOperation(
    "event-types",
    inputBase(input),
    async () => ({
      value: {
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
      },
    }),
  );
  if (!result.ok) throw new Error(result.error.kind);
  return result.data;
}

export async function readSiteEventFields(input: ReadSiteEventFieldsInput) {
  const result = await executeTypedApplicationOperation(
    "event-fields",
    inputBase(input),
    async () => ({
      value: {
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
      },
    }),
  );
  if (!result.ok) throw new Error(result.error.kind);
  return result.data;
}

export async function readSiteEventFieldValues(
  input: ReadSiteEventFieldValuesInput,
) {
  const result = await executeTypedApplicationOperation(
    "event-field-values",
    inputBase(input),
    async () => ({
      value: {
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
      },
    }),
  );
  if (!result.ok) throw new Error(result.error.kind);
  return result.data;
}

export async function readSiteEventTypeDetail(
  input: ReadSiteEventTypeDetailInput,
) {
  const result = await executeTypedApplicationOperation(
    "event-type-detail",
    inputBase(input),
    async () => {
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
        value: {
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
            pages: mapTabs(overview.breakdowns.pages).map((item) => ({
              ...item,
            })),
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
        },
      };
    },
  );
  if (!result.ok) throw new Error(result.error.kind);
  return result.data;
}
