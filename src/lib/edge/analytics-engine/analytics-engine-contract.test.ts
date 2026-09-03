import { describe, expect, it, vi } from "vitest";

import {
  decodeDimensionCode,
  encodeDimensionCode,
  EVENT_ANALYTICS_BLOBS,
  EVENT_ANALYTICS_DOUBLES,
  hasRequestFlag,
  REQUEST_ANALYTICS_BLOBS,
  REQUEST_ANALYTICS_DOUBLES,
  REQUEST_ANALYTICS_FLAGS,
  safeStringify,
  TRAFFIC_ANALYTICS_BLOBS,
  TRAFFIC_ANALYTICS_DOUBLES,
  writeRequestAnalyticsPoint,
} from "@/lib/edge/analytics-engine/index";
import type { RequestAnalyticsEnvironment } from "@/lib/edge/analytics-engine/request-writer";
import type { AnalyticsEnginePoint } from "@/lib/edge/analytics-engine/schema";
import type { TrackerClientPayload } from "@/lib/edge/types";

function request(cf: Record<string, unknown>): Request {
  const value = new Request("https://collector.test/collect?source=browser", {
    method: "POST",
    headers: {
      "cf-connecting-ip": "203.0.113.10",
      "cf-ray": "ray-1",
      referer: "https://example.test/from",
      "sec-fetch-site": "same-origin",
      "sec-fetch-mode": "cors",
      "sec-fetch-dest": "empty",
      "user-agent": "Mozilla/5.0",
    },
  });
  Object.defineProperty(value, "cf", { configurable: true, value: cf });
  return value;
}

function environment(writeDataPoint: (point: AnalyticsEnginePoint) => void) {
  return {
    DB: {},
    INGEST_DO: {},
    REQUEST_ANALYTICS: { writeDataPoint },
  } as unknown as RequestAnalyticsEnvironment;
}

