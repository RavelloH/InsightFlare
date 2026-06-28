import { beforeEach, describe, expect, it, vi } from "vitest";

import type * as QueryCore from "@/lib/edge/query/core";
import {
  addDimensionValue,
  finalizeDimensionBuckets,
  geoTabLabel,
  mapEventField,
  mapEventFieldValue,
  mapEventSummaryCards,
  mapGeoRowsToFilterOptions,
  mapPageCardMetrics,
  mapReferrerRowsToFilterOptions,
  percentChange,
  type QueryWindow,
  SHARE_TREND_OTHER_KEY,
  SHARE_TREND_OTHER_LABEL,
  SHARE_TREND_OTHER_TOKEN,
  siteQueryResponse,
  sqlIntegerLiteral,
} from "@/lib/edge/query/core";
import { queryEventTypeOverviewFromD1 } from "@/lib/edge/query/events-overview";
import {
  queryEventsSummaryFromD1,
  queryEventSummaryMetricsFromD1,
  queryEventTypeAggregate,
} from "@/lib/edge/query/events-summary";
import {
  queryEventsTrendFromD1,
  queryEventTypeTrendFromD1,
} from "@/lib/edge/query/events-trend";
import type { Env } from "@/lib/edge/types";

const queryD1AllMock = vi.hoisted(() => vi.fn());

vi.mock("@/lib/edge/query/core", async () => {
  const actual = await vi.importActual<typeof QueryCore>(
    "@/lib/edge/query/core",
  );
  return {
    ...actual,
    queryD1All: queryD1AllMock,
  };
});

const env = {} as Env;
const siteId = "site_123";
const window: QueryWindow = {
  fromMs: Date.UTC(2026, 0, 1),
  toMs: Date.UTC(2026, 0, 1, 2),
  nowMs: Date.UTC(2026, 0, 2),
  timeZone: "UTC",
};

