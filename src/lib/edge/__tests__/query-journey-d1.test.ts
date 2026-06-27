import { describe, expect, it, vi } from "vitest";

import type { QueryWindow } from "@/lib/edge/query/core";
import {
  handleSessionDetail,
  handleSessions,
  handleVisitorDetail,
  handleVisitors,
  queryGeoPointAggregate,
  queryGeoPointsFromD1,
  queryJourneyEventsForDetailFromD1,
  queryJourneyEventsFromD1,
  querySessionDetailFromD1,
  querySessionLocationPointsFromD1,
  querySessionsForDetailFromD1,
  querySessionsFromD1,
  queryVisitorAggregate,
  queryVisitorDetailFromD1,
  queryVisitorForDetailFromD1,
  queryVisitorsFromD1,
} from "@/lib/edge/query/journeys";
import type { Env } from "@/lib/edge/types";

type D1Row = Record<string, unknown>;
type QueryBinding = string | number | null;

interface QueryCall {
  sql: string;
  bindings: QueryBinding[];
}

const siteId = "site-journey";
const baseMs = Date.UTC(2026, 0, 1);

function queryWindow(): QueryWindow {
  return {
    fromMs: baseMs,
    toMs: baseMs + 2 * 60 * 60 * 1000,
    nowMs: baseMs + 24 * 60 * 60 * 1000,
    timeZone: "UTC",
  };
}

function createD1Env(resultSets: D1Row[][]): {
  env: Env;
  calls: QueryCall[];
} {
  const calls: QueryCall[] = [];
  const pendingResults = [...resultSets];
  const prepare = vi.fn((sql: string) => ({
    bind: vi.fn((...bindings: QueryBinding[]) => ({
      all: vi.fn(async () => {
        calls.push({ sql, bindings });
        return { results: pendingResults.shift() ?? [] };
      }),
    })),
  }));

  return {
    env: {
      DB: { prepare } as unknown as D1Database,
      DAILY_SALT_SECRET: "test-secret",
      INGEST_DO: {} as DurableObjectNamespace,
    },
    calls,
  };
}

function visitBindings(window: QueryWindow): QueryBinding[] {
  return [siteId, window.fromMs, window.toMs];
}

function eventBindings(window: QueryWindow): QueryBinding[] {
  return [siteId, window.fromMs, window.toMs];
}

function url(path: string, params: Record<string, string | number | boolean>) {
  const parsed = new URL(`https://edge.test${path}`);
  for (const [key, value] of Object.entries(params)) {
    parsed.searchParams.set(key, String(value));
  }
  return parsed;
}

function visitorRow(overrides: D1Row = {}): D1Row {
  return {
    visitorId: "visitor-1",
    sessionId: "session-1",
    firstSeenAt: baseMs,
    lastSeenAt: baseMs + 60_000,
    views: 3,
    sessions: 2,
    events: 1,
    country: "US",
    region: "California",
    regionCode: "CA",
    city: "San Francisco",
    referrerHost: "ref.example",
    referrerUrl: "https://ref.example/start",
    browser: "Chrome",
    browserVersion: "124",
    os: "macOS",
    osVersion: "14",
    deviceType: "desktop",
    screenWidth: 1440,
    screenHeight: 900,
    ...overrides,
  };
}

function sessionRow(overrides: D1Row = {}): D1Row {
  return {
    sessionId: "session-1",
    visitorId: "visitor-1",
    startedAt: baseMs,
    endedAt: baseMs + 60_000,
    totalDurationMs: 60_000,
    active: 0,
    views: 2,
    events: 1,
    bounce: 0,
    entryPath: "/home",
    exitPath: "/pricing",
    referrerHost: "ref.example",
    referrerUrl: "https://ref.example/start",
    country: "US",
    region: "California",
    regionCode: "CA",
    city: "San Francisco",
    latitude: 37.77,
    longitude: -122.42,
    browser: "Chrome",
    browserVersion: "124",
    os: "macOS",
    osVersion: "14",
    deviceType: "desktop",
    screenWidth: 1440,
    screenHeight: 900,
    perfTtfbMs: 120,
    perfFcpMs: 300,
    perfLcpMs: 1200,
    perfCls: 0.02,
    perfInpMs: 90,
    ...overrides,
  };
}

