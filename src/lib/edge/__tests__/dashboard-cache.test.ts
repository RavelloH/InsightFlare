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
      "https://analytics-cache.insightflare.internal/analytics/v2-analytics-filter-v3/private/site-1/shared/overview?from=1&to=2",
    );
  });

  it("uses the semantic filter fingerprint instead of filter URL ordering", async () => {
    const match = vi.fn().mockResolvedValue(undefined);
    const put = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("caches", {
      open: vi.fn().mockResolvedValue({ match, put }),
    });
    const identity = {
      scope: "private" as const,
      tenantId: "site-1",
      route: "overview",
    };

    await withDashboardCache(
      undefined,
      new URL(
        "https://example.test/api/private/overview?filter[geo.country]=in:US,JP",
      ),
      vi.fn().mockResolvedValue(new Response("fresh")),
      { identity },
    );
    await withDashboardCache(
      undefined,
      new URL(
        "https://example.test/api/private/overview?filter[geo.country]=in:JP,US",
      ),
      vi.fn().mockResolvedValue(new Response("fresh")),
      { identity },
    );

    expect((match.mock.calls[0]![0] as Request).url).toBe(
      (match.mock.calls[1]![0] as Request).url,
    );
  });

  it("keeps invalid filter parameters in the cache key", async () => {
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
        "https://example.test/api/private/overview?filter[unknown]=value",
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

    expect((match.mock.calls[0]![0] as Request).url).toContain(
      "filter%5Bunknown%5D=value",
    );
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
