import { describe, expect, it, vi } from "vitest";

import { generateDemoRetention } from "@/lib/realtime/mock/analytics-retention";
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

describe("mock/analytics-retention coverage", () => {
  it("builds retention cohorts from first visitor bucket and weighted visitors", () => {
    const visits = [
      makeVisit({ visitId: "u1-a", visitorId: "u1", startedAt: 1_000 }),
      makeVisit({
        visitId: "u1-b",
        visitorId: "u1",
        sessionId: "s2",
        startedAt: 3_600_000 + 1_000,
      }),
      makeVisit({
        visitId: "u2-a",
        visitorId: "u2",
        sessionId: "s3",
        startedAt: 3_600_000 + 2_000,
      }),
      makeVisit({
        visitId: "blank",
        visitorId: "   ",
        sessionId: "s4",
        startedAt: 2_000,
      }),
    ];
    const dataset = makeDataset(visits);
    dataset.visitors.get("u1")!.weight = 2;
    dataset.visitors.get("u2")!.weight = 3;
    mockBuildDemoFactDataset.mockReturnValue(dataset);
    mockApplyDemoFilters.mockReturnValue(makeFiltered(visits));

    expect(
      generateDemoRetention("site", {
        from: 0,
        to: 2 * 3_600_000,
        granularity: "hour",
        timeZone: "UTC",
      }),
    ).toEqual({
      ok: true,
      granularity: "hour",
      cohorts: [
        {
          bucket: 0,
          size: 2,
          periods: [
            { index: 0, visitors: 2, rate: 1 },
            { index: 1, visitors: 2, rate: 1 },
          ],
        },
        {
          bucket: 3_600_000,
          size: 3,
          periods: [{ index: 0, visitors: 3, rate: 1 }],
        },
      ],
    });
  });

  it("uses the earliest bucket when filtered visits are not chronological", () => {
    const visits = [
      makeVisit({
        visitId: "u1-later",
        visitorId: "u1",
        startedAt: 60_000 + 1_000,
      }),
      makeVisit({
        visitId: "u1-earlier",
        visitorId: "u1",
        sessionId: "s2",
        startedAt: 1_000,
      }),
    ];
    const dataset = makeDataset(visits);
    mockBuildDemoFactDataset.mockReturnValue(dataset);
    mockApplyDemoFilters.mockReturnValue(makeFiltered(visits));

    expect(
      generateDemoRetention("site", {
        from: 0,
        to: 2 * 60_000,
        granularity: "minute",
        timeZone: "UTC",
      }),
    ).toEqual({
      ok: true,
      granularity: "minute",
      cohorts: [
        {
          bucket: 0,
          size: 1,
          periods: [
            { index: 0, visitors: 1, rate: 1 },
            { index: 1, visitors: 1, rate: 1 },
          ],
        },
      ],
    });
  });

  it("accepts every explicit granularity and filters zero-weight cohorts", () => {
    const visits = [
      makeVisit({ visitId: "inside", visitorId: "u1", startedAt: 1_000 }),
      makeVisit({
        visitId: "outside-minute-window",
        visitorId: "u2",
        sessionId: "s2",
        startedAt: 2 * 60_000,
      }),
    ];
    const dataset = makeDataset(visits);
    dataset.visitors.clear();
    mockBuildDemoFactDataset.mockReturnValue(dataset);
    mockApplyDemoFilters.mockReturnValue(makeFiltered(visits));

    for (const granularity of ["minute", "day", "week", "month"] as const) {
      expect(
        generateDemoRetention("site", {
          from: 0,
          to: 60_000,
          granularity,
          timeZone: "UTC",
        }),
      ).toEqual({
        ok: true,
        granularity,
        cohorts: [],
      });
    }
  });

  it("falls back to week granularity and omits empty cohorts", () => {
    mockBuildDemoFactDataset.mockReturnValue(makeDataset([]));
    mockApplyDemoFilters.mockReturnValue(makeFiltered([]));

    expect(
      generateDemoRetention("site", {
        from: 0,
        to: 1,
        granularity: "century",
      }),
    ).toEqual({
      ok: true,
      granularity: "week",
      cohorts: [],
    });
  });

  it("skips visits whose start time falls outside the generated buckets", () => {
    const visits = [
      makeVisit({ visitId: "in-range", visitorId: "u1", startedAt: 1_000 }),
      makeVisit({
        visitId: "after-window",
        visitorId: "u2",
        sessionId: "s-late",
        startedAt: 60 * 60 * 1000, // beyond `to`
      }),
    ];
    const dataset = makeDataset(visits);
    mockBuildDemoFactDataset.mockReturnValue(dataset);
    mockApplyDemoFilters.mockReturnValue(makeFiltered(visits));

    expect(
      generateDemoRetention("site", {
        from: 0,
        to: 1_000,
        granularity: "hour",
        timeZone: "UTC",
      }),
    ).toMatchObject({
      ok: true,
      cohorts: [
        expect.objectContaining({
          bucket: 0,
          size: 1,
          periods: [expect.objectContaining({ index: 0, visitors: 1 })],
        }),
      ],
    });
  });
});

function makeDataset(visits: DemoVisitFact[]): DemoFactDataset {
  const dataset: DemoFactDataset = {
    from: 0,
    to: 1,
    viewWeight: 1,
    visits,
    sessions: new Map(),
    visitors: new Map(),
  };
  for (const visit of visits) {
    dataset.sessions.set(visit.sessionId, {
      sessionId: visit.sessionId,
      visitorId: visit.visitorId.trim(),
      entryPath: visit.pathname,
      exitPath: visit.pathname,
      weight: 1,
    });
    const visitorId = visit.visitorId.trim();
    if (visitorId) {
      dataset.visitors.set(visitorId, { visitorId, weight: 1 });
    }
  }
  return dataset;
}

function makeFiltered(visits: DemoVisitFact[]): DemoFilteredFacts {
  const sessions = new Set(visits.map((visit) => visit.sessionId));
  const visitors = new Set(
    visits.map((visit) => visit.visitorId.trim()).filter(Boolean),
  );
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