function journeyEventRow(overrides: D1Row = {}): D1Row {
  return {
    id: "visit-1",
    kind: "pageview",
    eventType: "pageview",
    occurredAt: baseMs + 10_000,
    visitId: "visit-1",
    sessionId: "session-1",
    visitorId: "visitor-1",
    pathname: "/home",
    hash: "",
    title: "Home",
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
    durationMs: 40_000,
    perfTtfbMs: 100,
    perfFcpMs: 250,
    perfLcpMs: 1100,
    perfCls: 0.01,
    perfInpMs: 80,
    ...overrides,
  };
}

describe("edge journey detail D1 queries", () => {
  it("returns null for a missing visitor detail row and captures target bindings", async () => {
    const { env, calls } = createD1Env([[]]);

    await expect(
      queryVisitorForDetailFromD1(env, siteId, "visitor-missing"),
    ).resolves.toBeNull();

    expect(calls).toHaveLength(1);
    expect(calls[0].sql).toContain("visitor_id = ?");
    expect(calls[0].bindings).toEqual([siteId, "visitor-missing", siteId]);
  });

  it("combines visitor, session, and event rows into visitor detail metrics", async () => {
    const secondSessionStart = baseMs + 24 * 60 * 60 * 1000;
    const { env, calls } = createD1Env([
      [visitorRow({ firstSeenAt: baseMs, lastSeenAt: secondSessionStart })],
      [
        sessionRow(),
        sessionRow({
          sessionId: "session-2",
          startedAt: secondSessionStart,
          endedAt: secondSessionStart + 30_000,
          totalDurationMs: 30_000,
          bounce: 1,
          entryPath: "/checkout",
          exitPath: "/checkout",
        }),
      ],
      [
        journeyEventRow(),
        journeyEventRow({
          id: "event-1",
          kind: "custom",
          eventType: "signup",
          occurredAt: baseMs + 20_000,
          visitId: "visit-1",
          pathname: "/signup",
          durationMs: 0,
        }),
      ],
    ]);

    const detail = await queryVisitorDetailFromD1(
      env,
      siteId,
      "visitor-1",
      "UTC",
    );

    expect(detail?.metrics).toMatchObject({
      totalEvents: 1,
      sessions: 2,
      views: 1,
      avgEventsPerSession: 0.5,
      bounceRate: 0.5,
      avgDurationMs: 45_000,
      p90DurationMs: 60_000,
      daysActive: 2,
      conversionEvents: 1,
      avgTimeBetweenSessionsMs: 24 * 60 * 60 * 1000,
    });
    expect(detail?.visitedPages).toEqual([{ pathname: "/home", views: 1 }]);
    expect(detail?.eventDistribution).toEqual([
      { eventType: "session start", count: 2 },
      { eventType: "pageview", count: 1 },
      { eventType: "signup", count: 1 },
    ]);
    expect(detail?.performance.ttfb).toMatchObject({
      avg: 100,
      p75: 100,
      samples: 1,
    });
    expect(detail?.events.map((event) => event.id)).toContain(
      "session-start:session-2",
    );
    expect(calls.map((call) => call.bindings)).toEqual([
      [siteId, "visitor-1", siteId],
      [siteId, "visitor-1", siteId],
      [siteId, "visitor-1", siteId],
    ]);
  });

  it("returns null visitor detail without consuming session or event rows", async () => {
    const { env, calls } = createD1Env([
      [],
      [sessionRow()],
      [journeyEventRow()],
    ]);

    await expect(
      queryVisitorDetailFromD1(env, siteId, "visitor-missing", "UTC"),
    ).resolves.toBeNull();

    expect(calls).toHaveLength(3);
    expect(calls.every((call) => call.bindings[1] === "visitor-missing")).toBe(
      true,
    );
  });

  it("returns zeroed visitor detail metrics when no sessions or events exist", async () => {
    const { env } = createD1Env([[visitorRow()], [], []]);

    const detail = await queryVisitorDetailFromD1(
      env,
      siteId,
      "visitor-1",
      "UTC",
    );

    expect(detail).toMatchObject({
      metrics: {
        totalEvents: 0,
        sessions: 0,
        views: 0,
        avgEventsPerSession: 0,
        bounceRate: 0,
        avgDurationMs: 0,
        p90DurationMs: 0,
        daysActive: 0,
        conversionEvents: 0,
        avgTimeBetweenSessionsMs: 0,
      },
      sessions: [],
      events: [],
      visitedPages: [],
      eventDistribution: [],
      activity: [],
    });
  });

  it("returns session detail with synthetic start and leave events", async () => {
    const { env } = createD1Env([
      [sessionRow()],
      [journeyEventRow()],
      [
        {
          latitude: "37.7",
          longitude: "-122.4",
          timestampMs: String(baseMs + 10_000),
          country: "US",
          region: "California",
          regionCode: "CA",
          city: "San Francisco",
        },
      ],
    ]);

    const detail = await querySessionDetailFromD1(env, siteId, "session-1");

    expect(detail?.session).toMatchObject({
      sessionId: "session-1",
      durationMs: 60_000,
      performance: {
        ttfb: 120,
        fcp: 300,
        lcp: 1200,
        cls: 0.02,
        inp: 90,
      },
    });
    expect(detail?.locationPoints).toEqual([
      {
        latitude: 37.7,
        longitude: -122.4,
        timestampMs: baseMs + 10_000,
        country: "US",
        region: "California",
        regionCode: "CA",
        city: "San Francisco",
        pointCount: 1,
      },
    ]);
    expect(detail?.events.map((event) => event.id)).toEqual([
      "session-leave:session-1",
      "visit-1",
      "session-start:session-1",
    ]);
    expect(detail?.eventDistribution).toEqual([
      { eventType: "leave", count: 1 },
      { eventType: "pageview", count: 1 },
      { eventType: "session start", count: 1 },
    ]);
  });

  it("sorts session detail events with id tie-breakers", async () => {
    const { env } = createD1Env([
      [
        sessionRow({
          active: 1,
          startedAt: baseMs,
          endedAt: baseMs + 30_000,
        }),
      ],
      [
        journeyEventRow({
          id: "z-event",
          occurredAt: baseMs + 10_000,
          visitId: "visit-z",
        }),
        journeyEventRow({
          id: "a-event",
          occurredAt: baseMs + 10_000,
          visitId: "visit-a",
          pathname: "/a",
        }),
      ],
      [],
    ]);

    const detail = await querySessionDetailFromD1(env, siteId, "session-1");

    expect(detail?.events.map((event) => event.id)).toEqual([
      "z-event",
      "a-event",
      "session-start:session-1",
    ]);
  });

  it("returns null when a session detail lookup has no matching session row", async () => {
    const { env } = createD1Env([[], [journeyEventRow()], []]);

    await expect(
      querySessionDetailFromD1(env, siteId, "session-missing"),
    ).resolves.toBeNull();
  });

  it("omits leave events for active session detail rows", async () => {
    const { env } = createD1Env([
      [
        sessionRow({
          active: 1,
          endedAt: baseMs + 60_000,
          exitPath: "/still-open",
        }),
      ],
      [journeyEventRow()],
      [],
    ]);

    const detail = await querySessionDetailFromD1(env, siteId, "session-1");

    expect(detail?.events.map((event) => event.kind)).toEqual([
      "pageview",
      "session_start",
    ]);
    expect(detail?.eventDistribution).toEqual([
      { eventType: "pageview", count: 1 },
      { eventType: "session start", count: 1 },
    ]);
  });

  it("maps direct detail query rows for sessions, events, and location points", async () => {
    const { env, calls } = createD1Env([
      [sessionRow({ sessionId: "session-2", totalDurationMs: "1500" })],
      [journeyEventRow({ id: "event-2", kind: "custom", eventType: "paid" })],
      [{ latitude: 1, longitude: 2, timestampMs: 3 }],
    ]);

    await expect(
      querySessionsForDetailFromD1(env, siteId, {
        type: "session",
        value: "session-2",
      }),
    ).resolves.toMatchObject([{ sessionId: "session-2", durationMs: 1500 }]);
    await expect(
      queryJourneyEventsForDetailFromD1(env, siteId, {
        type: "session",
        value: "session-2",
      }),
    ).resolves.toMatchObject([{ id: "event-2", kind: "custom" }]);
    await expect(
      querySessionLocationPointsFromD1(env, siteId, "session-2"),
    ).resolves.toEqual([
      {
        latitude: 1,
        longitude: 2,
        timestampMs: 3,
        country: "",
        region: "",
        regionCode: "",
        city: "",
        pointCount: 1,
      },
    ]);

    expect(calls[0].sql).toContain("session_id = ?");
    expect(calls[1].sql).toContain("UNION ALL");
    expect(calls[2].bindings).toEqual([siteId, "session-2"]);
  });
});

