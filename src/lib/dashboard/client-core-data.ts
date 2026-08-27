import type {
  EventRecordSortKey,
  RetentionGranularity,
  SessionListSortKey,
  SortDirection,
  VisitorListSortKey,
} from "@/lib/dashboard/client-data-types";
import {
  emptyEventFieldValues,
  emptyEventRecordDetail,
  emptyEventsRecords,
  emptyEventsSummary,
  emptyEventsTrend,
  emptyEventTypeDetail,
  emptyJourneyEventDetail,
  emptyPerformance,
  emptySessionDetail,
  emptySessions,
  emptyVisitorDetail,
  emptyVisitors,
} from "@/lib/dashboard/client-empty-data";
import type { TimeWindow } from "@/lib/dashboard/query-state";
import type {
  EventField,
  EventFieldValuesData,
  EventRecordDetailData,
  EventsRecordsData,
  EventsSummaryData,
  EventsTrendData,
  EventTypeDetailData,
  FunnelDeleteData,
  FunnelDetailData,
  FunnelListData,
  FunnelMutationData,
  FunnelStep,
  JourneyEvent,
  JourneyEventDetailData,
  OverviewData,
  PagesData,
  PerformanceData,
  RetentionData,
  SessionDetailData,
  SessionsData,
  TrendData,
  VisitorDetailData,
  VisitorsData,
} from "@/lib/edge-client";
import type { FilterDocument } from "@/lib/filter-contract";

import { fetchPrivateJson, fetchPrivateJsonMutate } from "./client-request";
import { withFilters } from "./client-utils";

function emptySessionsUnlessAborted(error: unknown): SessionsData {
  if (error instanceof Error && error.name === "AbortError") throw error;
  return emptySessions();
}

function emptyVisitorsUnlessAborted(error: unknown): VisitorsData {
  if (error instanceof Error && error.name === "AbortError") throw error;
  return emptyVisitors();
}

function fallbackUnlessAborted<T>(error: unknown, fallback: () => T): T {
  if (error instanceof Error && error.name === "AbortError") throw error;
  return fallback();
}

export async function fetchOverview(
  siteId: string,
  window: TimeWindow,
  filters?: FilterDocument,
  options?: {
    includeChange?: boolean;
    includeDetail?: boolean;
    signal?: AbortSignal;
  },
): Promise<OverviewData> {
  return fetchPrivateJson<OverviewData>(
    "/api/private/overview",
    withFilters(
      {
        siteId,
        from: window.from,
        to: window.to,
        timeZone: window.timeZone,
        ...(options?.includeChange ? { includeChange: 1 } : {}),
        ...(options?.includeDetail
          ? { includeDetail: 1, interval: window.interval }
          : {}),
      },
      filters,
    ),
    { signal: options?.signal },
  );
}

export async function fetchTrend(
  siteId: string,
  window: TimeWindow,
  filters?: FilterDocument,
  options?: { signal?: AbortSignal },
): Promise<TrendData> {
  return fetchPrivateJson<TrendData>(
    "/api/private/trend",
    withFilters(
      {
        siteId,
        from: window.from,
        to: window.to,
        timeZone: window.timeZone,
        interval: window.interval,
      },
      filters,
    ),
    { signal: options?.signal },
  );
}

export async function fetchPages(
  siteId: string,
  window: TimeWindow,
  filters?: FilterDocument,
): Promise<PagesData> {
  return fetchPrivateJson<PagesData>(
    "/api/private/pages",
    withFilters(
      {
        siteId,
        from: window.from,
        to: window.to,
        timeZone: window.timeZone,
        limit: 100,
        details: 1,
      },
      filters,
    ),
  );
}

