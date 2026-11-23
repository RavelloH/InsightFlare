// @vitest-environment node
import { describe, expect, it } from "vitest";

import { widgetConfigSchema, widgetRecordSchema } from "@/lib/widgets/contract";

const legacy = {
  title: "Legacy metric",
  type: "metric",
  metric: "views",
  range: "7d",
  timeZone: "UTC",
  locale: "en",
  theme: "auto",
  embedMode: "any",
  allowedOrigins: [],
  comparison: true,
  dimension: "page.path",
  limit: 5,
};

describe("widget P1/P2 configuration compatibility", () => {
  it("reads existing v1 records without any newly added configuration fields", () => {
    const parsed = widgetRecordSchema.parse({
      schemaVersion: 1,
      uuid: "11111111-1111-4111-8111-111111111111",
      teamId: "team",
      siteId: "site",
      draft: legacy,
      published: legacy,
      status: "published",
      revision: 1,
      createdAt: 1,
      updatedAt: 1,
    });
    expect(parsed.draft.rankingStyle).toBe("list");
    expect(parsed.draft.distributionStyle).toBe("bars");
    expect(parsed.draft.trendStyle).toBe("line");
    expect(parsed.published?.trendMetrics).toEqual([]);
    expect(parsed.draft.distributionDimension).toBe("client.deviceType");
    expect(parsed.draft.eventName).toBe("");
    expect(parsed.draft.geoProjection).toBe("flat");
  });

  it("accepts expanded metric, bar ranking, breakdown and multi-series trend", () => {
    expect(
      widgetConfigSchema.parse({ ...legacy, metric: "bounceRate" }).metric,
    ).toBe("bounceRate");
    expect(
      widgetConfigSchema.parse({
        ...legacy,
        type: "ranking",
        rankingStyle: "bars",
      }).rankingStyle,
    ).toBe("bars");
    expect(
      widgetConfigSchema.parse({
        ...legacy,
        type: "distribution",
        distributionDimension: "utm.source",
      }).type,
    ).toBe("distribution");
    expect(
      widgetConfigSchema.parse({
        ...legacy,
        type: "trend",
        trendMetrics: ["visitors", "views", "sessions"],
      }).trendMetrics,
    ).toHaveLength(3);
  });

  it("accepts category chart variants and disallows multi-metric area charts", () => {
    for (const style of ["bars", "donut", "ratio"] as const) {
      const actual = widgetConfigSchema.parse({
        ...legacy,
        type: "distribution",
        distributionStyle: style,
      });
      expect(actual.distributionStyle).toBe(style);
    }
    expect(
      widgetConfigSchema.parse({
        ...legacy,
        type: "trend",
        trendStyle: "area",
        trendMetrics: [],
      }).trendStyle,
    ).toBe("area");
    expect(
      widgetConfigSchema.safeParse({
        ...legacy,
        type: "trend",
        trendStyle: "area",
        trendMetrics: ["visitors", "views"],
      }).success,
    ).toBe(false);
  });

  it("rejects invalid metric combinations, duplicate series and absent conversion targets", () => {
    expect(
      widgetConfigSchema.safeParse({
        ...legacy,
        type: "ranking",
        metric: "bounceRate",
      }).success,
    ).toBe(false);
    expect(
      widgetConfigSchema.safeParse({
        ...legacy,
        type: "distribution",
        metric: "avgDurationMs",
      }).success,
    ).toBe(false);
    expect(
      widgetConfigSchema.safeParse({
        ...legacy,
        type: "trend",
        trendMetrics: ["views", "views"],
      }).success,
    ).toBe(false);
    expect(
      widgetConfigSchema.safeParse({
        ...legacy,
        type: "conversion",
        conversionKind: "event",
        eventName: "",
      }).success,
    ).toBe(false);
    expect(
      widgetConfigSchema.safeParse({
        ...legacy,
        type: "conversion",
        conversionKind: "goal",
        goalId: "",
      }).success,
    ).toBe(false);
    expect(
      widgetConfigSchema.safeParse({
        ...legacy,
        type: "conversion",
        conversionKind: "event",
        eventName: "sign_up",
      }).success,
    ).toBe(true);
    expect(
      widgetConfigSchema.safeParse({
        ...legacy,
        type: "conversion",
        conversionKind: "goal",
        goalId: "goal-1",
      }).success,
    ).toBe(true);
  });
});

describe("optional widget titles and page navigation", () => {
  it("accepts blank titles and defaults page navigation off for legacy records", () => {
    const result = widgetConfigSchema.parse({ ...legacy, title: "  " });
    expect(result.title).toBe("");
    expect(result.pageLinksEnabled).toBe(false);
    expect(
      widgetConfigSchema.parse({ ...legacy, title: "", pageLinksEnabled: true })
        .pageLinksEnabled,
    ).toBe(true);
    expect(
      widgetConfigSchema.safeParse({ ...legacy, pageLinksEnabled: "true" })
        .success,
    ).toBe(false);
  });
});
