import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  createFunnel,
  deleteFunnel,
  fetchEventRecordDetail,
  fetchEventsRecords,
  fetchEventsSummary,
  fetchEventsTrend,
  fetchEventTypeContextCards,
  fetchEventTypeDetail,
  fetchEventTypeFields,
  fetchEventTypeFieldValues,
  fetchFunnelDetail,
  fetchFunnels,
  fetchJourneyEventDetail,
  fetchPerformance,
  fetchSessionDetail,
  fetchSessions,
  fetchVisitorDetail,
  fetchVisitors,
} from "@/lib/dashboard/client-core-data";
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
import { dashboardFilterDocumentFromPresentation } from "@/lib/dashboard/filter-state";

vi.mock("@/lib/dashboard/client-request", () => ({
  fetchPrivateJson: vi.fn(),
  fetchPrivateJsonMutate: vi.fn(),
}));

vi.mock("@/lib/dashboard/client-utils", () => ({
  normalizePaginatedCollection: vi.fn((value: unknown, fallbackLimit = 0) => {
    const items = Array.isArray(value)
      ? value
      : value &&
          typeof value === "object" &&
          Array.isArray((value as { items?: unknown }).items)
        ? (value as { items: unknown[] }).items
        : [];
    const pagination =
      value &&
      typeof value === "object" &&
      (value as { pagination?: unknown }).pagination
        ? (value as { pagination: unknown }).pagination
        : {
            limit: fallbackLimit,
            returned: items.length,
            hasMore: false,
            nextCursor: null,
          };
    return { items, pagination };
  }),
  withFilters: vi.fn(
    (
      params: Record<string, unknown>,
      _filters: unknown,
      resolvedScope?: string,
    ) => (resolvedScope ? { ...params, scope: resolvedScope } : params),
  ),
  withPagination: vi.fn(
    (
      params: Record<string, unknown>,
      options?: { limit?: number; cursor?: string | null },
      defaultLimit?: number,
    ) => ({
      ...params,
      ...(options?.limit !== undefined
        ? { limit: options.limit }
        : defaultLimit !== undefined
          ? { limit: defaultLimit }
          : {}),
      ...(options?.cursor ? { cursor: options.cursor } : {}),
    }),
  ),
}));

import {
  fetchPrivateJson,
  fetchPrivateJsonMutate,
} from "@/lib/dashboard/client-request";

const fetchPrivateJsonMock = vi.mocked(fetchPrivateJson);
const fetchPrivateJsonMutateMock = vi.mocked(fetchPrivateJsonMutate);

const window = {
  preset: "custom" as const,
  from: 1000,
  to: 2000,
  timeZone: "UTC",
  interval: "day" as const,
};

beforeEach(() => {
  fetchPrivateJsonMock.mockReset();
  fetchPrivateJsonMutateMock.mockReset();
  fetchPrivateJsonMock.mockResolvedValue({ ok: true } as any);
});

describe("fetchVisitors", () => {
  it("assembles pagination options correctly", async () => {
    fetchPrivateJsonMock.mockResolvedValueOnce({
      ok: true,
      visitors: [],
    } as any);

    await fetchVisitors("site-1", window, undefined, {
      cursor: "visitor-cursor",
      limit: 25,
      sortBy: "lastSeenAt",
      sortDir: "desc",
      search: "test",
    });

    expect(fetchPrivateJsonMock).toHaveBeenCalledWith(
      "/api/private/visitors",
      expect.objectContaining({
        cursor: "visitor-cursor",
        limit: 25,
        sortBy: "lastSeenAt",
        sortDir: "desc",
        search: "test",
      }),
    );
  });

  it("uses default limit=100 when no limit is specified", async () => {
    fetchPrivateJsonMock.mockResolvedValueOnce({ ok: true } as any);

    await fetchVisitors("site-1", window);

    expect(fetchPrivateJsonMock).toHaveBeenCalledWith(
      "/api/private/visitors",
      expect.objectContaining({ limit: 100 }),
    );
  });

  it("uses explicit limit when provided", async () => {
    fetchPrivateJsonMock.mockResolvedValueOnce({ ok: true } as any);

    await fetchVisitors("site-1", window, undefined, { limit: 50 });

    expect(fetchPrivateJsonMock).toHaveBeenCalledWith(
      "/api/private/visitors",
      expect.objectContaining({ limit: 50 }),
    );
  });

  it("uses the explicit limit", async () => {
    fetchPrivateJsonMock.mockResolvedValueOnce({ ok: true } as any);

    await fetchVisitors("site-1", window, undefined, { limit: 25 });

    const params = fetchPrivateJsonMock.mock.calls[0][1] as Record<
      string,
      unknown
    >;
    expect(params.limit).toBe(25);
  });

  it("falls back to emptyVisitors on error", async () => {
    fetchPrivateJsonMock.mockRejectedValueOnce(new Error("network"));

    const result = await fetchVisitors("site-1", window);
    expect(result).toEqual(emptyVisitors());
  });

  it("trims search parameter", async () => {
    fetchPrivateJsonMock.mockResolvedValueOnce({ ok: true } as any);

    await fetchVisitors("site-1", window, undefined, { search: "  test  " });

    expect(fetchPrivateJsonMock).toHaveBeenCalledWith(
      "/api/private/visitors",
      expect.objectContaining({ search: "test" }),
    );
  });

  it("omits empty search", async () => {
    fetchPrivateJsonMock.mockResolvedValueOnce({ ok: true } as any);

    await fetchVisitors("site-1", window, undefined, { search: "   " });

    const params = fetchPrivateJsonMock.mock.calls[0][1] as Record<
      string,
      unknown
    >;
    expect(params.search).toBeUndefined();
  });
});

