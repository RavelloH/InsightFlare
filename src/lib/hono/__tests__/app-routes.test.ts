// @vitest-environment node

import { beforeEach, describe, expect, it, vi } from "vitest";

import { handleUsersAdmin } from "@/lib/edge/admin-users";
import { handleAdminWs } from "@/lib/edge/admin-ws";
import { handleOverviewContract } from "@/lib/edge/analytics/composition/legacy/overview-contract-adapter";
import type * as QueryCoreModule from "@/lib/edge/analytics/providers/d1/internal/core";
import {
  fetchPublicSite,
  resolvePrivateSiteForSession,
} from "@/lib/edge/analytics/providers/d1/internal/core";
import type * as QueryRouterModule from "@/lib/edge/analytics/providers/d1/internal/router";
import { authenticateApiKey } from "@/lib/edge/api-key-auth";
import {
  handlePrivateArchive,
  handlePrivateArchiveFile,
  handlePrivateArchiveManifest,
} from "@/lib/edge/archive-query";
import {
  handleCollectOptionsRequest,
  handleCollectRequest,
} from "@/lib/edge/collect";
import {
  handleLegacyAuthLogin,
  handleLegacyAuthLogout,
} from "@/lib/edge/legacy-auth";
import { handleMapTileRequest } from "@/lib/edge/map-tiles";
import { handleReleasesCompareRequest } from "@/lib/edge/releases-compare";
import { handleTrackerScriptRequest } from "@/lib/edge/script-endpoint";
import { handleWikiSummaryRequest } from "@/lib/edge/wiki-summary";
import { handleWorldCountriesRequest } from "@/lib/edge/world-countries";
import apiApp from "@/lib/hono/app";

vi.mock("@/lib/edge/admin-ws", () => ({
  handleAdminWs: vi.fn(),
}));

vi.mock("@/lib/edge/archive-query", () => ({
  handlePrivateArchiveFile: vi.fn(),
  handlePrivateArchive: vi.fn(),
  handlePrivateArchiveManifest: vi.fn(),
}));

vi.mock("@/lib/edge/admin-users", () => ({
  handleAuthLoginAdmin: vi.fn(),
  handleAuthMeAdmin: vi.fn(),
  handleProfileAdmin: vi.fn(),
  handleUsersAdmin: vi.fn(),
}));

vi.mock("@/lib/edge/collect", () => ({
  handleCollectOptionsRequest: vi.fn(),
  handleCollectRequest: vi.fn(),
}));

vi.mock("@/lib/edge/legacy-auth", () => ({
  handleLegacyAuthLogin: vi.fn(),
  handleLegacyAuthLogout: vi.fn(),
}));

vi.mock("@/lib/edge/map-tiles", () => ({
  handleMapTileRequest: vi.fn(),
}));

vi.mock("@/lib/edge/releases-compare", () => ({
  handleReleasesCompareRequest: vi.fn(),
}));

vi.mock(
  "@/lib/edge/analytics/providers/d1/internal/core",
  async (importOriginal) => {
    const actual = await importOriginal<typeof QueryCoreModule>();
    return {
      ...actual,
      fetchPublicSite: vi.fn(),
      resolvePrivateSiteForSession: vi.fn(),
    };
  },
);

vi.mock(
  "@/lib/edge/analytics/providers/d1/internal/router",
  async (importOriginal) => {
    const actual = await importOriginal<typeof QueryRouterModule>();
    return {
      ...actual,
    };
  },
);

vi.mock(
  "@/lib/edge/analytics/composition/legacy/overview-contract-adapter",
  () => ({
    handleOverviewContract: vi.fn(),
    handleTrendContract: vi.fn(),
  }),
);

vi.mock(
  "@/lib/edge/analytics/composition/legacy/pages-contract-adapter",
  () => ({
    handlePagesContract: vi.fn(),
    handleReferrersContract: vi.fn(),
  }),
);

vi.mock("@/lib/edge/api-key-auth", () => ({
  authenticateApiKey: vi.fn(),
}));

