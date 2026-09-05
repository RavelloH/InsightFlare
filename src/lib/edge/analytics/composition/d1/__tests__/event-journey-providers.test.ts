import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/edge/analytics/providers/d1/internal/core", () => ({
  mapEventAnalyticsContextCards: vi.fn((value) => value),
  mapEventField: vi.fn((value) => value),
  mapEventFieldValue: vi.fn((value) => value),
  mapEventRecord: vi.fn((value) => value),
  mapEventSummaryCards: vi.fn((value) => value),
  mapTabs: vi.fn((value) => value),
  mapVisitors: vi.fn((value) => value),
}));
vi.mock("@/lib/edge/analytics/providers/d1/internal/events-context", () => ({
  EVENT_CONTEXT_CARD_KEYS: ["path", "sourceDomain"],
  queryEventAnalyticsContextCardsFromD1: vi.fn(),
}));
vi.mock("@/lib/edge/analytics/providers/d1/internal/events-fields", () => ({
  decodeEventFieldCursor: vi.fn(),
  decodeEventFieldValueCursor: vi.fn(),
  queryEventFieldsFromD1: vi.fn(),
  queryEventFieldsPageFromD1: vi.fn(),
  queryEventFieldValuesPageFromD1: vi.fn(),
}));
vi.mock("@/lib/edge/analytics/providers/d1/internal/events-overview", () => ({
  queryEventTypeOverviewFromD1: vi.fn(),
}));
vi.mock("@/lib/edge/analytics/providers/d1/internal/events-records", () => ({
  queryEventRecordDetailFromD1: vi.fn(),
  queryEventRecordPageFromD1: vi.fn(),
  serializeEventRecordCursor: vi.fn(),
}));
vi.mock("@/lib/edge/analytics/providers/d1/internal/events-summary", () => ({
  decodeEventTypeCursor: vi.fn(),
  queryEventsSummaryFromD1: vi.fn(),
  queryEventTypePageFromD1: vi.fn(),
}));
vi.mock("@/lib/edge/analytics/providers/d1/internal/events-trend", () => ({
  queryEventsTrendFromD1: vi.fn(),
  queryEventTypeTrendFromD1: vi.fn(),
}));
vi.mock(
  "@/lib/edge/analytics/providers/d1/internal/journey-list-queries",
  () => ({
    querySessionListPageFromD1: vi.fn(),
    querySessionsFromD1: vi.fn(),
    queryVisitorListPageFromD1: vi.fn(),
    queryVisitorsFromD1: vi.fn(),
    serializeSessionListCursor: vi.fn(),
    serializeVisitorListCursor: vi.fn(),
  }),
);
vi.mock("@/lib/edge/analytics/providers/d1/internal/journeys", () => ({
  queryJourneyEventDetailFromD1: vi.fn(),
  querySessionDetailFromD1: vi.fn(),
  queryVisitorDetailFromD1: vi.fn(),
  stripSessionDetailCollections: vi.fn((value) => value),
  stripVisitorDetailCollections: vi.fn((value) => value),
}));
vi.mock("@/lib/edge/analytics/providers/d1/operations/site-journeys", () => ({
  readSiteSessionEvents: vi.fn(),
  readSiteVisitorEvents: vi.fn(),
  readSiteVisitorSessions: vi.fn(),
}));

import { AnalyticsProviderRegistry } from "@/lib/edge/analytics/application/provider-registry";
import { registerEventProviders } from "@/lib/edge/analytics/composition/d1/events";
import { registerJourneyProviders } from "@/lib/edge/analytics/composition/d1/journeys";
import type { D1SiteQueryRuntimeOptions } from "@/lib/edge/analytics/composition/d1/shared";
import {
  createQueryTime,
  EMPTY_FILTER_DOCUMENT,
  siteQueryContext,
} from "@/lib/edge/analytics/contract";
import { queryEventAnalyticsContextCardsFromD1 } from "@/lib/edge/analytics/providers/d1/internal/events-context";
import {
  decodeEventFieldCursor,
  decodeEventFieldValueCursor,
  queryEventFieldsFromD1,
  queryEventFieldsPageFromD1,
  queryEventFieldValuesPageFromD1,
} from "@/lib/edge/analytics/providers/d1/internal/events-fields";
import { queryEventTypeOverviewFromD1 } from "@/lib/edge/analytics/providers/d1/internal/events-overview";
import {
  queryEventRecordDetailFromD1,
  queryEventRecordPageFromD1,
  serializeEventRecordCursor,
} from "@/lib/edge/analytics/providers/d1/internal/events-records";
import {
  decodeEventTypeCursor,
  queryEventsSummaryFromD1,
  queryEventTypePageFromD1,
} from "@/lib/edge/analytics/providers/d1/internal/events-summary";
import {
  queryEventsTrendFromD1,
  queryEventTypeTrendFromD1,
} from "@/lib/edge/analytics/providers/d1/internal/events-trend";
import {
  querySessionListPageFromD1,
  querySessionsFromD1,
  queryVisitorListPageFromD1,
  queryVisitorsFromD1,
  serializeSessionListCursor,
  serializeVisitorListCursor,
} from "@/lib/edge/analytics/providers/d1/internal/journey-list-queries";
import {
  queryJourneyEventDetailFromD1,
  querySessionDetailFromD1,
  queryVisitorDetailFromD1,
} from "@/lib/edge/analytics/providers/d1/internal/journeys";
import {
  readSiteSessionEvents,
  readSiteVisitorEvents,
  readSiteVisitorSessions,
} from "@/lib/edge/analytics/providers/d1/operations/site-journeys";
import type { Env } from "@/lib/edge/types";

