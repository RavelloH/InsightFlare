import { parseFilterUrlForAudience } from "@/lib/edge/analytics/contract";
import {
  createTypedQueryProviderRegistry,
  executeTypedApplicationOperation,
  siteQueryContext,
} from "@/lib/edge/analytics/contract";
import {
  badRequest,
  jsonResponseWith,
  mapEventAnalyticsContextCards,
  mapEventField,
  mapEventFieldValue,
  mapEventRecord,
  mapEventSummaryCards,
  mapTabs,
  parseEventFieldPath,
  parseEventFieldValueType,
  parseEventId,
  parseEventName,
  parseEventRecordSort,
  parseInterval,
  parseLimit,
  parseListSearch,
  parseQueryLimit,
  parseWindow,
  queryErrorResponse,
  type ResponseContext,
} from "@/lib/edge/analytics/providers/d1/internal/core";
import {
  EVENT_CONTEXT_CARD_KEYS,
  type EventContextCardKey,
  queryEventAnalyticsContextCardsFromD1,
} from "@/lib/edge/analytics/providers/d1/internal/events-context";
import { queryEventFieldsFromD1 } from "@/lib/edge/analytics/providers/d1/internal/events-fields";
import { queryEventFieldValuesFromD1 } from "@/lib/edge/analytics/providers/d1/internal/events-fields";
import { queryEventTypeOverviewFromD1 } from "@/lib/edge/analytics/providers/d1/internal/events-overview";
import { queryEventRecordDetailFromD1 } from "@/lib/edge/analytics/providers/d1/internal/events-records";
import {
  parseEventRecordCursor,
  queryEventRecordPageFromD1,
  serializeEventRecordCursor,
} from "@/lib/edge/analytics/providers/d1/internal/events-records";
import { queryEventTypeAggregate } from "@/lib/edge/analytics/providers/d1/internal/events-summary";
import { queryEventsSummaryFromD1 } from "@/lib/edge/analytics/providers/d1/internal/events-summary";
import { queryEventsTrendFromD1 } from "@/lib/edge/analytics/providers/d1/internal/events-trend";
import { queryEventTypeTrendFromD1 } from "@/lib/edge/analytics/providers/d1/internal/events-trend";
import { toQueryTime } from "@/lib/edge/analytics/providers/d1/operations/overview-reader";
import {
  currentInvocationLogger,
  runWithD1Operation,
} from "@/lib/edge/observability-logger";
import type { Env } from "@/lib/edge/types";

export async function handleEventTypesContract(
  env: Env,
  siteId: string,
  url: URL,
  ctx?: ResponseContext,
  queryContext = siteQueryContext(siteId, "private-dashboard"),
): Promise<Response> {
  const window = parseWindow(url);
  if (!window) return badRequest("Invalid time window");
  const filters = parseFilterUrlForAudience(queryContext.policy.audience, url);
  const result = await executeTypedApplicationOperation<
    ReturnType<typeof mapTabs>
  >(
    "event-types",
    {
      context: queryContext,
      time: toQueryTime(window),
      filters: filters,
    },
    createTypedQueryProviderRegistry("event-types", async () => ({
      value: mapTabs(
        await queryEventTypeAggregate(
          env,
          siteId,
          window,
          filters,
          parseLimit(url, 20, 200),
        ),
      ),
    })),
  );
  if (!result.ok) return queryErrorResponse(result.error);
  return jsonResponseWith(ctx!, { ok: true, data: result.data });
}

