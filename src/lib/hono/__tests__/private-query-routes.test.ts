import { Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { withDashboardCache } from "@/lib/edge/dashboard-cache";
import type * as QueryCoreModule from "@/lib/edge/query/core";
import { resolvePrivateSite } from "@/lib/edge/query/core";
import type * as QueryRouterModule from "@/lib/edge/query/router";
import { dispatchQueryRoute } from "@/lib/edge/query/router";
import { handleTeamDashboard } from "@/lib/edge/query/team";
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
    resolvePrivateSite: vi.fn(),
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
  handleTeamDashboard: vi.fn(),
}));

const env = { DB: {} };
const ctx = {
  passThroughOnException: vi.fn(),
  waitUntil: vi.fn(),
} as unknown as ExecutionContext;

function request(path: string, init?: RequestInit): Request {
  return new Request(`https://app.test${path}`, init);
}

function createApp() {
  const app = new Hono<AppEnv>();
  app.route("/api/private", privateQueryRoutes);
  return app;
}

describe("Hono private query routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(resolvePrivateSite).mockResolvedValue({
      id: "site-1",
      name: "Site",
      domain: "app.test",
    });
    vi.mocked(dispatchQueryRoute).mockResolvedValue(new Response("query"));
    vi.mocked(handleTeamDashboard).mockResolvedValue(new Response("team"));
  });

  it("routes read-only dashboard queries through site resolution and cache", async () => {
    const app = createApp();

    const response = await app.fetch(
      request("/api/private/overview?siteId=site-1"),
      env as never,
      ctx,
    );

    await expect(response.text()).resolves.toBe("query");
    expect(resolvePrivateSite).toHaveBeenCalledWith(
      expect.any(Request),
      env,
      new URL("https://app.test/api/private/overview?siteId=site-1"),
    );
    expect(withDashboardCache).toHaveBeenCalledWith(
      ctx,
      new URL("https://app.test/api/private/overview?siteId=site-1"),
      expect.any(Function),
      undefined,
    );
    expect(dispatchQueryRoute).toHaveBeenCalledWith(
      env,
      "site-1",
      "overview",
      new URL("https://app.test/api/private/overview?siteId=site-1"),
      { publicMode: false },
      expect.any(Request),
    );
  });

  it("does not enter the cache generator when private site resolution fails", async () => {
    vi.mocked(resolvePrivateSite).mockResolvedValueOnce(
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
    expect(resolvePrivateSite).not.toHaveBeenCalled();
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
      { publicMode: false },
      expect.any(Request),
    );
  });

  it("keeps team dashboard ahead of site resolution and cache", async () => {
    const app = createApp();

    const response = await app.fetch(
      request("/api/private/team-dashboard?teamId=team-1"),
      env as never,
      ctx,
    );

    await expect(response.text()).resolves.toBe("team");
    expect(handleTeamDashboard).toHaveBeenCalledWith(
      expect.any(Request),
      env,
      new URL("https://app.test/api/private/team-dashboard?teamId=team-1"),
    );
    expect(resolvePrivateSite).not.toHaveBeenCalled();
    expect(withDashboardCache).not.toHaveBeenCalled();
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
      { publicMode: false },
      expect.any(Request),
    );
  });
});
