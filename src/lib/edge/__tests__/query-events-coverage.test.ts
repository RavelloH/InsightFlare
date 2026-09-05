import { beforeEach, describe, expect, it, vi } from "vitest";

import { EMPTY_FILTER_DOCUMENT } from "@/lib/edge/analytics/contract";
import type * as QueryCore from "@/lib/edge/analytics/providers/d1/internal/core";
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
} from "@/lib/edge/analytics/providers/d1/internal/core";
import {
  queryEventAnalyticsContextCardsFromD1,
  queryEventDimensionRowsFromFilteredEvents,
  queryEventGeoRowsFromFilteredEvents,
  queryEventSessionBoundaryRowsFromFilteredEvents,
} from "@/lib/edge/analytics/providers/d1/internal/events-context";
import { queryEventTypeOverviewFromD1 } from "@/lib/edge/analytics/providers/d1/internal/events-overview";
import {
  queryEventsSummaryFromD1,
  queryEventSummaryMetricsFromD1,
  queryEventTypeAggregate,
} from "@/lib/edge/analytics/providers/d1/internal/events-summary";
import {
  queryEventsTrendFromD1,
  queryEventTypeTrendFromD1,
} from "@/lib/edge/analytics/providers/d1/internal/events-trend";
import type { Env } from "@/lib/edge/types";

import { filterFixture } from "./filter-fixtures";

const queryD1AllMock = vi.hoisted(() => vi.fn());

vi.mock("@/lib/edge/analytics/providers/d1/internal/core", async () => {
  const actual = await vi.importActual<typeof QueryCore>(
    "@/lib/edge/analytics/providers/d1/internal/core",
  );
  return {
    ...actual,
    queryD1All: queryD1AllMock,
  };
});

