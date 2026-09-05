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
  EventFieldValueStat,
  EventRecord,
  EventRecordDetailData,
  EventsRecordsData,
  EventsSummaryData,
  EventsTrendData,
  EventTypeDetailData,
  EventTypeFieldsData,
  FunnelDeleteData,
  FunnelDetailData,
  FunnelListData,
  FunnelMutationData,
  FunnelStep,
  JourneyEvent,
  JourneyEventDetailData,
  JourneyEventsData,
  OverviewData,
  PagesData,
  PerformanceData,
  RetentionData,
  SessionDetailData,
  SessionEventsData,
  SessionsData,
  TrendData,
  VisitorDetailData,
  VisitorsData,
  VisitorSessionsData,
} from "@/lib/edge-client";
import type { FilterDocument, FilterScope } from "@/lib/filter-contract";

import { fetchPrivateJson, fetchPrivateJsonMutate } from "./client-request";
import {
  normalizePaginatedCollection,
  withFilters,
  withPagination,
} from "./client-utils";

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
  options?: {
    limit?: number;
    cursor?: string | null;
    signal?: AbortSignal;
  },
): Promise<PagesData> {
  return fetchPrivateJson<PagesData>(
    "/api/private/pages",
    withFilters(
      withPagination(
        {
          siteId,
          from: window.from,
          to: window.to,
          timeZone: window.timeZone,
          details: 1,
        },
        options,
        100,
      ),
      filters,
    ),
    { signal: options?.signal },
  );
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

export async function fetchFunnels(
  siteId: string,
  options?: {
    limit?: number;
    cursor?: string | null;
    signal?: AbortSignal;
  },
): Promise<FunnelListData> {
  const requestParams = withPagination({ siteId }, options, 100);
  return options?.signal
    ? fetchPrivateJson<FunnelListData>("/api/private/funnels", requestParams, {
        signal: options.signal,
      })
    : fetchPrivateJson<FunnelListData>("/api/private/funnels", requestParams);
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
  return request
    .then((value) => {
      const payload =
        value && typeof value === "object"
          ? (value as unknown as Record<string, unknown>)
          : {};
      const nested =
        payload.data && typeof payload.data === "object"
          ? (payload.data as Record<string, unknown>)
          : payload;
      const interval =
        nested.interval === "minute" ||
        nested.interval === "hour" ||
        nested.interval === "day" ||
        nested.interval === "week" ||
        nested.interval === "month"
          ? nested.interval
          : window.interval;
      return {
        ok: payload.ok !== false,
        interval,
        series: Array.isArray(nested.series) ? nested.series : [],
        data: Array.isArray(nested.data) ? nested.data : [],
      } satisfies EventsTrendData;
    })
    .catch((error) =>
      fallbackUnlessAborted(error, () => emptyEventsTrend(window.interval)),
    );
}

export async function fetchEventsRecords(
  siteId: string,
  window: TimeWindow,
  filters?: FilterDocument,
  options?: {
    cursor?: string | null;
    limit?: number;
    sortBy?: EventRecordSortKey;
    sortDir?: SortDirection;
    search?: string;
    eventName?: string;
    signal?: AbortSignal;
  },
): Promise<EventsRecordsData> {
  const limit = options?.limit ?? 80;
  const params: Record<string, string | number> = {
    siteId,
    from: window.from,
    to: window.to,
    timeZone: window.timeZone,
    limit,
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
  return request
    .then((value) => {
      // Keep the pagination consumer safe when a rolling deployment briefly
      // returns the collection without the standard envelope. The API
      // contract is still strict; this boundary merely prevents a malformed
      // successful payload from turning into a client-side TypeError.
      const payload =
        value && typeof value === "object"
          ? (value as unknown as Record<string, unknown>)
          : {};
      const collection = "data" in payload ? payload.data : payload;
      return {
        ok: payload.ok !== false,
        data: normalizePaginatedCollection<EventRecord>(collection, limit),
      } satisfies EventsRecordsData;
    })
    .catch((error) =>
      fallbackUnlessAborted(error, () => emptyEventsRecords(limit)),
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
  options?: {
    limit?: number;
    cursor?: string | null;
    signal?: AbortSignal;
    resolvedScope?: FilterScope;
  },
): Promise<EventTypeFieldsData> {
  const normalizedEventName = eventName?.trim() ?? "";
  const payload = await fetchPrivateJson<EventTypeFieldsData>(
    "/api/private/event-type-fields",
    withFilters(
      withPagination(
        {
          siteId,
          from: window.from,
          to: window.to,
          timeZone: window.timeZone,
          ...(normalizedEventName ? { eventName: normalizedEventName } : {}),
        },
        options,
        100,
      ),
      filters,
      options?.resolvedScope,
    ),
    { signal: options?.signal },
  ).catch((error) =>
    fallbackUnlessAborted(error, () => ({
      ok: true,
      eventName: normalizedEventName,
      data: {
        items: [],
        pagination: {
          limit: options?.limit ?? 100,
          returned: 0,
          hasMore: false,
          nextCursor: null,
        },
      },
    })),
  );
  const rawPayload = payload as EventTypeFieldsData & {
    fields?: unknown;
  };
  return {
    ...rawPayload,
    data: normalizePaginatedCollection<EventField>(
      rawPayload.data ?? rawPayload.fields,
      options?.limit ?? 100,
    ),
  };
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
    cursor?: string | null;
    search?: string;
    signal?: AbortSignal;
    resolvedScope?: FilterScope;
  },
): Promise<EventFieldValuesData> {
  const normalizedEventName = eventName?.trim() ?? "";
  const normalizedFieldPath = String(fieldPath ?? "");
  if (!normalizedFieldPath) {
    return emptyEventFieldValues(normalizedFieldPath, fieldValueType);
  }
  const payload = await fetchPrivateJson<EventFieldValuesData>(
    "/api/private/event-type-field-values",
    withFilters(
      withPagination(
        {
          siteId,
          from: window.from,
          to: window.to,
          timeZone: window.timeZone,
          ...(normalizedEventName ? { eventName: normalizedEventName } : {}),
          fieldPath: normalizedFieldPath,
          fieldValueType,
          ...(options?.search?.trim() ? { search: options.search.trim() } : {}),
        },
        options,
        25,
      ),
      filters,
      options?.resolvedScope,
    ),
    { signal: options?.signal },
  ).catch((error) =>
    fallbackUnlessAborted(error, () =>
      emptyEventFieldValues(normalizedFieldPath, fieldValueType),
    ),
  );
  return {
    ...payload,
    data: normalizePaginatedCollection<EventFieldValueStat>(
      payload.data,
      options?.limit ?? 25,
    ),
  };
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
