import { beforeEach, describe, expect, it, vi } from "vitest";

import { createD1TeamQueryRuntime } from "@/lib/edge/analytics/composition/d1";
import {
  createQueryTime,
  EMPTY_FILTER_DOCUMENT,
  teamQueryContext,
} from "@/lib/edge/analytics/contract";
import { readTeamBreakdown } from "@/lib/edge/analytics/providers/d1/operations/team-breakdown";
import { readTeamOverview } from "@/lib/edge/analytics/providers/d1/operations/team-overview";
import { readTeamSites } from "@/lib/edge/analytics/providers/d1/operations/team-sites";
import { readTeamTimeseries } from "@/lib/edge/analytics/providers/d1/operations/team-timeseries";
import type { Env } from "@/lib/edge/types";

vi.mock("@/lib/edge/analytics/providers/d1/operations/team-breakdown", () => ({
  readTeamBreakdown: vi.fn(),
}));
vi.mock("@/lib/edge/analytics/providers/d1/operations/team-overview", () => ({
  readTeamOverview: vi.fn(),
}));
vi.mock("@/lib/edge/analytics/providers/d1/operations/team-sites", () => ({
  readTeamSites: vi.fn(),
}));
vi.mock("@/lib/edge/analytics/providers/d1/operations/team-timeseries", () => ({
  readTeamTimeseries: vi.fn(),
}));

const env = {} as Env;
const time = createQueryTime(100, 200, "UTC", 200);
const context = teamQueryContext("team-1", "api-v1", ["site-1"]);

describe("D1 team query runtime", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(readTeamOverview).mockResolvedValue({
      data: {
        views: 10,
        sessions: 4,
        visitors: 3,
        bounces: 1,
        totalDurationMs: 20,
        durationViews: 4,
      },
      source: "raw",
      approximateVisitors: false,
    });
    vi.mocked(readTeamTimeseries).mockResolvedValue({
      data: { interval: "day", points: [] },
      source: "raw",
      approximateVisitors: false,
    });
    vi.mocked(readTeamSites).mockResolvedValue({
      data: { sites: [] },
      source: "raw",
      approximateVisitors: false,
    });
    vi.mocked(readTeamBreakdown).mockResolvedValue({ items: [] });
  });

  it("registers and executes all canonical team providers", async () => {
    const runtime = createD1TeamQueryRuntime({ env });
    const base = {
      context,
      time,
      filters: EMPTY_FILTER_DOCUMENT,
      teamId: "team-1",
      allowedSiteIds: ["site-1"],
    };

    const overview = await runtime.execute("overview", base);
    const trend = await runtime.execute("trend", {
      ...base,
      interval: "day",
    });
    const sites = await runtime.execute("team-sites", {
      ...base,
      interval: "day",
    });
    const breakdown = await runtime.execute("dimension", {
      ...base,
      dimension: "country",
      limit: 10,
    });

    expect(overview.ok && overview.data).toMatchObject({
      data: { views: 10 },
    });
    expect(trend.ok && trend.data).toMatchObject({
      data: { interval: "day" },
    });
    expect(sites.ok && sites.data).toEqual({
      data: { sites: [] },
      source: "raw",
      approximateVisitors: false,
    });
    expect(breakdown).toMatchObject({ ok: true, data: { items: [] } });
    expect(readTeamOverview).toHaveBeenCalledWith({
      env,
      teamId: "team-1",
      allowedSiteIds: ["site-1"],
      window: {
        startMs: 100,
        endExclusiveMs: 200,
        nowMs: 200,
        timeZone: "UTC",
      },
      filters: EMPTY_FILTER_DOCUMENT,
    });
    expect(readTeamTimeseries).toHaveBeenCalled();
    expect(readTeamSites).toHaveBeenCalled();
    expect(readTeamBreakdown).toHaveBeenCalled();
  });

  it("uses safe defaults for optional team query fields", async () => {
    const runtime = createD1TeamQueryRuntime({ env });
    const base = {
      context,
      time,
      filters: EMPTY_FILTER_DOCUMENT,
    };

    await runtime.execute("team-sites", base);
    await runtime.execute("team-sites", {
      ...base,
      allowedSiteIds: ["site-1", 7],
    });
    await runtime.execute("overview", {
      context,
      time,
      teamId: "team-1",
    });
    await runtime.execute("trend", {
      context,
      time,
      teamId: "team-1",
      interval: "day",
    });
    await runtime.execute("dimension", {
      ...base,
      dimension: "country",
      limit: Number.NaN,
    });

    expect(readTeamSites).toHaveBeenCalledWith({
      env,
      teamId: "",
      allowedSiteIds: undefined,
      interval: undefined,
      window: {
        startMs: 100,
        endExclusiveMs: 200,
        nowMs: 200,
        timeZone: "UTC",
      },
      filters: EMPTY_FILTER_DOCUMENT,
    });
    expect(readTeamBreakdown).toHaveBeenCalledWith(
      expect.objectContaining({
        teamId: "",
        allowedSiteIds: undefined,
        dimension: "country",
        limit: 20,
      }),
    );
  });
});