vi.mock("@/lib/edge/script-endpoint", () => ({
  handleTrackerScriptRequest: vi.fn(),
}));

vi.mock("@/lib/edge/world-countries", () => ({
  handleWorldCountriesRequest: vi.fn(),
}));

vi.mock("@/lib/edge/wiki-summary", () => ({
  handleWikiSummaryRequest: vi.fn(),
}));

vi.mock("@/lib/edge/session-auth", () => ({
  requireSession: vi.fn(),
}));

const { requireSession } = await import("@/lib/edge/session-auth");

const env = { DB: {}, INGEST_DO: {}, ARCHIVE_BUCKET: {} };
const dispatchQueryRoute = vi.fn();
const ctx = { waitUntil: vi.fn(), passThroughOnException: vi.fn() };
const executionCtx = ctx as unknown as ExecutionContext;
const session = {
  userId: "user-1",
  username: "user",
  displayName: "User",
  systemRole: "admin" as const,
  exp: 9999999999,
};

function request(path: string, init?: RequestInit): Request {
  return new Request(`https://app.test${path}`, init);
}

function publicBrowserRequest(path: string, init?: RequestInit): Request {
  const headers = new Headers(init?.headers);
  headers.set(
    "user-agent",
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
  );
  headers.set("sec-fetch-site", "same-origin");
  headers.set("sec-fetch-mode", "cors");
  headers.set("sec-fetch-dest", "empty");
  return request(path, { ...init, headers });
}

