import { describe, expect, it } from "vitest";

import { semanticMetric } from "@/lib/edge/analytics/engine/semantic/metrics";

type LegacyObservation = {
  readonly bucket: number;
  readonly kind: "page" | "event";
  readonly sessionId: string;
  readonly visitorId: string;
};

// Mirrors the legacy queryTrendFromD1 CTE inputs: unfiltered rows come from
// filtered_visits, while scoped rows come from page and event observations.
const observations: readonly LegacyObservation[] = [
  { bucket: 0, kind: "event", sessionId: "session-a", visitorId: "visitor-a" },
  { bucket: 1, kind: "page", sessionId: "session-a", visitorId: "visitor-a" },
  { bucket: 1, kind: "page", sessionId: "session-b", visitorId: "visitor-a" },
  { bucket: 2, kind: "event", sessionId: "session-c", visitorId: "visitor-b" },
];

function legacySessionTrendCounts(scoped: boolean): Map<number, number> {
  const firstBucketBySession = new Map<string, number>();
  for (const observation of observations) {
    if (!scoped && observation.kind !== "page") continue;
    if (!observation.sessionId) continue;
    const current = firstBucketBySession.get(observation.sessionId);
    if (current === undefined || observation.bucket < current) {
      firstBucketBySession.set(observation.sessionId, observation.bucket);
    }
  }
  const counts = new Map<number, number>();
  for (const bucket of firstBucketBySession.values()) {
    counts.set(bucket, (counts.get(bucket) ?? 0) + 1);
  }
  return counts;
}

function legacyVisitorTrendCounts(scoped: boolean): Map<number, number> {
  const visitorsByBucket = new Map<number, Set<string>>();
  for (const observation of observations) {
    if (!scoped && observation.kind !== "page") continue;
    if (!observation.visitorId) continue;
    const visitors =
      visitorsByBucket.get(observation.bucket) ?? new Set<string>();
    visitors.add(observation.visitorId);
    visitorsByBucket.set(observation.bucket, visitors);
  }
  return new Map(
    [...visitorsByBucket].map(([bucket, visitors]) => [bucket, visitors.size]),
  );
}

describe("legacy session and visitor trend policy inventory", () => {
  it("keeps unfiltered sessions assigned to their first page observation", () => {
    expect(semanticMetric("sessions")).toMatchObject({
      kind: "atomic",
      timeGroupingPolicy: "entity-first-observation",
    });
    expect([...legacySessionTrendCounts(false)]).toEqual([[1, 2]]);
  });

  it("keeps scoped sessions assigned to their first page or event observation", () => {
    expect(semanticMetric("sessions")).toMatchObject({
      kind: "atomic",
      timeGroupingPolicy: "entity-first-observation",
    });
    expect([...legacySessionTrendCounts(true)]).toEqual([
      [0, 1],
      [1, 1],
      [2, 1],
    ]);
  });

  it("counts unfiltered visitors distinctly inside each page bucket", () => {
    expect(semanticMetric("visitors")).toMatchObject({
      kind: "atomic",
      timeGroupingPolicy: "distinct-entity-per-bucket",
    });
    expect([...legacyVisitorTrendCounts(false)]).toEqual([[1, 1]]);
  });

  it("counts scoped visitors distinctly inside each page or event bucket", () => {
    expect(semanticMetric("visitors")).toMatchObject({
      kind: "atomic",
      timeGroupingPolicy: "distinct-entity-per-bucket",
    });
    expect([...legacyVisitorTrendCounts(true)]).toEqual([
      [0, 1],
      [1, 1],
      [2, 1],
    ]);
  });
});
