import {
  currentInvocationLogger,
  runWithD1Operation,
} from "@/lib/edge/observability-logger";
import {
  executeQueryOperation,
  siteQueryContext,
} from "@/lib/edge/query-contract";
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
} from "./events-context";
import { queryEventFieldsFromD1 } from "./events-fields";
import { queryEventFieldValuesFromD1 } from "./events-fields";
import { queryEventTypeOverviewFromD1 } from "./events-overview";
import { queryEventRecordDetailFromD1 } from "./events-records";
import {
  parseEventRecordCursor,
  queryEventRecordPageFromD1,
  serializeEventRecordCursor,
} from "./events-records";
import { queryEventTypeAggregate } from "./events-summary";
import { queryEventsSummaryFromD1 } from "./events-summary";
import { queryEventsTrendFromD1 } from "./events-trend";
import { queryEventTypeTrendFromD1 } from "./events-trend";
import { legacyFilters, toQueryTime } from "./overview-contract-adapter";

export async function handleEventTypesContract(
  env: Env,
  siteId: string,
  url: URL,
  ctx?: ResponseContext,
  queryContext = siteQueryContext(siteId, "private-dashboard"),
): Promise<Response> {
  const window = parseWindow(url);
  if (!window) return badRequest("Invalid time window");
  const filters = parseFilters(url);
  const result = await executeQueryOperation(
    "event-types",
    {
      context: queryContext,
      time: toQueryTime(window),
      filters: legacyFilters(filters),
    },
    async () => ({
      value: mapTabs(
        await queryEventTypeAggregate(
          env,
          siteId,
          window,
          filters,
          parseLimit(url, 20, 200),
        ),
      ),
    }),
  );
  if (!result.ok) return badRequest(result.error.kind);
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
  const filters = parseFilters(url);
  const result = await executeQueryOperation(
    "event-summary",
    {
      context: queryContext,
      time: toQueryTime(window),
      filters: legacyFilters(filters),
    },
    async () => {
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
    },
  );
  if (!result.ok) return badRequest(result.error.kind);
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
  const filters = parseFilters(url);
  const result = await executeQueryOperation(
    "event-trend",
    {
      context: queryContext,
      time: toQueryTime(window),
      filters: legacyFilters(filters),
    },
    async () => ({
      value: {
        interval,
        ...(await queryEventsTrendFromD1(
          env,
          siteId,
          window,
          interval,
          filters,
          parseLimit(url, 8, 12),
          parseEventName(url),
        )),
      },
    }),
  );
  if (!result.ok) return badRequest(result.error.kind);
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
  const filters = parseFilters(url);
  const result = await executeQueryOperation(
    "event-records",
    {
      context: queryContext,
      time: toQueryTime(window),
      filters: legacyFilters(filters),
    },
    async () => {
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
    },
  );
  if (!result.ok) return badRequest(result.error.kind);
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
  const filters = parseFilters(url);
  const result = await executeQueryOperation(
    "event-fields",
    {
      context: queryContext,
      time: toQueryTime(window),
      filters: legacyFilters(filters),
    },
    async () => ({
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
          )
        ).map(mapEventFieldValue),
      },
    }),
  );
  if (!result.ok) return badRequest(result.error.kind);
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
  const filters = parseFilters(url);
  const result = await executeQueryOperation(
    "event-fields",
    {
      context: queryContext,
      time: toQueryTime(window),
      filters: legacyFilters(filters),
    },
    async () => ({
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
    }),
  );
  if (!result.ok) return badRequest(result.error.kind);
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
  const filters = parseFilters(url);
  const result = await executeQueryOperation(
    "event-context",
    {
      context: queryContext,
      time: toQueryTime(window),
      filters: legacyFilters(filters),
    },
    async () => ({
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
    }),
  );
  if (!result.ok) return badRequest(result.error.kind);
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
  const filters = parseFilters(url);
  const includeContext = options?.includeContext ?? true;
  const includeBreakdowns = options?.includeBreakdowns ?? true;
  const includeFields = options?.includeFields ?? true;
  const result = await executeQueryOperation(
    "event-type-detail",
    {
      context: queryContext,
      time: toQueryTime(window),
      filters: legacyFilters(filters),
    },
    async () => {
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
    },
  );
  if (!result.ok) return badRequest(result.error.kind);
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
  const result = await executeQueryOperation(
    "event-record-detail",
    {
      context: queryContext,
      time: toQueryTime(window),
      filters: legacyFilters({}),
    },
    async () => ({
      value: await queryEventRecordDetailFromD1(env, siteId, eventId),
    }),
  );
  if (!result.ok) return badRequest(result.error.kind);
  return jsonResponseWith(ctx!, { ok: true, data: result.data });
}
