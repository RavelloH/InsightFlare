import { beforeEach, describe, expect, it, vi } from "vitest";

import { resolveTeamDashboardRequest } from "@/lib/dashboard/server-query";
import { resolvePrivateTeamForSession } from "@/lib/edge/query/core";
import {
  type EdgeSessionClaims,
  requireSession,
} from "@/lib/edge/session-auth";
import type { Env } from "@/lib/edge/types";

vi.mock("@/lib/edge/query/core", () => ({
  resolvePrivateTeamForSession: vi.fn(),
}));

vi.mock("@/lib/edge/session-auth", () => ({
  requireSession: vi.fn(),
}));

const requireSessionMock = vi.mocked(requireSession);
const resolvePrivateTeamForSessionMock = vi.mocked(
  resolvePrivateTeamForSession,
);
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
    requireSessionMock.mockReset();
    resolvePrivateTeamForSessionMock.mockReset();
  });

  it("returns unauthorized without invoking team ACL resolution", async () => {
    requireSessionMock.mockResolvedValue(null);
    const request = new Request("https://app.test/team/dashboard");

    const result = await resolveTeamDashboardRequest({
      request,
      env,
      teamId: "team-requested",
    });

    expect(result).toBeInstanceOf(Response);
    expect((result as Response).status).toBe(401);
    expect(resolvePrivateTeamForSessionMock).not.toHaveBeenCalled();
  });

  it("passes the session and resolved team ACL through with the cookie timezone", async () => {
    requireSessionMock.mockResolvedValue(session);
    resolvePrivateTeamForSessionMock.mockResolvedValue({
      id: "team-resolved",
      allowedSiteIds: ["site-1"],
    } as Awaited<ReturnType<typeof resolvePrivateTeamForSession>>);
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
    expect(resolvePrivateTeamForSessionMock).toHaveBeenCalledWith(
      request,
      env,
      expect.objectContaining({ search: "?tab=traffic&teamId=team-requested" }),
      session,
    );
  });

  it("returns ACL failures and uses UTC for missing or malformed cookies", async () => {
    requireSessionMock.mockResolvedValue(session);
    const denied = new Response("Forbidden", { status: 403 });
    resolvePrivateTeamForSessionMock.mockResolvedValueOnce(denied);

    const deniedResult = await resolveTeamDashboardRequest({
      request: new Request("https://app.test/team/dashboard"),
      env,
      teamId: "team-requested",
    });
    expect(deniedResult).toBe(denied);

    resolvePrivateTeamForSessionMock.mockResolvedValueOnce({
      id: "team-resolved",
    } as Awaited<ReturnType<typeof resolvePrivateTeamForSession>>);
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
