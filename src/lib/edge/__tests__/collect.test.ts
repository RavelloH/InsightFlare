import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  handleCollectOptionsRequest,
  handleCollectRequest,
} from "@/lib/edge/collect";
import { issueCollectToken } from "@/lib/edge/collect-token";
import type * as SiteSettingsStoreModule from "@/lib/edge/site-settings-store";
import { readSiteTrackingConfig } from "@/lib/edge/site-settings-store";
import type {
  SiteSettingsJsonValue,
  SiteTrackingConfig,
} from "@/lib/site-settings";

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

const baseSettings: SiteTrackingConfig = {
  siteId: "site-1",
  siteDomain: "example.com",
  allowedHostnames: [],
  trackingStrength: "smart",
  trackQueryParams: true,
  trackHash: true,
  autoTrackOutboundLinks: false,
  domainWhitelist: [],
  pathBlacklist: [],
  ignoreDoNotTrack: true,
  performanceSampleRate: 100,
};

const env = {
  INGEST_DO: {
    idFromName: vi.fn(),
    get: vi.fn(),
  },
  REQUEST_ANALYTICS: {
    writeDataPoint: vi.fn(),
  },
  SITE_SETTINGS_KV: {},
  MAIN_SECRET: "main-secret",
};

const ctx = {
  waitUntil: vi.fn(),
};

async function makePayload(overrides: Record<string, unknown> = {}) {
  const tokenSiteId = String(
    overrides.collectTokenSiteId ?? overrides.siteId ?? "site-1",
  );
  const siteId = String(overrides.siteId ?? "site-1");
  const tokenIp = String(overrides.collectTokenIp ?? "203.0.113.10");
  const {
    collectTokenSiteId: _collectTokenSiteId,
    collectTokenIp: _collectTokenIp,
    ...payloadOverrides
  } = overrides;
  return {
    siteId,
    kind: "pageview",
    visitId: "visit-1",
    previousVisitId: "previous-visit-1",
    eventId: "event-1",
    pathname: "/pricing?plan=pro#hero",
    hostname: "Example.COM.",
    timestamp: 1_800_000_000_000,
    collectToken: await issueCollectToken({
      env,
      siteId: tokenSiteId.trim() || "default",
      ip: tokenIp,
    }),
    ...payloadOverrides,
  };
}

function makeRuntimeRequest(input: {
  url?: string;
  origin?: string;
  body?: unknown;
  method?: string;
  headers?: HeadersInit;
  cf?: unknown;
}) {
  const headers = new Headers(input.headers);
  if (!headers.has("cf-connecting-ip")) {
    headers.set("cf-connecting-ip", "203.0.113.10");
  }
  if (input.body !== undefined && !headers.has("content-type")) {
    headers.set("content-type", "application/json");
  }

  const request = new Request(input.url ?? "https://collector.test/collect", {
    method: input.method ?? "POST",
    headers,
    body:
      input.body === undefined
        ? undefined
        : typeof input.body === "string"
          ? input.body
          : JSON.stringify(input.body),
  });

  if (input.origin) {
    const getHeader = request.headers.get.bind(request.headers);
    vi.spyOn(request.headers, "get").mockImplementation((name) =>
      name.toLowerCase() === "origin" ? input.origin! : getHeader(name),
    );
  }

  if (input.cf !== undefined) {
    Object.defineProperty(request, "cf", {
      value: input.cf,
      configurable: true,
    });
  }

  return request;
}

type BlockingCollectorCase = {
  name: string;
  rules: Record<string, string[]>;
  payload: Record<string, unknown>;
  headers?: Record<string, string>;
  cf?: Record<string, unknown>;
};

async function readForwardedEnvelope() {
  const waitUntilPromise = ctx.waitUntil.mock.calls.at(-1)?.[0];
  await waitUntilPromise;
  const stub = env.INGEST_DO.get.mock.results.at(-1)?.value;
  const fetchInit = stub.fetch.mock.calls[0]?.[1] as RequestInit;
  return JSON.parse(String(fetchInit.body)) as Record<string, unknown>;
}

