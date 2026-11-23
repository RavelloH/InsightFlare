import { describe, expect, it } from "vitest";

import { widgetTemplateConfig } from "@/components/dashboard/widgets/widget-templates";
import { widgetConfigSchema } from "@/lib/widgets/contract";

const baseline = widgetConfigSchema.parse({
  title: "Sample",
  type: "metric",
  metric: "visitors",
  range: "7d",
  timeZone: "UTC",
  locale: "zh",
  theme: "auto",
  embedMode: "any",
  allowedOrigins: [],
  comparison: true,
  dimension: "page.path",
  limit: 5,
});

describe("widget layout templates", () => {
  it("creates valid, independent starting points for five immediately previewable layouts", () => {
    const options = [
      "metric",
      "trend",
      "comparison",
      "ranking",
      "distribution",
      "donut",
      "ratio",
      "area",
      "geo",
      "realtimeBadge",
      "realtimeTrend",
      "realtimeMap",
    ] as const;
    for (const id of options) {
      const next = widgetTemplateConfig(baseline, id);
      expect(widgetConfigSchema.safeParse(next).success, id).toBe(true);
      expect(next).not.toBe(baseline);
    }
    expect(widgetTemplateConfig(baseline, "comparison").trendMetrics).toEqual([
      "visitors",
      "views",
      "sessions",
    ]);
    expect(widgetTemplateConfig(baseline, "ranking").rankingStyle).toBe("list");
    expect(
      widgetTemplateConfig(baseline, "distribution").distributionDimension,
    ).toBe("client.deviceType");
    expect(widgetTemplateConfig(baseline, "realtimeMap").geoProjection).toBe(
      "globe",
    );
    expect(widgetTemplateConfig(baseline, "donut").distributionStyle).toBe(
      "donut",
    );
    expect(widgetTemplateConfig(baseline, "ratio").distributionStyle).toBe(
      "ratio",
    );
    expect(widgetTemplateConfig(baseline, "area").trendStyle).toBe("area");
    expect(baseline.type).toBe("metric");
  });

  it("keeps conversion targets blank until explicitly selected", () => {
    const next = widgetTemplateConfig(baseline, "conversion");
    expect(next).toMatchObject({
      type: "conversion",
      conversionKind: "event",
      eventName: "",
    });
    expect(widgetConfigSchema.safeParse(next).success).toBe(false);
    expect(
      widgetConfigSchema.safeParse({ ...next, eventName: "sign_up" }).success,
    ).toBe(true);
  });
});