describe("edge query events summary coverage", () => {
  beforeEach(() => {
    queryD1AllMock.mockReset();
  });

  it("returns zero summary metrics when D1 has no aggregate row", async () => {
    queryD1AllMock.mockResolvedValueOnce([]);

    await expect(
      queryEventSummaryMetricsFromD1(env, siteId, window, {}),
    ).resolves.toEqual({
      events: 0,
      eventTypes: 0,
      sessions: 0,
      visitors: 0,
    });

    expect(queryD1AllMock).toHaveBeenCalledOnce();
  });

  it("reads event summary cards from each dimension query", async () => {
    queryD1AllMock
      .mockResolvedValueOnce([
        { events: 8, eventTypes: 2, sessions: 4, visitors: 3 },
      ])
      .mockResolvedValueOnce([
        { value: "signup", views: 5, sessions: 3, visitors: 2 },
      ])
      .mockResolvedValueOnce([
        { value: "/pricing", views: 4, sessions: 2, visitors: 2 },
      ])
      .mockResolvedValueOnce([
        { value: "Pricing", views: 4, sessions: 2, visitors: 2 },
      ])
      .mockResolvedValueOnce([
        { value: "example.com", views: 8, sessions: 4, visitors: 3 },
      ]);

    await expect(
      queryEventsSummaryFromD1(env, siteId, window, {}),
    ).resolves.toEqual({
      summary: { events: 8, eventTypes: 2, sessions: 4, visitors: 3 },
      cards: {
        event: {
          name: [{ value: "signup", views: 5, sessions: 3, visitors: 2 }],
        },
        page: {
          path: [{ value: "/pricing", views: 4, sessions: 2, visitors: 2 }],
          title: [{ value: "Pricing", views: 4, sessions: 2, visitors: 2 }],
          hostname: [
            { value: "example.com", views: 8, sessions: 4, visitors: 3 },
          ],
        },
      },
    });

    expect(queryD1AllMock).toHaveBeenCalledTimes(5);
    expect(queryD1AllMock.mock.calls[1][2]).toContain(100);
  });

  it("queries custom event type aggregates with visit context filters", async () => {
    queryD1AllMock.mockResolvedValueOnce([
      {
        value: "signup",
        views: "9",
        sessions: "4",
        visitors: "3",
      },
    ]);

    await expect(
      queryEventTypeAggregate(
        env,
        siteId,
        window,
        {
          sourceDomain: "Ref.Example",
          clientDeviceType: "mobile",
        },
        3,
      ),
    ).resolves.toEqual([
      { value: "signup", views: 9, sessions: 4, visitors: 3 },
    ]);

    expect(queryD1AllMock).toHaveBeenCalledOnce();
    const [, sql, bindings] = queryD1AllMock.mock.calls[0];
    expect(sql).toContain("LEFT JOIN visit_source vs");
    expect(sql).toContain("FROM event_rollup");
    expect(sql).toContain("LOWER(TRIM(COALESCE(vc.referrer_host, ''))) = ?");
    expect(sql).toContain("TRIM(COALESCE(vc.device_type, '')) = ?");
    expect(bindings).toEqual([
      siteId,
      window.fromMs,
      window.toMs,
      siteId,
      window.fromMs,
      window.toMs,
      "ref.example",
      "mobile",
      3,
    ]);
  });

  it("normalizes sparse custom event aggregate rows", async () => {
    queryD1AllMock.mockResolvedValueOnce([
      {
        value: null,
        views: undefined,
        sessions: null,
        visitors: undefined,
      },
    ]);

    await expect(
      queryEventTypeAggregate(env, siteId, window, {}, 1),
    ).resolves.toEqual([{ value: "", views: 0, sessions: 0, visitors: 0 }]);
  });

  it("computes event type overview fallbacks for sparse summary rows", async () => {
    queryD1AllMock
      .mockResolvedValueOnce([
        { events: 10, eventTypes: 2, sessions: 5, visitors: 4 },
      ])
      .mockResolvedValueOnce([
        {
          events: null,
          eventTypes: undefined,
          sessions: 4,
          visitors: null,
        },
      ])
      .mockResolvedValueOnce([{ value: "/signup", views: 2 }])
      .mockResolvedValueOnce([{ value: "US", views: 2 }])
      .mockResolvedValueOnce([{ value: "desktop", views: 2 }])
      .mockResolvedValueOnce([{ value: "Chrome", views: 2 }]);

    await expect(
      queryEventTypeOverviewFromD1(env, siteId, window, {}, "signup"),
    ).resolves.toEqual({
      summary: {
        events: 0,
        eventTypes: 0,
        sessions: 4,
        visitors: 0,
        avgEventsPerSession: 0,
        shareOfAllEvents: 0,
      },
      breakdowns: {
        pages: [{ value: "/signup", views: 2 }],
        countries: [{ value: "US", views: 2 }],
        devices: [{ value: "desktop", views: 2 }],
        browsers: [{ value: "Chrome", views: 2 }],
      },
    });
  });

  it("uses zero ratios when event type overview has no rows", async () => {
    queryD1AllMock
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);

    await expect(
      queryEventTypeOverviewFromD1(env, siteId, window, {}, "signup"),
    ).resolves.toEqual({
      summary: {
        events: 0,
        eventTypes: 0,
        sessions: 0,
        visitors: 0,
        avgEventsPerSession: 0,
        shareOfAllEvents: 0,
      },
      breakdowns: {
        pages: [],
        countries: [],
        devices: [],
        browsers: [],
      },
    });
  });
});

