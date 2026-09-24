import { resolveReportingTimeZone } from "@/lib/analytics/time-zone";
import { createEdgeSiteAnalyticsRuntime } from "@/lib/edge/analytics/composition";
import {
  type JourneyAnalysisContext,
  parseFilterUrlForAudience,
} from "@/lib/edge/analytics/contract";
import { siteQueryContext } from "@/lib/edge/analytics/contract";
import { queryWindowToTime } from "@/lib/edge/analytics/contract";
import {
  parseEventId,
  parseLimit,
  parseListSearch,
  parseSessionListSort,
  parseVisitorListSort,
  parseWindow,
} from "@/lib/edge/analytics/interfaces/dashboard/protocol/parsers";
import {
  badRequest,
  jsonResponseWith,
  queryErrorResponse,
  type ResponseContext,
} from "@/lib/edge/analytics/interfaces/dashboard/protocol/responses";
import type { Env } from "@/lib/edge/types";
type JourneyCollectionPath =
  "visitor-events" | "visitor-sessions" | "session-events";
function parseJourneyAnalysisContext(
  url: URL,
): JourneyAnalysisContext | undefined | null {
  const type = url.searchParams.get("analysisType")?.trim();
  const id = url.searchParams.get("analysisId")?.trim();
  const stepId = url.searchParams.get("analysisStepId")?.trim();
  const outcome = url.searchParams.get("analysisOutcome")?.trim();
  if (!type && !id && !stepId) return outcome ? null : undefined;
  if (!type || !id) return null;
  if (outcome && outcome !== "converted" && outcome !== "dropoff") return null;
  if (type === "goal" && !stepId) {
    if (outcome) return null;
    return { type: "goal", goalId: id };
  }
  if (type === "funnel" && stepId) {
    return {
      type: "funnel",
      funnelId: id,
      stepId,
      ...(outcome ? { outcome: outcome as "converted" | "dropoff" } : {}),
    };
  }
  return null;
}
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
  const analysisContext = parseJourneyAnalysisContext(url);
  if (analysisContext === null) return badRequest("Invalid analysis context");
  const result = await createEdgeSiteAnalyticsRuntime({ env, siteId }).execute(
    "visitors",
    {
      context: queryContext,
      time: queryWindowToTime(window),
      filters,
      page: { limit, cursor: rawCursor },
      sort,
      search: parseListSearch(url) ?? "",
      analysisContext,
    },
  );
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
  const analysisContext = parseJourneyAnalysisContext(url);
  if (analysisContext === null) return badRequest("Invalid analysis context");
  const result = await createEdgeSiteAnalyticsRuntime({ env, siteId }).execute(
    "sessions",
    {
      context: queryContext,
      time: queryWindowToTime(window),
      filters,
      page: { limit, cursor: rawCursor },
      sort,
      search: parseListSearch(url) ?? "",
      analysisContext,
    },
  );
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
  const result = await createEdgeSiteAnalyticsRuntime({ env, siteId }).execute(
    "visitor-detail",
    {
      context: queryContext,
      time: queryWindowToTime(window),
      filters: { version: 1, root: null },
      visitorId,
      timeZone: resolveReportingTimeZone(url.searchParams.get("timeZone")),
    },
  );
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
  const result = await createEdgeSiteAnalyticsRuntime({ env, siteId }).execute(
    "session-detail",
    {
      context: queryContext,
      time: queryWindowToTime(window),
      filters: { version: 1, root: null },
      sessionId,
    },
  );
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
  const result = await createEdgeSiteAnalyticsRuntime({ env, siteId }).execute(
    path,
    {
      context: queryContext,
      time: queryWindowToTime(window),
      filters,
      page: { limit, cursor: rawCursor },
      ...(path === "visitor-events" || path === "visitor-sessions"
        ? { visitorId: targetId }
        : { sessionId: targetId }),
    },
  );
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
  const result = await createEdgeSiteAnalyticsRuntime({
    env,
    siteId,
  }).execute("journey-event-detail", {
    context: queryContext,
    time: queryWindowToTime(window),
    filters: { version: 1, root: null },
    eventId,
    ...(eventKind ? { eventKind } : {}),
  });
  if (!result.ok) return queryErrorResponse(result.error);
  return jsonResponseWith(ctx!, { ok: true, data: result.data });
}
