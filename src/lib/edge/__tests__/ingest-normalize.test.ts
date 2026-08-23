import { describe, expect, it } from "vitest";

import type { RealtimeSnapshotRecord } from "@/lib/edge/ingest-normalize";
import {
  clampTimestamp,
  formatRealtimeOsLabel,
  jsonResponse,
  normalizePerformanceMetric,
  normalizePerformancePayload,
  resolveTrustedClientTimestamp,
  toRealtimePayload,
  toRealtimeScreenSize,
  toRealtimeVisitPayload,
} from "@/lib/edge/ingest-normalize";

describe("ingest normalization timestamp helpers", () => {
  it("clamps timestamps to positive finite integer values", () => {
    expect(clampTimestamp(1234.9, 5000)).toBe(1234);
    expect(clampTimestamp("2345.8", 5000)).toBe(2345);
    expect(clampTimestamp(0, 5000)).toBe(5000);
    expect(clampTimestamp(-1, 5000)).toBe(5000);
    expect(clampTimestamp(Number.NaN, 5000)).toBe(5000);
  });

  it("trusts only client timestamps within the accepted receive window", () => {
    const receivedAt = 1_700_000_000_000;

    expect(resolveTrustedClientTimestamp(receivedAt - 20_000, receivedAt)).toBe(
      receivedAt - 20_000,
    );
    expect(resolveTrustedClientTimestamp(receivedAt + 1, receivedAt)).toBe(
      receivedAt,
    );
    expect(resolveTrustedClientTimestamp(receivedAt - 30_001, receivedAt)).toBe(
      receivedAt,
    );
    expect(
      resolveTrustedClientTimestamp("bad", receivedAt, receivedAt - 1),
    ).toBe(receivedAt - 1);
  });
});

describe("ingest normalization performance helpers", () => {
  it("rounds finite non-negative metrics and drops invalid values", () => {
    expect(normalizePerformanceMetric(123.4567)).toBe(123.457);
    expect(normalizePerformanceMetric("1.2345")).toBe(1.235);
    expect(normalizePerformanceMetric(-1)).toBeNull();
    expect(normalizePerformanceMetric("bad")).toBeNull();
    expect(normalizePerformanceMetric(Number.POSITIVE_INFINITY)).toBeNull();
  });

  it("normalizes sparse performance payloads", () => {
    expect(
      normalizePerformancePayload({
        ttfb: "12.3456",
        fcp: -1,
        lcp: null,
        cls: 0.12345,
        inp: "bad",
      }),
    ).toEqual({
      ttfb: 12.346,
      cls: 0.123,
    });
    expect(normalizePerformancePayload({ ttfb: -1, cls: "bad" })).toBeNull();
    expect(normalizePerformancePayload(null)).toBeNull();
  });
});

describe("ingest normalization realtime payload helpers", () => {
  it("formats realtime screen sizes and OS labels defensively", () => {
    expect(toRealtimeScreenSize(1024.4, 768.6)).toBe("1024x769");
    expect(toRealtimeScreenSize(0, 768)).toBe("");
    expect(toRealtimeScreenSize(1024, -1)).toBe("");
    expect(toRealtimeScreenSize(null, 768)).toBe("");
    expect(toRealtimeScreenSize(Number.NaN, 768)).toBe("");

    expect(formatRealtimeOsLabel("Windows", "11")).toBe("Windows 11");
    expect(formatRealtimeOsLabel("Windows", " ")).toBe("Windows");
    expect(formatRealtimeOsLabel(" ", "14")).toBe("14");
    expect(formatRealtimeOsLabel(" ", " ")).toBe("");
  });

  it("maps realtime event rows with separate device fields", () => {
    const record: RealtimeSnapshotRecord = {
      id: "event-1",
      eventType: "pageview",
      eventAt: 1_700_000_000_000,
      visitId: "visit-1",
      sessionId: "session-1",
      pathname: "/docs",
      hash: "#intro",
      title: "Docs",
      hostname: "example.com",
      referrerUrl: "https://ref.example/start",
      referrerHost: "ref.example",
      visitorId: "visitor-1",
      country: "US",
      region: "CA",
      regionCode: "CA",
      city: "San Francisco",
      continent: "NA",
      timezone: "America/Los_Angeles",
      organization: "Example ISP",
      browser: "Chrome",
      os: "macOS",
      osVersion: "14",
      deviceType: "desktop",
      language: "en-US",
      screenWidth: 1440,
      screenHeight: 900,
      latitude: 37.7,
      longitude: -122.4,
    };

    expect(toRealtimePayload(record)).toMatchObject({
      id: "event-1",
      eventType: "pageview",
      os: "macOS",
      osVersion: "14",
      deviceType: "desktop",
      screenWidth: 1440,
      screenHeight: 900,
      screenSize: "1440x900",
    });
  });

  it("maps active visit rows into realtime visit payloads", () => {
    expect(
      toRealtimeVisitPayload({
        visitId: "visit-1",
        visitorId: "visitor-1",
        sessionId: "session-1",
        startedAt: 1_700_000_000_000,
        lastActivityAt: 1_700_000_010_000,
        pathname: "/pricing",
        hashFragment: "#plans",
        title: "Pricing",
        hostname: "example.com",
        referrerUrl: "",
        referrerHost: "",
        country: "US",
        region: "CA",
        regionCode: "CA",
        city: "San Francisco",
        continent: "NA",
        timezone: "America/Los_Angeles",
        asOrganization: "Example ISP",
        browser: "Chrome",
        os: "Windows",
        osVersion: "11",
        deviceType: "desktop",
        language: "en-US",
        screenWidth: 1440.2,
        screenHeight: 899.8,
        latitude: null,
        longitude: null,
      }),
    ).toMatchObject({
      visitId: "visit-1",
      hash: "#plans",
      organization: "Example ISP",
      os: "Windows",
      osVersion: "11",
      screenWidth: 1440.2,
      screenHeight: 899.8,
    });
  });

  it("serializes JSON responses with the edge content type", async () => {
    const response = jsonResponse({ ok: true }, 202);

    expect(response.status).toBe(202);
    expect(response.headers.get("content-type")).toBe(
      "application/json; charset=utf-8",
    );
    await expect(response.json()).resolves.toEqual({ ok: true });
  });
});
