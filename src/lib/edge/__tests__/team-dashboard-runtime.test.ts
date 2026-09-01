import { beforeEach, describe, expect, it, vi } from "vitest";

import { createTeamDashboardQueryRuntime } from "@/lib/edge/analytics/composition/ssr-query-runtime";
import {
  createQueryTime,
  teamQueryContext,
} from "@/lib/edge/analytics/contract";

vi.mock("@/lib/edge/analytics/providers/d1/internal/core", () => ({
  resolvePrivateTeamForSession: vi.fn(),
}));
vi.mock("@/lib/edge/analytics/providers/d1/internal/team", () => ({
  queryTeamDashboardForTeam: vi.fn(),
}));
vi.mock("@/lib/edge/session-auth", () => ({
  requireSession: vi.fn(),
}));

import { resolvePrivateTeamForSession } from "@/lib/edge/analytics/providers/d1/internal/core";
import { queryTeamDashboardForTeam } from "@/lib/edge/analytics/providers/d1/internal/team";
import {
  readTeamDashboard,
  resolveDashboardSession,
  resolveTeamDashboardScope,
} from "@/lib/edge/analytics/providers/d1/operations/team-dashboard";
import type { EdgeSessionClaims } from "@/lib/edge/session-auth";
import { requireSession } from "@/lib/edge/session-auth";

const env = {} as never;
const request = new Request("https://app.test/api/private/team-dashboard");
const session: EdgeSessionClaims = {
  userId: "user-1",
  username: "user",
  displayName: "User",
  systemRole: "user",
  exp: 1,
};

describe("team dashboard runtime", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("uses the session reader in non-demo builds", async () => {
    vi.mocked(requireSession).mockResolvedValue(session);
    await expect(resolveDashboardSession(request, env)).resolves.toEqual(
      session,
    );
    expect(requireSession).toHaveBeenCalledWith(request, env);
  });

  it("returns unauthorized or access-control responses without querying data", async () => {
    vi.mocked(requireSession).mockResolvedValue(null);
    const unauthorized = await resolveTeamDashboardScope({
      request,
      env,
      teamId: "team-1",
    });
    expect(unauthorized).toBeInstanceOf(Response);
    expect((unauthorized as Response).status).toBe(401);

    const denied = new Response("Forbidden", { status: 403 });
    vi.mocked(resolvePrivateTeamForSession).mockResolvedValue(denied);
    const blocked = await resolveTeamDashboardScope({
      request,
      env,
      teamId: "team-1",
      session,
    });
    expect(blocked).toBe(denied);
  });

  it("resolves scoped teams and passes optional site ACLs to the typed reader", async () => {
    vi.mocked(resolvePrivateTeamForSession).mockResolvedValue({
      id: "team-resolved",
      allowedSiteIds: ["site-1"],
    } as never);
    const scope = await resolveTeamDashboardScope({
      request,
      env,
      teamId: "team-requested",
      session,
    });
    expect(scope).toEqual({
      session,
      teamId: "team-resolved",
      allowedSiteIds: ["site-1"],
    });

    vi.mocked(queryTeamDashboardForTeam).mockResolvedValue({
      data: { sites: [], trend: [] },
      source: "raw",
    } as never);
    await expect(
      readTeamDashboard({
        env,
        teamId: "team-resolved",
        window: {
          startMs: 0,
          endExclusiveMs: 1,
          nowMs: 1,
          timeZone: "UTC",
        },
        interval: "day",
        allowedSiteIds: ["site-1"],
      }),
    ).resolves.toMatchObject({ source: "raw" });
    expect(queryTeamDashboardForTeam).toHaveBeenCalledWith(
      env,
      "team-resolved",
      expect.anything(),
      "day",
      ["site-1"],
      undefined,
    );

    await readTeamDashboard({
      env,
      teamId: "team-resolved",
      window: {
        startMs: 0,
        endExclusiveMs: 1,
        nowMs: 1,
        timeZone: "UTC",
      },
      interval: "day",
    });
    expect(queryTeamDashboardForTeam).toHaveBeenLastCalledWith(
      env,
      "team-resolved",
      expect.anything(),
      "day",
      undefined,
      undefined,
    );
  });

  it("passes the canonical filter document through the SSR reader", async () => {
    const filters = {
      version: 1 as const,
      root: {
        kind: "condition" as const,
        target: { kind: "field" as const, field: "page.path" as never },
        operator: "eq" as const,
        value: "/docs",
      },
    };
    vi.mocked(queryTeamDashboardForTeam).mockResolvedValue({
      data: { sites: [], trend: [] },
      source: "raw",
    } as never);

    await readTeamDashboard({
      env,
      teamId: "team-resolved",
      window: { startMs: 0, endExclusiveMs: 1, nowMs: 1, timeZone: "UTC" },
      interval: "day",
      filters,
    });

    expect(queryTeamDashboardForTeam).toHaveBeenCalledWith(
      env,
      "team-resolved",
      expect.anything(),
      "day",
      undefined,
      undefined,
      undefined,
      filters,
    );
  });

  it("forwards prepared filters from the runtime provider", async () => {
    const filters = {
      version: 1 as const,
      root: {
        kind: "condition" as const,
        target: { kind: "field" as const, field: "page.path" as never },
        operator: "eq" as const,
        value: "/docs",
      },
    };
    vi.mocked(queryTeamDashboardForTeam).mockResolvedValue({
      data: { sites: [], trend: [] },
      source: "raw",
    } as never);

    const runtime = createTeamDashboardQueryRuntime({
      env,
      teamId: "team-resolved",
      window: { startMs: 0, endExclusiveMs: 1, nowMs: 1, timeZone: "UTC" },
      interval: "day",
    });
    const result = await runtime.execute("team-dashboard", {
      context: teamQueryContext("team-resolved", "private-dashboard", [
        "site-1",
      ]),
      time: createQueryTime(0, 1, "UTC", 1),
      filters,
    });

    expect(result.ok).toBe(true);
    expect(queryTeamDashboardForTeam).toHaveBeenCalledWith(
      env,
      "team-resolved",
      expect.anything(),
      "day",
      undefined,
      undefined,
      undefined,
      expect.objectContaining({ root: filters.root }),
    );
  });
});
