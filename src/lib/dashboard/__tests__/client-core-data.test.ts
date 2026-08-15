import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  createFunnel,
  deleteFunnel,
  fetchEventRecordDetail,
  fetchEventsRecords,
  fetchEventsSummary,
  fetchEventsTrend,
  fetchEventTypeDetail,
  fetchEventTypeFieldValues,
  fetchFunnelDetail,
  fetchFunnels,
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
  emptyPerformance,
  emptySessionDetail,
  emptySessions,
  emptyVisitorDetail,
  emptyVisitors,
} from "@/lib/dashboard/client-empty-data";

vi.mock("@/lib/dashboard/client-request", () => ({
  fetchPrivateJson: vi.fn(),
  fetchPrivateJsonMutate: vi.fn(),
}));

vi.mock("@/lib/dashboard/client-utils", () => ({
  withFilters: vi.fn((params: Record<string, unknown>) => params),
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
      page: 2,
      pageSize: 25,
      sortBy: "lastSeenAt",
      sortDir: "desc",
      search: "test",
    });

    expect(fetchPrivateJsonMock).toHaveBeenCalledWith(
      "/api/private/visitors",
      expect.objectContaining({
        page: 2,
        pageSize: 25,
        sortBy: "lastSeenAt",
        sortDir: "desc",
        search: "test",
      }),
    );
  });

  it("uses default limit=100 when no pageSize or limit specified", async () => {
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

  it("omits limit when pageSize is provided without explicit limit", async () => {
    fetchPrivateJsonMock.mockResolvedValueOnce({ ok: true } as any);

    await fetchVisitors("site-1", window, undefined, { pageSize: 25 });

    const params = fetchPrivateJsonMock.mock.calls[0][1] as Record<
      string,
      unknown
    >;
    expect(params.limit).toBeUndefined();
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
      page: 3,
      pageSize: 10,
      sortBy: "startedAt",
      sortDir: "asc",
      search: "abc",
    });

    expect(fetchPrivateJsonMock).toHaveBeenCalledWith(
      "/api/private/sessions",
      expect.objectContaining({
        page: 3,
        pageSize: 10,
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
});

describe("fetchEventTypeFieldValues", () => {
  it("returns emptyEventFieldValues for empty eventName", async () => {
    const result = await fetchEventTypeFieldValues(
      "site-1",
      window,
      "  ",
      "field",
      "string",
    );
    expect(result).toEqual(emptyEventFieldValues("field", "string"));
    expect(fetchPrivateJsonMock).not.toHaveBeenCalled();
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
      pageSize: 20,
      sortBy: "occurredAt",
      sortDir: "desc",
    });

    expect(fetchPrivateJsonMock).toHaveBeenCalledWith(
      "/api/private/events-records",
      expect.objectContaining({
        search: "test",
        eventName: "click",
        cursor: "event-cursor",
        pageSize: 20,
        sortBy: "occurredAt",
        sortDir: "desc",
      }),
    );
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
