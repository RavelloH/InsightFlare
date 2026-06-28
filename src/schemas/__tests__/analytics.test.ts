import { describe, expect, it } from "vitest";

import {
  AnalyticsQueryParamsSchema,
  BatchInputSchema,
  BatchResponseSchema,
  BrowserVersionBrowserSchema,
  CrossBreakdownMatrixSchema,
  DashboardFiltersSchema,
  DimensionRowSchema,
  EventsSummaryDataSchema,
  EventTypeRowSchema,
  GeoPointRowSchema,
  GeoTabRowSchema,
  OverviewDataSchema,
  OverviewResponseSchema,
  PageRowSchema,
  PaginatedQueryParamsSchema,
  PerformanceSummaryRowSchema,
  QueryNameSchema,
  ReferrerRowSchema,
  RetentionCohortSchema,
  SessionRowSchema,
  TrendRowSchema,
  VisitorRowSchema,
} from "@/schemas/analytics";

describe("QueryNameSchema", () => {
  it("accepts all known query names", () => {
    const names = [
      "overview",
      "trend",
      "pages",
      "referrers",
      "funnels",
      "sessions",
      "visitors",
      "retention",
      "performance",
      "countries",
      "events-summary",
      "events-trend",
    ];
    for (const name of names) {
      expect(QueryNameSchema.safeParse(name).success).toBe(true);
    }
  });

  it("rejects unknown query name", () => {
    expect(QueryNameSchema.safeParse("unknown-query").success).toBe(false);
  });
});

describe("AnalyticsQueryParamsSchema", () => {
  it("accepts empty params (all optional)", () => {
    const result = AnalyticsQueryParamsSchema.safeParse({ interval: "day" });
    expect(result.success).toBe(true);
  });

  it("requires interval field", () => {
    const result = AnalyticsQueryParamsSchema.safeParse({});
    expect(result.success).toBe(false);
  });

  it("accepts valid params", () => {
    const result = AnalyticsQueryParamsSchema.safeParse({
      from: 1700000000000,
      to: 1700086400000,
      interval: "hour",
      timeZone: "America/New_York",
      limit: 100,
    });
    expect(result.success).toBe(true);
  });

  it("coerces string numbers for from/to", () => {
    const result = AnalyticsQueryParamsSchema.safeParse({
      from: "1700000000000",
      to: "1700086400000",
      interval: "day",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(typeof result.data.from).toBe("number");
      expect(typeof result.data.to).toBe("number");
    }
  });
});

describe("PaginatedQueryParamsSchema", () => {
  it("applies defaults", () => {
    const result = PaginatedQueryParamsSchema.safeParse({ interval: "day" });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.page).toBe(1);
      expect(result.data.sortDir).toBe("desc");
    }
  });

  it("rejects page < 1", () => {
    expect(PaginatedQueryParamsSchema.safeParse({ page: 0 }).success).toBe(
      false,
    );
  });
});

describe("DashboardFiltersSchema", () => {
  it("accepts empty filters", () => {
    expect(DashboardFiltersSchema.safeParse({}).success).toBe(true);
  });

  it("accepts all filter fields", () => {
    expect(
      DashboardFiltersSchema.safeParse({
        country: "US",
        device: "desktop",
        browser: "Chrome",
        path: "/home",
        sourceDomain: "google.com",
        geoCountry: "US",
        geoRegion: "CA",
        geoCity: "SF",
      }).success,
    ).toBe(true);
  });
});

describe("OverviewDataSchema", () => {
  it("accepts valid overview", () => {
    expect(
      OverviewDataSchema.safeParse({
        views: 1000,
        sessions: 500,
        visitors: 300,
        bounces: 100,
        totalDurationMs: 600000,
        avgDurationMs: 1200,
        bounceRate: 20,
        approximateVisitors: false,
      }).success,
    ).toBe(true);
  });

  it("rejects float for integer fields", () => {
    expect(
      OverviewDataSchema.safeParse({
        views: 1.5,
        sessions: 500,
        visitors: 300,
        bounces: 100,
        totalDurationMs: 600000,
        avgDurationMs: 1200,
        bounceRate: 20,
        approximateVisitors: false,
      }).success,
    ).toBe(false);
  });
});

describe("TrendRowSchema", () => {
  it("accepts valid trend row", () => {
    expect(
      TrendRowSchema.safeParse({
        bucket: 1700000000000,
        timestampMs: 1700000000000,
        views: 100,
        visitors: 50,
        sessions: 30,
      }).success,
    ).toBe(true);
  });

  it("accepts optional fields", () => {
    expect(
      TrendRowSchema.safeParse({
        bucket: 1,
        timestampMs: 1,
        views: 1,
        visitors: 1,
        sessions: 1,
        bounces: 0,
        totalDurationMs: 1000,
        avgDurationMs: 500,
      }).success,
    ).toBe(true);
  });
});

