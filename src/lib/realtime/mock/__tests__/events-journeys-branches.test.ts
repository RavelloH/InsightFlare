import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  generateDemoEventsSummary,
  generateDemoEventsTrend,
  generateDemoEventTypeDetail,
} from "@/lib/realtime/mock/events";
import type * as FactBuilder from "@/lib/realtime/mock/fact-builder";
import {
  generateDemoSessionDetail,
  generateDemoSessions,
  generateDemoVisitorDetail,
  generateDemoVisitors,
} from "@/lib/realtime/mock/journeys";
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

describe("mock events and journeys branch coverage", () => {
  beforeEach(() => {
    mockApplyDemoFilters.mockReset();
    mockBuildDemoFactDataset.mockReset();
  });

  it("returns zero event rates when filtered visits have no custom events", () => {
    setFacts([makeVisit({ eventType: "pageview" })]);

    expect(
      generateDemoEventsSummary("site", { from: 0, to: 3_600_000 }),
    ).toMatchObject({
      ok: true,
      summary: {
        events: 0,
        eventTypes: 0,
        sessions: 0,
        visitors: 0,
        avgEventsPerSession: 0,
      },
    });
    expect(
      generateDemoEventTypeDetail("site", {
        from: 0,
        to: 3_600_000,
        interval: "hour",
        eventName: "signup",
        timeZone: "UTC",
      }),
    ).toMatchObject({
      ok: true,
      eventName: "signup",
      summary: {
        events: 0,
        eventTypes: 1,
        sessions: 0,
        visitors: 0,
        avgEventsPerSession: 0,
        shareOfAllEvents: 0,
      },
    });
  });

  it("keeps trend series but skips custom events outside requested buckets", () => {
    setFacts([
      makeVisit({
        visitId: "late-signup",
        eventType: "signup",
        startedAt: 3 * 3_600_000,
      }),
    ]);

    const result = generateDemoEventsTrend("site", {
      from: 0,
      to: 3_600_000,
      interval: "hour",
      limit: 5,
      timeZone: "UTC",
    });
    const data = result.data as Array<Record<string, unknown>>;

    expect(result).toMatchObject({
      ok: true,
      series: [expect.objectContaining({ eventName: "signup", events: 1 })],
    });
    expect(data.map((point) => point.totalEvents)).toEqual([0, 0]);
  });

  it("uses the latest visit only when it is not replaced by an older same-visitor row", () => {
    setFacts([
      makeVisit({
        visitId: "latest",
        visitorId: "visitor-1",
        sessionId: "s-latest",
        startedAt: 3_000,
        regionName: "",
        region: "DE::BE::Berlin",
        cityName: "",
        city: "DE::BE::Berlin::Berlin",
      }),
      makeVisit({
        visitId: "earliest",
        visitorId: "visitor-1",
        sessionId: "s-earliest",
        startedAt: 1_000,
        regionName: "Bavaria",
        region: "DE::BY::Bavaria",
        cityName: "Munich",
        city: "DE::BY::Bavaria::Munich",
      }),
    ]);

    const result = generateDemoVisitors("site", { limit: 10 });

    expect(result).toMatchObject({
      ok: true,
      data: [
        expect.objectContaining({
          visitorId: "visitor-1",
          firstSeenAt: 1_000,
          lastSeenAt: 3_000,
          views: 2,
          sessions: 2,
          region: "DE::BE::Berlin",
          city: "DE::BE::Berlin::Berlin",
        }),
      ],
      meta: {
        pageSize: 10,
        returned: 1,
        hasMore: false,
        nextCursor: null,
      },
    });
  });

  it("orders tied visitor rows by visitor id after metric, timestamp, and view ties", () => {
    setFacts([
      makeVisit({
        visitId: "visitor-b",
        visitorId: "visitor-b",
        sessionId: "session-b",
        startedAt: 10_000,
      }),
      makeVisit({
        visitId: "visitor-a",
        visitorId: "visitor-a",
        sessionId: "session-a",
        startedAt: 10_000,
      }),
    ]);

    const result = generateDemoVisitors("site", {
      limit: 10,
      sortBy: "views",
      sortDir: "desc",
    });
    const data = result.data as Array<Record<string, unknown>>;

    expect(data.map((row) => row.visitorId)).toEqual([
      "visitor-a",
      "visitor-b",
    ]);
  });

  it("paginates visitors and filters search matches before building rows", () => {
    setFacts([
      makeVisit({
        visitId: "alpha",
        visitorId: "visitor-alpha",
        sessionId: "session-alpha",
        startedAt: 30_000,
        pathname: "/alpha-pricing",
        title: "Alpha Pricing",
      }),
      makeVisit({
        visitId: "beta",
        visitorId: "visitor-beta",
        sessionId: "session-beta",
        startedAt: 20_000,
        pathname: "/beta-docs",
        title: "Beta Docs",
      }),
      makeVisit({
        visitId: "gamma",
        visitorId: "visitor-gamma",
        sessionId: "session-gamma",
        startedAt: 10_000,
        pathname: "/gamma-help",
        title: "Gamma Help",
      }),
    ]);

    expect(
      generateDemoVisitors("site", {
        pageSize: 2,
      }),
    ).toMatchObject({
      meta: {
        pageSize: 2,
        returned: 2,
        hasMore: true,
        nextCursor: "2",
      },
    });

    const searched = generateDemoVisitors("site", {
      pageSize: 2,
      search: "beta-docs",
    }) as {
      data: Array<Record<string, unknown>>;
      meta: Record<string, unknown>;
    };

    expect(searched.data.map((row) => row.visitorId)).toEqual(["visitor-beta"]);
    expect(searched.meta).toMatchObject({
      returned: 1,
      hasMore: false,
      nextCursor: null,
    });
  });

  it("sorts visitor detail sessions newest first and returns null for blank IDs", () => {
    setFacts([
      makeVisit({
        visitId: "older",
        visitorId: "visitor-1",
        sessionId: "older-session",
        startedAt: 1_000,
      }),
      makeVisit({
        visitId: "newer",
        visitorId: "visitor-1",
        sessionId: "newer-session",
        startedAt: 5_000,
      }),
    ]);

    expect(generateDemoVisitorDetail("site", { visitorId: "" })).toEqual({
      ok: true,
      data: null,
    });

    const result = generateDemoVisitorDetail("site", {
      visitorId: "visitor-1",
      timeZone: "UTC",
    }) as { data: { sessions: Array<Record<string, unknown>> } };

    expect(result.data.sessions.map((row) => row.sessionId)).toEqual([
      "newer-session",
      "older-session",
    ]);
  });

  it("returns null session details for blank and missing session IDs", () => {
    setFacts([makeVisit({ sessionId: "known-session" })]);

    expect(generateDemoSessionDetail("site", { sessionId: "" })).toEqual({
      ok: true,
      data: null,
    });
    expect(
      generateDemoSessionDetail("site", { sessionId: "missing-session" }),
    ).toEqual({ ok: true, data: null });
  });

  it("orders tied session rows by session id after numeric and timestamp ties", () => {
    setFacts([
      makeVisit({ visitId: "b", sessionId: "b-session", startedAt: 10_000 }),
      makeVisit({ visitId: "a", sessionId: "a-session", startedAt: 10_000 }),
    ]);

    const result = generateDemoSessions("site", {
      limit: 10,
      sortBy: "views",
      sortDir: "desc",
    });
    const data = result.data as Array<Record<string, unknown>>;

    expect(data.map((row) => row.sessionId)).toEqual([
      "a-session",
      "b-session",
    ]);
  });

  it("paginates sessions and filters session search matches", () => {
    setFacts([
      makeVisit({
        visitId: "alpha",
        sessionId: "session-alpha",
        visitorId: "visitor-alpha",
        startedAt: 30_000,
        pathname: "/alpha-pricing",
        title: "Alpha Pricing",
      }),
      makeVisit({
        visitId: "beta",
        sessionId: "session-beta",
        visitorId: "visitor-beta",
        startedAt: 20_000,
        pathname: "/beta-docs",
        title: "Beta Docs",
      }),
      makeVisit({
        visitId: "gamma",
        sessionId: "session-gamma",
        visitorId: "visitor-gamma",
        startedAt: 10_000,
        pathname: "/gamma-help",
        title: "Gamma Help",
      }),
    ]);

    expect(
      generateDemoSessions("site", {
        pageSize: 2,
      }),
    ).toMatchObject({
      meta: {
        pageSize: 2,
        returned: 2,
        hasMore: true,
        nextCursor: "2",
      },
    });

    const searched = generateDemoSessions("site", {
      pageSize: 2,
      q: "gamma help",
    }) as {
      data: Array<Record<string, unknown>>;
      meta: Record<string, unknown>;
    };

    expect(searched.data.map((row) => row.sessionId)).toEqual([
      "session-gamma",
    ]);
    expect(searched.meta).toMatchObject({
      returned: 1,
      hasMore: false,
      nextCursor: null,
    });
  });
});

