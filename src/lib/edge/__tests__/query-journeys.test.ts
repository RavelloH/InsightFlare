import { describe, expect, it } from "vitest";

import type { JourneyEventRow, SessionRow } from "@/lib/edge/query/core";
import {
  averageGapMs,
  buildJourneySearchSql,
  detailTargetColumn,
  directionSql,
  emptyJourneyPerformanceSummary,
  mapGeoPointRow,
  mapJourneyEventRow,
  mapSessionRow,
  mapVisitorRow,
  nullableCoordinate,
  nullableNumber,
  percentile,
  reportingDateKey,
  sessionDurationMs,
  sessionLeaveEvent,
  sessionListOrderBy,
  sessionStartEvent,
  summarizeActivity,
  summarizeEventDistribution,
  summarizeJourneyPerformance,
  summarizeVisitedPages,
  visitorListOrderBy,
  whereClauseWithTarget,
} from "@/lib/edge/query/journeys";

function performance(
  values: Partial<JourneyEventRow["performance"]> = {},
): JourneyEventRow["performance"] {
  return {
    ttfb: null,
    fcp: null,
    lcp: null,
    cls: null,
    inp: null,
    ...values,
  };
}

function session(overrides: Partial<SessionRow> = {}): SessionRow {
  return {
    sessionId: "session-1",
    visitorId: "visitor-1",
    startedAt: 1_700_000_000_000,
    endedAt: 1_700_000_060_000,
    durationMs: 60_000,
    active: false,
    views: 2,
    events: 1,
    bounce: false,
    entryPath: "/entry",
    exitPath: "/exit",
    referrerHost: "ref.example",
    referrerUrl: "https://ref.example/start",
    country: "US",
    region: "CA",
    regionCode: "CA",
    city: "San Francisco",
    latitude: 37.7749,
    longitude: -122.4194,
    browser: "Chrome",
    browserVersion: "120",
    os: "macOS",
    osVersion: "14",
    deviceType: "desktop",
    screenWidth: 1440,
    screenHeight: 900,
    performance: performance(),
    ...overrides,
  };
}

function event(overrides: Partial<JourneyEventRow> = {}): JourneyEventRow {
  return {
    id: "event-1",
    kind: "pageview",
    eventType: "pageview",
    occurredAt: 1_700_000_000_000,
    visitId: "visit-1",
    sessionId: "session-1",
    visitorId: "visitor-1",
    pathname: "/",
    hash: "",
    title: "",
    hostname: "example.com",
    referrerHost: "",
    referrerUrl: "",
    country: "US",
    region: "CA",
    city: "San Francisco",
    browser: "Chrome",
    browserVersion: "120",
    os: "macOS",
    osVersion: "14",
    deviceType: "desktop",
    screenWidth: 1440,
    screenHeight: 900,
    durationMs: 0,
    performance: performance(),
    ...overrides,
  };
}

