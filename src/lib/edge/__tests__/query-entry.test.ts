import { beforeEach, describe, expect, it, vi } from "vitest";

import type { Env } from "@/lib/edge/types";

const withDashboardCacheMock = vi.fn(
  async (
    _ctx: ExecutionContext | undefined,
    _url: URL,
    generate: () => Promise<Response>,
  ) => generate(),
);
const fetchPublicSiteMock = vi.fn();
const resolvePrivateSiteMock = vi.fn();
const routeQueryMock = vi.fn();
const handleTeamDashboardMock = vi.fn();

vi.mock("@/lib/edge/dashboard-cache", () => ({
  PUBLIC_QUERY_CACHE_OPTIONS: {
    ttlSeconds: 300,
    cacheName: "insightflare-public-query",
    applyCacheHeadersOnBypass: true,
  },
  withDashboardCache: withDashboardCacheMock,
}));

vi.mock("@/lib/edge/query/core", () => ({
  fetchPublicSite: fetchPublicSiteMock,
  jsonResponse: (payload: unknown, status = 200) =>
    new Response(JSON.stringify(payload), {
      status,
      headers: { "content-type": "application/json; charset=utf-8" },
    }),
  notAllowed: () =>
    new Response(JSON.stringify({ ok: false, error: "Method Not Allowed" }), {
      status: 405,
      headers: { "content-type": "application/json; charset=utf-8" },
    }),
  resolvePrivateSite: resolvePrivateSiteMock,
}));

vi.mock("@/lib/edge/query/router", () => ({
  routeQuery: routeQueryMock,
}));

vi.mock("@/lib/edge/query/team", () => ({
  handleTeamDashboard: handleTeamDashboardMock,
}));

const { handlePrivateQuery, handlePublicQuery } =
  await import("@/lib/edge/query/entry");

const env = { DB: {} as D1Database } as Env;

function request(path: string, init?: RequestInit) {
  return new Request(`https://edge.test${path}`, init);
}

