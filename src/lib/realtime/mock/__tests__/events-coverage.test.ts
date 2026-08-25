import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  generateDemoEventRecordDetail,
  generateDemoEventsRecords,
  generateDemoEventsSummary,
  generateDemoEventsTrend,
  generateDemoEventTypeDetail,
  generateDemoEventTypeFieldValues,
} from "@/lib/realtime/mock/events";
import type * as FactBuilder from "@/lib/realtime/mock/fact-builder";
import type {
  DemoFactDataset,
  DemoFilteredFacts,
  DemoVisitFact,
} from "@/lib/realtime/mock/types";

const { mockApplyDemoFilters, mockBuildDemoFactDataset } = vi.hoisted(() => ({
  mockApplyDemoFilters: vi.fn(),
  mockBuildDemoFactDataset: vi.fn(),
}));

vi.mock("@/lib/realtime/mock/fact-builder", async () => {
  const actual = await vi.importActual<typeof FactBuilder>(
    "@/lib/realtime/mock/fact-builder",
  );
  return {
    ...actual,
    buildDemoFactDataset: mockBuildDemoFactDataset,
    applyDemoFilters: mockApplyDemoFilters,
  };
});

describe("mock/events coverage", () => {
  beforeEach(() => {
    mockBuildDemoFactDataset.mockReset();
    mockApplyDemoFilters.mockReset();
  });

  it("summarizes custom events with weighted session and visitor counts", () => {
    const visits = [
      makeVisit({ visitId: "signup", eventType: "signup", sessionId: "s1" }),
      makeVisit({
        visitId: "purchase",
        eventType: "purchase",
        sessionId: "s2",
        visitorId: "u2",
      }),
      makeVisit({ visitId: "page", eventType: "pageview" }),
    ];
    const dataset = makeDataset(visits);
    dataset.sessions.get("s1")!.weight = 2;
    dataset.sessions.get("s2")!.weight = 3;
    dataset.visitors.get("u1")!.weight = 4;
    dataset.visitors.get("u2")!.weight = 5;
    mockBuildDemoFactDataset.mockReturnValue(dataset);
    mockApplyDemoFilters.mockReturnValue(makeFiltered(visits));

    const result = generateDemoEventsSummary("site", { from: 0, to: 10_000 });

    expect(result).toMatchObject({
      ok: true,
      summary: {
        events: 2,
        eventTypes: 2,
        sessions: 5,
        visitors: 9,
        avgEventsPerSession: 0.4,
      },
    });
    expect(result.cards).toMatchObject({
      event: {
        name: [
          { label: "purchase", views: 1, sessions: 3, visitors: 5 },
          { label: "signup", views: 1, sessions: 2, visitors: 4 },
        ],
      },
      page: {
        path: [{ label: "/home", views: 2, sessions: 5, visitors: 9 }],
      },
    });
  });

  it("builds event trend series with an Other bucket and bucketed points", () => {
    const visits = [
      makeVisit({
        visitId: "a1",
        eventType: "alpha",
        startedAt: 1_000,
        sessionId: "s1",
      }),
      makeVisit({
        visitId: "a2",
        eventType: "alpha",
        startedAt: 3_600_000 + 1_000,
        sessionId: "s2",
        visitorId: "u2",
      }),
      makeVisit({
        visitId: "b1",
        eventType: "beta",
        startedAt: 3_600_000 + 2_000,
        sessionId: "s3",
        visitorId: "u3",
      }),
    ];
    const dataset = makeDataset(visits);
    mockBuildDemoFactDataset.mockReturnValue(dataset);
    mockApplyDemoFilters.mockReturnValue(makeFiltered(visits));

    const result = generateDemoEventsTrend("site", {
      from: 0,
      to: 2 * 3_600_000,
      interval: "hour",
      limit: 1,
      timeZone: "UTC",
    }) as any;

    expect(result.ok).toBe(true);
    expect(result.interval).toBe("hour");
    expect(result.series).toEqual([
      expect.objectContaining({
        key: "alpha",
        eventName: "alpha",
        events: 2,
      }),
      expect.objectContaining({
        key: "other",
        eventName: "Other",
        events: 1,
        isOther: true,
      }),
    ]);
    expect(result.data.map((point: any) => point.totalEvents)).toEqual([
      1, 2, 0,
    ]);
    expect(result.data[0].eventsBySeries).toMatchObject({ alpha: 1, other: 0 });
    expect(result.data[1].eventsBySeries).toMatchObject({ alpha: 1, other: 1 });
  });

  it("returns empty trend series and zeroed buckets when no events match", () => {
    const visits = [
      makeVisit({
        visitId: "page",
        eventType: "pageview",
        startedAt: 1_000,
      }),
      makeVisit({
        visitId: "signup",
        eventType: "signup",
        startedAt: 2_000,
      }),
    ];
    const dataset = makeDataset(visits);
    mockBuildDemoFactDataset.mockReturnValue(dataset);
    mockApplyDemoFilters.mockReturnValue(makeFiltered(visits));

    const result = generateDemoEventsTrend("site", {
      from: 0,
      to: 2 * 3_600_000,
      interval: "hour",
      eventName: "purchase",
      timeZone: "UTC",
    }) as any;

    expect(result.ok).toBe(true);
    expect(result.series).toEqual([]);
    expect(result.data).toEqual([
      { bucket: 0, timestampMs: 0, totalEvents: 0, eventsBySeries: {} },
      {
        bucket: 1,
        timestampMs: 3_600_000,
        totalEvents: 0,
        eventsBySeries: {},
      },
      {
        bucket: 2,
        timestampMs: 2 * 3_600_000,
        totalEvents: 0,
        eventsBySeries: {},
      },
    ]);
  });

  it("filters, searches, sorts, and paginates event records", () => {
    const visits = [
      makeVisit({
        visitId: "older",
        eventType: "signup",
        startedAt: 1_000,
        pathname: "/signup",
      }),
      makeVisit({
        visitId: "newer",
        eventType: "signup",
        startedAt: 2_000,
        pathname: "/pricing",
        sessionId: "s2",
      }),
      makeVisit({
        visitId: "other",
        eventType: "purchase",
        startedAt: 3_000,
        pathname: "/checkout",
        sessionId: "s3",
      }),
    ];
    const dataset = makeDataset(visits);
    mockBuildDemoFactDataset.mockReturnValue(dataset);
    mockApplyDemoFilters.mockReturnValue(makeFiltered(visits));

    const result = generateDemoEventsRecords("site", {
      from: 0,
      to: 10_000,
      eventName: "signup",
      search: "pricing",
      sortBy: "pathname",
      sortDir: "asc",
      pageSize: 1,
    }) as any;

    expect(result.meta).toEqual({
      pageSize: 1,
      returned: 1,
      hasMore: false,
      nextCursor: null,
    });
    expect(result.data).toEqual([
      expect.objectContaining({
        eventId: "newer:signup",
        eventName: "signup",
        pathname: "/pricing",
      }),
    ]);
  });

  it("reports and consumes a cursor when event records have another page", () => {
    const visits = [
      makeVisit({ visitId: "first", eventType: "signup", startedAt: 1_000 }),
      makeVisit({
        visitId: "second",
        eventType: "signup",
        startedAt: 2_000,
        sessionId: "s2",
      }),
      makeVisit({
        visitId: "third",
        eventType: "signup",
        startedAt: 3_000,
        sessionId: "s3",
        visitorId: "u3",
      }),
    ];
    const dataset = makeDataset(visits);
    mockBuildDemoFactDataset.mockReturnValue(dataset);
    mockApplyDemoFilters.mockReturnValue(makeFiltered(visits));

    const result = generateDemoEventsRecords("site", {
      from: 0,
      to: 10_000,
      pageSize: 2,
      sortBy: "occurredAt",
      sortDir: "desc",
    }) as any;

    expect(result.meta).toEqual({
      pageSize: 2,
      returned: 2,
      hasMore: true,
      nextCursor: "2",
    });
    expect(result.data.map((row: any) => row.eventId)).toEqual([
      "third:signup",
      "second:signup",
    ]);

    const nextPage = generateDemoEventsRecords("site", {
      from: 0,
      to: 10_000,
      cursor: result.meta.nextCursor,
      pageSize: 2,
      sortBy: "occurredAt",
      sortDir: "desc",
    }) as any;

    expect(nextPage.meta).toEqual({
      pageSize: 2,
      returned: 1,
      hasMore: false,
      nextCursor: null,
    });
    expect(nextPage.data.map((row: any) => row.eventId)).toEqual([
      "first:signup",
    ]);
  });

  it("returns no event records when event name and search filters reject matches", () => {
    const visits = [
      makeVisit({
        visitId: "signup",
        eventType: "signup",
        pathname: "/signup",
      }),
      makeVisit({
        visitId: "purchase",
        eventType: "purchase",
        pathname: "/checkout",
        sessionId: "s2",
      }),
    ];
    const dataset = makeDataset(visits);
    mockBuildDemoFactDataset.mockReturnValue(dataset);
    mockApplyDemoFilters.mockReturnValue(makeFiltered(visits));

    expect(
      generateDemoEventsRecords("site", {
        from: 0,
        to: 10_000,
        eventName: "signup",
        search: "checkout",
        cursor: "20",
        pageSize: 20,
      }),
    ).toEqual({
      ok: true,
      data: [],
      meta: {
        pageSize: 20,
        returned: 0,
        hasMore: false,
        nextCursor: null,
      },
    });
  });

  it("returns event type detail with trend, breakdowns, cards, and fields", () => {
    const visits = [
      makeVisit({
        visitId: "signup-1",
        eventType: "signup",
        startedAt: 1_000,
        pathname: "/signup",
      }),
      makeVisit({
        visitId: "signup-2",
        eventType: "signup",
        startedAt: 3_600_000 + 1_000,
        pathname: "/signup",
        sessionId: "s2",
        visitorId: "u2",
      }),
      makeVisit({
        visitId: "purchase-1",
        eventType: "purchase",
        startedAt: 3_600_000 + 2_000,
        pathname: "/checkout",
        sessionId: "s3",
        visitorId: "u3",
      }),
    ];
    const dataset = makeDataset(visits, { viewWeight: 2 });
    dataset.sessions.get("s1")!.weight = 3;
    dataset.sessions.get("s2")!.weight = 4;
    dataset.visitors.get("u1")!.weight = 5;
    dataset.visitors.get("u2")!.weight = 6;
    mockBuildDemoFactDataset.mockReturnValue(dataset);
    mockApplyDemoFilters.mockReturnValue(makeFiltered(visits));

    const result = generateDemoEventTypeDetail("site", {
      from: 0,
      to: 2 * 3_600_000,
      interval: "hour",
      eventName: "signup",
      timeZone: "UTC",
    }) as any;

    expect(result.summary).toMatchObject({
      events: 2,
      eventTypes: 1,
      sessions: 7,
      visitors: 11,
      avgEventsPerSession: 2 / 7,
      shareOfAllEvents: 2 / 3,
    });
    expect(result.trend.data.map((point: any) => point.events)).toEqual([
      2, 2, 0,
    ]);
    expect(result.breakdowns.pages).toEqual([
      { label: "/signup", views: 2, sessions: 7, visitors: 11 },
    ]);
    expect(result.cards).toMatchObject({
      page: {
        path: [{ label: "/signup", views: 2, sessions: 7, visitors: 11 }],
      },
    });
    expect(result.fields).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: "/plan", valueType: "string" }),
      ]),
    );
  });

  it("returns empty event type detail fallbacks for a missing event name", () => {
    const visits = [
      makeVisit({
        visitId: "signup",
        eventType: "signup",
        startedAt: 1_000,
      }),
    ];
    const dataset = makeDataset(visits);
    mockBuildDemoFactDataset.mockReturnValue(dataset);
    mockApplyDemoFilters.mockReturnValue(makeFiltered(visits));

    const result = generateDemoEventTypeDetail("site", {
      from: 0,
      to: 3_600_000,
      interval: "hour",
      timeZone: "UTC",
    }) as any;

    expect(result.eventName).toBe("");
    expect(result.summary).toMatchObject({
      events: 0,
      eventTypes: 0,
      sessions: 0,
      visitors: 0,
      avgEventsPerSession: 0,
      shareOfAllEvents: 0,
    });
    expect(result.trend.data).toEqual([
      { bucket: 0, timestampMs: 0, events: 0, visitors: 0 },
      { bucket: 1, timestampMs: 3_600_000, events: 0, visitors: 0 },
    ]);
    expect(result.breakdowns).toEqual({
      pages: [],
      countries: [],
      devices: [],
      browsers: [],
    });
    expect(result.cards.page.path).toEqual([]);
    expect(result.cards.source.domain).toEqual([]);
    expect(result.cards.client.browser).toEqual([]);
    expect(result.cards.geo.country).toEqual([]);
    expect(result.fields).toEqual([]);
  });

  it("returns field values only when required field params are present", () => {
    const visits = [
      makeVisit({ visitId: "one", eventType: "signup" }),
      makeVisit({ visitId: "two", eventType: "signup", sessionId: "s2" }),
    ];
    const dataset = makeDataset(visits);
    mockBuildDemoFactDataset.mockReturnValue(dataset);
    mockApplyDemoFilters.mockReturnValue(makeFiltered(visits));

    expect(
      generateDemoEventTypeFieldValues("site", {
        eventName: "",
        fieldPath: "/plan",
        fieldValueType: "string",
      }),
    ).toEqual({
      ok: true,
      fieldPath: "/plan",
      fieldValueType: "string",
      data: [],
    });

    const result = generateDemoEventTypeFieldValues("site", {
      eventName: "signup",
      fieldPath: "/plan",
      fieldValueType: "string",
      limit: 5,
    }) as any;
    expect(result.ok).toBe(true);
    expect(result.data.length).toBeGreaterThan(0);
    expect(result.data[0]).toEqual(
      expect.objectContaining({
        value: expect.any(String),
        events: expect.any(Number),
      }),
    );
  });

  it("short-circuits field values for each missing required field param", () => {
    mockBuildDemoFactDataset.mockReturnValue(
      makeDataset([makeVisit({ visitId: "one", eventType: "signup" })]),
    );

    expect(
      generateDemoEventTypeFieldValues("site", {
        eventName: "signup",
        fieldPath: "",
        fieldValueType: "string",
      }),
    ).toEqual({
      ok: true,
      fieldPath: "",
      fieldValueType: "string",
      data: [],
    });
    expect(
      generateDemoEventTypeFieldValues("site", {
        eventName: "signup",
        fieldPath: "/plan",
        fieldValueType: "",
      }),
    ).toEqual({
      ok: true,
      fieldPath: "/plan",
      fieldValueType: "",
      data: [],
    });
    expect(mockApplyDemoFilters).not.toHaveBeenCalled();
  });

  it("returns empty field values when the requested type has no scalar matches", () => {
    const visits = [
      makeVisit({ visitId: "one", eventType: "signup" }),
      makeVisit({ visitId: "two", eventType: "signup", sessionId: "s2" }),
    ];
    const dataset = makeDataset(visits);
    mockBuildDemoFactDataset.mockReturnValue(dataset);
    mockApplyDemoFilters.mockReturnValue(makeFiltered(visits));

    expect(
      generateDemoEventTypeFieldValues("site", {
        eventName: "signup",
        fieldPath: "/plan",
        fieldValueType: "number",
      }),
    ).toEqual({
      ok: true,
      fieldPath: "/plan",
      fieldValueType: "number",
      data: [],
    });
  });

  it("returns a requested record detail and falls back to the first event", () => {
    const visits = [
      makeVisit({ visitId: "first", eventType: "signup", startedAt: 1_000 }),
      makeVisit({
        visitId: "second",
        eventType: "purchase",
        startedAt: 2_000,
        sessionId: "s2",
      }),
    ];
    const dataset = makeDataset(visits);
    mockBuildDemoFactDataset.mockReturnValue(dataset);

    expect(
      generateDemoEventRecordDetail("site", {
        from: 0,
        to: 10_000,
        eventId: "first:signup",
      }),
    ).toMatchObject({
      ok: true,
      data: {
        event: { eventId: "first:signup", eventName: "signup" },
        context: { visitId: "first", sessionId: "s1" },
        eventData: { page: { path: "/home" } },
      },
    });

    expect(
      generateDemoEventRecordDetail("site", {
        from: 0,
        to: 10_000,
        eventId: "missing",
      }),
    ).toMatchObject({
      ok: true,
      data: {
        event: { eventId: "second:purchase", eventName: "purchase" },
      },
    });
  });

  it("returns null record detail when the dataset has no custom events", () => {
    mockBuildDemoFactDataset.mockReturnValue(
      makeDataset([makeVisit({ eventType: "pageview" })]),
    );

    expect(generateDemoEventRecordDetail("site", { from: 0, to: 1 })).toEqual({
      ok: true,
      data: null,
    });
  });

  it("maps event records with region fallback and operating system labels", () => {
    const visits = [
      makeVisit({
        visitId: "linux-event",
        eventType: "download",
        regionName: "",
        region: "DE::BE::Berlin",
        osVersion: "Ubuntu 24.04",
      }),
    ];
    const dataset = makeDataset(visits);
    mockBuildDemoFactDataset.mockReturnValue(dataset);
    mockApplyDemoFilters.mockReturnValue(makeFiltered(visits));

    const result = generateDemoEventsRecords("site", {
      from: 0,
      to: 10_000,
    }) as any;

    expect(result.data).toEqual([
      expect.objectContaining({
        eventId: "linux-event:download",
        region: "DE::BE::Berlin",
        os: "Ubuntu",
        osVersion: "Ubuntu 24.04",
        nodeCount: 18,
        valueCount: 13,
      }),
    ]);
  });
});

