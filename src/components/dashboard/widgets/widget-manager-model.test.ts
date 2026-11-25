import { afterEach, describe, expect, it, vi } from "vitest";

import { getSessionToken } from "@/lib/auth";
import { readReportingTimeZoneFromCookie } from "@/lib/dashboard/query-preferences";
import { type WidgetConfig, widgetConfigSchema } from "@/lib/widgets/contract";

import { widgetLabels } from "./labels";
import {
  defaultAllowedOrigin,
  defaultConfig,
  defaultTimeZone,
  displayType,
  errorMessage,
  htmlAttribute,
  metricLabel,
  statusLabel,
  widgetEmbedSnippet,
  widgetParameters,
  widgetRequest,
} from "./widget-manager-model";

vi.mock("@/lib/auth", () => ({ getSessionToken: vi.fn() }));
vi.mock("@/lib/dashboard/query-preferences", () => ({
  readReportingTimeZoneFromCookie: vi.fn(() => "Asia/Shanghai"),
}));

const copy = widgetLabels("en");

function config(overrides: Partial<WidgetConfig> = {}): WidgetConfig {
  return widgetConfigSchema.parse({
    ...defaultConfig("en", "example.com"),
    ...overrides,
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("widget editor defaults", () => {
  it("derives a restricted, valid default configuration from the site", () => {
    const value = defaultConfig("zh", "example.com");
    expect(value).toMatchObject({
      locale: "zh",
      timeZone: "Asia/Shanghai",
      embedMode: "restricted",
      allowedOrigins: ["https://example.com"],
    });
    expect(widgetConfigSchema.safeParse(value).success).toBe(true);
  });

  it("falls back to UTC when the reporting time zone cannot be read", () => {
    vi.mocked(readReportingTimeZoneFromCookie).mockImplementationOnce(() => {
      throw new Error("bad cookie");
    });
    expect(defaultTimeZone()).toBe("UTC");
  });

  it("normalizes site domains into embed origins", () => {
    expect(defaultAllowedOrigin("  ")).toEqual([]);
    expect(defaultAllowedOrigin("http://example.com:8080/")).toEqual([
      "http://example.com:8080",
    ]);
    expect(defaultAllowedOrigin("example.com/path")).toEqual([]);
  });

  it("prefers an error's own message", () => {
    expect(errorMessage(new Error("boom"), "fallback")).toBe("boom");
    expect(errorMessage(new Error(""), "fallback")).toBe("fallback");
    expect(errorMessage("text", "fallback")).toBe("fallback");
  });
});

describe("widget management requests", () => {
  it("sends authenticated JSON for writes and no body for reads", async () => {
    vi.mocked(getSessionToken).mockResolvedValue("token");
    const fetch = vi.fn(async () => Response.json({ data: 1 }));
    vi.stubGlobal("fetch", fetch);
    await expect(widgetRequest("/w", "POST")).resolves.toEqual({ data: 1 });
    const [, post] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    const headers = post.headers as Headers;
    expect(headers.get("authorization")).toBe("Bearer token");
    expect(headers.get("content-type")).toBe("application/json");
    expect(post.body).toBe("{}");
    expect(post.cache).toBe("no-store");

    vi.mocked(getSessionToken).mockResolvedValue("");
    await widgetRequest("/w", "DELETE");
    const [, remove] = fetch.mock.calls[1] as unknown as [string, RequestInit];
    expect((remove.headers as Headers).has("authorization")).toBe(false);
    expect((remove.headers as Headers).has("content-type")).toBe(false);
    expect(remove.body).toBeUndefined();
  });

  it("surfaces the server message or a status fallback", async () => {
    vi.mocked(getSessionToken).mockResolvedValue("");
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(
          Response.json({ message: "Denied" }, { status: 403 }),
        )
        .mockResolvedValueOnce(new Response("not json", { status: 500 })),
    );
    await expect(widgetRequest("/w", "GET")).rejects.toThrow("Denied");
    await expect(widgetRequest("/w", "PUT", { a: 1 })).rejects.toThrow(
      "Widget request failed (500)",
    );
  });
});

describe("widget embed snippet", () => {
  it("escapes attributes and pairs the iframe with the auto-height loader", () => {
    const snippet = widgetEmbedSnippet({
      origin: "https://insight.example",
      path: "/en/widget/abc",
      config: config(),
      title: `Visitors "<live>" & more`,
    });
    const [iframe, script] = snippet.split("\n");
    expect(iframe).toBe(
      '<iframe src="https://insight.example/en/widget/abc" title="Visitors &quot;&lt;live&gt;&quot; &amp; more" width="100%" height="160" loading="lazy" style="border:0" data-insightflare-widget></iframe>',
    );
    expect(script).toBe(
      '<script src="https://insight.example/api/public/widgets/embed.js" async></script>',
    );
    expect(htmlAttribute(`a&"<>`)).toBe("a&amp;&quot;&lt;&gt;");
  });
});

describe("widget labels", () => {
  it.each([
    ["metric", copy.metricType],
    ["trend", copy.trendType],
    ["ranking", copy.rankingType],
    ["distribution", copy.distributionType],
    ["conversion", copy.conversionType],
    ["geo", copy.geoType],
    ["realtime", copy.realtimeType],
  ] as const)("names the %s type", (type, label) => {
    expect(displayType(type, copy)).toBe(label);
  });

  it("names publication states and metrics", () => {
    expect(statusLabel("published", copy)).toBe(copy.statusPublished);
    expect(statusLabel("unpublished", copy)).toBe(copy.statusUnpublished);
    expect(statusLabel("draft", copy)).toBe(copy.statusDraft);
    for (const [metric, label] of [
      ["visitors", copy.visitors],
      ["views", copy.views],
      ["sessions", copy.sessions],
      ["bounces", copy.bounces],
      ["bounceRate", copy.bounceRate],
      ["avgDurationMs", copy.avgDurationMs],
      ["viewsPerSession", copy.viewsPerSession],
      ["events", copy.events],
    ] as const) {
      expect(metricLabel(metric, copy)).toBe(label);
    }
  });
});

describe("widget parameter summaries", () => {
  const summary = (overrides: Partial<WidgetConfig>) =>
    widgetParameters(config(overrides), copy).split(" · ");

  it("summarizes metric widgets with an optional comparison", () => {
    expect(summary({ comparison: true })).toEqual([
      copy.metricType,
      copy.visitors,
      copy.thirtyDays,
      copy.comparison,
    ]);
    expect(summary({ comparison: false, range: "7d" })).toEqual([
      copy.metricType,
      copy.visitors,
      copy.sevenDays,
    ]);
  });

  it("summarizes realtime layouts", () => {
    const realtime = (overrides: Partial<WidgetConfig>) =>
      summary({ type: "realtime", ...overrides })[1];
    expect(realtime({ realtimeLayout: "badge" })).toBe(copy.realtimeBadge);
    expect(realtime({ realtimeLayout: "trend" })).toBe(copy.realtimeTrend);
    expect(realtime({ realtimeLayout: "pages" })).toBe(copy.realtimePages);
    expect(realtime({ realtimeLayout: "map", geoProjection: "globe" })).toBe(
      copy.geoGlobe,
    );
    expect(realtime({ realtimeLayout: "map", geoProjection: "flat" })).toBe(
      copy.geoFlat,
    );
    expect(summary({ type: "realtime" })).toContain("30s");
  });

  it("summarizes ranking dimensions and styles", () => {
    expect(summary({ type: "ranking", dimension: "page.path" })).toContain(
      copy.pagePath,
    );
    expect(summary({ type: "ranking", dimension: "source.domain" })).toContain(
      copy.sourceDomain,
    );
    const country = summary({
      type: "ranking",
      dimension: "geo.country",
      limit: 10,
      rankingStyle: "bars",
    });
    expect(country).toContain(copy.country);
    expect(country).toContain(`${copy.limit}: 10`);
    expect(country).toContain(copy.rankingBars);
  });

  it.each([
    ["bars", "client.deviceType", copy.distributionBars, copy.deviceType],
    ["donut", "client.browser", copy.distributionDonut, copy.browser],
    ["ratio", "utm.source", copy.distributionRatio, copy.utmSource],
    ["bars", "source.domain", copy.distributionBars, copy.sourceDomain],
  ] as const)(
    "summarizes %s distributions by %s",
    (distributionStyle, distributionDimension, style, dimension) => {
      const parts = summary({
        type: "distribution",
        distributionStyle,
        distributionDimension,
      });
      expect(parts).toContain(style);
      expect(parts).toContain(dimension);
    },
  );

  it("summarizes geo, trend and conversion options", () => {
    expect(summary({ type: "geo", geoProjection: "globe" })).toContain(
      copy.geoGlobe,
    );
    expect(summary({ type: "geo", geoProjection: "flat" })).toContain(
      copy.geoFlat,
    );
    expect(summary({ type: "trend", trendStyle: "area" })).toContain(
      copy.trendArea,
    );
    const multi = summary({
      type: "trend",
      trendStyle: "line",
      trendMetrics: ["visitors", "views"],
    });
    expect(multi).toContain(copy.trendLine);
    expect(multi).toContain(`${copy.visitors} / ${copy.views}`);
    expect(
      summary({
        type: "conversion",
        metric: "events",
        conversionKind: "event",
        eventName: "signup",
      }),
    ).toContain(`${copy.eventConversion}: signup`);
    expect(
      summary({
        type: "conversion",
        metric: "events",
        conversionKind: "goal",
        goalId: "goal-1",
      }),
    ).toContain(copy.goalConversion);
  });
});
