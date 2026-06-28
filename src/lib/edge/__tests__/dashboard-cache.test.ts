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
    expect(response.headers.get("cache-control")).toBe(
      "public, max-age=30, s-maxage=30",
    );
    expect(response.headers.has("vary")).toBe(false);
    expect(match).toHaveBeenCalledTimes(1);
    expect((match.mock.calls[0]![0] as Request).url).toBe(
      "https://example.test/api?a=1&b=2",
    );
    expect(put).not.toHaveBeenCalled();
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
    expect(response.headers.get("cache-control")).toBe(
      "public, max-age=1, s-maxage=1",
    );
    expect(generate).toHaveBeenCalledTimes(1);
    expect(put).toHaveBeenCalledTimes(1);
    expect((put.mock.calls[0]![0] as Request).url).toBe(
      "https://example.test/api?a=1&z=9",
    );
    expect(waitUntil).toHaveBeenCalledTimes(1);
  });

  it("does not cache non-OK responses and tolerates cache failures", async () => {
    vi.stubGlobal("caches", {
      open: vi.fn().mockResolvedValue({
        match: vi.fn().mockRejectedValue(new Error("read failed")),
        put: vi.fn().mockResolvedValue(undefined),
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
  });
});