function makeDataset(
  visits: DemoVisitFact[],
  options: { viewWeight?: number } = {},
): DemoFactDataset {
  const dataset: DemoFactDataset = {
    from: 0,
    to: 1,
    viewWeight: options.viewWeight ?? 1,
    visits,
    sessions: new Map(),
    visitors: new Map(),
  };
  for (const visit of visits) {
    dataset.sessions.set(visit.sessionId, {
      sessionId: visit.sessionId,
      visitorId: visit.visitorId,
      entryPath: visit.pathname,
      exitPath: visit.pathname,
      weight: 1,
    });
    dataset.visitors.set(visit.visitorId, {
      visitorId: visit.visitorId,
      weight: 1,
    });
  }
  return dataset;
}

function makeFiltered(visits: DemoVisitFact[]): DemoFilteredFacts {
  const sessions = new Set(visits.map((visit) => visit.sessionId));
  const visitors = new Set(visits.map((visit) => visit.visitorId));
  const visitsBySession = new Map<string, number>();
  for (const visit of visits) {
    visitsBySession.set(
      visit.sessionId,
      (visitsBySession.get(visit.sessionId) ?? 0) + 1,
    );
  }
  return { visits, sessions, visitors, visitsBySession };
}

function makeVisit(overrides: Partial<DemoVisitFact> = {}): DemoVisitFact {
  return {
    visitId: "v1",
    sessionId: "s1",
    visitorId: "u1",
    startedAt: 0,
    pathname: "/home",
    title: "Home",
    hostname: "example.test",
    referrerHost: "",
    referrerUrl: "",
    browser: "Chrome",
    browserVersion: "138",
    osVersion: "Windows 11",
    deviceType: "Desktop",
    language: "en-US",
    screenSize: "1920x1080",
    country: "US",
    regionCode: "CA",
    regionName: "California",
    region: "US::CA::California",
    cityName: "San Francisco",
    city: "US::CA::California::San Francisco",
    continent: "North America",
    timezone: "UTC",
    organization: "Example ISP",
    latitude: 0,
    longitude: 0,
    eventType: "signup",
    durationMs: 1000,
    ...overrides,
  };
}