export async function handleEventsSummaryContract(
  env: Env,
  siteId: string,
  url: URL,
  ctx?: ResponseContext,
  queryContext = siteQueryContext(siteId, "private-dashboard"),
): Promise<Response> {
  const window = parseWindow(url);
  if (!window) return badRequest("Invalid time window");
  const filters = parseFilterUrlForAudience(queryContext.policy.audience, url);
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
    {
      context: queryContext,
      time: toQueryTime(window),
      filters: filters,
    },
    createTypedQueryProviderRegistry("event-summary", async () => {
      const data = await queryEventsSummaryFromD1(env, siteId, window, filters);
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
  if (!result.ok) return queryErrorResponse(result.error);
  return jsonResponseWith(ctx!, { ok: true, ...result.data });
}

export async function handleEventsTrendContract(
  env: Env,
  siteId: string,
  url: URL,
  ctx?: ResponseContext,
  queryContext = siteQueryContext(siteId, "private-dashboard"),
): Promise<Response> {
  const window = parseWindow(url);
  if (!window) return badRequest("Invalid time window");
  const interval = parseInterval(url);
  const filters = parseFilterUrlForAudience(queryContext.policy.audience, url);
  const result = await executeTypedApplicationOperation<
    { readonly interval: ReturnType<typeof parseInterval> } & Awaited<
      ReturnType<typeof queryEventsTrendFromD1>
    >
  >(
    "event-trend",
    {
      context: queryContext,
      time: toQueryTime(window),
      filters: filters,
    },
    createTypedQueryProviderRegistry("event-trend", async () => ({
      value: {
        interval,
        ...(await queryEventsTrendFromD1(
          env,
          siteId,
          window,
          interval,
          filters,
          parseLimit(url, 8, 18),
          parseEventName(url),
        )),
      },
    })),
  );
  if (!result.ok) return queryErrorResponse(result.error);
  return jsonResponseWith(ctx!, { ok: true, ...result.data });
}

export async function handleEventRecordsContract(
  env: Env,
  siteId: string,
  url: URL,
  ctx?: ResponseContext,
  queryContext = siteQueryContext(siteId, "private-dashboard"),
): Promise<Response> {
  const window = parseWindow(url);
  if (!window) return badRequest("Invalid time window");
  const pageSize = parseQueryLimit(url, "pageSize", 80, 1, 1_000);
  const sort = parseEventRecordSort(url);
  const rawCursor = url.searchParams.get("cursor");
  const cursor = rawCursor ? parseEventRecordCursor(rawCursor, sort) : null;
  if (rawCursor && !cursor) return badRequest("Invalid cursor");
  const filters = parseFilterUrlForAudience(queryContext.policy.audience, url);
  const result = await executeTypedApplicationOperation<{
    readonly data: Array<ReturnType<typeof mapEventRecord>>;
    readonly meta: {
      readonly pageSize: number;
      readonly returned: number;
      readonly hasMore: boolean;
      readonly nextCursor: string | null;
    };
  }>(
    "event-records",
    {
      context: queryContext,
      time: toQueryTime(window),
      filters: filters,
    },
    createTypedQueryProviderRegistry("event-records", async () => {
      const page = await queryEventRecordPageFromD1(
        env,
        siteId,
        window,
        filters,
        {
          pageSize,
          sort,
          search: parseListSearch(url),
          eventName: parseEventName(url),
          cursor,
        },
      );
      return {
        value: {
          data: page.rows.map(mapEventRecord),
          meta: {
            pageSize,
            returned: page.rows.length,
            hasMore: page.nextCursor !== null,
            nextCursor: page.nextCursor
              ? serializeEventRecordCursor(page.nextCursor)
              : null,
          },
        },
      };
    }),
  );
  if (!result.ok) return queryErrorResponse(result.error);
  return jsonResponseWith(ctx!, { ok: true, ...result.data });
}

export async function handleEventFieldValuesContract(
  env: Env,
  siteId: string,
  url: URL,
  ctx?: ResponseContext,
  queryContext = siteQueryContext(siteId, "private-dashboard"),
): Promise<Response> {
  const eventName = parseEventName(url);
  const fieldPath = parseEventFieldPath(url);
  const fieldValueType = parseEventFieldValueType(url);
  if (!eventName) return badRequest("eventName is required");
  if (!fieldPath) return badRequest("fieldPath is required");
  if (!fieldValueType) return badRequest("fieldValueType is required");
  const window = parseWindow(url);
  if (!window) return badRequest("Invalid time window");
  const filters = parseFilterUrlForAudience(queryContext.policy.audience, url);
  const result = await executeTypedApplicationOperation<{
    readonly fieldPath: string;
    readonly fieldValueType: string;
    readonly data: Array<ReturnType<typeof mapEventFieldValue>>;
  }>(
    "event-field-values",
    {
      context: queryContext,
      time: toQueryTime(window),
      filters: filters,
    },
    createTypedQueryProviderRegistry("event-field-values", async () => ({
      value: {
        fieldPath,
        fieldValueType,
        data: (
          await queryEventFieldValuesFromD1(
            env,
            siteId,
            window,
            filters,
            eventName,
            fieldPath,
            fieldValueType,
            parseLimit(url, 25, 100),
            parseListSearch(url),
          )
        ).map(mapEventFieldValue),
      },
    })),
  );
  if (!result.ok) return queryErrorResponse(result.error);
  return jsonResponseWith(ctx!, { ok: true, ...result.data });
}

function parseEventContextCardKeys(url: URL): EventContextCardKey[] | null {
  const raw = url.searchParams.get("cards")?.trim();
  if (!raw) return null;
  const selected = [...new Set(raw.split(",").map((key) => key.trim()))];
  if (
    selected.length === 0 ||
    selected.length > EVENT_CONTEXT_CARD_KEYS.length ||
    selected.some(
      (key) => !EVENT_CONTEXT_CARD_KEYS.includes(key as EventContextCardKey),
    )
  ) {
    return null;
  }
  return selected as EventContextCardKey[];
}

function emptyEventContextCards() {
  return {
    page: { path: [], query: [], title: [], hostname: [], entry: [], exit: [] },
    source: { domain: [], link: [] },
    client: {
      browser: [],
      osVersion: [],
      deviceType: [],
      language: [],
      screenSize: [],
    },
    geo: {
      country: [],
      region: [],
      city: [],
      continent: [],
      timezone: [],
      organization: [],
    },
  };
}

function measured<T>(operation: string, action: () => Promise<T>): Promise<T> {
  const logger = currentInvocationLogger();
  return logger
    ? logger.measure(operation, () => runWithD1Operation(operation, action))
    : action();
}

export async function handleEventTypeFieldsContract(
  env: Env,
  siteId: string,
  url: URL,
  ctx?: ResponseContext,
  queryContext = siteQueryContext(siteId, "private-dashboard"),
): Promise<Response> {
  const eventName = parseEventName(url);
  if (!eventName) return badRequest("eventName is required");
  const window = parseWindow(url);
  if (!window) return badRequest("Invalid time window");
  const filters = parseFilterUrlForAudience(queryContext.policy.audience, url);
  const result = await executeTypedApplicationOperation<{
    readonly eventName: string;
    readonly fields: Array<ReturnType<typeof mapEventField>>;
  }>(
    "event-fields",
    {
      context: queryContext,
      time: toQueryTime(window),
      filters: filters,
    },
    createTypedQueryProviderRegistry("event-fields", async () => ({
      value: {
        eventName,
        fields: (
          await measured("event_type_fields", () =>
            queryEventFieldsFromD1(
              env,
              siteId,
              window,
              filters,
              eventName,
              100,
            ),
          )
        ).map(mapEventField),
      },
    })),
  );
  if (!result.ok) return queryErrorResponse(result.error);
  return jsonResponseWith(ctx!, { ok: true, ...result.data });
}

export async function handleEventTypeContextContract(
  env: Env,
  siteId: string,
  url: URL,
  ctx?: ResponseContext,
  queryContext = siteQueryContext(siteId, "private-dashboard"),
): Promise<Response> {
  const eventName = parseEventName(url);
  if (!eventName) return badRequest("eventName is required");
  const window = parseWindow(url);
  if (!window) return badRequest("Invalid time window");
  const selectedKeys = parseEventContextCardKeys(url);
  if (!selectedKeys) return badRequest("Valid context cards are required");
  const filters = parseFilterUrlForAudience(queryContext.policy.audience, url);
  const result = await executeTypedApplicationOperation<{
    readonly eventName: string;
    readonly cards: ReturnType<typeof mapEventAnalyticsContextCards>;
  }>(
    "event-context",
    {
      context: queryContext,
      time: toQueryTime(window),
      filters: filters,
    },
    createTypedQueryProviderRegistry("event-context", async () => ({
      value: {
        eventName,
        cards: mapEventAnalyticsContextCards(
          await measured("event_type_context", () =>
            queryEventAnalyticsContextCardsFromD1(
              env,
              siteId,
              window,
              filters,
              100,
              eventName,
              selectedKeys,
            ),
          ),
        ),
      },
    })),
  );
  if (!result.ok) return queryErrorResponse(result.error);
  return jsonResponseWith(ctx!, { ok: true, ...result.data });
}

export async function handleEventTypeDetailContract(
  env: Env,
  siteId: string,
  url: URL,
  ctx?: ResponseContext,
  queryContext = siteQueryContext(siteId, "private-dashboard"),
  options?: {
    includeContext?: boolean;
    includeBreakdowns?: boolean;
    includeFields?: boolean;
  },
): Promise<Response> {
  const eventName = parseEventName(url);
  if (!eventName) return badRequest("eventName is required");
  const window = parseWindow(url);
  if (!window) return badRequest("Invalid time window");
  const filters = parseFilterUrlForAudience(queryContext.policy.audience, url);
  const includeContext = options?.includeContext ?? true;
  const includeBreakdowns = options?.includeBreakdowns ?? true;
  const includeFields = options?.includeFields ?? true;
  const result = await executeTypedApplicationOperation<{
    readonly eventName: string;
    readonly summary: Awaited<
      ReturnType<typeof queryEventTypeOverviewFromD1>
    >["summary"];
    readonly trend: Awaited<ReturnType<typeof queryEventTypeTrendFromD1>>;
    readonly breakdowns: {
      readonly pages: ReturnType<typeof mapTabs>;
      readonly countries: ReturnType<typeof mapTabs>;
      readonly devices: ReturnType<typeof mapTabs>;
      readonly browsers: ReturnType<typeof mapTabs>;
    };
    readonly cards: ReturnType<typeof mapEventAnalyticsContextCards>;
    readonly fields: Array<ReturnType<typeof mapEventField>>;
  }>(
    "event-type-detail",
    {
      context: queryContext,
      time: toQueryTime(window),
      filters: filters,
    },
    createTypedQueryProviderRegistry("event-type-detail", async () => {
      const [overview, trend, fields, cards] = await Promise.all([
        measured("event_type_detail.overview", () =>
          queryEventTypeOverviewFromD1(
            env,
            siteId,
            window,
            filters,
            eventName,
            { includeBreakdowns },
          ),
        ),
        measured("event_type_detail.trend", () =>
          queryEventTypeTrendFromD1(
            env,
            siteId,
            window,
            parseInterval(url),
            filters,
            eventName,
          ),
        ),
        includeFields
          ? measured("event_type_detail.fields", () =>
              queryEventFieldsFromD1(
                env,
                siteId,
                window,
                filters,
                eventName,
                100,
              ),
            )
          : Promise.resolve([]),
        includeContext
          ? measured("event_type_detail.context_cards", () =>
              queryEventAnalyticsContextCardsFromD1(
                env,
                siteId,
                window,
                filters,
                100,
                eventName,
              ),
            )
          : Promise.resolve(emptyEventContextCards()),
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
          cards: mapEventAnalyticsContextCards(cards),
          fields: fields.map(mapEventField),
        },
      };
    }),
  );
  if (!result.ok) return queryErrorResponse(result.error);
  return jsonResponseWith(ctx!, { ok: true, ...result.data });
}

export async function handleEventRecordDetailContract(
  env: Env,
  siteId: string,
  url: URL,
  ctx?: ResponseContext,
  queryContext = siteQueryContext(siteId, "private-dashboard"),
): Promise<Response> {
  const eventId = parseEventId(url);
  if (!eventId) return badRequest("eventId is required");
  const window = parseWindow(url);
  if (!window) return badRequest("Invalid time window");
  const result = await executeTypedApplicationOperation<
    Awaited<ReturnType<typeof queryEventRecordDetailFromD1>>
  >(
    "event-record-detail",
    {
      context: queryContext,
      time: toQueryTime(window),
      filters: { version: 1, root: null },
    },
    createTypedQueryProviderRegistry("event-record-detail", async () => ({
      value: await queryEventRecordDetailFromD1(env, siteId, eventId, window),
    })),
  );
  if (!result.ok) return queryErrorResponse(result.error);
  return jsonResponseWith(ctx!, { ok: true, data: result.data });
}
