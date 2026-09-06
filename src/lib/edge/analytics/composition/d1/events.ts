import type { AnalyticsProviderRegistry } from "@/lib/edge/analytics/application/provider-registry";
import { typedQueryProvider } from "@/lib/edge/analytics/application/provider-registry";
import { EMPTY_FILTER_DOCUMENT } from "@/lib/edge/analytics/contract";
import {
  mapEventAnalyticsContextCards,
  mapEventField,
  mapEventFieldValue,
  mapEventSummaryCards,
  mapTabs,
} from "@/lib/edge/analytics/providers/d1/internal/core";
import {
  EVENT_CONTEXT_CARD_KEYS,
  queryEventAnalyticsContextCardsFromD1,
} from "@/lib/edge/analytics/providers/d1/internal/events-context";
import {
  queryEventFieldsPageFromD1,
  queryEventFieldValuesPageFromD1,
} from "@/lib/edge/analytics/providers/d1/internal/events-fields";
import {
  decodeEventFieldCursor,
  decodeEventFieldValueCursor,
} from "@/lib/edge/analytics/providers/d1/internal/events-fields";
import { queryEventTypeOverviewFromD1 } from "@/lib/edge/analytics/providers/d1/internal/events-overview";
import { queryEventRecordDetailFromD1 } from "@/lib/edge/analytics/providers/d1/internal/events-records";
import {
  decodeEventTypeCursor,
  queryEventsSummaryFromD1,
  queryEventTypePageFromD1,
} from "@/lib/edge/analytics/providers/d1/internal/events-summary";
import {
  queryEventsTrendFromD1,
  queryEventTypeTrendFromD1,
} from "@/lib/edge/analytics/providers/d1/internal/events-trend";
import { readSiteEventRecords } from "@/lib/edge/analytics/providers/d1/operations/site-event-records";
import { InvalidCursorError } from "@/lib/pagination";

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
        const limit = numberField(request, "limit", 20);
        const search = stringField(request, "search") || undefined;
        const cursorText = stringField(request, "cursor") || null;
        const window = timeWindow(request.time);
        const filters = request.filters ?? EMPTY_FILTER_DOCUMENT;
        const cursor = await decodeEventTypeCursor(
          options.env,
          options.siteId,
          window,
          filters,
          search,
          cursorText,
          request.context.policy.audience,
        );
        if (cursorText && !cursor) throw new InvalidCursorError("event-types");
        const page = await queryEventTypePageFromD1(
          options.env,
          options.siteId,
          window,
          filters,
          limit,
          search,
          cursor,
          request.context.policy.audience,
        );
        return {
          value: {
            items: mapTabs([...page.items]),
            pagination: page.pagination,
          },
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
        return {
          value: await readSiteEventRecords({
            env: options.env,
            siteId: options.siteId,
            window: timeWindow(request.time),
            filters: request.filters ?? EMPTY_FILTER_DOCUMENT,
            audience: request.context.policy.audience,
            sort: (request.sort as never) ?? {
              field: "occurredAt",
              direction: "desc",
            },
            search: stringField(request, "search") || undefined,
            eventName: stringField(request, "eventName") || undefined,
            page:
              request.page && typeof request.page === "object"
                ? (request.page as { limit: number; cursor?: string | null })
                : { limit: numberField(request, "limit", 80), cursor: null },
          }),
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
        const limit = numberField(request, "limit", 25);
        const search = stringField(request, "search") || undefined;
        const window = timeWindow(request.time);
        const filters = request.filters ?? EMPTY_FILTER_DOCUMENT;
        const cursorText = stringField(request, "cursor") || null;
        const cursor = await decodeEventFieldValueCursor(
          options.env,
          options.siteId,
          window,
          filters,
          eventName,
          fieldPath,
          fieldValueType,
          search,
          cursorText,
          request.context.policy.audience,
        );
        if (cursorText && !cursor)
          throw new InvalidCursorError("event-field-values");
        const page = await queryEventFieldValuesPageFromD1(
          options.env,
          options.siteId,
          window,
          filters,
          eventName,
          fieldPath,
          fieldValueType,
          limit,
          search,
          cursor,
          request.context.policy.audience,
        );
        return {
          value: {
            fieldPath,
            fieldValueType,
            data: {
              items: page.items.map(mapEventFieldValue),
              pagination: page.pagination,
            },
          },
        };
      }),
    )
    .register(
      "event-fields",
      typedQueryProvider(async (input) => {
        const request = query(input!);
        const eventName = stringField(request, "eventName") || undefined;
        const limit = numberField(request, "limit", 100);
        const window = timeWindow(request.time);
        const filters = request.filters ?? EMPTY_FILTER_DOCUMENT;
        const cursorText = stringField(request, "cursor") || null;
        const cursor = await decodeEventFieldCursor(
          options.env,
          options.siteId,
          window,
          filters,
          eventName,
          cursorText,
          request.context.policy.audience,
        );
        if (cursorText && !cursor) throw new InvalidCursorError("event-fields");
        const page = await queryEventFieldsPageFromD1(
          options.env,
          options.siteId,
          window,
          filters,
          eventName,
          limit,
          cursor,
          request.context.policy.audience,
        );
        return {
          value: {
            eventName,
            data: {
              items: page.items.map(mapEventField),
              pagination: page.pagination,
            },
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
        const [overview, trend, cards] = await Promise.all([
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
