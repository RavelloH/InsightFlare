import {
  emptyVisitorDetail,
  emptyVisitors,
} from "@/lib/dashboard/client/data/empty";
import type {
  SortDirection,
  VisitorListSortKey,
} from "@/lib/dashboard/client/data/types";
import { fetchPrivateJson } from "@/lib/dashboard/client/request";
import { withFilters, withPagination } from "@/lib/dashboard/client/utils";
import type { TimeWindow } from "@/lib/dashboard/query-state";
import type {
  JourneyEventsData,
  VisitorDetailData,
  VisitorsData,
  VisitorSessionsData,
} from "@/lib/dashboard-api/client/edge";
import type { JourneyAnalysisContext } from "@/lib/edge/analytics/contract";
import type { FilterDocument } from "@/lib/filter-contract";
function emptyVisitorsUnlessAborted(error: unknown): VisitorsData {
  if (error instanceof Error && error.name === "AbortError") throw error;
  return emptyVisitors();
}
export async function fetchVisitors(
  siteId: string,
  window: TimeWindow,
  filters?: FilterDocument,
  options?: {
    limit?: number;
    cursor?: string | null;
    sortBy?: VisitorListSortKey;
    sortDir?: SortDirection;
    search?: string;
    analysisContext?: JourneyAnalysisContext;
    signal?: AbortSignal;
  },
): Promise<VisitorsData> {
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
    ? fetchPrivateJson<VisitorsData>("/api/private/visitors", requestParams, {
        signal: options.signal,
      })
    : fetchPrivateJson<VisitorsData>("/api/private/visitors", requestParams);
  return request.catch(emptyVisitorsUnlessAborted);
}
export async function fetchVisitorDetail(
  siteId: string,
  visitorId: string,
  timeZone?: string,
  window?: TimeWindow,
  options?: { signal?: AbortSignal },
): Promise<VisitorDetailData> {
  const normalizedVisitorId = visitorId.trim();
  if (!normalizedVisitorId) return emptyVisitorDetail();
  const result = await fetchPrivateJson<VisitorDetailData>(
    "/api/private/visitor-detail",
    {
      siteId,
      visitorId: normalizedVisitorId,
      ...(window ? { from: window.from, to: window.to } : {}),
      ...(timeZone ? { timeZone } : {}),
    },
    { signal: options?.signal, dedupe: false },
  );
  if (!result.data) return result;
  return {
    ...result,
    data: {
      ...result.data,
      sessions: result.data.sessions ?? [],
      events: result.data.events ?? [],
    },
  };
}
export async function fetchVisitorEvents(
  siteId: string,
  visitorId: string,
  window: TimeWindow,
  options?: {
    limit?: number;
    cursor?: string | null;
    signal?: AbortSignal;
  },
): Promise<JourneyEventsData> {
  return fetchPrivateJson<JourneyEventsData>(
    "/api/private/visitor-events",
    withPagination(
      {
        siteId,
        visitorId: visitorId.trim(),
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
export async function fetchVisitorSessions(
  siteId: string,
  visitorId: string,
  window: TimeWindow,
  options?: {
    limit?: number;
    cursor?: string | null;
    signal?: AbortSignal;
  },
): Promise<VisitorSessionsData> {
  return fetchPrivateJson<VisitorSessionsData>(
    "/api/private/visitor-sessions",
    withPagination(
      {
        siteId,
        visitorId: visitorId.trim(),
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
