import {
  currentInvocationLogger,
  runWithD1Operation,
} from "@/lib/edge/observability-logger";
import type { Env } from "@/lib/edge/types";

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
  parseFilters,
  parseInterval,
  parseLimit,
  parseListSearch,
  parseQueryLimit,
  parseWindow,
  type ResponseContext,
} from "./core";
import {
  EVENT_CONTEXT_CARD_KEYS,
  type EventContextCardKey,
  queryEventAnalyticsContextCardsFromD1,
  queryEventDimensionRowsFromFilteredEvents,
  queryEventGeoRowsFromFilteredEvents,
  queryEventSessionBoundaryRowsFromFilteredEvents,
} from "./events-context";
import {
  queryEventFieldsFromD1,
  queryEventFieldValuesFromD1,
} from "./events-fields";
import { queryEventTypeOverviewFromD1 } from "./events-overview";
import {
  parseEventRecordCursor,
  queryEventRecordDetailFromD1,
  queryEventRecordPageFromD1,
  queryEventRecordsFromD1,
  serializeEventRecordCursor,
} from "./events-records";
import {
  queryEventsSummaryFromD1,
  queryEventSummaryMetricsFromD1,
  queryEventTypeAggregate,
} from "./events-summary";
import {
  queryEventsTrendFromD1,
  queryEventTypeTrendFromD1,
} from "./events-trend";

export {
  queryEventAnalyticsContextCardsFromD1,
  queryEventDimensionRowsFromFilteredEvents,
  queryEventFieldsFromD1,
  queryEventFieldValuesFromD1,
  queryEventGeoRowsFromFilteredEvents,
  queryEventRecordDetailFromD1,
  queryEventRecordsFromD1,
  queryEventSessionBoundaryRowsFromFilteredEvents,
  queryEventsSummaryFromD1,
  queryEventsTrendFromD1,
  queryEventSummaryMetricsFromD1,
  queryEventTypeAggregate,
  queryEventTypeOverviewFromD1,
  queryEventTypeTrendFromD1,
};

export async function handleEventTypes(
  env: Env,
  siteId: string,
  url: URL,
  ctx?: ResponseContext,
): Promise<Response> {
  const window = parseWindow(url);
  if (!window) return badRequest("Invalid time window");
  const filters = parseFilters(url);
  const limit = parseLimit(url, 20, 200);
  const rows = await queryEventTypeAggregate(
    env,
    siteId,
    window,
    filters,
    limit,
  );
  return jsonResponseWith(ctx!, { ok: true, data: mapTabs(rows) });
}

export async function handleEventsSummary(
  env: Env,
  siteId: string,
  url: URL,
  ctx?: ResponseContext,
): Promise<Response> {
  const window = parseWindow(url);
  if (!window) return badRequest("Invalid time window");
  const filters = parseFilters(url);
  const data = await queryEventsSummaryFromD1(env, siteId, window, filters);
  return jsonResponseWith(ctx!, {
    ok: true,
    summary: {
      events: Number(data.summary.events ?? 0),
      eventTypes: Number(data.summary.eventTypes ?? 0),
      sessions: Number(data.summary.sessions ?? 0),
      visitors: Number(data.summary.visitors ?? 0),
      avgEventsPerSession:
        Number(data.summary.sessions ?? 0) > 0
          ? Number(data.summary.events ?? 0) /
            Number(data.summary.sessions ?? 0)
          : 0,
    },
    cards: mapEventSummaryCards(data.cards),
  });
}

export async function handleEventsTrend(
  env: Env,
  siteId: string,
  url: URL,
  ctx?: ResponseContext,
): Promise<Response> {
  const window = parseWindow(url);
  if (!window) return badRequest("Invalid time window");
  const filters = parseFilters(url);
  const interval = parseInterval(url);
  const limit = parseLimit(url, 8, 12);
  const eventName = parseEventName(url);
  const trend = await queryEventsTrendFromD1(
    env,
    siteId,
    window,
    interval,
    filters,
    limit,
    eventName,
  );
  return jsonResponseWith(ctx!, { ok: true, interval, ...trend });
}

export async function handleEventsRecords(
  env: Env,
  siteId: string,
  url: URL,
  ctx?: ResponseContext,
): Promise<Response> {
  const window = parseWindow(url);
  if (!window) return badRequest("Invalid time window");
  const filters = parseFilters(url);
  const pageSize = parseQueryLimit(url, "pageSize", 80, 1, 1_000);
  const sort = parseEventRecordSort(url);
  const rawCursor = url.searchParams.get("cursor");
  const cursor = rawCursor ? parseEventRecordCursor(rawCursor, sort) : null;
  if (rawCursor && !cursor) return badRequest("Invalid cursor");
  const search = parseListSearch(url);
  const eventName = parseEventName(url);
  const page = await queryEventRecordPageFromD1(env, siteId, window, filters, {
    pageSize,
    sort,
    search,
    eventName,
    cursor,
  });
  return jsonResponseWith(ctx!, {
    ok: true,
    data: page.rows.map(mapEventRecord),
    meta: {
      pageSize,
      returned: page.rows.length,
      hasMore: page.nextCursor !== null,
      nextCursor: page.nextCursor
        ? serializeEventRecordCursor(page.nextCursor)
        : null,
    },
  });
}