describe("PageRowSchema", () => {
  it("accepts valid page row", () => {
    expect(
      PageRowSchema.safeParse({
        pathname: "/home",
        views: 100,
        sessions: 50,
      }).success,
    ).toBe(true);
  });
});

describe("ReferrerRowSchema", () => {
  it("accepts valid referrer row", () => {
    expect(
      ReferrerRowSchema.safeParse({
        referrer: "google.com",
        views: 100,
        sessions: 50,
      }).success,
    ).toBe(true);
  });
});

describe("VisitorRowSchema", () => {
  it("accepts valid visitor row", () => {
    expect(
      VisitorRowSchema.safeParse({
        visitorId: "550e8400-e29b-41d4-a716-446655440000",
        firstSeenAt: 1700000000,
        lastSeenAt: 1700000100,
        views: 10,
        sessions: 3,
      }).success,
    ).toBe(true);
  });

  it("accepts optional geo and device fields", () => {
    expect(
      VisitorRowSchema.safeParse({
        visitorId: "550e8400-e29b-41d4-a716-446655440000",
        firstSeenAt: 1700000000,
        lastSeenAt: 1700000100,
        views: 1,
        sessions: 1,
        country: "US",
        region: "CA",
        city: "SF",
        browser: "Chrome",
        os: "macOS",
        deviceType: "desktop",
      }).success,
    ).toBe(true);
  });
});

describe("SessionRowSchema", () => {
  it("accepts valid session row", () => {
    expect(
      SessionRowSchema.safeParse({
        sessionId: "550e8400-e29b-41d4-a716-446655440000",
        visitorId: "550e8400-e29b-41d4-a716-446655440001",
        startedAt: 1700000000,
        endedAt: 1700000100,
        durationMs: 100000,
        active: false,
        views: 5,
        events: 2,
        bounce: false,
        entryPath: "/",
        exitPath: "/about",
        country: "US",
        browser: "Chrome",
        os: "macOS",
        deviceType: "desktop",
      }).success,
    ).toBe(true);
  });

  it("accepts optional performance metrics", () => {
    expect(
      SessionRowSchema.safeParse({
        sessionId: "550e8400-e29b-41d4-a716-446655440000",
        visitorId: "550e8400-e29b-41d4-a716-446655440001",
        startedAt: 1700000000,
        endedAt: 1700000100,
        durationMs: 100000,
        active: false,
        views: 1,
        events: 0,
        bounce: false,
        entryPath: "/",
        exitPath: "/",
        country: "US",
        browser: "Chrome",
        os: "macOS",
        deviceType: "desktop",
        performance: { ttfb: 100, fcp: 200, lcp: 500, cls: 0.05, inp: 50 },
      }).success,
    ).toBe(true);
  });
});

describe("RetentionCohortSchema", () => {
  it("accepts valid cohort", () => {
    expect(
      RetentionCohortSchema.safeParse({
        bucket: 1700000000000,
        size: 100,
        periods: [
          { index: 0, visitors: 100, rate: 1 },
          { index: 1, visitors: 50, rate: 0.5 },
        ],
      }).success,
    ).toBe(true);
  });
});

describe("PerformanceSummaryRowSchema", () => {
  it("accepts valid performance summary", () => {
    expect(
      PerformanceSummaryRowSchema.safeParse({
        ttfb: { avg: 100, p50: 80, p75: 120, p95: 200, samples: 500 },
        fcp: { avg: 200, p50: 180, p75: 220, p95: 400, samples: 500 },
        lcp: { avg: 500, p50: 400, p75: 600, p95: 1000, samples: 500 },
        cls: { avg: 0.05, p50: 0.03, p75: 0.07, p95: 0.15, samples: 500 },
        inp: { avg: 50, p50: 40, p75: 60, p95: 100, samples: 500 },
      }).success,
    ).toBe(true);
  });

  it("accepts null metric values", () => {
    expect(
      PerformanceSummaryRowSchema.safeParse({
        ttfb: { avg: null, p50: null, p75: null, p95: null, samples: 0 },
        fcp: { avg: null, p50: null, p75: null, p95: null, samples: 0 },
        lcp: { avg: null, p50: null, p75: null, p95: null, samples: 0 },
        cls: { avg: null, p50: null, p75: null, p95: null, samples: 0 },
        inp: { avg: null, p50: null, p75: null, p95: null, samples: 0 },
      }).success,
    ).toBe(true);
  });
});

describe("EventTypeRowSchema", () => {
  it("accepts valid event type row", () => {
    expect(
      EventTypeRowSchema.safeParse({
        label: "button_click",
        views: 100,
        sessions: 50,
        visitors: 30,
      }).success,
    ).toBe(true);
  });
});