const env = {} as Env;
const siteId = "provider-test";
const time = createQueryTime(0, 100, "UTC", 100);
const context = siteQueryContext(siteId, "public-share");

const pagination = {
  limit: 1,
  returned: 1,
  hasMore: true,
  nextCursor: "next",
};

function input(fields: Record<string, unknown> = {}) {
  return {
    context,
    time,
    filters: EMPTY_FILTER_DOCUMENT,
    ...fields,
  } as never;
}

function registry(
  register: (
    value: AnalyticsProviderRegistry,
    options: D1SiteQueryRuntimeOptions,
  ) => void,
) {
  const value = new AnalyticsProviderRegistry();
  register(value, { env, siteId });
  return value;
}

describe("D1 event provider routing", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(decodeEventTypeCursor).mockResolvedValue(null);
    vi.mocked(decodeEventFieldCursor).mockResolvedValue(null);
    vi.mocked(decodeEventFieldValueCursor).mockResolvedValue(null);
    vi.mocked(queryEventTypePageFromD1).mockResolvedValue({
      items: [{ value: "signup", views: 3, sessions: 2, visitors: 1 }],
      pagination,
    });
    vi.mocked(queryEventsSummaryFromD1).mockResolvedValue({
      summary: { events: 3, eventTypes: 1, sessions: 2, visitors: 1 },
      cards: {
        event: { name: [] },
        page: { path: [], title: [], hostname: [] },
      },
    });
    vi.mocked(queryEventsTrendFromD1).mockResolvedValue({
      series: [],
      data: [],
    });
    vi.mocked(queryEventRecordPageFromD1).mockResolvedValue({
      rows: [{ id: "record-1" }],
      nextCursor: { id: "record-2" },
    } as never);
    vi.mocked(serializeEventRecordCursor).mockReturnValue("record-next");
    vi.mocked(queryEventFieldValuesPageFromD1).mockResolvedValue({
      items: [{ value: "Chrome", occurrences: 3 }],
      pagination,
    } as never);
    vi.mocked(queryEventFieldsPageFromD1).mockResolvedValue({
      items: [{ path: "plan", valueType: "string" }],
      pagination,
    } as never);
    vi.mocked(queryEventFieldsFromD1).mockResolvedValue([]);
    vi.mocked(queryEventAnalyticsContextCardsFromD1).mockResolvedValue({
      page: {
        path: [],
        query: [],
        title: [],
        hostname: [],
        entry: [],
        exit: [],
      },
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
    });
    vi.mocked(queryEventTypeOverviewFromD1).mockResolvedValue({
      summary: {},
      breakdowns: { pages: [], countries: [], devices: [], browsers: [] },
    } as never);
    vi.mocked(queryEventTypeTrendFromD1).mockResolvedValue({ data: [] });
    vi.mocked(queryEventRecordDetailFromD1).mockResolvedValue({
      id: "record-1",
    } as never);
  });

  it("routes event collections and optional event detail work", async () => {
    const value = registry(registerEventProviders);

    await value.resolve("event-types")!.execute(input({ limit: 1 }));
    vi.mocked(decodeEventTypeCursor).mockResolvedValue({
      views: 3,
      sessions: 2,
      value: "signup",
    });
    await value
      .resolve("event-types")!
      .execute(input({ cursor: "valid", search: "sign" }));

    await value.resolve("event-summary")!.execute(input());
    await value
      .resolve("event-trend")!
      .execute(input({ interval: "day", limit: 2, eventName: "signup" }));
    await value.resolve("event-records")!.execute(
      input({
        pageSize: 1,
        sort: "occurredAt",
        search: "one",
        eventName: "signup",
        cursor: { id: "record-1" },
      }),
    );

    await value.resolve("event-field-values")!.execute(
      input({
        eventName: "signup",
        fieldPath: "plan",
        fieldValueType: "string",
        limit: 1,
        search: "pro",
      }),
    );
    vi.mocked(decodeEventFieldValueCursor).mockResolvedValue({
      occurrences: 3,
      events: 2,
      stringValue: "pro",
      numberValue: 0,
      booleanValue: 0,
    });
    await value.resolve("event-field-values")!.execute(
      input({
        eventName: "signup",
        fieldPath: "plan",
        fieldValueType: "string",
        cursor: "valid",
      }),
    );

    await value
      .resolve("event-fields")!
      .execute(input({ eventName: "signup", limit: 1 }));
    vi.mocked(decodeEventFieldCursor).mockResolvedValue({
      events: 2,
      occurrences: 3,
      path: "plan",
      valueType: "string",
    });
    await value
      .resolve("event-fields")!
      .execute(input({ eventName: "signup", cursor: "valid" }));

    await value
      .resolve("event-context")!
      .execute(
        input({ eventName: "signup", selectedKeys: ["path", "invalid", 1] }),
      );
    await value
      .resolve("event-context")!
      .execute(input({ eventName: "signup", selectedKeys: [] }));

    await value
      .resolve("event-type-detail")!
      .execute(input({ eventName: "signup" }));
    await value.resolve("event-type-detail")!.execute(
      input({
        eventName: "signup",
        includeContext: false,
        includeBreakdowns: false,
        includeFields: false,
      }),
    );
    await value
      .resolve("event-record-detail")!
      .execute(input({ eventId: "record-1" }));

    vi.mocked(queryEventsSummaryFromD1).mockResolvedValueOnce({
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
    await value.resolve("event-types")!.execute(input({ filters: undefined }));
    await value
      .resolve("event-summary")!
      .execute(input({ filters: undefined }));
    await value.resolve("event-trend")!.execute(input({ filters: undefined }));
    await value
      .resolve("event-records")!
      .execute(input({ filters: undefined }));
    await value.resolve("event-field-values")!.execute(
      input({
        filters: undefined,
        fieldPath: "plan",
        fieldValueType: "string",
      }),
    );
    await value.resolve("event-fields")!.execute(input({ filters: undefined }));
    await value
      .resolve("event-context")!
      .execute(input({ filters: undefined }));
    await value.resolve("event-type-detail")!.execute(
      input({
        filters: undefined,
        includeContext: false,
        includeBreakdowns: false,
        includeFields: false,
      }),
    );
    await value
      .resolve("event-type-detail")!
      .execute(input({ filters: null, eventName: "signup" }));

    expect(queryEventTypePageFromD1).toHaveBeenCalled();
    expect(queryEventRecordPageFromD1).toHaveBeenCalled();
    expect(queryEventFieldValuesPageFromD1).toHaveBeenCalled();
    expect(queryEventFieldsPageFromD1).toHaveBeenCalled();
    expect(queryEventAnalyticsContextCardsFromD1).toHaveBeenCalled();
    expect(queryEventTypeOverviewFromD1).toHaveBeenCalled();
  });

  it("rejects an invalid cursor for every event page provider", async () => {
    const value = registry(registerEventProviders);
    await expect(
      value.resolve("event-types")!.execute(input({ cursor: "bad" })),
    ).rejects.toThrow("invalid-cursor");
    await expect(
      value
        .resolve("event-field-values")!
        .execute(
          input({ fieldPath: "plan", fieldValueType: "string", cursor: "bad" }),
        ),
    ).rejects.toThrow("invalid-cursor");
    await expect(
      value.resolve("event-fields")!.execute(input({ cursor: "bad" })),
    ).rejects.toThrow("invalid-cursor");
  });
});

