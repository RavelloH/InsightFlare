import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  generateDemoDimension,
  generateDemoPages,
  generateDemoPagesDashboard,
  generateDemoReferrers,
} from "@/lib/realtime/mock/analytics-pages";
import type * as FactBuilder from "@/lib/realtime/mock/fact-builder";
import {
  generateDemoBrowserEngineTrend,
  generateDemoBrowserTrend,
  generateDemoClientDimensionTrend,
  generateDemoReferrerTrend,
} from "@/lib/realtime/mock/share-trends";
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
    applyDemoFilters: mockApplyDemoFilters,
    buildDemoFactDataset: mockBuildDemoFactDataset,
  };
});

const BASE_TIME = Date.UTC(2026, 0, 1, 0, 0, 0);
const SITE_ID = "demo-site-001";

describe("mock/share-trends branch coverage", () => {
  beforeEach(() => {
    mockApplyDemoFilters.mockReset();
    mockBuildDemoFactDataset.mockReset();
  });

  it("groups top browser labels, blank labels, and overflow labels into trend series", () => {
    const visits = [
      makeVisit({
        visitId: "chrome-a",
        sessionId: "s1",
        visitorId: "u1",
        browser: "Chrome",
        startedAt: BASE_TIME + 1_000,
      }),
      makeVisit({
        visitId: "chrome-b",
        sessionId: "s2",
        visitorId: "u2",
        browser: "Chrome",
        startedAt: BASE_TIME + 3_600_000 + 1_000,
      }),
      makeVisit({
        visitId: "safari",
        sessionId: "s3",
        visitorId: "u3",
        browser: "Safari",
        startedAt: BASE_TIME + 3_600_000 + 2_000,
      }),
      makeVisit({
        visitId: "blank",
        sessionId: "s4",
        visitorId: "u4",
        browser: "   ",
        startedAt: BASE_TIME + 2_000,
      }),
    ];
    const dataset = setFacts(visits);
    dataset.sessions.get("s1")!.weight = 2;
    dataset.sessions.get("s2")!.weight = 3;
    dataset.sessions.get("s3")!.weight = 5;
    dataset.visitors.get("u1")!.weight = 7;
    dataset.visitors.get("u2")!.weight = 11;
    dataset.visitors.get("u3")!.weight = 13;
    dataset.visitors.get("u4")!.weight = 17;

    const result = generateDemoBrowserTrend(SITE_ID, {
      from: BASE_TIME,
      to: BASE_TIME + 2 * 3_600_000,
      interval: "hour",
      limit: 1,
      timeZone: "UTC",
    });

    expect(result).toMatchObject({
      ok: true,
      interval: "hour",
      series: [
        {
          key: "chrome",
          label: "Chrome",
          views: 2,
          visitors: 18,
          sessions: 5,
        },
        {
          key: "other",
          label: "Other",
          views: 2,
          visitors: 30,
          sessions: 6,
          isOther: true,
        },
      ],
    });
    expect(result.data).toEqual([
      {
        bucket: 0,
        timestampMs: BASE_TIME,
        totalVisitors: 24,
        visitorsBySeries: { chrome: 7, other: 17 },
      },
      {
        bucket: 1,
        timestampMs: BASE_TIME + 3_600_000,
        totalVisitors: 24,
        visitorsBySeries: { chrome: 11, other: 13 },
      },
      {
        bucket: 2,
        timestampMs: BASE_TIME + 2 * 3_600_000,
        totalVisitors: 0,
        visitorsBySeries: { chrome: 0, other: 0 },
      },
    ]);
  });

  it("returns empty trend payloads for invalid dimensions and empty filtered visits", () => {
    setFacts([]);

    expect(
      generateDemoClientDimensionTrend(SITE_ID, {
        dimension: "not-a-dimension",
        interval: "nonsense",
      }),
    ).toEqual({
      ok: true,
      interval: "day",
      series: [],
      data: [],
    });
    expect(
      generateDemoReferrerTrend(SITE_ID, {
        from: BASE_TIME,
        to: BASE_TIME + 3_600_000,
        interval: "hour",
      }),
    ).toEqual({
      ok: true,
      interval: "hour",
      series: [],
      data: [],
    });
  });

  it("builds referrer, browser engine, and client dimension trends from label fallbacks", () => {
    setFacts([
      makeVisit({
        visitId: "direct",
        sessionId: "s1",
        visitorId: "u1",
        referrerHost: "",
        browser: "Safari",
        osVersion: "iOS 18",
        screenSize: "390x844",
      }),
      makeVisit({
        visitId: "search",
        sessionId: "s2",
        visitorId: "u2",
        startedAt: BASE_TIME + 1_000,
        referrerHost: "search.example",
        browser: "Chrome",
        osVersion: "Windows 11",
        screenSize: "1920x1080",
      }),
    ]);

    const trendWindow = {
      from: BASE_TIME,
      to: BASE_TIME + 3_600_000,
      interval: "hour",
      timeZone: "UTC",
      limit: 5,
    };

    expect(generateDemoReferrerTrend(SITE_ID, trendWindow)).toMatchObject({
      ok: true,
      series: expect.arrayContaining([
        expect.objectContaining({ label: "__direct__" }),
        expect.objectContaining({ label: "search.example" }),
      ]),
    });
    expect(generateDemoBrowserEngineTrend(SITE_ID, trendWindow)).toMatchObject({
      ok: true,
      series: expect.arrayContaining([
        expect.objectContaining({ label: "WebKit" }),
        expect.objectContaining({ label: "Blink" }),
      ]),
    });
    expect(
      generateDemoClientDimensionTrend(SITE_ID, {
        ...trendWindow,
        dimension: "screenSize",
      }),
    ).toMatchObject({
      ok: true,
      series: expect.arrayContaining([
        expect.objectContaining({ label: "390x844" }),
        expect.objectContaining({ label: "1920x1080" }),
      ]),
    });
  });
});

