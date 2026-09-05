import { afterEach, describe, expect, it, vi } from "vitest";

import {
  fetchPageCardTabs,
  fetchPagesDashboard,
  fetchPagesShareTrend,
} from "@/lib/dashboard/client-page-data";
import { dashboardFilterDocumentFromPresentation } from "@/lib/dashboard/filter-state";
import type { TimeWindow } from "@/lib/dashboard/query-state";

describe("dashboard client page data helpers", () => {
  const realFetch = globalThis.fetch;
  const realDemoMode = process.env.VITE_DEMO_MODE;
  const window: TimeWindow = {
    preset: "7d",
    from: 1000,
    to: 2000,
    timeZone: "UTC",
    interval: "day",
  };

  afterEach(() => {
    globalThis.fetch = realFetch;
    if (realDemoMode == null) {
      delete process.env.VITE_DEMO_MODE;
    } else {
      process.env.VITE_DEMO_MODE = realDemoMode;
    }
    vi.restoreAllMocks();
  });

  function jsonResponse(body: unknown): Response {
    return new Response(JSON.stringify(body), {
      headers: { "content-type": "application/json" },
    });
  }

  function pageData<T>(items: T[], limit = items.length, hasMore = false) {
    return {
      items,
      pagination: {
        limit,
        returned: items.length,
        hasMore,
        nextCursor: hasMore ? "next-cursor" : null,
      },
    };
  }

  function paramsFromCall(fetchMock: ReturnType<typeof vi.fn>, index = 0) {
    const url = String(fetchMock.mock.calls[index][0]);
    return new URLSearchParams(url.split("?")[1] ?? "");
  }

  it("serializes page dashboard defaults, options, and filters", async () => {
    delete process.env.VITE_DEMO_MODE;
    const fetchMock = vi
      .fn()
      .mockImplementation(() =>
        Promise.resolve(jsonResponse({ ok: true, data: pageData([], 12) })),
      );
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await fetchPagesDashboard(
      "pages-site",
      window,
      dashboardFilterDocumentFromPresentation({
        path: "/docs",
        sourceDomain: "example.com",
      }),
    );
    await fetchPagesDashboard("pages-site", window, undefined, {
      limit: 40,
      cursor: "pages-cursor",
    });

    expect(paramsFromCall(fetchMock, 0)).toMatchObject(
      new URLSearchParams({
        siteId: "pages-site",
        from: "1000",
        to: "2000",
        timeZone: "UTC",
        interval: "day",
        limit: "12",
        "filter[page.path]": "/docs",
        "filter[referrer.domain]": "example.com",
      }),
    );
    expect(paramsFromCall(fetchMock, 1).get("limit")).toBe("40");
    expect(paramsFromCall(fetchMock, 1).get("cursor")).toBe("pages-cursor");
  });

  it("builds page share trend with an Other series when totals exceed top pages", async () => {
    delete process.env.VITE_DEMO_MODE;
    const fetchMock = vi.fn((url: string) => {
      if (url.includes("/api/private/pages-dashboard")) {
        return Promise.resolve(
          jsonResponse({
            ok: true,
            interval: "day",
            data: pageData(
              [
                {
                  pathname: "/docs",
                  metrics: { views: "4", sessions: "2" },
                  trend: [
                    { timestampMs: 1000, views: "4" },
                    { timestampMs: 2000, views: "-3" },
                  ],
                },
              ],
              1,
            ),
          }),
        );
      }
      return Promise.resolve(
        jsonResponse({
          ok: true,
          interval: "day",
          data: [
            { timestampMs: 1000, views: "10" },
            { timestampMs: 2000, views: 2 },
          ],
        }),
      );
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const trend = await fetchPagesShareTrend("share-site", window, undefined, {
      limit: -10,
    });

    expect(paramsFromCall(fetchMock, 0).get("limit")).toBe("1");
    expect(trend.series).toEqual([
      {
        key: "page_0",
        label: "/docs",
        views: "4",
        visitors: "4",
        sessions: "2",
      },
      {
        key: "other",
        label: "Other",
        views: 8,
        visitors: 8,
        sessions: 8,
        isOther: true,
      },
    ]);
    expect(trend.data).toEqual([
      {
        bucket: 0,
        timestampMs: 1000,
        totalVisitors: 10,
        visitorsBySeries: { page_0: 4, other: 6 },
      },
      {
        bucket: 1,
        timestampMs: 2000,
        totalVisitors: 2,
        visitorsBySeries: { page_0: 0, other: 2 },
      },
    ]);
  });

  it("builds page share trend without Other when top page totals cover the trend", async () => {
    delete process.env.VITE_DEMO_MODE;
    const fetchMock = vi.fn((url: string) => {
      if (url.includes("/api/private/pages-dashboard")) {
        return Promise.resolve(
          jsonResponse({
            ok: true,
            interval: "day",
            data: pageData(
              [
                {
                  pathname: "/docs",
                  metrics: { views: 7, sessions: 3 },
                  trend: [{ timestampMs: 3000, views: 7 }],
                },
                {
                  pathname: "/pricing",
                  metrics: { views: 2, sessions: 1 },
                  trend: [],
                },
              ],
              5,
            ),
          }),
        );
      }
      return Promise.resolve(
        jsonResponse({
          ok: true,
          interval: "day",
          data: [{ timestampMs: 3000, views: 5 }],
        }),
      );
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const trend = await fetchPagesShareTrend("share-covered", window);

    expect(paramsFromCall(fetchMock, 0).get("limit")).toBe("5");
    expect(trend.series).toEqual([
      {
        key: "page_0",
        label: "/docs",
        views: 7,
        visitors: 7,
        sessions: 3,
      },
      {
        key: "page_1",
        label: "/pricing",
        views: 2,
        visitors: 2,
        sessions: 1,
      },
    ]);
    expect(trend.data).toEqual([
      {
        bucket: 0,
        timestampMs: 3000,
        totalVisitors: 7,
        visitorsBySeries: { page_0: 7 },
      },
    ]);
  });

  it("merges duplicate page buckets and fills Other from total-only buckets", async () => {
    delete process.env.VITE_DEMO_MODE;
    const fetchMock = vi.fn((url: string) => {
      if (url.includes("/api/private/pages-dashboard")) {
        return Promise.resolve(
          jsonResponse({
            ok: false,
            interval: "day",
            data: pageData(
              [
                {
                  pathname: "/docs",
                  metrics: { views: 2, sessions: 1 },
                  trend: [{ views: "2" }, { timestampMs: 5000, views: null }],
                },
                {
                  pathname: "/blog",
                  metrics: { views: 7, sessions: 4 },
                  trend: [
                    { timestampMs: null, views: 3 },
                    { timestampMs: 6000, views: 4 },
                  ],
                },
              ],
              2,
            ),
          }),
        );
      }
      return Promise.resolve(
        jsonResponse({
          ok: true,
          interval: "day",
          data: [
            { timestampMs: 0, views: 10 },
            { timestampMs: 7000, views: 2 },
            { timestampMs: 6000, views: -5 },
          ],
        }),
      );
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const trend = await fetchPagesShareTrend(
      "share-duplicates",
      window,
      dashboardFilterDocumentFromPresentation({ path: "/docs" }),
    );

    expect(trend.ok).toBe(false);
    expect(trend.series).toEqual([
      {
        key: "page_0",
        label: "/docs",
        views: 2,
        visitors: 2,
        sessions: 1,
      },
      {
        key: "page_1",
        label: "/blog",
        views: 7,
        visitors: 7,
        sessions: 4,
      },
      {
        key: "other",
        label: "Other",
        views: 7,
        visitors: 7,
        sessions: 7,
        isOther: true,
      },
    ]);
    expect(trend.data).toEqual([
      {
        bucket: 0,
        timestampMs: 0,
        totalVisitors: 10,
        visitorsBySeries: { page_0: 2, page_1: 3, other: 5 },
      },
      {
        bucket: 1,
        timestampMs: 5000,
        totalVisitors: 0,
        visitorsBySeries: { page_0: 0 },
      },
      {
        bucket: 2,
        timestampMs: 6000,
        totalVisitors: 4,
        visitorsBySeries: { page_1: 4 },
      },
      {
        bucket: 3,
        timestampMs: 7000,
        totalVisitors: 2,
        visitorsBySeries: { other: 2 },
      },
    ]);
  });

  it("uses total trend data when the page dashboard request falls back", async () => {
    delete process.env.VITE_DEMO_MODE;
    const fetchMock = vi.fn((url: string) => {
      if (url.includes("/api/private/pages-dashboard")) {
        return Promise.reject(new Error("pages unavailable"));
      }
      return Promise.resolve(
        jsonResponse({
          ok: true,
          interval: "day",
          data: [
            { timestampMs: 1000, views: 4 },
            { timestampMs: 2000, views: -1 },
          ],
        }),
      );
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const trend = await fetchPagesShareTrend(
      "share-total-only",
      window,
      dashboardFilterDocumentFromPresentation({ path: "/docs" }),
    );

    expect(paramsFromCall(fetchMock, 0).get("limit")).toBe("5");
    expect(paramsFromCall(fetchMock, 1).get("filter[page.path]")).toBe("/docs");
    expect(trend.series).toEqual([
      {
        key: "other",
        label: "Other",
        views: 4,
        visitors: 4,
        sessions: 4,
        isOther: true,
      },
    ]);
    expect(trend.data).toEqual([
      {
        bucket: 0,
        timestampMs: 1000,
        totalVisitors: 4,
        visitorsBySeries: { other: 4 },
      },
      {
        bucket: 1,
        timestampMs: 2000,
        totalVisitors: 0,
        visitorsBySeries: {},
      },
    ]);
  });

  it("keeps page trend data when the total trend request falls back", async () => {
    delete process.env.VITE_DEMO_MODE;
    const fetchMock = vi.fn((url: string) => {
      if (url.includes("/api/private/pages-dashboard")) {
        return Promise.resolve(
          jsonResponse({
            ok: true,
            interval: "day",
            data: pageData(
              [
                {
                  pathname: "/docs",
                  metrics: { views: 3, sessions: 1 },
                  trend: [{ timestampMs: 1000, views: 3 }],
                },
              ],
              12,
            ),
          }),
        );
      }
      return Promise.reject(new Error("trend unavailable"));
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const trend = await fetchPagesShareTrend(
      "share-page-only",
      window,
      undefined,
      {
        limit: 50,
      },
    );

    expect(paramsFromCall(fetchMock, 0).get("limit")).toBe("12");
    expect(trend.series).toEqual([
      {
        key: "page_0",
        label: "/docs",
        views: 3,
        visitors: 3,
        sessions: 1,
      },
    ]);
    expect(trend.data).toEqual([
      {
        bucket: 0,
        timestampMs: 1000,
        totalVisitors: 3,
        visitorsBySeries: { page_0: 3 },
      },
    ]);
  });

  it("falls back to empty page share trend data when both source requests fail", async () => {
    delete process.env.VITE_DEMO_MODE;
    globalThis.fetch = vi.fn().mockRejectedValue(new Error("offline"));

    await expect(
      fetchPagesShareTrend("share-fallback", window, undefined, { limit: 99 }),
    ).resolves.toEqual({
      ok: true,
      interval: "day",
      series: [],
      data: [],
    });
  });

  it("returns page card tabs when present and empty tabs when omitted", async () => {
    delete process.env.VITE_DEMO_MODE;
    const tabs = {
      path: [{ label: "/docs", views: 3 }],
      title: [{ label: "Docs", views: 2 }],
      hostname: [],
      entry: [],
      exit: [],
    };
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ ok: true, data: [], tabs }))
      .mockResolvedValueOnce(jsonResponse({ ok: true, data: [] }));
    globalThis.fetch = fetchMock;

    await expect(
      fetchPageCardTabs(
        "tabs-site",
        window,
        dashboardFilterDocumentFromPresentation({ path: "/docs" }),
      ),
    ).resolves.toEqual(tabs);
    await expect(fetchPageCardTabs("tabs-empty", window)).resolves.toEqual({
      path: [],
      title: [],
      hostname: [],
      entry: [],
      exit: [],
    });
    expect(paramsFromCall(fetchMock, 0).get("limit")).toBe("100");
    expect(paramsFromCall(fetchMock, 0).get("filter[page.path]")).toBe("/docs");
  });
});
