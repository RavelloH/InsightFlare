import { type Handler, Hono, type MiddlewareHandler } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { ApiKeyPrincipal } from "@/lib/edge/api-key-auth";
import type * as ApiKeyAuthModule from "@/lib/edge/api-key-auth";
import type { Env } from "@/lib/edge/types";
import {
  authenticateApiKeyMiddleware,
  requireApiScopeMiddleware,
} from "@/lib/hono/middleware/api-key";
import { normalizeJsonBodyMiddleware } from "@/lib/hono/middleware/body";
import { dashboardCacheMiddleware } from "@/lib/hono/middleware/dashboard-cache";
import {
  errorBoundaryMiddleware,
  handleHonoError,
} from "@/lib/hono/middleware/error-boundary";
import {
  requireMethodMiddleware,
  requireMethodsMiddleware,
} from "@/lib/hono/middleware/method";
import { requestIdMiddleware } from "@/lib/hono/middleware/request-id";
import { sameOriginMiddleware } from "@/lib/hono/middleware/same-origin";
import { requireSessionMiddleware } from "@/lib/hono/middleware/session";
import {
  resolveApiSiteMiddleware,
  resolvePrivateSiteMiddleware,
  resolvePublicSiteMiddleware,
} from "@/lib/hono/middleware/site";
import type { AppEnv } from "@/lib/hono/types";
import { responseContext } from "@/lib/hono/utils/context";

vi.mock("@/lib/edge/api-key-auth", async (importOriginal) => {
  const actual = await importOriginal<typeof ApiKeyAuthModule>();
  return {
    ...actual,
    authenticateApiKey: vi.fn(),
  };
});

vi.mock("@/lib/edge/dashboard-cache", () => ({
  withDashboardCache: vi.fn(
    async (
      _ctx: ExecutionContext,
      _url: URL,
      loader: () => Promise<Response>,
    ) => loader(),
  ),
}));

vi.mock("@/lib/edge/query/core", () => ({
  fetchPublicSite: vi.fn(),
  resolvePrivateSite: vi.fn(),
}));

vi.mock("@/lib/edge/session-auth", () => ({
  requireSession: vi.fn(),
}));

vi.mock("@/lib/edge/utils", () => ({
  requireSameOrigin: vi.fn(),
}));

const { authenticateApiKey } = await import("@/lib/edge/api-key-auth");
const { withDashboardCache } = await import("@/lib/edge/dashboard-cache");
const { fetchPublicSite, resolvePrivateSite } =
  await import("@/lib/edge/query/core");
const { requireSession } = await import("@/lib/edge/session-auth");
const { requireSameOrigin } = await import("@/lib/edge/utils");

const ctx = {
  passThroughOnException: vi.fn(),
  waitUntil: vi.fn(),
} as unknown as ExecutionContext;

const principal: ApiKeyPrincipal = {
  keyId: "key-1",
  teamId: "team-1",
  prefix: "if_123",
  scopes: ["analytics:read"],
  siteIds: ["site-1"],
};

function request(path: string, init?: RequestInit): Request {
  return new Request(`https://app.test${path}`, init);
}

function createApp(
  middleware: MiddlewareHandler<AppEnv>,
  handler: Handler<AppEnv>,
) {
  const app = new Hono<AppEnv>();
  app.use("*", middleware);
  app.all("*", handler);
  return app;
}

function createEnv(first: unknown = null): Env {
  return {
    DB: {
      prepare: vi.fn(() => ({
        bind: vi.fn(() => ({
          first: vi.fn(async () => first),
        })),
      })),
    },
  } as unknown as Env;
}

