import { afterEach, describe, expect, it, vi } from "vitest";

import {
  readDashboardQueryPreferences,
  resolveDashboardInitialWindow,
} from "@/lib/dashboard/query-preferences";
import {
  buildTeamAggregateTrend,
  buildTeamSiteTrends,
  fetchTeamDashboard,
  sameTeamDashboardWindow,
  teamDashboardQueryKey,
  teamDashboardQueryOptions,
} from "@/lib/dashboard/team-dashboard-query";

const window = {
  from: Date.UTC(2026, 0, 1),
  to: Date.UTC(2026, 0, 3),
  interval: "day" as const,
  timeZone: "UTC",
};

describe("team dashboard query helpers", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("uses the full request window as the shared cache identity", () => {
    expect(teamDashboardQueryKey("team-1", window)).toEqual([
      "dashboard",
      "team-dashboard",
      "team-1",
      window.from,
      window.to,
      "day",
      "UTC",
    ]);
    expect(
      sameTeamDashboardWindow(window, { ...window, timeZone: "Asia/Tokyo" }),
    ).toBe(false);
  });

  it("fills missing buckets without clearing the previous snapshot data", () => {
    const trend = [
      {
        bucket: 0,
        timestampMs: window.from,
        sites: [{ siteId: "site-1", views: 12, visitors: 8 }],
      },
      {
        bucket: 2,
        timestampMs: window.to,
        sites: [{ siteId: "site-2", views: 4, visitors: 3 }],
      },
    ];

    expect(buildTeamAggregateTrend(trend, window)).toEqual([
      {
        timestampMs: window.from,
        sites: [{ siteId: "site-1", views: 12, visitors: 8 }],
      },
      { timestampMs: Date.UTC(2026, 0, 2), sites: [] },
      {
        timestampMs: window.to,
        sites: [{ siteId: "site-2", views: 4, visitors: 3 }],
      },
    ]);
    expect(buildTeamSiteTrends(["site-1", "site-2"], trend, window)).toEqual({
      "site-1": [
        { timestampMs: window.from, views: 12, visitors: 8 },
        { timestampMs: Date.UTC(2026, 0, 2), views: 0, visitors: 0 },
        { timestampMs: window.to, views: 0, visitors: 0 },
      ],
      "site-2": [
        { timestampMs: window.from, views: 0, visitors: 0 },
        { timestampMs: Date.UTC(2026, 0, 2), views: 0, visitors: 0 },
        { timestampMs: window.to, views: 4, visitors: 3 },
      ],
    });
  });

  it("normalizes aggregate counts and ignores sites outside the requested set", () => {
    const trend = [
      {
        bucket: 0,
        timestampMs: window.from,
        sites: [
          { siteId: "site-1", views: 3, visitors: -4 },
          { siteId: "site-1", views: Number.NaN, visitors: 2 },
          { siteId: "other", views: 9, visitors: 8 },
        ],
      },
    ];

    expect(buildTeamAggregateTrend(trend, window)[0]).toEqual({
      timestampMs: window.from,
      sites: [
        { siteId: "site-1", views: 3, visitors: 2 },
        { siteId: "other", views: 9, visitors: 8 },
      ],
    });
    expect(
      buildTeamSiteTrends(["site-1"], trend, window)["site-1"]?.[0],
    ).toEqual({ timestampMs: window.from, views: 3, visitors: 2 });
  });

  it("uses the response contract and rejects unsuccessful team dashboard requests", async () => {
    const fetchMock = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", fetchMock);

    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          ok: true,
          data: { sites: [{ id: "site-1" }], trend: [{ bucket: 0 }] },
        }),
      ),
    );
    await expect(fetchTeamDashboard("team-1", window)).resolves.toEqual({
      sites: [{ id: "site-1" }],
      trend: [{ bucket: 0 }],
    });
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining("teamId=team-1"),
      expect.objectContaining({ credentials: "include", method: "GET" }),
    );

    fetchMock.mockResolvedValueOnce(new Response(null, { status: 500 }));
    await expect(fetchTeamDashboard("team-1", window)).rejects.toThrow(
      "fetch_team_dashboard_failed",
    );

    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ ok: false, data: {} })),
    );
    await expect(fetchTeamDashboard("team-1", window)).rejects.toThrow(
      "fetch_team_dashboard_failed",
    );

    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ ok: true, data: {} })),
    );
    await expect(fetchTeamDashboard("team-1", window)).resolves.toEqual({
      sites: [],
      trend: [],
    });
  });

  it("uses only a matching snapshot as initial query data", () => {
    const snapshot = {
      data: { sites: [], trend: [] },
      window,
      range: "7d" as const,
      fetchedAt: 123,
    };
    const withSnapshot = teamDashboardQueryOptions({
      teamId: "team-1",
      window,
      range: "custom",
      snapshot,
    });
    expect(withSnapshot.initialData).toBe(snapshot);
    expect(withSnapshot.initialDataUpdatedAt).toBe(123);
    expect(withSnapshot.enabled).toBe(true);

    const withoutSnapshot = teamDashboardQueryOptions({
      teamId: "",
      window,
      snapshot: { ...snapshot, window: { ...window, to: window.to + 1 } },
      enabled: false,
    });
    expect(withoutSnapshot.initialData).toBeUndefined();
    expect(withoutSnapshot.initialDataUpdatedAt).toBeUndefined();
    expect(withoutSnapshot.enabled).toBe(false);

    const defaulted = teamDashboardQueryOptions({
      teamId: "team-1",
      window,
    });
    expect(defaulted.enabled).toBe(true);
    expect(defaulted.initialData).toBeUndefined();
    expect(defaulted.initialDataUpdatedAt).toBeUndefined();

    const trend = buildTeamAggregateTrend(
      [
        {
          bucket: 0,
          timestampMs: window.to + 24 * 60 * 60_000,
          sites: [{ siteId: "site-1", views: 1, visitors: 1 }],
        },
      ],
      window,
    );
    expect(trend.at(-1)).toEqual({
      timestampMs: window.to + 24 * 60 * 60_000,
      sites: [{ siteId: "site-1", views: 1, visitors: 1 }],
    });

    const siteTrend = buildTeamSiteTrends(
      ["site-1"],
      [
        {
          bucket: 0,
          timestampMs: window.to + 24 * 60 * 60_000,
          sites: [{ siteId: "site-1", views: 1, visitors: 1 }],
        },
      ],
      window,
    );
    expect(siteTrend["site-1"]?.at(-1)).toEqual({
      timestampMs: window.to + 24 * 60 * 60_000,
      views: 1,
      visitors: 1,
    });
  });

  it("adds default and requested ranges when executing a dashboard query", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockImplementation(() =>
        Promise.resolve(
          new Response(
            JSON.stringify({ ok: true, data: { sites: [], trend: [] } }),
          ),
        ),
      );
    vi.stubGlobal("fetch", fetchMock);

    const defaulted = teamDashboardQueryOptions({ teamId: "team-1", window });
    await expect(
      defaulted.queryFn!({ signal: new AbortController().signal } as never),
    ).resolves.toMatchObject({ range: "30d" });

    const requested = teamDashboardQueryOptions({
      teamId: "team-1",
      window,
      range: "7d",
    });
    await expect(
      requested.queryFn!({ signal: new AbortController().signal } as never),
    ).resolves.toMatchObject({ range: "7d" });
  });
});

