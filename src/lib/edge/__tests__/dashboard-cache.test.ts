import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  PUBLIC_QUERY_CACHE_OPTIONS,
  withDashboardCache,
} from "@/lib/edge/dashboard-cache";

describe("edge dashboard cache wrapper", () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("generates directly when Cache API is unavailable", async () => {
    const generate = vi.fn().mockResolvedValue(new Response("fresh"));

    const response = await withDashboardCache(
      undefined,
      new URL("https://example.test/api?b=2&a=1"),
      generate,
    );

    expect(await response.text()).toBe("fresh");
    expect(generate).toHaveBeenCalledTimes(1);
  });

  it("adds public cache headers on bypass when requested", async () => {
    const generate = vi.fn().mockResolvedValue(new Response("fresh"));

    const response = await withDashboardCache(
      undefined,
      new URL("https://example.test/api/public/site/overview"),
      generate,
      PUBLIC_QUERY_CACHE_OPTIONS,
    );

    expect(await response.text()).toBe("fresh");
    expect(response.headers.get("cache-control")).toBe(
      "public, max-age=300, s-maxage=300",
    );
    expect(response.headers.get("x-edge-cache")).toBeNull();
  });

  it("does not read or write Cache API for a server-controlled bypass", async () => {
    const match = vi.fn();
    const put = vi.fn();
    vi.stubGlobal("caches", {
      open: vi.fn().mockResolvedValue({ match, put }),
    });
    const generate = vi.fn().mockResolvedValue(new Response("fresh"));

    const response = await withDashboardCache(
      undefined,
      new URL("https://example.test/api/private/v2/cursor"),
      generate,
      { bypassCache: true },
    );

    expect(await response.text()).toBe("fresh");
    expect(generate).toHaveBeenCalledTimes(1);
    expect(match).not.toHaveBeenCalled();
    expect(put).not.toHaveBeenCalled();
  });

  it("does not infer bypass from a client request header", async () => {
    const match = vi.fn().mockResolvedValue(new Response("cached"));
    const put = vi.fn();
    vi.stubGlobal("caches", {
      open: vi.fn().mockResolvedValue({ match, put }),
    });

    const response = await withDashboardCache(
      undefined,
      new URL("https://example.test/api/private/v2/cursor"),
      vi.fn().mockResolvedValue(new Response("fresh")),
      {
        request: new Request("https://example.test/api/private/v2/cursor", {
          headers: { "x-insightflare-cache-bypass": "true" },
        }),
      },
    );

    expect(await response.text()).toBe("cached");
    expect(match).toHaveBeenCalledTimes(1);
    expect(put).not.toHaveBeenCalled();
  });

  it("returns cached responses with HIT headers when a cache entry exists", async () => {
    const match = vi
      .fn()
      .mockResolvedValue(
        new Response("cached", { headers: { vary: "authorization" } }),
      );
    const put = vi.fn();
    vi.stubGlobal("caches", {
      open: vi.fn().mockResolvedValue({ match, put }),
    });

    const response = await withDashboardCache(
      undefined,
      new URL("https://example.test/api?b=2&a=1"),
      vi.fn(),
      { ttlSeconds: 30 },
    );

    expect(await response.text()).toBe("cached");
    expect(response.headers.get("x-edge-cache")).toBe("HIT");
    expect(response.headers.get("cache-control")).toBe("private, max-age=30");
    expect(response.headers.has("vary")).toBe(false);
    expect(match).toHaveBeenCalledTimes(1);
    expect((match.mock.calls[0]![0] as Request).url).toBe(
      "https://example.test/api?a=1&b=2",
    );
    expect(put).not.toHaveBeenCalled();
  });

  it("uses a tenant-scoped synthetic key and omits siteId from its query", async () => {
    const match = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("caches", {
      open: vi.fn().mockResolvedValue({
        match,
        put: vi.fn().mockResolvedValue(undefined),
      }),
    });

    await withDashboardCache(
      undefined,
      new URL(
        "https://example.test/api/private/overview?siteId=site-1&to=2&from=1",
      ),
      vi.fn().mockResolvedValue(new Response("fresh")),
      {
        identity: {
          scope: "private",
          tenantId: "site-1",
          route: "overview",
        },
      },
    );

    expect((match.mock.calls[0]![0] as Request).url).toBe(
      "https://analytics-cache.insightflare.internal/analytics/v2/legacy/private/site-1/shared/overview?from=1&to=2",
    );
  });

  it("isolates cache generations without changing public/private key scopes", async () => {
    const entries = new Map<string, Response>();
    const match = vi.fn(async (request: Request) =>
      entries.get(request.url)?.clone(),
    );
    const put = vi.fn(async (request: Request, response: Response) => {
      entries.set(request.url, response.clone());
    });
    vi.stubGlobal("caches", {
      open: vi.fn().mockResolvedValue({ match, put }),
    });

    const url = new URL(
      "https://example.test/api/query?siteId=site-1&from=1&to=2",
    );
    const privateIdentity = {
      scope: "private" as const,
      tenantId: "site-1",
      route: "overview",
    };
    const publicIdentity = {
      scope: "public" as const,
      tenantId: "site-1",
      route: "overview",
    };
    const firstGenerate = vi.fn().mockResolvedValue(new Response("first"));
    const secondGenerate = vi.fn().mockResolvedValue(new Response("second"));
    const publicGenerate = vi.fn().mockResolvedValue(new Response("public"));

    await withDashboardCache(undefined, url, firstGenerate, {
      identity: privateIdentity,
      cacheGeneration: "generation-a",
    });
    const second = await withDashboardCache(undefined, url, secondGenerate, {
      identity: privateIdentity,
      cacheGeneration: "generation-b",
    });
    await withDashboardCache(undefined, url, publicGenerate, {
      identity: publicIdentity,
      cacheGeneration: "generation-a",
    });
    const sameGeneration = await withDashboardCache(
      undefined,
      url,
      vi.fn().mockResolvedValue(new Response("unexpected")),
      {
        identity: privateIdentity,
        cacheGeneration: "generation-a",
      },
    );

    await expect(second.text()).resolves.toBe("second");
    await expect(sameGeneration.text()).resolves.toBe("first");
    expect(firstGenerate).toHaveBeenCalledTimes(1);
    expect(secondGenerate).toHaveBeenCalledTimes(1);
    expect(publicGenerate).toHaveBeenCalledTimes(1);
    expect([...entries.keys()]).toEqual([
      "https://analytics-cache.insightflare.internal/analytics/v2/generation-a/private/site-1/shared/overview?from=1&to=2",
      "https://analytics-cache.insightflare.internal/analytics/v2/generation-b/private/site-1/shared/overview?from=1&to=2",
      "https://analytics-cache.insightflare.internal/analytics/v2/generation-a/public/site-1/shared/overview?from=1&to=2",
    ]);
  });

  it("refreshes request metadata instead of replaying it from a cache entry", async () => {
    const cached = new Response(
      JSON.stringify({ ok: true, data: { views: 2 } }),
      {
        headers: {
          "content-type": "application/json",
          "x-insightflare-cache-had-dynamic-fields": "1",
          "x-insightflare-cache-created-at": String(Date.now() - 2_000),
          "x-insightflare-d1-rows-read": "42",
        },
      },
    );
    vi.stubGlobal("caches", {
      open: vi.fn().mockResolvedValue({
        match: vi.fn().mockResolvedValue(cached),
        put: vi.fn(),
      }),
    });

    const response = await withDashboardCache(
      undefined,
      new URL("https://example.test/api/private/overview"),
      vi.fn(),
      {
        request: new Request("https://example.test/api/private/overview", {
          headers: { "x-request-id": "current-request" },
        }),
      },
    );

    await expect(response.json()).resolves.toMatchObject({
      ok: true,
      requestId: "current-request",
    });
    expect(response.headers.get("x-insightflare-d1-rows-read")).toBe("0");
    expect(response.headers.get("x-insightflare-cached-d1-rows-read")).toBe(
      "42",
    );
    expect(response.headers.get("x-insightflare-cache-age")).toBe("2");
  });

  it("stores successful misses and marks returned responses as MISS", async () => {
    const match = vi.fn().mockResolvedValue(undefined);
    const put = vi.fn().mockResolvedValue(undefined);
    const waitUntil = vi.fn();
    vi.stubGlobal("caches", {
      open: vi.fn().mockResolvedValue({ match, put }),
    });
    const generate = vi
      .fn()
      .mockResolvedValue(new Response("fresh", { status: 200 }));

    const response = await withDashboardCache(
      { waitUntil } as unknown as ExecutionContext,
      new URL("https://example.test/api?z=9&a=1"),
      generate,
      { ttlSeconds: 0 },
    );

    expect(await response.text()).toBe("fresh");
    expect(response.headers.get("x-edge-cache")).toBe("MISS");
    expect(response.headers.get("cache-control")).toBe("private, max-age=1");
    expect(generate).toHaveBeenCalledTimes(1);
    expect(put).toHaveBeenCalledTimes(1);
    expect((put.mock.calls[0]![0] as Request).url).toBe(
      "https://example.test/api?a=1&z=9",
    );
    expect(
      (put.mock.calls[0]![1] as Response).headers.get("cache-control"),
    ).toBe("public, max-age=1, s-maxage=1");
    expect(waitUntil).toHaveBeenCalledTimes(1);
  });

  it("stores canonical JSON without request-specific metadata", async () => {
    const match = vi.fn().mockResolvedValue(undefined);
    const put = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("caches", {
      open: vi.fn().mockResolvedValue({ match, put }),
    });
    const response = await withDashboardCache(
      undefined,
      new URL("https://example.test/api/private/overview"),
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            ok: true,
            data: { views: 2 },
            requestId: "first-request",
            timestamp: "2026-08-12T00:00:00.000Z",
          }),
          { headers: { "content-type": "application/json" } },
        ),
      ),
      {
        request: new Request("https://example.test/api/private/overview", {
          headers: { "x-request-id": "first-request" },
        }),
      },
    );

    await expect(response.json()).resolves.toMatchObject({
      requestId: "first-request",
    });
    const cached = put.mock.calls[0]![1] as Response;
    await expect(cached.clone().json()).resolves.toEqual({
      ok: true,
      data: { views: 2 },
    });
    expect(cached.headers.get("x-insightflare-cache-had-dynamic-fields")).toBe(
      "1",
    );
  });

  it("does not cache non-OK responses and tolerates cache failures", async () => {
    const put = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("caches", {
      open: vi.fn().mockResolvedValue({
        match: vi.fn().mockRejectedValue(new Error("read failed")),
        put,
      }),
    });
    const generate = vi
      .fn()
      .mockResolvedValue(new Response("nope", { status: 500 }));

    const response = await withDashboardCache(
      undefined,
      new URL("https://example.test/api"),
      generate,
    );

    expect(response.status).toBe(500);
    expect(await response.text()).toBe("nope");
    expect(response.headers.get("x-edge-cache")).toBeNull();
    expect(put).not.toHaveBeenCalled();
  });
});
