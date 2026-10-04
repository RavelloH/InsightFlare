import { beforeEach, describe, expect, it, vi } from "vitest";

import { EMPTY_FILTER_DOCUMENT } from "@/lib/edge/analytics/contract";
import { EVENT_TYPE_OVERVIEW_OUTPUTS } from "@/lib/edge/analytics/engine/event-type-overview-plan";
import type * as AnalyticsReportQuery from "@/lib/edge/analytics/providers/d1/internal/analytics-report-query";
import type { QueryWindow } from "@/lib/edge/analytics/providers/d1/internal/core";
import { queryEventTypeOverviewFromD1 } from "@/lib/edge/analytics/providers/d1/internal/events-overview";
import type { Env } from "@/lib/edge/types";

const reportOutputSetMock = vi.hoisted(() => vi.fn());

vi.mock(
  "@/lib/edge/analytics/providers/d1/internal/analytics-report-query",
  async () => {
    const actual = await vi.importActual<typeof AnalyticsReportQuery>(
      "@/lib/edge/analytics/providers/d1/internal/analytics-report-query",
    );
    return {
      ...actual,
      queryAnalyticsReportOutputSetRowsFromD1: reportOutputSetMock,
    };
  },
);

const env = {} as Env;
const siteId = "site-1";
const window: QueryWindow = {
  startMs: Date.UTC(2026, 0, 1),
  endExclusiveMs: Date.UTC(2026, 0, 1, 1),
  nowMs: Date.UTC(2026, 0, 1, 2),
  timeZone: "UTC",
};

describe("edge query event type overview branch coverage", () => {
  beforeEach(() => {
    reportOutputSetMock.mockReset();
  });

  it("computes positive average events per session and share of scoped events", async () => {
    reportOutputSetMock.mockResolvedValueOnce([
      {
        events: 6,
        eventTypes: 1,
        sessions: 3,
        visitors: 2,
        cardType: "summary",
        value: null,
        scopedEvents: 20,
      },
      {
        events: 4,
        sessions: 0,
        visitors: 0,
        cardType: "page",
        value: "/pricing",
      },
      {
        events: 3,
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
        value: "Desktop",
      },
      {
        events: 1,
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
        events: 6,
        eventTypes: 1,
        sessions: 3,
        visitors: 2,
        avgEventsPerSession: 2,
        shareOfAllEvents: 0.3,
      },
      breakdowns: {
        pages: [{ value: "/pricing", views: 4, sessions: 0, visitors: 0 }],
        countries: [{ value: "US", views: 3, sessions: 0, visitors: 0 }],
        devices: [{ value: "Desktop", views: 2, sessions: 0, visitors: 0 }],
        browsers: [{ value: "Chrome", views: 1, sessions: 0, visitors: 0 }],
      },
    });
  });

  it("requests the stable overview order and only the summary when needed", async () => {
    reportOutputSetMock.mockResolvedValue([]);

    await queryEventTypeOverviewFromD1(
      env,
      siteId,
      window,
      EMPTY_FILTER_DOCUMENT,
      "signup",
    );

    expect(reportOutputSetMock).toHaveBeenCalledTimes(1);
    const fullSelection = reportOutputSetMock.mock.calls[0]![2] as {
      readonly outputIds: readonly string[];
      readonly orderBy: readonly {
        readonly field: string;
        readonly direction: "asc" | "desc";
        readonly nulls: "first" | "last";
      }[];
    };
    expect(fullSelection.outputIds).toEqual([
      EVENT_TYPE_OVERVIEW_OUTPUTS.summary,
      EVENT_TYPE_OVERVIEW_OUTPUTS.page,
      EVENT_TYPE_OVERVIEW_OUTPUTS.country,
      EVENT_TYPE_OVERVIEW_OUTPUTS.device,
      EVENT_TYPE_OVERVIEW_OUTPUTS.browser,
    ]);
    expect(fullSelection.orderBy).toEqual([
      { field: "cardType", direction: "asc", nulls: "first" },
      { field: "events", direction: "desc", nulls: "last" },
      { field: "sessions", direction: "desc", nulls: "last" },
      { field: "value", direction: "asc", nulls: "first" },
    ]);

    reportOutputSetMock.mockClear();
    await queryEventTypeOverviewFromD1(
      env,
      siteId,
      window,
      EMPTY_FILTER_DOCUMENT,
      "signup",
      { includeBreakdowns: false },
    );
    expect(reportOutputSetMock).toHaveBeenCalledTimes(1);
    const summarySelection = reportOutputSetMock.mock.calls[0]![2] as {
      readonly outputIds: readonly string[];
      readonly orderBy: readonly unknown[];
    };
    expect(summarySelection.outputIds).toEqual([
      EVENT_TYPE_OVERVIEW_OUTPUTS.summary,
    ]);
    expect(summarySelection.orderBy).toEqual(fullSelection.orderBy);
  });

  it("normalizes nullable event overview metrics to zero", async () => {
    reportOutputSetMock.mockResolvedValueOnce([
      {
        events: null,
        eventTypes: null,
        sessions: null,
        visitors: null,
        cardType: "summary",
        value: null,
        scopedEvents: null,
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

  it("normalizes missing summary fields and empty breakdown values", async () => {
    reportOutputSetMock.mockResolvedValueOnce([
      {
        cardType: "summary",
        value: null,
      },
      {
        cardType: "page",
        value: null,
        events: null,
        sessions: null,
        visitors: null,
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
        sessions: 0,
        visitors: 0,
        avgEventsPerSession: 0,
        shareOfAllEvents: 0,
      },
      breakdowns: {
        pages: [{ value: "", views: 0, sessions: 0, visitors: 0 }],
        countries: [],
        devices: [],
        browsers: [],
      },
    });
  });

  it("keeps positive summary denominators safe when the event count is missing", async () => {
    reportOutputSetMock.mockResolvedValueOnce([
      {
        cardType: "summary",
        value: null,
        sessions: 2,
        scopedEvents: 5,
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
    ).resolves.toMatchObject({
      summary: {
        events: 0,
        sessions: 2,
        avgEventsPerSession: 0,
        shareOfAllEvents: 0,
      },
    });
  });
});
