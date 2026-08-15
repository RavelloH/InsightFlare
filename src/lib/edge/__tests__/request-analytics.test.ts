import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  NORMAL_ANALYTICS_BLOBS,
  NORMAL_ANALYTICS_DOUBLES,
  writeNormalAnalyticsEvent,
} from "@/lib/edge/request-analytics";
import type { Env, TrackerClientPayload } from "@/lib/edge/types";

interface AnalyticsDataPoint {
  indexes: string[];
  blobs: string[];
  doubles: number[];
}

type AnalyticsWriter = (point: AnalyticsDataPoint) => void;

function analyticsWriter(implementation?: AnalyticsWriter) {
  return vi.fn<AnalyticsWriter>(implementation);
}

function request(headers: HeadersInit = {}, cf?: Record<string, unknown>) {
  const inputHeaders = new Headers(headers);
  const req = new Request("https://collector.test/collect?x=1", {
    method: "PATCH",
    headers: inputHeaders,
  });
  vi.spyOn(req.headers, "get").mockImplementation((name) =>
    inputHeaders.get(name),
  );
  if (cf) {
    Object.defineProperty(req, "cf", {
      value: cf,
      configurable: true,
    });
  }
  return req;
}

function env(writeDataPoint: AnalyticsWriter = vi.fn<AnalyticsWriter>()): Env {
  return {
    DB: {} as D1Database,
    INGEST_DO: {} as DurableObjectNamespace,
    NORMAL_ANALYTICS: {
      writeDataPoint,
    } as unknown as AnalyticsEngineDataset,
  } as Env;
}

function logger() {
  return { warn: vi.fn(), error: vi.fn() };
}

const basePayload: TrackerClientPayload = {
  siteId: "site-1",
  kind: "pageview",
  visitId: "visit-1",
  previousVisitId: "previous-visit",
  eventId: "event-1",
  startedAt: 999_900,
  timestamp: 999_950,
  hostname: "Example.COM",
  pathname: "https://example.com/pricing?plan=pro#hero",
  visitorId: "visitor-1",
  userId: "user-1",
  eventName: "signup",
  visibilityState: "visible",
};

