import type { AnalyticsProviderRegistry } from "@/lib/edge/analytics/application/provider-registry";
import { typedQueryProviderFor } from "@/lib/edge/analytics/application/provider-registry";
import { EMPTY_FILTER_DOCUMENT } from "@/lib/edge/analytics/contract";
import {
  deferredEventContextQualificationFromQuery,
  deferredEventFieldsQualificationFromQuery,
  deferredEventFieldValuesQualificationFromQuery,
  deferredEventRecordsQualificationFromQuery,
  deferredEventSummaryQualificationFromQuery,
  deferredEventTrendQualificationFromQuery,
  deferredEventTypeDetailQualificationFromQuery,
  deferredEventTypesQualificationFromQuery,
  prepareDeferredEventQualificationFallback,
} from "@/lib/edge/analytics/providers/d1/internal/advanced-filter-execution";
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
  preflightQualifiedEventFieldsCursorFromD1,
  preflightQualifiedEventFieldValuesCursorFromD1,
  queryEventFieldsPageFromD1,
  queryEventFieldValuesPageFromD1,
  queryQualifiedEventFieldsPageFromD1,
  queryQualifiedEventFieldValuesPageFromD1,
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
import { queryEventTypeDetailQualificationFromD1 } from "@/lib/edge/analytics/providers/d1/internal/events-type-detail";
import { readSiteEventRecords } from "@/lib/edge/analytics/providers/d1/operations/site-event-records";
import { InvalidCursorError } from "@/lib/pagination";

import {
  arrayField,
  type D1SiteRuntimeBindings,
  emptyEventContextCards,
  measured,
  numberField,
  stringField,
  timeWindow,
} from "./shared";

