import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/edge/analytics/providers/d1/internal/team", () => ({
  listTeamSites: vi.fn(),
}));
vi.mock("@/lib/edge/analytics/providers/d1/operations/site-breakdown", () => ({
  readSiteBreakdown: vi.fn(),
}));

import { listTeamSites } from "@/lib/edge/analytics/providers/d1/internal/team";
import { readSiteBreakdown } from "@/lib/edge/analytics/providers/d1/operations/site-breakdown";
import { readTeamBreakdown } from "@/lib/edge/analytics/providers/d1/operations/team-breakdown";

const input = {
  env: {} as never,
  teamId: "team-1",
  allowedSiteIds: ["site-1", "site-2"],
  window: { startMs: 0, endExclusiveMs: 1, nowMs: 1, timeZone: "UTC" },
  dimension: "page.path",
  limit: 2,
  filters: { version: 1 as const, root: null },
};

describe("team breakdown runtime", () => {
  beforeEach(() => vi.clearAllMocks());

  it("aggregates authorized sites, sorts deterministically, and applies the global limit", async () => {
    vi.mocked(listTeamSites).mockResolvedValue([
      { id: "site-1" },
      { id: "site-2" },
      { id: "site-3" },
    ] as never);
    vi.mocked(readSiteBreakdown).mockImplementation(async ({ siteId }) =>
      siteId === "site-1"
        ? {
            items: [
              {
                key: "/pricing",
                label: "/pricing",
                views: 4,
                sessions: 2,
                visitors: 2,
              },
              {
                key: "/docs",
                label: "/docs",
                views: 3,
                sessions: 1,
                visitors: 1,
              },
            ],
          }
        : {
            items: [
              {
                key: "/pricing",
                label: "/pricing",
                views: 6,
                sessions: 3,
                visitors: 3,
              },
              {
                key: "/about",
                label: "/about",
                views: 3,
                sessions: 2,
                visitors: 2,
              },
            ],
          },
    );

    await expect(readTeamBreakdown(input)).resolves.toEqual({
      items: [
        {
          key: "/pricing",
          label: "/pricing",
          views: 10,
          sessions: 5,
          visitors: 5,
        },
        { key: "/about", label: "/about", views: 3, sessions: 2, visitors: 2 },
      ],
    });
    expect(readSiteBreakdown).toHaveBeenCalledTimes(2);
    expect(readSiteBreakdown).toHaveBeenCalledWith(
      expect.objectContaining({ siteId: "site-1", limit: 0 }),
    );
  });

  it("returns an empty result without querying providers when no site is available", async () => {
    vi.mocked(listTeamSites).mockResolvedValue([] as never);
    await expect(readTeamBreakdown(input)).resolves.toEqual({ items: [] });
    expect(readSiteBreakdown).not.toHaveBeenCalled();
  });
});
