import { beforeEach, describe, expect, it, vi } from "vitest";

import { handlePrivateAdmin } from "@/lib/edge/admin";
import { handleAdminWs } from "@/lib/edge/admin-ws";
import { handleApiV1 } from "@/lib/edge/api-v1";
import { handlePrivateArchive } from "@/lib/edge/archive-query";
import {
  handleCollectOptionsRequest,
  handleCollectRequest,
} from "@/lib/edge/collect";
import { handleLegacyAdminUser } from "@/lib/edge/legacy-admin";
import { handleLegacyArchiveFile } from "@/lib/edge/legacy-archive";
import { handleLegacyAuthLogin } from "@/lib/edge/legacy-auth";
import { handleMapTileRequest } from "@/lib/edge/map-tiles";
import { handlePrivateQuery, handlePublicQuery } from "@/lib/edge/query";
import type * as QueryCoreModule from "@/lib/edge/query/core";
import { fetchPublicSite, resolvePrivateSite } from "@/lib/edge/query/core";
import type * as QueryRouterModule from "@/lib/edge/query/router";
import { routeQuery } from "@/lib/edge/query/router";
import { handleTrackerScriptRequest } from "@/lib/edge/script-endpoint";
import apiApp from "@/lib/hono/app";

vi.mock("@/lib/edge/admin", () => ({
  handlePrivateAdmin: vi.fn(),
}));

vi.mock("@/lib/edge/admin-ws", () => ({
  handleAdminWs: vi.fn(),
}));

vi.mock("@/lib/edge/archive-query", () => ({
  handlePrivateArchive: vi.fn(),
}));

vi.mock("@/lib/edge/collect", () => ({
  handleCollectOptionsRequest: vi.fn(),
  handleCollectRequest: vi.fn(),
}));

vi.mock("@/lib/edge/legacy-admin", () => ({
  handleLegacyAdminUser: vi.fn(),
}));

vi.mock("@/lib/edge/legacy-archive", () => ({
  handleLegacyArchiveFile: vi.fn(),
  handleLegacyArchiveManifest: vi.fn(),
}));

vi.mock("@/lib/edge/legacy-auth", () => ({
  handleLegacyAuthLogin: vi.fn(),
  handleLegacyAuthLogout: vi.fn(),
}));

vi.mock("@/lib/edge/map-tiles", () => ({
  handleMapTileRequest: vi.fn(),
}));

vi.mock("@/lib/edge/query", () => ({
  handlePrivateQuery: vi.fn(),
  handlePublicQuery: vi.fn(),
}));

vi.mock("@/lib/edge/query/core", async (importOriginal) => {
  const actual = await importOriginal<typeof QueryCoreModule>();
  return {
    ...actual,
    fetchPublicSite: vi.fn(),
    resolvePrivateSite: vi.fn(),
  };
});

vi.mock("@/lib/edge/query/router", async (importOriginal) => {
  const actual = await importOriginal<typeof QueryRouterModule>();
  return {
    ...actual,
    routeQuery: vi.fn(),
  };
});

vi.mock("@/lib/edge/api-v1", () => ({
  handleApiV1: vi.fn(),
}));

vi.mock("@/lib/edge/script-endpoint", () => ({
  handleTrackerScriptRequest: vi.fn(),
}));

const env = { DB: {}, INGEST_DO: {}, ARCHIVE_BUCKET: {} };
const ctx = { waitUntil: vi.fn(), passThroughOnException: vi.fn() };
const executionCtx = ctx as unknown as ExecutionContext;

function request(path: string, init?: RequestInit): Request {
  return new Request(`https://app.test${path}`, init);
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
    vi.mocked(handlePrivateAdmin).mockResolvedValue(new Response("admin"));
    vi.mocked(handlePrivateArchive).mockResolvedValue(new Response("archive"));
    vi.mocked(handlePrivateQuery).mockResolvedValue(
      new Response("private-query"),
    );
    vi.mocked(resolvePrivateSite).mockResolvedValue({
      id: "site-1",
      name: "Site",
      domain: "app.test",
    });
    vi.mocked(fetchPublicSite).mockResolvedValue({
      id: "public-site",
      name: "Public Site",
      domain: "public.test",
    });
    vi.mocked(routeQuery).mockResolvedValue(new Response("private-query"));
    vi.mocked(handlePublicQuery).mockResolvedValue(
      new Response("public-query"),
    );
    vi.mocked(handleApiV1).mockResolvedValue(new Response("v1"));
    vi.mocked(handleLegacyAuthLogin).mockResolvedValue(
      new Response("legacy-login"),
    );
    vi.mocked(handleLegacyAdminUser).mockResolvedValue(
      new Response("legacy-admin"),
    );
    vi.mocked(handleLegacyArchiveFile).mockResolvedValue(
      new Response("legacy-file"),
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
    await apiApp.fetch(request("/admin/ws"), env as any, executionCtx);

    expect(handleCollectOptionsRequest).toHaveBeenCalled();
    expect(handleCollectRequest).toHaveBeenCalledWith(
      expect.any(Request),
      env,
      executionCtx,
      new URL("https://app.test/collect"),
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
      request("/api/public/demo/site"),
      env as any,
      executionCtx,
    );
    await apiApp.fetch(
      request("/api/v1/capabilities"),
      env as any,
      executionCtx,
    );

    expect(handlePrivateAdmin).toHaveBeenCalled();
    expect(handlePrivateArchive).toHaveBeenCalled();
    expect(resolvePrivateSite).toHaveBeenCalled();
    expect(routeQuery).toHaveBeenCalledWith(
      env,
      "site-1",
      "overview",
      new URL("https://app.test/api/private/overview"),
      { publicMode: false },
      expect.any(Request),
    );
    expect(handlePrivateQuery).not.toHaveBeenCalled();
    expect(fetchPublicSite).toHaveBeenCalled();
    expect(handlePublicQuery).not.toHaveBeenCalled();
    expect(handleApiV1).toHaveBeenCalled();
  });

  it("routes legacy and map endpoints through Hono", async () => {
    await apiApp.fetch(
      request("/api/auth/login", { method: "POST" }),
      env as any,
      executionCtx,
    );
    await apiApp.fetch(
      request("/api/admin/user", { method: "POST" }),
      env as any,
      executionCtx,
    );
    await apiApp.fetch(
      request("/api/archive/file?key=a", { method: "HEAD" }),
      env as any,
      executionCtx,
    );
    await apiApp.fetch(
      request("/api/map-tiles/1/0/0.png"),
      env as any,
      executionCtx,
    );

    expect(handleLegacyAuthLogin).toHaveBeenCalled();
    expect(handleLegacyAdminUser).toHaveBeenCalled();
    expect(handleLegacyArchiveFile).toHaveBeenCalled();
    expect(handleMapTileRequest).toHaveBeenCalledWith(expect.any(Request), {
      z: "1",
      x: "0",
      y: "0.png",
    });
  });
});
