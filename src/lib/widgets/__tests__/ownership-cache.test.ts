// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Env } from "@/lib/edge/types";
import {
  cachedWidgetSiteBelongsToTeam,
  clearWidgetOwnershipMemo,
} from "@/lib/widgets/ownership-cache";
import { widgetSiteBelongsToTeam } from "@/lib/widgets/store";

vi.mock("@/lib/widgets/store", () => ({
  widgetSiteBelongsToTeam: vi.fn(),
}));

const env = {} as Env;

function fakeEdgeCache() {
  const entries = new Map<string, string>();
  const cache = {
    match: vi.fn(async (request: Request) => {
      const body = entries.get(request.url);
      return body === undefined ? undefined : new Response(body);
    }),
    put: vi.fn(async (request: Request, response: Response) => {
      expect(response.headers.get("cache-control")).toBe("max-age=60");
      entries.set(request.url, await response.text());
    }),
  };
  vi.stubGlobal("caches", { open: vi.fn(async () => cache) });
  return cache;
}

describe("public widget ownership cache", () => {
  beforeEach(() => {
    clearWidgetOwnershipMemo();
    vi.mocked(widgetSiteBelongsToTeam).mockReset();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("reuses an isolate result until it expires", async () => {
    vi.useFakeTimers();
    vi.mocked(widgetSiteBelongsToTeam).mockResolvedValue(true);
    expect(await cachedWidgetSiteBelongsToTeam(env, "team", "site")).toBe(true);
    expect(await cachedWidgetSiteBelongsToTeam(env, "team", "site")).toBe(true);
    expect(widgetSiteBelongsToTeam).toHaveBeenCalledTimes(1);

    vi.mocked(widgetSiteBelongsToTeam).mockResolvedValue(false);
    vi.advanceTimersByTime(15_001);
    expect(await cachedWidgetSiteBelongsToTeam(env, "team", "site")).toBe(
      false,
    );
    expect(widgetSiteBelongsToTeam).toHaveBeenCalledTimes(2);
  });

  it("keys results by both team and site", async () => {
    vi.mocked(widgetSiteBelongsToTeam).mockImplementation(
      async (_env, teamId) => teamId === "owner",
    );
    expect(await cachedWidgetSiteBelongsToTeam(env, "owner", "site")).toBe(
      true,
    );
    expect(await cachedWidgetSiteBelongsToTeam(env, "other", "site")).toBe(
      false,
    );
  });

  it("never caches a D1 failure", async () => {
    vi.mocked(widgetSiteBelongsToTeam)
      .mockRejectedValueOnce(new Error("D1 unavailable"))
      .mockResolvedValueOnce(true);
    await expect(
      cachedWidgetSiteBelongsToTeam(env, "team", "site"),
    ).rejects.toThrow("D1 unavailable");
    expect(await cachedWidgetSiteBelongsToTeam(env, "team", "site")).toBe(true);
  });

  it("shares results through the edge cache across isolates", async () => {
    const cache = fakeEdgeCache();
    const waitUntil = vi.fn();
    vi.mocked(widgetSiteBelongsToTeam).mockResolvedValue(false);
    expect(
      await cachedWidgetSiteBelongsToTeam(env, "team", "site", { waitUntil }),
    ).toBe(false);
    expect(waitUntil).toHaveBeenCalledTimes(1);
    await waitUntil.mock.calls[0]![0];

    // A fresh isolate has no memo but finds the edge entry.
    clearWidgetOwnershipMemo();
    expect(await cachedWidgetSiteBelongsToTeam(env, "team", "site")).toBe(
      false,
    );
    expect(widgetSiteBelongsToTeam).toHaveBeenCalledTimes(1);
    expect(cache.match).toHaveBeenCalledTimes(2);
  });

  it("falls back to D1 when the edge cache is unusable", async () => {
    vi.stubGlobal("caches", {
      open: vi.fn(async () => {
        throw new Error("no cache");
      }),
    });
    vi.mocked(widgetSiteBelongsToTeam).mockResolvedValue(true);
    expect(await cachedWidgetSiteBelongsToTeam(env, "team", "site")).toBe(true);
  });
});

describe("public widget ownership cache resilience", () => {
  beforeEach(() => {
    clearWidgetOwnershipMemo();
    vi.mocked(widgetSiteBelongsToTeam).mockReset();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("evicts the oldest isolate entry once the memo is full", async () => {
    vi.mocked(widgetSiteBelongsToTeam).mockResolvedValue(true);
    for (let index = 0; index <= 512; index += 1) {
      await cachedWidgetSiteBelongsToTeam(env, "team", `site-${index}`);
    }
    expect(widgetSiteBelongsToTeam).toHaveBeenCalledTimes(513);
    // The newest entry is still memoized, the first one was evicted.
    await cachedWidgetSiteBelongsToTeam(env, "team", "site-512");
    expect(widgetSiteBelongsToTeam).toHaveBeenCalledTimes(513);
    await cachedWidgetSiteBelongsToTeam(env, "team", "site-0");
    expect(widgetSiteBelongsToTeam).toHaveBeenCalledTimes(514);
  });

  it("ignores edge cache read, body and write failures", async () => {
    const broken = {
      match: vi
        .fn()
        .mockRejectedValueOnce(new Error("match failed"))
        .mockResolvedValueOnce({
          text: () => Promise.reject(new Error("body failed")),
        })
        .mockResolvedValueOnce(new Response("unexpected")),
      put: vi.fn(() => Promise.reject(new Error("put failed"))),
    };
    vi.stubGlobal("caches", { open: vi.fn(async () => broken) });
    vi.mocked(widgetSiteBelongsToTeam).mockResolvedValue(true);
    for (let attempt = 0; attempt < 3; attempt += 1) {
      clearWidgetOwnershipMemo();
      expect(await cachedWidgetSiteBelongsToTeam(env, "team", "site")).toBe(
        true,
      );
    }
    expect(widgetSiteBelongsToTeam).toHaveBeenCalledTimes(3);
    expect(broken.put).toHaveBeenCalledTimes(3);
  });
});
