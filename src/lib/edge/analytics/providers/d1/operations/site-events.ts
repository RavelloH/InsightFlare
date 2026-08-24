import "@tanstack/react-start/server-only";

import {
  analyticsFilterRegistry,
  assertFilterAudience,
  createTypedQueryProviderRegistry,
  executeTypedApplicationOperation,
  type FilterDocument,
  siteQueryContext,
  validateTypedQueryFilters,
} from "@/lib/edge/analytics/contract";
import { createQueryTime } from "@/lib/edge/analytics/contract/helpers";
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
import { queryEventsSummaryFromD1 } from "@/lib/edge/analytics/providers/d1/internal/events-summary";
import { queryEventTypeAggregate } from "@/lib/edge/analytics/providers/d1/internal/events-summary";
import { queryEventsTrendFromD1 } from "@/lib/edge/analytics/providers/d1/internal/events-trend";
import { queryEventTypeTrendFromD1 } from "@/lib/edge/analytics/providers/d1/internal/events-trend";
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
  const result = await executeTypedApplicationOperation<{
    readonly summary: {
      readonly events: number;
      readonly eventTypes: number;
      readonly sessions: number;
      readonly visitors: number;
      readonly avgEventsPerSession: number;
    };
    readonly cards: ReturnType<typeof mapEventSummaryCards>;
  }>(
    "event-summary",
    inputBase(input),
    createTypedQueryProviderRegistry("event-summary", async () => {
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
    }),
  );
  if (!result.ok) throw new Error(result.error.kind);
  return result.data;
}

export async function readSiteEventsTimeseries(
  input: ReadSiteEventsTimeseriesInput,
) {
  const result = await executeTypedApplicationOperation<
    Awaited<ReturnType<typeof queryEventsTrendFromD1>>
  >(
    "event-trend",
    inputBase(input),
    createTypedQueryProviderRegistry("event-trend", async () => ({
      value: await queryEventsTrendFromD1(
        input.env,
        input.siteId,
        input.window,
        input.interval,
        input.filters,
        input.limit,
      ),
    })),
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
  const result = await executeTypedApplicationOperation<{
    readonly items: Array<{
      readonly key: string;
      readonly label: string;
      readonly events: number;
      readonly sessions: number;
      readonly visitors: number;
    }>;
    readonly page: { readonly limit: number };
  }>(
    "event-types",
    inputBase(input),
    createTypedQueryProviderRegistry("event-types", async () => ({
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
    })),
  );
  if (!result.ok) throw new Error(result.error.kind);
  return result.data;
}

export async function readSiteEventFields(input: ReadSiteEventFieldsInput) {
  const result = await executeTypedApplicationOperation<{
    readonly eventName: string;
    readonly fields: ReturnType<typeof mapEventField>[];
    readonly page: { readonly limit: number };
  }>(
    "event-fields",
    inputBase(input),
    createTypedQueryProviderRegistry("event-fields", async () => ({
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
    })),
  );
  if (!result.ok) throw new Error(result.error.kind);
  return result.data;
}

export async function readSiteEventFieldValues(
  input: ReadSiteEventFieldValuesInput,
) {
  const result = await executeTypedApplicationOperation<{
    readonly eventName: string;
    readonly fieldPath: string;
    readonly fieldValueType: string;
    readonly items: ReturnType<typeof mapEventFieldValue>[];
    readonly page: { readonly limit: number };
  }>(
    "event-field-values",
    inputBase(input),
    createTypedQueryProviderRegistry("event-field-values", async () => ({
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
    })),
  );
  if (!result.ok) throw new Error(result.error.kind);
  return result.data;
}

export async function readSiteEventTypeDetail(
  input: ReadSiteEventTypeDetailInput,
) {
  const result = await executeTypedApplicationOperation<{
    readonly eventName: string;
    readonly summary: Awaited<
      ReturnType<typeof queryEventTypeOverviewFromD1>
    >["summary"];
    readonly trend: {
      readonly data: Array<{
        readonly bucket: number;
        readonly timestamp: string;
        readonly events: number;
        readonly visitors: number;
      }>;
    };
    readonly breakdowns: {
      readonly pages: ReturnType<typeof mapTabs>;
      readonly countries: ReturnType<typeof mapTabs>;
      readonly devices: ReturnType<typeof mapTabs>;
      readonly browsers: ReturnType<typeof mapTabs>;
    };
    readonly cards: ReturnType<typeof mapEventAnalyticsContextCards>;
    readonly fields: ReturnType<typeof mapEventField>[];
  }>(
    "event-type-detail",
    inputBase(input),
    createTypedQueryProviderRegistry("event-type-detail", async () => {
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
    }),
  );
  if (!result.ok) throw new Error(result.error.kind);
  return result.data;
}