describe("journey helper mappers", () => {
  it("maps visitor and geo rows with sanitized nullable values", () => {
    expect(
      mapVisitorRow({
        visitorId: 42,
        sessionId: "session-9",
        firstSeenAt: "100",
        lastSeenAt: "250",
        views: "3",
        sessions: "2",
        events: "5",
        country: "US",
        regionCode: "CA",
        screenWidth: "0",
        screenHeight: "720",
      }),
    ).toMatchObject({
      visitorId: "42",
      sessionId: "session-9",
      firstSeenAt: 100,
      lastSeenAt: 250,
      views: 3,
      sessions: 2,
      events: 5,
      country: "US",
      regionCode: "CA",
      screenWidth: null,
      screenHeight: 720,
    });

    expect(
      mapGeoPointRow({
        latitude: "37.7",
        longitude: "-122.4",
        timestampMs: "12345",
        country: "US",
      }),
    ).toEqual({
      latitude: 37.7,
      longitude: -122.4,
      timestampMs: 12345,
      country: "US",
      region: "",
      regionCode: "",
      city: "",
      pointCount: 1,
    });
  });

  it("maps session rows with duration, booleans, nullable dimensions, and performance", () => {
    expect(
      mapSessionRow({
        sessionId: "session-2",
        visitorId: "visitor-2",
        startedAt: "1000",
        endedAt: "2000",
        totalDurationMs: "900",
        active: 1,
        views: "1",
        events: "3",
        entryPath: "/pricing",
        exitPath: "/checkout",
        latitude: "37.7",
        longitude: "-122.4",
        screenWidth: "0",
        screenHeight: "720",
        perfTtfbMs: "125.1234",
        perfLcpMs: "-1",
      }),
    ).toMatchObject({
      sessionId: "session-2",
      visitorId: "visitor-2",
      startedAt: 1000,
      endedAt: 2000,
      durationMs: 900,
      active: true,
      views: 1,
      events: 3,
      bounce: true,
      entryPath: "/pricing",
      exitPath: "/checkout",
      latitude: 37.7,
      longitude: -122.4,
      screenWidth: null,
      screenHeight: 720,
      performance: {
        ttfb: 125.123,
        fcp: null,
        lcp: null,
        cls: null,
        inp: null,
      },
    });
  });

  it("maps journey event rows with kind normalization and sanitized numbers", () => {
    expect(
      mapJourneyEventRow({
        id: 123,
        kind: "unknown",
        eventType: "clicked",
        occurredAt: "3000",
        visitId: "visit-2",
        sessionId: "session-2",
        visitorId: "visitor-2",
        pathname: "/demo",
        screenWidth: "1920",
        screenHeight: "",
        durationMs: "-50",
        perfCls: "0.12345",
      }),
    ).toMatchObject({
      id: "123",
      kind: "pageview",
      eventType: "clicked",
      occurredAt: 3000,
      visitId: "visit-2",
      sessionId: "session-2",
      visitorId: "visitor-2",
      pathname: "/demo",
      screenWidth: 1920,
      screenHeight: null,
      durationMs: 0,
      performance: {
        cls: 0.123,
      },
    });
  });
});

describe("journey SQL helpers", () => {
  it("escapes list searches across all searchable columns", () => {
    const search = buildJourneySearchSql("  Ref%_\\Term  ", "fv");

    expect(search).not.toBeNull();
    expect(search?.condition).toContain("fv.visitor_id");
    expect(search?.condition).toContain("ESCAPE '\\'");
    expect(search?.condition).toContain(
      "CASE WHEN TRIM(COALESCE(fv.referrer_host, '')) = ''",
    );
    expect(search?.bindings).toHaveLength(21);
    expect(new Set(search?.bindings)).toEqual(new Set(["%ref\\%\\_\\\\term%"]));
    expect(buildJourneySearchSql("   ")).toBeNull();
  });

  it("builds unaliased search SQL and escapes direct traffic search terms", () => {
    const search = buildJourneySearchSql(" Direct_100% ");

    expect(search?.condition).toContain("visitor_id");
    expect(search?.condition).not.toContain("fv.visitor_id");
    expect(search?.condition).toContain(
      "CASE WHEN TRIM(COALESCE(referrer_host, '')) = ''",
    );
    expect(search?.bindings).toHaveLength(21);
    expect(new Set(search?.bindings)).toEqual(new Set(["%direct\\_100\\%%"]));
  });

  it("builds target where clauses without losing existing filters", () => {
    expect(
      whereClauseWithTarget("WHERE country = ?", {
        column: "visitor_id",
        value: "v1",
      }),
    ).toBe("WHERE visitor_id = ? AND country = ?");
    expect(
      whereClauseWithTarget("", { column: "session_id", value: "s1" }),
    ).toBe("WHERE session_id = ? ");
    expect(whereClauseWithTarget("WHERE country = ?")).toBe(
      "WHERE country = ?",
    );
  });

  it("maps sort descriptors and detail targets to SQL fragments", () => {
    expect(visitorListOrderBy({ key: "firstSeenAt", direction: "asc" })).toBe(
      "firstSeenAt ASC, lastSeenAt DESC, visitorId ASC",
    );
    expect(visitorListOrderBy({ key: "sessions", direction: "desc" })).toBe(
      "sessions DESC, lastSeenAt DESC, visitorId ASC",
    );
    expect(sessionListOrderBy({ key: "durationMs", direction: "asc" })).toBe(
      "totalDurationMs ASC, startedAt DESC, sessionId ASC",
    );
    expect(sessionListOrderBy({ key: "views", direction: "desc" })).toBe(
      "views DESC, startedAt DESC, sessionId ASC",
    );
    expect(directionSql("asc")).toBe("ASC");
    expect(directionSql("desc")).toBe("DESC");
    expect(detailTargetColumn({ type: "visitor", value: "v1" })).toBe(
      "visitor_id",
    );
    expect(detailTargetColumn({ type: "session", value: "s1" })).toBe(
      "session_id",
    );
  });
});