describe("normal request Analytics Engine writes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, "error").mockImplementation(() => undefined);
  });

  it("keeps the normal request schema within AE data point limits", () => {
    expect(NORMAL_ANALYTICS_BLOBS).toHaveLength(16);
    expect(NORMAL_ANALYTICS_DOUBLES.length).toBeLessThanOrEqual(20);
  });

  it("writes normalized pageview data points", () => {
    const writeDataPoint = analyticsWriter();
    const testEnv = env(writeDataPoint);

    writeNormalAnalyticsEvent(testEnv, {
      request: request(
        {
          "user-agent": "Mozilla/5.0",
          "cf-ray": "ray-1",
          "sec-fetch-site": "same-origin",
          "sec-fetch-mode": "cors",
          "sec-fetch-dest": "empty",
        },
        {
          country: "US",
          region: "CA",
          city: "San Francisco",
          continent: "NA",
          colo: "SFO",
          asn: "13335",
          asOrganization: "Cloudflare Inc.",
          latitude: "37.7749",
          longitude: "-122.4194",
          httpProtocol: "HTTP/3",
        },
      ),
      payload: basePayload,
      siteId: "site-1",
      origin: "https://example.com",
      traceId: "trace-1",
      receivedAt: 1_000_000,
    });

    expect(writeDataPoint).toHaveBeenCalledTimes(1);
    const point = writeDataPoint.mock.calls[0][0];
    expect(point.indexes).toEqual(["site-1"]);
    expect(point.blobs.slice(0, 6)).toEqual([
      "site-1",
      "pageview",
      "https://example.com",
      "example.com",
      "/pricing",
      "US",
    ]);
    expect(point.blobs[12]).toBe("ray-1");
    expect(point.blobs[13]).toBe("trace-1");
    expect(point.blobs[14]).toBe("PATCH");
    expect(JSON.parse(point.blobs[15])).toMatchObject({
      eventId: "event-1",
      visitId: "visit-1",
      previousVisitId: "previous-visit",
      hasVisitorId: true,
      hasUserId: true,
      eventName: "signup",
      visibilityState: "visible",
      secFetchSite: "same-origin",
      httpProtocol: "HTTP/3",
    });
    expect(point.doubles).toEqual([
      1_000_000,
      999_900,
      100,
      13335,
      37.7749,
      -122.4194,
      "Mozilla/5.0".length,
    ]);
  });

  it("skips writes when AE is disabled or unbound", () => {
    const disabledWriter = analyticsWriter();
    writeNormalAnalyticsEvent(
      {
        ...env(disabledWriter),
        INSIGHTFLARE_ANALYTICS_ENGINE_DISABLED: "yes",
      },
      {
        request: request(),
        payload: basePayload,
        siteId: "site-1",
        origin: null,
        traceId: "trace-1",
        receivedAt: 1_000_000,
      },
    );
    expect(disabledWriter).not.toHaveBeenCalled();

    writeNormalAnalyticsEvent(
      {
        DB: {} as D1Database,
        INGEST_DO: {} as DurableObjectNamespace,
      } as Env,
      {
        request: request(),
        payload: basePayload,
        siteId: "site-1",
        origin: null,
        traceId: "trace-1",
        receivedAt: 1_000_000,
      },
    );
  });

  it("handles custom events, invalid URL pathnames, missing values, and write errors", () => {
    const writeDataPoint = analyticsWriter(() => {
      throw new Error("write failed");
    });

    const invocationLogger = logger();
    writeNormalAnalyticsEvent(
      env(writeDataPoint),
      {
        request: request(
          {
            "user-agent": "bot".repeat(400),
            "cf-ray": "ray-2",
          },
          {
            asn: "bad",
            latitude: "bad",
            longitude: undefined,
          },
        ),
        payload: {
          kind: "custom_event",
          timestamp: 2_000,
          startedAt: 1_000,
          hostname: "",
          pathname: "https://%",
        },
        siteId: "",
        origin: null,
        traceId: "trace-2",
        receivedAt: 1_000,
      },
      invocationLogger,
    );

    expect(writeDataPoint).toHaveBeenCalledTimes(1);
    const point = writeDataPoint.mock.calls[0][0];
    expect(point.indexes).toEqual(["unknown"]);
    expect(point.blobs[0]).toBe("");
    expect(point.blobs[1]).toBe("custom_event");
    expect(point.blobs[3]).toBe("");
    expect(point.blobs[4]).toBe("");
    expect(point.doubles[1]).toBe(2_000);
    expect(point.doubles[2]).toBe(0);
    expect(point.doubles[3]).toBe(0);
    expect(point.doubles[4]).toBe(0);
    expect(point.doubles[5]).toBe(0);
    expect(point.doubles[6]).toBe(1024);
    expect(invocationLogger.error).toHaveBeenCalledWith(
      "collect.normal_analytics_write_failed",
    );
  });

  it("normalizes relative paths, fallback timestamps, and missing request metadata", () => {
    const writeDataPoint = analyticsWriter();

    const invocationLogger = logger();
    writeNormalAnalyticsEvent(
      env(writeDataPoint),
      {
        request: request(),
        payload: {
          kind: "pageview",
          timestamp: 0,
          startedAt: 0,
          hostname: "EXAMPLE.test",
          pathname: "/docs?utm=source#intro",
        },
        siteId: "site-2",
        origin: null,
        traceId: "trace-3",
        receivedAt: 3_000,
      },
      invocationLogger,
    );

    const point = writeDataPoint.mock.calls[0][0];
    expect(point.blobs[3]).toBe("example.test");
    expect(point.blobs[4]).toBe("/docs");
    expect(point.blobs[12]).toBe("");
    expect(point.doubles[1]).toBe(3_000);
    expect(point.doubles[2]).toBe(0);
  });

  it("normalizes blank pathnames and non-Error write failures", () => {
    const writeDataPoint = analyticsWriter(() => {
      throw "write failed";
    });
    const invocationLogger = logger();

    writeNormalAnalyticsEvent(
      env(writeDataPoint),
      {
        request: request({}, {}),
        payload: {
          kind: "" as TrackerClientPayload["kind"],
          timestamp: Number.NaN,
          startedAt: undefined,
          hostname: "",
          pathname: "",
        },
        siteId: "site-3",
        origin: "",
        traceId: "trace-4",
        receivedAt: 4_000,
      },
      invocationLogger,
    );

    const point = writeDataPoint.mock.calls[0][0];
    expect(point.blobs[1]).toBe("");
    expect(point.blobs[4]).toBe("");
    expect(point.doubles[1]).toBe(4_000);
    expect(invocationLogger.error).toHaveBeenCalledWith(
      "collect.normal_analytics_write_failed",
    );
  });
});