describe("edge journey list D1 queries", () => {
  it("passes default aggregate arguments through to the visitor list query", async () => {
    const window = queryWindow();
    const { env, calls } = createD1Env([
      [visitorRow({ visitorId: "visitor-2" })],
    ]);

    await expect(
      queryVisitorAggregate(env, siteId, window, {}, 6),
    ).resolves.toMatchObject([{ visitorId: "visitor-2" }]);

    expect(calls[0].sql).toContain("ORDER BY lastSeenAt DESC");
    expect(calls[0].bindings.at(-2)).toBe(6);
    expect(calls[0].bindings.at(-1)).toBe(0);
  });

  it("builds visitor list SQL with target, search, sorting, and pagination", async () => {
    const window = queryWindow();
    const { env, calls } = createD1Env([[visitorRow({ visitorId: 123 })]]);

    await expect(
      queryVisitorsFromD1(
        env,
        siteId,
        window,
        { country: "US" },
        5,
        "123",
        10,
        { key: "views", direction: "asc" },
        "Chrome",
      ),
    ).resolves.toMatchObject([{ visitorId: "123", views: 3 }]);

    expect(calls[0].sql).toContain("matched_visitors");
    expect(calls[0].sql).toContain("ORDER BY views ASC");
    expect(calls[0].bindings.slice(0, 8)).toEqual([
      ...visitBindings(window),
      ...eventBindings(window),
      "123",
      "us",
    ]);
    expect(calls[0].bindings.at(-2)).toBe(5);
    expect(calls[0].bindings.at(-1)).toBe(10);
  });

  it("builds session list SQL with session target and search filters", async () => {
    const window = queryWindow();
    const { env, calls } = createD1Env([[sessionRow()]]);

    await expect(
      querySessionsFromD1(
        env,
        siteId,
        window,
        { device: "desktop" },
        7,
        { type: "session", value: "session-1" },
        2,
        { key: "durationMs", direction: "asc" },
        "pricing",
      ),
    ).resolves.toMatchObject([{ sessionId: "session-1", durationMs: 60_000 }]);

    expect(calls[0].sql).toContain("matched_sessions");
    expect(calls[0].sql).toContain("ORDER BY totalDurationMs ASC");
    expect(calls[0].bindings.slice(0, 8)).toEqual([
      ...visitBindings(window),
      ...eventBindings(window),
      "session-1",
      "desktop",
    ]);
    expect(calls[0].bindings.at(-2)).toBe(7);
    expect(calls[0].bindings.at(-1)).toBe(2);
  });

  it("queries a target journey event list with visit filters and limit", async () => {
    const window = queryWindow();
    const { env, calls } = createD1Env([
      [journeyEventRow({ id: "event-3", kind: "custom", eventType: "paid" })],
    ]);

    await expect(
      queryJourneyEventsFromD1(
        env,
        siteId,
        window,
        { path: "/pricing" },
        { type: "session", value: "session-1" },
        20,
      ),
    ).resolves.toMatchObject([{ id: "event-3", kind: "custom" }]);

    expect(calls[0].sql).toContain("INNER JOIN filtered_visits");
    expect(calls[0].sql).toContain("WHERE session_id = ?");
    expect(calls[0].bindings).toEqual([
      ...visitBindings(window),
      ...eventBindings(window),
      "session-1",
      "/pricing",
      20,
    ]);
  });
});