export function registerEventProviders(
  registry: AnalyticsProviderRegistry,
  options: D1SiteRuntimeBindings,
): void {
  registry
    .register(
      "event-types",
      typedQueryProviderFor("event-types", async (input) => {
        const request = input;
        const limit = numberField(request, "limit", 20);
        const search = stringField(request, "search") || undefined;
        const cursorText = stringField(request, "cursor") || null;
        const deferredQualification =
          deferredEventTypesQualificationFromQuery(request);
        const window = timeWindow(request.time);
        const filters = request.filters ?? EMPTY_FILTER_DOCUMENT;
        let cursor: Awaited<ReturnType<typeof decodeEventTypeCursor>>;
        try {
          cursor = await decodeEventTypeCursor(
            options.env,
            options.siteId,
            window,
            filters,
            search,
            cursorText,
            request.context.policy.audience,
          );
        } catch (error) {
          if (
            cursorText &&
            deferredQualification &&
            error instanceof InvalidCursorError
          )
            await prepareDeferredEventQualificationFallback(
              deferredQualification,
            );
          throw error;
        }
        if (cursorText && !cursor) {
          if (deferredQualification)
            await prepareDeferredEventQualificationFallback(
              deferredQualification,
            );
          throw new InvalidCursorError("event-types");
        }
        const page = await queryEventTypePageFromD1(
          options.env,
          options.siteId,
          window,
          filters,
          limit,
          search,
          cursor,
          request.context.policy.audience,
          {
            ...(deferredQualification ? { deferredQualification } : {}),
            ...(options.diagnostics
              ? { diagnostics: options.diagnostics }
              : {}),
          },
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
      typedQueryProviderFor("event-summary", async (input) => {
        const request = input;
        const deferredQualification =
          deferredEventSummaryQualificationFromQuery(request);
        const window = timeWindow(request.time);
        const filters = request.filters ?? EMPTY_FILTER_DOCUMENT;
        const data =
          deferredQualification || options.diagnostics
            ? await queryEventsSummaryFromD1(
                options.env,
                options.siteId,
                window,
                filters,
                {
                  ...(deferredQualification ? { deferredQualification } : {}),
                  ...(options.diagnostics
                    ? { diagnostics: options.diagnostics }
                    : {}),
                },
              )
            : await queryEventsSummaryFromD1(
                options.env,
                options.siteId,
                window,
                filters,
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
      typedQueryProviderFor("event-trend", async (input) => {
        const request = input;
        const interval = request.interval ?? "day";
        const deferredQualification =
          deferredEventTrendQualificationFromQuery(request);
        const eventName = stringField(request, "eventName") || undefined;
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
              eventName,
              ...(deferredQualification || options.diagnostics
                ? [
                    {
                      ...(deferredQualification
                        ? { deferredQualification }
                        : {}),
                      ...(options.diagnostics
                        ? { diagnostics: options.diagnostics }
                        : {}),
                    },
                  ]
                : []),
            )),
          },
        };
      }),
    )
    .register(
      "event-records",
      typedQueryProviderFor("event-records", async (input) => {
        const request = input;
        const deferredQualification =
          deferredEventRecordsQualificationFromQuery(request);
        return {
          value: await readSiteEventRecords({
            env: options.env,
            siteId: options.siteId,
            window: timeWindow(request.time),
            filters: request.filters ?? EMPTY_FILTER_DOCUMENT,
            scopePlan: request.scopePlan,
            queryTime: request.time,
            audience: request.context.policy.audience,
            sort: {
              field: "occurredAt",
              direction: request.sort?.direction ?? "desc",
            },
            search: stringField(request, "search") || undefined,
            eventName: stringField(request, "eventName") || undefined,
            ...(deferredQualification ? { deferredQualification } : {}),
            ...(options.diagnostics
              ? { diagnostics: options.diagnostics }
              : {}),
            page: request.page ?? { limit: request.limit ?? 80, cursor: null },
          }),
        };
      }),
    )
    .register(
      "event-field-values",
      typedQueryProviderFor("event-field-values", async (input) => {
        const request = input;
        const deferredQualification =
          deferredEventFieldValuesQualificationFromQuery(request);
        const eventName = stringField(request, "eventName") || undefined;
        const fieldPath = stringField(request, "fieldPath");
        const fieldValueType = stringField(request, "fieldValueType");
        const limit = numberField(request, "limit", 25);
        const search = stringField(request, "search") || undefined;
        const window = timeWindow(request.time);
        const filters = request.filters ?? EMPTY_FILTER_DOCUMENT;
        const cursorText = stringField(request, "cursor") || null;
        const qualifiedInput = deferredQualification
          ? {
              env: options.env,
              siteId: options.siteId,
              window,
              queryTime: request.time,
              filters,
              ...(request.scopePlan ? { scopePlan: request.scopePlan } : {}),
              ...(eventName !== undefined ? { eventName } : {}),
              fieldPath,
              fieldValueType,
              ...(search !== undefined ? { search } : {}),
              limit,
              cursor: null,
              cursorToken: cursorText,
              audience: request.context.policy.audience,
              deferred: deferredQualification,
              ...(options.diagnostics
                ? { diagnostics: options.diagnostics }
                : {}),
            }
          : undefined;
        const preflightInvalidCursor = async () => {
          if (qualifiedInput)
            await preflightQualifiedEventFieldValuesCursorFromD1(
              qualifiedInput,
            );
        };
        let cursor: Awaited<ReturnType<typeof decodeEventFieldValueCursor>>;
        try {
          cursor = await decodeEventFieldValueCursor(
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
        } catch (error) {
          if (
            cursorText &&
            deferredQualification &&
            error instanceof InvalidCursorError
          )
            await preflightInvalidCursor();
          throw error;
        }
        if (cursorText && !cursor) {
          await preflightInvalidCursor();
          throw new InvalidCursorError("event-field-values");
        }
        const page = deferredQualification
          ? await queryQualifiedEventFieldValuesPageFromD1({
              ...qualifiedInput!,
              cursor,
            })
          : await queryEventFieldValuesPageFromD1(
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
            eventName,
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
      typedQueryProviderFor("event-fields", async (input) => {
        const request = input;
        const deferredQualification =
          deferredEventFieldsQualificationFromQuery(request);
        const eventName = stringField(request, "eventName") || undefined;
        const limit = numberField(request, "limit", 100);
        const window = timeWindow(request.time);
        const filters = request.filters ?? EMPTY_FILTER_DOCUMENT;
        const cursorText = stringField(request, "cursor") || null;
        let cursor: Awaited<ReturnType<typeof decodeEventFieldCursor>>;
        try {
          cursor = await decodeEventFieldCursor(
            options.env,
            options.siteId,
            window,
            filters,
            eventName,
            cursorText,
            request.context.policy.audience,
          );
        } catch (error) {
          if (
            cursorText &&
            deferredQualification &&
            error instanceof InvalidCursorError
          )
            await preflightQualifiedEventFieldsCursorFromD1({
              env: options.env,
              siteId: options.siteId,
              window,
              queryTime: request.time,
              filters,
              ...(request.scopePlan ? { scopePlan: request.scopePlan } : {}),
              ...(eventName !== undefined ? { eventName } : {}),
              limit,
              cursor: null,
              cursorToken: cursorText,
              audience: request.context.policy.audience,
              deferred: deferredQualification,
              ...(options.diagnostics
                ? { diagnostics: options.diagnostics }
                : {}),
            });
          throw error;
        }
        if (cursorText && !cursor) {
          if (deferredQualification)
            await preflightQualifiedEventFieldsCursorFromD1({
              env: options.env,
              siteId: options.siteId,
              window,
              queryTime: request.time,
              filters,
              ...(request.scopePlan ? { scopePlan: request.scopePlan } : {}),
              ...(eventName !== undefined ? { eventName } : {}),
              limit,
              cursor: null,
              cursorToken: cursorText,
              audience: request.context.policy.audience,
              deferred: deferredQualification,
              ...(options.diagnostics
                ? { diagnostics: options.diagnostics }
                : {}),
            });
          throw new InvalidCursorError("event-fields");
        }
        const page = deferredQualification
          ? await queryQualifiedEventFieldsPageFromD1({
              env: options.env,
              siteId: options.siteId,
              window,
              queryTime: request.time,
              filters,
              ...(request.scopePlan ? { scopePlan: request.scopePlan } : {}),
              ...(eventName !== undefined ? { eventName } : {}),
              limit,
              cursor,
              cursorToken: cursorText,
              audience: request.context.policy.audience,
              deferred: deferredQualification,
              ...(options.diagnostics
                ? { diagnostics: options.diagnostics }
                : {}),
            })
          : await queryEventFieldsPageFromD1(
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
      typedQueryProviderFor("event-context", async (input) => {
        const request = input;
        const deferredQualification =
          deferredEventContextQualificationFromQuery(request);
        const eventName = stringField(request, "eventName");
        const filters = request.filters ?? EMPTY_FILTER_DOCUMENT;
        const limit = numberField(request, "limit", 100);
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
                  filters,
                  limit,
                  eventName,
                  selectedKeys.length > 0 ? selectedKeys : undefined,
                  ...(deferredQualification || options.diagnostics
                    ? [
                        {
                          ...(deferredQualification
                            ? { deferredQualification }
                            : {}),
                          ...(options.diagnostics
                            ? { diagnostics: options.diagnostics }
                            : {}),
                        },
                      ]
                    : []),
                ),
              ),
            ),
          },
        };
      }),
    )
    .register(
      "event-type-detail",
      typedQueryProviderFor("event-type-detail", async (input) => {
        const request = input;
        const eventName = stringField(request, "eventName");
        const interval = request.interval ?? "day";
        const includeContext = request.includeContext !== false;
        const includeBreakdowns = request.includeBreakdowns !== false;
        const window = timeWindow(request.time);
        const filters = request.filters ?? EMPTY_FILTER_DOCUMENT;
        const deferredQualification =
          deferredEventTypeDetailQualificationFromQuery(request);
        const qualified = deferredQualification
          ? await measured("event_type_detail.qualification", () =>
              queryEventTypeDetailQualificationFromD1({
                env: options.env,
                siteId: options.siteId,
                window,
                filters,
                eventName,
                interval,
                includeBreakdowns,
                includeContext,
                deferred: deferredQualification,
                ...(options.diagnostics
                  ? { diagnostics: options.diagnostics }
                  : {}),
              }),
            )
          : null;
        const reports =
          qualified?.kind === "executed"
            ? qualified.reports
            : await (async () => {
                const reportFilters = deferredQualification
                  ? await prepareDeferredEventQualificationFallback(
                      deferredQualification,
                    )
                  : filters;
                const [overview, trend, cards] = await Promise.all([
                  measured("event_type_detail.overview", () =>
                    queryEventTypeOverviewFromD1(
                      options.env,
                      options.siteId,
                      window,
                      reportFilters,
                      eventName,
                      { includeBreakdowns },
                    ),
                  ),
                  measured("event_type_detail.trend", () =>
                    queryEventTypeTrendFromD1(
                      options.env,
                      options.siteId,
                      window,
                      interval,
                      reportFilters,
                      eventName,
                    ),
                  ),
                  includeContext
                    ? measured("event_type_detail.context_cards", () =>
                        queryEventAnalyticsContextCardsFromD1(
                          options.env,
                          options.siteId,
                          window,
                          reportFilters,
                          100,
                          eventName,
                        ),
                      )
                    : Promise.resolve(null),
                ]);
                return {
                  summary: overview.summary,
                  trend,
                  breakdowns: overview.breakdowns,
                  cards: cards ?? emptyEventContextCards(),
                };
              })();
        return {
          value: {
            eventName,
            summary: reports.summary,
            trend: reports.trend,
            breakdowns: {
              pages: mapTabs(reports.breakdowns.pages),
              countries: mapTabs(reports.breakdowns.countries),
              devices: mapTabs(reports.breakdowns.devices),
              browsers: mapTabs(reports.breakdowns.browsers),
            },
            cards: mapEventAnalyticsContextCards(reports.cards),
          },
        };
      }),
    )
    .register(
      "event-record-detail",
      typedQueryProviderFor("event-record-detail", async (input) => {
        const request = input;
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
