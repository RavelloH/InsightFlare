import { beforeEach, describe, expect, it, vi } from "vitest";

import { resolveTeamDashboardRequest } from "@/lib/dashboard/server-query";
import { resolveTeamDashboardScope } from "@/lib/edge/analytics/providers/d1/operations/team-dashboard";
import type { EdgeSessionClaims } from "@/lib/edge/session-auth";
import type { Env } from "@/lib/edge/types";

vi.mock("@/lib/edge/analytics/providers/d1/operations/team-dashboard", () => ({
  resolveTeamDashboardScope: vi.fn(),
}));

const resolveTeamDashboardScopeMock = vi.mocked(resolveTeamDashboardScope);
const env = {} as Env;
const session: EdgeSessionClaims = {
  userId: "user-1",
  username: "dashboard-user",
  displayName: "Dashboard User",
  systemRole: "user",
  exp: 9_999_999_999,
};

function requestWithCookies(url: string, cookie?: string): Request {
  return {
    url,
    headers: new Headers(cookie ? { cookie } : undefined),
  } as Request;
}

describe("resolveTeamDashboardRequest", () => {
  beforeEach(() => {
    resolveTeamDashboardScopeMock.mockReset();
  });

  it("returns runtime authorization failures unchanged", async () => {
    resolveTeamDashboardScopeMock.mockResolvedValue(
      new Response("Unauthorized", { status: 401 }),
    );
    const request = new Request("https://app.test/team/dashboard");

    const result = await resolveTeamDashboardRequest({
      request,
      env,
      teamId: "team-requested",
    });

    expect(result).toBeInstanceOf(Response);
    expect((result as Response).status).toBe(401);
    expect(resolveTeamDashboardScopeMock).toHaveBeenCalledWith({
      request,
      env,
      teamId: "team-requested",
    });
  });

  it("passes the runtime scope through with the cookie timezone", async () => {
    resolveTeamDashboardScopeMock.mockResolvedValue({
      session,
      teamId: "team-resolved",
      allowedSiteIds: ["site-1"],
    });
    const request = requestWithCookies(
      "https://app.test/team/dashboard?tab=traffic",
      "other=value; insightflare-reporting-time-zone=Asia%2FTokyo",
    );
    expect(request.headers.get("cookie")).toBe(
      "other=value; insightflare-reporting-time-zone=Asia%2FTokyo",
    );

    const result = await resolveTeamDashboardRequest({
      request,
      env,
      teamId: "team-requested",
    });

    expect(result).not.toBeInstanceOf(Response);
    if (result instanceof Response) throw new Error("Expected request context");
    expect(result).toMatchObject({
      env,
      request,
      session,
      teamId: "team-resolved",
      allowedSiteIds: ["site-1"],
      timeZone: "Asia/Tokyo",
    });
    expect(resolveTeamDashboardScopeMock).toHaveBeenCalledWith({
      request,
      env,
      teamId: "team-requested",
    });
  });

  it("defaults to UTC when no cookie header is present", async () => {
    resolveTeamDashboardScopeMock.mockResolvedValue({
      session,
      teamId: "team-resolved",
    });
    const request = new Request("https://app.test/team/dashboard?tab=traffic");

    const result = await resolveTeamDashboardRequest({
      request,
      env,
      teamId: "team-requested",
    });

    expect(result).not.toBeInstanceOf(Response);
    if (result instanceof Response) {
      throw new Error("Expected request context");
    }
    expect(result.timeZone).toBe("UTC");
  });

  it("skips cookie entries without an '=' separator and keeps the timezone", async () => {
    resolveTeamDashboardScopeMock.mockResolvedValue({
      session,
      teamId: "team-resolved",
    });
    const request = requestWithCookies(
      "https://app.test/team/dashboard?tab=traffic",
      "no-separator-value; insightflare-reporting-time-zone=Europe%2FParis",
    );

    const result = await resolveTeamDashboardRequest({
      request,
      env,
      teamId: "team-requested",
    });

    expect(result).not.toBeInstanceOf(Response);
    if (result instanceof Response) {
      throw new Error("Expected request context");
    }
    expect(result.timeZone).toBe("Europe/Paris");
  });

  it("returns ACL failures and uses UTC for missing or malformed cookies", async () => {
    const denied = new Response("Forbidden", { status: 403 });
    resolveTeamDashboardScopeMock.mockResolvedValueOnce(denied);

    const deniedResult = await resolveTeamDashboardRequest({
      request: new Request("https://app.test/team/dashboard"),
      env,
      teamId: "team-requested",
    });
    expect(deniedResult).toBe(denied);

    resolveTeamDashboardScopeMock.mockResolvedValueOnce({
      session,
      teamId: "team-resolved",
    });
    const malformedCookieRequest = requestWithCookies(
      "https://app.test/team/dashboard",
      "insightflare-reporting-time-zone=%E0%A4",
    );
    const fallbackResult = await resolveTeamDashboardRequest({
      request: malformedCookieRequest,
      env,
      teamId: "team-requested",
    });

    expect(fallbackResult).not.toBeInstanceOf(Response);
    if (fallbackResult instanceof Response) {
      throw new Error("Expected request context");
    }
    expect(fallbackResult.timeZone).toBe("UTC");
  });
});
