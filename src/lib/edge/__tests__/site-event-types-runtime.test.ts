import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/edge/analytics/providers/d1/internal/events-context", () => ({
  queryEventAnalyticsContextCardsFromD1: vi.fn(),
}));
vi.mock("@/lib/edge/analytics/providers/d1/internal/events-fields", () => ({
  queryEventFieldsFromD1: vi.fn(),
  queryEventFieldValuesFromD1: vi.fn(),
  queryEventFieldsPageFromD1: vi.fn(),
  queryEventFieldValuesPageFromD1: vi.fn(),
  decodeEventFieldCursor: vi.fn(),
  decodeEventFieldValueCursor: vi.fn(),
}));
vi.mock("@/lib/edge/analytics/providers/d1/internal/events-overview", () => ({
  queryEventTypeOverviewFromD1: vi.fn(),
}));
vi.mock("@/lib/edge/analytics/providers/d1/internal/events-summary", () => ({
  queryEventTypeAggregate: vi.fn(),
  queryEventTypePageFromD1: vi.fn(),
  decodeEventTypeCursor: vi.fn(),
  queryEventsSummaryFromD1: vi.fn(),
}));
vi.mock("@/lib/edge/analytics/providers/d1/internal/events-trend", () => ({
  queryEventTypeTrendFromD1: vi.fn(),
  queryEventsTrendFromD1: vi.fn(),
}));

import { queryEventAnalyticsContextCardsFromD1 } from "@/lib/edge/analytics/providers/d1/internal/events-context";
import {
  decodeEventFieldCursor,
  decodeEventFieldValueCursor,
  queryEventFieldsFromD1,
  queryEventFieldsPageFromD1,
  queryEventFieldValuesFromD1,
  queryEventFieldValuesPageFromD1,
} from "@/lib/edge/analytics/providers/d1/internal/events-fields";
import { queryEventTypeOverviewFromD1 } from "@/lib/edge/analytics/providers/d1/internal/events-overview";
import {
  decodeEventTypeCursor,
  queryEventsSummaryFromD1,
  queryEventTypeAggregate,
  queryEventTypePageFromD1,
} from "@/lib/edge/analytics/providers/d1/internal/events-summary";
import {
  queryEventsTrendFromD1,
  queryEventTypeTrendFromD1,
} from "@/lib/edge/analytics/providers/d1/internal/events-trend";
import {
  readSiteEventFields,
  readSiteEventFieldValues,
  readSiteEventsSummary,
  readSiteEventsTimeseries,
  readSiteEventTypeDetail,
  readSiteEventTypes,
} from "@/lib/edge/analytics/providers/d1/operations/site-events";

const base = {
  env: {} as never,
  siteId: "site-1",
  window: { startMs: 0, endExclusiveMs: 100, nowMs: 100, timeZone: "UTC" },
  filters: { version: 1 as const, root: null },
};

const cards = {
  page: { path: [], query: [], title: [], hostname: [], entry: [], exit: [] },
  source: { domain: [], link: [] },
  client: {
    browser: [],
    osVersion: [],
    deviceType: [],
    language: [],
    screenSize: [],
  },
  geo: {
    country: [],
    region: [],
    city: [],
    continent: [],
    timezone: [],
    organization: [],
  },
};

