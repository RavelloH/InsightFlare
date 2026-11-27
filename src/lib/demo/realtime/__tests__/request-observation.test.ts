import { describe, expect, it } from "vitest";

import {
  aggregateDemoRequestObservationData,
  generateDemoRequestObservationData,
  generateDemoRequestObservationEvents,
} from "@/lib/demo/realtime/request-observation";

function weightedCount(events: Array<{ sampleWeight: number }>) {
  return events.reduce((sum, event) => sum + event.sampleWeight, 0);
}

describe("mock/request-observation", () => {
  it("omits detail-only metadata without changing deterministic event data", () => {
    const generatedAt = Date.UTC(2026, 10, 27);
    const full = generateDemoRequestObservationData(60, generatedAt);
    const lean = generateDemoRequestObservationData(60, generatedAt, {
      includeMetadataJson: false,
    });
    const stripMetadata = (events: typeof full.events) =>
      events.map(({ metadataJson: _metadataJson, ...event }) => event);

    expect(stripMetadata(lean.blockedEvents)).toEqual(
      stripMetadata(full.blockedEvents),
    );
    expect(stripMetadata(lean.includedEvents)).toEqual(
      stripMetadata(full.includedEvents),
    );
    expect(stripMetadata(lean.normalEvents)).toEqual(
      stripMetadata(full.normalEvents),
    );
    expect(lean.summary).toEqual(full.summary);
    expect(lean.trend).toEqual(full.trend);
    expect(lean.blocked.summary).toEqual(full.blocked.summary);
    expect(lean.blocked.mapPoints).toEqual(full.blocked.mapPoints);
    expect(lean.blockedEvents.every((event) => event.metadataJson === "")).toBe(
      true,
    );
    expect(
      lean.includedEvents.every((event) => event.metadataJson === ""),
    ).toBe(true);
    expect(
      full.blockedEvents.some((event) => event.metadataJson.length > 0),
    ).toBe(true);
  });

  it("generates only matching metadata and preserves the event-only and overview contracts", () => {
    const now = Date.UTC(2026, 10, 27);
    const original = generateDemoRequestObservationData(60, now);
    const blocked = original.blockedEvents[0]!;
    const normal = original.normalEvents[0]!;
    const events = generateDemoRequestObservationEvents(60, now, {
      metadataMatch: { traceId: blocked.traceId, rayId: normal.rayId },
    });
    expect(events).not.toHaveProperty("summary");
    expect(events).not.toHaveProperty("trend");
    expect(
      events.allEvents
        .filter((event) => event.metadataJson)
        .map((event) => event.traceId)
        .sort(),
    ).toEqual([blocked.traceId, normal.traceId].sort());
    expect(
      events.blockedEvents.find((event) => event.traceId === blocked.traceId),
    ).toEqual(blocked);
    expect(
      events.normalEvents.find((event) => event.rayId === normal.rayId),
    ).toEqual(normal);
    const {
      blockedEvents: _blocked,
      includedEvents: _included,
      events: _events,
      normalEvents: _normal,
      blocked: originalBlocked,
      included: originalIncluded,
      ...originalStats
    } = original;
    const aggregated = aggregateDemoRequestObservationData(events);
    const {
      blockedEvents: _b,
      includedEvents: _i,
      events: _e,
      normalEvents: _n,
      blocked: actualBlocked,
      included: actualIncluded,
      ...actualStats
    } = aggregated;
    expect(actualStats).toEqual(originalStats);
    expect(actualBlocked.summary).toEqual(originalBlocked.summary);
    expect(actualIncluded.summary).toEqual(originalIncluded.summary);
  });

  it("generates weighted blocked and included request observation data", () => {
    const data = generateDemoRequestObservationData(1440);
    const allEvents = [...data.blockedEvents, ...data.includedEvents];
    const blockedEvents = allEvents.filter(
      (event) => event.disposition === "blocked",
    );
    const includedEvents = allEvents.filter(
      (event) => event.disposition === "included",
    );

    expect(data.ok).toBe(true);
    expect(data.configured).toBe(true);
    expect(data.sampling).toMatchObject({
      provider: "cloudflare_analytics_engine",
      mode: "automatic",
      observedSampled: true,
      aggregatesWeighted: true,
      detailsAreSampled: true,
      distinctAreApproximate: true,
    });
    expect(data.summary.total).toBe(weightedCount(allEvents));
    expect(data.summary.includedRequests).toBe(weightedCount(includedEvents));
    expect(data.summary.blockedRequests).toBe(weightedCount(blockedEvents));
    expect(data.summary.total).toBe(
      data.summary.includedRequests + data.summary.blockedRequests,
    );
    expect(data.summary.normalRequests).toBeGreaterThan(0);
    expect(data.summary.suspectedBotRequests).toBeGreaterThan(0);
    expect(data.summary.botRequests).toBeGreaterThan(0);
    expect(data.summary.customBlockedRequests).toBeGreaterThan(0);
    expect(data.summary.affectedSites).toBeGreaterThan(0);
    expect(data.summary.uniqueAsns).toBeGreaterThan(0);
    expect(data.summary.uniqueCountries).toBeGreaterThan(0);
    expect(new Set(allEvents.map((event) => event.category))).toEqual(
      new Set(["normal", "suspected_bot", "bot", "custom_block"]),
    );
    expect(new Set(allEvents.map((event) => event.disposition))).toEqual(
      new Set(["included", "blocked"]),
    );
    expect(
      allEvents.every((event) =>
        event.category === "bot" ? event.ip.length > 0 : event.ip === "",
      ),
    ).toBe(true);

    expect(data.events).toEqual(data.blockedEvents);
    expect(data.normalEvents).toEqual(
      data.includedEvents.filter((event) => event.category === "normal"),
    );
    expect(data.blocked.summary.total).toBe(data.summary.blockedRequests);
    expect(data.included.summary.total).toBe(data.summary.includedRequests);
    expect(data.blocked.mapPoints.length).toBeGreaterThan(0);
    expect(data.included.mapPoints.length).toBeGreaterThan(0);
    expect(data.reasons.length).toBeGreaterThan(0);
    expect(data.asns.length).toBeGreaterThan(0);
    expect(data.mapPoints).toEqual(data.blocked.mapPoints);
    expect(data.events[0]?.metadataJson).toContain('"requestMethod":"POST"');

    const categoryWeight = (category: string) =>
      allEvents
        .filter((event) => event.category === category)
        .reduce((sum, event) => sum + event.sampleWeight, 0);
    expect(data.trend.reduce((sum, point) => sum + point.normalCount, 0)).toBe(
      categoryWeight("normal"),
    );
    expect(
      data.trend.reduce((sum, point) => sum + point.suspectedBotCount, 0),
    ).toBe(categoryWeight("suspected_bot"));
    expect(data.trend.reduce((sum, point) => sum + point.botCount, 0)).toBe(
      categoryWeight("bot"),
    );
    expect(
      data.trend.reduce((sum, point) => sum + point.customBlockedCount, 0),
    ).toBe(categoryWeight("custom_block"));
    expect(
      data.trend.reduce((sum, point) => sum + point.includedCount, 0),
    ).toBe(data.summary.includedRequests);
    expect(data.trend.reduce((sum, point) => sum + point.blockedCount, 0)).toBe(
      data.summary.blockedRequests,
    );
    expect(
      data.trend.every(
        (point) =>
          point.totalCount === point.includedCount + point.blockedCount &&
          point.weightedRequestCount === point.totalCount &&
          point.botRatio >= 0 &&
          point.botRatio <= 1 &&
          point.blockedRatio >= 0 &&
          point.blockedRatio <= 1,
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
        data.overview.includedRequests + data.overview.blockedRequests,
      );
      expect(data.overview.botRequestRatio).toBe(
        data.summary.botRequests / data.overview.totalRequests,
      );
      expect(data.overview.blockedRequestRatio).toBe(
        data.overview.blockedRequests / data.overview.totalRequests,
      );
      expect(data.blocked.summary.total).toBe(data.overview.blockedRequests);
      expect(data.included.summary.total).toBe(data.overview.includedRequests);
      expect(data.trend.some((point) => point.totalCount > 0)).toBe(true);
      expect(data.trend.some((point) => point.p95LatencyMs !== null)).toBe(
        true,
      );
    },
    15_000,
  );
});
