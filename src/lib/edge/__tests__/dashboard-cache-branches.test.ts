import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { withDashboardCache } from "@/lib/edge/analytics/composition/dashboard-cache";

describe("dashboard cache low branch coverage", () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("falls back to generation when the global cache storage is null", async () => {
    vi.stubGlobal("caches", null);
    const generate = vi.fn(async () => new Response("fresh"));

    const response = await withDashboardCache(
      undefined,
      new URL("https://edge.test/query"),
      generate,
    );

    expect(await response.text()).toBe("fresh");
    expect(generate).toHaveBeenCalledTimes(1);
  });

  it("floors fractional TTLs and preserves cached response status metadata", async () => {
    const match = vi.fn(
      async (_request: Request) => new Response("cached", { status: 202 }),
    );
    vi.stubGlobal("caches", {
      open: vi.fn(async () => ({ match, put: vi.fn() })),
    });

    const response = await withDashboardCache(
      undefined,
      new URL("https://edge.test/query?b=2&a=1"),
      vi.fn(),
      { ttlSeconds: 5.9 },
    );

    expect(response.status).toBe(202);
    expect(await response.text()).toBe("cached");
    expect(response.headers.get("x-edge-cache")).toBe("HIT");
    expect(response.headers.get("cache-control")).toBe("private, max-age=5");
    expect(match.mock.calls[0]![0].url).toBe("https://edge.test/query?a=1&b=2");
  });

  it("returns successful misses even when asynchronous cache writes fail", async () => {
    const put = vi.fn(async () => {
      throw new Error("write failed");
    });
    vi.stubGlobal("caches", {
      open: vi.fn(async () => ({
        match: vi.fn(async () => undefined),
        put,
      })),
    });

    const response = await withDashboardCache(
      undefined,
      new URL("https://edge.test/query"),
      vi.fn(async () => new Response("fresh")),
      { ttlSeconds: 2 },
    );

    expect(response.headers.get("x-edge-cache")).toBe("MISS");
    expect(response.headers.get("cache-control")).toBe("private, max-age=2");
    expect(await response.text()).toBe("fresh");
    expect(put).toHaveBeenCalledTimes(1);
  });
});