describe("site event-types runtime", () => {
  beforeEach(() => vi.clearAllMocks());

  it("runs the event type list, fields, and values through typed operations", async () => {
    vi.mocked(queryEventTypeAggregate).mockResolvedValue([
      { value: "signup", views: 3, sessions: 2, visitors: 2 },
    ]);
    vi.mocked(queryEventFieldsFromD1).mockResolvedValue([]);
    vi.mocked(queryEventFieldValuesFromD1).mockResolvedValue([]);

    await expect(
      readSiteEventTypes({ ...base, search: "sign", limit: 20 }),
    ).resolves.toEqual({
      items: [
        { key: "signup", label: "signup", events: 3, sessions: 2, visitors: 2 },
      ],
      page: { limit: 20 },
    });
    await expect(
      readSiteEventFields({ ...base, eventName: "signup", limit: 100 }),
    ).resolves.toEqual({
      eventName: "signup",
      items: [],
      page: { limit: 100 },
    });
    await expect(
      readSiteEventFieldValues({
        ...base,
        eventName: "signup",
        fieldPath: "plan",
        fieldValueType: "string",
        search: "pro",
        limit: 25,
      }),
    ).resolves.toEqual({
      eventName: "signup",
      fieldPath: "plan",
      fieldValueType: "string",
      items: [],
      page: { limit: 25 },
    });
    expect(queryEventTypeAggregate).toHaveBeenCalledWith(
      base.env,
      "site-1",
      base.window,
      base.filters,
      20,
      "sign",
    );
    expect(queryEventFieldsFromD1).toHaveBeenCalledWith(
      base.env,
      "site-1",
      base.window,
      base.filters,
      "signup",
      100,
    );
    expect(queryEventFieldValuesFromD1).toHaveBeenCalledWith(
      base.env,
      "site-1",
      base.window,
      base.filters,
      "signup",
      "plan",
      "string",
      25,
      "pro",
    );
  });

  it("builds the detail composite inside one typed event-type operation", async () => {
    vi.mocked(queryEventTypeOverviewFromD1).mockResolvedValue({
      summary: {
        events: 3,
        eventTypes: 1,
        sessions: 2,
        visitors: 2,
        avgEventsPerSession: 1.5,
        shareOfAllEvents: 1,
      },
      breakdowns: {
        pages: [{ value: "/signup", views: 3, sessions: 2, visitors: 2 }],
        countries: [{ value: "US", views: 3, sessions: 2, visitors: 2 }],
        devices: [{ value: "desktop", views: 3, sessions: 2, visitors: 2 }],
        browsers: [{ value: "Chrome", views: 3, sessions: 2, visitors: 2 }],
      },
    });
    vi.mocked(queryEventTypeTrendFromD1).mockResolvedValue({
      data: [{ bucket: 0, timestampMs: 0, events: 3, visitors: 2 }],
    });
    vi.mocked(queryEventFieldsFromD1).mockResolvedValue([]);
    vi.mocked(queryEventAnalyticsContextCardsFromD1).mockResolvedValue(cards);

    await expect(
      readSiteEventTypeDetail({
        ...base,
        eventName: "signup",
        interval: "day",
      }),
    ).resolves.toMatchObject({
      eventName: "signup",
      trend: { data: [{ timestamp: "1970-01-01T00:00:00.000Z" }] },
      cards,
    });
    expect(queryEventTypeOverviewFromD1).toHaveBeenCalledWith(
      base.env,
      "site-1",
      base.window,
      base.filters,
      "signup",
      { includeBreakdowns: true },
    );
    expect(queryEventTypeTrendFromD1).toHaveBeenCalledWith(
      base.env,
      "site-1",
      base.window,
      "day",
      base.filters,
      "signup",
    );
    expect(queryEventAnalyticsContextCardsFromD1).toHaveBeenCalledWith(
      base.env,
      "site-1",
      base.window,
      base.filters,
      100,
      "signup",
    );
  });

  it("maps event summary and timeseries operations independently", async () => {
    const summaryCards = {
      event: { name: [] },
      page: { path: [], title: [], hostname: [] },
    };
    vi.mocked(queryEventsSummaryFromD1).mockResolvedValue({
      summary: { events: 6, eventTypes: 2, sessions: 3, visitors: 2 },
      cards: summaryCards,
    });
    vi.mocked(queryEventsTrendFromD1).mockResolvedValue({
      series: [
        {
          key: "all",
          eventName: "all",
          label: "all",
          events: 6,
          sessions: 3,
          visitors: 2,
        },
      ],
      data: [
        {
          bucket: 0,
          timestampMs: 1_000,
          totalEvents: 6,
          eventsBySeries: { all: 6 },
        },
      ],
    });

    await expect(readSiteEventsSummary(base)).resolves.toMatchObject({
      summary: {
        events: 6,
        eventTypes: 2,
        sessions: 3,
        visitors: 2,
        avgEventsPerSession: 2,
      },
      cards: summaryCards,
    });
    await expect(
      readSiteEventsTimeseries({
        ...base,
        interval: "day",
        limit: 10,
      }),
    ).resolves.toEqual({
      interval: "day",
      series: [
        {
          key: "all",
          eventName: "all",
          label: "all",
          events: 6,
          sessions: 3,
          visitors: 2,
        },
      ],
      points: [
        {
          bucket: 0,
          timestamp: "1970-01-01T00:00:01.000Z",
          totalEvents: 6,
          eventsBySeries: { all: 6 },
        },
      ],
    });
    expect(queryEventsSummaryFromD1).toHaveBeenCalledWith(
      base.env,
      base.siteId,
      base.window,
      base.filters,
    );
    expect(queryEventsTrendFromD1).toHaveBeenCalledWith(
      base.env,
      base.siteId,
      base.window,
      "day",
      base.filters,
      10,
    );
  });

  it("loads event types, fields, and values through their page contracts", async () => {
    vi.mocked(queryEventTypePageFromD1).mockResolvedValue({
      items: [{ value: "purchase", views: 4, sessions: 3, visitors: 2 }],
      pagination: {
        limit: 1,
        returned: 1,
        hasMore: true,
        nextCursor: "event-type-next",
      },
    });
    vi.mocked(queryEventFieldsPageFromD1).mockResolvedValue({
      items: [
        {
          path: "plan",
          valueType: 1,
          events: 2,
          occurrences: 3,
          firstSeenAt: 1,
          lastSeenAt: 2,
          stringValue: "pro",
          numberValue: null,
          booleanValue: null,
        },
      ],
      pagination: {
        limit: 1,
        returned: 1,
        hasMore: false,
        nextCursor: null,
      },
    });
    vi.mocked(queryEventFieldValuesPageFromD1).mockResolvedValue({
      items: [
        {
          valueType: 1,
          events: 2,
          occurrences: 2,
          firstSeenAt: 1,
          lastSeenAt: 2,
          stringValue: "pro",
          numberValue: null,
          booleanValue: null,
        },
      ],
      pagination: {
        limit: 1,
        returned: 1,
        hasMore: false,
        nextCursor: null,
      },
    });
    vi.mocked(decodeEventTypeCursor).mockResolvedValue({
      views: 5,
      sessions: 4,
      value: "signup",
    });
    vi.mocked(decodeEventFieldCursor).mockResolvedValue({
      events: 3,
      occurrences: 4,
      path: "email",
      valueType: "string",
    });
    vi.mocked(decodeEventFieldValueCursor).mockResolvedValue({
      occurrences: 3,
      events: 2,
      stringValue: "basic",
      numberValue: -1,
      booleanValue: -1,
    });

    await expect(
      readSiteEventTypes({
        ...base,
        search: "purchase",
        audience: "public-share",
        page: { limit: 1, cursor: "event-type-cursor" },
      }),
    ).resolves.toMatchObject({
      items: [
        {
          key: "purchase",
          label: "purchase",
          events: 4,
          sessions: 3,
          visitors: 2,
        },
      ],
      pagination: { hasMore: true, nextCursor: "event-type-next" },
    });
    await expect(
      readSiteEventFields({
        ...base,
        eventName: "purchase",
        audience: "public-share",
        page: { limit: 1, cursor: "field-cursor" },
      }),
    ).resolves.toMatchObject({
      eventName: "purchase",
      items: [{ path: "plan", valueType: "string" }],
      pagination: { hasMore: false },
    });
    await expect(
      readSiteEventFieldValues({
        ...base,
        eventName: "purchase",
        fieldPath: "plan",
        fieldValueType: "string",
        search: "pro",
        audience: "public-share",
        page: { limit: 1, cursor: "value-cursor" },
      }),
    ).resolves.toMatchObject({
      fieldPath: "plan",
      fieldValueType: "string",
      items: [{ value: "pro" }],
      pagination: { hasMore: false },
    });
    expect(queryEventTypePageFromD1).toHaveBeenCalledWith(
      base.env,
      "site-1",
      base.window,
      base.filters,
      1,
      "purchase",
      expect.objectContaining({ value: "signup" }),
      "public-share",
    );
  });

  it("rejects cursors that cannot be decoded for each event collection", async () => {
    vi.mocked(decodeEventTypeCursor).mockResolvedValue(null);
    vi.mocked(decodeEventFieldCursor).mockResolvedValue(null);
    vi.mocked(decodeEventFieldValueCursor).mockResolvedValue(null);

    await expect(
      readSiteEventTypes({ ...base, page: { limit: 1, cursor: "bad" } }),
    ).rejects.toThrow("invalid-cursor");
    await expect(
      readSiteEventFields({ ...base, page: { limit: 1, cursor: "bad" } }),
    ).rejects.toThrow("invalid-cursor");
    await expect(
      readSiteEventFieldValues({
        ...base,
        fieldPath: "plan",
        fieldValueType: "string",
        page: { limit: 1, cursor: "bad" },
      }),
    ).rejects.toThrow("invalid-cursor");
    expect(queryEventTypePageFromD1).not.toHaveBeenCalled();
  });

  it("passes canonical filters through without audience policy", async () => {
    await expect(
      readSiteEventTypes({
        ...base,
        limit: 20,
        filters: {
          version: 1,
          root: {
            kind: "condition",
            target: { kind: "field", field: "unknown.field" as never },
            operator: "eq",
            value: "x",
          },
        },
      }),
    ).resolves.toBeDefined();
    expect(queryEventTypeAggregate).toHaveBeenCalled();
  });

  it("preserves provider failures for the application boundary", async () => {
    vi.mocked(queryEventTypeAggregate).mockRejectedValueOnce(new Error("down"));
    await expect(readSiteEventTypes({ ...base, limit: 20 })).rejects.toThrow(
      "down",
    );

    vi.mocked(queryEventFieldsFromD1).mockRejectedValueOnce(new Error("down"));
    await expect(
      readSiteEventFields({ ...base, eventName: "signup", limit: 100 }),
    ).rejects.toThrow("down");

    vi.mocked(queryEventFieldValuesFromD1).mockRejectedValueOnce(
      new Error("down"),
    );
    await expect(
      readSiteEventFieldValues({
        ...base,
        eventName: "signup",
        fieldPath: "plan",
        fieldValueType: "string",
        limit: 25,
      }),
    ).rejects.toThrow("down");

    vi.mocked(queryEventTypeOverviewFromD1).mockRejectedValueOnce(
      new Error("down"),
    );
    await expect(
      readSiteEventTypeDetail({
        ...base,
        eventName: "signup",
        interval: "day",
      }),
    ).rejects.toThrow("down");
  });
});
