import { describe, expect, it } from "vitest";

import { generateDemoRequestObservationData } from "@/lib/realtime/mock/request-observation";

describe("mock/request-observation", () => {
  it("generates populated request observation demo data", () => {
    const data = generateDemoRequestObservationData(1440);

    expect(data.ok).toBe(true);
    expect(data.configured).toBe(true);
    expect(data.summary.total).toBeGreaterThan(0);
    expect(data.summary.baselineRequests).toBeGreaterThan(data.summary.total);
    expect(data.summary.botRequestRatio).toBeGreaterThan(0);
    expect(data.summary.botRequestRatio).toBeLessThan(1);
    expect(data.summary.highThreat).toBeGreaterThan(0);
    expect(data.summary.mediumThreat).toBeGreaterThan(0);
    expect(data.summary.customBlocked).toBeGreaterThan(0);
    expect(data.summary.affectedSites).toBeGreaterThan(0);
    expect(data.summary.uniqueAsns).toBeGreaterThan(0);
    expect(data.summary.uniqueCountries).toBeGreaterThan(0);
    expect(data.events.length).toBe(data.summary.total);
    expect(data.trend.length).toBeGreaterThan(0);
    expect(
      data.trend.every(
        (point) =>
          point.weightedRequestCount === point.totalCount &&
          point.latencySampleWeight >= 0 &&
          point.latencyWeightedSumMs >= 0,
      ),
    ).toBe(true);
    expect(data.reasons.length).toBeGreaterThan(0);
    expect(data.asns.length).toBeGreaterThan(0);
    expect(data.mapPoints.length).toBeGreaterThan(0);
    expect(data.events[0]?.metadataJson).toContain('"requestMethod":"POST"');
    expect(new Set(data.normalEvents.map((event) => event.kind))).toEqual(
      new Set(["pageview", "leave", "visibility", "custom_event", "identify"]),
    );
    expect(new Set(data.events.map((event) => event.category))).toEqual(
      new Set(["medium_threat", "high_threat", "custom_block"]),
    );
    expect(
      data.trend.reduce((sum, point) => sum + point.pageviewCount, 0),
    ).toBe(
      data.normalEvents.filter((event) => event.kind === "pageview").length,
    );
    expect(data.trend.reduce((sum, point) => sum + point.leaveCount, 0)).toBe(
      data.normalEvents.filter((event) => event.kind === "leave").length,
    );
    expect(
      data.trend.reduce((sum, point) => sum + point.visibilityCount, 0),
    ).toBe(
      data.normalEvents.filter((event) => event.kind === "visibility").length,
    );
    expect(
      data.trend.reduce((sum, point) => sum + point.customEventCount, 0),
    ).toBe(
      data.normalEvents.filter((event) => event.kind === "custom_event").length,
    );
    expect(
      data.trend.reduce((sum, point) => sum + point.identifyCount, 0),
    ).toBe(
      data.normalEvents.filter((event) => event.kind === "identify").length,
    );
    expect(
      data.trend.every(
        (point) =>
          point.pageviewCount +
            point.leaveCount +
            point.visibilityCount +
            point.customEventCount +
            point.identifyCount ===
          point.normalCount,
      ),
    ).toBe(true);
    expect(
      data.trend.every(
        (point) =>
          point.mediumThreatCount +
            point.highThreatCount +
            point.customBlockedCount ===
          point.abnormalCount,
      ),
    ).toBe(true);
  });

  it.each([60, 10080, 43200] as const)(
    "generates coherent request observation demo data for %i-minute windows",
    (minutes) => {
      const data = generateDemoRequestObservationData(minutes);

      expect(data.ok).toBe(true);
      expect(data.window.minutes).toBe(minutes);
      expect(data.overview.totalRequests).toBe(
        data.overview.normalRequests + data.overview.abnormalRequests,
      );
      expect(data.normal.summary.total).toBe(data.overview.normalRequests);
      expect(data.abnormal.summary.total).toBe(data.overview.abnormalRequests);
      expect(data.normal.mapPoints.length).toBeGreaterThan(0);
      expect(data.abnormal.mapPoints.length).toBeGreaterThan(0);
      expect(data.trend.some((point) => point.totalCount > 0)).toBe(true);
      expect(data.trend.some((point) => point.p95LatencyMs !== null)).toBe(
        true,
      );
    },
  );
});
