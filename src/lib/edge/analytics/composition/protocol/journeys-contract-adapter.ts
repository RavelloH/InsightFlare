import { resolveReportingTimeZone } from "@/lib/dashboard/time-zone";
import { createD1SiteQueryRuntime } from "@/lib/edge/analytics/composition/d1";
import { parseFilterUrlForAudience } from "@/lib/edge/analytics/contract";
import { siteQueryContext } from "@/lib/edge/analytics/contract";
import type { mapVisitors } from "@/lib/edge/analytics/providers/d1/internal/core";
import {
  badRequest,
  jsonResponseWith,
  parseEventId,
  parseLimit,
  parseListSearch,
  parseSessionListSort,
  parseVisitorListSort,
  parseWindow,
  queryErrorResponse,
  type ResponseContext,
} from "@/lib/edge/analytics/providers/d1/internal/core";
import {} from "@/lib/edge/analytics/providers/d1/internal/journey-list-queries";
import { toQueryTime } from "@/lib/edge/analytics/providers/d1/operations/overview-reader";
import type { Env } from "@/lib/edge/types";

type JourneyCollectionPath =
  | "visitor-events"
  | "visitor-sessions"
  | "session-events";

export async function handleVisitorsContract(
  env: Env,
  siteId: string,
  url: URL,
  ctx?: ResponseContext,
  queryContext = siteQueryContext(siteId, "private-dashboard"),
): Promise<Response> {
  const window = parseWindow(url);
  if (!window) return badRequest("Invalid time window");
  const limit = parseLimit(url, 80, 120);
  const sort = parseVisitorListSort(url);
  const rawCursor = url.searchParams.get("cursor");
  const filters = parseFilterUrlForAudience(queryContext.policy.audience, url);
  const result = await createD1SiteQueryRuntime({ env, siteId }).execute<{
    readonly items: ReturnType<typeof mapVisitors>;
    readonly pagination: {
      readonly limit: number;
      readonly returned: number;
      readonly hasMore: boolean;
      readonly nextCursor: string | null;
    };
  }>("visitors", {
    context: queryContext,
    time: toQueryTime(window),
    filters,
    page: { limit, cursor: rawCursor },
    sort,
    search: parseListSearch(url) ?? "",
  });
  if (!result.ok) return queryErrorResponse(result.error);
  return jsonResponseWith(ctx!, { ok: true, data: result.data });
}

export async function handleSessionsContract(
  env: Env,
  siteId: string,
  url: URL,
  ctx?: ResponseContext,
  queryContext = siteQueryContext(siteId, "private-dashboard"),
): Promise<Response> {
  const window = parseWindow(url);
  if (!window) return badRequest("Invalid time window");
  const limit = parseLimit(url, 80, 120);
  const sort = parseSessionListSort(url);
  const rawCursor = url.searchParams.get("cursor");
  const filters = parseFilterUrlForAudience(queryContext.policy.audience, url);
  const result = await createD1SiteQueryRuntime({ env, siteId }).execute<{
    readonly items: readonly unknown[];
    readonly pagination: {
      readonly limit: number;
      readonly returned: number;
      readonly hasMore: boolean;
      readonly nextCursor: string | null;
    };
  }>("sessions", {
    context: queryContext,
    time: toQueryTime(window),
    filters,
    page: { limit, cursor: rawCursor },
    sort,
    search: parseListSearch(url) ?? "",
  });
  if (!result.ok) return queryErrorResponse(result.error);
  return jsonResponseWith(ctx!, { ok: true, data: result.data });
}