describe("mock/analytics-pages branch coverage", () => {
  beforeEach(() => {
    mockApplyDemoFilters.mockReset();
    mockBuildDemoFactDataset.mockReset();
  });

  it("builds pages, referrers, and typed dimensions including empty query/hash values", () => {
    setFacts([
      makeVisit({
        visitId: "home",
        sessionId: "s1",
        visitorId: "u1",
        pathname: "/",
        title: "Home",
        referrerHost: "",
        referrerUrl: "",
        eventType: "pageview",
      }),
      makeVisit({
        visitId: "pricing",
        sessionId: "s2",
        visitorId: "u2",
        startedAt: BASE_TIME + 1_000,
        pathname: "/pricing",
        title: "Pricing",
        referrerHost: "search.example",
        referrerUrl: "https://search.example/result",
        eventType: "signup",
        country: "DE",
        deviceType: "Mobile",
      }),
    ]);

    expect(generateDemoPages(SITE_ID, { limit: 10 })).toMatchObject({
      ok: true,
      data: {
        items: expect.arrayContaining([
          { pathname: "/", views: 1, sessions: 1 },
          { pathname: "/pricing", views: 1, sessions: 1 },
        ]),
      },
      tabs: {
        path: expect.any(Array),
        title: expect.any(Array),
        hostname: expect.any(Array),
        entry: expect.any(Array),
        exit: expect.any(Array),
      },
    });
    expect(generateDemoReferrers(SITE_ID, { limit: 10 })).toEqual({
      ok: true,
      data: {
        items: [
          { referrer: "(direct)", views: 1, sessions: 1, visitors: 1 },
          { referrer: "search.example", views: 1, sessions: 1, visitors: 1 },
        ],
        pagination: {
          limit: 10,
          returned: 2,
          hasMore: false,
          nextCursor: null,
        },
      },
    });
    expect(
      generateDemoDimension(SITE_ID, "countries", { geo: "US" }),
    ).toMatchObject({
      ok: true,
      data: {
        items: expect.arrayContaining([
          { value: "US", views: 1, sessions: 1, visitors: 1 },
          { value: "DE", views: 1, sessions: 1, visitors: 1 },
        ]),
      },
    });
    expect(generateDemoDimension(SITE_ID, "devices", {})).toMatchObject({
      ok: true,
      data: {
        items: expect.arrayContaining([
          { value: "Desktop", views: 1, sessions: 1, visitors: 1 },
          { value: "Mobile", views: 1, sessions: 1, visitors: 1 },
        ]),
      },
    });
    expect(generateDemoDimension(SITE_ID, "event-types", {})).toEqual({
      ok: true,
      data: {
        items: [{ value: "signup", views: 1, sessions: 1, visitors: 1 }],
        pagination: {
          limit: 20,
          returned: 1,
          hasMore: false,
          nextCursor: null,
        },
      },
    });

    const queryDimension = generateDemoDimension(SITE_ID, "page-query", {}) as {
      data: { items: Array<{ value: string }> };
    };
    expect(queryDimension.data.items).toContainEqual(
      expect.objectContaining({ value: "" }),
    );

    const hashDimension = generateDemoDimension(SITE_ID, "page-hash", {}) as {
      data: { items: Array<{ value: string }> };
    };
    expect(hashDimension.data.items).toContainEqual(
      expect.objectContaining({ value: "" }),
    );
    expect(generateDemoDimension(SITE_ID, "unknown", {})).toEqual({
      ok: true,
      data: {
        items: [],
        pagination: {
          limit: 20,
          returned: 0,
          hasMore: false,
          nextCursor: null,
        },
      },
    });
  });

  it("paginates page dashboards and reports previous-window changes", () => {
    const currentVisits = [
      makeVisit({
        visitId: "home-a",
        sessionId: "s1",
        visitorId: "u1",
        pathname: "/home",
        title: "Home",
        durationMs: 1_000,
      }),
      makeVisit({
        visitId: "home-b",
        sessionId: "s1",
        visitorId: "u1",
        startedAt: BASE_TIME + 1_000,
        pathname: "/home",
        title: "Homepage",
        durationMs: 3_000,
      }),
      makeVisit({
        visitId: "pricing",
        sessionId: "s2",
        visitorId: "u2",
        startedAt: BASE_TIME + 2_000,
        pathname: "/pricing",
        title: "Pricing",
        durationMs: 5_000,
      }),
    ];
    const previousVisits = [
      makeVisit({
        visitId: "previous-home",
        sessionId: "old-s1",
        visitorId: "old-u1",
        startedAt: BASE_TIME - 3_600_000,
        pathname: "/home",
        title: "Home",
        durationMs: 2_000,
      }),
    ];
    const currentDataset = makeDataset(currentVisits);
    const previousDataset = makeDataset(previousVisits);
    mockBuildDemoFactDataset
      .mockReturnValueOnce(currentDataset)
      .mockReturnValueOnce(previousDataset)
      .mockReturnValue(currentDataset);
    mockApplyDemoFilters.mockImplementation(
      (dataset: DemoFactDataset, filters: { path?: string }) => {
        const visits = filters.path
          ? dataset.visits.filter((visit) => visit.pathname === filters.path)
          : dataset.visits;
        return makeFiltered(visits);
      },
    );

    const result = generateDemoPagesDashboard(SITE_ID, {
      from: BASE_TIME,
      to: BASE_TIME + 3_600_000,
      interval: "hour",
      limit: 1,
      timeZone: "UTC",
    });

    expect(result).toMatchObject({
      ok: true,
      interval: "hour",
      data: {
        items: [
          expect.objectContaining({
            pathname: "/home",
            titles: ["Home", "Homepage"],
            trend: expect.arrayContaining([
              { timestampMs: BASE_TIME, views: 2, visitors: 1 },
            ]),
            metrics: expect.objectContaining({
              views: 2,
              visitors: 1,
              sessions: 1,
              pagesPerSession: 2,
              avgDurationMs: 4000,
            }),
            changeRates: expect.objectContaining({
              views: 100,
              visitors: 0,
              sessions: 0,
              pagesPerSession: 100,
            }),
          }),
        ],
        pagination: {
          limit: 1,
          returned: 1,
          hasMore: true,
          nextCursor: expect.any(String),
        },
      },
    });
  });

  it("returns zero pages per session when a page has views but no weighted sessions", () => {
    const currentVisits = [
      makeVisit({ visitId: "zero-session", pathname: "/zero", title: "Zero" }),
    ];
    const currentDataset = makeDataset(currentVisits);
    // Give the only session a zero weight so weightedSessionCount returns 0
    // while views remain > 0 — this exercises the else branch of
    // pagesPerSession (`sessions > 0 ? views / sessions : 0`).
    currentDataset.sessions.get("s1")!.weight = 0;
    mockBuildDemoFactDataset.mockReturnValue(currentDataset);
    mockApplyDemoFilters.mockImplementation(
      (dataset: DemoFactDataset, filters: { path?: string }) => {
        const visits = filters.path
          ? dataset.visits.filter((visit) => visit.pathname === filters.path)
          : dataset.visits;
        return makeFiltered(visits);
      },
    );

    expect(
      generateDemoPagesDashboard(SITE_ID, {
        from: BASE_TIME,
        to: BASE_TIME,
        interval: "hour",
        limit: 12,
        timeZone: "UTC",
      }),
    ).toMatchObject({
      ok: true,
      data: {
        items: [
          expect.objectContaining({
            pathname: "/zero",
            metrics: expect.objectContaining({
              views: 1,
              sessions: 0,
              pagesPerSession: 0,
            }),
          }),
        ],
      },
    });
  });

  it("returns null dashboard change rates when the previous window has no rows", () => {
    const currentVisits = [
      makeVisit({ visitId: "only", pathname: "/only", title: "Only" }),
    ];
    const currentDataset = makeDataset(currentVisits);
    const previousDataset = makeDataset([]);
    mockBuildDemoFactDataset
      .mockReturnValueOnce(currentDataset)
      .mockReturnValueOnce(previousDataset)
      .mockReturnValue(currentDataset);
    mockApplyDemoFilters.mockImplementation(
      (dataset: DemoFactDataset, filters: { path?: string }) => {
        const visits = filters.path
          ? dataset.visits.filter((visit) => visit.pathname === filters.path)
          : dataset.visits;
        return makeFiltered(visits);
      },
    );

    expect(
      generateDemoPagesDashboard(SITE_ID, {
        from: BASE_TIME,
        to: BASE_TIME,
      }),
    ).toMatchObject({
      ok: true,
      data: {
        items: [
          {
            changeRates: {
              views: null,
              visitors: null,
              sessions: null,
              bounceRate: null,
              pagesPerSession: null,
              avgDurationMs: null,
            },
          },
        ],
      },
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
    from: BASE_TIME,
    to: BASE_TIME + 2 * 3_600_000,
    viewWeight: 1,
    visits,
    sessions: new Map(),
    visitors: new Map(),
  };
  for (const visit of visits) {
    const session = dataset.sessions.get(visit.sessionId);
    if (session) {
      session.exitPath = visit.pathname;
    } else {
      dataset.sessions.set(visit.sessionId, {
        sessionId: visit.sessionId,
        visitorId: visit.visitorId,
        entryPath: visit.pathname,
        exitPath: visit.pathname,
        weight: 1,
      });
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
    sessionId: "s1",
    visitorId: "u1",
    startedAt: BASE_TIME,
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
    timezone: "America/Los_Angeles",
    organization: "Example ISP",
    latitude: 37.7749,
    longitude: -122.4194,
    eventType: "pageview",
    durationMs: 1000,
    ...overrides,
  };
}
