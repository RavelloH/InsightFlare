import { beforeEach, describe, expect, it, vi } from "vitest";

import type * as QueryCore from "@/lib/edge/query/core";
import type { QueryWindow } from "@/lib/edge/query/core";
import { queryEventTypeOverviewFromD1 } from "@/lib/edge/query/events-overview";
import { EMPTY_FILTER_DOCUMENT } from "@/lib/edge/query-contract";
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
  endExclusiveMs: Date.UTC(2026, 0, 1, 1),
  nowMs: Date.UTC(2026, 0, 1, 2),
  timeZone: "UTC",
};

describe("edge query event type overview branch coverage", () => {
  beforeEach(() => {
    queryD1AllMock.mockReset();
  });

  it("computes positive average events per session and share of scoped events", async () => {
    queryD1AllMock.mockResolvedValueOnce([
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

  it("normalizes nullable event overview metrics to zero", async () => {
    queryD1AllMock.mockResolvedValueOnce([
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
    queryD1AllMock.mockResolvedValueOnce([
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
    queryD1AllMock.mockResolvedValueOnce([
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