describe("edge journey geo D1 queries", () => {
  it("passes geo aggregate calls through to the D1 implementation", async () => {
    const window = queryWindow();
    const { env } = createD1Env([
      [{ latitude: 1, longitude: 2, timestampMs: 3 }],
      [],
    ]);

    await expect(
      queryGeoPointAggregate(env, siteId, window, {}, 5),
    ).resolves.toEqual({
      points: [
        {
          latitude: 1,
          longitude: 2,
          timestampMs: 3,
          country: "",
          region: "",
          regionCode: "",
          city: "",
          pointCount: 1,
        },
      ],
      countryCounts: [],
      regionCounts: [],
      cityCounts: [],
    });
  });

  it("returns point data and country counts when no geo drilldown is active", async () => {
    const window = queryWindow();
    const { env, calls } = createD1Env([
      [
        {
          latitude: "42.5",
          longitude: "13.5",
          timestampMs: "100",
          country: "IT",
        },
      ],
      [{ country: "IT", views: "8", sessions: "4", visitors: "3" }],
    ]);

    await expect(
      queryGeoPointsFromD1(env, siteId, window, { country: "IT" }, 25),
    ).resolves.toEqual({
      points: [
        {
          latitude: 42.5,
          longitude: 13.5,
          timestampMs: 100,
          country: "IT",
          region: "",
          regionCode: "",
          city: "",
          pointCount: 1,
        },
      ],
      countryCounts: [{ country: "IT", views: 8, sessions: 4, visitors: 3 }],
      regionCounts: [],
      cityCounts: [],
    });
    expect(calls[0].bindings).toEqual([...visitBindings(window), "it", 25]);
    expect(calls[1].sql).toContain("GROUP BY country");
  });

  it("defaults missing geo country count fields", async () => {
    const window = queryWindow();
    const { env } = createD1Env([[], [{ country: null }]]);

    await expect(
      queryGeoPointsFromD1(env, siteId, window, {}, 10),
    ).resolves.toMatchObject({
      countryCounts: [{ country: "", views: 0, sessions: 0, visitors: 0 }],
      regionCounts: [],
      cityCounts: [],
    });
  });

  it("returns region counts when drilled into a country", async () => {
    const window = queryWindow();
    const { env } = createD1Env([
      [],
      [
        {
          country: "us",
          regionCode: "ca",
          region: "California",
          views: "5",
          sessions: "3",
          visitors: "2",
        },
        { country: "", regionCode: "", region: "", views: 1 },
      ],
    ]);

    await expect(
      queryGeoPointsFromD1(env, siteId, window, { geo: "US" }, 10),
    ).resolves.toMatchObject({
      countryCounts: [],
      regionCounts: [
        {
          value: "US::CA::California",
          label: "California",
          views: 5,
          sessions: 3,
          visitors: 2,
        },
      ],
      cityCounts: [],
    });
  });

  it("returns city counts when drilled into a region or city scope", async () => {
    const window = queryWindow();
    const { env, calls } = createD1Env([
      [],
      [
        {
          country: "us",
          regionCode: "ca",
          region: "California",
          city: "San Francisco",
          views: "6",
          sessions: "4",
          visitors: "3",
        },
        { country: "US", city: "", views: 100 },
      ],
    ]);

    await expect(
      queryGeoPointsFromD1(
        env,
        siteId,
        window,
        { geo: "US::CA::California" },
        10,
      ),
    ).resolves.toMatchObject({
      countryCounts: [],
      regionCounts: [],
      cityCounts: [
        {
          value: "US::CA::California::San Francisco",
          label: "San Francisco",
          views: 6,
          sessions: 4,
          visitors: 3,
        },
      ],
    });
    expect(calls[1].sql).toContain(
      "GROUP BY country, regionCode, region, city",
    );
  });

  it("defaults missing geo dimension count fields", async () => {
    const window = queryWindow();
    const regionEnv = createD1Env([
      [],
      [
        {
          country: "us",
          regionCode: "ny",
        },
      ],
    ]);

    await expect(
      queryGeoPointsFromD1(regionEnv.env, siteId, window, { geo: "US" }, 10),
    ).resolves.toMatchObject({
      regionCounts: [
        {
          value: "US::NY::NY",
          label: "NY",
          views: 0,
          sessions: 0,
          visitors: 0,
        },
      ],
      cityCounts: [],
    });

    const cityEnv = createD1Env([
      [],
      [
        {
          country: "us",
          city: "New York",
        },
      ],
    ]);

    await expect(
      queryGeoPointsFromD1(
        cityEnv.env,
        siteId,
        window,
        { geo: "US::NY::NY" },
        10,
      ),
    ).resolves.toMatchObject({
      regionCounts: [],
      cityCounts: [
        {
          value: "US::New York",
          label: "New York",
          views: 0,
          sessions: 0,
          visitors: 0,
        },
      ],
    });
  });

  it("falls back to region names when building geo aggregate values", async () => {
    const window = queryWindow();
    const regionEnv = createD1Env([
      [],
      [
        {
          country: "ca",
          regionCode: "",
          region: "Ontario",
          views: "4",
          sessions: "2",
          visitors: "1",
        },
      ],
    ]);

    await expect(
      queryGeoPointsFromD1(regionEnv.env, siteId, window, { geo: "CA" }, 10),
    ).resolves.toMatchObject({
      regionCounts: [
        {
          value: "CA::ONTARIO::Ontario",
          label: "Ontario",
          views: 4,
          sessions: 2,
          visitors: 1,
        },
      ],
      cityCounts: [],
    });

    const cityEnv = createD1Env([
      [],
      [
        {
          country: "ca",
          regionCode: "",
          region: "",
          city: "Toronto",
          views: "7",
          sessions: "3",
          visitors: "2",
        },
      ],
    ]);

    await expect(
      queryGeoPointsFromD1(
        cityEnv.env,
        siteId,
        window,
        { geo: "CA::ON::Ontario" },
        10,
      ),
    ).resolves.toMatchObject({
      regionCounts: [],
      cityCounts: [
        {
          value: "CA::Toronto",
          label: "Toronto",
          views: 7,
          sessions: 3,
          visitors: 2,
        },
      ],
    });
  });
});