describe("dashboard query preferences", () => {
  it("reads a range preference and reporting timezone from cookies", () => {
    const cookie = [
      "insightflare-dashboard-query=%7B%22range%22%3A%227d%22%2C%22interval%22%3A%22day%22%2C%22customRange%22%3Anull%7D",
      "insightflare-reporting-time-zone=Asia%2FTokyo",
    ].join("; ");

    expect(readDashboardQueryPreferences(cookie)).toEqual({
      range: "7d",
      interval: "day",
      customRange: null,
    });
    expect(
      resolveDashboardInitialWindow(cookie, Date.UTC(2026, 0, 10)),
    ).toMatchObject({
      preset: "7d",
      interval: "day",
      timeZone: "Asia/Tokyo",
    });
  });

  it("falls back safely for absent, malformed, and invalid preference cookies", () => {
    expect(readDashboardQueryPreferences(null)).toEqual({
      range: "30d",
      customRange: null,
    });
    expect(readDashboardQueryPreferences("other=value")).toEqual({
      range: "30d",
      customRange: null,
    });
    expect(
      readDashboardQueryPreferences(
        "insightflare-dashboard-query=%7Binvalid-json",
      ),
    ).toEqual({ range: "30d", customRange: null });
    expect(
      readDashboardQueryPreferences(
        "insightflare-dashboard-query=%7B%22interval%22%3A%22invalid%22%2C%22customRange%22%3A%7B%22from%22%3A10%2C%22to%22%3A5%7D%7D",
      ),
    ).toEqual({ range: "30d", interval: undefined, customRange: null });
    expect(
      readDashboardQueryPreferences(
        "insightflare-dashboard-query=%7B%22customRange%22%3A%7B%22from%22%3A10%2C%22to%22%3A20%7D%7D",
      ),
    ).toEqual({
      range: "30d",
      interval: undefined,
      customRange: { from: 10, to: 20 },
    });
    expect(
      readDashboardQueryPreferences(
        "insightflare-dashboard-query=%7B%22customRange%22%3A%7B%22from%22%3A%22bad%22%2C%22to%22%3A20%7D%7D",
      ),
    ).toEqual({ range: "30d", interval: undefined, customRange: null });
    expect(
      readDashboardQueryPreferences("insightflare-dashboard-query"),
    ).toEqual({ range: "30d", customRange: null });
    expect(
      readDashboardQueryPreferences("insightflare-dashboard-query=%ZZ"),
    ).toEqual({ range: "30d", customRange: null });
  });
});
