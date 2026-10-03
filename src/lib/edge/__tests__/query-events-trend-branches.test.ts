import { beforeEach, describe, expect, it, vi } from "vitest";

import { EMPTY_FILTER_DOCUMENT } from "@/lib/edge/analytics/contract";
import {
  type QueryWindow,
  SHARE_TREND_OTHER_KEY,
  SHARE_TREND_OTHER_LABEL,
  SHARE_TREND_OTHER_TOKEN,
} from "@/lib/edge/analytics/providers/d1/internal/core";
import {
  queryEventsTrendFromD1,
  queryEventTypeTrendFromD1,
} from "@/lib/edge/analytics/providers/d1/internal/events-trend";
import type { Env } from "@/lib/edge/types";

const queryOutputRowsMock = vi.hoisted(() => vi.fn());

vi.mock(
  "@/lib/edge/analytics/providers/d1/internal/analytics-report-query",
  () => ({
    queryAnalyticsReportOutputRowsFromD1: queryOutputRowsMock,
  }),
);

const env = {} as Env;
const siteId = "site-1";
const window: QueryWindow = {
  startMs: Date.UTC(2026, 0, 1),
  endExclusiveMs: Date.UTC(2026, 0, 1, 2),
  nowMs: Date.UTC(2026, 0, 2),
  timeZone: "UTC",
};

describe("edge query events trend defensive branches", () => {
  beforeEach(() => {
    queryOutputRowsMock.mockReset();
  });

  it("falls back to trend-row totals when Other series aggregate values are empty", async () => {
    queryOutputRowsMock
      .mockResolvedValueOnce([{ eventName: "signup", events: 1 }])
      .mockResolvedValueOnce([
        { bucket: null, seriesName: "signup", events: 100 },
        { bucket: 0, seriesName: null, events: null },
        {
          bucket: 1,
          seriesName: SHARE_TREND_OTHER_TOKEN,
          events: undefined,
        },
        { bucket: 1, seriesName: SHARE_TREND_OTHER_TOKEN, events: 3 },
      ])
      .mockResolvedValueOnce([
        {
          eventName: SHARE_TREND_OTHER_LABEL,
          events: null,
          sessions: undefined,
          visitors: null,
        },
      ]);

    const result = await queryEventsTrendFromD1(
      env,
      siteId,
      window,
      "hour",
      EMPTY_FILTER_DOCUMENT,
      1,
    );

    expect(result.series).toEqual([
      {
        key: "signup",
        eventName: "signup",
        label: "signup",
        events: 1,
        sessions: 0,
        visitors: 0,
      },
      {
        key: SHARE_TREND_OTHER_KEY,
        eventName: SHARE_TREND_OTHER_LABEL,
        label: SHARE_TREND_OTHER_LABEL,
        events: 3,
        sessions: 0,
        visitors: 0,
        isOther: true,
      },
    ]);
    expect(result.data[0]).toMatchObject({
      totalEvents: 0,
      eventsBySeries: { "": 0 },
    });
    expect(result.data[1]).toMatchObject({
      totalEvents: 3,
      eventsBySeries: { [SHARE_TREND_OTHER_KEY]: 3 },
    });
  });

  it("normalizes sparse event type trend rows to zeroes", async () => {
    queryOutputRowsMock.mockResolvedValueOnce([
      { bucket: 0, events: null, visitors: undefined },
    ]);

    const result = await queryEventTypeTrendFromD1(
      env,
      siteId,
      window,
      "hour",
      EMPTY_FILTER_DOCUMENT,
      "signup",
    );

    expect(result.data[0]).toMatchObject({
      bucket: 0,
      events: 0,
      visitors: 0,
    });
    expect(result.data[1]).toMatchObject({
      bucket: 1,
      events: 0,
      visitors: 0,
    });
  });
});
