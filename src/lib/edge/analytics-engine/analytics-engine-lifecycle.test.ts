import { describe, expect, it, vi } from "vitest";

import {
  writeEventAnalyticsPoint,
  writeTrafficPageviewFact,
  writeTrafficSessionEndedFact,
  writeTrafficVisitFinalizedFact,
} from "@/lib/edge/analytics-engine/index";
import type { AnalyticsEnginePoint } from "@/lib/edge/analytics-engine/schema";
import type {
  NormalizedCustomEvent,
  NormalizedPageview,
} from "@/lib/edge/types";

const context = {
  siteId: "site-1",
  visitId: "visit-1",
  visitorId: "visitor-1",
  sessionId: "session-1",
  startedAt: 1_000,
  pathname: "/pricing",
  queryString: "?plan=pro",
  hashFragment: "#hero",
  title: "Pricing",
  hostname: "example.test",
  referrerUrl: "https://search.example/",
  referrerHost: "search.example",
  utmSource: "search",
  utmMedium: "organic",
  utmCampaign: "launch",
  utmTerm: "plans",
  utmContent: "hero",
  isEU: false,
  country: "US",
  region: "CA",
  regionCode: "CA",
  city: "San Francisco",
  continent: "NA",
  latitude: 37.77,
  longitude: -122.4,
  postalCode: "94105",
  metroCode: "807",
  timezone: "America/Los_Angeles",
  asOrganization: "Example ISP",
  uaRaw: "Mozilla/5.0",
  browser: "Chrome",
  browserVersion: "126",
  os: "Windows",
  osVersion: "11",
  deviceType: "desktop",
  language: "en-US",
  screenWidth: 1440,
  screenHeight: 900,
} as const;

const pageview = {
  ...context,
  kind: "pageview",
  previousVisitId: "",
  previousVisitStartedAt: null,
  receivedAt: 1_100,
} satisfies NormalizedPageview;

function env(
  binding: keyof Pick<
    {
      REQUEST_ANALYTICS?: unknown;
      TRAFFIC_ANALYTICS?: unknown;
      EVENT_ANALYTICS?: unknown;
    },
    "TRAFFIC_ANALYTICS" | "EVENT_ANALYTICS"
  >,
  writeDataPoint: (point: AnalyticsEnginePoint) => void,
) {
  return {
    DB: {},
    INGEST_DO: {},
    [binding]: { writeDataPoint },
  } as never;
}

