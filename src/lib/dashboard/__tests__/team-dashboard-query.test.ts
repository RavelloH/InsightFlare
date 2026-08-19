import { describe, expect, it } from "vitest";

import {
  readDashboardQueryPreferences,
  resolveDashboardInitialWindow,
} from "@/lib/dashboard/query-preferences";
import {
  buildTeamAggregateTrend,
  buildTeamSiteTrends,
  sameTeamDashboardWindow,
  teamDashboardQueryKey,
} from "@/lib/dashboard/team-dashboard-query";

const window = {
  from: Date.UTC(2026, 0, 1),
  to: Date.UTC(2026, 0, 3),
  interval: "day" as const,
  timeZone: "UTC",
};

describe("team dashboard query helpers", () => {
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
});
