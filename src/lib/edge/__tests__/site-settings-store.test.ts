import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  deleteSiteScriptSettings,
  normalizeSiteSettingsKey,
  readSiteScriptSettings,
  readSiteTrackingConfig,
  upsertSiteScriptSettings,
  upsertSiteTrackingConfig,
} from "@/lib/edge/site-settings-store";
import type { Env } from "@/lib/edge/types";

function envWithKv(kv: Partial<KVNamespace>): Env {
  return { SITE_SETTINGS_KV: kv as KVNamespace } as Env;
}

function cacheWithResponse(response: Response | null = null) {
  return {
    match: vi.fn().mockResolvedValue(response),
    put: vi.fn().mockResolvedValue(undefined),
    delete: vi.fn().mockResolvedValue(true),
  };
}

describe("edge site settings store", () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("normalizes site setting keys", () => {
    expect(normalizeSiteSettingsKey(" site-1 ")).toBe("site-1");
    expect(normalizeSiteSettingsKey(null)).toBe("");
    expect(normalizeSiteSettingsKey("x".repeat(140))).toHaveLength(120);
  });

  it("returns null for blank site IDs before touching bindings", async () => {
    await expect(readSiteTrackingConfig({} as Env, "   ")).resolves.toBeNull();
    await expect(readSiteScriptSettings({} as Env, "")).resolves.toBeNull();
  });

  it("reads normalized settings from edge cache when available", async () => {
    const cache = cacheWithResponse(
      new Response(
        JSON.stringify({
          siteId: "cached-site",
          siteDomain: "https://Example.com/path",
          trackingStrength: "strong",
          trackQueryParams: "0",
          trackHash: "1",
          domainWhitelist: ["https://Docs.example.com", "bad*"],
          pathBlacklist: "/admin\nsettings",
          performanceSampleRate: "12.345",
        }),
      ),
    );
    vi.stubGlobal("caches", {
      open: vi.fn().mockResolvedValue(cache),
    });

    const config = await readSiteTrackingConfig(
      envWithKv({ get: vi.fn() }),
      "cached-site",
    );

    expect(config).toMatchObject({
      siteId: "cached-site",
      siteDomain: "example.com",
      trackingStrength: "strong",
      trackQueryParams: false,
      trackHash: true,
      domainWhitelist: ["docs.example.com"],
      pathBlacklist: ["/admin", "/settings"],
      performanceSampleRate: 12.35,
    });
  });

  it("reads KV settings, handles invalid JSON, and writes normalized cache entries", async () => {
    const cache = cacheWithResponse();
    vi.stubGlobal("caches", {
      open: vi.fn().mockResolvedValue(cache),
    });
    const kv = {
      get: vi.fn().mockResolvedValue("{bad json"),
    };

    const config = await readSiteTrackingConfig(envWithKv(kv), " site-1 ");

    expect(kv.get).toHaveBeenCalledWith("site-1");
    expect(config).toMatchObject({
      siteId: "site-1",
      siteDomain: "",
      trackingStrength: "smart",
      ignoreDoNotTrack: true,
    });
    expect(cache.put).toHaveBeenCalledTimes(1);
    expect((cache.put.mock.calls[0]![0] as Request).url).toBe(
      "https://insightflare.internal/__site-settings/site-1",
    );
  });

  it("upserts tracking and script settings into KV and cache", async () => {
    const cache = cacheWithResponse();
    vi.stubGlobal("caches", {
      open: vi.fn().mockResolvedValue(cache),
    });
    const kv = {
      get: vi.fn().mockResolvedValue(
        JSON.stringify({
          siteDomain: "old.example",
          trackHash: true,
          performanceSampleRate: 10,
        }),
      ),
      put: vi.fn().mockResolvedValue(undefined),
    };

    const config = await upsertSiteTrackingConfig(envWithKv(kv), " site-1 ", {
      siteDomain: "https://New.example/path",
      settings: {
        trackHash: false,
        domainWhitelist: "https://Docs.example.com\nbad*",
        pathBlacklist: "admin,/checkout?step=1",
        performanceSampleRate: 25,
      },
    });

    expect(config).toMatchObject({
      siteId: "site-1",
      siteDomain: "new.example",
      trackHash: false,
      domainWhitelist: ["docs.example.com"],
      pathBlacklist: ["/admin", "/checkout"],
      performanceSampleRate: 25,
    });
    expect(kv.put).toHaveBeenCalledTimes(1);
    const stored = JSON.parse(kv.put.mock.calls[0]![1] as string) as Record<
      string,
      unknown
    >;
    expect(stored).toMatchObject({
      siteId: "site-1",
      siteDomain: "new.example",
      trackHash: false,
      performanceSampleRate: 25,
    });
    expect(stored.allowedHostnames).toBeUndefined();

    const scriptSettings = await upsertSiteScriptSettings(
      envWithKv({
        get: vi.fn().mockResolvedValue(null),
        put: vi.fn().mockResolvedValue(undefined),
      }),
      "site-2",
      {
        siteDomain: "example.org",
        settings: { autoTrackOutboundLinks: true },
      },
    );
    expect(scriptSettings).toMatchObject({
      autoTrackOutboundLinks: true,
      domainWhitelist: [],
    });
  });

  it("throws for missing required upsert fields and missing KV bindings", async () => {
    await expect(
      upsertSiteTrackingConfig(
        { SITE_SETTINGS_KV: {} as KVNamespace } as Env,
        "",
        {
          siteDomain: "example.com",
        },
      ),
    ).rejects.toThrow("siteId is required");

    await expect(
      upsertSiteTrackingConfig(
        envWithKv({ get: vi.fn().mockResolvedValue(null) }),
        "site-1",
        {},
      ),
    ).rejects.toThrow("siteDomain is required");

    await expect(readSiteTrackingConfig({} as Env, "site-1")).rejects.toThrow(
      "SITE_SETTINGS_KV binding is missing",
    );
  });

  it("stores blocking field patches in one canonical v2 layer", async () => {
    const kv = {
      get: vi.fn().mockResolvedValue(
        JSON.stringify({
          siteDomain: "example.com",
          domainWhitelist: ["old.example.com"],
          pathBlacklist: ["/private"],
          blockingRules: [
            { version: 2, data: { domains: ["old-v2.example.com"] } },
          ],
        }),
      ),
      put: vi.fn().mockResolvedValue(undefined),
    };

    const config = await upsertSiteTrackingConfig(envWithKv(kv), "site-1", {
      blockingPatch: {
        domains: ["*", "-new.example.com"],
      },
    });

    expect(config.blockingRules).toEqual([
      { version: 2, data: { domains: ["*", "-new.example.com"] } },
    ]);
    const stored = JSON.parse(kv.put.mock.calls[0]![1] as string) as Record<
      string,
      unknown
    >;
    expect(stored.domainWhitelist).toBeUndefined();
    expect(stored.pathBlacklist).toEqual(["/private"]);
    expect(stored.blockingRules).toEqual([
      { version: 2, data: { domains: ["*", "-new.example.com"] } },
    ]);
  });

  it("deletes KV and cache entries for non-empty site IDs", async () => {
    const cache = cacheWithResponse();
    vi.stubGlobal("caches", {
      open: vi.fn().mockResolvedValue(cache),
    });
    const kv = {
      delete: vi.fn().mockResolvedValue(undefined),
    };

    await deleteSiteScriptSettings(envWithKv(kv), " site/1 ");
    await deleteSiteScriptSettings(envWithKv(kv), " ");

    expect(kv.delete).toHaveBeenCalledTimes(1);
    expect(kv.delete).toHaveBeenCalledWith("site/1");
    expect(cache.delete).toHaveBeenCalledTimes(1);
    expect((cache.delete.mock.calls[0]![0] as Request).url).toBe(
      "https://insightflare.internal/__site-settings/site%2F1",
    );
  });
});
