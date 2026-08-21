import { describe, expect, it, vi } from "vitest";

import { RealtimeProvider } from "@/lib/edge/realtime-provider";

function env(response: Response | Error) {
  const fetch = vi.fn(async () => {
    if (response instanceof Error) throw response;
    return response;
  });
  return {
    env: {
      INGEST_DO: {
        idFromName: vi.fn(() => "stub-1"),
        get: vi.fn(() => ({ fetch })),
      },
    } as never,
    fetch,
  };
}

describe("RealtimeProvider", () => {
  it("encapsulates the snapshot request and applies the requested bounds", async () => {
    const { env: bindings, fetch } = env(
      new Response(JSON.stringify({ activeNow: 2, data: [] }), { status: 200 }),
    );
    await expect(
      new RealtimeProvider(bindings).snapshot({
        siteId: "site/a",
        fromMs: 10,
        toMs: 20,
        limit: 50,
      }),
    ).resolves.toEqual({ activeVisitors: 2, events: [], sessions: [] });
    expect(fetch).toHaveBeenCalledWith(
      "https://ingest.internal/snapshot?from=10&to=20&limit=50",
      expect.objectContaining({ method: "GET" }),
    );
  });

  it("maps provider failures and malformed snapshot payloads to data unavailable", async () => {
    const unavailable = env(new Response("down", { status: 503 }));
    await expect(
      new RealtimeProvider(unavailable.env).snapshot({
        siteId: "site-1",
        fromMs: 10,
        toMs: 20,
        limit: 1,
      }),
    ).rejects.toThrow("data-unavailable");

    const malformed = env(
      new Response(JSON.stringify({ activeNow: 1, data: ["not-a-record"] }), {
        status: 200,
      }),
    );
    await expect(
      new RealtimeProvider(malformed.env).snapshot({
        siteId: "site-1",
        fromMs: 10,
        toMs: 20,
        limit: 1,
      }),
    ).rejects.toThrow("data-unavailable");
    const arrayItem = env(
      new Response(JSON.stringify({ activeNow: 1, data: [[]] }), {
        status: 200,
      }),
    );
    await expect(
      new RealtimeProvider(arrayItem.env).snapshot({
        siteId: "site-1",
        fromMs: 10,
        toMs: 20,
        limit: 1,
      }),
    ).rejects.toThrow("data-unavailable");
    const missingData = env(
      new Response(JSON.stringify({ activeNow: 1 }), { status: 200 }),
    );
    await expect(
      new RealtimeProvider(missingData.env).snapshot({
        siteId: "site-1",
        fromMs: 10,
        toMs: 20,
        limit: 1,
      }),
    ).resolves.toMatchObject({ events: [] });

    const thrown = env(new Error("network"));
    await expect(
      new RealtimeProvider(thrown.env).snapshot({
        siteId: "site-1",
        fromMs: 10,
        toMs: 20,
        limit: 1,
      }),
    ).rejects.toThrow("data-unavailable");
  });

  it("reads a validated active visitor count and normalizes invalid values to zero", async () => {
    const valid = env(
      new Response(JSON.stringify({ activeNow: 3 }), { status: 200 }),
    );
    await expect(
      new RealtimeProvider(valid.env).activeVisitors({ siteId: "site-1" }),
    ).resolves.toBe(3);

    const invalid = env(
      new Response(JSON.stringify({ activeNow: -1 }), { status: 200 }),
    );
    await expect(
      new RealtimeProvider(invalid.env).activeVisitors({ siteId: "site-1" }),
    ).resolves.toBe(0);

    const unavailable = env(new Response("down", { status: 503 }));
    await expect(
      new RealtimeProvider(unavailable.env).activeVisitors({
        siteId: "site-1",
      }),
    ).rejects.toThrow("data-unavailable");
    const thrown = env(new Error("network"));
    await expect(
      new RealtimeProvider(thrown.env).activeVisitors({ siteId: "site-1" }),
    ).rejects.toThrow("data-unavailable");
  });
});
