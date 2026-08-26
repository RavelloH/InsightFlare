import type { AnalyticsProviderRegistry } from "@/lib/edge/analytics/application/provider-registry";
import { typedQueryProvider } from "@/lib/edge/analytics/application/provider-registry";
import { EMPTY_FILTER_DOCUMENT } from "@/lib/edge/analytics/contract";
import {
  mapEventAnalyticsContextCards,
  mapEventField,
  mapEventFieldValue,
  mapEventRecord,
  mapEventSummaryCards,
  mapTabs,
} from "@/lib/edge/analytics/providers/d1/internal/core";
import {
  EVENT_CONTEXT_CARD_KEYS,
  queryEventAnalyticsContextCardsFromD1,
} from "@/lib/edge/analytics/providers/d1/internal/events-context";
import {
  queryEventFieldsFromD1,
  queryEventFieldValuesFromD1,
} from "@/lib/edge/analytics/providers/d1/internal/events-fields";
import { queryEventTypeOverviewFromD1 } from "@/lib/edge/analytics/providers/d1/internal/events-overview";
import {
  queryEventRecordDetailFromD1,
  queryEventRecordPageFromD1,
  serializeEventRecordCursor,
} from "@/lib/edge/analytics/providers/d1/internal/events-records";
import {
  queryEventsSummaryFromD1,
  queryEventTypeAggregate,
} from "@/lib/edge/analytics/providers/d1/internal/events-summary";
import {
  queryEventsTrendFromD1,
  queryEventTypeTrendFromD1,
} from "@/lib/edge/analytics/providers/d1/internal/events-trend";

import {
  arrayField,
  type D1SiteQueryRuntimeOptions,
  emptyEventContextCards,
  measured,
  numberField,
  query,
  stringField,
  timeWindow,
} from "./shared";