describe("Hono API app routing", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(handleCollectOptionsRequest).mockResolvedValue(
      new Response(null, { status: 204 }),
    );
    vi.mocked(handleCollectRequest).mockResolvedValue(
      new Response(null, { status: 204 }),
    );
    vi.mocked(handleTrackerScriptRequest).mockResolvedValue(
      new Response("script"),
    );
    vi.mocked(handleWorldCountriesRequest).mockResolvedValue(
      new Response("countries"),
    );
    vi.mocked(handleWikiSummaryRequest).mockResolvedValue(new Response("wiki"));
    vi.mocked(handleReleasesCompareRequest).mockResolvedValue(
      new Response("compare"),
    );
    vi.mocked(handleUsersAdmin).mockResolvedValue(new Response("admin"));
    vi.mocked(requireSession).mockResolvedValue(session);
    vi.mocked(handlePrivateArchive).mockResolvedValue(new Response("archive"));
    vi.mocked(handlePrivateArchiveFile).mockResolvedValue(
      new Response("archive-file"),
    );
    vi.mocked(handlePrivateArchiveManifest).mockResolvedValue(
      new Response("archive"),
    );
    vi.mocked(resolvePrivateSiteForSession).mockResolvedValue({
      id: "site-1",
      name: "Site",
      domain: "app.test",
    });
    vi.mocked(fetchPublicSite).mockResolvedValue({
      id: "public-site",
      name: "Public Site",
      domain: "public.test",
    });
    vi.mocked(dispatchQueryRoute).mockResolvedValue(
      new Response("private-query"),
    );
    vi.mocked(handleOverviewContract).mockResolvedValue(
      new Response("private-query"),
    );
    vi.mocked(authenticateApiKey).mockResolvedValue({
      keyId: "key-1",
      teamId: "team-1",
      prefix: "if_123",
      scopes: ["analytics:read"],
      siteIds: ["site-1"],
    });
    vi.mocked(handleLegacyAuthLogin).mockResolvedValue(
      new Response("legacy-login"),
    );
    vi.mocked(handleLegacyAuthLogout).mockResolvedValue(
      new Response("legacy-logout"),
    );
    vi.mocked(handleMapTileRequest).mockResolvedValue(new Response("tile"));
    vi.mocked(handleAdminWs).mockResolvedValue(new Response("ws"));
  });

  it("serves healthz directly from Hono bindings", async () => {
    const response = await apiApp.fetch(
      request("/healthz"),
      env as any,
      executionCtx,
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      ok: true,
      service: "insightflare",
      bindings: { d1: true, durableObject: true, r2Archive: true },
    });
  });

  it("serves dynamic well-known OpenAPI with forwarded host", async () => {
    const response = await apiApp.fetch(
      request("/.well-known/openapi.json", {
        headers: {
          "x-forwarded-host": "edge.example.test",
          "x-forwarded-proto": "https",
        },
      }),
      env as any,
      executionCtx,
    );
    const body = (await response.json()) as {
      servers: Array<{ url: string }>;
    };

    expect(response.headers.get("access-control-allow-origin")).toBe("*");
    expect(body.servers[0].url).toBe("https://edge.example.test");
  });

  it("serves well-known HEAD and dynamic metadata variants", async () => {
    const openapiHead = await apiApp.fetch(
      request("/.well-known/openapi.json", { method: "HEAD" }),
      env as any,
      executionCtx,
    );
    const skills = await apiApp.fetch(
      request("/.well-known/skills.json", {
        headers: {
          "x-forwarded-host": "skills.example.test",
          "x-forwarded-proto": "http",
        },
      }),
      env as any,
      executionCtx,
    );
    const skillsHead = await apiApp.fetch(
      request("/.well-known/skills.json", { method: "HEAD" }),
      env as any,
      executionCtx,
    );
    const security = await apiApp.fetch(
      request("/.well-known/security.txt"),
      env as any,
      executionCtx,
    );
    const securityHead = await apiApp.fetch(
      request("/.well-known/security.txt", { method: "HEAD" }),
      env as any,
      executionCtx,
    );

    expect(openapiHead.status).toBe(200);
    expect(await openapiHead.text()).toBe("");
    expect(skills.headers.get("content-type")).toContain("application/json");
    expect(skills.headers.get("access-control-allow-origin")).toBe("*");
    expect(skills.headers.get("cache-control")).toContain("max-age=3600");
    expect(await skills.text()).toContain("http://skills.example.test");
    expect(skillsHead.status).toBe(200);
    expect(security.status).toBe(200);
    expect(await security.text()).toContain("contact@insightflare.net");
    expect(securityHead.status).toBe(200);
  });

  it("redirects well-known helpers using the request origin fallback", async () => {
    const changePassword = await apiApp.fetch(
      request("/.well-known/change-password"),
      env as any,
      executionCtx,
    );
    const changePasswordHead = await apiApp.fetch(
      request("/.well-known/change-password", { method: "HEAD" }),
      env as any,
      executionCtx,
    );
    const health = await apiApp.fetch(
      request("/.well-known/health"),
      env as any,
      executionCtx,
    );
    const healthHead = await apiApp.fetch(
      request("/.well-known/health", { method: "HEAD" }),
      env as any,
      executionCtx,
    );

    expect(changePassword.status).toBe(302);
    expect(changePassword.headers.get("location")).toBe("https://app.test/app");
    expect(changePasswordHead.status).toBe(200);
    expect(health.status).toBe(302);
    expect(health.headers.get("location")).toBe("https://app.test/healthz");
    expect(healthHead.status).toBe(200);
  });

  it("routes edge endpoints to their shared handlers", async () => {
    await apiApp.fetch(
      request("/collect", { method: "OPTIONS" }),
      env as any,
      executionCtx,
    );
    await apiApp.fetch(
      request("/collect", { method: "POST" }),
      env as any,
      executionCtx,
    );
    await apiApp.fetch(request("/script.js"), env as any, executionCtx);
    await apiApp.fetch(
      request("/api/private/realtime/ws"),
      env as any,
      executionCtx,
    );

    expect(handleCollectOptionsRequest).toHaveBeenCalled();
    expect(handleCollectRequest).toHaveBeenCalledWith(
      expect.any(Request),
      env,
      executionCtx,
      new URL("https://app.test/collect"),
      expect.anything(),
    );
    expect(handleTrackerScriptRequest).toHaveBeenCalledWith(
      expect.any(Request),
      env,
    );
    expect(handleAdminWs).toHaveBeenCalledWith(expect.any(Request), env);
  });

  it("routes private, public, and v1 API groups through Hono", async () => {
    await apiApp.fetch(
      request("/api/private/admin/users"),
      env as any,
      executionCtx,
    );
    await apiApp.fetch(
      request("/api/private/archive/manifest"),
      env as any,
      executionCtx,
    );
    await apiApp.fetch(
      request("/api/private/overview"),
      env as any,
      executionCtx,
    );
    await apiApp.fetch(
      publicBrowserRequest("/api/public/share/demo/site"),
      env as any,
      executionCtx,
    );
    await apiApp.fetch(
      request("/api/v1/capabilities"),
      env as any,
      executionCtx,
    );

    expect(handleUsersAdmin).toHaveBeenCalled();
    expect(handlePrivateArchiveManifest).toHaveBeenCalled();
    expect(handlePrivateArchive).not.toHaveBeenCalled();
    expect(resolvePrivateSiteForSession).toHaveBeenCalled();
    expect(handleOverviewContract).toHaveBeenCalledWith(
      env,
      "site-1",
      new URL("https://app.test/api/private/overview"),
      expect.objectContaining({ requestId: expect.any(String) }),
      expect.objectContaining({ subject: { kind: "site", siteId: "site-1" } }),
    );
    expect(fetchPublicSite).toHaveBeenCalled();
  });

  it("emits one aggregate Worker record with route and query diagnostics", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    vi.mocked(handleOverviewContract).mockResolvedValueOnce(
      new Response("overview", {
        headers: {
          "x-insightflare-cache": "MISS",
          "x-insightflare-data-source": "raw",
          "x-insightflare-d1-rows-read": "42",
        },
      }),
    );

    await apiApp.fetch(
      request("/api/private/overview"),
      env as any,
      executionCtx,
    );

    expect(logSpy).toHaveBeenCalledTimes(1);
    expect(logSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        source: "worker",
        trigger: "request",
        request: expect.objectContaining({
          method: "GET",
          status: 200,
          outcome: "ok",
        }),
        performance: expect.objectContaining({
          cache: "MISS",
          dataSource: "raw",
          handlerD1RowsRead: 42,
        }),
        logs: expect.arrayContaining([
          expect.objectContaining({ message: "request.started" }),
          expect.objectContaining({ message: "route.handler.started" }),
          expect.objectContaining({ message: "route.handler.completed" }),
          expect.objectContaining({ message: "request.completed" }),
        ]),
      }),
    );
    logSpy.mockRestore();
  });

  it("redirects the bare API root to API v1 without applying API no-cache defaults", async () => {
    const response = await apiApp.fetch(
      request("/api"),
      env as any,
      executionCtx,
    );

    expect(response.status).toBe(307);
    expect(response.headers.get("location")).toBe("/api/v1");
    expect(response.headers.get("cache-control")).toBeNull();
    expect(response.headers.get("pragma")).toBeNull();
  });

  it("adds no-cache headers to API v1 responses", async () => {
    const response = await apiApp.fetch(
      request("/api/v1"),
      env as any,
      executionCtx,
    );

    expect(response.headers.get("cache-control")).toBe(
      "no-store, no-cache, must-revalidate",
    );
    expect(response.headers.get("pragma")).toBe("no-cache");
  });

  it("does not add global no-cache headers to public resource responses", async () => {
    const response = await apiApp.fetch(
      publicBrowserRequest("/api/public/resources/world-countries"),
      env as any,
      executionCtx,
    );

    expect(response.headers.get("cache-control")).toBeNull();
    expect(response.headers.get("pragma")).toBeNull();
  });

  it("routes public session and resource endpoints through Hono", async () => {
    await apiApp.fetch(
      request("/api/public/session", { method: "POST" }),
      env as any,
      executionCtx,
    );
    await apiApp.fetch(
      request("/api/public/session", { method: "DELETE" }),
      env as any,
      executionCtx,
    );
    await apiApp.fetch(
      publicBrowserRequest("/api/public/resources/map-tiles/1/0/0.png"),
      env as any,
      executionCtx,
    );

    expect(handleLegacyAuthLogin).toHaveBeenCalled();
    expect(handleLegacyAuthLogout).toHaveBeenCalled();
    expect(handleMapTileRequest).toHaveBeenCalledWith(
      expect.any(Request),
      { z: "1", x: "0", y: "0.png" },
      expect.anything(),
    );
  });

  it("routes private endpoints only after session authentication", async () => {
    await apiApp.fetch(
      request("/api/private/archive/file?key=a", { method: "HEAD" }),
      env as any,
      executionCtx,
    );
    await apiApp.fetch(
      request("/api/private/realtime/ws?siteId=site-1"),
      env as any,
      executionCtx,
    );

    expect(requireSession).toHaveBeenCalled();
    expect(handlePrivateArchiveFile).toHaveBeenCalled();
    expect(handleAdminWs).toHaveBeenCalled();
  });

  it("reuses the authenticated session for private site resolution", async () => {
    vi.mocked(requireSession).mockClear();

    await apiApp.fetch(
      request("/api/private/overview?siteId=site-1"),
      env as any,
      executionCtx,
    );

    expect(requireSession).toHaveBeenCalledTimes(1);
    expect(resolvePrivateSiteForSession).toHaveBeenCalledWith(
      expect.any(Request),
      env,
      new URL("https://app.test/api/private/overview?siteId=site-1"),
      session,
    );
  });

  it("returns 401 for private endpoints without a session", async () => {
    vi.mocked(requireSession).mockResolvedValueOnce(null);

    const response = await apiApp.fetch(
      request("/api/private/admin/users"),
      env as any,
      executionCtx,
    );

    expect(response.status).toBe(401);
    expect(handleUsersAdmin).not.toHaveBeenCalled();
  });

  it("does not mount legacy private API aliases", async () => {
    const legacyAdmin = await apiApp.fetch(
      request("/api" + "/admin/user", { method: "POST" }),
      env as any,
      executionCtx,
    );
    const legacyArchive = await apiApp.fetch(
      request("/api" + "/archive/file?key=a"),
      env as any,
      executionCtx,
    );
    const legacyMap = await apiApp.fetch(
      request("/api" + "/map-tiles/1/0/0.png"),
      env as any,
      executionCtx,
    );
    const legacyWs = await apiApp.fetch(
      request("/admin" + "/ws?siteId=site-1"),
      env as any,
      executionCtx,
    );

    expect(legacyAdmin.status).toBe(404);
    expect(legacyArchive.status).toBe(404);
    expect(legacyMap.status).toBe(404);
    expect(legacyWs.status).toBe(404);
  });

  it("routes world countries through Hono", async () => {
    const original = publicBrowserRequest(
      "/api/public/resources/world-countries",
    );

    const response = await apiApp.fetch(original, env as any, executionCtx);

    expect(await response.text()).toBe("countries");
    expect(handleWorldCountriesRequest).toHaveBeenCalledWith(
      original,
      expect.anything(),
    );
  });

  it("routes wiki summary through Hono", async () => {
    const original = publicBrowserRequest(
      "/api/public/resources/wiki-summary?wikidataId=Q42",
    );

    const response = await apiApp.fetch(original, env as any, executionCtx);

    expect(await response.text()).toBe("wiki");
    expect(handleWikiSummaryRequest).toHaveBeenCalledWith(
      original,
      expect.anything(),
    );
  });

  it("routes release comparison through Hono", async () => {
    const original = request("/api/private/releases/compare?head=v2&base=v1");

    const response = await apiApp.fetch(original, env as any, executionCtx);

    expect(await response.text()).toBe("compare");
    expect(handleReleasesCompareRequest).toHaveBeenCalledWith(original, env);
  });
});