describe("edge query entry handlers", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    withDashboardCacheMock.mockImplementation(
      async (
        _ctx: ExecutionContext | undefined,
        _url: URL,
        generate: () => Promise<Response>,
      ) => generate(),
    );
    fetchPublicSiteMock.mockResolvedValue({
      id: "site-public",
      name: "Public",
      domain: "public.example",
    });
    resolvePrivateSiteMock.mockResolvedValue({
      id: "site-private",
      name: "Private",
      domain: "private.example",
    });
    routeQueryMock.mockResolvedValue(new Response("routed"));
    handleTeamDashboardMock.mockResolvedValue(new Response("team"));
  });

  it("rejects unsupported private methods before resolving the site", async () => {
    const edgeRequest = request("/api/private/overview", { method: "POST" });

    const response = await handlePrivateQuery(
      edgeRequest,
      env,
      new URL(edgeRequest.url),
    );

    expect(response.status).toBe(405);
    expect(resolvePrivateSiteMock).not.toHaveBeenCalled();
    expect(routeQueryMock).not.toHaveBeenCalled();
    expect(withDashboardCacheMock).not.toHaveBeenCalled();
  });

  it("routes private team dashboard before site resolution or caching", async () => {
    const edgeRequest = request("/api/private/team-dashboard?teamId=team-1");

    const response = await handlePrivateQuery(
      edgeRequest,
      env,
      new URL(edgeRequest.url),
    );

    await expect(response.text()).resolves.toBe("team");
    expect(handleTeamDashboardMock).toHaveBeenCalledWith(
      edgeRequest,
      env,
      new URL(edgeRequest.url),
    );
    expect(resolvePrivateSiteMock).not.toHaveBeenCalled();
    expect(withDashboardCacheMock).not.toHaveBeenCalled();
  });

  it("bypasses dashboard cache for private funnel reads and mutations", async () => {
    const readRequest = request("/api/private/funnels");
    const readUrl = new URL(readRequest.url);

    await expect(
      (await handlePrivateQuery(readRequest, env, readUrl)).text(),
    ).resolves.toBe("routed");
    expect(routeQueryMock).toHaveBeenCalledWith(
      env,
      "site-private",
      "funnels",
      readUrl,
      { publicMode: false },
      readRequest,
    );
    expect(withDashboardCacheMock).not.toHaveBeenCalled();

    vi.clearAllMocks();
    resolvePrivateSiteMock.mockResolvedValue({
      id: "site-private",
      name: "Private",
      domain: "private.example",
    });
    routeQueryMock.mockResolvedValue(new Response("routed"));

    const edgeRequest = request("/api/private/funnels", {
      method: "POST",
    });
    const url = new URL(edgeRequest.url);

    const response = await handlePrivateQuery(edgeRequest, env, url);

    await expect(response.text()).resolves.toBe("routed");
    expect(routeQueryMock).toHaveBeenCalledWith(
      env,
      "site-private",
      "funnels",
      url,
      { publicMode: false },
      edgeRequest,
    );
    expect(withDashboardCacheMock).not.toHaveBeenCalled();

    vi.clearAllMocks();
    resolvePrivateSiteMock.mockResolvedValue({
      id: "site-private",
      name: "Private",
      domain: "private.example",
    });
    routeQueryMock.mockResolvedValue(new Response("routed"));

    const deleteRequest = request("/api/private/funnels?id=funnel-1", {
      method: "DELETE",
    });
    const deleteUrl = new URL(deleteRequest.url);

    await expect(
      (await handlePrivateQuery(deleteRequest, env, deleteUrl)).text(),
    ).resolves.toBe("routed");
    expect(routeQueryMock).toHaveBeenCalledWith(
      env,
      "site-private",
      "funnels",
      deleteUrl,
      { publicMode: false },
      deleteRequest,
    );
    expect(withDashboardCacheMock).not.toHaveBeenCalled();
  });

  it("returns site resolution responses without routing", async () => {
    const denied = new Response("denied", { status: 401 });
    resolvePrivateSiteMock.mockResolvedValueOnce(denied);
    const edgeRequest = request("/api/private/overview");

    const response = await handlePrivateQuery(
      edgeRequest,
      env,
      new URL(edgeRequest.url),
    );

    expect(response).toBe(denied);
    expect(routeQueryMock).not.toHaveBeenCalled();
  });

  it("wraps private read-only routes with dashboard cache", async () => {
    const edgeRequest = request("/api/private/overview");
    const url = new URL(edgeRequest.url);
    const ctx = {} as ExecutionContext;

    const response = await handlePrivateQuery(edgeRequest, env, url, ctx);

    await expect(response.text()).resolves.toBe("routed");
    expect(withDashboardCacheMock).toHaveBeenCalledWith(
      ctx,
      url,
      expect.any(Function),
    );
    expect(routeQueryMock).toHaveBeenCalledWith(
      env,
      "site-private",
      "overview",
      url,
      { publicMode: false },
      edgeRequest,
    );
  });

  it("rejects unsupported public methods before public site lookup", async () => {
    const edgeRequest = request("/api/public-sites/public/overview", {
      method: "POST",
    });

    const response = await handlePublicQuery(
      edgeRequest,
      env,
      new URL(edgeRequest.url),
    );

    expect(response.status).toBe(405);
    expect(fetchPublicSiteMock).not.toHaveBeenCalled();
    expect(withDashboardCacheMock).not.toHaveBeenCalled();
  });

  it("returns public site lookup responses without routing", async () => {
    const missing = new Response("missing", { status: 404 });
    fetchPublicSiteMock.mockResolvedValueOnce(missing);
    const edgeRequest = request("/api/public-sites/missing/overview");

    const response = await handlePublicQuery(
      edgeRequest,
      env,
      new URL(edgeRequest.url),
    );

    expect(response).toBe(missing);
    expect(routeQueryMock).not.toHaveBeenCalled();
  });

  it("routes public paths after the slug through dashboard cache", async () => {
    const edgeRequest = request("/api/public-sites/public/pages/top");
    const url = new URL(edgeRequest.url);
    const ctx = {} as ExecutionContext;

    const response = await handlePublicQuery(edgeRequest, env, url, ctx);

    await expect(response.text()).resolves.toBe("routed");
    expect(withDashboardCacheMock).toHaveBeenCalledWith(
      ctx,
      url,
      expect.any(Function),
      {
        ttlSeconds: 300,
        cacheName: "insightflare-public-query",
        applyCacheHeadersOnBypass: true,
      },
    );
    expect(routeQueryMock).toHaveBeenCalledWith(
      env,
      "site-public",
      "pages/top",
      url,
      { publicMode: true },
      edgeRequest,
    );
  });

  it("wraps public site metadata responses with public cache options", async () => {
    const edgeRequest = request("/api/public-sites/public/site");
    const url = new URL(edgeRequest.url);
    const ctx = {} as ExecutionContext;

    const response = await handlePublicQuery(edgeRequest, env, url, ctx);

    await expect(response.json()).resolves.toMatchObject({
      ok: true,
      data: {
        slug: "public",
        name: "Public",
        domain: "public.example",
        id: "site-public",
      },
    });
    expect(withDashboardCacheMock).toHaveBeenCalledWith(
      ctx,
      url,
      expect.any(Function),
      {
        ttlSeconds: 300,
        cacheName: "insightflare-public-query",
        applyCacheHeadersOnBypass: true,
      },
    );
    expect(routeQueryMock).not.toHaveBeenCalled();
  });
});