describe("fetchSessions", () => {
  it("assembles pagination options correctly", async () => {
    fetchPrivateJsonMock.mockResolvedValueOnce({
      ok: true,
      sessions: [],
    } as any);

    await fetchSessions("site-1", window, undefined, {
      cursor: "session-cursor",
      limit: 10,
      sortBy: "startedAt",
      sortDir: "asc",
      search: "abc",
    });

    expect(fetchPrivateJsonMock).toHaveBeenCalledWith(
      "/api/private/sessions",
      expect.objectContaining({
        cursor: "session-cursor",
        limit: 10,
        sortBy: "startedAt",
        sortDir: "asc",
        search: "abc",
      }),
    );
  });

  it("falls back to emptySessions on error", async () => {
    fetchPrivateJsonMock.mockRejectedValueOnce(new Error("fail"));

    const result = await fetchSessions("site-1", window);
    expect(result).toEqual(emptySessions());
  });
});

describe("fetchVisitorDetail", () => {
  it("returns emptyVisitorDetail for empty visitorId", async () => {
    const result = await fetchVisitorDetail("site-1", "  ");
    expect(result).toEqual(emptyVisitorDetail());
    expect(fetchPrivateJsonMock).not.toHaveBeenCalled();
  });

  it("calls fetchPrivateJson with normalized visitorId", async () => {
    fetchPrivateJsonMock.mockResolvedValueOnce({ ok: true } as any);

    await fetchVisitorDetail(
      "site-1",
      "  visitor-123  ",
      "America/New_York",
      window,
    );

    expect(fetchPrivateJsonMock).toHaveBeenCalledWith(
      "/api/private/visitor-detail",
      expect.objectContaining({
        visitorId: "visitor-123",
        timeZone: "America/New_York",
      }),
      expect.anything(),
    );
  });
});

describe("fetchSessionDetail", () => {
  it("returns emptySessionDetail for empty sessionId", async () => {
    const result = await fetchSessionDetail("site-1", "");
    expect(result).toEqual(emptySessionDetail());
    expect(fetchPrivateJsonMock).not.toHaveBeenCalled();
  });
});

describe("fetchFunnelDetail", () => {
  it("fetches funnel lists by site", async () => {
    fetchPrivateJsonMock.mockResolvedValueOnce({ funnels: [] } as any);

    await fetchFunnels("site-1");

    expect(fetchPrivateJsonMock).toHaveBeenCalledWith("/api/private/funnels", {
      siteId: "site-1",
      limit: 100,
    });
  });

  it("throws for empty funnelId", async () => {
    await expect(fetchFunnelDetail("site-1", "  ", window)).rejects.toThrow(
      "Funnel id is required",
    );
    expect(fetchPrivateJsonMock).not.toHaveBeenCalled();
  });

  it("creates and deletes funnels through mutation requests", async () => {
    fetchPrivateJsonMutateMock.mockResolvedValueOnce({ ok: true } as any);
    fetchPrivateJsonMutateMock.mockResolvedValueOnce({ ok: true } as any);

    await createFunnel("site-1", "Signup", [
      { id: "step-1", type: "page", value: "/signup" },
    ] as any);
    await deleteFunnel("site-1", "funnel-1");

    expect(fetchPrivateJsonMutateMock).toHaveBeenNthCalledWith(
      1,
      "/api/private/funnels",
      "POST",
      { siteId: "site-1" },
      {
        name: "Signup",
        steps: [{ id: "step-1", type: "page", value: "/signup" }],
      },
    );
    expect(fetchPrivateJsonMutateMock).toHaveBeenNthCalledWith(
      2,
      "/api/private/funnels",
      "DELETE",
      { siteId: "site-1", id: "funnel-1" },
    );
  });
});

