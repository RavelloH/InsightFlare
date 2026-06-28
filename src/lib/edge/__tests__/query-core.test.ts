import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  addDimensionValue,
  addGeoDimensionValue,
  appendSqlConditions,
  buildEventFilterSql,
  buildEventPayloadFilterSql,
  buildTimeBuckets,
  buildVisitFilterSql,
  clientDimensionDefinition,
  customEventJsonTypeCode,
  customEventJsonTypeLabel,
  dedupeFilterOptions,
  DIRECT_REFERRER_FILTER_VALUE,
  emptyOverviewAggregateRow,
  emptyPerformanceRouteMetrics,
  eventPayloadFilterValueType,
  eventRecordOrderBy,
  fetchPublicSite,
  finalizeDimensionBuckets,
  finalizeGeoDimensionBuckets,
  formatPageLabel,
  geoTabLabel,
  intervalBucketMs,
  mapDimensionRowsToFilterOptions,
  mapEventAnalyticsContextCards,
  mapEventFieldValue,
  mapEventRecord,
  mapGeoRowsToFilterOptions,
  mapGeoTabs,
  mapOverviewAggregate,
  mapPages,
  mapReferrerRowsToFilterOptions,
  mapReferrers,
  mapTabs,
  mapTrendRows,
  mapVisitors,
  mapVisitPerformanceMetrics,
  parseBooleanFlag,
  parseEventFieldPath,
  parseEventFieldValueType,
  parseEventId,
  parseEventName,
  parseEventPayloadFilters,
  parseEventRecordSort,
  parseFilterOptionKey,
  parseFilters,
  parseGeoFilterValue,
  parseInterval,
  parseLimit,
  parseListSearch,
  parseQueryLimit,
  parseSessionListSort,
  parseVisitorListSort,
  parseWindow,
  performanceMetricColumn,
  type QueryWindow,
  shareTrendSeriesKey,
  sourceLabel,
  timeBucketCase,
  timeBucketTimestamp,
  withoutFilterKey,
  withoutGeoFilter,
} from "@/lib/edge/query/core";
import type { Env } from "@/lib/edge/types";

const fixedNow = Date.UTC(2026, 4, 26, 8);

function url(search = "") {
  return new URL(`https://edge.test/query${search}`);
}