function setFacts(visits: DemoVisitFact[]): DemoFactDataset {
  const dataset = makeDataset(visits);
  mockBuildDemoFactDataset.mockReturnValue(dataset);
  mockApplyDemoFilters.mockReturnValue(makeFiltered(visits));
  return dataset;
}

function makeDataset(visits: DemoVisitFact[]): DemoFactDataset {
  const dataset: DemoFactDataset = {
    from: 0,
    to: 3_600_000,
    viewWeight: 1,
    visits,
    sessions: new Map(),
    visitors: new Map(),
  };
  for (const visit of visits) {
    if (!dataset.sessions.has(visit.sessionId)) {
      dataset.sessions.set(visit.sessionId, {
        sessionId: visit.sessionId,
        visitorId: visit.visitorId,
        entryPath: visit.pathname,
        exitPath: visit.pathname,
        weight: 1,
      });
    } else {
      const session = dataset.sessions.get(visit.sessionId);
      if (session) session.exitPath = visit.pathname;
    }
    if (!dataset.visitors.has(visit.visitorId)) {
      dataset.visitors.set(visit.visitorId, {
        visitorId: visit.visitorId,
        weight: 1,
      });
    }
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
    visitId: "visit-1",
    sessionId: "session-1",
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
    regionCode: "CA",
    regionName: "California",
    region: "US::CA::California",
    cityName: "San Francisco",
    city: "US::CA::California::San Francisco",
    continent: "North America",
    timezone: "UTC",
    organization: "Example ISP",
    latitude: 37.7749,
    longitude: -122.4194,
    eventType: "pageview",
    durationMs: 1000,
    ...overrides,
  };
}