describe("fetchEventTypeDetail", () => {
  it("returns emptyEventTypeDetail for empty eventName", async () => {
    const result = await fetchEventTypeDetail("site-1", window, "  ");
    expect(result).toEqual(emptyEventTypeDetail(""));
    expect(fetchPrivateJsonMock).not.toHaveBeenCalled();
  });

  it("falls back to emptyEventTypeDetail on error", async () => {
    fetchPrivateJsonMock.mockRejectedValueOnce(new Error("fail"));

    const result = await fetchEventTypeDetail("site-1", window, "click");
    expect(result).toEqual(emptyEventTypeDetail("click"));
  });

  it("requests the private summary-only detail shape", async () => {
    await fetchEventTypeDetail("site-1", window, "click");

    expect(fetchPrivateJsonMock).toHaveBeenCalledWith(
      "/api/private/event-type-detail",
      expect.objectContaining({
        includeContext: "false",
        includeBreakdowns: "false",
        includeFields: "false",
      }),
    );
  });
});

describe("fetchEventTypeFields", () => {
  it("loads fields across event types without an event name", async () => {
    await fetchEventTypeFields("site-1", window, "  ");

    expect(fetchPrivateJsonMock).toHaveBeenCalledWith(
      "/api/private/event-type-fields",
      expect.not.objectContaining({ eventName: expect.anything() }),
      { signal: undefined },
    );
  });

  it("uses the private fields endpoint and keeps filters", async () => {
    await fetchEventTypeFields(
      "site-1",
      window,
      "click",
      dashboardFilterDocumentFromPresentation({ country: "CN" }),
    );

    expect(fetchPrivateJsonMock).toHaveBeenCalledWith(
      "/api/private/event-type-fields",
      expect.objectContaining({ eventName: "click" }),
      { signal: undefined },
    );
  });

  it("passes the resolved scope for payload field suggestions", async () => {
    await fetchEventTypeFields("site-1", window, "click", undefined, {
      resolvedScope: "session",
    });

    expect(fetchPrivateJsonMock).toHaveBeenCalledWith(
      "/api/private/event-type-fields",
      expect.objectContaining({ scope: "session" }),
      { signal: undefined },
    );
  });

  it("falls back to empty fields when the request fails", async () => {
    fetchPrivateJsonMock.mockRejectedValueOnce(new Error("fail"));

    await expect(
      fetchEventTypeFields("site-1", window, "click"),
    ).resolves.toEqual({
      ok: true,
      eventName: "click",
      data: {
        items: [],
        pagination: {
          limit: 100,
          returned: 0,
          hasMore: false,
          nextCursor: null,
        },
      },
    });
  });
});

describe("fetchEventTypeContextCards", () => {
  it("skips requests until both event and card keys are available", async () => {
    const cards = await fetchEventTypeContextCards(
      "site-1",
      window,
      " ",
      "path",
    );

    expect(cards).toEqual(emptyEventTypeDetail("").cards);
    expect(fetchPrivateJsonMock).not.toHaveBeenCalled();
  });

  it("loads the requested context card and returns its response shape", async () => {
    const cards = emptyEventTypeDetail("click").cards;
    cards.page.path = [
      { label: "/pricing", views: 2, sessions: 1, visitors: 1 },
    ];
    fetchPrivateJsonMock.mockResolvedValueOnce({ cards } as any);

    await expect(
      fetchEventTypeContextCards(
        "site-1",
        window,
        " click ",
        " path ",
        dashboardFilterDocumentFromPresentation({ country: "CN" }),
      ),
    ).resolves.toEqual(cards);
    expect(fetchPrivateJsonMock).toHaveBeenCalledWith(
      "/api/private/event-type-context",
      expect.objectContaining({ eventName: "click", cards: "path" }),
    );
  });

  it("falls back to an empty card shape when context loading fails", async () => {
    fetchPrivateJsonMock.mockRejectedValueOnce(new Error("fail"));

    await expect(
      fetchEventTypeContextCards("site-1", window, "click", "path"),
    ).resolves.toEqual(emptyEventTypeDetail("click").cards);
  });
});