describe("session timeline helper events", () => {
  it("creates session start events from session metadata", () => {
    expect(sessionStartEvent(session())).toEqual({
      id: "session-start:session-1",
      kind: "session_start",
      eventType: "session start",
      occurredAt: 1_700_000_000_000,
      visitId: "",
      sessionId: "session-1",
      visitorId: "visitor-1",
      pathname: "/entry",
      hash: "",
      title: "",
      hostname: "",
      referrerHost: "ref.example",
      referrerUrl: "https://ref.example/start",
      country: "US",
      region: "CA",
      city: "San Francisco",
      browser: "Chrome",
      browserVersion: "120",
      os: "macOS",
      osVersion: "14",
      deviceType: "desktop",
      screenWidth: 1440,
      screenHeight: 900,
      durationMs: 0,
      performance: performance(),
    });
  });

  it("creates session leave events from the latest page event", () => {
    const page = event({
      id: "older-page",
      visitId: "visit-old",
      occurredAt: 1_700_000_010_000,
      pathname: "/older",
    });
    const latestPage = event({
      id: "latest-page",
      visitId: "visit-new",
      occurredAt: 1_700_000_020_000,
      pathname: "/latest",
      title: "Latest",
    });

    expect(
      sessionLeaveEvent(
        session({ exitPath: " ", endedAt: 1_700_000_030_000 }),
        [
          page,
          latestPage,
          event({ kind: "custom", occurredAt: 1_700_000_040_000 }),
        ],
      ),
    ).toMatchObject({
      id: "session-leave:session-1",
      kind: "leave",
      eventType: "leave",
      occurredAt: 1_700_000_030_000,
      visitId: "visit-new",
      pathname: "/latest",
      title: "Latest",
      durationMs: 0,
      performance: performance(),
    });
  });

  it("creates session leave events from session metadata when no page events exist", () => {
    expect(
      sessionLeaveEvent(
        session({
          exitPath: " ",
          entryPath: "/entry-fallback",
          endedAt: 1_700_000_030_000,
        }),
        [event({ kind: "custom", eventType: "signup", pathname: "/signup" })],
      ),
    ).toMatchObject({
      id: "session-leave:session-1",
      kind: "leave",
      occurredAt: 1_700_000_030_000,
      visitId: "",
      pathname: "/entry-fallback",
      referrerHost: "ref.example",
    });
  });

  it("omits leave events for active sessions, invalid end times, and empty paths", () => {
    expect(sessionLeaveEvent(session({ active: true }), [])).toBeNull();
    expect(sessionLeaveEvent(session({ endedAt: 0 }), [])).toBeNull();
    expect(
      sessionLeaveEvent(session({ startedAt: 2000, endedAt: 1000 }), []),
    ).toBeNull();
    expect(
      sessionLeaveEvent(session({ entryPath: " ", exitPath: " " }), []),
    ).toBeNull();
  });
});

