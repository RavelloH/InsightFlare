import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { handleWorldCountriesRequest } from "@/lib/edge/resources/world-countries";

describe("world countries handler", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("returns the first valid upstream feature collection", async () => {
    const payload = {
      type: "FeatureCollection",
      features: [{ type: "Feature", properties: {}, geometry: null }],
    };
    vi.mocked(fetch)
      .mockResolvedValueOnce(new Response("server error", { status: 500 }))
      .mockResolvedValueOnce(new Response(JSON.stringify(payload)));

    const response = await handleWorldCountriesRequest(
      new Request("https://app.test/api/public/resources/world-countries"),
    );

    expect(fetch).toHaveBeenCalledTimes(2);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe(
      "application/geo+json; charset=utf-8",
    );
    expect(response.headers.get("cache-control")).toContain("max-age=86400");
    expect(await response.json()).toEqual(payload);
  });

  it("falls through invalid JSON shapes and reports the last upstream status", async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(new Response(JSON.stringify({ type: "Feature" })))
      .mockResolvedValueOnce(new Response("not found", { status: 404 }));

    const response = await handleWorldCountriesRequest(
      new Request("https://app.test/api/public/resources/world-countries"),
    );

    expect(response.status).toBe(404);
    expect(await response.text()).toBe(
      "Countries GeoJSON upstream unavailable",
    );
  });

  it("falls through null payloads and fetch failures", async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(new Response("null"))
      .mockRejectedValueOnce(new Error("network unavailable"));

    const response = await handleWorldCountriesRequest(
      new Request("https://app.test/api/public/resources/world-countries"),
    );

    expect(fetch).toHaveBeenCalledTimes(2);
    expect(response.status).toBe(502);
    expect(await response.text()).toBe(
      "Countries GeoJSON upstream unavailable",
    );
  });
});
