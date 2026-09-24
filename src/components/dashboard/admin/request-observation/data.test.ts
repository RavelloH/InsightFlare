import { beforeEach, describe, expect, it, vi } from "vitest";

const requestAdminService = vi.hoisted(() => vi.fn());

vi.mock("@/lib/dashboard-api/client/admin-service", () => ({
  requestAdminService,
}));

import type { TimeWindow } from "@/lib/dashboard/query-state";

import {
  fetchRequestObservation,
  fetchRequestObservationDetail,
  fetchRequestObservationDimension,
  fetchRequestObservationPage,
} from "./data";

const window: TimeWindow = {
  preset: "custom",
  from: 1_000.8,
  to: 2_000.9,
  interval: "hour",
  timeZone: "UTC",
};

beforeEach(() => {
  requestAdminService.mockReset().mockResolvedValue({
    ok: true,
    configured: true,
    generatedAt: 1_000,
    summary: { total: 0, affectedSites: 0, uniqueAsns: 0, uniqueCountries: 0 },
    mapPoints: [],
    trend: [],
    reasons: [],
    asns: [],
    events: [],
    blocked: {
      summary: { total: 0 },
      events: [],
      pagination: { limit: 1, returned: 0, hasMore: false, nextCursor: null },
    },
    included: {
      summary: { total: 0 },
      events: [],
      pagination: { limit: 1, returned: 0, hasMore: false, nextCursor: null },
    },
  });
});

describe("request observation data client", () => {
  it("fetches a normalized overview and paged event sources", async () => {
    const controller = new AbortController();
    const overview = await fetchRequestObservation(window, controller.signal);
    expect(overview.ok).toBe(true);
    expect(requestAdminService).toHaveBeenNthCalledWith(
      1,
      "request-observation",
      expect.objectContaining({
        params: {
          from: "1000",
          to: "2000",
          interval: "hour",
          timeZone: "UTC",
          limit: expect.any(String),
        },
        signal: controller.signal,
      }),
    );

    await fetchRequestObservationPage(window, "blocked", "cursor-1");
    expect(requestAdminService).toHaveBeenLastCalledWith(
      "request-observation",
      expect.objectContaining({
        params: expect.objectContaining({
          source: "blocked",
          cursor: "cursor-1",
          from: "1000",
          to: "2000",
        }),
      }),
    );
  });

  it("returns dimensions and rejects malformed dimension payloads", async () => {
    requestAdminService.mockResolvedValueOnce({
      ok: true,
      dimension: { rows: [{ key: "US", label: "United States", count: 4 }] },
    });
    await expect(
      fetchRequestObservationDimension(
        window,
        "included",
        "network",
        "country",
      ),
    ).resolves.toEqual([{ key: "US", label: "United States", count: 4 }]);
    expect(requestAdminService).toHaveBeenLastCalledWith(
      "request-observation",
      expect.objectContaining({
        params: expect.objectContaining({
          dimensionSource: "included",
          dimensionGroup: "network",
          dimensionTab: "country",
        }),
      }),
    );

    requestAdminService.mockResolvedValueOnce({ ok: true });
    await expect(
      fetchRequestObservationDimension(window, "blocked", "client", "ip"),
    ).rejects.toThrow("load_bot_protection_failed");
  });

  it("requests event details using whichever trace identifiers are available", async () => {
    requestAdminService.mockResolvedValueOnce({
      ok: true,
      detail: { traceId: "trace-1" },
    });
    await expect(
      fetchRequestObservationDetail(window, {
        traceId: "trace-1",
        rayId: "ray-1",
      } as never),
    ).resolves.toEqual({ traceId: "trace-1" });
    expect(requestAdminService).toHaveBeenLastCalledWith(
      "request-observation",
      expect.objectContaining({
        params: expect.objectContaining({
          detail: "1",
          traceId: "trace-1",
          rayId: "ray-1",
        }),
        signal: undefined,
      }),
    );

    requestAdminService.mockResolvedValueOnce({ ok: true, detail: null });
    await expect(
      fetchRequestObservationDetail(window, {
        traceId: "",
        rayId: "",
      } as never),
    ).resolves.toBeNull();
    expect(requestAdminService).toHaveBeenLastCalledWith(
      "request-observation",
      expect.objectContaining({
        params: expect.not.objectContaining({
          traceId: expect.anything(),
          rayId: expect.anything(),
        }),
      }),
    );
  });
});
