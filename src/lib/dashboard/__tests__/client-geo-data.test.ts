import { afterEach, describe, expect, it, vi } from "vitest";

import {
  fetchOverviewGeoDimensionTab,
  fetchOverviewGeoPoints,
} from "@/lib/dashboard/client-geo-data";
import type { TimeWindow } from "@/lib/dashboard/query-state";

describe("dashboard client geo data helpers", () => {
  const realFetch = globalThis.fetch;
  const realDemoMode = process.env.NEXT_PUBLIC_DEMO_MODE;
  const window: TimeWindow = {
    preset: "24h",
    from: 1000,
    to: 2000,
    timeZone: "UTC",
    interval: "hour",
  };

  afterEach(() => {
    globalThis.fetch = realFetch;
    if (realDemoMode == null) {
      delete process.env.NEXT_PUBLIC_DEMO_MODE;
    } else {
      process.env.NEXT_PUBLIC_DEMO_MODE = realDemoMode;
    }
    vi.restoreAllMocks();
  });

  function jsonResponse(body: unknown): Response {
    return new Response(JSON.stringify(body), {
      headers: { "content-type": "application/json" },
    });
  }

  function paramsFromCall(fetchMock: ReturnType<typeof vi.fn>, index = 0) {
    const url = String(fetchMock.mock.calls[index][0]);
    return new URLSearchParams(url.split("?")[1] ?? "");
  }

  it("normalizes geo point payload sections and serializes geo options", async () => {
    delete process.env.NEXT_PUBLIC_DEMO_MODE;
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({
        ok: true,
        data: [
          {
            latitude: "42.5",
            longitude: undefined,
            timestampMs: "12345",
            country: 99,
            region: null,
            regionCode: "IDF",
            city: "Paris",
          },
        ],
        countryCounts: [{ country: null, views: "8", sessions: "4" }],
        regionCounts: [{ value: 12, label: undefined, visitors: "2" }],
        cityCounts: [{ value: undefined, label: "Paris", views: "7" }],
      }),
    );
    globalThis.fetch = fetchMock;

    const out = await fetchOverviewGeoPoints(
      "geo-site",
      window,
      { country: "FR", geo: "EU::FR" },
      { limit: 25, applyGeoFilter: true },
    );

    expect(paramsFromCall(fetchMock)).toMatchObject(
      new URLSearchParams({
        siteId: "geo-site",
        from: "1000",
        to: "2000",
        timeZone: "UTC",
        limit: "25",
        applyGeoFilter: "1",
        country: "FR",
        geo: "EU::FR",
      }),
    );
    expect(out).toEqual({
      ok: true,
      data: [
        {
          latitude: 42.5,
          longitude: 0,
          timestampMs: 12345,
          country: "99",
          region: "",
          regionCode: "IDF",
          city: "Paris",
          pointCount: 1,
        },
      ],
      countryCounts: [{ country: "", views: 8, sessions: 4, visitors: 0 }],
      regionCounts: [
        { value: "12", label: "", views: 0, sessions: 0, visitors: 2 },
      ],
      cityCounts: [
        { value: "", label: "Paris", views: 7, sessions: 0, visitors: 0 },
      ],
    });
  });

  it("falls back to empty geo points when payload sections are not arrays or fetch fails", async () => {
    delete process.env.NEXT_PUBLIC_DEMO_MODE;
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({
          ok: true,
          data: null,
          countryCounts: "bad",
          regionCounts: undefined,
          cityCounts: {},
        }),
      )
      .mockRejectedValueOnce(new Error("offline"));
    globalThis.fetch = fetchMock;

    await expect(fetchOverviewGeoPoints("geo-empty", window)).resolves.toEqual({
      ok: true,
      data: [],
      countryCounts: [],
      regionCounts: [],
      cityCounts: [],
    });
    await expect(fetchOverviewGeoPoints("geo-fail", window)).resolves.toEqual({
      ok: true,
      data: [],
      countryCounts: [],
      regionCounts: [],
      cityCounts: [],
    });
  });

  it("normalizes geo dimension labels for generic, region, and city tabs", async () => {
    delete process.env.NEXT_PUBLIC_DEMO_MODE;
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({
          ok: true,
          data: [
            {
              value: "",
              label: "  United States  ",
              views: "11",
              sessions: "5",
              visitors: "3",
            },
          ],
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          ok: true,
          data: [
            {
              value: "US::CA::California",
              label: "United States :: CA :: California",
            },
            {
              value: "raw-region",
              label: " ",
              views: "2",
            },
          ],
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          ok: true,
          data: [
            {
              value: "US::CA::California::San Francisco",
              label: "United States :: CA :: California :: San Francisco",
              sessions: "4",
            },
            {
              value: "raw-city",
              label: "",
              visitors: "6",
            },
          ],
        }),
      );
    globalThis.fetch = fetchMock;

    await expect(
      fetchOverviewGeoDimensionTab("geo-country", window, "country"),
    ).resolves.toEqual([
      {
        value: "United States",
        label: "United States",
        views: 11,
        sessions: 5,
        visitors: 3,
      },
    ]);
    await expect(
      fetchOverviewGeoDimensionTab("geo-region", window, "region"),
    ).resolves.toEqual([
      {
        value: "US::CA::California",
        label: "California",
        views: 0,
        sessions: 0,
        visitors: 0,
      },
      {
        value: "raw-region",
        label: "raw-region",
        views: 2,
        sessions: 0,
        visitors: 0,
      },
    ]);
    await expect(
      fetchOverviewGeoDimensionTab("geo-city", window, "city"),
    ).resolves.toEqual([
      {
        value: "US::CA::California::San Francisco",
        label: "San Francisco",
        views: 0,
        sessions: 4,
        visitors: 0,
      },
      {
        value: "raw-city",
        label: "raw-city",
        views: 0,
        sessions: 0,
        visitors: 6,
      },
    ]);
    expect(paramsFromCall(fetchMock, 0).get("limit")).toBe("100");
  });

  it("returns an empty dimension list when the endpoint fails", async () => {
    delete process.env.NEXT_PUBLIC_DEMO_MODE;
    globalThis.fetch = vi.fn().mockRejectedValue(new Error("offline"));

    await expect(
      fetchOverviewGeoDimensionTab("geo-fallback", window, "timezone"),
    ).resolves.toEqual([]);
  });
});
