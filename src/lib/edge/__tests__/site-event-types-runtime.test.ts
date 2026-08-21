import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/edge/query/events-context", () => ({
  queryEventAnalyticsContextCardsFromD1: vi.fn(),
}));
vi.mock("@/lib/edge/query/events-fields", () => ({
  queryEventFieldsFromD1: vi.fn(),
  queryEventFieldValuesFromD1: vi.fn(),
}));
vi.mock("@/lib/edge/query/events-overview", () => ({
  queryEventTypeOverviewFromD1: vi.fn(),
}));
vi.mock("@/lib/edge/query/events-summary", () => ({
  queryEventTypeAggregate: vi.fn(),
}));
vi.mock("@/lib/edge/query/events-trend", () => ({
  queryEventTypeTrendFromD1: vi.fn(),
}));

import { queryEventAnalyticsContextCardsFromD1 } from "@/lib/edge/query/events-context";
import {
  queryEventFieldsFromD1,
  queryEventFieldValuesFromD1,
} from "@/lib/edge/query/events-fields";
import { queryEventTypeOverviewFromD1 } from "@/lib/edge/query/events-overview";
import { queryEventTypeAggregate } from "@/lib/edge/query/events-summary";
import { queryEventTypeTrendFromD1 } from "@/lib/edge/query/events-trend";
import {
  readSiteEventFields,
  readSiteEventFieldValues,
  readSiteEventTypeDetail,
  readSiteEventTypes,
} from "@/lib/edge/query-runtime/site-events";

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
      fields: [],
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
      breakdowns: { pages: [], countries: [], devices: [], browsers: [] },
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

  it("fails closed before providers for an invalid filter", async () => {
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
    ).rejects.toThrow("invalid-input");
    expect(queryEventTypeAggregate).not.toHaveBeenCalled();
  });

  it("maps each event-type provider failure to the typed internal error", async () => {
    vi.mocked(queryEventTypeAggregate).mockRejectedValueOnce(new Error("down"));
    await expect(readSiteEventTypes({ ...base, limit: 20 })).rejects.toThrow(
      "internal",
    );

    vi.mocked(queryEventFieldsFromD1).mockRejectedValueOnce(new Error("down"));
    await expect(
      readSiteEventFields({ ...base, eventName: "signup", limit: 100 }),
    ).rejects.toThrow("internal");

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
    ).rejects.toThrow("internal");

    vi.mocked(queryEventTypeOverviewFromD1).mockRejectedValueOnce(
      new Error("down"),
    );
    await expect(
      readSiteEventTypeDetail({
        ...base,
        eventName: "signup",
        interval: "day",
      }),
    ).rejects.toThrow("internal");
  });
});
