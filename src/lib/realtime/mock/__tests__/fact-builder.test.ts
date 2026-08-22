import { describe, expect, it } from "vitest";

import { findSiteProfile } from "@/lib/realtime/demo-site-profiles";
import {
  aggregateDimensionRowsFromVisits,
  aggregateOverviewMetrics,
  aggregateSessionEdgeRows,
  applyDemoFilters,
  buildDemoFactDataset,
  buildDemoPathTitleMap,
  collectClientTabs,
  collectGeoTabs,
  collectPageDataAndTabs,
  collectReferrerRows,
  DEMO_FACT_DATASET_CACHE,
  emptyDemoFactDataset,
  weightedSessionCount,
  weightedVisitorCount,
} from "@/lib/realtime/mock/fact-builder";
import { computeMetrics } from "@/lib/realtime/mock/site-curves";
import type {
  DemoFactDataset,
  DemoFilteredFacts,
  DemoVisitFact,
} from "@/lib/realtime/mock/types";

const SITE_ID = "demo-site-001";
const DAY_MS = 86_400_000;

describe("mock/fact-builder", () => {
  describe("emptyDemoFactDataset", () => {
    it("returns an empty dataset with the given window", () => {
      const empty = emptyDemoFactDataset(0, 100);
      expect(empty.from).toBe(0);
      expect(empty.to).toBe(100);
      expect(empty.viewWeight).toBe(1);
      expect(empty.visits).toEqual([]);
      expect(empty.sessions.size).toBe(0);
      expect(empty.visitors.size).toBe(0);
    });
  });

  describe("buildDemoPathTitleMap", () => {
    it("uses profile paths/titles and fills missing titles from path", () => {
      const profile = findSiteProfile(SITE_ID);
      const map = buildDemoPathTitleMap(profile, ["/extra-path"]);
      expect(map.size).toBeGreaterThan(0);
      expect(map.get("/extra-path")).toBeTruthy();
    });

    it("skips blank profile paths and derives blank titles from the path", () => {
      const profile = {
        ...findSiteProfile(SITE_ID),
        paths: ["", "/custom-report"],
        titles: ["Ignored", "   "],
      };

      const map = buildDemoPathTitleMap(profile, ["/custom-report"]);

      expect(map.has("")).toBe(false);
      expect(map.get("/custom-report")).toBe("Custom Report");
    });
  });

  describe("buildDemoFactDataset", () => {
    it("returns an empty dataset for inverted windows", () => {
      DEMO_FACT_DATASET_CACHE.clear();
      const data = buildDemoFactDataset(SITE_ID, 100, 100);
      expect(data.visits.length).toBe(0);
    });

    it("returns a non-empty dataset for a day window", () => {
      DEMO_FACT_DATASET_CACHE.clear();
      const dataset = buildDemoFactDataset(SITE_ID, DAY_MS, 2 * DAY_MS);
      expect(dataset.visits.length).toBeGreaterThan(0);
      expect(dataset.sessions.size).toBeGreaterThan(0);
      expect(dataset.visitors.size).toBeGreaterThan(0);
      expect(dataset.viewWeight).toBeGreaterThanOrEqual(1);
      // visits should be sorted by startedAt
      for (let i = 1; i < dataset.visits.length; i += 1) {
        expect(dataset.visits[i].startedAt).toBeGreaterThanOrEqual(
          dataset.visits[i - 1].startedAt,
        );
      }
    });

    it("adapts long-window sampling while preserving weighted metrics", () => {
      DEMO_FACT_DATASET_CACHE.clear();
      const to = Date.now();
      const thirtyDayFrom = to - 30 * DAY_MS;
      const ninetyDayFrom = to - 90 * DAY_MS;
      const thirtyDayMetrics = computeMetrics(SITE_ID, thirtyDayFrom, to);
      const ninetyDayMetrics = computeMetrics(SITE_ID, ninetyDayFrom, to);
      const thirtyDay = buildDemoFactDataset(SITE_ID, thirtyDayFrom, to);
      const ninetyDay = buildDemoFactDataset(SITE_ID, ninetyDayFrom, to);

      const originalThirtyDayTarget = Math.max(
        320,
        Math.min(
          12_000,
          Math.round(Math.sqrt(thirtyDayMetrics.views + 1) * 46),
        ),
      );
      const originalNinetyDayTarget = Math.max(
        320,
        Math.min(
          12_000,
          Math.round(Math.sqrt(ninetyDayMetrics.views + 1) * 46),
        ),
      );
      expect(thirtyDay.visits.length).toBe(
        Math.max(1, Math.min(thirtyDayMetrics.views, originalThirtyDayTarget)),
      );
      expect(ninetyDay.visits.length).toBeGreaterThan(0);
      expect(ninetyDay.visits.length).toBeLessThan(thirtyDay.visits.length);
      expect(ninetyDay.visits.length).toBeLessThan(originalNinetyDayTarget);
      expect(
        new Set(ninetyDay.visits.map((visit) => visit.pathname)).size,
      ).toBeGreaterThan(1);
      expect(
        new Set(ninetyDay.visits.map((visit) => visit.country)).size,
      ).toBeGreaterThan(1);
      expect(ninetyDay.viewWeight).toBeGreaterThan(0);
      expect(
        [...ninetyDay.sessions.values()].every(
          (session) => Number.isFinite(session.weight) && session.weight > 0,
        ),
      ).toBe(true);
      expect(
        [...ninetyDay.visitors.values()].every(
          (visitor) => Number.isFinite(visitor.weight) && visitor.weight > 0,
        ),
      ).toBe(true);

      const aggregated = aggregateOverviewMetrics(
        ninetyDay,
        applyDemoFilters(ninetyDay, {}),
      );
      expect(aggregated.views).toBe(ninetyDayMetrics.views);
      expect(aggregated.sessions).toBe(ninetyDayMetrics.sessions);
      expect(aggregated.visitors).toBe(ninetyDayMetrics.visitors);
      expect(
        Math.abs(aggregated.totalDurationMs - ninetyDayMetrics.totalDurationMs),
      ).toBeLessThan(10_000);
      expect(aggregated.bounceRate).toBeCloseTo(ninetyDayMetrics.bounceRate, 2);
    });

    it("caches results", () => {
      DEMO_FACT_DATASET_CACHE.clear();
      const a = buildDemoFactDataset(SITE_ID, DAY_MS, 2 * DAY_MS);
      const b = buildDemoFactDataset(SITE_ID, DAY_MS, 2 * DAY_MS);
      expect(a).toBe(b);
    });

    it("clears oversized cache before storing a generated dataset", () => {
      DEMO_FACT_DATASET_CACHE.clear();
      for (let index = 0; index < 141; index += 1) {
        DEMO_FACT_DATASET_CACHE.set(
          `stale:${index}`,
          emptyDemoFactDataset(index, index + 1),
        );
      }

      const dataset = buildDemoFactDataset(SITE_ID, DAY_MS, 2 * DAY_MS);

      expect(dataset.visits.length).toBeGreaterThan(0);
      expect(DEMO_FACT_DATASET_CACHE.size).toBe(1);
    });

    it("handles non-finite endpoints by returning an empty dataset", () => {
      DEMO_FACT_DATASET_CACHE.clear();
      const d = buildDemoFactDataset(SITE_ID, Number.NaN, 100);
      expect(d.visits.length).toBe(0);
    });

    it("caches an empty dataset when a finite window has zero computed views", () => {
      DEMO_FACT_DATASET_CACHE.clear();
      const a = buildDemoFactDataset(SITE_ID, 0, 1);
      const b = buildDemoFactDataset(SITE_ID, 0, 1);
      expect(a).toBe(b);
      expect(a.visits).toEqual([]);
      expect(a.sessions.size).toBe(0);
      expect(a.visitors.size).toBe(0);
    });
  });

  describe("weightedSessionCount / weightedVisitorCount", () => {
    it("sums session/visitor weights for the given IDs", () => {
      const dataset: DemoFactDataset = emptyDemoFactDataset(0, 1);
      dataset.sessions.set("s1", {
        sessionId: "s1",
        visitorId: "v1",
        entryPath: "/",
        exitPath: "/",
        weight: 2,
      });
      dataset.sessions.set("s2", {
        sessionId: "s2",
        visitorId: "v2",
        entryPath: "/",
        exitPath: "/",
        weight: 3,
      });
      dataset.visitors.set("v1", { visitorId: "v1", weight: 1.5 });
      dataset.visitors.set("v2", { visitorId: "v2", weight: 2.5 });
      expect(weightedSessionCount(dataset, ["s1", "s2"])).toBe(5);
      expect(weightedSessionCount(dataset, ["s1", "missing"])).toBe(2);
      expect(weightedVisitorCount(dataset, ["v1", "v2"])).toBe(4);
      expect(weightedVisitorCount(dataset, ["missing"])).toBe(0);
    });
  });

  describe("applyDemoFilters", () => {
    it("returns all visits when no filters are set", () => {
      DEMO_FACT_DATASET_CACHE.clear();
      const dataset = buildDemoFactDataset(SITE_ID, DAY_MS, 2 * DAY_MS);
      const filtered = applyDemoFilters(dataset, {});
      expect(filtered.visits.length).toBe(dataset.visits.length);
      expect(filtered.sessions.size).toBeGreaterThan(0);
      expect(filtered.visitors.size).toBeGreaterThan(0);
    });

    it("filters by country", () => {
      DEMO_FACT_DATASET_CACHE.clear();
      const dataset = buildDemoFactDataset(SITE_ID, DAY_MS, 2 * DAY_MS);
      const filtered = applyDemoFilters(dataset, { country: "US" });
      for (const visit of filtered.visits) {
        expect(visit.country.toLowerCase()).toBe("us");
      }
    });

    it("filters by browser", () => {
      DEMO_FACT_DATASET_CACHE.clear();
      const dataset = buildDemoFactDataset(SITE_ID, DAY_MS, 2 * DAY_MS);
      const browser = dataset.visits[0]?.browser;
      if (!browser) return;
      const filtered = applyDemoFilters(dataset, { browser });
      expect(filtered.visits.length).toBeGreaterThan(0);
      for (const visit of filtered.visits) {
        expect(visit.browser).toBe(browser);
      }
    });

    it("filters by direct referrer sentinel for sourceDomain", () => {
      const dataset = emptyDemoFactDataset(0, 1);
      dataset.visits.push(
        makeVisit({ visitId: "v1", referrerHost: "" }),
        makeVisit({ visitId: "v2", referrerHost: "google.com" }),
      );
      const filtered = applyDemoFilters(dataset, {
        sourceDomain: "__direct__",
      });
      expect(filtered.visits.length).toBe(1);
      expect(filtered.visits[0].visitId).toBe("v1");
    });

    it("filters by referrer host equality for sourceDomain", () => {
      const dataset = emptyDemoFactDataset(0, 1);
      dataset.visits.push(
        makeVisit({ visitId: "v1", referrerHost: "google.com" }),
        makeVisit({ visitId: "v2", referrerHost: "yahoo.com" }),
      );
      const filtered = applyDemoFilters(dataset, {
        sourceDomain: "google.com",
      });
      expect(filtered.visits.length).toBe(1);
      expect(filtered.visits[0].visitId).toBe("v1");
    });

    it("filters by sourceLink with URL hostname fallback", () => {
      const dataset = emptyDemoFactDataset(0, 1);
      dataset.visits.push(
        makeVisit({
          visitId: "v1",
          referrerHost: "google.com",
          referrerUrl: "https://google.com/search/foo",
        }),
        makeVisit({
          visitId: "v2",
          referrerHost: "yahoo.com",
          referrerUrl: "https://yahoo.com/r/bar",
        }),
      );
      const filtered = applyDemoFilters(dataset, {
        sourceLink: "https://google.com/anything",
      });
      expect(filtered.visits.length).toBe(1);
      expect(filtered.visits[0].visitId).toBe("v1");
    });

    it("filters by geo country code", () => {
      const dataset = emptyDemoFactDataset(0, 1);
      dataset.visits.push(
        makeVisit({ visitId: "v1", country: "US" }),
        makeVisit({ visitId: "v2", country: "DE" }),
      );
      const filtered = applyDemoFilters(dataset, { geo: "US" });
      expect(filtered.visits.length).toBe(1);
      expect(filtered.visits[0].visitId).toBe("v1");
    });

    it("filters by geo region", () => {
      const dataset = emptyDemoFactDataset(0, 1);
      dataset.visits.push(
        makeVisit({
          visitId: "v1",
          country: "US",
          regionCode: "CA",
          regionName: "California",
        }),
        makeVisit({
          visitId: "v2",
          country: "US",
          regionCode: "TX",
          regionName: "Texas",
        }),
      );
      const filtered = applyDemoFilters(dataset, { geo: "US::CA::California" });
      expect(filtered.visits.length).toBe(1);
      expect(filtered.visits[0].visitId).toBe("v1");
    });

    it("filters by entry/exit pathways using session lookups", () => {
      const dataset = emptyDemoFactDataset(0, 1);
      const visits: DemoVisitFact[] = [
        makeVisit({
          visitId: "v1",
          sessionId: "s1",
          pathname: "/landing",
        }),
        makeVisit({ visitId: "v2", sessionId: "s2", pathname: "/foo" }),
      ];
      dataset.visits.push(...visits);
      dataset.sessions.set("s1", {
        sessionId: "s1",
        visitorId: "u1",
        entryPath: "/landing",
        exitPath: "/checkout",
        weight: 1,
      });
      dataset.sessions.set("s2", {
        sessionId: "s2",
        visitorId: "u2",
        entryPath: "/foo",
        exitPath: "/bar",
        weight: 1,
      });
      expect(
        applyDemoFilters(dataset, { entry: "/landing" }).visits,
      ).toHaveLength(1);
      expect(
        applyDemoFilters(dataset, { exit: "/checkout" }).visits,
      ).toHaveLength(1);
      expect(
        applyDemoFilters(dataset, { entry: "/missing" }).visits,
      ).toHaveLength(0);
    });
  });

  describe("aggregateOverviewMetrics", () => {
    it("aggregates metrics from a filtered set", () => {
      DEMO_FACT_DATASET_CACHE.clear();
      const dataset = buildDemoFactDataset(SITE_ID, DAY_MS, 2 * DAY_MS);
      const filtered = applyDemoFilters(dataset, {});
      const m = aggregateOverviewMetrics(dataset, filtered);
      expect(m.views).toBeGreaterThan(0);
      expect(m.sessions).toBeGreaterThan(0);
      expect(m.visitors).toBeGreaterThan(0);
      expect(m.bounceRate).toBeGreaterThanOrEqual(0);
      expect(m.bounceRate).toBeLessThanOrEqual(1);
      expect(m.approximateVisitors).toBe(false);
    });

    it("returns zeros for an empty filtered set", () => {
      const empty: DemoFilteredFacts = {
        visits: [],
        sessions: new Set(),
        visitors: new Set(),
        visitsBySession: new Map(),
      };
      const m = aggregateOverviewMetrics(emptyDemoFactDataset(0, 1), empty);
      expect(m.views).toBe(0);
      expect(m.sessions).toBe(0);
      expect(m.bounces).toBe(0);
      expect(m.bounceRate).toBe(0);
    });
  });

  describe("aggregateDimensionRowsFromVisits", () => {
    it("buckets by label and sorts by views", () => {
      const dataset = emptyDemoFactDataset(0, 1);
      dataset.visitors.set("u1", { visitorId: "u1", weight: 1 });
      dataset.visitors.set("u2", { visitorId: "u2", weight: 1 });
      dataset.sessions.set("s1", {
        sessionId: "s1",
        visitorId: "u1",
        entryPath: "/",
        exitPath: "/",
        weight: 1,
      });
      dataset.sessions.set("s2", {
        sessionId: "s2",
        visitorId: "u2",
        entryPath: "/",
        exitPath: "/",
        weight: 1,
      });
      const visits = [
        makeVisit({
          visitId: "v1",
          sessionId: "s1",
          visitorId: "u1",
          pathname: "/a",
        }),
        makeVisit({
          visitId: "v2",
          sessionId: "s1",
          visitorId: "u1",
          pathname: "/a",
        }),
        makeVisit({
          visitId: "v3",
          sessionId: "s2",
          visitorId: "u2",
          pathname: "/b",
        }),
      ];
      const rows = aggregateDimensionRowsFromVisits(
        dataset,
        visits,
        10,
        (v) => v.pathname,
      );
      expect(rows[0].label).toBe("/a");
      expect(rows[0].views).toBe(2);
      expect(rows[1].label).toBe("/b");
    });

    it("ignores empty labels", () => {
      const dataset = emptyDemoFactDataset(0, 1);
      const visits = [makeVisit({ pathname: "" })];
      expect(
        aggregateDimensionRowsFromVisits(
          dataset,
          visits,
          10,
          (v) => v.pathname,
        ),
      ).toEqual([]);
    });
  });

  describe("aggregateSessionEdgeRows", () => {
    it("uses earliest visit for `entry` and latest for `exit`", () => {
      const dataset = emptyDemoFactDataset(0, 1);
      dataset.sessions.set("s1", {
        sessionId: "s1",
        visitorId: "u1",
        entryPath: "/",
        exitPath: "/",
        weight: 1,
      });
      dataset.visitors.set("u1", { visitorId: "u1", weight: 1 });
      const filtered: DemoFilteredFacts = {
        visits: [
          makeVisit({
            visitId: "v1",
            sessionId: "s1",
            visitorId: "u1",
            startedAt: 100,
            pathname: "/landing",
          }),
          makeVisit({
            visitId: "v2",
            sessionId: "s1",
            visitorId: "u1",
            startedAt: 500,
            pathname: "/exit-page",
          }),
        ],
        sessions: new Set(["s1"]),
        visitors: new Set(["u1"]),
        visitsBySession: new Map([["s1", 2]]),
      };
      const entryRows = aggregateSessionEdgeRows(dataset, filtered, "entry", 5);
      const exitRows = aggregateSessionEdgeRows(dataset, filtered, "exit", 5);
      expect(entryRows[0].label).toBe("/landing");
      expect(exitRows[0].label).toBe("/exit-page");
    });
  });

  describe("collectPageDataAndTabs", () => {
    it("returns shaped page data and tab arrays", () => {
      DEMO_FACT_DATASET_CACHE.clear();
      const dataset = buildDemoFactDataset(SITE_ID, DAY_MS, 2 * DAY_MS);
      const filtered = applyDemoFilters(dataset, {});
      const result = collectPageDataAndTabs(dataset, filtered, 5);
      expect(Array.isArray(result.data)).toBe(true);
      expect(result.data.length).toBeGreaterThan(0);
      expect(result.data[0].pathname).toBeTruthy();
      expect(Array.isArray(result.tabs.path)).toBe(true);
      expect(Array.isArray(result.tabs.title)).toBe(true);
      expect(Array.isArray(result.tabs.entry)).toBe(true);
      expect(Array.isArray(result.tabs.exit)).toBe(true);
    });
  });

  describe("collectReferrerRows", () => {
    it("returns referrer rows with the default direct value", () => {
      DEMO_FACT_DATASET_CACHE.clear();
      const dataset = buildDemoFactDataset(SITE_ID, DAY_MS, 2 * DAY_MS);
      const filtered = applyDemoFilters(dataset, {});
      const rows = collectReferrerRows(dataset, filtered, 5);
      expect(rows.length).toBeGreaterThan(0);
      expect(rows[0].referrer).toBeTruthy();
    });

    it("supports full URL mode and a custom direct value", () => {
      DEMO_FACT_DATASET_CACHE.clear();
      const dataset = buildDemoFactDataset(SITE_ID, DAY_MS, 2 * DAY_MS);
      const filtered = applyDemoFilters(dataset, {});
      const rows = collectReferrerRows(dataset, filtered, 5, {
        includeFullUrl: true,
        directValue: "Direct",
      });
      expect(rows.length).toBeGreaterThan(0);
    });
  });

  describe("collectClientTabs & collectGeoTabs", () => {
    it("returns shaped client + geo tabs", () => {
      DEMO_FACT_DATASET_CACHE.clear();
      const dataset = buildDemoFactDataset(SITE_ID, DAY_MS, 2 * DAY_MS);
      const filtered = applyDemoFilters(dataset, {});
      const client = collectClientTabs(dataset, filtered, 5);
      const geo = collectGeoTabs(dataset, filtered, 5);
      expect(Array.isArray(client.browser)).toBe(true);
      expect(Array.isArray(client.osVersion)).toBe(true);
      expect(Array.isArray(client.deviceType)).toBe(true);
      expect(Array.isArray(client.language)).toBe(true);
      expect(Array.isArray(client.screenSize)).toBe(true);
      expect(Array.isArray(geo.country)).toBe(true);
      expect(Array.isArray(geo.region)).toBe(true);
      expect(Array.isArray(geo.city)).toBe(true);
      expect(Array.isArray(geo.continent)).toBe(true);
      expect(Array.isArray(geo.timezone)).toBe(true);
      expect(Array.isArray(geo.organization)).toBe(true);
    });
  });
});

function makeVisit(overrides: Partial<DemoVisitFact> = {}): DemoVisitFact {
  return {
    visitId: "v1",
    sessionId: "s1",
    visitorId: "u1",
    startedAt: 0,
    pathname: "/home",
    title: "Home",
    hostname: "example.com",
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
    continent: "",
    timezone: "",
    organization: "",
    latitude: 0,
    longitude: 0,
    eventType: "pageview",
    durationMs: 0,
    ...overrides,
  };
}
