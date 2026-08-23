import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  generateDemoBrowserCrossBreakdown,
  generateDemoBrowserRadar,
  generateDemoBrowserVersionBreakdown,
  generateDemoClientCrossBreakdown,
  generateDemoReferrerRadar,
} from "@/lib/realtime/mock/browser-client";
import type * as FactBuilder from "@/lib/realtime/mock/fact-builder";
import type {
  DemoFactDataset,
  DemoFilteredFacts,
  DemoVisitFact,
} from "@/lib/realtime/mock/types";

const {
  mockAggregateDimensionRowsFromVisits,
  mockApplyDemoFilters,
  mockBuildDemoFactDataset,
  mockCollectReferrerRows,
} = vi.hoisted(() => ({
  mockAggregateDimensionRowsFromVisits: vi.fn(),
  mockApplyDemoFilters: vi.fn(),
  mockBuildDemoFactDataset: vi.fn(),
  mockCollectReferrerRows: vi.fn(),
}));

vi.mock("@/lib/realtime/mock/fact-builder", async () => {
  const actual = await vi.importActual<typeof FactBuilder>(
    "@/lib/realtime/mock/fact-builder",
  );
  mockAggregateDimensionRowsFromVisits.mockImplementation(
    actual.aggregateDimensionRowsFromVisits,
  );
  mockCollectReferrerRows.mockImplementation(actual.collectReferrerRows);
  return {
    ...actual,
    aggregateDimensionRowsFromVisits: mockAggregateDimensionRowsFromVisits,
    applyDemoFilters: mockApplyDemoFilters,
    buildDemoFactDataset: mockBuildDemoFactDataset,
    collectReferrerRows: mockCollectReferrerRows,
  };
});

const SITE_ID = "demo-site-001";
const BASE_TIME = Date.UTC(2026, 0, 5, 12);

