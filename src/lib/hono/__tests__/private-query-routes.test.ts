import { Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { withDashboardCache } from "@/lib/edge/dashboard-cache";
import type * as QueryCoreModule from "@/lib/edge/query/core";
import {
  resolvePrivateSiteForSession,
  resolvePrivateTeamForSession,
} from "@/lib/edge/query/core";
import type * as QueryRouterModule from "@/lib/edge/query/router";
import { dispatchQueryRoute } from "@/lib/edge/query/router";
import { handleTeamDashboardForTeam } from "@/lib/edge/query/team";
import { privateQueryRoutes } from "@/lib/hono/routes/private/query";
import type { AppEnv } from "@/lib/hono/types";

vi.mock("@/lib/edge/dashboard-cache", () => ({
  withDashboardCache: vi.fn(
    async (
      _ctx: ExecutionContext,
      _url: URL,
      loader: () => Promise<Response>,
    ) => loader(),
  ),
}));

vi.mock("@/lib/edge/query/core", async (importOriginal) => {
  const actual = await importOriginal<typeof QueryCoreModule>();
  return {
    ...actual,
    resolvePrivateSiteForSession: vi.fn(),
    resolvePrivateTeamForSession: vi.fn(),
  };
});

vi.mock("@/lib/edge/query/router", async (importOriginal) => {
  const actual = await importOriginal<typeof QueryRouterModule>();
  return {
    ...actual,
    dispatchQueryRoute: vi.fn(),
  };
});

vi.mock("@/lib/edge/query/team", () => ({
  handleTeamDashboardForTeam: vi.fn(),
}));

const env = { DB: {} };
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
    });
    vi.mocked(dispatchQueryRoute).mockResolvedValue(new Response("query"));
    vi.mocked(resolvePrivateTeamForSession).mockResolvedValue({
      id: "team-1",
      allowedSiteIds: ["site-1"],
    });
    vi.mocked(handleTeamDashboardForTeam).mockResolvedValue(
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
    expect(dispatchQueryRoute).toHaveBeenCalledWith(
      env,
      "site-1",
      "overview",
      new URL("https://app.test/api/private/overview?siteId=site-1"),
      { publicMode: false, dashboardMode: true },
      expect.any(Request),
    );
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
    expect(dispatchQueryRoute).toHaveBeenCalledWith(
      env,
      "site-1",
      "funnels",
      new URL("https://app.test/api/private/funnels?siteId=site-1"),
      { publicMode: false, dashboardMode: true },
      expect.any(Request),
    );
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
        },
        request: expect.any(Request),
      }),
    );
    expect(handleTeamDashboardForTeam).toHaveBeenCalledWith(
      env,
      new URL(
        "https://app.test/api/private/team-dashboard?teamId=team-1&from=100&to=200",
      ),
      "team-1",
      expect.objectContaining({ fromMs: 100, toMs: 200 }),
      ["site-1"],
    );
    expect(resolvePrivateSiteForSession).not.toHaveBeenCalled();
    expect(dispatchQueryRoute).not.toHaveBeenCalled();
  });

  it("falls back unknown GET queries through the legacy query dispatcher", async () => {
    const app = createApp();

    const response = await app.fetch(
      request("/api/private/unknown?siteId=site-1"),
      env as never,
      ctx,
    );

    expect(response.status).toBe(200);
    expect(withDashboardCache).toHaveBeenCalled();
    expect(dispatchQueryRoute).toHaveBeenCalledWith(
      env,
      "site-1",
      "unknown",
      new URL("https://app.test/api/private/unknown?siteId=site-1"),
      { publicMode: false, dashboardMode: true },
      expect.any(Request),
    );
  });

  it("enables dashboard-only event detail response shaping", async () => {
    const app = createApp();
    const detailUrl =
      "/api/private/event-type-detail?siteId=site-1&includeContext=false&includeBreakdowns=false&includeFields=false";

    const response = await app.fetch(request(detailUrl), env as never, ctx);

    expect(response.status).toBe(200);
    expect(dispatchQueryRoute).toHaveBeenCalledWith(
      env,
      "site-1",
      "event-type-detail",
      new URL(`https://app.test${detailUrl}`),
      { publicMode: false, dashboardMode: true },
      expect.any(Request),
    );
  });
});
