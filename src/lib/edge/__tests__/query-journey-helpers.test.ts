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

const baseMs = Date.UTC(2026, 0, 2, 3, 4, 5);

function session(overrides: Partial<SessionRow> = {}): SessionRow {
  return {
    sessionId: "session-1",
    visitorId: "visitor-1",
    startedAt: baseMs,
    endedAt: baseMs + 30_000,
    durationMs: 30_000,
    active: false,
    views: 2,
    events: 1,
    bounce: false,
    entryPath: "/entry",
    exitPath: "/exit",
    referrerHost: "ref.example",
    referrerUrl: "https://ref.example/start",
    country: "US",
    region: "California",
    regionCode: "CA",
    city: "San Francisco",
    latitude: 37.7,
    longitude: -122.4,
    browser: "Chrome",
    browserVersion: "124",
    os: "macOS",
    osVersion: "14",
    deviceType: "desktop",
    screenWidth: 1440,
    screenHeight: 900,
    performance: { ttfb: null, fcp: null, lcp: null, cls: null, inp: null },
    ...overrides,
  };
}

function event(overrides: Partial<JourneyEventRow> = {}): JourneyEventRow {
  return {
    id: "visit-1",
    kind: "pageview",
    eventType: "pageview",
    occurredAt: baseMs + 5_000,
    visitId: "visit-1",
    sessionId: "session-1",
    visitorId: "visitor-1",
    pathname: "/entry",
    hash: "",
    title: "Entry",
    hostname: "example.com",
    referrerHost: "ref.example",
    referrerUrl: "https://ref.example/start",
    country: "US",
    region: "California",
    city: "San Francisco",
    browser: "Chrome",
    browserVersion: "124",
    os: "macOS",
    osVersion: "14",
    deviceType: "desktop",
    screenWidth: 1440,
    screenHeight: 900,
    durationMs: 10_000,
    performance: { ttfb: null, fcp: null, lcp: null, cls: null, inp: null },
    ...overrides,
  };
}

