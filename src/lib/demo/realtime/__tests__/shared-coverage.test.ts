import { describe, expect, it, vi } from "vitest";

import type * as FactBuilder from "@/lib/demo/realtime/fact-builder";
import {
  buildDemoTimeBuckets,
  buildDemoTrendBuckets,
  createDemoShareTrendSeriesKey,
  demoClientDimensionMeta,
  demoVisitMatchesJourneySearch,
  findDemoTimeBucketIndex,
  parseDemoClientDimensionKey,
  parseDemoScreenSize,
  parseDemoTimeZone,
} from "@/lib/demo/realtime/shared";
import type {
  DemoFactDataset,
  DemoFilteredFacts,
  DemoVisitFact,
} from "@/lib/demo/realtime/types";
const { mockApplyDemoFilters, mockBuildDemoFactDataset } = vi.hoisted(() => ({
  mockApplyDemoFilters: vi.fn(),
  mockBuildDemoFactDataset: vi.fn(),
}));
vi.mock("@/lib/demo/realtime/fact-builder", async () => {
  const actual = await vi.importActual<typeof FactBuilder>(
    "@/lib/demo/realtime/fact-builder",
  );
  return {
    ...actual,
    buildDemoFactDataset: mockBuildDemoFactDataset,
    applyDemoFilters: mockApplyDemoFilters,
  };
});
describe("mock/shared coverage", () => {
  it("matches journey searches against visit and session fields", () => {
    const visit = makeVisit({
      pathname: "/pricing",
      title: "Pricing",
      referrerHost: "",
      referrerUrl: "",
      country: "US",
      regionName: "California",
      cityName: "San Francisco",
      browser: "Safari",
      browserVersion: "18",
      osVersion: "iOS 18",
      deviceType: "Mobile",
    });
    const dataset = makeDataset([visit]);
    dataset.sessions.set("s1", {
      sessionId: "s1",
      visitorId: "u1",
      entryPath: "/landing",
      exitPath: "/checkout",
      weight: 1,
    });

    expect(demoVisitMatchesJourneySearch(dataset, visit, "")).toBe(true);
    expect(demoVisitMatchesJourneySearch(dataset, visit, "checkout")).toBe(
      true,
    );
    expect(demoVisitMatchesJourneySearch(dataset, visit, "safari 18")).toBe(
      true,
    );
    expect(demoVisitMatchesJourneySearch(dataset, visit, "direct")).toBe(true);
    expect(demoVisitMatchesJourneySearch(dataset, visit, "missing")).toBe(
      false,
    );
  });

  it("parses timezone aliases and builds bounded fallback buckets", () => {
    expect(parseDemoTimeZone({ tz: "UTC" })).toBe("UTC");
    expect(parseDemoTimeZone({ timeZone: "Not/AZone" })).toBe("UTC");

    const buckets = buildDemoTimeBuckets(
      30 * 60 * 1000,
      90 * 60 * 1000,
      "hour",
      "UTC",
    );
    expect(buckets).toHaveLength(2);
    expect(buckets[0]).toMatchObject({
      index: 0,
      timestampMs: 0,
      fromMs: 0,
      toMs: 3_600_000,
    });
    expect(findDemoTimeBucketIndex(buckets, 3_600_000)).toBe(1);
    expect(findDemoTimeBucketIndex(buckets, 99_999_999)).toBeNull();

    expect(buildDemoTimeBuckets(1_000, 0, "day", "UTC")).toEqual([
      { index: 0, timestampMs: 0, fromMs: 0, toMs: 86_400_000 },
    ]);
  });

  it("does not throw or emit non-finite buckets for non-finite time bounds", () => {
    let buckets: ReturnType<typeof buildDemoTimeBuckets> = [];

    expect(() => {
      buckets = buildDemoTimeBuckets(Number.NaN, Number.NaN, "hour", "UTC");
    }).not.toThrow();
    expect(buckets.length).toBeGreaterThan(0);
    for (const bucket of buckets) {
      expect(Number.isFinite(bucket.timestampMs)).toBe(true);
      expect(Number.isFinite(bucket.fromMs)).toBe(true);
      expect(Number.isFinite(bucket.toMs)).toBe(true);
    }
  });

  it("builds weighted trend rows with session starts and bounces in their first bucket", () => {
    const visits = [
      makeVisit({
        visitId: "v1",
        sessionId: "s1",
        visitorId: "u1",
        startedAt: 1_000,
        durationMs: 500,
      }),
      makeVisit({
        visitId: "v2",
        sessionId: "s1",
        visitorId: "u1",
        startedAt: 3_600_000 + 1_000,
        durationMs: 1500,
      }),
      makeVisit({
        visitId: "v3",
        sessionId: "s2",
        visitorId: "u2",
        startedAt: 3_600_000 + 2_000,
        durationMs: 1000,
      }),
    ];
    const dataset = makeDataset(visits, { viewWeight: 2 });
    dataset.sessions.get("s1")!.weight = 3;
    dataset.sessions.get("s2")!.weight = 4;
    dataset.visitors.get("u1")!.weight = 5;
    dataset.visitors.get("u2")!.weight = 7;
    const filtered: DemoFilteredFacts = {
      visits,
      sessions: new Set(["s1", "s2"]),
      visitors: new Set(["u1", "u2"]),
      visitsBySession: new Map([
        ["s1", 2],
        ["s2", 1],
      ]),
    };
    mockBuildDemoFactDataset.mockReturnValue(dataset);
    mockApplyDemoFilters.mockReturnValue(filtered);

    expect(
      buildDemoTrendBuckets("site", 0, 2 * 3_600_000, "hour", {}, "UTC"),
    ).toEqual([
      {
        bucket: 0,
        timestampMs: 0,
        views: 2,
        visitors: 5,
        sessions: 3,
        bounces: 0,
        totalDurationMs: 1000,
        avgDurationMs: 333,
        source: "detail",
      },
      {
        bucket: 1,
        timestampMs: 3_600_000,
        views: 4,
        visitors: 12,
        sessions: 4,
        bounces: 4,
        totalDurationMs: 5000,
        avgDurationMs: 1250,
        source: "detail",
      },
      {
        bucket: 2,
        timestampMs: 7_200_000,
        views: 0,
        visitors: 0,
        sessions: 0,
        bounces: 0,
        totalDurationMs: 0,
        avgDurationMs: 0,
        source: "detail",
      },
    ]);
  });

  it("creates unique series keys from normalized labels", () => {
    const used = new Set(["other", "alpha-beta"]);

    expect(
      createDemoShareTrendSeriesKey(" Alpha Beta ", used, "fallback"),
    ).toBe("alpha-beta-2");
    expect(createDemoShareTrendSeriesKey("!!!", used, "fallback")).toBe(
      "fallback",
    );
  });

  it("parses client dimension keys and returns label metadata", () => {
    expect(parseDemoClientDimensionKey("browser")).toBe("browser");
    expect(parseDemoClientDimensionKey("unknown")).toBeNull();

    const visit = makeVisit({
      browser: "Firefox",
      osVersion: "Android 15",
      deviceType: "Tablet",
      language: "de-DE",
      screenSize: "1024x768",
    });
    expect(demoClientDimensionMeta("browser").getLabel(visit)).toBe("Firefox");
    expect(demoClientDimensionMeta("operatingSystem").getLabel(visit)).toBe(
      "Android",
    );
    expect(demoClientDimensionMeta("osVersion").getLabel(visit)).toBe(
      "Android 15",
    );
    expect(demoClientDimensionMeta("deviceType").getLabel(visit)).toBe(
      "Tablet",
    );
    expect(demoClientDimensionMeta("language").getLabel(visit)).toBe("de-DE");
    expect(demoClientDimensionMeta("screenSize").getLabel(visit)).toBe(
      "1024x768",
    );
  });

  it("parses screen sizes and rejects malformed values", () => {
    expect(parseDemoScreenSize("1280x720")).toEqual({
      screenWidth: 1280,
      screenHeight: 720,
    });
    expect(parseDemoScreenSize("wide")).toEqual({
      screenWidth: null,
      screenHeight: null,
    });
  });
});
function makeDataset(
  visits: DemoVisitFact[] = [],
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
function makeVisit(overrides: Partial<DemoVisitFact> = {}): DemoVisitFact {
  return {
    visitId: "v1",
    sessionId: "s1",
    visitorId: "u1",
    startedAt: 0,
    pathname: "/home",
    title: "Home",
    hostname: "example.test",
    referrerHost: "search.example",
    referrerUrl: "https://search.example/result",
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
    eventType: "pageview",
    durationMs: 1000,
    ...overrides,
  };
}