const env = {} as Env;
const siteId = "site_123";
const window: QueryWindow = {
  startMs: Date.UTC(2026, 0, 1),
  endExclusiveMs: Date.UTC(2026, 0, 1, 2),
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
      queryEventSummaryMetricsFromD1(
        env,
        siteId,
        window,
        EMPTY_FILTER_DOCUMENT,
      ),
    ).resolves.toEqual({
      events: 0,
      eventTypes: 0,
      sessions: 0,
      visitors: 0,
    });

    expect(queryD1AllMock).toHaveBeenCalledOnce();
  });

  it("keeps an absent D1 card collection from reaching array operations", async () => {
    queryD1AllMock.mockResolvedValueOnce(undefined);

    await expect(
      queryEventsSummaryFromD1(env, siteId, window, EMPTY_FILTER_DOCUMENT),
    ).resolves.toEqual({
      summary: { events: 0, eventTypes: 0, sessions: 0, visitors: 0 },
      cards: {
        event: { name: [] },
        page: { path: [], title: [], hostname: [] },
      },
    });
  });

  it("reads event summary cards from each dimension query", async () => {
    queryD1AllMock.mockResolvedValueOnce([
      {
        cardType: "__summary__",
        views: 8,
        eventTypes: 2,
        sessions: 4,
        visitors: 3,
      },
      {
        cardType: "event",
        value: "signup",
        views: 5,
        sessions: 3,
        visitors: 2,
      },
      {
        cardType: "path",
        value: "/pricing",
        views: 4,
        sessions: 2,
        visitors: 2,
      },
      {
        cardType: "title",
        value: "Pricing",
        views: 4,
        sessions: 2,
        visitors: 2,
      },
      {
        cardType: "hostname",
        value: "example.com",
        views: 8,
        sessions: 4,
        visitors: 3,
      },
    ]);

    await expect(
      queryEventsSummaryFromD1(env, siteId, window, EMPTY_FILTER_DOCUMENT),
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

    expect(queryD1AllMock).toHaveBeenCalledOnce();
    expect(queryD1AllMock.mock.calls[0][1]).toContain(
      "filtered_events AS MATERIALIZED",
    );
    expect(queryD1AllMock.mock.calls[0][2]).toEqual(
      expect.arrayContaining([siteId, window.startMs, window.endExclusiveMs]),
    );
  });

  it("builds all event context cards within D1 compound SELECT limits", async () => {
    queryD1AllMock.mockResolvedValueOnce([
      {
        cardType: "path",
        value: "/pricing",
        views: 8,
        sessions: 4,
        visitors: 3,
      },
      {
        cardType: "sourceDomain",
        value: "",
        views: 2,
        sessions: 1,
        visitors: 1,
      },
      {
        cardType: "query",
        value: null,
        label: null,
        views: null,
        sessions: null,
        visitors: null,
      },
      {
        cardType: "browser",
        value: "Chrome",
        views: 8,
        sessions: 4,
        visitors: 3,
      },
      {
        cardType: "region",
        value: "US::CA::California",
        label: "California",
        views: 8,
        sessions: 4,
        visitors: 3,
      },
      {
        cardType: "entry",
        value: "/",
        views: 8,
        sessions: 4,
        visitors: 3,
      },
    ]);

    const cards = await queryEventAnalyticsContextCardsFromD1(
      env,
      siteId,
      window,
      EMPTY_FILTER_DOCUMENT,
      10,
      "Signup",
    );

    expect(cards.page.path).toEqual([
      { value: "/pricing", views: 8, sessions: 4, visitors: 3 },
    ]);
    expect(cards.page.entry).toEqual([
      { value: "/", views: 8, sessions: 4, visitors: 3 },
    ]);
    expect(cards.source.domain[0]?.value).toBe("");
    expect(cards.geo.region[0]).toMatchObject({
      value: "US::CA::California",
      label: "California",
    });
    expect(cards.client.browser[0]?.value).toBe("Chrome");
    expect(queryD1AllMock).toHaveBeenCalledOnce();
    const [, sql] = queryD1AllMock.mock.calls[0];
    expect(sql).toContain("ranked_cards AS");
    expect((sql.match(/card_group_\d+ AS \(/g) ?? []).length).toBe(4);
    expect((sql.match(/SELECT \* FROM card_group_\d+/g) ?? []).length).toBe(4);
  });

  it("maps empty combined summary results without a synthetic row", async () => {
    queryD1AllMock.mockResolvedValueOnce([]);

    await expect(
      queryEventsSummaryFromD1(env, siteId, window, EMPTY_FILTER_DOCUMENT),
    ).resolves.toMatchObject({
      summary: { events: 0, eventTypes: 0, sessions: 0, visitors: 0 },
      cards: { event: { name: [] } },
    });
  });

  it("keeps low-level context helpers compatible for targeted callers", async () => {
    queryD1AllMock
      .mockResolvedValueOnce([
        { value: "", views: 1, sessions: 1, visitors: 1 },
      ])
      .mockResolvedValueOnce([
        { value: "Chrome", views: 2, sessions: 1, visitors: 1 },
      ])
      .mockResolvedValueOnce([
        {
          value: "US::CA::California",
          label: "California",
          views: 2,
          sessions: 1,
          visitors: 1,
        },
      ])
      .mockResolvedValueOnce([
        { value: "/", views: 2, sessions: 1, visitors: 1 },
      ])
      .mockResolvedValueOnce([
        { value: "/pricing", views: 2, sessions: 1, visitors: 1 },
      ]);
    const baseCte = "WITH filtered_events AS (SELECT * FROM source)";

    await expect(
      queryEventDimensionRowsFromFilteredEvents(
        env,
        baseCte,
        [siteId],
        "browser",
        5,
        { includeEmpty: true },
      ),
    ).resolves.toHaveLength(1);
    await expect(
      queryEventDimensionRowsFromFilteredEvents(
        env,
        baseCte,
        [siteId],
        "browser",
        5,
      ),
    ).resolves.toMatchObject([{ value: "Chrome" }]);
    await expect(
      queryEventGeoRowsFromFilteredEvents(
        env,
        baseCte,
        [siteId],
        "country",
        "region",
        5,
      ),
    ).resolves.toMatchObject([{ label: "California" }]);
    await expect(
      queryEventSessionBoundaryRowsFromFilteredEvents(
        env,
        baseCte,
        [siteId],
        "entry",
        5,
      ),
    ).resolves.toMatchObject([{ value: "/" }]);
    await expect(
      queryEventSessionBoundaryRowsFromFilteredEvents(
        env,
        baseCte,
        [siteId],
        "exit",
        5,
      ),
    ).resolves.toMatchObject([{ value: "/pricing" }]);
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
        filterFixture({
          sourceDomain: "Ref.Example",
          clientDeviceType: "mobile",
        }),
        3,
      ),
    ).resolves.toEqual([
      { value: "signup", views: 9, sessions: 4, visitors: 3 },
    ]);

    expect(queryD1AllMock).toHaveBeenCalledOnce();
    const [, sql, bindings] = queryD1AllMock.mock.calls[0];
    expect(sql).not.toContain("LEFT JOIN visit_source vs");
    expect(sql).toContain("FROM event_rollup");
    expect(sql).toContain("LOWER(TRIM(COALESCE(es.referrer_host, ''))) = ?");
    expect(sql).toContain("LOWER(TRIM(COALESCE(es.device_type, ''))) = ?");
    expect(bindings).toEqual([
      siteId,
      window.startMs,
      window.endExclusiveMs,
      "mobile",
      "ref.example",
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
      queryEventTypeAggregate(env, siteId, window, EMPTY_FILTER_DOCUMENT, 1),
    ).resolves.toEqual([{ value: "", views: 0, sessions: 0, visitors: 0 }]);
  });

  it("computes event type overview fallbacks for sparse summary rows", async () => {
    queryD1AllMock.mockResolvedValueOnce([
      {
        events: null,
        eventTypes: undefined,
        sessions: 4,
        visitors: null,
        cardType: "summary",
        value: null,
        scopedEvents: 10,
      },
      {
        events: 2,
        sessions: 0,
        visitors: 0,
        cardType: "page",
        value: "/signup",
      },
      {
        events: 2,
        sessions: 0,
        visitors: 0,
        cardType: "country",
        value: "US",
      },
      {
        events: 2,
        sessions: 0,
        visitors: 0,
        cardType: "device",
        value: "desktop",
      },
      {
        events: 2,
        sessions: 0,
        visitors: 0,
        cardType: "browser",
        value: "Chrome",
      },
    ]);

    await expect(
      queryEventTypeOverviewFromD1(
        env,
        siteId,
        window,
        EMPTY_FILTER_DOCUMENT,
        "signup",
      ),
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
        pages: [{ value: "/signup", views: 2, sessions: 0, visitors: 0 }],
        countries: [{ value: "US", views: 2, sessions: 0, visitors: 0 }],
        devices: [{ value: "desktop", views: 2, sessions: 0, visitors: 0 }],
        browsers: [{ value: "Chrome", views: 2, sessions: 0, visitors: 0 }],
      },
    });
  });

  it("uses zero ratios when event type overview has no rows", async () => {
    queryD1AllMock.mockResolvedValueOnce([]);

    await expect(
      queryEventTypeOverviewFromD1(
        env,
        siteId,
        window,
        EMPTY_FILTER_DOCUMENT,
        "signup",
      ),
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
      filterFixture({ browser: "Chrome" }),
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
      EMPTY_FILTER_DOCUMENT,
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
      EMPTY_FILTER_DOCUMENT,
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