describe("fetchEventTypeFieldValues", () => {
  it("forwards a trimmed search term", async () => {
    fetchPrivateJsonMock.mockResolvedValueOnce(
      emptyEventFieldValues("path", "string"),
    );

    await fetchEventTypeFieldValues(
      "site-1",
      window,
      "click",
      "path",
      "string",
      undefined,
      { search: "  pro  " },
    );

    expect(fetchPrivateJsonMock).toHaveBeenCalledWith(
      "/api/private/event-type-field-values",
      expect.objectContaining({ search: "pro" }),
      { signal: undefined },
    );
  });

  it("passes the resolved scope with event payload value filters", async () => {
    fetchPrivateJsonMock.mockResolvedValueOnce(
      emptyEventFieldValues("payload.plan", "string"),
    );

    await fetchEventTypeFieldValues(
      "site-1",
      window,
      "click",
      "payload.plan",
      "string",
      dashboardFilterDocumentFromPresentation({ path: "/pricing" }),
      { resolvedScope: "visitor" },
    );

    expect(fetchPrivateJsonMock).toHaveBeenCalledWith(
      "/api/private/event-type-field-values",
      expect.objectContaining({
        scope: "visitor",
      }),
      { signal: undefined },
    );
  });

  it("loads field values across event types without an event name", async () => {
    await fetchEventTypeFieldValues("site-1", window, "  ", "field", "string");

    expect(fetchPrivateJsonMock).toHaveBeenCalledWith(
      "/api/private/event-type-field-values",
      expect.not.objectContaining({ eventName: expect.anything() }),
      { signal: undefined },
    );
  });

  it("returns emptyEventFieldValues for empty fieldPath", async () => {
    const result = await fetchEventTypeFieldValues(
      "site-1",
      window,
      "click",
      "",
      "string",
    );
    expect(result).toEqual(emptyEventFieldValues("", "string"));
    expect(fetchPrivateJsonMock).not.toHaveBeenCalled();
  });

  it("falls back on error", async () => {
    fetchPrivateJsonMock.mockRejectedValueOnce(new Error("fail"));

    const result = await fetchEventTypeFieldValues(
      "site-1",
      window,
      "click",
      "path",
      "number",
    );
    expect(result).toEqual(emptyEventFieldValues("path", "number"));
  });
});

describe("fetchEventRecordDetail", () => {
  it("returns emptyEventRecordDetail for empty eventId", async () => {
    const result = await fetchEventRecordDetail("site-1", "  ");
    expect(result).toEqual(emptyEventRecordDetail());
    expect(fetchPrivateJsonMock).not.toHaveBeenCalled();
  });

  it("falls back on error", async () => {
    fetchPrivateJsonMock.mockRejectedValueOnce(new Error("fail"));

    const result = await fetchEventRecordDetail("site-1", "evt-1");
    expect(result).toEqual(emptyEventRecordDetail());
  });

  it("can preserve detail request errors for the drawer", async () => {
    fetchPrivateJsonMock.mockRejectedValueOnce(new Error("fail"));

    await expect(
      fetchEventRecordDetail("site-1", "evt-1", undefined, {
        preserveErrors: true,
      }),
    ).rejects.toThrow("fail");
  });

  it("forwards cancellation signals and preserves aborts", async () => {
    const controller = new AbortController();
    fetchPrivateJsonMock.mockResolvedValueOnce(emptyEventRecordDetail());

    await fetchEventRecordDetail("site-1", "evt-1", window, {
      signal: controller.signal,
    });

    expect(fetchPrivateJsonMock).toHaveBeenCalledWith(
      "/api/private/event-record-detail",
      expect.objectContaining({ siteId: "site-1", eventId: "evt-1" }),
      { signal: controller.signal },
    );

    const aborted = new AbortController();
    aborted.abort();
    fetchPrivateJsonMock.mockRejectedValueOnce(
      new DOMException("Aborted", "AbortError"),
    );

    await expect(
      fetchEventRecordDetail("site-1", "evt-1", window, {
        signal: aborted.signal,
      }),
    ).rejects.toMatchObject({ name: "AbortError" });
  });
});