describe("edge journey helper branches", () => {
  it("normalizes nullable numbers, durations, filters, search SQL, and ordering", () => {
    expect(nullableNumber(null)).toBeNull();
    expect(nullableNumber(undefined)).toBeNull();
    expect(nullableNumber("")).toBeNull();
    expect(nullableNumber(0)).toBeNull();
    expect(nullableNumber("12.5")).toBe(12.5);
    expect(nullableNumber(Number.POSITIVE_INFINITY)).toBeNull();

    expect(nullableCoordinate("")).toBeNull();
    expect(nullableCoordinate("0")).toBe(0);
    expect(nullableCoordinate("bad")).toBeNull();

    expect(sessionDurationMs(10, 20, 999, true)).toBe(999);
    expect(sessionDurationMs(10, 20.4, 0, false)).toBe(10);
    expect(sessionDurationMs(20, 10, -5, false)).toBe(0);

    expect(
      whereClauseWithTarget("", { column: "visitor_id", value: "v" }),
    ).toBe("WHERE visitor_id = ? ");
    expect(
      whereClauseWithTarget("WHERE country = ?", {
        column: "session_id",
        value: "s",
      }),
    ).toBe("WHERE session_id = ? AND country = ?");

    expect(buildJourneySearchSql("   ")).toBeNull();
    const search = buildJourneySearchSql("  50%_off\\now  ", "v");
    expect(search?.condition).toContain("v.visitor_id");
    expect(search?.condition).toContain("direct");
    expect(search?.bindings).toHaveLength(21);
    expect(search?.bindings[0]).toBe("%50\\%\\_off\\\\now%");

    expect(directionSql("asc")).toBe("ASC");
    expect(directionSql("desc")).toBe("DESC");
    expect(visitorListOrderBy({ key: "sessions", direction: "asc" })).toBe(
      "sessions ASC, lastSeenAt DESC, visitorId ASC",
    );
    expect(sessionListOrderBy({ key: "durationMs", direction: "desc" })).toBe(
      "totalDurationMs DESC, startedAt DESC, sessionId ASC",
    );
  });

  it("maps sparse visitor, session, geo, and event rows with defaults", () => {
    expect(
      mapVisitorRow({
        visitorId: 123,
        firstSeenAt: "10",
        lastSeenAt: undefined,
        views: "2",
        sessions: null,
        screenWidth: "",
        screenHeight: null,
      }),
    ).toMatchObject({
      visitorId: "123",
      sessionId: "",
      firstSeenAt: 10,
      lastSeenAt: 0,
      views: 2,
      sessions: 0,
      screenWidth: null,
      screenHeight: null,
    });

    expect(
      mapSessionRow({
        sessionId: "session-1",
        visitorId: "visitor-1",
        startedAt: 100,
        endedAt: 80,
        durationMs: "25.8",
        active: "1",
        views: 1,
        latitude: "",
        longitude: "0",
        screenWidth: 0,
        screenHeight: "720",
        perfTtfbMs: "125.1234",
      }),
    ).toMatchObject({
      durationMs: 26,
      active: true,
      bounce: true,
      latitude: null,
      longitude: 0,
      screenWidth: null,
      screenHeight: 720,
      performance: { ttfb: 125.123 },
    });

    expect(mapGeoPointRow({ latitude: "1", longitude: null })).toEqual({
      latitude: 1,
      longitude: 0,
      timestampMs: 0,
      country: "",
      region: "",
      regionCode: "",
      city: "",
      pointCount: 1,
    });

    expect(
      ["custom", "session_start", "leave", "unknown"].map((kind) =>
        mapJourneyEventRow({
          kind,
          durationMs: -100,
          screenWidth: "1024",
          perfCls: "0.01234",
        }),
      ),
    ).toMatchObject([
      { kind: "custom", durationMs: 0, screenWidth: 1024 },
      { kind: "session_start", durationMs: 0, screenWidth: 1024 },
      { kind: "leave", durationMs: 0, screenWidth: 1024 },
      { kind: "pageview", durationMs: 0, screenWidth: 1024 },
    ]);
  });

  it("builds synthetic session events and rejects invalid leave-event branches", () => {
    const current = session();
    expect(sessionStartEvent(current)).toMatchObject({
      id: "session-start:session-1",
      kind: "session_start",
      pathname: "/entry",
      performance: { ttfb: null, fcp: null, lcp: null, cls: null, inp: null },
    });

    expect(sessionLeaveEvent(session({ active: true }), [])).toBeNull();
    expect(sessionLeaveEvent(session({ endedAt: 0 }), [])).toBeNull();
    expect(
      sessionLeaveEvent(session({ startedAt: 10, endedAt: 5 }), []),
    ).toBeNull();
    expect(
      sessionLeaveEvent(session({ entryPath: "", exitPath: "" }), [
        event({ kind: "custom", pathname: "/ignored" }),
      ]),
    ).toBeNull();

    expect(
      sessionLeaveEvent(session({ exitPath: "" }), [
        event({ id: "older", pathname: "/old", occurredAt: baseMs + 1_000 }),
        event({
          id: "custom-late",
          kind: "custom",
          pathname: "/ignored",
          occurredAt: baseMs + 20_000,
        }),
        event({ id: "newer", pathname: "/new", occurredAt: baseMs + 10_000 }),
      ]),
    ).toMatchObject({
      id: "session-leave:session-1",
      kind: "leave",
      pathname: "/new",
      visitId: "visit-1",
    });

    expect(
      sessionLeaveEvent(session({ entryPath: "/fallback", exitPath: "" }), []),
    ).toMatchObject({
      pathname: "/fallback",
      visitId: "",
    });
  });

  it("summarizes journey pages, event labels, performance, activity, and math helpers", () => {
    const events = [
      event({
        pathname: "/b",
        visitId: "v1",
        performance: { ttfb: 100, fcp: 20, lcp: null, cls: 0.01, inp: null },
      }),
      event({
        pathname: "   ",
        visitId: "v2",
        performance: { ttfb: 300, fcp: null, lcp: 1200, cls: 0.03, inp: 80 },
      }),
      event({
        pathname: "/b",
        visitId: "v1",
        performance: { ttfb: 999, fcp: 999, lcp: 999, cls: 999, inp: 999 },
      }),
      event({ kind: "custom", eventType: " signup ", pathname: "/ignored" }),
      event({ kind: "leave", eventType: "", occurredAt: 0 }),
      event({
        kind: "pageview",
        eventType: "pageview",
        occurredAt: Number.NaN,
      }),
    ];

    expect(summarizeVisitedPages(events)).toEqual([
      { pathname: "/b", views: 2 },
      { pathname: "/", views: 1 },
      { pathname: "/entry", views: 1 },
    ]);
    expect(summarizeEventDistribution(events)).toEqual([
      { eventType: "pageview", count: 4 },
      { eventType: "leave", count: 1 },
      { eventType: "signup", count: 1 },
    ]);

    const performance = summarizeJourneyPerformance(events);
    expect(performance.ttfb).toEqual({
      avg: 200,
      p75: 300,
      min: 100,
      max: 300,
      samples: 2,
    });
    expect(performance.lcp).toMatchObject({ avg: 1200, samples: 1 });
    expect(emptyJourneyPerformanceSummary().inp).toEqual({
      avg: null,
      p75: null,
      min: null,
      max: null,
      samples: 0,
    });

    expect(reportingDateKey(Date.UTC(2026, 0, 2, 23, 30), "Asia/Tokyo")).toBe(
      "2026-01-03",
    );
    expect(
      summarizeActivity(
        [
          event({ occurredAt: Date.UTC(2026, 0, 2, 23, 30) }),
          event({ occurredAt: Date.UTC(2026, 0, 1, 23, 30) }),
          event({ occurredAt: 0 }),
          event({ occurredAt: Number.NaN }),
        ],
        "UTC",
      ),
    ).toEqual([
      { date: "2026-01-01", count: 1 },
      { date: "2026-01-02", count: 1 },
    ]);

    expect(percentile([Number.NaN, -1], 75)).toBe(0);
    expect(percentile([1, 2, 3, 4], -50)).toBe(1);
    expect(percentile([1, 2, 3, 4], 250)).toBe(4);
    expect(averageGapMs([Number.NaN, 0, 100])).toBe(0);
    expect(averageGapMs([300, 100, 200])).toBe(100);
    expect(detailTargetColumn({ type: "visitor", value: "v" })).toBe(
      "visitor_id",
    );
    expect(detailTargetColumn({ type: "session", value: "s" })).toBe(
      "session_id",
    );
  });
});
