import { describe, expect, it } from "vitest";

import {
  applyPublicQueryPolicy,
  operationForQueryRoute,
} from "@/lib/edge/analytics/providers/d1/internal/router";

describe("D1 analytics route mapping", () => {
  it("keeps every protocol route mapped to its canonical operation", () => {
    const routes: Array<[string, string]> = [
      ["overview", "overview"],
      ["trend", "trend"],
      ["pages", "pages"],
      ["pages-dashboard", "pages-dashboard"],
      ["referrers", "referrers"],
      ["referrer-summary", "referrers"],
      ["filter-values", "filter-values"],
      ["overview-geo-points", "geo-points"],
      ["retention", "retention"],
      ["performance", "performance"],
      ["funnels", "funnel-analysis"],
      ["goal-summary", "goal-summary"],
      ["goal-timeseries", "goal-timeseries"],
      ["team-dashboard", "team-dashboard"],
      ["events-summary", "event-summary"],
      ["events-trend", "event-trend"],
      ["event-types", "event-types"],
      ["event-type-detail", "event-type-detail"],
      ["event-type-fields", "event-fields"],
      ["event-type-field-values", "event-field-values"],
      ["event-type-context", "event-context"],
      ["events-records", "event-records"],
      ["event-record-detail", "event-record-detail"],
      ["journey-event-detail", "journey-event-detail"],
      ["visitor-events", "visitor-events"],
      ["visitor-sessions", "visitor-sessions"],
      ["session-events", "session-events"],
      ["visitors", "visitors"],
      ["visitor-detail", "visitor-detail"],
      ["sessions", "sessions"],
      ["session-detail", "session-detail"],
      ["browser-version-breakdown", "radar"],
      ["browser-radar", "radar"],
      ["client-cross-breakdown", "cross-dimension"],
      ["browser-trend", "share-trend"],
      ["overview-source-channel", "channels"],
      ["overview-source-domain", "referrers"],
      ["unknown-dimension", "dimension"],
    ];

    for (const [route, operation] of routes) {
      expect(operationForQueryRoute(route), route).toBe(operation);
    }
  });

  it("sanitizes public query details without allowing hidden dimensions", () => {
    const sanitized = applyPublicQueryPolicy(
      new URL("https://app.test/share?details=1&fullUrl=1"),
    );
    expect(sanitized.allowed).toBe(true);
    expect(sanitized.url.search).toBe("");

    for (const url of [
      "https://app.test/share?query=secret",
      "https://app.test/share?sourceLink=secret",
      "https://app.test/share?filterKey=sourceLink",
      "https://app.test/share?primaryDimension=page.query",
    ]) {
      expect(applyPublicQueryPolicy(new URL(url)).allowed).toBe(false);
    }
    expect(
      applyPublicQueryPolicy(new URL("https://app.test/share")).allowed,
    ).toBe(true);
  });
});
