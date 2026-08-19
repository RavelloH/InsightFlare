import { describe, expect, it, vi } from "vitest";

import type { ParsedTimeRange } from "@/lib/edge/api-v1-helpers";
import {
  apiV1OverviewMetrics,
  queryApiV1Breakdown,
  queryApiV1CrossBreakdown,
  queryApiV1EventFields,
  queryApiV1EventFieldValues,
  queryApiV1EventRecordDetail,
  queryApiV1EventRecords,
  queryApiV1EventsSummary,
  queryApiV1EventsTrend,
  queryApiV1EventTypeDetail,
  queryApiV1EventTypes,
  queryApiV1Explore,
  queryApiV1FilterValues,
  queryApiV1FunnelAnalysis,
  queryApiV1JourneyEvents,
  queryApiV1JourneySessions,
  queryApiV1Overview,
  queryApiV1Performance,
  queryApiV1Retention,
  queryApiV1SavedFunnelAnalysis,
  queryApiV1SessionDetail,
  queryApiV1Sessions,
  queryApiV1TeamBreakdown,
  queryApiV1TeamDashboard,
  queryApiV1Trend,
  queryApiV1VisitorDetail,
  queryApiV1Visitors,
} from "@/lib/edge/api-v1-query-adapter";
import * as dimensions from "@/lib/edge/query/dimensions";
import * as eventSummary from "@/lib/edge/query/events-summary";
import * as filterValues from "@/lib/edge/query/filter-values";
import { executePrivateQuery } from "@/lib/edge/query-adapters/private";
import { executePublicQuery } from "@/lib/edge/query-adapters/public";
import type { Env } from "@/lib/edge/types";

const timeRange: ParsedTimeRange = {
  startMs: Date.UTC(2026, 0, 1),
  endExclusiveMs: Date.UTC(2026, 0, 2),
  from: new Date(Date.UTC(2026, 0, 1)).toISOString(),
  to: new Date(Date.UTC(2026, 0, 2)).toISOString(),
  timeZone: "UTC",
};
const url = new URL(
  "https://edge.test/api/v1?interval=day&limit=1&eventName=signup&fieldPath=plan&fieldValueType=string&cards=page.path&eventId=event-1&visitorId=visitor-1&sessionId=session-1",
);
const pagination = { limit: 1, cursor: null };

function emptyEnv(): Env {
  const statement = {
    bind() {
      return statement;
    },
    all: async () => ({ results: [] }),
    first: async () => null,
  };
  return {
    DB: { prepare: () => statement },
  } as unknown as Env;
}