export async function handleEventTypeDetail(
  env: Env,
  siteId: string,
  url: URL,
  ctx?: ResponseContext,
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
  const filters = parseFilters(url);
  const interval = parseInterval(url);
  const logger = currentInvocationLogger();
  const includeContext = options?.includeContext ?? true;
  const includeBreakdowns = options?.includeBreakdowns ?? true;
  const includeFields = options?.includeFields ?? true;
  const measure = <T>(operation: string, action: () => Promise<T>) =>
    logger
      ? logger.measure(operation, () => runWithD1Operation(operation, action))
      : action();
  const [overview, trend, fields, cards] = await Promise.all([
    measure("event_type_detail.overview", () =>
      queryEventTypeOverviewFromD1(env, siteId, window, filters, eventName, {
        includeBreakdowns,
      }),
    ),
    measure("event_type_detail.trend", () =>
      queryEventTypeTrendFromD1(
        env,
        siteId,
        window,
        interval,
        filters,
        eventName,
      ),
    ),
    includeFields
      ? measure("event_type_detail.fields", () =>
          queryEventFieldsFromD1(env, siteId, window, filters, eventName, 100),
        )
      : Promise.resolve([]),
    includeContext
      ? measure("event_type_detail.context_cards", () =>
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
  return jsonResponseWith(ctx!, {
    ok: true,
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
  });
}

export async function handleEventTypeFields(
  env: Env,
  siteId: string,
  url: URL,
  ctx?: ResponseContext,
): Promise<Response> {
  const eventName = parseEventName(url);
  if (!eventName) return badRequest("eventName is required");
  const window = parseWindow(url);
  if (!window) return badRequest("Invalid time window");
  const filters = parseFilters(url);
  const logger = currentInvocationLogger();
  const fields = logger
    ? await logger.measure("event_type_fields", () =>
        runWithD1Operation("event_type_fields", () =>
          queryEventFieldsFromD1(env, siteId, window, filters, eventName, 100),
        ),
      )
    : await queryEventFieldsFromD1(
        env,
        siteId,
        window,
        filters,
        eventName,
        100,
      );
  return jsonResponseWith(ctx!, {
    ok: true,
    eventName,
    fields: fields.map(mapEventField),
  });
}

function parseEventContextCardKeys(url: URL): EventContextCardKey[] | null {
  const raw = url.searchParams.get("cards")?.trim();
  if (!raw) return null;
  const selected = [...new Set(raw.split(",").map((key) => key.trim()))];
  if (
    selected.length === 0 ||
    selected.length > EVENT_CONTEXT_CARD_KEYS.length ||
    selected.some(
      (key): key is EventContextCardKey =>
        !EVENT_CONTEXT_CARD_KEYS.includes(key as EventContextCardKey),
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

export async function handleEventTypeContext(
  env: Env,
  siteId: string,
  url: URL,
  ctx?: ResponseContext,
): Promise<Response> {
  const eventName = parseEventName(url);
  if (!eventName) return badRequest("eventName is required");
  const window = parseWindow(url);
  if (!window) return badRequest("Invalid time window");
  const selectedKeys = parseEventContextCardKeys(url);
  if (!selectedKeys) return badRequest("Valid context cards are required");
  const filters = parseFilters(url);
  const logger = currentInvocationLogger();
  const cards = logger
    ? await logger.measure("event_type_context", () =>
        runWithD1Operation("event_type_context", () =>
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
      )
    : await queryEventAnalyticsContextCardsFromD1(
        env,
        siteId,
        window,
        filters,
        100,
        eventName,
        selectedKeys,
      );
  return jsonResponseWith(ctx!, {
    ok: true,
    eventName,
    cards: mapEventAnalyticsContextCards(cards),
  });
}

export async function handleEventTypeFieldValues(
  env: Env,
  siteId: string,
  url: URL,
  ctx?: ResponseContext,
): Promise<Response> {
  const eventName = parseEventName(url);
  const fieldPath = parseEventFieldPath(url);
  const fieldValueType = parseEventFieldValueType(url);
  if (!eventName) return badRequest("eventName is required");
  if (!fieldPath) return badRequest("fieldPath is required");
  if (!fieldValueType) return badRequest("fieldValueType is required");
  const window = parseWindow(url);
  if (!window) return badRequest("Invalid time window");
  const filters = parseFilters(url);
  const limit = parseLimit(url, 25, 100);
  const rows = await queryEventFieldValuesFromD1(
    env,
    siteId,
    window,
    filters,
    eventName,
    fieldPath,
    fieldValueType,
    limit,
  );
  return jsonResponseWith(ctx!, {
    ok: true,
    fieldPath,
    fieldValueType,
    data: rows.map(mapEventFieldValue),
  });
}

export async function handleEventRecordDetail(
  env: Env,
  siteId: string,
  url: URL,
  ctx?: ResponseContext,
): Promise<Response> {
  const eventId = parseEventId(url);
  if (!eventId) return badRequest("eventId is required");
  const detail = await queryEventRecordDetailFromD1(env, siteId, eventId);
  return jsonResponseWith(ctx!, { ok: true, data: detail });
}
