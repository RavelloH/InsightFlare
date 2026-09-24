import {
  emptySessionDetail,
  emptySessions,
} from "@/lib/dashboard/client/data/empty";
import type {
  SessionListSortKey,
  SortDirection,
} from "@/lib/dashboard/client/data/types";
import { fetchPrivateJson } from "@/lib/dashboard/client/request";
import { withFilters, withPagination } from "@/lib/dashboard/client/utils";
import type { TimeWindow } from "@/lib/dashboard/query-state";
import type {
  SessionDetailData,
  SessionEventsData,
  SessionsData,
} from "@/lib/dashboard-api/client/edge";
import type { JourneyAnalysisContext } from "@/lib/edge/analytics/contract";
import type { FilterDocument } from "@/lib/filter-contract";
function emptySessionsUnlessAborted(error: unknown): SessionsData {
  if (error instanceof Error && error.name === "AbortError") throw error;
  return emptySessions();
}
export async function fetchSessions(
  siteId: string,
  window: TimeWindow,
  filters?: FilterDocument,
  options?: {
    limit?: number;
    cursor?: string | null;
    sortBy?: SessionListSortKey;
    sortDir?: SortDirection;
    search?: string;
    analysisContext?: JourneyAnalysisContext;
    signal?: AbortSignal;
  },
): Promise<SessionsData> {
  const params: Record<string, string | number> = {
    siteId,
    from: window.from,
    to: window.to,
    timeZone: window.timeZone,
  };
  if (options?.cursor) params.cursor = options.cursor;
  params.limit = options?.limit ?? 100;
  if (options?.sortBy) params.sortBy = options.sortBy;
  if (options?.sortDir) params.sortDir = options.sortDir;
  if (options?.analysisContext) {
    params.analysisType = options.analysisContext.type;
    params.analysisId =
      options.analysisContext.type === "goal"
        ? options.analysisContext.goalId
        : options.analysisContext.funnelId;
    if (options.analysisContext.type === "funnel") {
      params.analysisStepId = options.analysisContext.stepId;
      params.analysisOutcome = options.analysisContext.outcome ?? "converted";
    }
  }
  const search = options?.search?.trim();
  if (search) params.search = search;
  const requestParams = withFilters(
    {
      ...params,
    },
    filters,
  );
  const request = options?.signal
    ? fetchPrivateJson<SessionsData>("/api/private/sessions", requestParams, {
        signal: options.signal,
      })
    : fetchPrivateJson<SessionsData>("/api/private/sessions", requestParams);
  return request.catch(emptySessionsUnlessAborted);
}
export async function fetchSessionDetail(
  siteId: string,
  sessionId: string,
  timeZone?: string,
  window?: TimeWindow,
  options?: { signal?: AbortSignal },
): Promise<SessionDetailData> {
  const normalizedSessionId = sessionId.trim();
  if (!normalizedSessionId) return emptySessionDetail();
  return fetchPrivateJson<SessionDetailData>(
    "/api/private/session-detail",
    {
      siteId,
      sessionId: normalizedSessionId,
      ...(window ? { from: window.from, to: window.to } : {}),
      ...(timeZone ? { timeZone } : {}),
    },
    { signal: options?.signal, dedupe: false },
  );
}
export async function fetchSessionEvents(
  siteId: string,
  sessionId: string,
  window: TimeWindow,
  options?: {
    limit?: number;
    cursor?: string | null;
    signal?: AbortSignal;
  },
): Promise<SessionEventsData> {
  return fetchPrivateJson<SessionEventsData>(
    "/api/private/session-events",
    withPagination(
      {
        siteId,
        sessionId: sessionId.trim(),
        from: window.from,
        to: window.to,
        timeZone: window.timeZone,
      },
      options,
      100,
    ),
    { signal: options?.signal },
  );
}