describe("API v1 typed query adapter", () => {
  it("enters every analytics reader through its typed operation", async () => {
    const env = emptyEnv();
    const results = await Promise.all([
      queryApiV1Overview(env, "site-1", url, timeRange),
      queryApiV1Trend(env, "site-1", url, timeRange, "day"),
      queryApiV1TeamDashboard(env, "team-1", ["site-1"], timeRange, "day"),
      queryApiV1Performance("site-1", url, timeRange, async () => ({
        ok: true,
      })),
      queryApiV1Explore("site-1", url, timeRange, async () => []),
      queryApiV1TeamBreakdown(
        "team-1",
        ["site-1"],
        url,
        timeRange,
        async () => [],
      ),
      queryApiV1FunnelAnalysis(env, "site-1", timeRange, [
        { type: "pageview", value: "/" },
        { type: "event", value: "signup" },
      ]),
      queryApiV1SavedFunnelAnalysis(env, "site-1", timeRange, async () => ({
        funnel: { id: "funnel-1" },
        steps: [
          { type: "pageview", value: "/" },
          { type: "event", value: "signup" },
        ],
      })),
      queryApiV1EventRecords(env, "site-1", url, timeRange, pagination),
      queryApiV1EventTypes(env, "site-1", url, timeRange),
      queryApiV1EventFieldValues(env, "site-1", url, timeRange),
      queryApiV1EventFields(env, "site-1", url, timeRange),
      queryApiV1FilterValues(
        env,
        "site-1",
        new URL(`${url}&filterKey=page.path`),
        timeRange,
      ),
      queryApiV1EventsSummary(env, "site-1", url, timeRange),
      queryApiV1EventsTrend(env, "site-1", url, timeRange),
      queryApiV1Retention(env, "site-1", url, timeRange),
      queryApiV1CrossBreakdown(
        env,
        "site-1",
        url,
        timeRange,
        "client.browser",
        "client.osVersion",
      ),
      queryApiV1Breakdown(env, "site-1", url, timeRange, "page.path"),
      queryApiV1EventRecordDetail(env, "site-1", "event-1", timeRange),
      queryApiV1EventTypeDetail(env, "site-1", url, timeRange, "signup"),
      queryApiV1Visitors(env, "site-1", url, timeRange, pagination),
      queryApiV1Sessions(env, "site-1", url, timeRange, pagination),
      queryApiV1VisitorDetail(env, "site-1", "visitor-1", timeRange),
      queryApiV1SessionDetail(env, "site-1", "session-1", timeRange),
      queryApiV1JourneyEvents(env, "site-1", url, timeRange, pagination, {
        type: "visitor",
        value: "visitor-1",
      }),
      queryApiV1JourneySessions(env, "site-1", url, timeRange, pagination, {
        type: "session",
        value: "session-1",
      }),
    ]);

    expect(results).toHaveLength(26);
    expect(results.every((result) => "ok" in result)).toBe(true);
  });

  it("rejects incomplete API v1 field-value and canonical-value requests", async () => {
    const env = emptyEnv();
    const [eventFieldValues, eventFields, filterValues] = await Promise.all([
      queryApiV1EventFieldValues(
        env,
        "site-1",
        new URL("https://edge.test/api/v1?eventName=signup"),
        timeRange,
      ),
      queryApiV1EventFields(
        env,
        "site-1",
        new URL("https://edge.test/api/v1"),
        timeRange,
      ),
      queryApiV1FilterValues(
        env,
        "site-1",
        new URL("https://edge.test/api/v1"),
        timeRange,
      ),
    ]);

    expect(eventFieldValues.ok).toBe(false);
    expect(eventFields.ok).toBe(false);
    expect(filterValues.ok).toBe(false);
  });

  it("selects private and public contract readers without a dispatcher", async () => {
    const env = emptyEnv();
    const privatePaths = [
      "overview",
      "trend",
      "pages",
      "referrers",
      "pages-dashboard",
      "retention",
      "performance",
      "event-types",
      "events-summary",
      "events-trend",
      "events-records",
      "event-type-field-values",
      "event-type-fields",
      "event-type-context",
      "event-type-detail",
      "event-record-detail",
      "visitors",
      "sessions",
      "visitor-detail",
      "session-detail",
      "filter-values",
      "overview-geo-points",
      "funnels",
      "countries",
      "page-query",
      "page-hash",
      "utm-source",
      "utm-medium",
      "utm-campaign",
      "utm-term",
      "utm-content",
      "overview-page-path",
      "overview-page-title",
      "overview-page-hostname",
      "overview-page-entry",
      "overview-page-exit",
      "overview-source-domain",
      "overview-source-link",
      "overview-client-browser",
      "overview-client-os-version",
      "overview-client-device-type",
      "overview-client-language",
      "overview-client-screen-size",
      "overview-geo-country",
      "overview-geo-region",
      "overview-geo-city",
      "overview-geo-continent",
      "overview-geo-timezone",
      "overview-geo-organization",
      "browser-trend",
      "browser-engine-trend",
      "browser-version-breakdown",
      "browser-cross-breakdown",
      "browser-radar",
      "referrer-radar",
      "referrer-dimension-trend",
      "client-dimension-trend",
      "utm-dimension-trend",
      "client-cross-breakdown",
    ];
    const publicPaths = [
      "overview",
      "trend",
      "pages",
      "referrers",
      "pages-dashboard",
      "retention",
      "performance",
      "event-types",
      "filter-values",
      "overview-geo-points",
      "countries",
      "utm-source",
      "utm-medium",
      "utm-campaign",
      "utm-term",
      "utm-content",
      "overview-page-path",
      "overview-page-title",
      "overview-page-hostname",
      "overview-page-entry",
      "overview-page-exit",
      "overview-source-domain",
      "overview-client-browser",
      "overview-client-os-version",
      "overview-client-device-type",
      "overview-client-language",
      "overview-client-screen-size",
      "overview-geo-country",
      "overview-geo-region",
      "overview-geo-city",
      "overview-geo-continent",
      "overview-geo-timezone",
      "overview-geo-organization",
      "browser-trend",
      "browser-engine-trend",
      "browser-version-breakdown",
      "browser-cross-breakdown",
      "browser-radar",
      "referrer-radar",
      "referrer-dimension-trend",
      "client-dimension-trend",
      "utm-dimension-trend",
      "client-cross-breakdown",
    ];
    const privateResponses = await Promise.all(
      privatePaths.map((pathname) =>
        executePrivateQuery({ env, siteId: "site-1", pathname, url }),
      ),
    );
    const publicResponses = await Promise.all(
      publicPaths.map((pathname) =>
        executePublicQuery({ env, siteId: "site-1", pathname, url }),
      ),
    );

    expect(
      [...privateResponses, ...publicResponses].every(
        (response) => response instanceof Response,
      ),
    ).toBe(true);
  });

  it("returns typed invalid-cursor failures before selecting API v1 readers", async () => {
    const env = emptyEnv();
    const invalid = { limit: 1, cursor: "invalid" };
    const results = await Promise.all([
      queryApiV1EventRecords(env, "site-1", url, timeRange, invalid),
      queryApiV1Visitors(env, "site-1", url, timeRange, invalid),
      queryApiV1Sessions(env, "site-1", url, timeRange, invalid),
    ]);
    expect(results).toEqual(
      expect.arrayContaining([expect.objectContaining({ ok: false })]),
    );
  });

  it("covers API v1 metric, dimension, and cross-dimension branches", async () => {
    expect(
      apiV1OverviewMetrics({
        current: {
          views: 1,
          sessions: 0,
          visitors: 0,
          bounces: 0,
          totalDurationMs: 10,
          durationViews: 0,
        },
      }),
    ).toMatchObject({ avgDurationMs: 0, bounceRate: 0 });
    expect(
      apiV1OverviewMetrics({
        current: {
          views: 4,
          sessions: 2,
          visitors: 1,
          bounces: 1,
          totalDurationMs: 21,
          durationViews: 2,
        },
      }),
    ).toMatchObject({ avgDurationMs: 11, bounceRate: 0.5 });

    const env = emptyEnv();
    const results = await Promise.all([
      queryApiV1CrossBreakdown(
        env,
        "site-1",
        url,
        timeRange,
        "unsupported",
        "client.osVersion",
      ),
      queryApiV1CrossBreakdown(
        env,
        "site-1",
        url,
        timeRange,
        "client.browser",
        "client.browser",
      ),
      queryApiV1Breakdown(env, "site-1", url, timeRange, "session.entryPath"),
      queryApiV1Breakdown(env, "site-1", url, timeRange, "session.exitPath"),
      queryApiV1Breakdown(env, "site-1", url, timeRange, "event.name"),
      queryApiV1Breakdown(env, "site-1", url, timeRange, "unknown.dimension"),
      queryApiV1SavedFunnelAnalysis(env, "site-1", timeRange, async () => ({
        funnel: null,
        steps: [],
      })),
      queryApiV1SavedFunnelAnalysis(env, "site-1", timeRange, async () => ({
        funnel: { id: "short" },
        steps: [{ type: "pageview", value: "/" }],
      })),
    ]);
    expect(results).toHaveLength(8);
    expect(results.slice(0, 2).every((result) => !result.ok)).toBe(true);
  });

  it("preserves API v1 summary fallbacks and optional event names", async () => {
    const summarySpy = vi
      .spyOn(eventSummary, "queryEventsSummaryFromD1")
      .mockResolvedValue({
        summary: {
          events: null,
          eventTypes: null,
          sessions: null,
          visitors: null,
        },
        cards: {
          event: { name: [] },
          page: { path: [], title: [], hostname: [] },
        },
      } as never);
    const result = await queryApiV1EventsSummary(
      emptyEnv(),
      "site-1",
      new URL("https://edge.test/api/v1?interval=day"),
      timeRange,
    );
    const trend = await queryApiV1EventsTrend(
      emptyEnv(),
      "site-1",
      new URL("https://edge.test/api/v1?interval=day"),
      timeRange,
    );
    summarySpy.mockRestore();
    expect(result).toMatchObject({ ok: true });
    expect(trend).toMatchObject({ ok: true });
  });

  it("maps returned rows for API v1 filter values", async () => {
    const filterSpy = vi
      .spyOn(filterValues, "queryFilterValuesFromD1")
      .mockResolvedValue([
        { value: "/pricing", occurrences: 42 },
        { value: "/about", occurrences: 7 },
      ] as never);
    const result = await queryApiV1FilterValues(
      emptyEnv(),
      "site-1",
      new URL(`${url}&filterKey=page.path`),
      timeRange,
    );
    filterSpy.mockRestore();

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.field).toBe("page.path");
      expect(result.data.data).toEqual([
        { value: "/pricing", label: "/pricing", occurrences: 42 },
        { value: "/about", label: "/about", occurrences: 7 },
      ]);
    }
  });

  it("maps returned rows for API v1 breakdown", async () => {
    const dimensionSpy = vi
      .spyOn(dimensions, "queryDimensionFromD1")
      .mockResolvedValue([
        { value: "/", views: 10, sessions: 5, visitors: 3 },
        { value: "/login", views: 4, sessions: 2, visitors: 2 },
      ] as never);
    const result = await queryApiV1Breakdown(
      emptyEnv(),
      "site-1",
      new URL(`${url}`),
      timeRange,
      "page.path",
    );
    dimensionSpy.mockRestore();

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data).toEqual([
        { value: "/", label: "/", views: 10, sessions: 5, visitors: 3 },
        {
          value: "/login",
          label: "/login",
          views: 4,
          sessions: 2,
          visitors: 2,
        },
      ]);
    }
  });
});
