import { Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { withDashboardCache } from "@/lib/edge/analytics/composition/dashboard-cache";
import type * as PrivateQueryAdapter from "@/lib/edge/analytics/interfaces/dashboard/private";
import {
  executePrivateQuery,
  executePrivateTeamDashboard,
} from "@/lib/edge/analytics/interfaces/dashboard/private";
import { handleOverviewContract } from "@/lib/edge/analytics/interfaces/dashboard/protocol/overview";
import type * as SiteAccessModule from "@/lib/edge/auth/site-access";
import {
  resolvePrivateSiteForSession,
  resolvePrivateTeamForSession,
} from "@/lib/edge/auth/site-access";
import { privateQueryRoutes } from "@/lib/hono/routes/private/query";
import type { AppEnv } from "@/lib/hono/types";
vi.mock("@/lib/edge/analytics/composition/dashboard-cache", () => ({
  withDashboardCache: vi.fn(
    async (
      _ctx: ExecutionContext,
      _url: URL,
      loader: () => Promise<Response>,
    ) => loader(),
  ),
}));
vi.mock("@/lib/edge/auth/site-access", async (importOriginal) => {
  const actual = await importOriginal<typeof SiteAccessModule>();
  return {
    ...actual,
    resolvePrivateSiteForSession: vi.fn(),
    resolvePrivateTeamForSession: vi.fn(),
  };
});
vi.mock("@/lib/edge/analytics/interfaces/dashboard/protocol/overview", () => ({
  handleOverviewContract: vi.fn(),
  handleTrendContract: vi.fn(),
}));
vi.mock("@/lib/edge/analytics/interfaces/dashboard/protocol/pages", () => ({
  handlePagesContract: vi.fn(),
  handleReferrersContract: vi.fn(),
}));
vi.mock(
  "@/lib/edge/analytics/interfaces/dashboard/private",
  async (importOriginal) => {
    const actual = await importOriginal<typeof PrivateQueryAdapter>();
    return {
      ...actual,
      executePrivateQuery: vi.fn(actual.executePrivateQuery),
      executePrivateTeamDashboard: vi.fn(),
    };
  },
);
vi.mock("@/lib/edge/analytics/interfaces/dashboard/protocol/funnels", () => ({
  handleFunnel: vi.fn(async () => new Response("funnel")),
}));
vi.mock("@/lib/edge/analytics/interfaces/dashboard/protocol/goals", () => ({
  handleGoal: vi.fn(async () => new Response("goal")),
}));
vi.mock("@/lib/edge/analytics/interfaces/dashboard/protocol/events", () => ({
  handleEventTypeDetailContract: vi.fn(async () => new Response("query")),
}));
const env = { DB: {} };
const dispatchQueryRoute = vi.fn();
const ctx = {
  passThroughOnException: vi.fn(),
  waitUntil: vi.fn(),
} as unknown as ExecutionContext;
const session = {
  userId: "user-1",
  username: "user",
  displayName: "User",
  systemRole: "user" as const,
  exp: 9999999999,
};
function request(path: string, init?: RequestInit): Request {
  return new Request(`https://app.test${path}`, init);
}
function createApp() {
  const app = new Hono<AppEnv>();
  app.use("/api/private/*", async (c, next) => {
    c.set("session", session);
    await next();
  });
  app.route("/api/private", privateQueryRoutes);
  return app;
}
describe("Hono private query routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(resolvePrivateSiteForSession).mockResolvedValue({
      id: "site-1",
      name: "Site",
      domain: "app.test",
      canManage: true,
    });
    vi.mocked(dispatchQueryRoute).mockResolvedValue(new Response("query"));
    vi.mocked(handleOverviewContract).mockResolvedValue(new Response("query"));
    vi.mocked(resolvePrivateTeamForSession).mockResolvedValue({
      id: "team-1",
      allowedSiteIds: ["site-1"],
    });
    vi.mocked(executePrivateTeamDashboard).mockResolvedValue(
      new Response("team"),
    );
  });

  it("routes read-only dashboard queries through site resolution and cache", async () => {
    const app = createApp();

    const response = await app.fetch(
      request("/api/private/overview?siteId=site-1"),
      env as never,
      ctx,
    );

    await expect(response.text()).resolves.toBe("query");
    expect(resolvePrivateSiteForSession).toHaveBeenCalledWith(
      expect.any(Request),
      env,
      new URL("https://app.test/api/private/overview?siteId=site-1"),
      session,
    );
    expect(withDashboardCache).toHaveBeenCalledWith(
      ctx,
      new URL("https://app.test/api/private/overview?siteId=site-1"),
      expect.any(Function),
      expect.objectContaining({
        identity: {
          scope: "private",
          tenantId: "site-1",
          route: "overview",
        },
        request: expect.any(Request),
      }),
    );
    expect(handleOverviewContract).toHaveBeenCalledWith(
      env,
      "site-1",
      new URL("https://app.test/api/private/overview?siteId=site-1"),
      expect.objectContaining({ requestId: expect.any(String) }),
      expect.objectContaining({ subject: { kind: "site", siteId: "site-1" } }),
    );
    expect(dispatchQueryRoute).not.toHaveBeenCalled();
  });

  it("does not enter the cache generator when private site resolution fails", async () => {
    vi.mocked(resolvePrivateSiteForSession).mockResolvedValueOnce(
      new Response("denied", { status: 404 }),
    );
    const app = createApp();

    const response = await app.fetch(
      request("/api/private/overview?siteId=missing"),
      env as never,
      ctx,
    );

    expect(response.status).toBe(404);
    await expect(response.text()).resolves.toBe("denied");
    expect(withDashboardCache).not.toHaveBeenCalled();
    expect(dispatchQueryRoute).not.toHaveBeenCalled();
  });

  it("authorizes one site and preserves per-item cache identity and captured clock", async () => {
    vi.mocked(executePrivateQuery)
      .mockResolvedValueOnce(Response.json({ ok: true, data: { items: [] } }))
      .mockResolvedValueOnce(Response.json({ ok: false }, { status: 400 }));
    const query = "siteId=site-1&from=100&to=200&limit=100&scope=session";
    const response = await createApp().fetch(
      request("/api/private/query-batch?siteId=site-1", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          items: [
            { path: "overview-page-path", query },
            { path: "overview-client-browser", query },
          ],
        }),
      }),
      env as never,
      ctx,
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      ok: true,
      items: [
        { status: 200, body: { ok: true, data: { items: [] } } },
        { status: 400, body: { ok: false } },
      ],
    });
    expect(resolvePrivateSiteForSession).toHaveBeenCalledTimes(1);
    expect(withDashboardCache).toHaveBeenCalledTimes(2);
    expect(
      vi
        .mocked(withDashboardCache)
        .mock.calls.map((call) => call[3]?.identity?.route),
    ).toEqual(["overview-page-path", "overview-client-browser"]);
    const calls = vi.mocked(executePrivateQuery).mock.calls;
    expect(calls[0]?.[0].batchExecution?.capturedAtMs).toEqual(
      expect.any(Number),
    );
    expect(calls[0]?.[0].batchExecution?.capturedAtMs).toBe(
      calls[1]?.[0].batchExecution?.capturedAtMs,
    );
  });

  it.each([
    ["goals", "site-1", 100],
    ["overview-page-path", "site-2", 100],
    ["overview-page-path", "site-1", 101],
  ])(
    "rejects unsupported batch items before querying: %s %s %s",
    async (path, site, limit) => {
      const response = await createApp().fetch(
        request("/api/private/query-batch?siteId=site-1", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            items: [
              {
                path: "overview-client-browser",
                query: "siteId=site-1&from=100&to=200&limit=100",
              },
              {
                path,
                query: "siteId=" + site + "&from=100&to=200&limit=" + limit,
              },
            ],
          }),
        }),
        env as never,
        ctx,
      );
      expect(response.status).toBe(400);
      expect(withDashboardCache).not.toHaveBeenCalled();
      expect(executePrivateQuery).not.toHaveBeenCalled();
    },
  );

  it("denies the entire private batch before any cache access when the parent site is not readable", async () => {
    vi.mocked(resolvePrivateSiteForSession).mockResolvedValueOnce(
      new Response("denied", { status: 404 }),
    );
    const query = "siteId=site-1&from=100&to=200&limit=100";
    const response = await createApp().fetch(
      request("/api/private/query-batch?siteId=site-1", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          items: [
            { path: "overview-page-path", query },
            { path: "overview-client-browser", query },
          ],
        }),
      }),
      env as never,
      ctx,
    );
    expect(response.status).toBe(404);
    expect(withDashboardCache).not.toHaveBeenCalled();
    expect(executePrivateQuery).not.toHaveBeenCalled();
  });

  it("rejects oversized and non-JSON private batches before dispatch", async () => {
    const app = createApp();
    const path = "/api/private/query-batch?siteId=site-1";
    const oversized = await app.fetch(
      request(path, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: " ".repeat(48 * 1024 + 1),
      }),
      env as never,
      ctx,
    );
    const nonJson = await app.fetch(
      request(path, {
        method: "POST",
        headers: { "content-type": "text/plain" },
        body: "{}",
      }),
      env as never,
      ctx,
    );
    expect(oversized.status).toBe(413);
    expect(nonJson.status).toBe(415);
    expect(withDashboardCache).not.toHaveBeenCalled();
    expect(executePrivateQuery).not.toHaveBeenCalled();
  });

  it("keeps non-funnel mutations out of private query routes", async () => {
    const app = createApp();

    const response = await app.fetch(
      request("/api/private/overview?siteId=site-1", { method: "POST" }),
      env as never,
      ctx,
    );

    expect(response.status).toBe(405);
    expect(resolvePrivateSiteForSession).not.toHaveBeenCalled();
    expect(withDashboardCache).not.toHaveBeenCalled();
    expect(dispatchQueryRoute).not.toHaveBeenCalled();
  });

  it("allows funnel mutations without dashboard cache", async () => {
    const app = createApp();

    const postResponse = await app.fetch(
      request("/api/private/funnels?siteId=site-1", { method: "POST" }),
      env as never,
      ctx,
    );
    const deleteResponse = await app.fetch(
      request("/api/private/funnels?siteId=site-1", { method: "DELETE" }),
      env as never,
      ctx,
    );

    expect(postResponse.status).toBe(200);
    expect(deleteResponse.status).toBe(200);
    expect(withDashboardCache).not.toHaveBeenCalled();
  });

  it("allows Goal definition CRUD through the private site route", async () => {
    const app = createApp();

    const getResponse = await app.fetch(
      request("/api/private/goals?siteId=site-1"),
      env as never,
      ctx,
    );
    const postResponse = await app.fetch(
      request("/api/private/goals?siteId=site-1", { method: "POST" }),
      env as never,
      ctx,
    );

    expect(getResponse.status).toBe(200);
    expect(postResponse.status).toBe(200);
    expect(withDashboardCache).not.toHaveBeenCalled();
  });

  it("denies Goal mutations to a readable site member", async () => {
    vi.mocked(resolvePrivateSiteForSession).mockResolvedValueOnce({
      id: "site-1",
      name: "Site",
      domain: "app.test",
      canManage: false,
    });
    const app = createApp();
    const response = await app.fetch(
      request("/api/private/goals?siteId=site-1", {
        method: "PATCH",
        body: "{}",
      }),
      env as never,
      ctx,
    );
    expect(response.status).toBe(403);
  });

  it("denies funnel mutations to a readable site member", async () => {
    vi.mocked(resolvePrivateSiteForSession).mockResolvedValueOnce({
      id: "site-1",
      name: "Site",
      domain: "app.test",
      canManage: false,
    });
    const app = createApp();
    const response = await app.fetch(
      request("/api/private/funnels?siteId=site-1", {
        method: "PATCH",
        body: "{}",
      }),
      env as never,
      ctx,
    );
    expect(response.status).toBe(403);
  });

  it("throws when the private session context is missing", async () => {
    const app = new Hono<AppEnv>();
    app.route("/api/private", privateQueryRoutes);

    const response = await app.fetch(
      request("/api/private/team-dashboard?teamId=team-1"),
      env as never,
      ctx,
    );

    expect(response.status).toBe(500);
    expect(resolvePrivateTeamForSession).not.toHaveBeenCalled();
  });

  it("rejects non-GET team dashboard queries before team resolution", async () => {
    const app = createApp();

    const response = await app.fetch(
      request("/api/private/team-dashboard?teamId=team-1", { method: "POST" }),
      env as never,
      ctx,
    );

    expect(response.status).toBe(405);
    expect(resolvePrivateTeamForSession).not.toHaveBeenCalled();
    expect(executePrivateTeamDashboard).not.toHaveBeenCalled();
  });

  it("returns the team access response directly when team resolution fails", async () => {
    vi.mocked(resolvePrivateTeamForSession).mockResolvedValueOnce(
      new Response("denied", { status: 403 }),
    );
    const app = createApp();

    const response = await app.fetch(
      request("/api/private/team-dashboard?teamId=team-1"),
      env as never,
      ctx,
    );

    expect(response.status).toBe(403);
    await expect(response.text()).resolves.toBe("denied");
    expect(withDashboardCache).not.toHaveBeenCalled();
    expect(executePrivateTeamDashboard).not.toHaveBeenCalled();
  });

  it("caches the team dashboard after team access resolves", async () => {
    const app = createApp();

    const response = await app.fetch(
      request("/api/private/team-dashboard?teamId=team-1&from=100&to=200"),
      env as never,
      ctx,
    );

    await expect(response.text()).resolves.toBe("team");
    expect(resolvePrivateTeamForSession).toHaveBeenCalledWith(
      expect.any(Request),
      env,
      new URL(
        "https://app.test/api/private/team-dashboard?teamId=team-1&from=100&to=200",
      ),
      session,
    );
    expect(withDashboardCache).toHaveBeenCalledWith(
      ctx,
      new URL(
        "https://app.test/api/private/team-dashboard?teamId=team-1&from=100&to=200",
      ),
      expect.any(Function),
      expect.objectContaining({
        identity: {
          scope: "private-team",
          tenantId: "team-1",
          route: "team-dashboard",
          audienceId: "user-1",
          allowedSiteIds: ["site-1"],
        },
        request: expect.any(Request),
      }),
    );
    expect(executePrivateTeamDashboard).toHaveBeenCalledWith(
      expect.objectContaining({
        env,
        teamId: "team-1",
        allowedSiteIds: ["site-1"],
        url: new URL(
          "https://app.test/api/private/team-dashboard?teamId=team-1&from=100&to=200",
        ),
      }),
    );
    expect(resolvePrivateSiteForSession).not.toHaveBeenCalled();
    expect(dispatchQueryRoute).not.toHaveBeenCalled();
  });

  it("returns 404 for unknown GET queries without the legacy dispatcher", async () => {
    const app = createApp();

    const response = await app.fetch(
      request("/api/private/unknown?siteId=site-1"),
      env as never,
      ctx,
    );

    expect(response.status).toBe(404);
    expect(withDashboardCache).toHaveBeenCalled();
    expect(dispatchQueryRoute).not.toHaveBeenCalled();
  });

  it("enables dashboard-only event detail response shaping", async () => {
    const app = createApp();
    const detailUrl =
      "/api/private/event-type-detail?siteId=site-1&eventName=checkout&includeContext=false&includeBreakdowns=false";

    const response = await app.fetch(request(detailUrl), env as never, ctx);

    expect(response.status).toBe(200);
  });
});
