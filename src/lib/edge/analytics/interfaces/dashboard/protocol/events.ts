import { createEdgeSiteAnalyticsRuntime } from "@/lib/edge/analytics/composition";
import { parseFilterUrlForAudience } from "@/lib/edge/analytics/contract";
import { siteQueryContext } from "@/lib/edge/analytics/contract";
import { queryWindowToTime } from "@/lib/edge/analytics/contract";
import {
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
} from "@/lib/edge/analytics/interfaces/dashboard/protocol/parsers";
import {
  badRequest,
  jsonResponseWith,
  queryErrorResponse,
  type ResponseContext,
} from "@/lib/edge/analytics/interfaces/dashboard/protocol/responses";
import type { Env } from "@/lib/edge/types";
const EVENT_CONTEXT_CARD_KEYS = [
  "path",
  "query",
  "title",
  "hostname",
  "entry",
  "exit",
  "sourceDomain",
  "sourceLink",
  "browser",
  "osVersion",
  "deviceType",
  "language",
  "screenSize",
  "country",
  "region",
  "city",
  "continent",
  "timezone",
  "organization",
] as const;
type EventContextCardKey = (typeof EVENT_CONTEXT_CARD_KEYS)[number];
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
  const result = await createEdgeSiteAnalyticsRuntime({ env, siteId }).execute(
    "event-types",
    {
      context: queryContext,
      time: queryWindowToTime(window),
      filters,
      limit: parseLimit(url, 20, 200),
      search: url.searchParams.get("search")?.trim() ?? "",
      cursor: url.searchParams.get("cursor") ?? "",
    },
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
  const result = await createEdgeSiteAnalyticsRuntime({ env, siteId }).execute(
    "event-summary",
    {
      context: queryContext,
      time: queryWindowToTime(window),
      filters,
    },
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
  const result = await createEdgeSiteAnalyticsRuntime({ env, siteId }).execute(
    "event-trend",
    {
      context: queryContext,
      time: queryWindowToTime(window),
      filters,
      interval,
      limit: parseLimit(url, 8, 18),
      eventName: parseEventName(url) ?? "",
    },
  );
  if (!result.ok) return queryErrorResponse(result.error);
  return jsonResponseWith(ctx!, { ok: true, data: result.data });
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
  const limit = parseQueryLimit(url, "limit", 80, 1, 1_000);
  const sort = parseEventRecordSort(url);
  const rawCursor = url.searchParams.get("cursor");
  const filters = parseFilterUrlForAudience(queryContext.policy.audience, url);
  const result = await createEdgeSiteAnalyticsRuntime({ env, siteId }).execute(
    "event-records",
    {
      context: queryContext,
      time: queryWindowToTime(window),
      filters,
      page: { limit, cursor: rawCursor },
      sort,
      search: parseListSearch(url) ?? "",
      eventName: parseEventName(url) ?? "",
    },
  );
  if (!result.ok) return queryErrorResponse(result.error);
  return jsonResponseWith(ctx!, { ok: true, data: result.data });
}
export async function handleEventFieldValuesContract(
  env: Env,
  siteId: string,
  url: URL,
  ctx?: ResponseContext,
  queryContext = siteQueryContext(siteId, "private-dashboard"),
): Promise<Response> {
  const eventName = parseEventName(url) ?? undefined;
  const fieldPath = parseEventFieldPath(url);
  const fieldValueType = parseEventFieldValueType(url);
  if (!fieldPath) return badRequest("fieldPath is required");
  if (!fieldValueType) return badRequest("fieldValueType is required");
  const window = parseWindow(url);
  if (!window) return badRequest("Invalid time window");
  const filters = parseFilterUrlForAudience(queryContext.policy.audience, url);
  const result = await createEdgeSiteAnalyticsRuntime({ env, siteId }).execute(
    "event-field-values",
    {
      context: queryContext,
      time: queryWindowToTime(window),
      filters,
      eventName: eventName ?? "",
      fieldPath,
      fieldValueType,
      limit: parseLimit(url, 25, 100),
      search: parseListSearch(url) ?? "",
      cursor: url.searchParams.get("cursor") ?? "",
    },
  );
  if (!result.ok) return queryErrorResponse(result.error);
  const { eventName: _eventName, ...data } = result.data;
  return jsonResponseWith(ctx!, { ok: true, ...data });
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
  const eventName = parseEventName(url) ?? undefined;
  const window = parseWindow(url);
  if (!window) return badRequest("Invalid time window");
  const filters = parseFilterUrlForAudience(queryContext.policy.audience, url);
  const result = await createEdgeSiteAnalyticsRuntime({ env, siteId }).execute(
    "event-fields",
    {
      context: queryContext,
      time: queryWindowToTime(window),
      filters,
      eventName: eventName ?? "",
      limit: parseLimit(url, 100, 200),
      cursor: url.searchParams.get("cursor") ?? "",
    },
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
  const result = await createEdgeSiteAnalyticsRuntime({ env, siteId }).execute(
    "event-context",
    {
      context: queryContext,
      time: queryWindowToTime(window),
      filters,
      eventName,
      selectedKeys,
      limit: 100,
    },
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
  },
): Promise<Response> {
  const eventName = parseEventName(url);
  if (!eventName) return badRequest("eventName is required");
  const window = parseWindow(url);
  if (!window) return badRequest("Invalid time window");
  const filters = parseFilterUrlForAudience(queryContext.policy.audience, url);
  const includeContext = options?.includeContext ?? true;
  const includeBreakdowns = options?.includeBreakdowns ?? true;
  const result = await createEdgeSiteAnalyticsRuntime({ env, siteId }).execute(
    "event-type-detail",
    {
      context: queryContext,
      time: queryWindowToTime(window),
      filters,
      eventName,
      interval: parseInterval(url),
      includeContext,
      includeBreakdowns,
    },
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
  const result = await createEdgeSiteAnalyticsRuntime({ env, siteId }).execute(
    "event-record-detail",
    {
      context: queryContext,
      time: queryWindowToTime(window),
      filters: { version: 1, root: null },
      eventId,
    },
  );
  if (!result.ok) return queryErrorResponse(result.error);
  return jsonResponseWith(ctx!, { ok: true, data: result.data });
}