describe("edge query events trend coverage", () => {
  beforeEach(() => {
    queryD1AllMock.mockReset();
  });

  it("maps event trend rows, collisions, other series, and invalid buckets", async () => {
    queryD1AllMock
      .mockResolvedValueOnce([
        {
          eventName: "Signup Complete",
          events: 9,
          sessions: 4,
          visitors: 3,
        },
        {
          eventName: "Signup/Complete",
          events: 5,
          sessions: 3,
          visitors: 2,
        },
      ])
      .mockResolvedValueOnce([
        { bucket: 0, seriesKey: "Signup Complete", events: 3 },
        { bucket: 1, seriesKey: SHARE_TREND_OTHER_TOKEN, events: 4 },
        { bucket: 99, seriesKey: "Signup Complete", events: 100 },
      ])
      .mockResolvedValueOnce([]);

    const result = await queryEventsTrendFromD1(
      env,
      siteId,
      window,
      "hour",
      { browser: "Chrome" },
      2,
    );

    expect(result.series).toEqual([
      {
        key: "signup-complete",
        eventName: "Signup Complete",
        label: "Signup Complete",
        events: 9,
        sessions: 4,
        visitors: 3,
      },
      {
        key: "signup-complete-2",
        eventName: "Signup/Complete",
        label: "Signup/Complete",
        events: 5,
        sessions: 3,
        visitors: 2,
      },
      {
        key: SHARE_TREND_OTHER_KEY,
        eventName: SHARE_TREND_OTHER_LABEL,
        label: SHARE_TREND_OTHER_LABEL,
        events: 4,
        sessions: 0,
        visitors: 0,
        isOther: true,
      },
    ]);
    expect(result.data[0]).toMatchObject({
      bucket: 0,
      totalEvents: 3,
      eventsBySeries: { "signup-complete": 3 },
    });
    expect(result.data[1]).toMatchObject({
      bucket: 1,
      totalEvents: 4,
      eventsBySeries: { [SHARE_TREND_OTHER_KEY]: 4 },
    });
    expect(queryD1AllMock.mock.calls[2][1]).toContain(
      "WHERE event_name NOT IN (?, ?)",
    );
  });

  it("uses the other token when no top event series are selected", async () => {
    queryD1AllMock
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        { bucket: 0, seriesKey: SHARE_TREND_OTHER_TOKEN, events: 2 },
      ])
      .mockResolvedValueOnce([
        {
          eventName: SHARE_TREND_OTHER_LABEL,
          events: 7,
          sessions: 5,
          visitors: 4,
        },
      ]);

    const result = await queryEventsTrendFromD1(
      env,
      siteId,
      window,
      "hour",
      {},
      0,
    );

    expect(result.series).toEqual([
      {
        key: SHARE_TREND_OTHER_KEY,
        eventName: SHARE_TREND_OTHER_LABEL,
        label: SHARE_TREND_OTHER_LABEL,
        events: 7,
        sessions: 5,
        visitors: 4,
        isOther: true,
      },
    ]);
    expect(queryD1AllMock.mock.calls[1][2]).toContain(SHARE_TREND_OTHER_TOKEN);
    expect(queryD1AllMock.mock.calls[2][1]).not.toContain(
      "WHERE event_name NOT IN",
    );
  });

  it("maps event type trend rows and ignores out-of-range buckets", async () => {
    queryD1AllMock.mockResolvedValueOnce([
      { bucket: 0, events: 3, visitors: 2 },
      { bucket: -1, events: 100, visitors: 100 },
    ]);

    const result = await queryEventTypeTrendFromD1(
      env,
      siteId,
      window,
      "hour",
      {},
      "signup",
    );

    expect(result.data[0]).toMatchObject({ bucket: 0, events: 3, visitors: 2 });
    expect(result.data[1]).toMatchObject({ bucket: 1, events: 0, visitors: 0 });
  });
});