describe("edge query core parsers", () => {
  beforeEach(() => {
    vi.spyOn(Date, "now").mockReturnValue(fixedNow);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("parses valid windows, defaults, and invalid ranges", () => {
    expect(
      parseWindow(
        url("?from=1700000000123.9&to=1700003600999.5&timeZone=Asia/Tokyo"),
      ),
    ).toEqual({
      fromMs: 1_700_000_000_123,
      toMs: 1_700_003_600_999,
      nowMs: fixedNow,
      timeZone: "Asia/Tokyo",
    });

    expect(parseWindow(url("?timeZone=Bad/Zone"))).toEqual({
      fromMs: fixedNow - 86_400_000,
      toMs: fixedNow,
      nowMs: fixedNow,
      timeZone: "UTC",
    });

    expect(parseWindow(url("?from=nope&to=wat"))).toBeNull();
    expect(parseWindow(url("?from=-1&to=10"))).toBeNull();
    expect(parseWindow(url("?from=20&to=10"))).toBeNull();
  });

  it("parses intervals and clamps limits", () => {
    expect(parseInterval(url("?interval=HOUR"))).toBe("hour");
    expect(parseInterval(url("?interval=minute"))).toBe("minute");
    expect(parseInterval(url("?interval=bad"))).toBe("day");

    expect(parseLimit(url("?limit=12.9"), 20, 50)).toBe(12);
    expect(parseLimit(url("?limit=0"), 20, 50)).toBe(20);
    expect(parseLimit(url("?limit=250"), 20, 50)).toBe(50);

    expect(parseQueryLimit(url("?pageSize=12.9"), "pageSize", 20, 5, 50)).toBe(
      12,
    );
    expect(parseQueryLimit(url("?pageSize=1"), "pageSize", 20, 5, 50)).toBe(5);
    expect(parseQueryLimit(url("?pageSize=500"), "pageSize", 20, 5, 50)).toBe(
      50,
    );
    expect(parseQueryLimit(url("?pageSize=nope"), "pageSize", 20, 5, 50)).toBe(
      20,
    );
  });

  it("parses list sort keys and falls back to defaults", () => {
    expect(
      parseVisitorListSort(url("?sortBy=firstSeenAt&sortDir=asc")),
    ).toEqual({ key: "firstSeenAt", direction: "asc" });
    expect(parseVisitorListSort(url("?sortBy=unknown&sortDir=asc"))).toEqual({
      key: "lastSeenAt",
      direction: "desc",
    });

    expect(parseSessionListSort(url("?sortBy=durationMs"))).toEqual({
      key: "durationMs",
      direction: "desc",
    });
    expect(parseSessionListSort(url("?sortBy=lastSeenAt&sortDir=asc"))).toEqual(
      {
        key: "startedAt",
        direction: "desc",
      },
    );

    expect(parseEventRecordSort(url("?sortBy=pathname&sortDir=asc"))).toEqual({
      key: "pathname",
      direction: "asc",
    });
    expect(parseEventRecordSort(url("?sortBy=views&sortDir=asc"))).toEqual({
      key: "occurredAt",
      direction: "desc",
    });
  });

  it("normalizes dashboard filters and event payload filter rules", () => {
    const payloadFilters = JSON.stringify([
      { path: "$.plan.name", operator: "!=", value: " pro " },
      { path: "/totals/paid", operator: "eq", value: 42 },
      { path: "flags[0].enabled", operator: "ne", value: true },
      { path: "empty", value: null },
      { path: "/", value: "skip" },
      { path: "bad", value: { unsupported: true } },
    ]);

    expect(parseEventPayloadFilters(payloadFilters)).toEqual([
      { path: "/plan/name", operator: "ne", value: " pro " },
      { path: "/totals/paid", operator: "eq", value: 42 },
      { path: "/flags/*/enabled", operator: "ne", value: true },
      { path: "/empty", operator: "eq", value: null },
    ]);

    const parsed = parseFilters(
      url(
        `?country= US &device=desktop&browser= Chrome &path=%20/docs%20` +
          `&query=ref%3Dhome&title=Docs&hostname=Example.COM` +
          `&entry=/&exit=/pricing&sourceDomain=News.Example` +
          `&sourceLink=https%3A%2F%2Fnews.example%2Fpost` +
          `&clientBrowser=Safari&clientOsVersion=17&clientDeviceType=mobile` +
          `&clientLanguage=en-US&clientScreenSize=390x844` +
          `&geoCountry=CA&geoRegion=CA%3A%3ABC%3A%3ABritish%20Columbia` +
          `&geoContinent=NA&geoTimezone=America%2FVancouver` +
          `&geoOrganization=Example%20ISP` +
          `&eventPayloadFilters=${encodeURIComponent(payloadFilters)}`,
      ),
    );

    expect(parsed).toMatchObject({
      country: "US",
      device: "desktop",
      browser: "Chrome",
      path: "/docs",
      query: "ref=home",
      title: "Docs",
      hostname: "Example.COM",
      entry: "/",
      exit: "/pricing",
      sourceDomain: "News.Example",
      sourceLink: "https://news.example/post",
      clientBrowser: "Safari",
      clientOsVersion: "17",
      clientDeviceType: "mobile",
      clientLanguage: "en-US",
      clientScreenSize: "390x844",
      geo: "CA",
      geoContinent: "NA",
      geoTimezone: "America/Vancouver",
      geoOrganization: "Example ISP",
      eventPayloadFilters: [
        { path: "/plan/name", operator: "ne", value: " pro " },
        { path: "/totals/paid", operator: "eq", value: 42 },
        { path: "/flags/*/enabled", operator: "ne", value: true },
        { path: "/empty", operator: "eq", value: null },
      ],
    });

    expect(parseEventPayloadFilters("not json")).toBeUndefined();
    expect(
      parseEventPayloadFilters(JSON.stringify({ path: "/plan" })),
    ).toBeUndefined();
  });

  it("parses focused query params and filter option helpers", () => {
    expect(parseListSearch(url("?search=%20checkout%20"))).toBe("checkout");
    expect(parseListSearch(url("?search=%20%20"))).toBeUndefined();
    expect(parseListSearch(url())).toBeUndefined();
    expect(parseEventName(url("?eventName=%20signup%20"))).toBe("signup");
    expect(parseEventName(url("?eventName=%20%20"))).toBeUndefined();
    expect(parseEventFieldPath(url("?fieldPath=/payload/plan"))).toBe(
      "/payload/plan",
    );
    expect(parseEventFieldPath(url("?fieldPath="))).toBeUndefined();
    expect(parseEventFieldPath(url())).toBeUndefined();
    expect(parseEventFieldValueType(url("?fieldValueType=Object"))).toBe(
      "object",
    );
    expect(parseEventFieldValueType(url("?fieldValueType=unsupported"))).toBe(
      undefined,
    );
    expect(parseEventId(url("?eventId=%20evt_123%20"))).toBe("evt_123");
    expect(parseEventId(url("?eventId=%20%20"))).toBeUndefined();
    expect(parseFilterOptionKey(url("?filterKey=geoTimezone"))).toBe(
      "geoTimezone",
    );
    expect(parseFilterOptionKey(url("?filterKey=unknown"))).toBeNull();
    expect(parseBooleanFlag(url("?includeDetail=yes"), "includeDetail")).toBe(
      true,
    );
    expect(
      withoutFilterKey({ country: "US", browser: "Chrome" }, "country"),
    ).toEqual({ browser: "Chrome" });
  });

  it("drops malformed payload filters while preserving valid rules", () => {
    expect(parseEventPayloadFilters("")).toBeUndefined();
    expect(
      parseEventPayloadFilters(
        JSON.stringify([
          null,
          "bad",
          42,
          { path: "/", value: "skip" },
          { path: "bad", value: { nested: true } },
          { path: "$.flags.enabled", operator: "ne", value: false },
        ]),
      ),
    ).toEqual([{ path: "/flags/enabled", operator: "ne", value: false }]);
  });
});

describe("edge public site lookup", () => {
  function envWithPublicSite(row: Record<string, unknown> | null) {
    const first = vi.fn().mockResolvedValue(row);
    const bind = vi.fn(() => ({ first }));
    const prepare = vi.fn(() => ({ bind }));
    const env = { DB: { prepare } } as unknown as Env;
    return { env, prepare, bind, first };
  }

  it("requires enabled public sharing for slug lookup", async () => {
    const { env, prepare, bind } = envWithPublicSite({
      id: "site-1",
      name: "Blog",
      domain: "blog.test",
    });

    const site = await fetchPublicSite(
      env,
      new URL("https://edge.test/api/public/blog/site"),
    );

    expect(site).toMatchObject({ id: "site-1" });
    expect(prepare).toHaveBeenCalledWith(
      "SELECT id,name,domain FROM sites WHERE public_enabled=1 AND public_slug=? LIMIT 1",
    );
    expect(bind).toHaveBeenCalledWith("blog");
  });

  it("returns 404 for disabled, deleted, old, empty, or malformed slugs", async () => {
    const { env, first } = envWithPublicSite(null);

    for (const path of [
      "/api/public/disabled/site",
      "/api/public/old-slug/overview",
      "/api/public/deleted/pages",
    ]) {
      const response = await fetchPublicSite(
        env,
        new URL(`https://edge.test${path}`),
      );
      expect(response).toBeInstanceOf(Response);
      expect((response as Response).status, path).toBe(404);
    }
    expect(first).toHaveBeenCalledTimes(3);

    const empty = await fetchPublicSite(
      env,
      new URL("https://edge.test/api/public/%20/site"),
    );
    expect((empty as Response).status).toBe(404);

    const malformed = await fetchPublicSite(
      env,
      new URL("https://edge.test/api/public/%E0%A4%A/site"),
    );
    expect((malformed as Response).status).toBe(404);
  });
});

describe("edge query core dimensions", () => {
  it("formats page labels with optional query and hash details", () => {
    expect(formatPageLabel("", "", "", false)).toBe("/");
    expect(formatPageLabel("/docs", "?tab=api", "", true)).toBe(
      "/docs?tab=api",
    );
    expect(formatPageLabel("/docs", "", "#install", true)).toBe(
      "/docs#install",
    );
  });

  it("emits aliased and unaliased client dimension expressions", () => {
    expect(clientDimensionDefinition("browser")).toEqual({
      labelExpr: "TRIM(COALESCE(browser, ''))",
      fallbackKeyBase: "browser",
    });
    expect(clientDimensionDefinition("deviceType")).toEqual({
      labelExpr: "TRIM(COALESCE(device_type, ''))",
      fallbackKeyBase: "device",
    });
    expect(clientDimensionDefinition("language")).toEqual({
      labelExpr: "TRIM(COALESCE(language, ''))",
      fallbackKeyBase: "language",
    });
    expect(clientDimensionDefinition("browser", "v").labelExpr).toBe(
      "TRIM(COALESCE(v.browser, ''))",
    );
  });
});

describe("edge query core time helpers", () => {
  const nowMs = Date.UTC(2026, 4, 26);

  function window(fromMs: number, toMs: number): QueryWindow {
    return { fromMs, toMs, nowMs, timeZone: "UTC" };
  }

  it("labels query windows as detail data", () => {
    expect(sourceLabel(window(0, nowMs))).toBe("detail");
  });

  it("builds zoned buckets and SQL bucket cases", () => {
    const queryWindow: QueryWindow = {
      fromMs: Date.UTC(2026, 0, 2, 1, 30),
      toMs: Date.UTC(2026, 0, 2, 3, 5),
      nowMs,
      timeZone: "UTC",
    };

    const buckets = buildTimeBuckets(queryWindow, "hour");

    expect(buckets).toEqual([
      {
        index: 0,
        timestampMs: Date.UTC(2026, 0, 2, 1),
        fromMs: Date.UTC(2026, 0, 2, 1),
        toMs: Date.UTC(2026, 0, 2, 2),
      },
      {
        index: 1,
        timestampMs: Date.UTC(2026, 0, 2, 2),
        fromMs: Date.UTC(2026, 0, 2, 2),
        toMs: Date.UTC(2026, 0, 2, 3),
      },
      {
        index: 2,
        timestampMs: Date.UTC(2026, 0, 2, 3),
        fromMs: Date.UTC(2026, 0, 2, 3),
        toMs: Date.UTC(2026, 0, 2, 4),
      },
    ]);

    expect(timeBucketTimestamp(buckets, 1)).toBe(Date.UTC(2026, 0, 2, 2));
    expect(timeBucketTimestamp(buckets, 99)).toBe(0);

    expect(timeBucketCase(buckets.slice(0, 2), "started_at")).toEqual({
      sql:
        `CASE WHEN started_at >= ${Date.UTC(2026, 0, 2, 1)} ` +
        `AND started_at < ${Date.UTC(2026, 0, 2, 2)} THEN 0 ` +
        `WHEN started_at >= ${Date.UTC(2026, 0, 2, 2)} ` +
        `AND started_at < ${Date.UTC(2026, 0, 2, 3)} THEN 1 ELSE NULL END`,
      bindings: [],
    });
  });

  it("maps interval widths and falls back when no bucket can be generated", () => {
    expect(intervalBucketMs("minute")).toBe(60_000);
    expect(intervalBucketMs("hour")).toBe(3_600_000);
    expect(intervalBucketMs("day")).toBe(86_400_000);
    expect(intervalBucketMs("week")).toBe(7 * 86_400_000);
    expect(intervalBucketMs("month")).toBe(30 * 86_400_000);

    const fromMs = Date.UTC(2026, 0, 2, 1, 30);
    const buckets = buildTimeBuckets(
      {
        fromMs,
        toMs: Date.UTC(2026, 0, 2, 0, 59),
        nowMs,
        timeZone: "UTC",
      },
      "hour",
    );

    expect(buckets).toEqual([
      {
        index: 0,
        timestampMs: fromMs,
        fromMs,
        toMs: fromMs + 1,
      },
    ]);
  });
});

describe("edge query core mappers", () => {
  it("maps overview aggregate rows with derived rates", () => {
    expect(
      mapOverviewAggregate(
        {
          views: 10,
          sessions: 4,
          visitors: 3,
          bounces: 1,
          totalDuration: 1_001,
          durationViews: 2,
        },
        { approximateVisitors: true },
      ),
    ).toEqual({
      views: 10,
      sessions: 4,
      visitors: 3,
      bounces: 1,
      totalDurationMs: 1_001,
      avgDurationMs: 250,
      bounceRate: 0.25,
      approximateVisitors: true,
    });
  });

  it("maps trend rows and tab rows", () => {
    expect(
      mapTrendRows(
        [
          {
            bucket: 2,
            timestampMs: 123,
            views: 8,
            visitors: 5,
            sessions: 2,
            bounces: 1,
            totalDuration: 999,
            durationViews: 0,
          },
        ],
        "detail",
      ),
    ).toEqual([
      {
        bucket: 2,
        timestampMs: 123,
        views: 8,
        visitors: 5,
        sessions: 2,
        bounces: 1,
        totalDurationMs: 999,
        avgDurationMs: 500,
        source: "detail",
      },
    ]);

    expect(
      mapTabs([
        { value: "/docs", views: 7, sessions: 4, visitors: 3 },
        { value: "", views: 1, sessions: 1, visitors: 1 },
      ]),
    ).toEqual([
      { label: "/docs", views: 7, sessions: 4, visitors: 3 },
      { label: "", views: 1, sessions: 1, visitors: 1 },
    ]);
  });

  it("maps core rows, filter options, and geo dimension buckets", () => {
    expect(emptyOverviewAggregateRow()).toEqual({
      views: 0,
      sessions: 0,
      visitors: 0,
      bounces: 0,
      totalDuration: 0,
      durationViews: 0,
    });
    expect(
      mapPages([
        { pathname: "/docs", query: "a=1", hash: "top", views: 3, sessions: 2 },
      ]),
    ).toEqual([
      { pathname: "/docs", query: "a=1", hash: "top", views: 3, sessions: 2 },
    ]);
    expect(
      mapGeoTabs([
        {
          value: "US",
          label: "United States",
          views: 3,
          sessions: 2,
          visitors: 1,
        },
      ]),
    ).toEqual([
      {
        value: "US",
        label: "United States",
        views: 3,
        sessions: 2,
        visitors: 1,
      },
    ]);
    expect(
      mapReferrers([
        { referrer: "news.example", views: 4, sessions: 2, visitors: 2 },
      ]),
    ).toEqual([{ referrer: "news.example", views: 4, sessions: 2 }]);
    expect(
      mapVisitors([
        {
          visitorId: "visitor-1",
          firstSeenAt: 1,
          lastSeenAt: 2,
          views: 3,
          sessions: 1,
        },
      ]),
    ).toEqual([
      {
        visitorId: "visitor-1",
        sessionId: "",
        firstSeenAt: 1,
        lastSeenAt: 2,
        views: 3,
        sessions: 1,
        events: 0,
        country: "",
        region: "",
        regionCode: "",
        city: "",
        referrerHost: "",
        referrerUrl: "",
        browser: "",
        browserVersion: "",
        os: "",
        osVersion: "",
        deviceType: "",
        screenWidth: null,
        screenHeight: null,
      },
    ]);

    expect(
      dedupeFilterOptions([
        { value: "", label: "skip" },
        { value: " alpha ", label: " " },
        { value: "alpha", label: "duplicate" },
        { value: "beta", label: "Beta", group: "country" },
      ]),
    ).toEqual([
      { value: "alpha", label: "alpha" },
      { value: "beta", label: "Beta", group: "country" },
    ]);
    expect(
      mapDimensionRowsToFilterOptions([
        { value: " Chrome ", views: 2, sessions: 1, visitors: 1 },
        { value: "Chrome", views: 1, sessions: 1, visitors: 1 },
      ]),
    ).toEqual([{ value: "Chrome", label: "Chrome" }]);

    const geoBuckets = new Map();
    addGeoDimensionValue(geoBuckets, " US ", "session-a", "visitor-a");
    addGeoDimensionValue(geoBuckets, "US", "session-b", "visitor-b");
    addGeoDimensionValue(geoBuckets, "CA", "session-c", "visitor-c");
    addGeoDimensionValue(geoBuckets, " ", "session-d", "visitor-d");
    expect(
      finalizeGeoDimensionBuckets(geoBuckets, 2, (value) => `Label ${value}`),
    ).toEqual([
      { value: "US", label: "Label US", views: 2, sessions: 2, visitors: 2 },
      { value: "CA", label: "Label CA", views: 1, sessions: 1, visitors: 1 },
    ]);
  });

  it("maps defensive event values, filter options, geo labels, and tab ordering", () => {
    expect([
      mapEventFieldValue({
        valueType: 1,
        events: 3,
        occurrences: 4,
        firstSeenAt: 10,
        lastSeenAt: 20,
        stringValue: "pro",
        numberValue: null,
        booleanValue: null,
      }),
      mapEventFieldValue({
        valueType: 2,
        events: 1,
        occurrences: 2,
        firstSeenAt: 30,
        lastSeenAt: 40,
        stringValue: null,
        numberValue: 12.5,
        booleanValue: null,
      }),
      mapEventFieldValue({
        valueType: 3,
        events: 5,
        occurrences: 6,
        firstSeenAt: 50,
        lastSeenAt: 60,
        stringValue: null,
        numberValue: null,
        booleanValue: 0,
      }),
      mapEventFieldValue({
        valueType: 0,
        events: null as unknown as number,
        occurrences: undefined as unknown as number,
        firstSeenAt: null as unknown as number,
        lastSeenAt: undefined as unknown as number,
        stringValue: "ignored",
        numberValue: 99,
        booleanValue: 1,
      }),
    ]).toEqual([
      {
        value: "pro",
        events: 3,
        occurrences: 4,
        firstSeenAt: 10,
        lastSeenAt: 20,
      },
      {
        value: 12.5,
        events: 1,
        occurrences: 2,
        firstSeenAt: 30,
        lastSeenAt: 40,
      },
      {
        value: false,
        events: 5,
        occurrences: 6,
        firstSeenAt: 50,
        lastSeenAt: 60,
      },
      {
        value: null,
        events: 0,
        occurrences: 0,
        firstSeenAt: 0,
        lastSeenAt: 0,
      },
    ]);

    expect(
      dedupeFilterOptions([
        { value: null as unknown as string, label: "empty" },
        { value: " alpha ", label: undefined as unknown as string },
        { value: "alpha", label: "duplicate" },
        { value: " beta ", label: " " },
      ]),
    ).toEqual([
      { value: "alpha", label: "alpha" },
      { value: "beta", label: "beta" },
    ]);
    expect(
      mapReferrerRowsToFilterOptions([
        { referrer: "", views: 1, sessions: 1, visitors: 1 },
        { referrer: "   ", views: 1, sessions: 1, visitors: 1 },
        { referrer: " news.example ", views: 1, sessions: 1, visitors: 1 },
        { referrer: "news.example", views: 1, sessions: 1, visitors: 1 },
      ]),
    ).toEqual([
      {
        value: DIRECT_REFERRER_FILTER_VALUE,
        label: DIRECT_REFERRER_FILTER_VALUE,
      },
      { value: "news.example", label: "news.example" },
    ]);

    expect(
      mapGeoRowsToFilterOptions(
        [
          { value: "US", views: 1, sessions: 1, visitors: 1 },
          { value: "::::", views: 1, sessions: 1, visitors: 1 },
        ],
        "country",
      ),
    ).toEqual([
      { value: "US", label: "US", group: "country" },
      { value: "::::", label: "::::", group: "country" },
    ]);
    expect(
      mapGeoRowsToFilterOptions(
        [
          { value: "US::CA", views: 1, sessions: 1, visitors: 1 },
          { value: "US::CA::California", views: 1, sessions: 1, visitors: 1 },
        ],
        "region",
      ),
    ).toEqual([
      { value: "US::CA", label: "US", group: "region" },
      {
        value: "US::CA::California",
        label: "California",
        group: "region",
      },
    ]);
    expect(
      mapGeoRowsToFilterOptions(
        [
          { value: "US::Austin", views: 1, sessions: 1, visitors: 1 },
          {
            value: "US::CA::California::San Francisco",
            views: 1,
            sessions: 1,
            visitors: 1,
          },
        ],
        "city",
      ),
    ).toEqual([
      { value: "US::Austin", label: "Austin", group: "city" },
      {
        value: "US::CA::California::San Francisco",
        label: "San Francisco",
        group: "city",
      },
    ]);
    expect(geoTabLabel("US::CA", "region")).toBe("US");
    expect(geoTabLabel("US::Austin", "city")).toBe("Austin");
    expect(geoTabLabel("unknown", "timezone")).toBe("unknown");

    const buckets = new Map();
    addDimensionValue(buckets, "beta", "session-a", "visitor-a");
    addDimensionValue(buckets, "alpha", "session-b", "visitor-b");
    addDimensionValue(buckets, "gamma", "session-c", "visitor-c");
    addDimensionValue(buckets, "gamma", "session-c", "visitor-c");
    addDimensionValue(buckets, "gamma", "session-d", "visitor-c");
    addDimensionValue(buckets, "   ", "session-e", "visitor-e");

    expect(finalizeDimensionBuckets(buckets, 10)).toEqual([
      { value: "gamma", views: 3, sessions: 2, visitors: 1 },
      { value: "alpha", views: 1, sessions: 1, visitors: 1 },
      { value: "beta", views: 1, sessions: 1, visitors: 1 },
    ]);
  });

  it("maps event records and analytics context cards", () => {
    expect(
      mapEventRecord({
        eventId: "event-1",
        eventName: "signup",
        occurredAt: 10,
        receivedAt: 12,
        sequence: 2,
        visitId: "visit-1",
        sessionId: "session-1",
        visitorId: "visitor-1",
        pathname: "/signup",
        title: "Signup",
        hostname: "example.com",
        referrerHost: "news.example",
        country: "US",
        region: "CA",
        browser: "Chrome",
        browserVersion: "124",
        os: "macOS",
        osVersion: "14",
        deviceType: "desktop",
        nodeCount: 3,
        valueCount: 4,
      }),
    ).toEqual({
      eventId: "event-1",
      eventName: "signup",
      occurredAt: 10,
      receivedAt: 12,
      sequence: 2,
      visitId: "visit-1",
      sessionId: "session-1",
      visitorId: "visitor-1",
      pathname: "/signup",
      title: "Signup",
      hostname: "example.com",
      referrerHost: "news.example",
      country: "US",
      region: "CA",
      browser: "Chrome",
      browserVersion: "124",
      os: "macOS",
      osVersion: "14",
      deviceType: "desktop",
      nodeCount: 3,
      valueCount: 4,
    });

    const dim = [{ value: "A", views: 1, sessions: 1, visitors: 1 }];
    const geo = [
      {
        value: "US",
        label: "United States",
        views: 1,
        sessions: 1,
        visitors: 1,
      },
    ];
    expect(
      mapEventAnalyticsContextCards({
        page: {
          path: dim,
          query: [],
          title: [],
          hostname: [],
          entry: [],
          exit: [],
        },
        source: { domain: dim, link: [] },
        client: {
          browser: dim,
          osVersion: [],
          deviceType: [],
          language: [],
          screenSize: [],
        },
        geo: {
          country: geo,
          region: [],
          city: [],
          continent: [],
          timezone: [],
          organization: [],
        },
      }),
    ).toMatchObject({
      page: { path: [{ label: "A", views: 1, sessions: 1, visitors: 1 }] },
      source: { domain: [{ label: "A", views: 1, sessions: 1, visitors: 1 }] },
      client: { browser: [{ label: "A", views: 1, sessions: 1, visitors: 1 }] },
      geo: {
        country: [
          {
            value: "US",
            label: "United States",
            views: 1,
            sessions: 1,
            visitors: 1,
          },
        ],
      },
    });
  });
});

describe("edge query core share trend keys", () => {
  it("normalizes labels and avoids collisions", () => {
    const usedKeys = new Set<string>();

    expect(shareTrendSeriesKey("Chrome 124", usedKeys, "series")).toBe(
      "chrome-124",
    );
    expect(shareTrendSeriesKey("Chrome/124", usedKeys, "series")).toBe(
      "chrome-124-2",
    );
    expect(shareTrendSeriesKey("   !!!   ", usedKeys, "series")).toBe("series");
    expect(shareTrendSeriesKey("", usedKeys, "series")).toBe("series-2");
    expect([...usedKeys]).toEqual([
      "chrome-124",
      "chrome-124-2",
      "series",
      "series-2",
    ]);
  });
});

describe("edge query core SQL helpers", () => {
  it("appends SQL conditions without dropping existing clauses", () => {
    expect(
      appendSqlConditions("", ["", " started_at >= ? ", "site_id = ?"]),
    ).toBe("WHERE started_at >= ? AND site_id = ?");
    expect(
      appendSqlConditions("WHERE status = 'active'", [
        "started_at >= ?",
        "  ",
        "started_at < ?",
      ]),
    ).toBe("WHERE status = 'active' AND started_at >= ? AND started_at < ?");
  });

  it("builds visit filters for direct traffic, client dimensions, and geo values", () => {
    const filter = buildVisitFilterSql(
      {
        country: "US",
        sourceDomain: DIRECT_REFERRER_FILTER_VALUE,
        sourceLink: "HTTPS://REF.EXAMPLE/POST",
        clientOsVersion: "macOS 14",
        clientScreenSize: "1440x900",
        geo: "US::CA::California::San Francisco",
      },
      "v",
    );

    expect(filter.clause).toContain("LOWER(TRIM(COALESCE(v.country, ''))) = ?");
    expect(filter.clause).toContain("TRIM(COALESCE(v.referrer_host, '')) = ''");
    expect(filter.clause).toContain(
      "LOWER(TRIM(COALESCE(v.referrer_url, ''))) = ?",
    );
    expect(filter.clause).toContain("v.os || ' ' || v.os_version");
    expect(filter.clause).toContain(
      "CAST(v.screen_width AS TEXT) || 'x' || CAST(v.screen_height AS TEXT)",
    );
    expect(filter.clause).toContain(
      "UPPER(TRIM(CASE WHEN TRIM(COALESCE(v.region_code, '')) != '' THEN v.region_code ELSE v.region END)) IN (?, ?)",
    );
    expect(filter.clause).toContain("LOWER(TRIM(COALESCE(v.city, ''))) = ?");
    expect(filter.bindings).toEqual([
      "us",
      "https://ref.example/post",
      "macOS 14",
      "1440x900",
      "us",
      "CA",
      "CALIFORNIA",
      "san francisco",
    ]);
  });

  it("parses geo filter values and removes geo filters without mutating other keys", () => {
    expect(parseGeoFilterValue("US::CA::California::San Francisco")).toEqual({
      country: "US",
      regionCode: "CA",
      regionName: "California",
      city: "San Francisco",
    });
    expect(parseGeoFilterValue("bad")).toBeNull();
    expect(withoutGeoFilter({ geo: "US", country: "US" })).toEqual({
      geo: undefined,
      country: "US",
    });
  });

  it("builds visit filters for page metadata, session edges, and direct source links", () => {
    const filter = buildVisitFilterSql({
      title: "Docs",
      entry: "/",
      exit: "/pricing",
      sourceDomain: "News.Example",
      sourceLink: DIRECT_REFERRER_FILTER_VALUE,
      clientLanguage: "en-US",
      geoTimezone: "America/Los_Angeles",
    });

    expect(filter.clause).toContain("TRIM(COALESCE(title, '')) = ?");
    expect(filter.clause).toContain(
      "ORDER BY edge.started_at ASC, edge.visit_id ASC LIMIT 1",
    );
    expect(filter.clause).toContain(
      "ORDER BY edge.started_at DESC, edge.visit_id DESC LIMIT 1",
    );
    expect(filter.clause).toContain(
      "LOWER(TRIM(COALESCE(referrer_host, ''))) = ?",
    );
    expect(filter.clause).toContain("TRIM(COALESCE(referrer_url, '')) = ''");
    expect(filter.clause).toContain("TRIM(COALESCE(language, '')) = ?");
    expect(filter.clause).toContain("TRIM(COALESCE(timezone, '')) = ?");
    expect(filter.bindings).toEqual([
      "Docs",
      "/",
      "/pricing",
      "news.example",
      "en-US",
      "America/Los_Angeles",
    ]);

    expect(buildVisitFilterSql({})).toEqual({ clause: "", bindings: [] });
  });

  it("classifies event payload filter values", () => {
    expect(eventPayloadFilterValueType(null)).toBe("null");
    expect(eventPayloadFilterValueType(1)).toBe("number");
    expect(eventPayloadFilterValueType(false)).toBe("boolean");
    expect(eventPayloadFilterValueType("value")).toBe("string");
  });

  it("builds event payload and event filters with typed bindings", () => {
    const payload = buildEventPayloadFilterSql(
      {
        eventPayloadFilters: [
          { path: "$.plan", operator: "eq", value: "pro" },
          { path: "/paid", operator: "ne", value: true },
          { path: "/score", operator: "eq", value: 42 },
          { path: "/missing", operator: "ne", value: null },
        ],
      },
      "ev",
    );

    expect(payload.clauses).toHaveLength(4);
    expect(payload.clauses.join("\n")).toContain("epv0.event_pk = ev.event_pk");
    expect(payload.clauses.join("\n")).toContain(
      "COALESCE(epv0.string_value, '') = ?",
    );
    expect(payload.clauses.join("\n")).toContain("epv1.boolean_value != ?");
    expect(payload.clauses.join("\n")).toContain("epv2.number_value = ?");
    expect(payload.clauses.join("\n")).toContain("epv3.value_type != ?");
    expect(payload.bindings).toEqual([
      "/plan",
      1,
      "pro",
      "/paid",
      3,
      1,
      "/score",
      2,
      42,
      "/missing",
      0,
    ]);

    const eventFilter = buildEventFilterSql(
      {
        browser: "Chrome",
        eventPayloadFilters: [{ path: "/plan", operator: "eq", value: "pro" }],
      },
      "ev",
      { eventName: "signup", search: "Checkout" },
    );

    expect(eventFilter.clause).toContain("TRIM(COALESCE(ev.browser, '')) = ?");
    expect(eventFilter.clause).toContain(
      "TRIM(COALESCE(ev.event_name, '')) = ?",
    );
    expect(eventFilter.clause).toContain(
      "LOWER(TRIM(COALESCE(ev.event_id, ''))) LIKE ?",
    );
    expect(eventFilter.bindings).toEqual([
      "Chrome",
      "/plan",
      1,
      "pro",
      "signup",
      "%checkout%",
      "%checkout%",
      "%checkout%",
      "%checkout%",
      "%checkout%",
      "%checkout%",
      "%checkout%",
      "%checkout%",
    ]);

    expect(
      buildEventPayloadFilterSql({
        eventPayloadFilters: [
          { path: "/", operator: "eq", value: "skip" },
          {
            path: "/unsupported",
            operator: "eq",
            value: { nested: true } as never,
          },
        ],
      }),
    ).toEqual({ clauses: [], bindings: [] });

    expect(
      buildEventPayloadFilterSql(
        {
          eventPayloadFilters: [
            { path: "/paid", operator: "eq", value: false },
          ],
        },
        "",
      ).bindings,
    ).toEqual(["/paid", 3, 0]);

    expect(buildEventFilterSql({}, "")).toEqual({ clause: "", bindings: [] });
  });

  it("maps custom event JSON type labels and codes", () => {
    expect(customEventJsonTypeLabel(0)).toBe("null");
    expect(customEventJsonTypeLabel(4)).toBe("object");
    expect(customEventJsonTypeLabel(5)).toBe("array");
    expect(customEventJsonTypeCode("null")).toBe(0);
    expect(customEventJsonTypeCode("object")).toBe(4);
    expect(customEventJsonTypeCode("array")).toBe(5);
    expect(customEventJsonTypeCode("unknown")).toBeNull();
  });

  it("builds deterministic event ordering clauses", () => {
    expect(eventRecordOrderBy({ key: "eventName", direction: "asc" })).toBe(
      "eventName ASC, occurredAt DESC, eventId DESC",
    );
    expect(eventRecordOrderBy({ key: "pathname", direction: "desc" })).toBe(
      "pathname DESC, occurredAt DESC, eventId DESC",
    );
    expect(eventRecordOrderBy({ key: "occurredAt", direction: "asc" })).toBe(
      "occurredAt ASC, eventId ASC",
    );
  });
});

describe("edge query core performance helpers", () => {
  it("maps visit performance metrics with nullable and rounded values", () => {
    expect(
      mapVisitPerformanceMetrics({
        perfTtfbMs: "125.1234",
        perfFcpMs: "",
        perfLcpMs: "-1",
        perfCls: 0.12345,
        perfInpMs: Number.NaN,
      }),
    ).toEqual({
      ttfb: 125.123,
      fcp: null,
      lcp: null,
      cls: 0.123,
      inp: null,
    });
  });

  it("returns known performance metric columns and empty route metrics", () => {
    expect(performanceMetricColumn("lcp")).toBe("perf_lcp_ms");
    expect(emptyPerformanceRouteMetrics()).toEqual({
      ttfb: { avg: null, p50: null, p75: null, p95: null, samples: 0 },
      fcp: { avg: null, p50: null, p75: null, p95: null, samples: 0 },
      lcp: { avg: null, p50: null, p75: null, p95: null, samples: 0 },
      cls: { avg: null, p50: null, p75: null, p95: null, samples: 0 },
      inp: { avg: null, p50: null, p75: null, p95: null, samples: 0 },
    });
  });
});