describe("collect route", () => {
  beforeEach(() => {
    vi.useRealTimers();
    readSiteTrackingConfigMock.mockReset();
    env.REQUEST_ANALYTICS.writeDataPoint.mockReset();
    env.INGEST_DO.idFromName.mockReset();
    env.INGEST_DO.get.mockReset();
    env.INGEST_DO.idFromName.mockReturnValue("do-id");
    env.INGEST_DO.get.mockReturnValue({
      fetch: vi.fn().mockResolvedValue(new Response("queued", { status: 202 })),
    });
    ctx.waitUntil.mockReset();
    readSiteTrackingConfigMock.mockResolvedValue(baseSettings);
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
  });

  it("answers CORS preflight with the parsed origin", async () => {
    const request = new Request("https://collector.test/collect", {
      method: "OPTIONS",
    });
    vi.spyOn(request.headers, "get").mockImplementation((name) =>
      name.toLowerCase() === "origin" ? "https://Example.com/path" : null,
    );

    const response = await handleCollectOptionsRequest(request);

    expect(response.status).toBe(204);
    expect(response.headers.get("access-control-allow-origin")).toBe(
      "https://example.com",
    );
    expect(response.headers.get("access-control-allow-credentials")).toBe(
      "true",
    );
    expect(response.headers.get("access-control-allow-methods")).toBe(
      "GET, POST, PATCH, OPTIONS",
    );
    expect(response.headers.get("vary")).toBe("Origin");
  });

  it("omits allow-origin when the request origin is invalid", async () => {
    const request = new Request("https://collector.test/collect", {
      method: "OPTIONS",
    });
    vi.spyOn(request.headers, "get").mockImplementation((name) =>
      name.toLowerCase() === "origin" ? "not a url" : null,
    );

    const response = await handleCollectOptionsRequest(request);

    expect(response.status).toBe(204);
    expect(response.headers.has("access-control-allow-origin")).toBe(false);
    expect(response.headers.get("vary")).toBe("Origin");
  });

  it("answers CORS preflight without allow-origin when no origin is present", async () => {
    const request = new Request("https://collector.test/collect", {
      method: "OPTIONS",
    });

    const response = await handleCollectOptionsRequest(request);

    expect(response.status).toBe(204);
    expect(response.headers.has("access-control-allow-origin")).toBe(false);
    expect(response.headers.has("access-control-allow-credentials")).toBe(
      false,
    );
    expect(response.headers.get("vary")).toBe("Origin");
  });

  it("returns a JSON error for invalid JSON without reading settings", async () => {
    const request = makeRuntimeRequest({
      origin: "https://example.com",
      body: "{",
    });

    const response = await handleCollectRequest(
      request,
      env as never,
      ctx as never,
      new URL(request.url),
    );

    await expect(response.json()).resolves.toEqual({
      ok: false,
      error: "Invalid JSON payload",
    });
    expect(response.status).toBe(400);
    expect(response.headers.get("content-type")).toBe(
      "application/json; charset=utf-8",
    );
    expect(readSiteTrackingConfigMock).not.toHaveBeenCalled();
    expect(ctx.waitUntil).not.toHaveBeenCalled();
  });

  it("rejects custom event payloads with invalid eventData before forwarding", async () => {
    const request = makeRuntimeRequest({
      origin: "https://example.com",
      body: await makePayload({
        kind: "custom_event",
        eventName: "Signup",
        eventData: ["not", "an", "object"],
      }),
    });

    const response = await handleCollectRequest(
      request,
      env as never,
      ctx as never,
      new URL(request.url),
    );

    await expect(response.json()).resolves.toEqual({
      ok: false,
      error: "eventData must be a JSON object",
    });
    expect(response.status).toBe(422);
    expect(readSiteTrackingConfigMock).not.toHaveBeenCalled();
    expect(ctx.waitUntil).not.toHaveBeenCalled();
  });

  it("returns a controlled validation error when custom event payloads omit eventData", async () => {
    const request = makeRuntimeRequest({
      origin: "https://example.com",
      body: await makePayload({
        kind: "custom_event",
        eventName: "Signup",
      }),
    });

    const response = await handleCollectRequest(
      request,
      env as never,
      ctx as never,
      new URL(request.url),
    );

    await expect(response.json()).resolves.toEqual({
      ok: false,
      error: "eventData is required",
    });
    expect(response.status).toBe(422);
    expect(readSiteTrackingConfigMock).not.toHaveBeenCalled();
    expect(ctx.waitUntil).not.toHaveBeenCalled();
  });

  it("rejects custom event payloads when eventData cannot be JSON serialized", async () => {
    const body = JSON.stringify(
      await makePayload({
        kind: "custom_event",
        eventName: "Signup",
        eventData: { explode: true },
      }),
    );
    const stringify = JSON.stringify;
    const stringifySpy = vi
      .spyOn(JSON, "stringify")
      .mockImplementation((value, replacer, space) => {
        if (
          value &&
          typeof value === "object" &&
          "explode" in value &&
          value.explode === true
        ) {
          throw new TypeError("cannot serialize");
        }
        return stringify(value, replacer, space);
      });
    const request = makeRuntimeRequest({
      origin: "https://example.com",
      body,
    });

    const response = await handleCollectRequest(
      request,
      env as never,
      ctx as never,
      new URL(request.url),
    );

    await expect(response.json()).resolves.toEqual({
      ok: false,
      error: "eventData must be JSON serializable",
    });
    expect(response.status).toBe(422);
    expect(readSiteTrackingConfigMock).not.toHaveBeenCalled();
    expect(ctx.waitUntil).not.toHaveBeenCalled();

    stringifySpy.mockRestore();
  });

  it("diverts bot traffic to Analytics Engine without forwarding", async () => {
    const request = makeRuntimeRequest({
      origin: "https://example.com",
      body: await makePayload(),
      headers: {
        "user-agent": "Googlebot/2.1",
      },
    });

    const response = await handleCollectRequest(
      request,
      env as never,
      ctx as never,
      new URL(request.url),
    );

    expect(response.status).toBe(204);
    expect(env.REQUEST_ANALYTICS.writeDataPoint).toHaveBeenCalledTimes(1);
    const dataPoint = env.REQUEST_ANALYTICS.writeDataPoint.mock.calls[0]?.[0];
    expect(dataPoint).toMatchObject({
      indexes: ["site-1"],
    });
    expect(dataPoint?.blobs).toEqual(
      expect.arrayContaining([
        "pageview",
        "high_threat",
        expect.stringContaining("ua_isbot"),
        "Googlebot/2.1",
      ]),
    );
    expect(readSiteTrackingConfigMock).toHaveBeenCalledWith(env, "site-1");
    expect(ctx.waitUntil).not.toHaveBeenCalled();
  });

  it("drops direct collect requests without a valid collect token", async () => {
    const request = makeRuntimeRequest({
      origin: "https://example.com",
      body: {
        ...(await makePayload()),
        collectToken: "",
      },
    });

    const response = await handleCollectRequest(
      request,
      env as never,
      ctx as never,
      new URL(request.url),
    );

    expect(response.status).toBe(204);
    expect(readSiteTrackingConfigMock).not.toHaveBeenCalled();
    expect(env.REQUEST_ANALYTICS.writeDataPoint).not.toHaveBeenCalled();
    expect(env.INGEST_DO.idFromName).not.toHaveBeenCalled();
    expect(ctx.waitUntil).not.toHaveBeenCalled();
  });

  it("drops collect requests when the token IP does not match the request IP", async () => {
    const request = makeRuntimeRequest({
      origin: "https://example.com",
      body: await makePayload({ collectTokenIp: "203.0.113.20" }),
    });

    const response = await handleCollectRequest(
      request,
      env as never,
      ctx as never,
      new URL(request.url),
    );

    expect(response.status).toBe(204);
    expect(readSiteTrackingConfigMock).not.toHaveBeenCalled();
    expect(env.INGEST_DO.idFromName).not.toHaveBeenCalled();
    expect(ctx.waitUntil).not.toHaveBeenCalled();
  });

  it("drops empty, malformed, and unsupported payloads with no forwarding", async () => {
    const scenarios: unknown[] = [
      undefined,
      null,
      [],
      await makePayload({ kind: "screenview" }),
    ];

    for (const body of scenarios) {
      const request = makeRuntimeRequest({
        origin: "https://example.com",
        body,
      });

      const response = await handleCollectRequest(
        request,
        env as never,
        ctx as never,
        new URL(request.url),
      );

      expect(response.status).toBe(204);
      expect(ctx.waitUntil).not.toHaveBeenCalled();
      ctx.waitUntil.mockClear();
      readSiteTrackingConfigMock.mockClear();
    }
  });

  it("drops payloads when settings are missing or cannot be read", async () => {
    for (const settingsResult of [null, new Error("KV unavailable")]) {
      if (settingsResult instanceof Error) {
        readSiteTrackingConfigMock.mockRejectedValueOnce(settingsResult);
      } else {
        readSiteTrackingConfigMock.mockResolvedValueOnce(settingsResult);
      }
      const request = makeRuntimeRequest({
        origin: "https://example.com",
        body: await makePayload(),
      });

      const response = await handleCollectRequest(
        request,
        env as never,
        ctx as never,
        new URL(request.url),
      );

      expect(response.status).toBe(204);
      expect(env.INGEST_DO.idFromName).not.toHaveBeenCalled();
      expect(ctx.waitUntil).not.toHaveBeenCalled();
    }
  });

  it("enforces domain whitelist privacy settings before forwarding", async () => {
    readSiteTrackingConfigMock.mockResolvedValue({
      ...baseSettings,
      domainWhitelist: ["allowed.example"],
      allowedHostnames: ["allowed.example"],
    });
    const request = makeRuntimeRequest({
      origin: "https://blocked.example",
      body: await makePayload(),
    });

    const response = await handleCollectRequest(
      request,
      env as never,
      ctx as never,
      new URL(request.url),
    );

    expect(response.status).toBe(204);
    expect(response.headers.get("access-control-allow-origin")).toBe(
      "https://blocked.example",
    );
    expect(ctx.waitUntil).not.toHaveBeenCalled();
  });

  it("rejects opaque file origins when a hostname whitelist is configured", async () => {
    readSiteTrackingConfigMock.mockResolvedValue({
      ...baseSettings,
      domainWhitelist: ["allowed.example"],
      allowedHostnames: ["allowed.example"],
    });
    const request = makeRuntimeRequest({
      origin: "file:///Users/example/page.html",
      body: await makePayload(),
    });

    const response = await handleCollectRequest(
      request,
      env as never,
      ctx as never,
      new URL(request.url),
    );

    expect(response.status).toBe(204);
    expect(response.headers.get("access-control-allow-origin")).toBe("null");
    expect(ctx.waitUntil).not.toHaveBeenCalled();
  });

  it("forwards when a whitelisted origin hostname matches case-insensitively", async () => {
    readSiteTrackingConfigMock.mockResolvedValue({
      ...baseSettings,
      domainWhitelist: ["allowed.example"],
      allowedHostnames: [" Allowed.Example "],
    });
    const request = makeRuntimeRequest({
      origin: "https://Allowed.Example.",
      body: await makePayload(),
    });

    const response = await handleCollectRequest(
      request,
      env as never,
      ctx as never,
      new URL(request.url),
    );

    expect(response.status).toBe(204);
    expect(response.headers.get("access-control-allow-origin")).toBe(
      "https://allowed.example.",
    );
    expect(env.INGEST_DO.idFromName).toHaveBeenCalledWith("site-1");
    expect(ctx.waitUntil).toHaveBeenCalledTimes(1);
  });

  it("enforces path blacklist settings after normalizing payload paths", async () => {
    readSiteTrackingConfigMock.mockResolvedValue({
      ...baseSettings,
      pathBlacklist: ["/private"],
    });
    const request = makeRuntimeRequest({
      origin: "https://example.com",
      body: await makePayload({
        pathname: "https://example.com/private/account?tab=billing",
      }),
    });

    const response = await handleCollectRequest(
      request,
      env as never,
      ctx as never,
      new URL(request.url),
    );

    expect(response.status).toBe(204);
    expect(ctx.waitUntil).not.toHaveBeenCalled();
  });

  it.each([
    {
      name: "domains",
      rules: { domains: ["blocked.example"] },
      payload: { hostname: "blocked.example" },
    },
    {
      name: "paths",
      rules: { paths: ["/private/*"] },
      payload: { pathname: "/private/account" },
    },
    {
      name: "query parameters",
      rules: { queryParameters: ["utm_*"] },
      payload: { query: "?utm_source=campaign" },
    },
    {
      name: "referrers",
      rules: { referrers: ["ads.example"] },
      payload: { referrerUrl: "https://ads.example/landing" },
      headers: { referer: "https://ads.example/landing" },
    },
    {
      name: "user agents",
      rules: { userAgents: ["*crawler*"] },
      payload: {},
      headers: { "user-agent": "ExampleCrawler/1.0" },
    },
    {
      name: "IP ranges",
      rules: { ips: ["203.0.113.0/24"] },
      payload: {},
    },
    {
      name: "ASNs",
      rules: { asns: ["4837"] },
      payload: {},
      cf: { asn: 4837 },
    },
    {
      name: "countries",
      rules: { countries: ["CN"] },
      payload: {},
      cf: { country: "CN" },
    },
    {
      name: "regions",
      rules: { regions: ["CN-SD"] },
      payload: {},
      cf: { country: "CN", regionCode: "SD" },
    },
  ] satisfies BlockingCollectorCase[])(
    "applies v2 $name rules to collector request context",
    async (item) => {
      readSiteTrackingConfigMock.mockResolvedValue({
        ...baseSettings,
        blockingRules: [
          {
            version: 2,
            data: item.rules as unknown as Record<
              string,
              SiteSettingsJsonValue
            >,
          },
        ],
      });
      const request = makeRuntimeRequest({
        origin: "https://example.com",
        headers: item.headers as unknown as HeadersInit,
        cf: item.cf,
        body: await makePayload(item.payload),
      });

      const response = await handleCollectRequest(
        request,
        env as never,
        ctx as never,
        new URL(request.url),
      );

      expect(response.status).toBe(204);
      expect(ctx.waitUntil).not.toHaveBeenCalled();
      expect(env.INGEST_DO.idFromName).not.toHaveBeenCalled();
      expect(env.REQUEST_ANALYTICS.writeDataPoint).toHaveBeenCalledTimes(1);
      expect(
        env.REQUEST_ANALYTICS.writeDataPoint.mock.calls[0]?.[0]?.blobs,
      ).toEqual(expect.arrayContaining(["custom_block"]));
    },
  );

  it("records all matching custom-block fields once without storing rule details", async () => {
    readSiteTrackingConfigMock.mockResolvedValue({
      ...baseSettings,
      blockingRules: [
        {
          version: 2,
          data: {
            domains: ["blocked.example"],
            paths: ["/private/*"],
            queryParameters: ["utm_source"],
          },
        },
      ],
    });
    const request = makeRuntimeRequest({
      origin: "https://example.com",
      body: await makePayload({
        hostname: "blocked.example",
        pathname: "/private/account",
        query: "?utm_source=campaign",
      }),
      headers: { "user-agent": "Googlebot/2.1" },
    });

    const response = await handleCollectRequest(
      request,
      env as never,
      ctx as never,
      new URL(request.url),
    );

    expect(response.status).toBe(204);
    expect(env.REQUEST_ANALYTICS.writeDataPoint).toHaveBeenCalledTimes(1);
    expect(env.INGEST_DO.idFromName).not.toHaveBeenCalled();
    const dataPoint = env.REQUEST_ANALYTICS.writeDataPoint.mock.calls[0]?.[0];
    expect(dataPoint?.blobs?.[2]).toBe(
      "custom_block,blocked_domains,blocked_paths,blocked_query_parameters",
    );
    expect(dataPoint?.blobs?.[2]).not.toContain("ua_isbot");
    expect(JSON.stringify(dataPoint?.blobs?.[19])).not.toContain(
      "blocked.example",
    );
    expect(JSON.stringify(dataPoint?.blobs?.[19])).not.toContain("version");
  });

  it("allows a later negative v2 rule to override a blocking IP range", async () => {
    readSiteTrackingConfigMock.mockResolvedValue({
      ...baseSettings,
      blockingRules: [
        {
          version: 2,
          data: { ips: ["203.0.113.0/24", "-203.0.113.10"] },
        },
      ],
    });
    const request = makeRuntimeRequest({
      origin: "https://example.com",
      body: await makePayload(),
    });

    const response = await handleCollectRequest(
      request,
      env as never,
      ctx as never,
      new URL(request.url),
    );

    expect(response.status).toBe(204);
    expect(env.INGEST_DO.idFromName).toHaveBeenCalledWith("site-1");
    expect(ctx.waitUntil).toHaveBeenCalledTimes(1);
  });

  it("forwards normalized pageview payloads to the ingest Durable Object", async () => {
    const request = makeRuntimeRequest({
      origin: "https://example.com",
      body: await makePayload({
        siteId: "  site-1  ",
        pathname: "pricing//plans?from=nav#hero",
        hostname: "Example.COM.",
        uaClientHints: {
          brands: [
            { brand: "Chromium", version: "125" },
            { brand: "", version: "ignored" },
          ],
          fullVersionList: "invalid",
          mobile: false,
          platform: " Windows ",
          formFactors: ["Desktop", ""],
          ignored: "field",
        },
      }),
      cf: {
        country: "US",
      },
    });

    const response = await handleCollectRequest(
      request,
      env as never,
      ctx as never,
      new URL(request.url),
    );

    expect(response.status).toBe(204);
    expect(env.INGEST_DO.idFromName).toHaveBeenCalledWith("site-1");
    const stub = env.INGEST_DO.get.mock.results[0]?.value;
    expect(stub.fetch).toHaveBeenCalledWith("https://ingest.internal/ingest", {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: expect.any(String),
    });
    expect(ctx.waitUntil).toHaveBeenCalledTimes(1);

    const envelope = await readForwardedEnvelope();
    expect(envelope.client).toMatchObject({
      siteId: "site-1",
      kind: "pageview",
      visitId: "visit-1",
      pathname: "/pricing/plans",
      hostname: "example.com",
      uaClientHints: {
        brands: [{ brand: "Chromium", version: "125" }],
        mobile: false,
        platform: "Windows",
        formFactors: ["Desktop"],
      },
    });
    expect(envelope.request).toMatchObject({
      method: "POST",
      url: "https://collector.test/collect",
      cf: {
        country: "US",
      },
    });
    expect(envelope.trace).toMatchObject({
      source: "collect",
      id: expect.any(String),
      acceptedAt: expect.any(Number),
    });
  });

  it("normalizes query-only pageview paths to root while ignoring empty blacklist entries", async () => {
    readSiteTrackingConfigMock.mockResolvedValue({
      ...baseSettings,
      pathBlacklist: ["", "/private"],
    });
    const request = makeRuntimeRequest({
      body: await makePayload({
        pathname: "?utm_source=newsletter",
      }),
    });

    const response = await handleCollectRequest(
      request,
      env as never,
      ctx as never,
      new URL(request.url),
    );

    expect(response.status).toBe(204);
    expect(response.headers.has("access-control-allow-origin")).toBe(false);
    const envelope = await readForwardedEnvelope();
    expect(envelope.client).toMatchObject({
      siteId: "site-1",
      kind: "pageview",
      pathname: "/",
    });
  });

  it("falls back to the query siteId and removes empty UA hints when forwarding", async () => {
    const request = makeRuntimeRequest({
      url: "https://collector.test/collect?siteId=query-site",
      origin: "https://example.com",
      body: await makePayload({
        collectTokenSiteId: "query-site",
        siteId: "",
        kind: "identify",
        pathname: "not-needed",
        hostname: "not-needed",
        userId: "user-1",
        uaClientHints: {
          brands: [{ brand: "", version: "ignored" }],
          mobile: "no",
        },
      }),
    });

    const response = await handleCollectRequest(
      request,
      env as never,
      ctx as never,
      new URL(request.url),
    );

    expect(response.status).toBe(204);
    expect(readSiteTrackingConfigMock).toHaveBeenCalledWith(env, "query-site");
    expect(env.INGEST_DO.idFromName).toHaveBeenCalledWith("query-site");
    const envelope = await readForwardedEnvelope();
    expect(envelope.client).toMatchObject({
      siteId: "query-site",
      kind: "identify",
      visitId: "visit-1",
    });
    expect(envelope.client).not.toHaveProperty("uaClientHints");
  });

  it("uses the default siteId when the payload and query omit one", async () => {
    const request = makeRuntimeRequest({
      origin: "https://example.com",
      body: await makePayload({
        siteId: "",
        kind: "leave",
        pathname: "",
      }),
    });

    const response = await handleCollectRequest(
      request,
      env as never,
      ctx as never,
      new URL(request.url),
    );

    expect(response.status).toBe(204);
    expect(readSiteTrackingConfigMock).toHaveBeenCalledWith(env, "default");
    expect(env.INGEST_DO.idFromName).toHaveBeenCalledWith("default");
    const envelope = await readForwardedEnvelope();
    expect(envelope.client).toMatchObject({
      siteId: "default",
      kind: "leave",
      visitId: "visit-1",
    });
    expect(envelope.client).toHaveProperty("pathname", "");
  });

  it("rejects whitespace-only siteIds before reading settings", async () => {
    const request = makeRuntimeRequest({
      origin: "https://example.com",
      body: await makePayload({
        siteId: "   ",
      }),
    });

    const response = await handleCollectRequest(
      request,
      env as never,
      ctx as never,
      new URL(request.url),
    );

    expect(response.status).toBe(204);
    expect(readSiteTrackingConfigMock).not.toHaveBeenCalled();
    expect(ctx.waitUntil).not.toHaveBeenCalled();
  });

  it("forwards custom events after event name normalization", async () => {
    const request = makeRuntimeRequest({
      origin: "https://example.com",
      body: await makePayload({
        kind: "custom_event",
        eventName: "  Trial Started  ",
        eventData: {
          plan: "pro",
        },
        pathname: "https://example.com/events/trial?utm_source=test",
      }),
    });

    const response = await handleCollectRequest(
      request,
      env as never,
      ctx as never,
      new URL(request.url),
    );

    expect(response.status).toBe(204);
    expect(env.INGEST_DO.idFromName).toHaveBeenCalledWith("site-1");
    const envelope = await readForwardedEnvelope();
    expect(envelope.client).toMatchObject({
      siteId: "site-1",
      kind: "custom_event",
      visitId: "visit-1",
      eventName: "Trial Started",
      pathname: "/events/trial",
      eventData: {
        plan: "pro",
      },
    });
  });

  it("forwards visibility events after state and path normalization", async () => {
    const request = makeRuntimeRequest({
      origin: "https://example.com",
      body: await makePayload({
        kind: "visibility",
        visibilityState: "hidden",
        pathname: "https://example.com/docs/page?tab=one",
      }),
    });

    const response = await handleCollectRequest(
      request,
      env as never,
      ctx as never,
      new URL(request.url),
    );

    expect(response.status).toBe(204);
    const envelope = await readForwardedEnvelope();
    expect(envelope.client).toMatchObject({
      siteId: "site-1",
      kind: "visibility",
      visitId: "visit-1",
      visibilityState: "hidden",
      pathname: "/docs/page",
    });
  });

  it("falls back to timestamp/random trace ids when randomUUID is unavailable", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-25T12:00:00.000Z"));
    const randomUuidSpy = vi
      .spyOn(crypto, "randomUUID")
      .mockImplementation(() => {
        throw new Error("randomUUID unavailable");
      });
    const randomSpy = vi.spyOn(Math, "random").mockReturnValue(0.5);
    const expectedTraceId = `${Date.now().toString(36)}-i`;
    const request = makeRuntimeRequest({
      origin: "https://example.com",
      body: await makePayload(),
    });

    const response = await handleCollectRequest(
      request,
      env as never,
      ctx as never,
      new URL(request.url),
    );

    expect(response.status).toBe(204);
    const envelope = await readForwardedEnvelope();
    expect(envelope.trace).toMatchObject({
      id: expectedTraceId,
      source: "collect",
    });

    randomUuidSpy.mockRestore();
    randomSpy.mockRestore();
  });

  it("rejects normalized payloads with missing required fields", async () => {
    const scenarios = [
      { kind: "pageview", visitId: "" },
      { kind: "pageview", hostname: "bad:host" },
      { kind: "pageview", pathname: "https://%" },
      { kind: "custom_event", eventName: "", eventData: {} },
    ];

    for (const overrides of scenarios) {
      const request = makeRuntimeRequest({
        origin: "https://example.com",
        body: await makePayload(overrides),
      });

      const response = await handleCollectRequest(
        request,
        env as never,
        ctx as never,
        new URL(request.url),
      );

      expect(response.status).toBe(204);
      expect(ctx.waitUntil).not.toHaveBeenCalled();
      ctx.waitUntil.mockClear();
      env.INGEST_DO.idFromName.mockClear();
    }
  });

  it("does not emit a second log when Durable Object forwarding fails asynchronously", async () => {
    const forwardError = new Error("DO unavailable");
    env.INGEST_DO.get.mockReturnValue({
      fetch: vi.fn().mockRejectedValue(forwardError),
    });
    const request = makeRuntimeRequest({
      origin: "https://example.com",
      body: await makePayload(),
    });

    const response = await handleCollectRequest(
      request,
      env as never,
      ctx as never,
      new URL(request.url),
    );

    expect(response.status).toBe(204);
    await expect(ctx.waitUntil.mock.calls[0]?.[0]).resolves.toBeUndefined();
    expect(console.error).not.toHaveBeenCalled();
  });

  it("does not emit a second log for non-ok Durable Object responses", async () => {
    env.INGEST_DO.get.mockReturnValue({
      fetch: vi
        .fn()
        .mockResolvedValue(new Response("bad gateway", { status: 502 })),
    });
    const request = makeRuntimeRequest({
      origin: "https://example.com",
      body: await makePayload(),
    });

    const response = await handleCollectRequest(
      request,
      env as never,
      ctx as never,
      new URL(request.url),
    );

    expect(response.status).toBe(204);
    await expect(ctx.waitUntil.mock.calls[0]?.[0]).resolves.toBeUndefined();
    expect(console.error).not.toHaveBeenCalled();
  });

  it("does not read Durable Object response bodies after queuing the forward", async () => {
    env.INGEST_DO.get.mockReturnValue({
      fetch: vi.fn().mockResolvedValue({
        ok: true,
        status: 202,
        text: vi.fn().mockRejectedValue(new Error("stream closed")),
      }),
    });
    const request = makeRuntimeRequest({
      origin: "https://example.com",
      body: await makePayload(),
    });

    const response = await handleCollectRequest(
      request,
      env as never,
      ctx as never,
      new URL(request.url),
    );

    expect(response.status).toBe(204);
    await expect(ctx.waitUntil.mock.calls[0]?.[0]).resolves.toBeUndefined();
    expect(console.log).not.toHaveBeenCalled();
  });
});