describe("edge query core event helper coverage", () => {
  it("maps event fields and event field values across value types", () => {
    expect(
      mapEventField({
        path: "/plan",
        valueType: 1,
        events: 2,
        occurrences: 3,
        firstSeenAt: 10,
        lastSeenAt: 20,
        stringValue: "pro",
        numberValue: null,
        booleanValue: null,
      }),
    ).toMatchObject({ valueType: "string", exampleValue: "pro" });
    expect(
      mapEventField({
        path: "/paid",
        valueType: 3,
        events: 2,
        occurrences: 3,
        firstSeenAt: 10,
        lastSeenAt: 20,
        stringValue: null,
        numberValue: null,
        booleanValue: 0,
      }),
    ).toMatchObject({ valueType: "boolean", exampleValue: false });
    expect(
      mapEventFieldValue({
        valueType: 2,
        events: null as unknown as number,
        occurrences: undefined as unknown as number,
        firstSeenAt: null as unknown as number,
        lastSeenAt: undefined as unknown as number,
        stringValue: null,
        numberValue: null,
        booleanValue: null,
      }),
    ).toEqual({
      value: 0,
      events: 0,
      occurrences: 0,
      firstSeenAt: 0,
      lastSeenAt: 0,
    });
  });

  it("finalizes dimension buckets and maps event summary cards", () => {
    const buckets = new Map();
    addDimensionValue(buckets, " signup ", "session-a", "visitor-a");
    addDimensionValue(buckets, "signup", "session-a", "visitor-b");
    addDimensionValue(buckets, "checkout", "session-b", "visitor-c");
    addDimensionValue(buckets, "   ", "session-c", "visitor-d");

    expect(finalizeDimensionBuckets(buckets, 1)).toEqual([
      { value: "signup", views: 2, sessions: 1, visitors: 2 },
    ]);
    expect(
      mapEventSummaryCards({
        event: {
          name: [{ value: "signup", views: 2, sessions: 1, visitors: 2 }],
        },
        page: {
          path: [{ value: "/signup", views: 2, sessions: 1, visitors: 2 }],
          title: [{ value: "Signup", views: 2, sessions: 1, visitors: 2 }],
          hostname: [
            { value: "example.com", views: 2, sessions: 1, visitors: 2 },
          ],
        },
      }),
    ).toEqual({
      event: {
        name: [{ label: "signup", views: 2, sessions: 1, visitors: 2 }],
      },
      page: {
        path: [{ label: "/signup", views: 2, sessions: 1, visitors: 2 }],
        title: [{ label: "Signup", views: 2, sessions: 1, visitors: 2 }],
        hostname: [
          { label: "example.com", views: 2, sessions: 1, visitors: 2 },
        ],
      },
    });
  });

  it("maps filter options, page card math, geo labels, and response headers", async () => {
    expect(
      mapReferrerRowsToFilterOptions([
        { referrer: "", views: 1, sessions: 1, visitors: 1 },
        { referrer: " news.example ", views: 1, sessions: 1, visitors: 1 },
        { referrer: "news.example", views: 1, sessions: 1, visitors: 1 },
      ]),
    ).toEqual([
      { value: "__direct__", label: "__direct__" },
      { value: "news.example", label: "news.example" },
    ]);
    expect(
      mapGeoRowsToFilterOptions(
        [{ value: "US::CA::California::", views: 1, sessions: 1, visitors: 1 }],
        "region",
      ),
    ).toEqual([
      {
        value: "US::CA::California::",
        label: "California",
        group: "region",
      },
    ]);
    expect(geoTabLabel("US::::::", "city")).toBe("US");
    expect(
      mapPageCardMetrics({
        views: 3,
        sessions: 0,
        visitors: 2,
        bounces: 1,
        totalDuration: 10,
        durationViews: 1,
      }),
    ).toMatchObject({ pagesPerSession: 0, avgDurationMs: 0 });
    expect(percentChange(12, 0)).toBeNull();
    expect(() => sqlIntegerLiteral(Number.NaN)).toThrow(
      "Invalid time bucket boundary",
    );

    const response = siteQueryResponse(
      "private-site",
      { ok: true },
      {
        publicSite: {
          slug: "demo",
          name: "Demo",
          domain: "example.com",
        },
      },
    );

    expect(response.headers.get("cache-control")).toBe(
      "public, max-age=300, s-maxage=300",
    );
    await expect(response.json()).resolves.toMatchObject({
      ok: true,
      site: { slug: "demo", name: "Demo", domain: "example.com" },
      privacy: {
        queryHashDetails: "hidden",
        visitorTrajectories: "hidden",
        detailedReferrerUrl: "hidden",
      },
    });
  });
});
