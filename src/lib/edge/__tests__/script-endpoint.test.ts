import { beforeEach, describe, expect, it, vi } from "vitest";

import { handleTrackerScriptRequest } from "@/lib/edge/script-endpoint";
import type * as SiteSettingsStoreModule from "@/lib/edge/site-settings-store";
import { readSiteTrackingConfig } from "@/lib/edge/site-settings-store";
import type { Env } from "@/lib/edge/types";
import type { SiteTrackingConfig } from "@/lib/site-settings";

vi.mock("@/tracker/sdk.min", () => ({
  SDK_MIN: '"use strict";full-sdk',
}));

vi.mock("@/tracker/sdk.no-perf.min", () => ({
  SDK_MIN: "no-perf-sdk",
}));

vi.mock("@/lib/edge/site-settings-store", async () => {
  const actual = await vi.importActual<typeof SiteSettingsStoreModule>(
    "@/lib/edge/site-settings-store",
  );
  return {
    ...actual,
    readSiteTrackingConfig: vi.fn(),
  };
});

const readSiteTrackingConfigMock = vi.mocked(readSiteTrackingConfig);

function makeEnv(overrides: Partial<Env> = {}): Env {
  return overrides as Env;
}

function makeSettings(
  overrides: Partial<SiteTrackingConfig> = {},
): SiteTrackingConfig {
  return {
    siteId: "site-1",
    siteDomain: "example.com",
    allowedHostnames: ["example.com"],
    trackingStrength: "smart",
    trackQueryParams: true,
    trackHash: true,
    autoTrackOutboundLinks: false,
    domainWhitelist: [],
    pathBlacklist: [],
    ignoreDoNotTrack: true,
    performanceSampleRate: 50,
    ...overrides,
  };
}

function makeRequest(input: {
  url?: string;
  method?: string;
  isEUCountry?: boolean;
  ip?: string;
}): Request {
  const headers = new Headers();
  if (input.ip) headers.set("cf-connecting-ip", input.ip);
  const request = new Request(
    input.url ?? "https://example.com/script.js?siteId=site-1",
    { method: input.method ?? "GET", headers },
  );
  if (input.isEUCountry !== undefined) {
    Object.defineProperty(request, "cf", {
      value: { isEUCountry: input.isEUCountry },
      configurable: true,
    });
  }
  return request;
}

function cacheStorageWith(cache: Partial<Cache>) {
  return {
    open: vi.fn().mockResolvedValue(cache),
  };
}