describe("Traffic and Event Analytics Engine projections", () => {
  it("writes a pageview fact with session counters and dimensions", () => {
    const writeDataPoint = vi.fn<(point: AnalyticsEnginePoint) => void>();

    writeTrafficPageviewFact(env("TRAFFIC_ANALYTICS", writeDataPoint), {
      record: pageview,
      sessionPageIndex: 1,
      sessionViewCount: 1,
    });

    const point = writeDataPoint.mock.calls[0]![0];
    expect(point.indexes).toEqual(["site-1"]);
    expect(point.blobs).toHaveLength(20);
    expect(point.doubles).toHaveLength(20);
    expect(point.blobs[0]).toBe("visit-1");
    expect(point.blobs[19]).toContain("queryString");
    expect(point.doubles.slice(0, 8)).toEqual([
      1, 1_000, 1_100, 1_000, 0, 0, 1, 1,
    ]);
    expect(point.doubles[17]).toBeGreaterThan(0);
    expect(point.doubles[19]).toBe(1);
  });

  it("writes visit finalization exactly from the transition snapshot", () => {
    const writeDataPoint = vi.fn<(point: AnalyticsEnginePoint) => void>();

    writeTrafficVisitFinalizedFact(env("TRAFFIC_ANALYTICS", writeDataPoint), {
      visit: {
        ...context,
        perfTtfbMs: 40,
        perfFcpMs: 80,
        perfLcpMs: 120,
        perfCls: 0.01,
        perfInpMs: 20,
      },
      receivedAt: 2_000,
      endedAt: 1_900,
      durationMs: 900,
      durationSource: "server",
      exitReason: "pagehide",
    });

    const point = writeDataPoint.mock.calls[0]![0];
    expect(point.doubles[0]).toBe(2);
    expect(point.doubles.slice(1, 6)).toEqual([
      1_900, 2_000, 1_000, 1_900, 900,
    ]);
    expect(JSON.parse(point.blobs[19])).toMatchObject({
      durationSource: "server",
      exitReason: "pagehide",
    });
  });

  it("writes a session-ended fact with the final page count", () => {
    const writeDataPoint = vi.fn<(point: AnalyticsEnginePoint) => void>();

    writeTrafficSessionEndedFact(env("TRAFFIC_ANALYTICS", writeDataPoint), {
      siteId: "site-1",
      sessionId: "session-1",
      visitorId: "visitor-1",
      startedAt: 1_000,
      lastActivityAt: 4_000,
      pageCount: 2,
      entryPath: "/home",
      lastPath: "/pricing",
      lastVisitId: "visit-2",
      nextDueAt: 5_000,
      receivedAt: 5_100,
      endedAt: 5_000,
      lastVisit: {
        ...context,
        title: "Pricing",
      },
    });

    const point = writeDataPoint.mock.calls[0]![0];
    expect(point.doubles.slice(0, 8)).toEqual([
      3, 5_000, 5_100, 1_000, 5_000, 4_000, 2, 2,
    ]);
    expect(JSON.parse(point.blobs[19])).toMatchObject({
      durationSource: "session_timeout",
      entryPath: "/home",
      exitReason: "session_timeout",
    });
  });

  it("keeps complete normalized custom-event data in payloadJson", () => {
    const writeDataPoint = vi.fn<(point: AnalyticsEnginePoint) => void>();
    const record = {
      ...context,
      kind: "custom_event",
      eventId: "event-1",
      sequence: 3,
      receivedAt: 2_000,
      eventAt: 1_950,
      eventName: "checkout",
      eventDataJson: JSON.stringify({
        order: { id: "order-123", total: 99.5 },
        items: [{ sku: "sku-1", quantity: 2 }],
      }),
    } satisfies NormalizedCustomEvent;

    writeEventAnalyticsPoint(env("EVENT_ANALYTICS", writeDataPoint), record);

    const point = writeDataPoint.mock.calls[0]![0];
    expect(point.indexes).toEqual(["site-1"]);
    expect(point.blobs).toHaveLength(20);
    expect(point.doubles).toHaveLength(20);
    expect(JSON.parse(point.blobs[19])).toMatchObject({
      eventData: {
        order: { id: "order-123", total: 99.5 },
        items: [{ sku: "sku-1", quantity: 2 }],
      },
    });
    expect(point.doubles.slice(0, 4)).toEqual([1_950, 2_000, 1_000, 3]);
  });

  it("does not let a failed Analytics Engine write fail the caller", () => {
    const writeDataPoint = vi.fn(() => {
      throw new Error("AE unavailable");
    });
    expect(() =>
      writeTrafficPageviewFact(env("TRAFFIC_ANALYTICS", writeDataPoint), {
        record: pageview,
        sessionPageIndex: 1,
      }),
    ).not.toThrow();
  });

  it("keeps optional lifecycle fields and missing bindings best-effort", () => {
    const logger = {
      error: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
    };
    const sparsePageview = {
      ...pageview,
      continent: "",
      country: "",
      deviceType: "unknown",
      latitude: null,
      longitude: null,
      screenHeight: null,
      screenWidth: null,
    } satisfies NormalizedPageview;
    const missingBinding = { DB: {}, INGEST_DO: {} } as never;

    expect(() =>
      writeTrafficPageviewFact(
        missingBinding,
        { record: sparsePageview, sessionPageIndex: 0 },
        logger,
      ),
    ).not.toThrow();
    expect(() =>
      writeTrafficVisitFinalizedFact(
        missingBinding,
        {
          visit: {
            ...context,
            latitude: null,
            longitude: null,
            screenHeight: null,
            screenWidth: null,
          },
          receivedAt: 2_000,
        },
        logger,
      ),
    ).not.toThrow();
    expect(() =>
      writeTrafficSessionEndedFact(
        missingBinding,
        {
          siteId: "site-1",
          sessionId: "session-1",
          visitorId: "visitor-1",
          startedAt: 1_000,
          lastActivityAt: 4_000,
          pageCount: 2,
          entryPath: "/home",
          lastPath: "/pricing",
          lastVisitId: "visit-2",
          nextDueAt: 5_000,
          receivedAt: 5_100,
          endedAt: 5_000,
        },
        logger,
      ),
    ).not.toThrow();

    const eventRecord = {
      ...context,
      eventAt: 0,
      eventDataJson: "{}",
      eventId: "event-1",
      eventName: "checkout",
      kind: "custom_event",
      receivedAt: 2_000,
      sequence: Number.NaN,
    } satisfies NormalizedCustomEvent;
    expect(() =>
      writeEventAnalyticsPoint(missingBinding, eventRecord, logger),
    ).not.toThrow();
    expect(logger.warn).toHaveBeenCalledTimes(4);
  });
});