describe("fetchJourneyEventDetail", () => {
  it("returns an empty detail without requesting an empty event id", async () => {
    const result = await fetchJourneyEventDetail("site-1", "  ", "pageview");

    expect(result).toEqual(emptyJourneyEventDetail());
    expect(fetchPrivateJsonMock).not.toHaveBeenCalled();
  });

  it("forwards the event kind, time window, and parent identifiers", async () => {
    fetchPrivateJsonMock.mockResolvedValueOnce(emptyJourneyEventDetail());
    const controller = new AbortController();

    await fetchJourneyEventDetail("site-1", "visit-1", "pageview", window, {
      sessionId: "session-1",
      visitId: "visit-1",
      signal: controller.signal,
    });

    expect(fetchPrivateJsonMock).toHaveBeenCalledWith(
      "/api/private/journey-event-detail",
      {
        siteId: "site-1",
        eventId: "visit-1",
        eventKind: "pageview",
        from: 1000,
        to: 2000,
        sessionId: "session-1",
        visitId: "visit-1",
      },
      { signal: controller.signal },
    );
  });
});

describe("fetchEventsTrend", () => {
  it("includes eventName when provided", async () => {
    fetchPrivateJsonMock.mockResolvedValueOnce({ ok: true } as any);

    await fetchEventsTrend("site-1", window, undefined, { eventName: "click" });

    expect(fetchPrivateJsonMock).toHaveBeenCalledWith(
      "/api/private/events-trend",
      expect.objectContaining({ eventName: "click" }),
    );
  });

  it("omits eventName when not provided", async () => {
    fetchPrivateJsonMock.mockResolvedValueOnce({ ok: true } as any);

    await fetchEventsTrend("site-1", window);

    const params = fetchPrivateJsonMock.mock.calls[0][1] as Record<
      string,
      unknown
    >;
    expect(params.eventName).toBeUndefined();
  });

  it("falls back on error", async () => {
    fetchPrivateJsonMock.mockRejectedValueOnce(new Error("fail"));

    const result = await fetchEventsTrend("site-1", window);
    expect(result).toEqual(emptyEventsTrend(window.interval));
  });
});

describe("fetchEventsRecords", () => {
  it("assembles search and eventName parameters", async () => {
    fetchPrivateJsonMock.mockResolvedValueOnce({ ok: true } as any);

    await fetchEventsRecords("site-1", window, undefined, {
      search: "test",
      eventName: "click",
      cursor: "event-cursor",
      limit: 20,
      sortBy: "occurredAt",
      sortDir: "desc",
    });

    expect(fetchPrivateJsonMock).toHaveBeenCalledWith(
      "/api/private/events-records",
      expect.objectContaining({
        search: "test",
        eventName: "click",
        cursor: "event-cursor",
        limit: 20,
        sortBy: "occurredAt",
        sortDir: "desc",
      }),
    );
  });

  it("normalizes a successful legacy collection before pagination consumers read it", async () => {
    const event = { eventId: "event-1" };
    fetchPrivateJsonMock.mockResolvedValueOnce({
      ok: true,
      data: [event],
    } as any);

    await expect(
      fetchEventsRecords("site-1", window, undefined, { limit: 20 }),
    ).resolves.toMatchObject({
      ok: true,
      data: {
        items: [event],
        pagination: {
          limit: 20,
          returned: 1,
          hasMore: false,
          nextCursor: null,
        },
      },
    });
  });

  it("falls back on error", async () => {
    fetchPrivateJsonMock.mockRejectedValueOnce(new Error("fail"));

    const result = await fetchEventsRecords("site-1", window);
    expect(result).toEqual(emptyEventsRecords(80));
  });
});

describe("fetchEventsSummary", () => {
  it("falls back on error", async () => {
    fetchPrivateJsonMock.mockRejectedValueOnce(new Error("fail"));

    const result = await fetchEventsSummary("site-1", window);
    expect(result).toEqual(emptyEventsSummary());
  });
});

describe("fetchPerformance", () => {
  it("falls back on error", async () => {
    fetchPrivateJsonMock.mockRejectedValueOnce(new Error("fail"));

    const result = await fetchPerformance("site-1", window);
    expect(result).toEqual(emptyPerformance(window.interval));
  });
});
