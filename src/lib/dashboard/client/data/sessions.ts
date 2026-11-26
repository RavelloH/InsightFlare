import { infiniteQueryOptions } from "@tanstack/react-query";

import {
  emptySessionDetail,
  emptySessions,
} from "@/lib/dashboard/client/data/empty";
import type {
  PrivateReadTransport,
  SessionListSortKey,
  SortDirection,
} from "@/lib/dashboard/client/data/types";
import { fetchPrivateJson } from "@/lib/dashboard/client/request";
import { withFilters, withPagination } from "@/lib/dashboard/client/utils";
import { filterQueryKey } from "@/lib/dashboard/filter-query-key";
import {
  parseFilterDocumentFromSearchParams,
  type TimeWindow,
} from "@/lib/dashboard/query-state";
import type {
  SessionDetailData,
  SessionEventsData,
  SessionsData,
} from "@/lib/dashboard-api/client/edge";
import type { JourneyAnalysisContext } from "@/lib/edge/analytics/contract";
import {
  attachFilterScopePreference,
  type FilterDocument,
} from "@/lib/filter-contract";
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
    transport?: PrivateReadTransport;
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
  const request =
    options?.signal || options?.transport
      ? fetchPrivateJson<SessionsData>("/api/private/sessions", requestParams, {
          signal: options.signal,
          ...(options.transport ? { transport: options.transport } : {}),
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

export const SESSION_PAGE_SIZE = 50;
export const DEFAULT_SESSION_SORT = {
  key: "startedAt",
  direction: "desc",
} as const;
/** Shared normalized query identity for the route and the mounted list. */
export function sessionsListQueryOptions(input: {
  siteId: string;
  window: TimeWindow;
  filters: FilterDocument;
  search?: string;
  sort?: { key: SessionListSortKey; direction: SortDirection };
  transport?: PrivateReadTransport;
  enabled?: boolean;
}) {
  const {
    siteId,
    window,
    filters,
    search = "",
    sort = DEFAULT_SESSION_SORT,
    transport,
  } = input;
  return infiniteQueryOptions({
    queryKey: [
      "dashboard",
      "sessions",
      siteId,
      window.from,
      window.to,
      window.timeZone,
      filterQueryKey(filters),
      search,
      sort.key,
      sort.direction,
    ],
    queryFn: ({ pageParam, signal }) =>
      fetchSessions(siteId, window, filters, {
        cursor: pageParam,
        limit: SESSION_PAGE_SIZE,
        sortBy: sort.key,
        sortDir: sort.direction,
        search,
        signal,
        transport,
      }),
    initialPageParam: null as string | null,
    getNextPageParam: (lastPage) =>
      lastPage.data.pagination.hasMore
        ? lastPage.data.pagination.nextCursor
        : undefined,
    enabled: input.enabled ?? true,
  });
}
export function startSessionsInitialReads(
  siteId: string,
  window: TimeWindow,
  search: URLSearchParams,
  transport: PrivateReadTransport,
): void {
  const document = parseFilterDocumentFromSearchParams(search);
  const filters = document.root
    ? document
    : attachFilterScopePreference(document, "auto");
  void fetchSessions(siteId, window, filters, {
    limit: SESSION_PAGE_SIZE,
    sortBy: DEFAULT_SESSION_SORT.key,
    sortDir: DEFAULT_SESSION_SORT.direction,
    transport,
  }).catch(() => undefined);
}