describe("Hono middleware foundation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(requireSameOrigin).mockReturnValue(null);
  });

  it("stores the shared request id value", async () => {
    const app = createApp(requestIdMiddleware(), (c) =>
      c.json({ requestId: c.get("requestId") }),
    );

    const response = await app.fetch(
      request("/api/private/overview", {
        headers: { "x-request-id": "req-123" },
      }),
      createEnv(),
      ctx,
    );

    await expect(response.json()).resolves.toEqual({ requestId: "req-123" });
  });

  it("returns the shared response context from Hono variables", () => {
    expect(
      responseContext({
        get: (key: string) => (key === "requestId" ? "req-ctx" : undefined),
      } as never),
    ).toEqual({ requestId: "req-ctx" });
  });

  it("maps thrown errors through the shared error response", async () => {
    const app = new Hono<AppEnv>();
    app.onError(handleHonoError);
    app.get("*", () => {
      throw new Error("boom");
    });

    const response = await app.fetch(request("/api/private/overview"), {}, ctx);
    const body = (await response.json()) as { error: { code: string } };

    expect(response.status).toBe(500);
    expect(body.error.code).toBe("internal_server_error");
  });

  it("passes thrown Response values through the error boundary middleware", async () => {
    const app = createApp(errorBoundaryMiddleware(), () => {
      throw new Response("teapot", { status: 418 });
    });

    const response = await app.fetch(request("/api/private/overview"), {}, ctx);

    expect(response.status).toBe(418);
    await expect(response.text()).resolves.toBe("teapot");
  });

  it("short-circuits unsafe cross-origin requests", async () => {
    vi.mocked(requireSameOrigin).mockReturnValue(
      new Response("Forbidden", { status: 403 }),
    );
    const app = createApp(sameOriginMiddleware(), () => new Response("ok"));

    const response = await app.fetch(
      request("/api/admin/user", {
        method: "POST",
        headers: { origin: "https://evil.test" },
      }),
      createEnv(),
      ctx,
    );

    expect(response.status).toBe(403);
    await expect(response.text()).resolves.toBe("Forbidden");
  });

  it("continues same-origin middleware when the shared helper allows the request", async () => {
    const app = createApp(sameOriginMiddleware(), () => new Response("ok"));

    const response = await app.fetch(
      request("/api/admin/user", { method: "POST" }),
      createEnv(),
      ctx,
    );

    expect(response.status).toBe(200);
    await expect(response.text()).resolves.toBe("ok");
  });

  it("guards exact and grouped methods with the API v1 response shape", async () => {
    const exact = createApp(requireMethodMiddleware("POST"), () =>
      Response.json({ ok: true }),
    );
    const grouped = createApp(requireMethodsMiddleware(["GET", "HEAD"]), () =>
      Response.json({ ok: true }),
    );

    const exactResponse = await exact.fetch(
      request("/api/v1/sites", { method: "GET" }),
      createEnv(),
      ctx,
    );
    const groupedResponse = await grouped.fetch(
      request("/api/v1/sites", { method: "POST" }),
      createEnv(),
      ctx,
    );

    expect(exactResponse.status).toBe(405);
    expect(groupedResponse.status).toBe(405);
    await expect(exactResponse.json()).resolves.toMatchObject({
      error: { code: "method_not_allowed" },
    });
  });

  it("continues allowed method middleware branches", async () => {
    const exact = createApp(requireMethodMiddleware("POST"), () =>
      Response.json({ ok: true }),
    );
    const grouped = createApp(requireMethodsMiddleware(["GET", "HEAD"]), () =>
      Response.json({ ok: true }),
    );

    const exactResponse = await exact.fetch(
      request("/api/v1/sites", { method: "POST" }),
      createEnv(),
      ctx,
    );
    const groupedResponse = await grouped.fetch(
      request("/api/v1/sites", { method: "HEAD" }),
      createEnv(),
      ctx,
    );

    expect(exactResponse.status).toBe(200);
    expect(groupedResponse.status).toBe(200);
  });

  it("normalizes JSON bodies by replacing the raw request body", async () => {
    const app = createApp(
      normalizeJsonBodyMiddleware((body) => ({ ...body, added: true })),
      async (c) => Response.json(await c.req.raw.json()),
    );

    const response = await app.fetch(
      request("/api/admin/site", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "Site" }),
      }),
      createEnv(),
      ctx,
    );

    await expect(response.json()).resolves.toEqual({
      name: "Site",
      added: true,
    });
  });

  it("stores authenticated session claims", async () => {
    vi.mocked(requireSession).mockResolvedValue({
      userId: "user-1",
      username: "user",
      displayName: "User",
      systemRole: "user",
      exp: 1,
    });
    const app = createApp(requireSessionMiddleware(), (c) =>
      c.json({ userId: c.get("session")?.userId }),
    );

    const response = await app.fetch(
      request("/api/private/admin/users"),
      createEnv(),
      ctx,
    );

    await expect(response.json()).resolves.toEqual({ userId: "user-1" });
  });

  it("short-circuits missing sessions with the shared unauthorized response", async () => {
    vi.mocked(requireSession).mockResolvedValue(null);
    const app = createApp(requireSessionMiddleware(), () =>
      Response.json({ ok: true }),
    );

    const response = await app.fetch(
      request("/api/private/admin/users"),
      createEnv(),
      ctx,
    );

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "unauthorized" },
    });
  });

  it("stores API key principals and reuses the shared scope checks", async () => {
    vi.mocked(authenticateApiKey).mockResolvedValue(principal);
    const app = createApp(authenticateApiKeyMiddleware(), (c) =>
      c.json({ teamId: c.get("apiPrincipal")?.teamId }),
    );

    const response = await app.fetch(
      request("/api/v1/sites"),
      createEnv(),
      ctx,
    );

    await expect(response.json()).resolves.toEqual({ teamId: "team-1" });
  });

  it("short-circuits invalid API keys and insufficient API scopes", async () => {
    vi.mocked(authenticateApiKey).mockResolvedValueOnce(
      new Response("invalid", { status: 401 }),
    );
    const authApp = createApp(authenticateApiKeyMiddleware(), () =>
      Response.json({ ok: true }),
    );
    const deniedApp = createApp(requireApiScopeMiddleware("site:write"), () =>
      Response.json({ ok: true }),
    );

    const authResponse = await authApp.fetch(
      request("/api/v1/sites"),
      createEnv(),
      ctx,
    );
    vi.mocked(authenticateApiKey).mockResolvedValueOnce(principal);
    const deniedResponse = await deniedApp.fetch(
      request("/api/v1/sites"),
      createEnv(),
      ctx,
    );

    expect(authResponse.status).toBe(401);
    await expect(authResponse.text()).resolves.toBe("invalid");
    expect(deniedResponse.status).toBe(403);
    await expect(deniedResponse.json()).resolves.toMatchObject({
      error: { code: "insufficient_scope" },
    });
  });

  it("continues API scope middleware when a principal is already available", async () => {
    const app = new Hono<AppEnv>();
    app.use("*", async (c, next) => {
      c.set("apiPrincipal", principal);
      await next();
    });
    app.use("*", requireApiScopeMiddleware("analytics:read"));
    app.get("*", (c) => c.json({ teamId: c.get("apiPrincipal")?.teamId }));

    const response = await app.fetch(
      request("/api/v1/sites"),
      createEnv(),
      ctx,
    );

    await expect(response.json()).resolves.toEqual({ teamId: "team-1" });
  });

  it("resolves private, public, and API site context", async () => {
    vi.mocked(resolvePrivateSite).mockResolvedValue({
      id: "private-site",
      name: "Private Site",
      domain: "app.test",
    });
    vi.mocked(fetchPublicSite).mockResolvedValue({
      id: "public-site",
      name: "Public Site",
      domain: "app.test",
    });

    const privateApp = createApp(resolvePrivateSiteMiddleware(), (c) =>
      c.json({ id: c.get("privateSite")?.id }),
    );
    const publicApp = new Hono<AppEnv>();
    publicApp.use("/:slug/*", resolvePublicSiteMiddleware());
    publicApp.get("/:slug/site", (c) =>
      c.json({ slug: c.get("publicSite")?.slug }),
    );
    const apiApp = new Hono<AppEnv>();
    apiApp.use("*", async (c, next) => {
      c.set("apiPrincipal", principal);
      await next();
    });
    apiApp.use("/sites/:siteId/*", resolveApiSiteMiddleware());
    apiApp.get("/sites/:siteId/overview", (c) =>
      c.json({ id: c.get("apiSite")?.id }),
    );

    const privateResponse = await privateApp.fetch(
      request("/api/private/overview"),
      createEnv(),
      ctx,
    );
    const publicResponse = await publicApp.fetch(
      request("/demo/site"),
      createEnv(),
      ctx,
    );
    const apiResponse = await apiApp.fetch(
      request("/sites/site-1/overview"),
      createEnv({
        id: "site-1",
        teamId: "team-1",
        name: "API Site",
        domain: "api.test",
        publicEnabled: 0,
        publicSlug: null,
        createdAt: 1,
        updatedAt: 2,
      }),
      ctx,
    );

    await expect(privateResponse.json()).resolves.toEqual({
      id: "private-site",
    });
    await expect(publicResponse.json()).resolves.toEqual({ slug: "demo" });
    await expect(apiResponse.json()).resolves.toEqual({ id: "site-1" });
  });

  it("passes through site resolver response failures", async () => {
    vi.mocked(resolvePrivateSite).mockResolvedValueOnce(
      new Response("private-denied", { status: 403 }),
    );
    vi.mocked(fetchPublicSite).mockResolvedValueOnce(
      new Response("public-missing", { status: 404 }),
    );
    const privateApp = createApp(resolvePrivateSiteMiddleware(), () =>
      Response.json({ ok: true }),
    );
    const publicApp = createApp(resolvePublicSiteMiddleware(), () =>
      Response.json({ ok: true }),
    );

    const privateResponse = await privateApp.fetch(
      request("/api/private/overview"),
      createEnv(),
      ctx,
    );
    const publicResponse = await publicApp.fetch(
      request("/demo/site"),
      createEnv(),
      ctx,
    );

    expect(privateResponse.status).toBe(403);
    await expect(privateResponse.text()).resolves.toBe("private-denied");
    expect(publicResponse.status).toBe(404);
    await expect(publicResponse.text()).resolves.toBe("public-missing");
  });

  it("returns not found when API site context is absent or inaccessible", async () => {
    const app = new Hono<AppEnv>();
    app.use("/sites/:siteId/*", resolveApiSiteMiddleware());
    app.get("/sites/:siteId/overview", () => Response.json({ ok: true }));

    const response = await app.fetch(
      request("/sites/site-1/overview"),
      createEnv(),
      ctx,
    );

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "site_not_found" },
    });
  });

  it("returns not found when API site lookup misses", async () => {
    const app = new Hono<AppEnv>();
    app.use("*", async (c, next) => {
      c.set("apiPrincipal", principal);
      await next();
    });
    app.use("/sites/:siteId/*", resolveApiSiteMiddleware());
    app.get("/sites/:siteId/overview", () => Response.json({ ok: true }));

    const response = await app.fetch(
      request("/sites/site-1/overview"),
      createEnv(null),
      ctx,
    );

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "site_not_found" },
    });
  });

  it("wraps responses with dashboard cache middleware", async () => {
    const app = createApp(
      dashboardCacheMiddleware({ ttlSeconds: 30 }),
      () => new Response("cached"),
    );

    const response = await app.fetch(
      request("/api/private/overview"),
      createEnv(),
      ctx,
    );

    await expect(response.text()).resolves.toBe("cached");
    expect(withDashboardCache).toHaveBeenCalledWith(
      ctx,
      new URL("https://app.test/api/private/overview"),
      expect.any(Function),
      { ttlSeconds: 30 },
    );
  });
});
