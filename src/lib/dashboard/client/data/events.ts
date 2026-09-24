import {
  emptyEventFieldValues,
  emptyEventRecordDetail,
  emptyEventsRecords,
  emptyEventsSummary,
  emptyEventsTrend,
  emptyEventTypeDetail,
  emptyJourneyEventDetail,
} from "@/lib/dashboard/client/data/empty";
import type {
  EventRecordSortKey,
  SortDirection,
} from "@/lib/dashboard/client/data/types";
import { fetchPrivateJson } from "@/lib/dashboard/client/request";
import {
  normalizePaginatedCollection,
  withFilters,
  withPagination,
} from "@/lib/dashboard/client/utils";
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
  EventsTrendResponseData,
  EventTypeDetailData,
  EventTypeFieldsData,
  JourneyEvent,
  JourneyEventDetailData,
} from "@/lib/dashboard-api/client/edge";
import type { FilterDocument, FilterScope } from "@/lib/filter-contract";
function fallbackUnlessAborted<T>(error: unknown, fallback: () => T): T {
  if (error instanceof Error && error.name === "AbortError") throw error;
  if (
    error instanceof Error &&
    (error.message === "pagination_contract_violation" ||
      error.message === "events_trend_contract_violation")
  ) {
    throw error;
  }
  return fallback();
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
    ? fetchPrivateJson<EventsTrendResponseData>(
        "/api/private/events-trend",
        requestParams,
        { signal: options.signal },
      )
    : fetchPrivateJson<EventsTrendResponseData>(
        "/api/private/events-trend",
        requestParams,
      );
  return request
    .then((value) => {
      const payload = value as EventsTrendResponseData;
      const data = payload?.data;
      if (
        !data ||
        !(
          data.interval === "minute" ||
          data.interval === "hour" ||
          data.interval === "day" ||
          data.interval === "week" ||
          data.interval === "month"
        ) ||
        !Array.isArray(data.series) ||
        !Array.isArray(data.data)
      ) {
        throw new Error("events_trend_contract_violation");
      }
      return {
        ok: payload.ok,
        interval: data.interval,
        series: data.series,
        data: data.data,
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
      const payload = value as EventsRecordsData;
      return {
        ok: payload.ok,
        data: normalizePaginatedCollection<EventRecord>(payload.data),
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
    data: normalizePaginatedCollection<EventFieldValueStat>(payload.data),
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