export function registerEventProviders(
  registry: AnalyticsProviderRegistry,
  options: D1SiteQueryRuntimeOptions,
): void {
  registry
    .register(
      "event-types",
      typedQueryProvider(async (input) => {
        const request = query(input!);
        return {
          value: mapTabs(
            await queryEventTypeAggregate(
              options.env,
              options.siteId,
              timeWindow(request.time),
              request.filters ?? EMPTY_FILTER_DOCUMENT,
              numberField(request, "limit", 20),
              stringField(request, "search") || undefined,
            ),
          ),
        };
      }),
    )
    .register(
      "event-summary",
      typedQueryProvider(async (input) => {
        const request = query(input!);
        const data = await queryEventsSummaryFromD1(
          options.env,
          options.siteId,
          timeWindow(request.time),
          request.filters ?? EMPTY_FILTER_DOCUMENT,
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
    )
    .register(
      "event-trend",
      typedQueryProvider(async (input) => {
        const request = query(input!);
        const interval = request.interval as never;
        return {
          value: {
            interval,
            ...(await queryEventsTrendFromD1(
              options.env,
              options.siteId,
              timeWindow(request.time),
              interval,
              request.filters ?? EMPTY_FILTER_DOCUMENT,
              numberField(request, "limit", 8),
              stringField(request, "eventName") || undefined,
            )),
          },
        };
      }),
    )
    .register(
      "event-records",
      typedQueryProvider(async (input) => {
        const request = query(input!);
        const page = await queryEventRecordPageFromD1(
          options.env,
          options.siteId,
          timeWindow(request.time),
          request.filters ?? EMPTY_FILTER_DOCUMENT,
          {
            pageSize: numberField(request, "pageSize", 80),
            sort: request.sort as never,
            search: stringField(request, "search") || undefined,
            eventName: stringField(request, "eventName") || undefined,
            cursor: (request.cursor as never) ?? null,
          },
        );
        return {
          value: {
            data: page.rows.map(mapEventRecord),
            meta: {
              pageSize: numberField(request, "pageSize", 80),
              returned: page.rows.length,
              hasMore: page.nextCursor !== null,
              nextCursor: page.nextCursor
                ? serializeEventRecordCursor(page.nextCursor)
                : null,
            },
          },
        };
      }),
    )
    .register(
      "event-field-values",
      typedQueryProvider(async (input) => {
        const request = query(input!);
        const eventName = stringField(request, "eventName") || undefined;
        const fieldPath = stringField(request, "fieldPath");
        const fieldValueType = stringField(request, "fieldValueType");
        return {
          value: {
            fieldPath,
            fieldValueType,
            data: (
              await queryEventFieldValuesFromD1(
                options.env,
                options.siteId,
                timeWindow(request.time),
                request.filters ?? EMPTY_FILTER_DOCUMENT,
                eventName,
                fieldPath,
                fieldValueType,
                numberField(request, "limit", 25),
                stringField(request, "search") || undefined,
              )
            ).map(mapEventFieldValue),
          },
        };
      }),
    )
    .register(
      "event-fields",
      typedQueryProvider(async (input) => {
        const request = query(input!);
        const eventName = stringField(request, "eventName") || undefined;
        return {
          value: {
            eventName,
            fields: (
              await measured("event_type_fields", () =>
                queryEventFieldsFromD1(
                  options.env,
                  options.siteId,
                  timeWindow(request.time),
                  request.filters ?? EMPTY_FILTER_DOCUMENT,
                  eventName,
                  numberField(request, "limit", 100),
                ),
              )
            ).map(mapEventField),
          },
        };
      }),
    )
    .register(
      "event-context",
      typedQueryProvider(async (input) => {
        const request = query(input!);
        const eventName = stringField(request, "eventName");
        const selectedKeys = arrayField(request, "selectedKeys").filter(
          (key): key is (typeof EVENT_CONTEXT_CARD_KEYS)[number] =>
            typeof key === "string" &&
            EVENT_CONTEXT_CARD_KEYS.includes(
              key as (typeof EVENT_CONTEXT_CARD_KEYS)[number],
            ),
        );
        return {
          value: {
            eventName,
            cards: mapEventAnalyticsContextCards(
              await measured("event_type_context", () =>
                queryEventAnalyticsContextCardsFromD1(
                  options.env,
                  options.siteId,
                  timeWindow(request.time),
                  request.filters ?? EMPTY_FILTER_DOCUMENT,
                  numberField(request, "limit", 100),
                  eventName,
                  selectedKeys.length > 0 ? selectedKeys : undefined,
                ),
              ),
            ),
          },
        };
      }),
    )
    .register(
      "event-type-detail",
      typedQueryProvider(async (input) => {
        const request = query(input!);
        const eventName = stringField(request, "eventName");
        const includeContext = request.includeContext !== false;
        const includeBreakdowns = request.includeBreakdowns !== false;
        const includeFields = request.includeFields !== false;
        const [overview, trend, fields, cards] = await Promise.all([
          measured("event_type_detail.overview", () =>
            queryEventTypeOverviewFromD1(
              options.env,
              options.siteId,
              timeWindow(request.time),
              request.filters ?? EMPTY_FILTER_DOCUMENT,
              eventName,
              { includeBreakdowns },
            ),
          ),
          measured("event_type_detail.trend", () =>
            queryEventTypeTrendFromD1(
              options.env,
              options.siteId,
              timeWindow(request.time),
              request.interval as never,
              request.filters ?? EMPTY_FILTER_DOCUMENT,
              eventName,
            ),
          ),
          includeFields
            ? measured("event_type_detail.fields", () =>
                queryEventFieldsFromD1(
                  options.env,
                  options.siteId,
                  timeWindow(request.time),
                  request.filters ?? EMPTY_FILTER_DOCUMENT,
                  eventName,
                  100,
                ),
              )
            : Promise.resolve([]),
          includeContext
            ? measured("event_type_detail.context_cards", () =>
                queryEventAnalyticsContextCardsFromD1(
                  options.env,
                  options.siteId,
                  timeWindow(request.time),
                  request.filters ?? EMPTY_FILTER_DOCUMENT,
                  100,
                  eventName,
                ),
              )
            : Promise.resolve(null),
        ]);
        return {
          value: {
            eventName,
            summary: overview.summary,
            trend,
            breakdowns: {
              pages: mapTabs(overview.breakdowns.pages),
              countries: mapTabs(overview.breakdowns.countries),
              devices: mapTabs(overview.breakdowns.devices),
              browsers: mapTabs(overview.breakdowns.browsers),
            },
            cards: cards
              ? mapEventAnalyticsContextCards(cards)
              : emptyEventContextCards(),
            fields: fields.map(mapEventField),
          },
        };
      }),
    )
    .register(
      "event-record-detail",
      typedQueryProvider(async (input) => {
        const request = query(input!);
        return {
          value: await queryEventRecordDetailFromD1(
            options.env,
            options.siteId,
            stringField(request, "eventId"),
            timeWindow(request.time),
          ),
        };
      }),
    );
}