describe("browser-client mock coverage", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(BASE_TIME);
    mockAggregateDimensionRowsFromVisits.mockClear();
    mockApplyDemoFilters.mockReset();
    mockBuildDemoFactDataset.mockReset();
    mockCollectReferrerRows.mockClear();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns empty breakdowns for empty facts and invalid client dimensions", () => {
    setFacts([]);

    expect(generateDemoBrowserVersionBreakdown(SITE_ID, {})).toEqual({
      ok: true,
      data: [],
    });
    expect(
      generateDemoBrowserCrossBreakdown(SITE_ID, {
        browserLimit: "bad",
        osLimit: 0,
        deviceTypeLimit: 99,
      }),
    ).toEqual({
      ok: true,
      operatingSystem: { columns: [], rows: [], totalVisitors: 0 },
      deviceType: { columns: [], rows: [], totalVisitors: 0 },
    });
    expect(
      generateDemoClientCrossBreakdown(SITE_ID, {
        primaryDimension: "unknown",
        secondaryDimension: "deviceType",
      }),
    ).toEqual({
      ok: true,
      data: { columns: [], rows: [], totalVisitors: 0 },
    });
  });

  it("groups browser breakdown unknown, other, and fallback buckets", () => {
    setFacts([
      makeVisit({
        visitId: "chrome-windows-138",
        sessionId: "s1",
        visitorId: "u1",
        browser: "Chrome",
        browserVersion: "138",
        osVersion: "Windows 11",
        deviceType: "Desktop",
      }),
      makeVisit({
        visitId: "chrome-windows-137",
        sessionId: "s2",
        visitorId: "u2",
        browser: "Chrome",
        browserVersion: "137",
        osVersion: "Windows 10",
        deviceType: "Desktop",
      }),
      makeVisit({
        visitId: "chrome-unknown-version",
        sessionId: "s3",
        visitorId: "u3",
        browser: "Chrome",
        browserVersion: "",
        osVersion: "",
        deviceType: "Mobile",
      }),
      makeVisit({
        visitId: "safari-ios",
        sessionId: "s4",
        visitorId: "u4",
        browser: "Safari",
        browserVersion: "18",
        osVersion: "iOS 18",
        deviceType: "Mobile",
      }),
      makeVisit({
        visitId: "firefox-linux",
        sessionId: "s5",
        visitorId: "u5",
        browser: "Firefox",
        browserVersion: "140",
        osVersion: "Linux",
        deviceType: "Tablet",
      }),
    ]);

    const versions = generateDemoBrowserVersionBreakdown(SITE_ID, {
      browserLimit: 1,
      versionLimit: 2,
    }) as {
      data: Array<{
        browser: string;
        versions: Array<{ key: string; label: string; isOther?: boolean }>;
      }>;
    };

    expect(versions.data).toEqual([
      expect.objectContaining({
        browser: "Chrome",
        versions: expect.arrayContaining([
          expect.objectContaining({ key: "unknown", label: "Unknown" }),
          expect.objectContaining({
            key: "other",
            label: "Other",
            isOther: true,
          }),
        ]),
      }),
    ]);

    const cross = generateDemoBrowserCrossBreakdown(SITE_ID, {
      browserLimit: 1,
      osLimit: 2,
      deviceTypeLimit: 1,
    }) as {
      operatingSystem: {
        columns: Array<{ key: string; isOther?: boolean; isUnknown?: boolean }>;
        rows: Array<{
          key: string;
          isOther?: boolean;
          cells: Array<{ key: string; isOther?: boolean; isUnknown?: boolean }>;
        }>;
      };
      deviceType: {
        columns: Array<{ key: string; isOther?: boolean }>;
        rows: Array<{ key: string; isOther?: boolean }>;
      };
    };

    expect(cross.operatingSystem.columns).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ key: "unknown", isUnknown: true }),
        expect.objectContaining({ key: "other", isOther: true }),
      ]),
    );
    expect(cross.operatingSystem.rows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ key: "chrome" }),
        expect.objectContaining({ key: "other", isOther: true }),
      ]),
    );
    expect(cross.operatingSystem.rows[0].cells).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ key: "unknown", isUnknown: true }),
        expect.objectContaining({ key: "other", isOther: true }),
      ]),
    );
    expect(cross.deviceType.columns).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ key: "other", isOther: true }),
      ]),
    );
    expect(cross.deviceType.rows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ key: "other", isOther: true }),
      ]),
    );
  });

  it("returns empty cross dimensions when dimension aggregation has no visitor rows", () => {
    const visits = [
      makeVisit({
        visitId: "chrome-empty-dimension",
        browser: "Chrome",
        osVersion: "",
        deviceType: "",
      }),
    ];
    setFacts(visits);
    mockAggregateDimensionRowsFromVisits
      .mockImplementationOnce(() => [
        { label: "Chrome", views: 1, sessions: 1, visitors: 1 },
      ])
      .mockImplementationOnce(() => [])
      .mockImplementationOnce(() => [
        { label: "Chrome", views: 1, sessions: 1, visitors: 1 },
      ])
      .mockImplementationOnce(() => []);

    expect(generateDemoBrowserCrossBreakdown(SITE_ID, {})).toEqual({
      ok: true,
      operatingSystem: { columns: [], rows: [], totalVisitors: 0 },
      deviceType: { columns: [], rows: [], totalVisitors: 0 },
    });
  });

  it("builds client dimension combinations for browser, OS version, device, language, and screen fallbacks", () => {
    setFacts([
      makeVisit({
        visitId: "chrome-windows",
        sessionId: "s1",
        visitorId: "u1",
        browser: "Chrome",
        osVersion: "Windows 11",
        deviceType: "Desktop",
        language: "en-US",
        screenSize: "1920x1080",
      }),
      makeVisit({
        visitId: "chrome-sparse",
        sessionId: "s2",
        visitorId: "u2",
        browser: "Chrome",
        osVersion: "",
        deviceType: "Mobile",
        language: "",
        screenSize: "",
      }),
      makeVisit({
        visitId: "safari-ios",
        sessionId: "s3",
        visitorId: "u3",
        browser: "Safari",
        osVersion: "iOS 18",
        deviceType: "Mobile",
        language: "de-DE",
        screenSize: "390x844",
      }),
      makeVisit({
        visitId: "firefox-linux",
        sessionId: "s4",
        visitorId: "u4",
        browser: "Firefox",
        osVersion: "Linux",
        deviceType: "Tablet",
        language: "fr-FR",
        screenSize: "1536x864",
      }),
    ]);

    const osVersionCross = generateDemoClientCrossBreakdown(SITE_ID, {
      primaryDimension: "browser",
      secondaryDimension: "osVersion",
      primaryLimit: 1,
      secondaryLimit: 2,
    }) as {
      data: {
        columns: Array<{ key: string; isOther?: boolean; isUnknown?: boolean }>;
        rows: Array<{ key: string; isOther?: boolean }>;
      };
    };

    expect(osVersionCross.data.columns).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ key: "unknown", isUnknown: true }),
        expect.objectContaining({ key: "other", isOther: true }),
      ]),
    );
    expect(osVersionCross.data.rows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ key: "chrome" }),
        expect.objectContaining({ key: "other", isOther: true }),
      ]),
    );

    const languageCross = generateDemoClientCrossBreakdown(SITE_ID, {
      primaryDimension: "deviceType",
      secondaryDimension: "language",
      primaryLimit: 1,
      secondaryLimit: 2,
    }) as {
      data: {
        columns: Array<{ key: string; isOther?: boolean; isUnknown?: boolean }>;
        rows: Array<{ key: string; isOther?: boolean }>;
      };
    };

    expect(languageCross.data.columns).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ key: "unknown", isUnknown: true }),
        expect.objectContaining({ key: "other", isOther: true }),
      ]),
    );
    expect(languageCross.data.rows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ key: "mobile" }),
        expect.objectContaining({ key: "other", isOther: true }),
      ]),
    );

    const screenCross = generateDemoClientCrossBreakdown(SITE_ID, {
      primaryDimension: "screenSize",
      secondaryDimension: "operatingSystem",
      primaryLimit: 1,
      secondaryLimit: 1,
    }) as {
      data: {
        columns: Array<{ key: string; isOther?: boolean }>;
        rows: Array<{ key: string; isOther?: boolean }>;
      };
    };

    expect(screenCross.data.columns).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ key: "other", isOther: true }),
      ]),
    );
    expect(screenCross.data.rows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ key: "other", isOther: true }),
      ]),
    );
  });

  it("uses radar metric fallbacks for empty and single-session visitor sets", () => {
    const visits = [
      makeVisit({
        visitId: "weighted-chrome",
        sessionId: "s1",
        visitorId: "u1",
        browser: "Chrome",
        referrerHost: "search.example",
        durationMs: -100,
      }),
    ];
    setFacts(visits);

    expect(generateDemoBrowserRadar(SITE_ID, {})).toMatchObject({
      ok: true,
      data: [
        expect.objectContaining({
          browser: "Chrome",
          sessions: 1,
          metrics: expect.objectContaining({
            duration: 0,
            engagement: 0,
            depth: 1,
            loyalty: 0,
            frequency: expect.any(Number),
            traffic: 1,
          }),
        }),
      ],
    });
    expect(
      generateDemoReferrerRadar(SITE_ID, { limit: "other" }),
    ).toMatchObject({
      ok: true,
      data: [
        expect.objectContaining({
          referrer: "search.example",
          sessions: 1,
          metrics: expect.objectContaining({
            duration: 0,
            engagement: 0,
            depth: 1,
            loyalty: 0,
            frequency: expect.any(Number),
            traffic: 1,
          }),
        }),
      ],
    });

    mockApplyDemoFilters.mockReturnValue({
      visits: [],
      sessions: new Set(),
      visitors: new Set(),
      visitsBySession: new Map(),
    });

    expect(generateDemoBrowserRadar(SITE_ID, {})).toEqual({
      ok: true,
      data: [],
    });
    expect(generateDemoReferrerRadar(SITE_ID, {})).toEqual({
      ok: true,
      data: [],
    });
  });

  it("covers browser radar zero-aggregation metrics, global frequency fallback, and blank labels", () => {
    const paddedBrowserVisit = makeVisit({
      visitId: "padded-browser",
      sessionId: "s1",
      visitorId: "u1",
      browser: " Chrome ",
      durationMs: 5000,
    });
    setFacts([paddedBrowserVisit]);
    mockApplyDemoFilters.mockReturnValue({
      visits: [paddedBrowserVisit],
      sessions: new Set(["s1", "s2"]),
      visitors: new Set(),
      visitsBySession: new Map([["s1", 1]]),
    });

    expect(generateDemoBrowserRadar(SITE_ID, {})).toMatchObject({
      ok: true,
      data: [
        expect.objectContaining({
          browser: "Chrome",
          metrics: expect.objectContaining({
            duration: 0,
            engagement: 0,
            depth: 0,
            loyalty: 0,
            frequency: demoRadarFrequency("Chrome"),
            traffic: 1,
          }),
        }),
      ],
    });

    setFacts([
      makeVisit({ visitId: "empty-browser", browser: "" }),
      makeVisit({
        visitId: "blank-browser",
        sessionId: "s2",
        visitorId: "u2",
        browser: "   ",
      }),
    ]);

    expect(generateDemoBrowserRadar(SITE_ID, {})).toEqual({
      ok: true,
      data: [],
    });
  });

  it("covers referrer radar zero-aggregation metrics, global frequency fallback, and blank labels", () => {
    const unmatchedVisit = makeVisit({
      visitId: "unmatched-referrer",
      sessionId: "s1",
      visitorId: "u1",
      referrerHost: "other.example",
      durationMs: 5000,
    });
    setFacts([unmatchedVisit]);
    mockApplyDemoFilters.mockReturnValue({
      visits: [unmatchedVisit],
      sessions: new Set(["s1", "s2"]),
      visitors: new Set(),
      visitsBySession: new Map([["s1", 1]]),
    });
    mockCollectReferrerRows.mockImplementationOnce(() => [
      {
        referrer: "search.example",
        views: 1,
        sessions: 1,
        visitors: 1,
      },
    ]);

    expect(generateDemoReferrerRadar(SITE_ID, {})).toMatchObject({
      ok: true,
      data: [
        expect.objectContaining({
          referrer: "search.example",
          metrics: expect.objectContaining({
            duration: 0,
            engagement: 0,
            depth: 0,
            loyalty: 0,
            frequency: demoRadarFrequency("search.example"),
            traffic: 1,
          }),
        }),
      ],
    });

    setFacts([
      makeVisit({ visitId: "empty-referrer", referrerHost: "" }),
      makeVisit({
        visitId: "blank-referrer",
        sessionId: "s2",
        visitorId: "u2",
        referrerHost: "   ",
      }),
    ]);

    expect(generateDemoReferrerRadar(SITE_ID, {})).toMatchObject({
      ok: true,
      data: [
        expect.objectContaining({
          referrer: "",
          metrics: expect.objectContaining({
            duration: 1000,
            engagement: 0,
            depth: 1,
            loyalty: 0,
            frequency: 0.75,
            traffic: 1,
          }),
        }),
      ],
    });
  });

  it("keeps radar traffic at zero when mocked dimension totals collapse to zero", () => {
    setFacts([
      makeVisit({
        visitId: "traffic-browser",
        browser: "Chrome",
        referrerHost: "search.example",
      }),
    ]);
    mockAggregateDimensionRowsFromVisits.mockImplementationOnce(() => [
      {
        label: "Chrome",
        views: 1,
        sessions: 1,
        visitors: positiveForFilterThenZero(),
      },
    ]);

    expect(generateDemoBrowserRadar(SITE_ID, {})).toMatchObject({
      ok: true,
      data: [
        expect.objectContaining({
          browser: "Chrome",
          metrics: expect.objectContaining({ traffic: 0 }),
        }),
      ],
    });

    mockCollectReferrerRows.mockImplementationOnce(() => [
      {
        referrer: "search.example",
        views: 1,
        sessions: 1,
        visitors: positiveForFilterThenZero(),
      },
    ]);

    expect(generateDemoReferrerRadar(SITE_ID, {})).toMatchObject({
      ok: true,
      data: [
        expect.objectContaining({
          referrer: "search.example",
          metrics: expect.objectContaining({ traffic: 0 }),
        }),
      ],
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
    if (!dataset.sessions.has(visit.sessionId)) {
      dataset.sessions.set(visit.sessionId, {
        sessionId: visit.sessionId,
        visitorId: visit.visitorId,
        entryPath: visit.pathname,
        exitPath: visit.pathname,
        weight: 1,
      });
    } else {
      dataset.sessions.get(visit.sessionId)!.exitPath = visit.pathname;
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

function demoRadarFrequency(label: string): number {
  let nameHash = 0;
  for (let index = 0; index < label.length; index += 1) {
    nameHash = ((nameHash << 5) - nameHash + label.charCodeAt(index)) | 0;
  }
  return 0.75 + (Math.abs(nameHash) % 100) / 200;
}

function positiveForFilterThenZero(): number {
  let calls = 0;
  return {
    valueOf: () => {
      calls += 1;
      return calls === 1 ? 1 : 0;
    },
  } as unknown as number;
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
