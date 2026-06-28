import { Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type * as DashboardCacheModule from "@/lib/edge/dashboard-cache";
import {
  PUBLIC_QUERY_CACHE_OPTIONS,
  withDashboardCache,
} from "@/lib/edge/dashboard-cache";
import type * as QueryCoreModule from "@/lib/edge/query/core";
import { fetchPublicSite } from "@/lib/edge/query/core";
import type * as QueryRouterModule from "@/lib/edge/query/router";
import { dispatchQueryRoute } from "@/lib/edge/query/router";
import { publicQueryRoutes } from "@/lib/hono/routes/public/query";
import type { AppEnv } from "@/lib/hono/types";

vi.mock("@/lib/edge/dashboard-cache", async (importOriginal) => {
  const actual = await importOriginal<typeof DashboardCacheModule>();
  return {
    ...actual,
    withDashboardCache: vi.fn(
      async (
        _ctx: ExecutionContext,
        _url: URL,
        loader: () => Promise<Response>,
      ) => loader(),
    ),
  };
});

vi.mock("@/lib/edge/query/core", async (importOriginal) => {
  const actual = await importOriginal<typeof QueryCoreModule>();
  return {
    ...actual,
    fetchPublicSite: vi.fn(),
  };
});

vi.mock("@/lib/edge/query/router", async (importOriginal) => {
  const actual = await importOriginal<typeof QueryRouterModule>();
  return {
    ...actual,
    dispatchQueryRoute: vi.fn(),
  };
});

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
  app.route("/api/public", publicQueryRoutes);
  return app;
}

describe("Hono public query routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(fetchPublicSite).mockResolvedValue({
      id: "site-1",
      name: "Public Site",
      domain: "public.test",
    });
    vi.mocked(dispatchQueryRoute).mockResolvedValue(new Response("query"));
  });

  it("returns public site metadata through the public cache wrapper", async () => {
    const app = createApp();

    const response = await app.fetch(
      request("/api/public/demo/site"),
      env as never,
      ctx,
    );
    const body = (await response.json()) as {
      ok: boolean;
      data: { slug: string; id: string };
    };

    expect(body).toMatchObject({
      ok: true,
      data: { slug: "demo", id: "site-1" },
    });
    expect(fetchPublicSite).toHaveBeenCalledWith(
      env,
      new URL("https://app.test/api/public/demo/site"),
    );
    expect(withDashboardCache).toHaveBeenCalledWith(
      ctx,
      new URL("https://app.test/api/public/demo/site"),
      expect.any(Function),
      PUBLIC_QUERY_CACHE_OPTIONS,
    );
    expect(dispatchQueryRoute).not.toHaveBeenCalled();
  });

  it("routes public allowlist queries with publicMode and public cache options", async () => {
    const app = createApp();

    const response = await app.fetch(
      request("/api/public/demo/overview?preset=today"),
      env as never,
      ctx,
    );

    await expect(response.text()).resolves.toBe("query");
    expect(withDashboardCache).toHaveBeenCalledWith(
      ctx,
      new URL("https://app.test/api/public/demo/overview?preset=today"),
      expect.any(Function),
      PUBLIC_QUERY_CACHE_OPTIONS,
    );
    expect(dispatchQueryRoute).toHaveBeenCalledWith(
      env,
      "site-1",
      "overview",
      new URL("https://app.test/api/public/demo/overview?preset=today"),
      { publicMode: true },
      expect.any(Request),
    );
  });

  it("rejects public mutations before site lookup and cache", async () => {
    const app = createApp();

    const response = await app.fetch(
      request("/api/public/demo/overview", { method: "POST" }),
      env as never,
      ctx,
    );

    expect(response.status).toBe(405);
    expect(fetchPublicSite).not.toHaveBeenCalled();
    expect(withDashboardCache).not.toHaveBeenCalled();
    expect(dispatchQueryRoute).not.toHaveBeenCalled();
  });

  it("does not enter cache when public site resolution fails", async () => {
    vi.mocked(fetchPublicSite).mockResolvedValueOnce(
      new Response("missing", { status: 404 }),
    );
    const app = createApp();

    const response = await app.fetch(
      request("/api/public/missing/overview"),
      env as never,
      ctx,
    );

    expect(response.status).toBe(404);
    await expect(response.text()).resolves.toBe("missing");
    expect(withDashboardCache).not.toHaveBeenCalled();
    expect(dispatchQueryRoute).not.toHaveBeenCalled();
  });

  it("keeps private-only endpoints behind the public query allowlist", async () => {
    vi.mocked(dispatchQueryRoute).mockResolvedValueOnce(
      new Response("not found", { status: 404 }),
    );
    const app = createApp();

    const response = await app.fetch(
      request("/api/public/demo/events-records"),
      env as never,
      ctx,
    );

    expect(response.status).toBe(404);
    expect(dispatchQueryRoute).toHaveBeenCalledWith(
      env,
      "site-1",
      "events-records",
      new URL("https://app.test/api/public/demo/events-records"),
      { publicMode: true },
      expect.any(Request),
    );
  });
});
