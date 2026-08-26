import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { handleMapRelayRequest } from "@/lib/edge/map-relay";
import type { Env } from "@/lib/edge/types";

const env = { MAP_RELAY_BASE_URL: "https://maprelay.test" } as unknown as Env;

function request(path: string, init?: RequestInit): Request {
  return new Request(`https://app.test${path}`, init);
}

describe("map relay handler", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("requests the relay from the backend and forwards its cache response", async () => {
    vi.mocked(fetch).mockResolvedValue(
      new Response("style", {
        headers: {
          "cache-control": "public, max-age=300",
          "content-type": "application/json; charset=utf-8",
          etag: '"style"',
          "set-cookie": "should-not-be-forwarded",
        },
      }),
    );

    const response = await handleMapRelayRequest(
      request("/api/public/resources/map/v1/styles/dark/style.json?locale=zh"),
      env,
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("application/json");
    expect(response.headers.get("cache-control")).toBe("public, max-age=300");
    expect(response.headers.get("set-cookie")).toBeNull();
    expect(await response.text()).toBe("style");

    expect(fetch).toHaveBeenCalledTimes(1);
    const [url, init] = vi.mocked(fetch).mock.calls[0] as [URL, RequestInit];
    expect(url.toString()).toBe(
      "https://maprelay.test/v1/styles/dark/style.json?if_origin=https%3A%2F%2Fapp.test&if_locale=zh",
    );
    expect(init.method).toBe("GET");
    const headers = new Headers(init.headers);
    expect(headers.get("x-insightflare-client")).toBe(
      "insightflare-backend-v1",
    );
    expect(headers.get("x-insightflare-version")).toBeTruthy();
    expect(headers.get("x-insightflare-commit")).toBeTruthy();
    expect(headers.get("x-insightflare-host")).toBe("app.test");
    expect(headers.get("x-insightflare-protocol")).toBe("https");
    expect(headers.get("x-insightflare-locale")).toBe("zh");
    expect(headers.get("origin")).toBeNull();
  });

  it("rejects cross-origin and unsupported resource requests", async () => {
    const crossOriginRequest = request(
      "/api/public/resources/map/v1/styles/light/style.json",
    );
    crossOriginRequest.headers.set("referer", "https://evil.test/page");
    const crossOrigin = await handleMapRelayRequest(crossOriginRequest, env);
    const unsupported = await handleMapRelayRequest(
      request("/api/public/resources/map/v1/unknown.json"),
      env,
    );

    expect(crossOrigin.status).toBe(403);
    expect(unsupported.status).toBe(404);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("uses the safe relay fallback for invalid configurations", async () => {
    vi.mocked(fetch).mockImplementation(
      async () =>
        new Response("ok", { headers: { "content-type": "text/plain" } }),
    );

    const methodNotAllowed = await handleMapRelayRequest(
      request("/api/public/resources/map/v1/styles/light/style.json", {
        method: "POST",
      }),
      env,
    );
    expect(methodNotAllowed.status).toBe(405);
    expect(methodNotAllowed.headers.get("allow")).toBe("GET");

    const nonMapPath = await handleMapRelayRequest(request("/healthz"), env);
    expect(nonMapPath.status).toBe(404);

    const invalidConfig = await handleMapRelayRequest(
      request("/api/public/resources/map/v1/styles/light/style.json?locale=fr"),
      { MAP_RELAY_BASE_URL: "not-a-url" } as unknown as Env,
    );
    expect(invalidConfig.status).toBe(200);
    expect((vi.mocked(fetch).mock.calls[0]?.[0] as URL).toString()).toBe(
      "https://maprelay.ravelloh.com/v1/styles/light/style.json?if_origin=https%3A%2F%2Fapp.test",
    );

    const httpConfig = await handleMapRelayRequest(
      request("/api/public/resources/map/v1/tiles/carto.streets/v1/0/0/0.mvt"),
      { MAP_RELAY_BASE_URL: "http://maprelay.test" } as unknown as Env,
    );
    expect(httpConfig.status).toBe(200);
    expect((vi.mocked(fetch).mock.calls[1]?.[0] as URL).origin).toBe(
      "https://maprelay.ravelloh.com",
    );

    const noEnv = await handleMapRelayRequest(
      request("/api/public/resources/map/v1/styles/light/style.json"),
    );
    expect(noEnv.status).toBe(200);
    expect(vi.mocked(fetch).mock.calls).toHaveLength(3);
  });

  it("returns a gateway error when the relay cannot be reached", async () => {
    vi.mocked(fetch).mockRejectedValue(new Error("network unavailable"));

    const response = await handleMapRelayRequest(
      request("/api/public/resources/map/v1/tiles/carto.streets/v1/0/0/0.mvt"),
      env,
    );

    expect(response.status).toBe(502);
    expect(await response.text()).toBe("Map relay unavailable");
  });
});
