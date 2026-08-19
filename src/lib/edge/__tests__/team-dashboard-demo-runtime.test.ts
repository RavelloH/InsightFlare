import { describe, expect, it } from "vitest";

import {
  readDemoTeamDashboard,
  resolveDemoTeamDashboardScope,
} from "@/lib/edge/query-runtime/team-dashboard-demo";

const input = {
  env: {} as never,
  teamId: "demo-team-001",
  window: {
    startMs: Date.UTC(2026, 0, 1),
    endExclusiveMs: Date.UTC(2026, 0, 8),
    nowMs: Date.UTC(2026, 0, 8),
    timeZone: "Asia/Shanghai",
  },
  interval: "day" as const,
};

describe("demo team dashboard runtime", () => {
  it("provides a virtual session, team ACL, and typed mock result", async () => {
    const scope = await resolveDemoTeamDashboardScope({
      request: new Request("https://app.test/api/private/team-dashboard"),
      env: input.env,
      teamId: input.teamId,
    });
    expect(scope).not.toBeInstanceOf(Response);
    if (scope instanceof Response) throw new Error("Expected demo team scope");

    const result = await readDemoTeamDashboard({
      ...input,
      allowedSiteIds: scope.allowedSiteIds,
    });

    expect(scope.session).toMatchObject({
      userId: "demo-user-001",
      systemRole: "admin",
    });
    expect(result.source).toBe("mock");
    expect(result.data.sites.length).toBeGreaterThan(0);
    expect(result.data.trend.length).toBeGreaterThan(0);
    expect(
      result.data.sites.every((site) =>
        scope.allowedSiteIds?.includes(site.id),
      ),
    ).toBe(true);
  });

  it("enforces the supplied site scope without changing the response contract", async () => {
    const unrestricted = await readDemoTeamDashboard(input);
    const onlySiteId = unrestricted.data.sites[0]?.id;
    expect(onlySiteId).toBeTruthy();

    const restricted = await readDemoTeamDashboard({
      ...input,
      allowedSiteIds: [onlySiteId!],
    });

    expect(restricted).toMatchObject({ source: "mock" });
    expect(restricted.data.sites.map((site) => site.id)).toEqual([onlySiteId]);
    expect(
      restricted.data.trend.every((bucket) =>
        bucket.sites.every((site) => site.siteId === onlySiteId),
      ),
    ).toBe(true);
  });

  it("returns not found for an unknown demo team", async () => {
    const result = await resolveDemoTeamDashboardScope({
      request: new Request("https://app.test/api/private/team-dashboard"),
      env: input.env,
      teamId: "missing-team",
    });
    expect(result).toBeInstanceOf(Response);
    expect((result as Response).status).toBe(404);
  });
});