describe("Analytics Engine v2 contract", () => {
  it("keeps all published slot arrays within the AE contract", () => {
    expect(REQUEST_ANALYTICS_BLOBS).toEqual([
      "kind",
      "category",
      "reasons",
      "ip",
      "userAgent",
      "origin",
      "hostname",
      "pathname",
      "country",
      "region",
      "city",
      "continent",
      "colo",
      "asOrganization",
      "verifiedBotCategory",
      "rayId",
      "traceId",
      "requestMethod",
      "httpProtocol",
      "metadataJson",
    ]);
    expect(REQUEST_ANALYTICS_DOUBLES).toHaveLength(20);
    expect(TRAFFIC_ANALYTICS_BLOBS).toHaveLength(20);
    expect(TRAFFIC_ANALYTICS_DOUBLES).toHaveLength(20);
    expect(EVENT_ANALYTICS_BLOBS).toHaveLength(20);
    expect(EVENT_ANALYTICS_DOUBLES).toHaveLength(20);
  });

  it("round-trips supported dimension codes and rejects unknown values", () => {
    for (const input of [
      ["country", "US"],
      ["continent", "NA"],
      ["deviceType", "mobile"],
      ["trafficChannel", "organic"],
    ] as const) {
      const code = encodeDimensionCode(input[0], input[1]);
      expect(code).toBeGreaterThan(0);
      expect(decodeDimensionCode(code)).toEqual({
        dimension: input[0],
        value: input[1],
      });
    }
    expect(encodeDimensionCode("deviceType", "not-a-device")).toBe(0);
    expect(decodeDimensionCode(0)).toBeNull();
  });

  it("writes request slots with siteId only in index1 and explicit presence flags", () => {
    const writeDataPoint = vi.fn<(point: AnalyticsEnginePoint) => void>();
    const payload: TrackerClientPayload = {
      kind: "pageview",
      startedAt: 1_000,
      timestamp: 2_000,
      hostname: "Example.TEST",
      pathname: "/pricing?plan=pro",
      eventId: "event-1",
      visitId: "visit-1",
      visibilityState: "visible",
    };
    vi.spyOn(Date, "now").mockReturnValue(1_025);

    writeRequestAnalyticsPoint(environment(writeDataPoint), {
      request: request({
        country: "US",
        region: "CA",
        city: "San Francisco",
        continent: "NA",
        colo: "SFO",
        asn: "13335",
        asOrganization: "Cloudflare",
        httpProtocol: "HTTP/3",
        latitude: 37.7749,
        longitude: -122.4194,
        botManagement: { score: 12 },
        clientTcpRtt: 8,
        tlsClientHelloLength: 256,
      }),
      payload,
      siteId: "site-1",
      origin: "https://example.test",
      traceId: "trace-1",
      receivedAt: 1_000,
      category: "bot",
      disposition: "blocked",
      reasons: ["cf_bot_score_low"],
    });

    expect(writeDataPoint).toHaveBeenCalledTimes(1);
    const point = writeDataPoint.mock.calls[0][0];
    expect(point.indexes).toEqual(["site-1"]);
    expect(point.blobs).toHaveLength(20);
    expect(point.blobs.slice(0, 8)).toEqual([
      "pageview",
      "bot",
      "cf_bot_score_low",
      "203.0.113.10",
      "Mozilla/5.0",
      "https://example.test",
      "example.test",
      "/pricing",
    ]);
    expect(point.doubles).toHaveLength(20);
    expect(point.doubles.slice(0, 11)).toEqual([
      1_000,
      1_000,
      25,
      13_335,
      37.7749,
      -122.4194,
      12,
      "Mozilla/5.0".length,
      8,
      0,
      256,
    ]);
    expect(
      hasRequestFlag(point.doubles[18], REQUEST_ANALYTICS_FLAGS.eventAtPresent),
    ).toBe(true);
    expect(
      hasRequestFlag(
        point.doubles[18],
        REQUEST_ANALYTICS_FLAGS.edgeLatencyPresent,
      ),
    ).toBe(true);
    expect(
      hasRequestFlag(
        point.doubles[18],
        REQUEST_ANALYTICS_FLAGS.coordinatePresent,
      ),
    ).toBe(true);
    expect(
      hasRequestFlag(
        point.doubles[18],
        REQUEST_ANALYTICS_FLAGS.botScorePresent,
      ),
    ).toBe(true);
    expect(
      hasRequestFlag(
        point.doubles[18],
        REQUEST_ANALYTICS_FLAGS.dispositionBlocked,
      ),
    ).toBe(true);
    expect(point.doubles[19]).toBe(2);
    expect(JSON.parse(point.blobs[19])).toMatchObject({
      requestPathname: "/collect",
      eventId: "event-1",
      visitId: "visit-1",
    });
  });

  it.each(["normal", "suspected_bot", "custom_block"] as const)(
    "does not write IP addresses for %s requests",
    (category) => {
      const writeDataPoint = vi.fn<(point: AnalyticsEnginePoint) => void>();
      const payload: TrackerClientPayload = {
        kind: "pageview",
        startedAt: 1_000,
        timestamp: 2_000,
        hostname: "example.test",
        pathname: "/",
        visitId: "visit-1",
      };

      writeRequestAnalyticsPoint(environment(writeDataPoint), {
        request: request({}),
        payload,
        siteId: "site-1",
        origin: "https://example.test",
        traceId: "trace-1",
        receivedAt: 1_000,
        category,
        disposition: category === "custom_block" ? "blocked" : "included",
        reasons: [],
      });

      expect(writeDataPoint).toHaveBeenCalledTimes(1);
      expect(writeDataPoint.mock.calls[0]?.[0]?.blobs?.[3]).toBe("");
    },
  );

  it("does not write an IP for a bot request that is included by policy", () => {
    const writeDataPoint = vi.fn<(point: AnalyticsEnginePoint) => void>();

    writeRequestAnalyticsPoint(environment(writeDataPoint), {
      request: request({ "cf-connecting-ip": "203.0.113.10" }),
      payload: {
        kind: "pageview",
        startedAt: 1_000,
        timestamp: 2_000,
        hostname: "example.test",
        pathname: "/",
        visitId: "visit-1",
      },
      siteId: "site-1",
      origin: "https://example.test",
      traceId: "trace-1",
      receivedAt: 1_000,
      category: "bot",
      disposition: "included",
      reasons: ["script_ua"],
    });

    expect(writeDataPoint).toHaveBeenCalledTimes(1);
    expect(writeDataPoint.mock.calls[0]?.[0]?.blobs?.[3]).toBe("");
  });

  it("keeps metadata JSON valid and bounded even for cyclic values", () => {
    const cyclic: Record<string, unknown> = { value: "x".repeat(20_000) };
    cyclic.self = cyclic;
    const serialized = safeStringify({ botManagement: cyclic });

    expect(serialized.length).toBeLessThanOrEqual(8_192);
    expect(() => JSON.parse(serialized)).not.toThrow();
  });
});