describe("edge script endpoint", () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
    readSiteTrackingConfigMock.mockReset();
    readSiteTrackingConfigMock.mockResolvedValue(makeSettings());
  });

  it("rejects non-GET requests and missing site IDs", async () => {
    const postResponse = await handleTrackerScriptRequest(
      makeRequest({ method: "POST" }),
      makeEnv(),
    );
    const missingSiteResponse = await handleTrackerScriptRequest(
      makeRequest({ url: "https://example.com/script.js?siteId=%20%20" }),
      makeEnv(),
    );

    await expect(postResponse.text()).resolves.toBe("Method Not Allowed");
    expect(postResponse.status).toBe(405);
    await expect(missingSiteResponse.text()).resolves.toBe("Missing siteId");
    expect(missingSiteResponse.status).toBe(400);
    expect(readSiteTrackingConfigMock).not.toHaveBeenCalled();
  });

  it("returns settings lookup errors and missing-site responses", async () => {
    readSiteTrackingConfigMock.mockRejectedValueOnce(new Error("KV down"));
    const errorResponse = await handleTrackerScriptRequest(
      makeRequest({}),
      makeEnv(),
    );

    readSiteTrackingConfigMock.mockRejectedValueOnce("boom");
    const unknownErrorResponse = await handleTrackerScriptRequest(
      makeRequest({}),
      makeEnv(),
    );

    readSiteTrackingConfigMock.mockResolvedValueOnce(null);
    const notFoundResponse = await handleTrackerScriptRequest(
      makeRequest({}),
      makeEnv(),
    );

    await expect(errorResponse.text()).resolves.toBe("KV down");
    expect(errorResponse.status).toBe(500);
    await expect(unknownErrorResponse.text()).resolves.toBe(
      "site_settings_unavailable",
    );
    expect(unknownErrorResponse.status).toBe(500);
    await expect(notFoundResponse.text()).resolves.toBe("Not Found");
    expect(notFoundResponse.status).toBe(404);
  });

  it("injects site settings into the full SDK and writes cache entries", async () => {
    const cache = {
      match: vi.fn().mockResolvedValue(null),
      put: vi.fn().mockResolvedValue(undefined),
    };
    const storage = cacheStorageWith(cache);
    vi.stubGlobal("caches", storage);
    readSiteTrackingConfigMock.mockResolvedValueOnce(
      makeSettings({
        trackingStrength: "smart",
        trackQueryParams: false,
        trackHash: true,
        ignoreDoNotTrack: false,
        autoTrackOutboundLinks: true,
        performanceSampleRate: 125,
      }),
    );

    const response = await handleTrackerScriptRequest(
      makeRequest({
        url: "https://example.com/script.js?siteId=%20site-1%20",
        isEUCountry: true,
        ip: "203.0.113.9",
      }),
      makeEnv({
        MAIN_SECRET: "main-secret",
        SCRIPT_CACHE_TTL_SECONDS: "12.9",
        SESSION_WINDOW_MINUTES: "0",
      }),
    );

    const script = await response.text();
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe(
      "application/javascript; charset=utf-8",
    );
    expect(response.headers.get("access-control-allow-origin")).toBe("*");
    expect(response.headers.get("cache-control")).toBe(
      "public, max-age=12, s-maxage=12",
    );
    expect(script).toMatch(
      /^"use strict";globalThis\["__insightflare_tracker_runtime_config__"\] = \{"siteId":"site-1","isEUMode":true,"trackQueryParams":false,"trackHash":true,"ignoreDoNotTrack":false,"autoTrackOutboundLinks":true,"performanceSampleRate":100,"sessionWindowMs":1800000,"collectToken":"eyJ/,
    );
    expect(script).toMatch(/\nfull-sdk$/);
    expect(storage.open).toHaveBeenCalledWith("insightflare-script-cache");
    expect(cache.match).toHaveBeenCalledTimes(1);
    expect(cache.put).toHaveBeenCalledTimes(1);
    expect((cache.put.mock.calls[0]![0] as Request).url).toContain(
      "https://insightflare.internal/__script/site-1?eu=1&fp=",
    );
  });

  it("uses cached script responses before rendering a new SDK", async () => {
    const cached = new Response("cached script", {
      headers: { "x-cache-hit": "1" },
    });
    const cache = {
      match: vi.fn().mockResolvedValue(cached),
      put: vi.fn(),
    };
    vi.stubGlobal("caches", cacheStorageWith(cache));

    const response = await handleTrackerScriptRequest(
      makeRequest({}),
      makeEnv({ MAIN_SECRET: "main-secret" }),
    );

    await expect(response.text()).resolves.toBe("cached script");
    expect(response.headers.get("x-cache-hit")).toBe("1");
    expect(cache.put).not.toHaveBeenCalled();
  });

  it("serves no-perf scripts and clamps weak-mode cache/session settings", async () => {
    readSiteTrackingConfigMock.mockResolvedValueOnce(
      makeSettings({
        trackingStrength: "weak",
        trackQueryParams: true,
        trackHash: false,
        performanceSampleRate: -10,
      }),
    );

    const response = await handleTrackerScriptRequest(
      makeRequest({ isEUCountry: false }),
      makeEnv({
        MAIN_SECRET: "main-secret",
        SCRIPT_CACHE_TTL_SECONDS: "999999",
        SESSION_WINDOW_MINUTES: "99999",
      }),
    );

    await expect(response.text()).resolves.toMatch(
      /^globalThis\["__insightflare_tracker_runtime_config__"\] = \{"siteId":"site-1","isEUMode":true,"trackQueryParams":true,"trackHash":false,"ignoreDoNotTrack":true,"autoTrackOutboundLinks":false,"performanceSampleRate":0,"sessionWindowMs":86400000,"collectToken":"eyJ/,
    );
    expect(response.headers.get("cache-control")).toBe(
      "public, max-age=43200, s-maxage=43200",
    );
  });

  it("forces strong-mode non-EU scripts and ignores unavailable caches", async () => {
    vi.stubGlobal("caches", {
      open: vi.fn().mockRejectedValue(new Error("cache unavailable")),
    });
    readSiteTrackingConfigMock.mockResolvedValueOnce(
      makeSettings({
        trackingStrength: "strong",
        performanceSampleRate: 1,
      }),
    );

    const response = await handleTrackerScriptRequest(
      makeRequest({ isEUCountry: true }),
      makeEnv({
        MAIN_SECRET: "main-secret",
        SCRIPT_CACHE_TTL_SECONDS: "-1",
        SESSION_WINDOW_MINUTES: "abc",
      }),
    );

    await expect(response.text()).resolves.toContain('"isEUMode":false');
    expect(response.headers.get("cache-control")).toBe(
      "public, max-age=600, s-maxage=600",
    );
  });

  it("varies script cache entries by client IP because collect tokens are IP-bound", async () => {
    const cache = {
      match: vi.fn().mockResolvedValue(null),
      put: vi.fn().mockResolvedValue(undefined),
    };
    vi.stubGlobal("caches", cacheStorageWith(cache));

    await handleTrackerScriptRequest(
      makeRequest({ ip: "203.0.113.1" }),
      makeEnv({ MAIN_SECRET: "main-secret" }),
    );
    await handleTrackerScriptRequest(
      makeRequest({ ip: "203.0.113.2" }),
      makeEnv({ MAIN_SECRET: "main-secret" }),
    );

    const firstKey = (cache.match.mock.calls[0]![0] as Request).url;
    const secondKey = (cache.match.mock.calls[1]![0] as Request).url;
    expect(firstKey).not.toBe(secondKey);
  });
});