describe("D1 journey provider routing", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(queryVisitorListPageFromD1).mockResolvedValue({
      rows: [{ id: "visitor-page" }],
      nextCursor: { id: "visitor-next" },
    } as never);
    vi.mocked(querySessionListPageFromD1).mockResolvedValue({
      rows: [{ id: "session-page" }],
      nextCursor: { id: "session-next" },
    } as never);
    vi.mocked(queryVisitorsFromD1).mockResolvedValue([
      { id: "visitor-legacy" },
    ] as never);
    vi.mocked(querySessionsFromD1).mockResolvedValue([
      { id: "session-legacy" },
    ] as never);
    vi.mocked(serializeVisitorListCursor).mockReturnValue("visitor-cursor");
    vi.mocked(serializeSessionListCursor).mockReturnValue("session-cursor");
    vi.mocked(readSiteVisitorEvents).mockResolvedValue({
      items: [],
      pagination,
    });
    vi.mocked(readSiteVisitorSessions).mockResolvedValue({
      items: [],
      pagination,
    });
    vi.mocked(readSiteSessionEvents).mockResolvedValue({
      items: [],
      pagination,
    });
    vi.mocked(queryJourneyEventDetailFromD1).mockResolvedValue({
      id: "journey-event",
    } as never);
    vi.mocked(queryVisitorDetailFromD1).mockResolvedValue({
      id: "visitor-detail",
    } as never);
    vi.mocked(querySessionDetailFromD1).mockResolvedValue({
      id: "session-detail",
    } as never);
  });

  it("supports paged and legacy visitor/session paths plus lazy detail paths", async () => {
    const value = registry(registerJourneyProviders);

    await value.resolve("visitors")!.execute(
      input({
        paged: true,
        pageSize: 1,
        sort: "visits",
        search: "visitor",
        cursor: { id: "visitor" },
      }),
    );
    await value
      .resolve("visitors")!
      .execute(input({ pageSize: 1, sort: "visits", search: "visitor" }));
    await value.resolve("sessions")!.execute(
      input({
        paged: true,
        pageSize: 1,
        sort: "startedAt",
        search: "session",
        cursor: { id: "session" },
      }),
    );
    await value
      .resolve("sessions")!
      .execute(input({ pageSize: 1, sort: "startedAt", search: "session" }));

    for (const operation of [
      "visitor-events",
      "visitor-sessions",
      "session-events",
    ] as const) {
      await value.resolve(operation)!.execute(
        input({
          visitorId: "visitor-1",
          sessionId: "session-1",
          page: { limit: 2, cursor: "cursor" },
        }),
      );
      await value.resolve(operation)!.execute(
        input({
          visitorId: "visitor-1",
          sessionId: "session-1",
          page: { limit: Number.NaN, cursor: 12 },
        }),
      );
      await value.resolve(operation)!.execute(
        input({
          visitorId: "visitor-1",
          sessionId: "session-1",
        }),
      );
    }

    await value
      .resolve("journey-event-detail")!
      .execute(input({ eventId: "event-1", eventKind: "custom_event" }));
    await value
      .resolve("visitor-detail")!
      .execute(input({ visitorId: "visitor-1", timeZone: "Asia/Shanghai" }));
    await value
      .resolve("session-detail")!
      .execute(input({ sessionId: "session-1" }));

    await value.resolve("visitors")!.execute(input({ filters: undefined }));
    await value.resolve("sessions")!.execute(input({ filters: undefined }));
    await value
      .resolve("visitor-events")!
      .execute(input({ filters: undefined, visitorId: "visitor-1" }));
    await value
      .resolve("visitor-sessions")!
      .execute(input({ filters: undefined, visitorId: "visitor-1" }));
    await value
      .resolve("session-events")!
      .execute(input({ filters: undefined, sessionId: "session-1" }));
    await value
      .resolve("journey-event-detail")!
      .execute(input({ filters: undefined, eventId: "event-1" }));
    await value
      .resolve("visitor-detail")!
      .execute(input({ filters: undefined, visitorId: "visitor-1" }));

    expect(queryVisitorListPageFromD1).toHaveBeenCalled();
    expect(queryVisitorsFromD1).toHaveBeenCalled();
    expect(querySessionListPageFromD1).toHaveBeenCalled();
    expect(querySessionsFromD1).toHaveBeenCalled();
    expect(readSiteVisitorEvents).toHaveBeenCalled();
    expect(readSiteVisitorSessions).toHaveBeenCalled();
    expect(readSiteSessionEvents).toHaveBeenCalled();
  });

  it("maps missing detail results to null", async () => {
    vi.mocked(queryVisitorDetailFromD1).mockResolvedValue(null);
    vi.mocked(querySessionDetailFromD1).mockResolvedValue(null);
    const value = registry(registerJourneyProviders);
    await expect(
      value.resolve("visitor-detail")!.execute(input({ visitorId: "missing" })),
    ).resolves.toEqual({ value: null });
    await expect(
      value.resolve("session-detail")!.execute(input({ sessionId: "missing" })),
    ).resolves.toEqual({ value: null });
  });
});
