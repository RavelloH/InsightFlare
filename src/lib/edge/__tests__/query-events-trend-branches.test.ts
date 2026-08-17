import { beforeEach, describe, expect, it, vi } from "vitest";

import type * as QueryCore from "@/lib/edge/query/core";
import {
  type QueryWindow,
  SHARE_TREND_OTHER_KEY,
  SHARE_TREND_OTHER_LABEL,
  SHARE_TREND_OTHER_TOKEN,
} from "@/lib/edge/query/core";
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
const siteId = "site-1";
const window: QueryWindow = {
  startMs: Date.UTC(2026, 0, 1),
  endExclusiveMs: Date.UTC(2026, 0, 1, 2),
  nowMs: Date.UTC(2026, 0, 2),
  timeZone: "UTC",
};

describe("edge query events trend defensive branches", () => {
  beforeEach(() => {
    queryD1AllMock.mockReset();
  });

  it("falls back to trend-row totals when Other series aggregate values are empty", async () => {
    queryD1AllMock
      .mockResolvedValueOnce([{ eventName: "signup", events: 1 }])
      .mockResolvedValueOnce([
        { bucket: null, seriesKey: "signup", events: 100 },
        { bucket: 0, seriesKey: null, events: null },
        { bucket: 1, seriesKey: SHARE_TREND_OTHER_TOKEN, events: undefined },
        { bucket: 1, seriesKey: SHARE_TREND_OTHER_TOKEN, events: 3 },
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
      {},
      1,
    );

    expect(result.series).toEqual([
      {
        key: "signup",
        eventName: "signup",
        label: "signup",
        events: 1,
        sessions: undefined,
        visitors: undefined,
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
    queryD1AllMock.mockResolvedValueOnce([
      { bucket: null, events: 7, visitors: 7 },
      { bucket: 0, events: null, visitors: undefined },
    ]);

    const result = await queryEventTypeTrendFromD1(
      env,
      siteId,
      window,
      "hour",
      {},
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
