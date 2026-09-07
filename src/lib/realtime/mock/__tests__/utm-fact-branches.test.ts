import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  DEMO_SITE_PROFILES,
  type DemoSiteProfile,
} from "@/lib/realtime/demo-site-profiles";
import type * as FactBuilder from "@/lib/realtime/mock/fact-builder";
import { buildDemoPathTitleMap } from "@/lib/realtime/mock/fact-dataset";
import type {
  DemoFactDataset,
  DemoFilteredFacts,
  DemoVisitFact,
} from "@/lib/realtime/mock/types";
import {
  generateDemoUtmDimension,
  generateDemoUtmTrend,
} from "@/lib/realtime/mock/utm-dimensions";
import {
  generateDemoGeoPoints,
  generateDemoOverviewSourceTab,
} from "@/lib/realtime/mock/utm-overview";

const {
  mockApplyDemoFilters,
  mockBuildDemoFactDataset,
  mockCollectReferrerRows,
} = vi.hoisted(() => ({
  mockApplyDemoFilters: vi.fn(),
  mockBuildDemoFactDataset: vi.fn(),
  mockCollectReferrerRows: vi.fn(),
}));

vi.mock("@/lib/realtime/mock/fact-builder", async () => {
  const actual = await vi.importActual<typeof FactBuilder>(
    "@/lib/realtime/mock/fact-builder",
  );
  return {
    ...actual,
    applyDemoFilters: mockApplyDemoFilters,
    buildDemoFactDataset: mockBuildDemoFactDataset,
    collectReferrerRows: mockCollectReferrerRows,
  };
});

const BASE_TIME = Date.UTC(2026, 0, 5, 12);

