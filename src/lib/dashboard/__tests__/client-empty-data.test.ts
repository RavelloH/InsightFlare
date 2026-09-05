import { describe, expect, it } from "vitest";

import {
  emptyDashboardFilterOptions,
  emptyDimension,
  emptyEventAnalyticsContextCards,
  emptyEventBreakdowns,
  emptyEventFieldValues,
  emptyEventRecordDetail,
  emptyEventsRecords,
  emptyEventsSummary,
  emptyEventsTrend,
  emptyEventTypeDetail,
  emptyOverview,
  emptyOverviewClientDimensionTabs,
  emptyOverviewGeoDimensionTabs,
  emptyOverviewGeoPoints,
  emptyOverviewGeoTab,
  emptyOverviewTab,
  emptyPageCardTabs,
  emptyPages,
  emptyPerformance,
  emptyReferrers,
  emptySessionDetail,
  emptySessions,
  emptyTrend,
  emptyVisitorDetail,
  emptyVisitors,
} from "@/lib/dashboard/client-empty-data";

describe("dashboard client empty data builders", () => {
  it("builds isolated empty trend and performance payloads", () => {
    const trend = emptyTrend("hour");
    const performance = emptyPerformance("day");

    expect(trend).toEqual({
      ok: true,
      interval: "hour",
      data: [],
    });
    expect(performance.interval).toBe("day");
    expect(performance.summaries.lcp).toEqual({
      avg: null,
      p50: null,
      p75: null,
      p95: null,
      samples: 0,
    });
    expect(performance.trends.lcp).toEqual([]);

    performance.trends.lcp.push({
      bucket: 0,
      timestampMs: 1,
      avg: 10,
      p50: 9,
      p75: 11,
      p95: 20,
      samples: 2,
    });
    expect(emptyPerformance("day").trends.lcp).toEqual([]);
  });

  it("preserves requested empty metadata values", () => {
    expect(emptyEventsRecords(33).data.pagination).toMatchObject({
      limit: 33,
      returned: 0,
      hasMore: false,
      nextCursor: null,
    });
    expect(emptyEventTypeDetail("Signup").summary.eventTypes).toBe(1);
    expect(emptyEventTypeDetail("").summary.eventTypes).toBe(0);
    expect(emptyEventFieldValues("payload.plan", "string")).toEqual({
      ok: true,
      fieldPath: "payload.plan",
      fieldValueType: "string",
      data: {
        items: [],
        pagination: {
          limit: 1,
          returned: 0,
          hasMore: false,
          nextCursor: null,
        },
      },
    });
  });

  it("builds empty dashboard dimension containers", () => {
    expect(emptyVisitors().data.pagination.limit).toBe(1);
    expect(emptySessions().data.pagination).toEqual({
      limit: 1,
      returned: 0,
      hasMore: false,
      nextCursor: null,
    });
    expect(emptyOverviewGeoPoints()).toEqual({
      ok: true,
      data: [],
      countryCounts: [],
      regionCounts: [],
      cityCounts: [],
    });
    expect(emptyOverviewClientDimensionTabs()).toEqual({
      browser: [],
      osVersion: [],
      deviceType: [],
      language: [],
      screenSize: [],
    });
    expect(emptyOverviewGeoDimensionTabs()).toEqual({
      country: [],
      region: [],
      city: [],
      continent: [],
      timezone: [],
      organization: [],
    });
  });

  it("builds empty top-level dashboard payloads", () => {
    expect(emptyOverview().data).toMatchObject({
      views: 0,
      sessions: 0,
      visitors: 0,
      approximateVisitors: false,
    });
    expect(emptyPages()).toEqual({
      ok: true,
      data: {
        items: [],
        pagination: {
          limit: 1,
          returned: 0,
          hasMore: false,
          nextCursor: null,
        },
      },
    });
    expect(emptyReferrers()).toEqual({
      ok: true,
      data: {
        items: [],
        pagination: {
          limit: 1,
          returned: 0,
          hasMore: false,
          nextCursor: null,
        },
      },
    });
    expect(emptyDimension()).toEqual({ ok: true, data: [] });
    expect(emptyOverviewTab()).toEqual({
      ok: true,
      data: {
        items: [],
        pagination: {
          limit: 1,
          returned: 0,
          hasMore: false,
          nextCursor: null,
        },
      },
    });
    expect(emptyOverviewGeoTab()).toEqual({ ok: true, data: [] });
    expect(emptyDashboardFilterOptions()).toEqual({
      ok: true,
      data: {
        items: [],
        pagination: {
          limit: 1,
          returned: 0,
          hasMore: false,
          nextCursor: null,
        },
      },
    });
    expect(emptyPageCardTabs()).toEqual({
      path: [],
      title: [],
      hostname: [],
      entry: [],
      exit: [],
    });
  });

  it("builds empty detail and event analytics payloads", () => {
    expect(emptyVisitorDetail()).toEqual({ ok: true, data: null });
    expect(emptySessionDetail()).toEqual({ ok: true, data: null });
    expect(emptyEventRecordDetail()).toEqual({ ok: true, data: null });
    expect(emptyEventsSummary()).toMatchObject({
      ok: true,
      summary: {
        events: 0,
        eventTypes: 0,
        sessions: 0,
        visitors: 0,
        avgEventsPerSession: 0,
      },
    });
    expect(emptyEventBreakdowns()).toEqual({
      pages: [],
      countries: [],
      devices: [],
      browsers: [],
    });
    expect(emptyEventsTrend("day")).toEqual({
      ok: true,
      interval: "day",
      series: [],
      data: [],
    });
    expect(emptyEventAnalyticsContextCards().geo.country).toEqual([]);
  });
});