describe("edge journey handlers", () => {
  it("paginates visitors and trims hasMore rows", async () => {
    const window = queryWindow();
    const { env, calls } = createD1Env([
      [
        visitorRow({ visitorId: "visitor-1" }),
        visitorRow({ visitorId: "visitor-2" }),
      ],
    ]);

    const response = await handleVisitors(
      env,
      siteId,
      url("/visitors", {
        from: window.fromMs,
        to: window.toMs,
        page: 2,
        pageSize: 1,
        sortBy: "views",
        sortDir: "asc",
        search: "Chrome",
      }),
    );

    await expect(response.json()).resolves.toMatchObject({
      ok: true,
      data: [{ visitorId: "visitor-1", views: 3, sessions: 2 }],
      meta: {
        page: 2,
        pageSize: 1,
        returned: 1,
        hasMore: true,
        nextPage: 3,
      },
    });
    expect(calls[0].sql).toContain("ORDER BY views ASC");
    expect(calls[0].bindings.at(-2)).toBe(2);
    expect(calls[0].bindings.at(-1)).toBe(1);
  });

  it("returns non-paged sessions with search and default metadata", async () => {
    const window = queryWindow();
    const { env, calls } = createD1Env([[sessionRow()]]);

    const response = await handleSessions(
      env,
      siteId,
      url("/sessions", {
        from: window.fromMs,
        to: window.toMs,
        limit: 3,
        search: "pricing",
      }),
    );

    await expect(response.json()).resolves.toMatchObject({
      ok: true,
      data: [{ sessionId: "session-1", visitorId: "visitor-1" }],
      meta: {
        page: 1,
        pageSize: 3,
        returned: 1,
        hasMore: false,
        nextPage: null,
      },
    });
    expect(calls[0].bindings.at(-2)).toBe(3);
    expect(calls[0].bindings.at(-1)).toBe(0);
  });

  it("paginates sessions and trims the extra hasMore row", async () => {
    const window = queryWindow();
    const { env, calls } = createD1Env([
      [
        sessionRow({ sessionId: "session-1" }),
        sessionRow({ sessionId: "session-2" }),
      ],
    ]);

    const response = await handleSessions(
      env,
      siteId,
      url("/sessions", {
        from: window.fromMs,
        to: window.toMs,
        page: 1,
        pageSize: 1,
        sortBy: "views",
        sortDir: "asc",
      }),
    );

    await expect(response.json()).resolves.toMatchObject({
      ok: true,
      data: [{ sessionId: "session-1" }],
      meta: {
        page: 1,
        pageSize: 1,
        returned: 1,
        hasMore: true,
        nextPage: 2,
      },
    });
    expect(calls[0].sql).toContain("ORDER BY views ASC");
    expect(calls[0].bindings.at(-2)).toBe(2);
    expect(calls[0].bindings.at(-1)).toBe(0);
  });

  it("rejects invalid list windows before querying D1", async () => {
    const { env, calls } = createD1Env([]);

    const visitors = await handleVisitors(
      env,
      siteId,
      new URL("https://edge.test/visitors?from=20&to=10"),
    );
    const sessions = await handleSessions(
      env,
      siteId,
      new URL("https://edge.test/sessions?from=20&to=10"),
    );

    expect(visitors.status).toBe(400);
    expect(sessions.status).toBe(400);
    await expect(visitors.json()).resolves.toMatchObject({
      ok: false,
      error: { message: "Invalid time window" },
    });
    await expect(sessions.json()).resolves.toMatchObject({
      ok: false,
      error: { message: "Invalid time window" },
    });
    expect(calls).toEqual([]);
  });

  it("validates missing detail ids before querying D1", async () => {
    const { env, calls } = createD1Env([]);

    const visitor = await handleVisitorDetail(
      env,
      siteId,
      new URL("https://edge.test/visitor-detail"),
    );
    const session = await handleSessionDetail(
      env,
      siteId,
      new URL("https://edge.test/session-detail"),
    );

    expect(visitor.status).toBe(400);
    expect(session.status).toBe(400);
    await expect(visitor.json()).resolves.toMatchObject({
      ok: false,
      error: { message: "Missing visitorId" },
    });
    await expect(session.json()).resolves.toMatchObject({
      ok: false,
      error: { message: "Missing sessionId" },
    });
    expect(calls).toEqual([]);
  });

  it("returns visitor and session detail handler payloads", async () => {
    const { env } = createD1Env([
      [visitorRow()],
      [sessionRow()],
      [journeyEventRow()],
      [sessionRow()],
      [journeyEventRow()],
      [{ latitude: 1, longitude: 2, timestampMs: 3 }],
    ]);

    const visitor = await handleVisitorDetail(
      env,
      siteId,
      new URL(
        "https://edge.test/visitor-detail?visitorId=visitor-1&timeZone=Bad/Zone",
      ),
    );
    const session = await handleSessionDetail(
      env,
      siteId,
      new URL("https://edge.test/session-detail?sessionId=session-1"),
    );

    await expect(visitor.json()).resolves.toMatchObject({
      ok: true,
      data: {
        visitor: { visitorId: "visitor-1" },
        metrics: { sessions: 1 },
      },
    });
    await expect(session.json()).resolves.toMatchObject({
      ok: true,
      data: {
        session: { sessionId: "session-1" },
        locationPoints: [{ latitude: 1, longitude: 2, timestampMs: 3 }],
      },
    });
  });
});