export async function fetchVisitors(
  siteId: string,
  window: TimeWindow,
  filters?: FilterDocument,
  options?: {
    limit?: number;
    cursor?: string | null;
    pageSize?: number;
    sortBy?: VisitorListSortKey;
    sortDir?: SortDirection;
    search?: string;
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
  if (options?.pageSize !== undefined) params.pageSize = options.pageSize;
  if (options?.limit !== undefined) {
    params.limit = options.limit;
  } else if (options?.pageSize === undefined) {
    params.limit = 100;
  }
  if (options?.sortBy) params.sortBy = options.sortBy;
  if (options?.sortDir) params.sortDir = options.sortDir;
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
  return fetchPrivateJson<VisitorDetailData>(
    "/api/private/visitor-detail",
    {
      siteId,
      visitorId: normalizedVisitorId,
      ...(window ? { from: window.from, to: window.to } : {}),
      ...(timeZone ? { timeZone } : {}),
    },
    { signal: options?.signal, dedupe: false },
  );
}

export async function fetchSessions(
  siteId: string,
  window: TimeWindow,
  filters?: FilterDocument,
  options?: {
    limit?: number;
    cursor?: string | null;
    pageSize?: number;
    sortBy?: SessionListSortKey;
    sortDir?: SortDirection;
    search?: string;
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
  if (options?.pageSize !== undefined) params.pageSize = options.pageSize;
  if (options?.limit !== undefined) {
    params.limit = options.limit;
  } else if (options?.pageSize === undefined) {
    params.limit = 100;
  }
  if (options?.sortBy) params.sortBy = options.sortBy;
  if (options?.sortDir) params.sortDir = options.sortDir;
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

export async function fetchFunnels(
  siteId: string,
  options?: { signal?: AbortSignal },
): Promise<FunnelListData> {
  return options?.signal
    ? fetchPrivateJson<FunnelListData>(
        "/api/private/funnels",
        { siteId },
        {
          signal: options.signal,
        },
      )
    : fetchPrivateJson<FunnelListData>("/api/private/funnels", { siteId });
}

export async function fetchFunnelDetail(
  siteId: string,
  funnelId: string,
  window: TimeWindow,
  filters?: FilterDocument,
  options?: { signal?: AbortSignal },
): Promise<FunnelDetailData> {
  const normalizedFunnelId = funnelId.trim();
  if (!normalizedFunnelId) {
    throw new Error("Funnel id is required");
  }
  return fetchPrivateJson<FunnelDetailData>(
    "/api/private/funnels",
    withFilters(
      {
        siteId,
        id: normalizedFunnelId,
        from: window.from,
        to: window.to,
        timeZone: window.timeZone,
      },
      filters,
    ),
    { dedupe: false, signal: options?.signal },
  );
}

export async function createFunnel(
  siteId: string,
  name: string,
  steps: FunnelStep[],
): Promise<FunnelMutationData> {
  return fetchPrivateJsonMutate<FunnelMutationData>(
    "/api/private/funnels",
    "POST",
    { siteId },
    { name, steps },
  );
}

export async function deleteFunnel(
  siteId: string,
  funnelId: string,
): Promise<FunnelDeleteData> {
  return fetchPrivateJsonMutate<FunnelDeleteData>(
    "/api/private/funnels",
    "DELETE",
    { siteId, id: funnelId },
  );
}

export async function fetchEventsSummary(
  siteId: string,
  window: TimeWindow,
  filters?: FilterDocument,
  options?: { signal?: AbortSignal },
): Promise<EventsSummaryData> {
  const requestParams = withFilters(
    {
      siteId,
      from: window.from,
      to: window.to,
      timeZone: window.timeZone,
    },
    filters,
  );
  const request = options?.signal
    ? fetchPrivateJson<EventsSummaryData>(
        "/api/private/events-summary",
        requestParams,
        { signal: options.signal },
      )
    : fetchPrivateJson<EventsSummaryData>(
        "/api/private/events-summary",
        requestParams,
      );
  return request.catch((error) =>
    fallbackUnlessAborted(error, emptyEventsSummary),
  );
}

export async function fetchEventsTrend(
  siteId: string,
  window: TimeWindow,
  filters?: FilterDocument,
  options?: {
    limit?: number;
    eventName?: string;
    signal?: AbortSignal;
  },
): Promise<EventsTrendData> {
  const params: Record<string, string | number> = {
    siteId,
    from: window.from,
    to: window.to,
    timeZone: window.timeZone,
    interval: window.interval,
    limit: options?.limit ?? 8,
  };
  const eventName = options?.eventName?.trim();
  if (eventName) params.eventName = eventName;
  const requestParams = withFilters(params, filters);
  const request = options?.signal
    ? fetchPrivateJson<EventsTrendData>(
        "/api/private/events-trend",
        requestParams,
        { signal: options.signal },
      )
    : fetchPrivateJson<EventsTrendData>(
        "/api/private/events-trend",
        requestParams,
      );
  return request.catch((error) =>
    fallbackUnlessAborted(error, () => emptyEventsTrend(window.interval)),
  );
}

export async function fetchEventsRecords(
  siteId: string,
  window: TimeWindow,
  filters?: FilterDocument,
  options?: {
    cursor?: string | null;
    pageSize?: number;
    sortBy?: EventRecordSortKey;
    sortDir?: SortDirection;
    search?: string;
    eventName?: string;
    signal?: AbortSignal;
  },
): Promise<EventsRecordsData> {
  const pageSize = options?.pageSize ?? 80;
  const params: Record<string, string | number> = {
    siteId,
    from: window.from,
    to: window.to,
    timeZone: window.timeZone,
    pageSize,
  };
  if (options?.cursor) params.cursor = options.cursor;
  if (options?.sortBy) params.sortBy = options.sortBy;
  if (options?.sortDir) params.sortDir = options.sortDir;
  const search = options?.search?.trim();
  if (search) params.search = search;
  const eventName = options?.eventName?.trim();
  if (eventName) params.eventName = eventName;
  const requestParams = withFilters(params, filters);
  const request = options?.signal
    ? fetchPrivateJson<EventsRecordsData>(
        "/api/private/events-records",
        requestParams,
        { signal: options.signal },
      )
    : fetchPrivateJson<EventsRecordsData>(
        "/api/private/events-records",
        requestParams,
      );
  return request.catch((error) =>
    fallbackUnlessAborted(error, () => emptyEventsRecords(pageSize)),
  );
}

export async function fetchEventTypeDetail(
  siteId: string,
  window: TimeWindow,
  eventName: string,
  filters?: FilterDocument,
  options?: { signal?: AbortSignal },
): Promise<EventTypeDetailData> {
  const normalizedEventName = eventName.trim();
  if (!normalizedEventName) {
    return emptyEventTypeDetail("");
  }
  const requestParams = withFilters(
    {
      siteId,
      from: window.from,
      to: window.to,
      timeZone: window.timeZone,
      interval: window.interval,
      eventName: normalizedEventName,
      includeContext: "false",
      includeBreakdowns: "false",
      includeFields: "false",
    },
    filters,
  );
  const request = options?.signal
    ? fetchPrivateJson<EventTypeDetailData>(
        "/api/private/event-type-detail",
        requestParams,
        { signal: options.signal },
      )
    : fetchPrivateJson<EventTypeDetailData>(
        "/api/private/event-type-detail",
        requestParams,
      );
  return request.catch((error) =>
    fallbackUnlessAborted(error, () =>
      emptyEventTypeDetail(normalizedEventName),
    ),
  );
}

export async function fetchEventTypeFields(
  siteId: string,
  window: TimeWindow,
  eventName?: string,
  filters?: FilterDocument,
  options?: { signal?: AbortSignal },
): Promise<Pick<EventTypeDetailData, "fields">> {
  const normalizedEventName = eventName?.trim() ?? "";
  return fetchPrivateJson<Pick<EventTypeDetailData, "fields">>(
    "/api/private/event-type-fields",
    withFilters(
      {
        siteId,
        from: window.from,
        to: window.to,
        timeZone: window.timeZone,
        ...(normalizedEventName ? { eventName: normalizedEventName } : {}),
      },
      filters,
    ),
    { signal: options?.signal },
  ).catch((error) => fallbackUnlessAborted(error, () => ({ fields: [] })));
}

export async function fetchEventTypeContextCards(
  siteId: string,
  window: TimeWindow,
  eventName: string,
  cards: string,
  filters?: FilterDocument,
): Promise<EventTypeDetailData["cards"]> {
  const normalizedEventName = eventName.trim();
  const normalizedCards = cards.trim();
  if (!normalizedEventName || !normalizedCards) {
    return emptyEventTypeDetail(normalizedEventName).cards;
  }
  return fetchPrivateJson<Pick<EventTypeDetailData, "cards">>(
    "/api/private/event-type-context",
    withFilters(
      {
        siteId,
        from: window.from,
        to: window.to,
        timeZone: window.timeZone,
        interval: window.interval,
        eventName: normalizedEventName,
        cards: normalizedCards,
      },
      filters,
    ),
  )
    .then((data) => data.cards)
    .catch(() => emptyEventTypeDetail(normalizedEventName).cards);
}

export async function fetchEventTypeFieldValues(
  siteId: string,
  window: TimeWindow,
  eventName: string | undefined,
  fieldPath: string,
  fieldValueType: EventField["valueType"],
  filters?: FilterDocument,
  options?: {
    limit?: number;
    search?: string;
    signal?: AbortSignal;
  },
): Promise<EventFieldValuesData> {
  const normalizedEventName = eventName?.trim() ?? "";
  const normalizedFieldPath = String(fieldPath ?? "");
  if (!normalizedFieldPath) {
    return emptyEventFieldValues(normalizedFieldPath, fieldValueType);
  }
  return fetchPrivateJson<EventFieldValuesData>(
    "/api/private/event-type-field-values",
    withFilters(
      {
        siteId,
        from: window.from,
        to: window.to,
        timeZone: window.timeZone,
        ...(normalizedEventName ? { eventName: normalizedEventName } : {}),
        fieldPath: normalizedFieldPath,
        fieldValueType,
        limit: options?.limit ?? 25,
        ...(options?.search?.trim() ? { search: options.search.trim() } : {}),
      },
      filters,
    ),
    { signal: options?.signal },
  ).catch((error) =>
    fallbackUnlessAborted(error, () =>
      emptyEventFieldValues(normalizedFieldPath, fieldValueType),
    ),
  );
}

export async function fetchEventRecordDetail(
  siteId: string,
  eventId: string,
  window?: TimeWindow,
  options?: { signal?: AbortSignal; preserveErrors?: boolean },
): Promise<EventRecordDetailData> {
  const normalizedEventId = eventId.trim();
  if (!normalizedEventId) return emptyEventRecordDetail();
  const request = fetchPrivateJson<EventRecordDetailData>(
    "/api/private/event-record-detail",
    {
      siteId,
      eventId: normalizedEventId,
      ...(window ? { from: window.from, to: window.to } : {}),
    },
    { signal: options?.signal },
  );
  return options?.preserveErrors
    ? request
    : request.catch((error) =>
        fallbackUnlessAborted(error, emptyEventRecordDetail),
      );
}

export async function fetchJourneyEventDetail(
  siteId: string,
  eventId: string,
  eventKind: Exclude<JourneyEvent["kind"], "custom">,
  window?: TimeWindow,
  options?: {
    sessionId?: string;
    visitId?: string;
    signal?: AbortSignal;
    preserveErrors?: boolean;
  },
): Promise<JourneyEventDetailData> {
  const normalizedEventId = eventId.trim();
  if (!normalizedEventId) return emptyJourneyEventDetail();

  const params = {
    siteId,
    eventId: normalizedEventId,
    eventKind,
    ...(window ? { from: window.from, to: window.to } : {}),
    ...(options?.sessionId?.trim()
      ? { sessionId: options.sessionId.trim() }
      : {}),
    ...(options?.visitId?.trim() ? { visitId: options.visitId.trim() } : {}),
  };
  const request = fetchPrivateJson<JourneyEventDetailData>(
    "/api/private/journey-event-detail",
    params,
    { signal: options?.signal },
  );
  return options?.preserveErrors
    ? request
    : request.catch((error) =>
        fallbackUnlessAborted(error, emptyJourneyEventDetail),
      );
}

export async function fetchPerformance(
  siteId: string,
  window: TimeWindow,
  filters?: FilterDocument,
  options?: { signal?: AbortSignal },
): Promise<PerformanceData> {
  const requestParams = withFilters(
    {
      siteId,
      from: window.from,
      to: window.to,
      timeZone: window.timeZone,
      interval: window.interval,
    },
    filters,
  );
  const request = options?.signal
    ? fetchPrivateJson<PerformanceData>(
        "/api/private/performance",
        requestParams,
        { signal: options.signal },
      )
    : fetchPrivateJson<PerformanceData>(
        "/api/private/performance",
        requestParams,
      );
  return request.catch((error) =>
    fallbackUnlessAborted(error, () => emptyPerformance(window.interval)),
  );
}

export async function fetchRetention(
  siteId: string,
  window: TimeWindow,
  filters?: FilterDocument,
  options?: {
    granularity?: RetentionGranularity;
    signal?: AbortSignal;
  },
): Promise<RetentionData> {
  const granularity = options?.granularity ?? "week";
  const requestParams = withFilters(
    {
      siteId,
      from: window.from,
      to: window.to,
      timeZone: window.timeZone,
      granularity,
    },
    filters,
  );
  return options?.signal
    ? fetchPrivateJson<RetentionData>("/api/private/retention", requestParams, {
        signal: options.signal,
      })
    : fetchPrivateJson<RetentionData>("/api/private/retention", requestParams);
}