describe("mock UTM and fact branch coverage", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(BASE_TIME);
    mockApplyDemoFilters.mockReset();
    mockBuildDemoFactDataset.mockReset();
    mockCollectReferrerRows.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("falls back to a derived title for missing profile title slots", () => {
    const profile: DemoSiteProfile = {
      ...DEMO_SITE_PROFILES[0],
      paths: ["/docs"],
      titles: [],
    };

    const titles = buildDemoPathTitleMap(profile, []);

    expect(titles.get("/docs")).toBe("Docs");
  });

  it("uses the domain slug when campaign labels cannot use a site name", () => {
    const profile: DemoSiteProfile = {
      ...DEMO_SITE_PROFILES[0],
      id: "utm-domain-slug-site",
      name: "!!!",
      domain: "Brand.Example",
      titles: [],
      paths: ["/"],
    };
    DEMO_SITE_PROFILES.push(profile);

    try {
      setFacts(
        Array.from({ length: 20 }, (_, index) =>
          makeVisit({
            visitId: `campaign-${index}`,
            sessionId: `s${index}`,
            visitorId: `u${index}`,
          }),
        ),
      );

      const result = generateDemoUtmDimension(profile.id, "campaign", {
        from: BASE_TIME,
        to: BASE_TIME + 3_600_000,
        limit: 8,
      }) as { data: { items: Array<{ value: string }> } };

      expect(result.data.items.map((row) => row.value)).toEqual(
        expect.arrayContaining([expect.stringMatching(/^brand-example-/)]),
      );
    } finally {
      DEMO_SITE_PROFILES.pop();
    }
  });

  it("builds source, medium, term, and content UTM dimensions from profile pools", () => {
    const profile: DemoSiteProfile = {
      ...DEMO_SITE_PROFILES[0],
      id: "utm-pool-site",
      name: "Pool Site",
      domain: "pool.example",
      paths: ["/", "/pricing-page", "/docs/getting-started"],
      titles: ["Home", "Pricing Comparison", "Automation Guide"],
      topReferrers: [
        { name: "https://www.Search.Example/path", weight: 1 },
        { name: "partner", weight: 0.5 },
        { name: "(direct)", weight: 10 },
        { name: "", weight: 5 },
        { name: "zero.example", weight: 0 },
      ],
    };
    DEMO_SITE_PROFILES.push(profile);

    try {
      setFacts(
        Array.from({ length: 200 }, (_, index) =>
          makeVisit({
            visitId: `utm-${index}`,
            sessionId: `s${index}`,
            visitorId: `u${index}`,
            startedAt: BASE_TIME + index * 1_000,
          }),
        ),
      );

      const source = generateDemoUtmDimension(profile.id, "source", {
        from: BASE_TIME,
        to: BASE_TIME + 3_600_000,
        limit: 12,
      }) as {
        data: {
          items: Array<{ value: string; views: number; sessions: number }>;
        };
      };
      const sourceValues = source.data.items.map((row) => row.value);
      expect(sourceValues).toContain("search");
      expect(sourceValues).not.toContain("(direct)");
      expect(sourceValues).not.toContain("zero");
      expect(source.data.items.every((row) => row.views >= row.sessions)).toBe(
        true,
      );

      const medium = generateDemoUtmDimension(profile.id, "medium", {
        from: BASE_TIME,
        to: BASE_TIME + 3_600_000,
        limit: 6,
      }) as { data: { items: Array<{ value: string }> } };
      expect(medium.data.items.map((row) => row.value)).toEqual(
        expect.arrayContaining([
          expect.stringMatching(
            /^(email|cpc|paid-social|organic-social|referral|affiliate|display|sponsored|community|influencer)$/,
          ),
        ]),
      );

      const term = generateDemoUtmDimension(profile.id, "term", {
        from: BASE_TIME,
        to: BASE_TIME + 3_600_000,
        limit: 10,
      }) as { data: { items: Array<{ value: string }> } };
      expect(term.data.items.map((row) => row.value)).toEqual(
        expect.arrayContaining([
          expect.stringMatching(
            /^(pricing|comparison|automation|guide|brand|template|free-trial|discount)$/,
          ),
        ]),
      );

      const content = generateDemoUtmDimension(profile.id, "content", {
        from: BASE_TIME,
        to: BASE_TIME + 3_600_000,
        limit: 10,
      }) as { data: { items: Array<{ value: string }> } };
      expect(content.data.items.map((row) => row.value)).toEqual(
        expect.arrayContaining([
          expect.stringMatching(
            /(-hero|-cta|hero-a|hero-b|pricing-card|email-1|email-2)$/,
          ),
        ]),
      );
    } finally {
      DEMO_SITE_PROFILES.pop();
    }
  });

  it("returns empty UTM payloads for empty facts and invalid trend dimensions", () => {
    setFacts([]);

    expect(
      generateDemoUtmDimension("demo-site-001", "source", {
        from: BASE_TIME,
        to: BASE_TIME + 3_600_000,
      }),
    ).toMatchObject({
      ok: true,
      data: { items: [], pagination: expect.any(Object) },
    });
    expect(
      generateDemoUtmTrend("demo-site-001", {
        dimension: "unknown",
        interval: "minute",
      }),
    ).toEqual({
      ok: true,
      interval: "minute",
      series: [],
      data: [],
    });
    expect(
      generateDemoUtmTrend("demo-site-001", {
        dimension: "source",
        from: BASE_TIME,
        to: BASE_TIME + 3_600_000,
      }),
    ).toEqual({
      ok: true,
      interval: "day",
      series: [],
      data: [],
    });
  });

  it("builds UTM trend series with Other and preserves bucket visitor totals", () => {
    setFacts(
      Array.from({ length: 120 }, (_, index) =>
        makeVisit({
          visitId: `trend-${index}`,
          sessionId: `s${index}`,
          visitorId: `u${index}`,
          startedAt: BASE_TIME + (index % 3) * 3_600_000 + index,
        }),
      ),
    );

    const result = generateDemoUtmTrend("demo-site-001", {
      dimension: "campaign",
      from: BASE_TIME,
      to: BASE_TIME + 2 * 3_600_000,
      interval: "hour",
      limit: 1,
      timeZone: "UTC",
    }) as {
      series: Array<{ key: string; label: string; isOther?: boolean }>;
      data: Array<{
        totalVisitors: number;
        visitorsBySeries: Record<string, number>;
      }>;
    };

    expect(result.series).toEqual([
      expect.not.objectContaining({ isOther: expect.anything() }),
      expect.objectContaining({ key: "other", label: "Other", isOther: true }),
    ]);
    for (const point of result.data) {
      expect(Object.keys(point.visitorsBySeries).sort()).toEqual(
        result.series.map((series) => series.key).sort(),
      );
      expect(
        Object.values(point.visitorsBySeries).reduce(
          (sum, value) => sum + value,
          0,
        ),
      ).toBe(point.totalVisitors);
    }
  });

  it("skips blank region and city buckets while still returning country counts", () => {
    setFacts([
      makeVisit({
        visitId: "no-region",
        region: "",
        city: "",
      }),
    ]);

    const result = generateDemoGeoPoints("demo-site-001", {
      from: BASE_TIME,
      to: BASE_TIME + 3_600_000,
      applyGeoFilter: "true",
      geo: "US",
    }) as {
      countryCounts: Array<{ country: string }>;
      regionCounts: unknown[];
      cityCounts: unknown[];
    };

    expect(result.countryCounts).toEqual([
      expect.objectContaining({ country: "US" }),
    ]);
    expect(result.regionCounts).toEqual([]);
    expect(result.cityCounts).toEqual([]);
  });

  it("normalizes nullish referrer rows in overview source tabs", () => {
    setFacts([makeVisit()]);
    mockCollectReferrerRows.mockReturnValue([
      { referrer: null, views: null, sessions: null, visitors: null },
    ]);

    expect(
      generateDemoOverviewSourceTab("demo-site-001", {}, "domain"),
    ).toEqual({
      ok: true,
      data: [{ label: "", views: 0, sessions: 0, visitors: 0 }],
    });
  });

  it("generates channel rows in overview source tabs", () => {
    setFacts([
      makeVisit({ referrerHost: "google.com" }),
      makeVisit({
        visitId: "visit-2",
        sessionId: "s2",
        visitorId: "u2",
        referrerHost: "facebook.com",
      }),
      makeVisit({
        visitId: "visit-3",
        sessionId: "s3",
        visitorId: "u3",
      }),
    ]);

    expect(
      generateDemoOverviewSourceTab("demo-site-001", {}, "channel"),
    ).toEqual({
      ok: true,
      data: [
        { label: "direct", views: 1, sessions: 1, visitors: 1 },
        { label: "organic_search", views: 1, sessions: 1, visitors: 1 },
        { label: "social", views: 1, sessions: 1, visitors: 1 },
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
    to: BASE_TIME + 3_600_000,
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