describe("journey summaries", () => {
  it("summarizes visited pages with pageview-only counts, defaults, and stable sorting", () => {
    expect(
      summarizeVisitedPages([
        event({ pathname: "/beta" }),
        event({ pathname: "/alpha" }),
        event({ pathname: "/beta" }),
        event({ pathname: " " }),
        event({ kind: "custom", eventType: "signup", pathname: "/beta" }),
      ]),
    ).toEqual([
      { pathname: "/beta", views: 2 },
      { pathname: "/", views: 1 },
      { pathname: "/alpha", views: 1 },
    ]);
  });

  it("limits visited page and event distribution summaries to top fifty rows", () => {
    const events = Array.from({ length: 55 }, (_, index) =>
      event({
        id: `event-${index}`,
        eventType: `event-${String(index).padStart(2, "0")}`,
        pathname: `/page-${String(index).padStart(2, "0")}`,
      }),
    );

    expect(summarizeVisitedPages(events)).toHaveLength(50);
    expect(summarizeVisitedPages(events).at(0)).toEqual({
      pathname: "/page-00",
      views: 1,
    });
    expect(summarizeEventDistribution(events)).toHaveLength(50);
    expect(summarizeEventDistribution(events).at(-1)).toEqual({
      eventType: "event-49",
      count: 1,
    });
  });

  it("summarizes event distribution with fallback labels and stable sorting", () => {
    expect(
      summarizeEventDistribution([
        event({ eventType: "signup" }),
        event({ eventType: "pageview" }),
        event({ eventType: "signup" }),
        event({ kind: "custom", eventType: " " }),
      ]),
    ).toEqual([
      { eventType: "signup", count: 2 },
      { eventType: "custom", count: 1 },
      { eventType: "pageview", count: 1 },
    ]);
  });

  it("returns empty performance buckets when no pageview samples exist", () => {
    expect(emptyJourneyPerformanceSummary()).toEqual({
      ttfb: { avg: null, p75: null, min: null, max: null, samples: 0 },
      fcp: { avg: null, p75: null, min: null, max: null, samples: 0 },
      lcp: { avg: null, p75: null, min: null, max: null, samples: 0 },
      cls: { avg: null, p75: null, min: null, max: null, samples: 0 },
      inp: { avg: null, p75: null, min: null, max: null, samples: 0 },
    });
    expect(
      summarizeJourneyPerformance([
        event({ kind: "custom", eventType: "signup" }),
      ]),
    ).toEqual(emptyJourneyPerformanceSummary());
  });

  it("summarizes unique pageview performance samples", () => {
    expect(
      summarizeJourneyPerformance([
        event({
          visitId: "visit-a",
          performance: performance({ ttfb: 100, lcp: 2500, cls: 0.05 }),
        }),
        event({
          visitId: "visit-b",
          performance: performance({ ttfb: 300, lcp: 3500, inp: 120 }),
        }),
        event({
          visitId: "visit-b",
          performance: performance({ ttfb: 900, lcp: 9000, inp: 400 }),
        }),
      ]),
    ).toMatchObject({
      ttfb: { avg: 200, p75: 300, min: 100, max: 300, samples: 2 },
      lcp: { avg: 3000, p75: 3500, min: 2500, max: 3500, samples: 2 },
      cls: { avg: 0.05, p75: 0.05, min: 0.05, max: 0.05, samples: 1 },
      inp: { avg: 120, p75: 120, min: 120, max: 120, samples: 1 },
    });
  });

  it("summarizes activity by reporting timezone", () => {
    const lateUtc = Date.UTC(2024, 0, 2, 1, 30);
    const nextUtc = Date.UTC(2024, 0, 2, 8, 30);

    expect(reportingDateKey(lateUtc, "America/Los_Angeles")).toBe("2024-01-01");
    expect(
      summarizeActivity(
        [
          event({ occurredAt: lateUtc }),
          event({ occurredAt: nextUtc }),
          event({ occurredAt: 0 }),
          event({ occurredAt: Number.NaN }),
        ],
        "America/Los_Angeles",
      ),
    ).toEqual([
      { date: "2024-01-01", count: 1 },
      { date: "2024-01-02", count: 1 },
    ]);
  });
});

describe("journey numeric helpers", () => {
  it("normalizes nullable numbers, coordinates, and session durations", () => {
    expect(nullableNumber("120")).toBe(120);
    expect(nullableNumber(undefined)).toBeNull();
    expect(nullableNumber("0")).toBeNull();
    expect(nullableNumber("-1")).toBeNull();
    expect(nullableNumber(Number.NaN)).toBeNull();
    expect(nullableCoordinate("0")).toBe(0);
    expect(nullableCoordinate("")).toBeNull();
    expect(nullableCoordinate(Number.POSITIVE_INFINITY)).toBeNull();

    expect(sessionDurationMs(100, 250, 10, false)).toBe(150);
    expect(sessionDurationMs(100, 250, 99.6, true)).toBe(100);
    expect(sessionDurationMs(100, 250, Number.POSITIVE_INFINITY, true)).toBe(
      150,
    );
    expect(sessionDurationMs(250, 100, -10, false)).toBe(0);
  });

  it("computes nearest-rank percentiles over finite non-negative values", () => {
    expect(percentile([10, 30, 20, -1, Number.NaN], 75)).toBe(30);
    expect(percentile([10, 30, 20], 50)).toBe(20);
    expect(percentile([], 90)).toBe(0);
    expect(percentile([-1, Number.NaN], 90)).toBe(0);
  });

  it("computes average gaps from sorted valid timestamps", () => {
    expect(averageGapMs([4000, 1000, 2500, 0, Number.NaN])).toBe(1500);
    expect(averageGapMs([1000])).toBe(0);
  });
});
