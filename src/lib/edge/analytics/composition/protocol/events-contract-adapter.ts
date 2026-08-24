import { createD1SiteQueryRuntime } from "@/lib/edge/analytics/composition/d1";
import { parseFilterUrlForAudience } from "@/lib/edge/analytics/contract";
import { siteQueryContext } from "@/lib/edge/analytics/contract";
import type {
  mapEventAnalyticsContextCards,
  mapEventField,
  mapEventFieldValue,
  mapEventRecord,
  mapEventSummaryCards,
  mapTabs,
} from "@/lib/edge/analytics/providers/d1/internal/core";
import {
  badRequest,
  jsonResponseWith,
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
} from "@/lib/edge/analytics/providers/d1/internal/events-context";
import { parseEventRecordCursor } from "@/lib/edge/analytics/providers/d1/internal/events-records";
import { toQueryTime } from "@/lib/edge/analytics/providers/d1/operations/overview-reader";
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
  const result = await createD1SiteQueryRuntime({ env, siteId }).execute<
    ReturnType<typeof mapTabs>
  >("event-types", {
    context: queryContext,
    time: toQueryTime(window),
    filters,
    limit: parseLimit(url, 20, 200),
    search: url.searchParams.get("search")?.trim() ?? "",
  });
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
  const result = await createD1SiteQueryRuntime({ env, siteId }).execute<{
    readonly summary: {
      readonly events: number;
      readonly eventTypes: number;
      readonly sessions: number;
      readonly visitors: number;
      readonly avgEventsPerSession: number;
    };
    readonly cards: ReturnType<typeof mapEventSummaryCards>;
  }>("event-summary", {
    context: queryContext,
    time: toQueryTime(window),
    filters,
  });
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
  const result = await createD1SiteQueryRuntime({ env, siteId }).execute<{
    readonly interval: ReturnType<typeof parseInterval>;
    readonly series: readonly unknown[];
    readonly data: readonly unknown[];
  }>("event-trend", {
    context: queryContext,
    time: toQueryTime(window),
    filters,
    interval,
    limit: parseLimit(url, 8, 18),
    eventName: parseEventName(url) ?? "",
  });
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
  const result = await createD1SiteQueryRuntime({ env, siteId }).execute<{
    readonly data: Array<ReturnType<typeof mapEventRecord>>;
    readonly meta: {
      readonly pageSize: number;
      readonly returned: number;
      readonly hasMore: boolean;
      readonly nextCursor: string | null;
    };
  }>("event-records", {
    context: queryContext,
    time: toQueryTime(window),
    filters,
    pageSize,
    sort,
    search: parseListSearch(url) ?? "",
    eventName: parseEventName(url) ?? "",
    cursor,
  });
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
  const result = await createD1SiteQueryRuntime({ env, siteId }).execute<{
    readonly fieldPath: string;
    readonly fieldValueType: string;
    readonly data: Array<ReturnType<typeof mapEventFieldValue>>;
  }>("event-field-values", {
    context: queryContext,
    time: toQueryTime(window),
    filters,
    eventName,
    fieldPath,
    fieldValueType,
    limit: parseLimit(url, 25, 100),
    search: parseListSearch(url) ?? "",
  });
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
  const result = await createD1SiteQueryRuntime({ env, siteId }).execute<{
    readonly eventName: string;
    readonly fields: Array<ReturnType<typeof mapEventField>>;
  }>("event-fields", {
    context: queryContext,
    time: toQueryTime(window),
    filters,
    eventName,
    limit: 100,
  });
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
  const result = await createD1SiteQueryRuntime({ env, siteId }).execute<{
    readonly eventName: string;
    readonly cards: ReturnType<typeof mapEventAnalyticsContextCards>;
  }>("event-context", {
    context: queryContext,
    time: toQueryTime(window),
    filters,
    eventName,
    selectedKeys,
    limit: 100,
  });
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
  const result = await createD1SiteQueryRuntime({ env, siteId }).execute<{
    readonly eventName: string;
    readonly summary: Record<string, unknown>;
    readonly trend: Record<string, unknown>;
    readonly breakdowns: {
      readonly pages: ReturnType<typeof mapTabs>;
      readonly countries: ReturnType<typeof mapTabs>;
      readonly devices: ReturnType<typeof mapTabs>;
      readonly browsers: ReturnType<typeof mapTabs>;
    };
    readonly cards: ReturnType<typeof mapEventAnalyticsContextCards>;
    readonly fields: Array<ReturnType<typeof mapEventField>>;
  }>("event-type-detail", {
    context: queryContext,
    time: toQueryTime(window),
    filters,
    eventName,
    interval: parseInterval(url),
    includeContext,
    includeBreakdowns,
    includeFields,
  });
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
  const result = await createD1SiteQueryRuntime({ env, siteId }).execute<
    Record<string, unknown>
  >("event-record-detail", {
    context: queryContext,
    time: toQueryTime(window),
    filters: { version: 1, root: null },
    eventId,
  });
  if (!result.ok) return queryErrorResponse(result.error);
  return jsonResponseWith(ctx!, { ok: true, data: result.data });
}
