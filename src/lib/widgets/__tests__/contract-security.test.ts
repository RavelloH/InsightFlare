// @vitest-environment node
import { describe, expect, it } from "vitest";

import {
  normalizeWidgetOrigin,
  suggestedWidgetHeight,
  widgetConfigSchema,
  widgetRecordSchema,
  widgetUuidSchema,
} from "@/lib/widgets/contract";

const base = {
  title: "Traffic",
  type: "metric",
  metric: "visitors",
  range: "7d",
  timeZone: "UTC",
  locale: "en",
  theme: "auto",
  embedMode: "restricted",
  allowedOrigins: ["https://example.test"],
  comparison: true,
  dimension: "page.path",
  limit: 5,
} as const;

describe("public widget configuration layout contracts", () => {
  it.each([
    [{ type: "metric", limit: 5 }, 160],
    [{ type: "realtime", realtimeLayout: "badge", limit: 5 }, 54],
    [
      {
        type: "realtime",
        realtimeLayout: "map",
        geoProjection: "flat",
        limit: 5,
      },
      270,
    ],
    [
      {
        type: "realtime",
        realtimeLayout: "map",
        geoProjection: "globe",
        limit: 5,
      },
      295,
    ],
    [{ type: "realtime", realtimeLayout: "pages", limit: 5 }, 240],
    [{ type: "realtime", realtimeLayout: "pages", limit: 10 }, 380],
    [{ type: "realtime", realtimeLayout: "trend", limit: 5 }, 260],
    [{ type: "geo", geoProjection: "flat", limit: 5 }, 250],
    [{ type: "geo", geoProjection: "globe", limit: 5 }, 275],
    [{ type: "trend", limit: 5 }, 320],
    [{ type: "conversion", limit: 5 }, 320],
    [{ type: "distribution", distributionStyle: "donut", limit: 5 }, 310],
    [{ type: "distribution", distributionStyle: "ratio", limit: 5 }, 240],
    [{ type: "distribution", distributionStyle: "bars", limit: 5 }, 280],
    [{ type: "distribution", distributionStyle: "bars", limit: 10 }, 420],
    [{ type: "ranking", limit: 5 }, 300],
    [{ type: "ranking", limit: 10 }, 460],
  ] as const)(
    "suggests a bounded container height for %j",
    (config, expected) => {
      expect(suggestedWidgetHeight(config)).toBe(expected);
    },
  );

  it.each([
    [" https://SITE.example/ ", "https://site.example"],
    ["http://localhost:3000", "http://localhost:3000"],
    ["https://site.example", "https://site.example"],
  ])("canonicalizes an allowed embed origin %s", (source, expected) => {
    expect(normalizeWidgetOrigin(source)).toBe(expected);
  });

  it.each([
    "javascript:alert(1)",
    "https://example.test/path",
    "https://example.test?user=secret",
    "https://example.test#fragment",
    "https://*.example.test",
    "https://example.test%2f.evil",
    "https://user:password@example.test",
    "ftp://example.test",
    "https://example.test:bad",
  ])("rejects invalid or unsafe origin %s", (source) => {
    expect(normalizeWidgetOrigin(source)).toBeNull();
  });

  it("normalizes duplicate allowed origins to one canonical permitted source", () => {
    const result = widgetConfigSchema.parse({
      ...base,
      allowedOrigins: [" https://EXAMPLE.test/ ", "https://example.test"],
    });
    expect(result.allowedOrigins).toEqual(["https://example.test"]);
  });

  it("rejects restricted embedding without an origin and unsafe wildcard origins", () => {
    expect(
      widgetConfigSchema.safeParse({ ...base, allowedOrigins: [] }).success,
    ).toBe(false);
    expect(
      widgetConfigSchema.safeParse({
        ...base,
        allowedOrigins: ["https://*.example.test"],
      }).success,
    ).toBe(false);
  });

  it("rejects unexpected configuration properties and duplicate trend metrics", () => {
    expect(
      widgetConfigSchema.safeParse({ ...base, exposePrivateData: true })
        .success,
    ).toBe(false);
    expect(
      widgetConfigSchema.safeParse({
        ...base,
        type: "trend",
        trendMetrics: ["views", "views"],
      }).success,
    ).toBe(false);
  });

  it("accepts only a structurally valid v4 UUID and emits lower-case public IDs", () => {
    expect(widgetUuidSchema.parse("11111111-1111-4111-8111-111111111AAA")).toBe(
      "11111111-1111-4111-8111-111111111aaa",
    );
    expect(
      widgetUuidSchema.safeParse("11111111-1111-1111-1111-111111111111")
        .success,
    ).toBe(false);
  });

  it("keeps publication status and persisted configuration consistent", () => {
    const published = widgetConfigSchema.parse(base);
    const record = {
      schemaVersion: 1,
      uuid: "11111111-1111-4111-8111-111111111111",
      teamId: "team-a",
      siteId: "site-a",
      draft: published,
      published,
      status: "published",
      revision: 1,
      createdAt: 1,
      updatedAt: 1,
    };
    expect(widgetRecordSchema.safeParse(record).success).toBe(true);
    expect(
      widgetRecordSchema.safeParse({
        ...record,
        status: "draft",
        published,
      }).success,
    ).toBe(false);
    expect(
      widgetRecordSchema.safeParse({
        ...record,
        status: "published",
        published: null,
      }).success,
    ).toBe(false);
    expect(
      widgetRecordSchema.safeParse({
        ...record,
        status: "draft",
        published: null,
      }).success,
    ).toBe(true);
  });
});
