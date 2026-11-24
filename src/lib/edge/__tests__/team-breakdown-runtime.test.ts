import { beforeEach, describe, expect, it, vi } from "vitest";

import type { FilterFieldId } from "@/lib/edge/analytics/contract";

vi.mock("@/lib/edge/analytics/providers/d1/internal/team", () => ({
  listTeamSites: vi.fn(),
  queryTeamDimensionFromD1: vi.fn(),
}));
vi.mock("@/lib/edge/analytics/providers/d1/operations/site-breakdown", () => ({
  readSiteBreakdown: vi.fn(),
}));

import {
  listTeamSites,
  queryTeamDimensionFromD1,
} from "@/lib/edge/analytics/providers/d1/internal/team";
import { readSiteBreakdown } from "@/lib/edge/analytics/providers/d1/operations/site-breakdown";
import {
  readTeamBreakdown,
  type ReadTeamBreakdownInput,
} from "@/lib/edge/analytics/providers/d1/operations/team-breakdown";

const input: ReadTeamBreakdownInput = {
  env: {} as never,
  teamId: "team-1",
  allowedSiteIds: ["site-1", "site-2"],
  window: { startMs: 0, endExclusiveMs: 1, nowMs: 1, timeZone: "UTC" },
  dimension: "page.path",
  limit: 2,
  filters: { version: 1, root: null },
};

describe("team breakdown runtime", () => {
  beforeEach(() => vi.clearAllMocks());

  it("batches authorized scalar dimensions, sorts and applies the exact global limit", async () => {
    vi.mocked(listTeamSites).mockResolvedValue([
      { id: "site-1" },
      { id: "site-2" },
      { id: "site-3" },
    ] as never);
    vi.mocked(queryTeamDimensionFromD1).mockResolvedValue([
      { value: "/pricing", views: 10, sessions: 5, visitors: 5 },
      { value: "/about", views: 3, sessions: 2, visitors: 2 },
      { value: "/docs", views: 3, sessions: 1, visitors: 1 },
    ]);

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
    expect(queryTeamDimensionFromD1).toHaveBeenCalledWith(
      input.env,
      ["site-1", "site-2"],
      input.window,
      input.filters,
      "TRIM(COALESCE(pathname, ''))",
    );
    expect(readSiteBreakdown).not.toHaveBeenCalled();

    await expect(
      readTeamBreakdown({ ...input, limit: 0 }),
    ).resolves.toHaveProperty(
      "items",
      expect.arrayContaining([
        expect.objectContaining({ key: "/docs", views: 3 }),
      ]),
    );
  });

  it("does not query analytics providers for an empty authorized team", async () => {
    vi.mocked(listTeamSites).mockResolvedValue([] as never);
    await expect(readTeamBreakdown(input)).resolves.toEqual({ items: [] });
    expect(queryTeamDimensionFromD1).not.toHaveBeenCalled();
    expect(readSiteBreakdown).not.toHaveBeenCalled();
  });

  it("retains per-site aggregation for session boundary and event dimensions", async () => {
    vi.mocked(listTeamSites).mockResolvedValue([
      { id: "site-1" },
      { id: "site-2" },
    ] as never);
    vi.mocked(readSiteBreakdown).mockImplementation(async ({ siteId }) => ({
      items: [
        {
          key: "/start",
          label: "/start",
          views: siteId === "site-1" ? 4 : 6,
          sessions: siteId === "site-1" ? 2 : 3,
          visitors: siteId === "site-1" ? 1 : 2,
        },
      ],
    }));
    await expect(
      readTeamBreakdown({ ...input, dimension: "session.entryPath" }),
    ).resolves.toEqual({
      items: [
        { key: "/start", label: "/start", views: 10, sessions: 5, visitors: 3 },
      ],
    });
    expect(readSiteBreakdown).toHaveBeenCalledTimes(2);
    expect(queryTeamDimensionFromD1).not.toHaveBeenCalled();
  });

  it("keeps unprepared non-empty filters on the legacy per-site path", async () => {
    vi.mocked(listTeamSites).mockResolvedValue([{ id: "site-1" }] as never);
    vi.mocked(readSiteBreakdown).mockResolvedValue({
      items: [
        { key: "/docs", label: "/docs", views: 2, sessions: 2, visitors: 1 },
      ],
    });
    const filters: ReadTeamBreakdownInput["filters"] = {
      version: 1,
      root: {
        kind: "condition",
        target: { kind: "field", field: "page.path" as FilterFieldId },
        operator: "eq",
        value: "/docs",
      },
    };
    await expect(readTeamBreakdown({ ...input, filters })).resolves.toEqual({
      items: [
        { key: "/docs", label: "/docs", views: 2, sessions: 2, visitors: 1 },
      ],
    });
    expect(readSiteBreakdown).toHaveBeenCalledWith(
      expect.objectContaining({ siteId: "site-1", filters, limit: 0 }),
    );
    expect(queryTeamDimensionFromD1).not.toHaveBeenCalled();
  });
});
