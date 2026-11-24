import { describe, expect, it } from "vitest";

import {
  buildWorkspaceRows,
  buildWorkspaceTotals,
  mergeTeamTrends,
  sortRows,
} from "@/components/dashboard/workspace/model";
import type {
  TeamDashboardData,
  TeamDashboardSite,
} from "@/lib/dashboard/team-dashboard-query";
import type { TeamData } from "@/lib/dashboard-api/client/edge";

function site(
  id: string,
  overview: Partial<TeamDashboardSite["overview"]>,
  changeRates: Partial<TeamDashboardSite["changeRates"]> = {},
  previous?: Partial<TeamDashboardSite["overview"]>,
): TeamDashboardSite {
  return {
    id,
    teamId: "team-a",
    name: id.toUpperCase(),
    domain: `${id}.example.com`,
    publicEnabled: 0,
    publicSlug: null,
    createdAt: 0,
    updatedAt: 0,
    overview: {
      views: 0,
      sessions: 0,
      visitors: 0,
      bounces: 0,
      totalDurationMs: 0,
      avgDurationMs: 0,
      bounceRate: 0,
      approximateVisitors: false,
      ...overview,
    },
    ...(previous === undefined
      ? {}
      : {
          previousOverview: {
            views: 0,
            sessions: 0,
            visitors: 0,
            bounces: 0,
            totalDurationMs: 0,
            avgDurationMs: 0,
            bounceRate: 0,
            approximateVisitors: false,
            ...previous,
          },
        }),
    changeRates: {
      views: null,
      visitors: null,
      sessions: null,
      bounceRate: null,
      avgDurationMs: null,
      pagesPerSession: null,
      ...changeRates,
    },
  };
}

const team = { id: "team-a", slug: "team-a", name: "Team A" } as TeamData;

describe("workspace totals", () => {
  it("uses actual previous metrics rather than reconstructing rounded percentages", () => {
    const totals = buildWorkspaceTotals([
      site(
        "a",
        {
          visitors: 150,
          views: 300,
          sessions: 200,
          totalDurationMs: 40_000,
          avgDurationMs: 200,
        },
        { visitors: 49.99, views: 0, sessions: 100, avgDurationMs: 0 },
        { visitors: 100, views: 300, sessions: 100, totalDurationMs: 20_000 },
      ),
      site(
        "b",
        {
          visitors: 50,
          views: 100,
          sessions: 100,
          totalDurationMs: 20_000,
          avgDurationMs: 200,
        },
        { visitors: -50, views: 0, sessions: 0, avgDurationMs: 0 },
        { visitors: 100, views: 100, sessions: 100, totalDurationMs: 20_000 },
      ),
    ]);
    // Previous visitors: 150 / 1.5 + 50 / 0.5 = 200.
    expect(totals.visitors).toBe(200);
    expect(totals.change.visitors).toBeCloseTo(0);
    expect(totals.change.views).toBeCloseTo(0);
    // Previous sessions: 200 / 2 + 100 = 200, now 300.
    expect(totals.change.sessions).toBeCloseTo(50);
    expect(totals.avgDurationMs).toBe(200);
    expect(totals.change.avgDurationMs).toBeCloseTo(0);
  });

  it("includes new and vanished sites even when their rates are null or -100%", () => {
    const totals = buildWorkspaceTotals([
      site(
        "new",
        { visitors: 30, views: 60, sessions: 40, totalDurationMs: 12_000 },
        {},
        {},
      ),
      site(
        "old",
        {},
        { visitors: -100, views: -100, sessions: -100 },
        {
          visitors: 20,
          views: 100,
          sessions: 50,
          totalDurationMs: 10_000,
        },
      ),
    ]);
    expect(totals.change.visitors).toBe(50);
    expect(totals.change.views).toBe(-40);
    expect(totals.change.sessions).toBe(-20);
    expect(totals.avgDurationMs).toBe(300);
    expect(totals.change.avgDurationMs).toBe(50);
    const newOnly = buildWorkspaceTotals([
      site("new", { visitors: 10 }, {}, {}),
    ]);
    expect(newOnly.change.visitors).toBeNull();
  });

  it("leaves change unknown when the older snapshot has no previous metrics", () => {
    const totals = buildWorkspaceTotals([
      site("a", { visitors: 10, sessions: 10 }, { visitors: 10 }),
      site("b", { visitors: 10, sessions: 10 }),
      site("idle", {}),
    ]);
    expect(totals.change.visitors).toBeNull();
    expect(totals.change.sessions).toBeNull();
    expect(totals.change.avgDurationMs).toBeNull();
    expect(buildWorkspaceTotals([]).change.visitors).toBeNull();
  });
});

describe("workspace rows", () => {
  const data: TeamDashboardData = {
    sites: [
      site("b", { visitors: 50, views: 80 }, { visitors: -10 }),
      site("a", { visitors: 50, views: 120 }, { visitors: 20 }),
      site("c", { visitors: 90, views: 10 }),
    ],
    trend: [{ bucket: 1, timestampMs: 1, sites: [] }],
  };
  const rows = buildWorkspaceRows(
    [team, { ...team, id: "missing" }],
    new Map([[team.id, data]]),
    { a: [{ timestampMs: 1, views: 2, visitors: 1 }] },
  );

  it("joins sites with their team, slug and trend", () => {
    expect(rows.map((row) => row.site.id)).toEqual(["b", "a", "c"]);
    expect(rows[1]).toMatchObject({
      slug: "a-example-com",
      visitorsChange: 20,
      trend: [{ timestampMs: 1, views: 2, visitors: 1 }],
    });
    expect(rows[0]!.trend).toEqual([]);
    expect(mergeTeamTrends([data, data])).toHaveLength(2);
  });

  it("sorts by the chosen column, then by name", () => {
    const ids = (sort: Parameters<typeof sortRows>[1]) =>
      sortRows(rows, sort).map((row) => row.site.id);
    expect(ids("visitors")).toEqual(["c", "a", "b"]);
    expect(ids("views")).toEqual(["a", "b", "c"]);
    expect(ids("change")).toEqual(["a", "b", "c"]);
  });
});
