import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  executeDemoQuery,
  executeDemoQueryPayload,
} from "@/lib/edge/query-runtime/demo-query";
import {
  DEMO_SITE_PROFILES,
  demoSitePublicSlug,
} from "@/lib/realtime/demo-site-profiles";
import type * as DemoMockModule from "@/lib/realtime/mock";
import { handleDemoRequest } from "@/lib/realtime/mock";
import { demoBadRequest, demoNotFound } from "@/lib/realtime/mock/envelope";

vi.mock("@/lib/realtime/mock", async (importOriginal) => {
  const actual = await importOriginal<typeof DemoMockModule>();
  return { ...actual, handleDemoRequest: vi.fn() };
});

const handleDemoRequestMock = vi.mocked(handleDemoRequest);

function request(path: string, init?: RequestInit): Request {
  return new Request(`https://app.test${path}`, init);
}

describe("server demo query runtime", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("passes the API pathname and resolved site id to the demo generator", async () => {
    handleDemoRequestMock.mockReturnValue({
      ok: true,
      requestId: "demo-request",
      timestamp: "2026-08-22T00:00:00.000Z",
      data: { views: 12 },
    });

    const response = await executeDemoQuery({
      request: request("/api/private/overview?siteId=attacker-site&range=7d"),
      url: new URL(
        "https://app.test/api/private/overview?siteId=attacker-site&range=7d",
      ),
      siteId: "demo-site-001",
      context: { requestId: "adapter-request" },
    });

    expect(response.status).toBe(200);
    const payload = (await response.json()) as {
      timestamp: string;
      requestId: string;
    };
    expect(payload).toMatchObject({
      ok: true,
      data: { views: 12 },
      requestId: "adapter-request",
    });
    expect(payload.timestamp).not.toBe("2026-08-22T00:00:00.000Z");
    expect(handleDemoRequestMock).toHaveBeenCalledWith({
      path: "/api/private/overview",
      method: "GET",
      params: { siteId: "demo-site-001", range: "7d" },
      body: undefined,
    });
    expect(response.headers.get("content-type")).toContain("application/json");
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(response.headers.get("x-insightflare-data-source")).toBe("mock");
  });

  it("exposes the demo response as a typed-provider payload", async () => {
    handleDemoRequestMock.mockReturnValue({
      ok: true,
      requestId: "demo-request",
      timestamp: "2026-08-22T00:00:00.000Z",
      data: { views: 12 },
    });

    await expect(
      executeDemoQueryPayload({
        request: request("/api/private/overview"),
        url: new URL("https://app.test/api/private/overview"),
        siteId: "demo-site-001",
      }),
    ).resolves.toMatchObject({
      status: 200,
      payload: expect.objectContaining({ data: { views: 12 } }),
    });
  });

  it("clones JSON bodies for funnel and saved-filter mutations", async () => {
    handleDemoRequestMock.mockReturnValue({
      ok: true,
      requestId: "demo-request",
      timestamp: "2026-08-22T00:00:00.000Z",
      data: { created: true },
    });
    const body = {
      name: "Signup",
      steps: [{ type: "pageview", value: "/" }],
    };
    const mutationRequest = request("/api/private/funnels?siteId=ignored", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });

    const response = await executeDemoQuery({
      request: mutationRequest,
      url: new URL("https://app.test/api/private/funnels?siteId=ignored"),
      siteId: "demo-site-002",
    });

    expect(response.status).toBe(201);
    const deleteResponse = await executeDemoQuery({
      request: request(
        "/api/private/funnels?siteId=demo-site-002&id=demo-funnel",
        {
          method: "DELETE",
        },
      ),
      url: new URL(
        "https://app.test/api/private/funnels?siteId=demo-site-002&id=demo-funnel",
      ),
      siteId: "demo-site-002",
    });
    expect(deleteResponse.status).toBe(200);
    expect(handleDemoRequestMock).toHaveBeenCalledWith({
      path: "/api/private/funnels",
      method: "POST",
      params: { siteId: "demo-site-002" },
      body,
    });
  });

  it("preserves the saved-filter collection POST status of 201", async () => {
    handleDemoRequestMock.mockReturnValue({
      filters: [],
    });

    const response = await executeDemoQuery({
      request: request("/api/private/saved-filters?siteId=demo-site-001", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name: "Learners",
          description: "Demo filter",
          visibility: "private",
          filterDsl: 'page.path eq "/pricing"',
        }),
      }),
      url: new URL(
        "https://app.test/api/private/saved-filters?siteId=demo-site-001",
      ),
      siteId: "demo-site-001",
    });

    expect(response.status).toBe(201);
  });

  it("returns 405 for unsupported saved-filter methods", async () => {
    const response = await executeDemoQuery({
      request: request("/api/private/saved-filters?siteId=demo-site-001", {
        method: "PATCH",
      }),
      url: new URL(
        "https://app.test/api/private/saved-filters?siteId=demo-site-001",
      ),
      siteId: "demo-site-001",
      context: { requestId: "unsupported-method-request" },
    });

    expect(response.status).toBe(405);
    expect(await response.json()).toMatchObject({
      ok: false,
      requestId: "unsupported-method-request",
      error: {
        code: "method_not_allowed",
        message: "Method Not Allowed",
      },
    });
    expect(handleDemoRequestMock).not.toHaveBeenCalled();
  });

  it("returns a standard 400 for invalid funnel JSON bodies", async () => {
    handleDemoRequestMock.mockReturnValue({
      ok: true,
      requestId: "should-not-be-used",
      timestamp: "2026-08-22T00:00:00.000Z",
      data: {},
    });

    const response = await executeDemoQuery({
      request: request("/api/private/funnels?siteId=demo-site-001", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{not-json",
      }),
      url: new URL("https://app.test/api/private/funnels?siteId=demo-site-001"),
      siteId: "demo-site-001",
      context: { requestId: "invalid-json-request" },
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      ok: false,
      requestId: "invalid-json-request",
      error: { code: "invalid_json_body", message: "Invalid JSON body" },
    });
    expect(handleDemoRequestMock).not.toHaveBeenCalled();
  });

  it("keeps saved-filter invalid JSON semantics delegated to the generator", async () => {
    handleDemoRequestMock.mockReturnValue({
      ok: false,
      requestId: "generator-request",
      timestamp: "2026-08-22T00:00:00.000Z",
      error: { code: "name_is_required", message: "name is required" },
    });

    const response = await executeDemoQuery({
      request: request("/api/private/saved-filters?siteId=demo-site-001", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{not-json",
      }),
      url: new URL(
        "https://app.test/api/private/saved-filters?siteId=demo-site-001",
      ),
      siteId: "demo-site-001",
      context: { requestId: "saved-filter-request" },
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      requestId: "saved-filter-request",
      error: { code: "name_is_required", message: "name is required" },
    });
    expect(handleDemoRequestMock).toHaveBeenCalledWith(
      expect.objectContaining({ body: undefined }),
    );
  });

  it("maps demo not-found and validation envelopes to HTTP errors", async () => {
    handleDemoRequestMock.mockReturnValueOnce(demoNotFound("Missing"));
    const notFound = await executeDemoQuery({
      request: request("/api/private/funnels?siteId=demo-site-001&id=missing"),
      url: new URL(
        "https://app.test/api/private/funnels?siteId=demo-site-001&id=missing",
      ),
      siteId: "demo-site-001",
    });
    expect(notFound.status).toBe(404);
    expect(
      (await notFound.json()) as { error: { code: string } },
    ).toMatchObject({ error: { code: "not_found" } });

    handleDemoRequestMock.mockReturnValueOnce(demoBadRequest("Name required"));
    const badRequest = await executeDemoQuery({
      request: request("/api/private/funnels?siteId=demo-site-001"),
      url: new URL("https://app.test/api/private/funnels?siteId=demo-site-001"),
      siteId: "demo-site-001",
    });
    expect(badRequest.status).toBe(400);
  });

  it("returns a public response with public cache headers and 500 on exceptions", async () => {
    handleDemoRequestMock.mockImplementationOnce(() => {
      throw new Error("generator failed");
    });

    const response = await executeDemoQuery({
      request: request("/api/public/share/demo/overview"),
      url: new URL("https://app.test/api/public/share/demo/overview"),
      siteId: "demo-site-001",
      publicQuery: true,
    });

    expect(response.status).toBe(500);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(response.headers.get("access-control-allow-origin")).toBeNull();
    expect(response.headers.get("x-insightflare-data-source")).toBe("mock");
    expect(await response.json()).toMatchObject({
      ok: false,
      error: { code: "internal_error", message: "generator failed" },
    });
  });

  it("keeps public cache and CORS headers on successful query responses", async () => {
    handleDemoRequestMock.mockReturnValue({
      ok: true,
      requestId: "generator-request",
      timestamp: "2026-08-22T00:00:00.000Z",
      data: { views: 12 },
    });

    const response = await executeDemoQuery({
      request: request("/api/public/share/demo/overview"),
      url: new URL("https://app.test/api/public/share/demo/overview"),
      siteId: "demo-site-001",
      publicQuery: true,
      context: { requestId: "public-request" },
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe(
      "public, max-age=300, s-maxage=300",
    );
    expect(response.headers.get("access-control-allow-origin")).toBe("*");
    expect(response.headers.get("x-insightflare-data-source")).toBe("mock");
  });

  it("keeps non-public query paths outside the demo public runtime", async () => {
    vi.stubEnv("VITE_DEMO_MODE", "1");
    vi.resetModules();
    const { executePublicQuery } =
      await import("@/lib/edge/query-adapters/public");

    for (const pathname of [
      "page-query",
      "page-hash",
      "devices",
      "overview-source-link",
    ]) {
      const url = new URL(`https://app.test/api/public/share/demo/${pathname}`);
      const response = await executePublicQuery({
        env: {} as never,
        siteId: "demo-site-001",
        pathname,
        url,
        request: new Request(url),
      });
      expect(response.status, pathname).toBe(404);
    }

    expect(handleDemoRequestMock).not.toHaveBeenCalled();
  });

  it("resolves demo private/public sites without touching D1", async () => {
    vi.stubEnv("VITE_DEMO_MODE", "1");
    vi.resetModules();
    const { fetchPublicSite, resolvePrivateSiteForSession } =
      await import("@/lib/edge/query/core-sites");
    const prepare = vi.fn(() => {
      throw new Error("D1 must not be used in demo site resolution");
    });
    const env = { DB: { prepare } } as never;
    const session = {
      userId: "demo-user-001",
      username: "demo",
      displayName: "Demo User",
      systemRole: "user" as const,
      exp: Number.MAX_SAFE_INTEGER,
    };
    const profile = DEMO_SITE_PROFILES[0]!;

    await expect(
      resolvePrivateSiteForSession(
        request("/api/private/overview?siteId=demo-site-001"),
        env,
        new URL("https://app.test/api/private/overview?siteId=demo-site-001"),
        session,
      ),
    ).resolves.toMatchObject({ id: profile.id });
    await expect(
      fetchPublicSite(
        env,
        new URL(
          `https://app.test/api/public/share/${demoSitePublicSlug(profile)}/overview`,
        ),
      ),
    ).resolves.toMatchObject({ id: profile.id });

    const privateMissing = await resolvePrivateSiteForSession(
      request("/api/private/overview?siteId=not-a-demo-site"),
      env,
      new URL("https://app.test/api/private/overview?siteId=not-a-demo-site"),
      session,
    );
    const publicMissing = await fetchPublicSite(
      env,
      new URL("https://app.test/api/public/share/not-a-demo-site/overview"),
    );
    expect(privateMissing).toBeInstanceOf(Response);
    expect((privateMissing as Response).status).toBe(404);
    expect(publicMissing).toBeInstanceOf(Response);
    expect((publicMissing as Response).status).toBe(404);
    expect(prepare).not.toHaveBeenCalled();
  });
});
