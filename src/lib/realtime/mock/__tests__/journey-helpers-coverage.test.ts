import { afterEach, describe, expect, it, vi } from "vitest";

import {
  compareDemoNumericField,
  createDemoJourneyEvents,
  createDemoJourneyLocationPoints,
  createDemoJourneySession,
  demoAverageGapMs,
  demoJourneyPercentile,
  demoReportingDateKey,
  demoVisitsBySession,
  parseDemoSessionSort,
  parseDemoVisitorSort,
  summarizeDemoActivity,
  summarizeDemoEventDistribution,
  summarizeDemoVisitedPages,
} from "@/lib/realtime/mock/journey-helpers";
import type { DemoVisitFact } from "@/lib/realtime/mock/types";

describe("mock/journey-helpers coverage", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("sorts location points by visit time and drops invalid coordinates", () => {
    const visits = [
      makeVisit({
        visitId: "late",
        startedAt: 300,
        latitude: Number.NaN,
      }),
      makeVisit({
        visitId: "b",
        startedAt: 100,
        country: "DE",
        regionName: "",
        region: "BE",
        cityName: "",
        city: "Berlin",
        latitude: 52.52,
        longitude: 13.405,
      }),
      makeVisit({
        visitId: "a",
        startedAt: 100,
        country: "US",
        regionName: "California",
        regionCode: "CA",
        cityName: "San Francisco",
        latitude: 37.77,
        longitude: -122.42,
      }),
      makeVisit({
        visitId: "bad-lon",
        startedAt: 200,
        longitude: 181,
      }),
    ];

    expect(createDemoJourneyLocationPoints(visits)).toEqual([
      {
        latitude: 37.77,
        longitude: -122.42,
        timestampMs: 100,
        country: "US",
        region: "California",
        regionCode: "CA",
        city: "San Francisco",
      },
      {
        latitude: 52.52,
        longitude: 13.405,
        timestampMs: 100,
        country: "DE",
        region: "BE",
        regionCode: "",
        city: "Berlin",
      },
    ]);
  });

  it("builds a session from ordered visits with non-negative duration and geo fallback", () => {
    vi.useFakeTimers();
    vi.setSystemTime(600_000);
    const session = createDemoJourneySession("s1", [
      makeVisit({
        visitId: "last",
        startedAt: 400_000,
        pathname: "/checkout",
        durationMs: 2_000,
        latitude: 91,
        longitude: 0,
      }),
      makeVisit({
        visitId: "first",
        startedAt: 100_000,
        pathname: "/landing",
        durationMs: -500,
        eventType: "signup",
        screenSize: "390x844",
        latitude: 12,
        longitude: 34,
      }),
    ]);

    expect(session).toMatchObject({
      sessionId: "s1",
      visitorId: "visitor-1",
      startedAt: 100_000,
      endedAt: 402_000,
      durationMs: 2_000,
      active: true,
      views: 2,
      events: 1,
      bounce: false,
      entryPath: "/landing",
      exitPath: "/checkout",
      latitude: 12,
      longitude: 34,
      screenWidth: 390,
      screenHeight: 844,
    });
    expect(createDemoJourneySession("empty", [])).toBeNull();
    expect(
      createDemoJourneySession(
        "missing-first-last",
        new Array(1) as DemoVisitFact[],
      ),
    ).toBeNull();
  });

  it("uses visit ids to order session visits with matching timestamps", () => {
    vi.useFakeTimers();
    vi.setSystemTime(600_000);
    const session = createDemoJourneySession("same-timestamp", [
      makeVisit({
        visitId: "z-exit",
        startedAt: 100_000,
        pathname: "/exit",
        durationMs: 1_000,
      }),
      makeVisit({
        visitId: "a-entry",
        startedAt: 100_000,
        pathname: "/entry",
        durationMs: 2_000,
      }),
    ]);

    expect(session).toMatchObject({
      sessionId: "same-timestamp",
      startedAt: 100_000,
      endedAt: 102_000,
      durationMs: 3_000,
      entryPath: "/entry",
      exitPath: "/exit",
    });
  });

  it("groups visits by session without sorting or dropping entries", () => {
    const grouped = demoVisitsBySession([
      makeVisit({ visitId: "a", sessionId: "s1" }),
      makeVisit({ visitId: "b", sessionId: "s2" }),
      makeVisit({ visitId: "c", sessionId: "s1" }),
    ]);

    expect([...grouped.keys()]).toEqual(["s1", "s2"]);
    expect(grouped.get("s1")?.map((visit) => visit.visitId)).toEqual([
      "a",
      "c",
    ]);
  });

  it("creates page, custom, start, and inactive leave events in descending occurrence order", () => {
    vi.useFakeTimers();
    vi.setSystemTime(10 * 60 * 1000);
    const events = createDemoJourneyEvents(
      [
        makeVisit({
          visitId: "early",
          startedAt: 1_000,
          durationMs: 500,
          eventType: "signup",
          pathname: "/start",
        }),
        makeVisit({
          visitId: "late",
          startedAt: 2_000,
          durationMs: -50,
          eventType: "pageview",
          pathname: "/end",
        }),
      ],
      { includeSessionStart: true, includeSessionEnd: true },
    );

    expect(events.map((event) => event.id)).toEqual([
      "session-leave:s1",
      "late",
      "early:signup",
      "session-start:s1",
      "early",
    ]);
    expect(events.find((event) => event.id === "late")).toMatchObject({
      kind: "pageview",
      durationMs: 0,
      pathname: "/end",
    });
    expect(events.find((event) => event.id === "early:signup")).toMatchObject({
      kind: "custom",
      eventType: "signup",
      occurredAt: 2_000,
    });
  });

  it("skips null sessions when adding session start and end events", () => {
    const originalEntries = Map.prototype.entries;
    vi.spyOn(Map.prototype, "entries").mockImplementation(function (
      this: Map<unknown, unknown>,
    ) {
      const entries = Array.from(originalEntries.call(this));
      const sessionVisitMap = entries.some(
        ([, value]) =>
          Array.isArray(value) &&
          value.some((visit) =>
            Boolean((visit as Partial<DemoVisitFact> | undefined)?.visitId),
          ),
      );
      if (!sessionVisitMap) {
        return entries[Symbol.iterator]() as ReturnType<
          Map<unknown, unknown>["entries"]
        >;
      }

      return [...entries, ["empty-session", []]][
        Symbol.iterator
      ]() as ReturnType<Map<unknown, unknown>["entries"]>;
    });

    const events = createDemoJourneyEvents([makeVisit()], {
      includeSessionStart: true,
      includeSessionEnd: true,
    });

    expect(events.some((event) => event.id === "session-start:s1")).toBe(true);
    expect(
      events.some((event) => event.id === "session-start:empty-session"),
    ).toBe(false);
    expect(
      events.some((event) => event.id === "session-leave:empty-session"),
    ).toBe(false);
  });

  it("adds inactive session leave events from the last visit", () => {
    vi.useFakeTimers();
    vi.setSystemTime(20 * 60 * 1000);
    const events = createDemoJourneyEvents(
      [
        makeVisit({
          visitId: "first",
          startedAt: 50_000,
          durationMs: 1_000,
          pathname: "/entry",
        }),
        makeVisit({
          visitId: "last",
          startedAt: 60_000,
          durationMs: 5_000,
          pathname: "",
          title: "Exit",
          hostname: "exit.example.test",
          screenSize: "1366x768",
        }),
      ],
      { includeSessionEnd: true },
    );

    expect(
      events.find((event) => event.id === "session-leave:s1"),
    ).toMatchObject({
      kind: "leave",
      eventType: "leave",
      occurredAt: 65_000,
      visitId: "last",
      pathname: "",
      title: "Exit",
      hostname: "exit.example.test",
      screenWidth: 1366,
      screenHeight: 768,
    });
    expect(events.some((event) => event.id === "session-start:s1")).toBe(false);
  });

  it("sorts same-timestamp events by id descending", () => {
    const events = createDemoJourneyEvents([
      makeVisit({
        visitId: "alpha",
        startedAt: 1_000,
      }),
      makeVisit({
        visitId: "omega",
        startedAt: 1_000,
      }),
    ]);

    expect(events.map((event) => event.id)).toEqual(["omega", "alpha"]);
  });

  it("handles tied and invalid session boundary events", () => {
    vi.useFakeTimers();
    vi.setSystemTime(20 * 60 * 1000);

    const tiedEvents = createDemoJourneyEvents(
      [
        makeVisit({ visitId: "first", startedAt: 50_000, durationMs: 1_000 }),
        makeVisit({ visitId: "last", startedAt: 50_000, durationMs: 2_000 }),
      ],
      { includeSessionEnd: true },
    );
    expect(tiedEvents.some((event) => event.kind === "leave")).toBe(true);

    const invalidEvents = createDemoJourneyEvents(
      [makeVisit({ startedAt: undefined as unknown as number })],
      { includeSessionEnd: true },
    );
    expect(invalidEvents.some((event) => event.kind === "leave")).toBe(false);

    const activeEvents = createDemoJourneyEvents(
      [makeVisit({ startedAt: Date.now() - 1_000 })],
      { includeSessionEnd: true },
    );
    expect(activeEvents.some((event) => event.kind === "leave")).toBe(false);

    const incompleteEvents = createDemoJourneyEvents([
      makeVisit({
        visitId: undefined as unknown as string,
        startedAt: undefined as unknown as number,
      }),
      makeVisit({
        visitId: undefined as unknown as string,
        startedAt: undefined as unknown as number,
      }),
    ]);
    expect(incompleteEvents).toHaveLength(2);
  });

  it("summarizes pages, event types, and activity with invalid events ignored", () => {
    const events = [
      { kind: "pageview", pathname: "/pricing", occurredAt: 1000 },
      { kind: "pageview", pathname: "   ", occurredAt: 2000 },
      { kind: "pageview", pathname: "/pricing", occurredAt: Number.NaN },
      { kind: "custom", eventType: "signup", occurredAt: 86_401_000 },
      { kind: "custom", kindOnly: true, occurredAt: -1 },
    ];

    expect(summarizeDemoVisitedPages(events)).toEqual([
      { pathname: "/pricing", views: 2 },
      { pathname: "/", views: 1 },
    ]);
    expect(summarizeDemoEventDistribution(events)).toEqual([
      { eventType: "pageview", count: 3 },
      { eventType: "custom", count: 1 },
      { eventType: "signup", count: 1 },
    ]);
    expect(summarizeDemoActivity(events, "UTC")).toEqual([
      { date: "1970-01-01", count: 2 },
      { date: "1970-01-02", count: 1 },
    ]);
    expect(demoReportingDateKey(Date.UTC(2026, 0, 1, 1), "UTC")).toBe(
      "2026-01-01",
    );
  });

  it("falls back for empty pathname and event type values", () => {
    expect(
      summarizeDemoVisitedPages([
        { kind: "pageview", pathname: "" },
        { kind: "pageview", pathname: null },
        { kind: "custom", pathname: "/ignored" },
      ]),
    ).toEqual([{ pathname: "/", views: 2 }]);

    expect(
      summarizeDemoEventDistribution([
        { kind: "custom", eventType: "" },
        { kind: "", eventType: "" },
        { kind: null, eventType: null },
        { kind: "custom", eventType: "purchase" },
      ]),
    ).toEqual([
      { eventType: "event", count: 2 },
      { eventType: "custom", count: 1 },
      { eventType: "purchase", count: 1 },
    ]);
  });

  it("computes percentiles and average gaps from finite non-negative inputs", () => {
    expect(demoJourneyPercentile([50, -1, 10, Number.NaN, 30], 50)).toBe(30);
    expect(demoJourneyPercentile([10, 20, 30], 0)).toBe(10);
    expect(demoJourneyPercentile([10, 20, 30], 999)).toBe(30);
    expect(demoJourneyPercentile([], 95)).toBe(0);
    expect(demoJourneyPercentile([Number.NaN, -1, -100], 75)).toBe(0);

    expect(demoAverageGapMs([100, 200, Number.POSITIVE_INFINITY, 500])).toBe(
      200,
    );
    expect(demoAverageGapMs([0, 100])).toBe(0);
  });

  it("parses sort options and compares numeric fields in both directions", () => {
    expect(
      parseDemoVisitorSort({ sortBy: "sessions", sortDir: "ASC" }),
    ).toEqual({
      key: "sessions",
      direction: "asc",
    });
    expect(parseDemoVisitorSort({ sortBy: "bad", sortDir: "asc" })).toEqual({
      key: "lastSeenAt",
      direction: "desc",
    });
    expect(parseDemoSessionSort({ sortBy: "views" })).toEqual({
      key: "views",
      direction: "desc",
    });
    expect(parseDemoSessionSort({ sortBy: "unknown" })).toEqual({
      key: "startedAt",
      direction: "desc",
    });

    expect(
      compareDemoNumericField({ views: 2 }, { views: 5 }, "views", "asc"),
    ).toBeLessThan(0);
    expect(
      compareDemoNumericField({ views: 2 }, { views: 5 }, "views", "desc"),
    ).toBeGreaterThan(0);
  });
});

function makeVisit(overrides: Partial<DemoVisitFact> = {}): DemoVisitFact {
  return {
    visitId: "visit-1",
    sessionId: "s1",
    visitorId: "visitor-1",
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
    regionCode: "",
    regionName: "",
    region: "",
    cityName: "",
    city: "",
    continent: "North America",
    timezone: "UTC",
    organization: "Example ISP",
    latitude: 0,
    longitude: 0,
    eventType: "pageview",
    durationMs: 1000,
    ...overrides,
  };
}