export async function handleVisitorDetailContract(
  env: Env,
  siteId: string,
  url: URL,
  ctx?: ResponseContext,
  queryContext = siteQueryContext(siteId, "private-dashboard"),
): Promise<Response> {
  const visitorId = (url.searchParams.get("visitorId") || "").trim();
  if (!visitorId) return badRequest("Missing visitorId");
  // Detail readers intentionally do not filter a visitor's trajectory by the
  // dashboard window; the window is only contract metadata and policy input.
  const window = parseWindow(url);
  if (!window) return badRequest("Invalid time window");
  const result = await createD1SiteQueryRuntime({ env, siteId }).execute<
    Record<string, unknown>
  >("visitor-detail", {
    context: queryContext,
    time: toQueryTime(window),
    filters: { version: 1, root: null },
    visitorId,
    timeZone: resolveReportingTimeZone(url.searchParams.get("timeZone")),
  });
  if (!result.ok) return queryErrorResponse(result.error);
  return jsonResponseWith(ctx!, { ok: true, data: result.data });
}

export async function handleSessionDetailContract(
  env: Env,
  siteId: string,
  url: URL,
  ctx?: ResponseContext,
  queryContext = siteQueryContext(siteId, "private-dashboard"),
): Promise<Response> {
  const sessionId = (url.searchParams.get("sessionId") || "").trim();
  if (!sessionId) return badRequest("Missing sessionId");
  const window = parseWindow(url);
  if (!window) return badRequest("Invalid time window");
  const result = await createD1SiteQueryRuntime({ env, siteId }).execute<
    Record<string, unknown>
  >("session-detail", {
    context: queryContext,
    time: toQueryTime(window),
    filters: { version: 1, root: null },
    sessionId,
  });
  if (!result.ok) return queryErrorResponse(result.error);
  return jsonResponseWith(ctx!, { ok: true, data: result.data });
}

export async function handleJourneyCollectionContract(
  env: Env,
  siteId: string,
  url: URL,
  path: JourneyCollectionPath,
  ctx?: ResponseContext,
  queryContext = siteQueryContext(siteId, "private-dashboard"),
): Promise<Response> {
  const window = parseWindow(url);
  if (!window) return badRequest("Invalid time window");
  const limit = parseLimit(url, 100, 500);
  const rawCursor = url.searchParams.get("cursor");
  const targetKey =
    path === "visitor-events" || path === "visitor-sessions"
      ? "visitorId"
      : "sessionId";
  const targetId = url.searchParams.get(targetKey)?.trim();
  if (!targetId) return badRequest(`Missing ${targetKey}`);
  const filters = parseFilterUrlForAudience(queryContext.policy.audience, url);
  const result = await createD1SiteQueryRuntime({ env, siteId }).execute<{
    readonly items: readonly unknown[];
    readonly pagination: unknown;
  }>(path, {
    context: queryContext,
    time: toQueryTime(window),
    filters,
    page: { limit, cursor: rawCursor },
    ...(path === "visitor-events" || path === "visitor-sessions"
      ? { visitorId: targetId }
      : { sessionId: targetId }),
  });
  if (!result.ok) return queryErrorResponse(result.error);
  return jsonResponseWith(ctx!, { ok: true, data: result.data });
}

export async function handleJourneyEventDetailContract(
  env: Env,
  siteId: string,
  url: URL,
  ctx?: ResponseContext,
  queryContext = siteQueryContext(siteId, "private-dashboard"),
): Promise<Response> {
  const eventId = parseEventId(url);
  if (!eventId) return badRequest("Missing eventId");
  const rawEventKind = url.searchParams.get("eventKind")?.trim();
  const eventKind =
    rawEventKind === "pageview" ||
    rawEventKind === "session_start" ||
    rawEventKind === "leave"
      ? rawEventKind
      : rawEventKind
        ? null
        : undefined;
  if (eventKind === null) return badRequest("Invalid eventKind");
  const window = parseWindow(url);
  if (!window) return badRequest("Invalid time window");
  const result = await createD1SiteQueryRuntime({ env, siteId }).execute<Record<
    string,
    unknown
  > | null>("journey-event-detail", {
    context: queryContext,
    time: toQueryTime(window),
    filters: { version: 1, root: null },
    eventId,
    ...(eventKind ? { eventKind } : {}),
  });
  if (!result.ok) return queryErrorResponse(result.error);
  return jsonResponseWith(ctx!, { ok: true, data: result.data });
}