describe("EventsSummaryDataSchema", () => {
  it("accepts valid summary", () => {
    expect(
      EventsSummaryDataSchema.safeParse({
        summary: {
          events: 100,
          eventTypes: 5,
          sessions: 50,
          visitors: 30,
          avgEventsPerSession: 2,
        },
        cards: {
          event: { name: [] },
          page: { path: [], title: [], hostname: [] },
        },
      }).success,
    ).toBe(true);
  });
});

describe("BrowserVersionBrowserSchema", () => {
  it("accepts valid browser version data", () => {
    expect(
      BrowserVersionBrowserSchema.safeParse({
        browser: "Chrome",
        views: 1000,
        visitors: 500,
        sessions: 600,
        versions: [
          {
            key: "120",
            label: "120",
            views: 500,
            visitors: 300,
            sessions: 350,
          },
        ],
      }).success,
    ).toBe(true);
  });
});

describe("CrossBreakdownMatrixSchema", () => {
  it("accepts valid matrix", () => {
    expect(
      CrossBreakdownMatrixSchema.safeParse({
        columns: [
          {
            key: "win",
            label: "Windows",
            views: 100,
            visitors: 50,
            sessions: 60,
          },
        ],
        rows: [
          {
            key: "chrome",
            label: "Chrome",
            views: 100,
            visitors: 50,
            sessions: 60,
            cells: [
              {
                key: "win-chrome",
                label: "Chrome/Win",
                views: 80,
                visitors: 40,
                sessions: 50,
              },
            ],
          },
        ],
        totalVisitors: 50,
      }).success,
    ).toBe(true);
  });
});

describe("GeoPointRowSchema", () => {
  it("accepts valid geo point", () => {
    expect(
      GeoPointRowSchema.safeParse({
        latitude: 37.7749,
        longitude: -122.4194,
        timestampMs: 1700000000000,
        country: "US",
        region: "CA",
        regionCode: "CA",
        city: "San Francisco",
      }).success,
    ).toBe(true);
  });
});

describe("DimensionRowSchema", () => {
  it("accepts valid dimension row", () => {
    expect(
      DimensionRowSchema.safeParse({
        label: "/home",
        views: 100,
        sessions: 50,
        visitors: 30,
      }).success,
    ).toBe(true);
  });
});

describe("GeoTabRowSchema", () => {
  it("accepts valid geo tab row", () => {
    expect(
      GeoTabRowSchema.safeParse({
        value: "US",
        label: "United States",
        views: 1000,
        sessions: 500,
        visitors: 300,
      }).success,
    ).toBe(true);
  });
});

describe("BatchInputSchema", () => {
  it("accepts valid batch input", () => {
    expect(
      BatchInputSchema.safeParse({
        requests: [
          {
            id: "overview",
            method: "GET",
            path: "/api/v1/sites/site-1/analytics/overview",
            query: { preset: "last_7_days" },
          },
        ],
      }).success,
    ).toBe(true);
  });

  it("rejects empty requests array", () => {
    expect(BatchInputSchema.safeParse({ requests: [] }).success).toBe(false);
  });

  it("rejects more than 20 requests", () => {
    const requests = Array.from({ length: 21 }, (_, index) => ({
      id: `overview-${index}`,
      method: "GET",
      path: "/api/v1/sites/site-1/analytics/overview",
    }));
    expect(BatchInputSchema.safeParse({ requests }).success).toBe(false);
  });

  it("rejects non-GET subrequests and non-v1 paths", () => {
    expect(
      BatchInputSchema.safeParse({
        requests: [
          {
            id: "bad",
            method: "POST",
            path: "/api/v1/sites/site-1/analytics/overview",
          },
        ],
      }).success,
    ).toBe(false);
    expect(
      BatchInputSchema.safeParse({
        requests: [{ id: "bad", method: "GET", path: "/collect/event" }],
      }).success,
    ).toBe(false);
  });
});

describe("BatchResponseSchema", () => {
  it("accepts valid batch response", () => {
    expect(
      BatchResponseSchema.safeParse({
        ok: true,
        requestId: "r",
        timestamp: "t",
        data: {
          responses: [
            { id: "overview", status: 200, body: { data: {} } },
            { id: "trend", status: 400, body: { error: {} } },
          ],
        },
        meta: {
          partialFailure: true,
        },
      }).success,
    ).toBe(true);
  });
});

describe("OverviewResponseSchema", () => {
  it("accepts valid overview response envelope", () => {
    expect(
      OverviewResponseSchema.safeParse({
        ok: true,
        requestId: "r",
        timestamp: "t",
        data: {
          views: 100,
          sessions: 50,
          visitors: 30,
          bounces: 10,
          totalDurationMs: 60000,
          avgDurationMs: 1200,
          bounceRate: 20,
          approximateVisitors: false,
        },
      }).success,
    ).toBe(true);
  });
});
