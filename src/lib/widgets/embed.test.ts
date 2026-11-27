// @vitest-environment node
import { describe, expect, it } from "vitest";

import type { WidgetConfig, WidgetData } from "@/lib/widgets/contract";
import {
  renderWidgetDocument,
  renderWidgetPlaceholder,
  widgetDocumentCsp,
} from "@/lib/widgets/embed";
import { widgetStylesheet } from "@/lib/widgets/embed-style";

const config: WidgetConfig = {
  title: "Test widget",
  type: "metric",
  metric: "visitors",
  range: "7d",
  timeZone: "UTC",
  locale: "en",
  theme: "auto",
  embedMode: "any",
  allowedOrigins: [],
  comparison: true,
  dimension: "page.path",
  limit: 5,
  rankingStyle: "list",
  pageLinksEnabled: false,
  distributionStyle: "bars",
  trendStyle: "line",
  distributionDimension: "client.deviceType",
  trendMetrics: [],
  conversionKind: "event",
  eventName: "",
  goalId: "",
  geoProjection: "flat",
  realtimeLayout: "badge",
};

const previewData: WidgetData = {
  type: "metric",
  metric: "visitors",
  value: 42,
  change: 0.1,
  from: 0,
  to: 1,
  timeZone: "UTC",
  updatedAt: 1,
};

describe("widget preview auto-height", () => {
  it("renders squared widgets without a visible updated-at footer", () => {
    const html = renderWidgetDocument({
      uuid: "11111111-1111-4111-8111-111111111111",
      config,
    });
    expect(html).toContain("border-radius: 0;");
    expect(html).toMatch(/\.widget__realtime-badge\s*\{[^}]*border-radius: 0;/);
    expect(html).toContain(".widget__row::before");
    expect(html).not.toContain("widget__footer");
    expect(html).not.toContain("widget-footer");
  });

  it("enables a scoped height reporter for list previews", () => {
    const html = renderWidgetDocument({
      uuid: "11111111-1111-4111-8111-111111111111",
      config,
      preview: true,
      autoHeight: true,
      previewData,
    });
    expect(html).toContain(
      '<html lang="en" data-theme="auto" data-auto-height="true">',
    );
    expect(html).toContain('data-preview="true" data-auto-height="true"');
    expect(html).toContain("insightflare-widget-height");
    expect(html).toContain("new ResizeObserver(reportHeight).observe(root)");
    expect(html).toContain('html[data-auto-height="true"] .widget__inner');
  });

  it("does not opt ordinary or public widget documents into intrinsic height", () => {
    for (const input of [
      { preview: true, previewData },
      { preview: false, autoHeight: true },
      {},
    ]) {
      const html = renderWidgetDocument({
        uuid: "11111111-1111-4111-8111-111111111111",
        config,
        ...input,
      });
      expect(html).not.toMatch(/<html[^>]*data-auto-height/);
      expect(html).not.toContain('data-preview="true" data-auto-height');
      expect(html).not.toContain('data-preview="false" data-auto-height');
    }
  });
});

describe("refined widget visuals", () => {
  it("renders independently colored trend strokes and legend colors", () => {
    const trend: WidgetData = {
      ...previewData,
      type: "trend",
      metric: "visitors",
      points: [{ timestampMs: 1, value: 1 }],
      series: [
        { metric: "visitors", points: [{ timestampMs: 1, value: 1 }] },
        { metric: "views", points: [{ timestampMs: 1, value: 2 }] },
        { metric: "sessions", points: [{ timestampMs: 1, value: 3 }] },
      ],
    };
    const html = renderWidgetDocument({
      uuid: "11111111-1111-4111-8111-111111111111",
      config: {
        ...config,
        type: "trend",
        trendMetrics: ["visitors", "views", "sessions"],
      },
      preview: true,
      previewData: trend,
    });
    expect(html).toContain("path.style.stroke = lineColor");
    expect(html).toContain("paletteColor(i, series.length)");
    expect(html).toContain("--widget-palette-3-2:");
    expect(html).toContain("--widget-palette-3-3:");
    expect(html).not.toContain("@font-face");
  });

  it("allows a public route locale to override a widget's stored locale without changing the original", () => {
    const html = renderWidgetDocument({
      uuid: "11111111-1111-4111-8111-111111111111",
      config,
      localeOverride: "ja",
    });
    expect(html).toContain('<html lang="ja"');
    expect(html).toContain('data-locale="ja"');
    expect(html).toContain("過去7日間");
    expect(config.locale).toBe("en");
  });

  it("references cacheable same-origin assets in the real public embed", () => {
    const html = renderWidgetDocument({
      uuid: "11111111-1111-4111-8111-111111111111",
      config,
      assets: { stylesheet: "/assets/widget.css", script: "/assets/widget.js" },
    });
    expect(html).toContain('<link rel="stylesheet" href="/assets/widget.css">');
    expect(html).toContain('<script src="/assets/widget.js"></script>');
    expect(html).not.toContain("<style>");
    expect(html).not.toContain("<script>");
    expect(widgetStylesheet({ webfont: true })).toContain("@font-face");
    expect(widgetStylesheet({ webfont: false })).not.toContain("@font-face");
  });

  it("keeps previews self-contained even when assets are supplied", () => {
    const html = renderWidgetDocument({
      uuid: "11111111-1111-4111-8111-111111111111",
      config,
      preview: true,
      previewData,
      assets: { stylesheet: "/assets/widget.css", script: "/assets/widget.js" },
    });
    expect(html).not.toContain("/assets/widget.");
    expect(html).toContain("<style>");
    expect(html).toContain("<script>");
  });
});

describe("geographic widget rendering and CSP isolation", () => {
  const geoConfig: WidgetConfig = {
    ...config,
    type: "geo",
    geoProjection: "flat",
  };
  const geoData: WidgetData = {
    ...previewData,
    type: "geo",
    points: [{ country: "US", lat: 39.54, lon: -97.48, value: 35 }],
    unmapped: 3,
  };

  it("keeps the land-dot mask and map renderer out of non-geo widgets", () => {
    const normal = renderWidgetDocument({
      uuid: "11111111-1111-4111-8111-111111111111",
      config,
    });
    expect(normal).not.toContain("var geoLand");
    expect(normal).not.toContain("function renderGeo(data)");
    expect(widgetDocumentCsp("*")).toContain("script-src 'self'");
    expect(widgetDocumentCsp("*")).toContain("style-src 'self'");
    expect(widgetDocumentCsp("*")).not.toContain("unsafe-inline");
  });

  it("renders only one self-contained country map script", () => {
    const html = renderWidgetDocument({
      uuid: "11111111-1111-4111-8111-111111111111",
      config: geoConfig,
      preview: true,
      previewData: geoData,
    });
    expect(html).toContain("var geoLand = {");
    expect(html).toContain('data-geo-projection="flat"');
    expect(html).toContain("function renderGeo(data)");
    expect(html).not.toContain("widget__geo-summary");
    expect(html).not.toContain("widget__geo-note");
    expect(html).toContain("widget__geo-tooltip");
    expect(html.match(/<script>/g)).toHaveLength(1);
  });

  it("renders the globe mode with the same country data without external map scripts", () => {
    const html = renderWidgetDocument({
      uuid: "11111111-1111-4111-8111-111111111111",
      config: { ...geoConfig, geoProjection: "globe" },
      preview: true,
      previewData: geoData,
    });
    expect(html).toContain('data-geo-projection="globe"');
    expect(html).toContain("var geoLand");
    expect(html).not.toContain("maplibre");
    expect(html).not.toContain("deck.gl");
  });
});

describe("realtime iframe presentation", () => {
  const realtimeBase: WidgetConfig = {
    ...config,
    type: "realtime",
    metric: "visitors",
    realtimeLayout: "badge",
  };
  const realtimeData: WidgetData = {
    ...previewData,
    type: "realtime",
    metric: "visitors",
    activeNow: 42,
    points: [],
    rows: [],
    bars: Array.from({ length: 30 }, (_, index) => ({
      minute: index * 60_000,
      visitors: index % 7,
      views: index % 9,
    })),
  };
  it("keeps the inline badge compact in the embedded document", () => {
    const html = renderWidgetDocument({
      uuid: "11111111-1111-4111-8111-111111111111",
      config: realtimeBase,
      preview: true,
      previewData: realtimeData,
    });
    expect(html).toContain('data-realtime-layout="badge"');
    expect(html).toContain("widget__realtime-badge");
    expect(html).toContain("function renderRealtime(data)");
    expect(html).toContain("refreshIntervalMs = 30000");
  });
  it("supports the 30-bar chart, map and page layouts without changing the active count", () => {
    for (const layout of ["trend", "map", "pages"] as const) {
      const html = renderWidgetDocument({
        uuid: "11111111-1111-4111-8111-111111111111",
        config: { ...realtimeBase, realtimeLayout: layout },
        preview: true,
        previewData: realtimeData,
      });
      expect(html).toContain(`data-realtime-layout="${layout}"`);
      expect(html).toContain("renderRealtime(data)");
      expect(html).toContain("renderers.geo = renderGeo");
    }
  });
});

describe("lightweight chart widgets", () => {
  const data: WidgetData = {
    ...previewData,
    type: "distribution",
    rows: [
      { label: "Desktop", value: 75, percent: 0.75 },
      { label: "Mobile", value: 25, percent: 0.25 },
    ],
  };

  it("renders donut and ratio layouts using the shared distribution payload", () => {
    for (const distributionStyle of ["donut", "ratio", "bars"] as const) {
      const html = renderWidgetDocument({
        uuid: "11111111-1111-4111-8111-111111111111",
        config: { ...config, type: "distribution", distributionStyle },
        preview: true,
        previewData: data,
      });
      expect(html).toContain(`data-distribution-style="${distributionStyle}"`);
      expect(html).toContain("function renderDonut(data)");
      expect(html).toContain("function renderRatio(data)");
      expect(html).not.toContain("function renderGeo(data)");
    }
  });

  it("provides a distinct area-chart gradient without changing ordinary line charts", () => {
    const trend: WidgetData = {
      ...previewData,
      type: "trend",
      points: [
        { timestampMs: 1, value: 12 },
        { timestampMs: 2, value: 25 },
      ],
    };
    const build = (trendStyle: "line" | "area") =>
      renderWidgetDocument({
        uuid: "11111111-1111-4111-8111-111111111111",
        config: { ...config, type: "trend", trendStyle },
        preview: true,
        previewData: trend,
      });
    expect(build("area")).toContain('data-trend-style="area"');
    expect(build("area")).toContain("widget-trend-area-gradient");
    expect(build("line")).toContain('data-trend-style="line"');
  });
});

describe("automatic preview locale, optional titles and trusted path links", () => {
  it("hides an empty title and uses the app locale override without redirecting", () => {
    const html = renderWidgetDocument({
      uuid: "11111111-1111-4111-8111-111111111111",
      config: { ...config, title: "", locale: "en" },
      localeOverride: "zh",
      preview: true,
      previewData,
    });
    expect(html).toContain('<html lang="zh"');
    expect(html).toContain('data-locale="zh"');
    expect(html).not.toContain('class="widget__title"');
    expect(html).toContain('class="widget__period"');
  });

  it("allows only opted-in page links to the server-selected site origin", () => {
    const make = (enabled: boolean) =>
      renderWidgetDocument({
        uuid: "11111111-1111-4111-8111-111111111111",
        config: {
          ...config,
          type: "ranking",
          title: "",
          dimension: "page.path",
          pageLinksEnabled: enabled,
        },
        siteOrigin: "https://example.com",
        preview: true,
        previewData: {
          ...previewData,
          type: "ranking",
          rows: [{ label: "/docs", value: 42 }],
        },
      });
    expect(make(false)).toContain('data-page-links-enabled="false"');
    expect(make(false)).toContain('data-site-origin=""');
    expect(make(true)).toContain('data-site-origin="https://example.com"');
    expect(make(true)).toContain('rel = "noopener noreferrer"');
    expect(make(true)).toContain("function pathHref(rawPath)");
  });
});

describe("public embed escaping and frame-ancestor security", () => {
  const statusCases = [
    "not-found",
    "unpublished",
    "domain-denied",
    "unavailable",
  ] as const;

  it.each(statusCases)(
    "returns a localized, noninteractive placeholder for %s",
    (status) => {
      for (const locale of ["en", "zh", "zh-tw", "ja"] as const) {
        const html = renderWidgetPlaceholder(status, locale);
        expect(html).toContain(`<html lang="${locale}"`);
        expect(html).toContain('role="status"');
        // CSP is set by the HTTP response, not embedded as a meta element.
        expect(html).not.toContain("<script");
        expect(html).not.toContain('data-uuid="');
        expect(html).not.toContain("function renderRealtime");
      }
    },
  );

  it("deduplicates explicitly allowed ancestors without broadening their policy", () => {
    const csp = widgetDocumentCsp(
      "https://portal.example https://portal.example https://embed.example",
    );
    expect(csp).toContain(
      "frame-ancestors https://portal.example https://embed.example",
    );
    expect(csp).not.toContain("frame-ancestors *");
  });

  it("gives an explicit deny-all ancestor precedence over ordinary domains", () => {
    expect(widgetDocumentCsp("https://portal.example 'none'")).toContain(
      "frame-ancestors 'none'",
    );
    expect(widgetDocumentCsp("* 'none'")).toContain("frame-ancestors *");
  });

  it.each([
    "javascript:alert(1)",
    "ftp://example.test",
    "https://valid.test/extra-path",
    "https://user:password@valid.test",
    "not a URL",
    "",
  ])("drops unsafe iframe ancestor source %s", (ancestor) => {
    expect(widgetDocumentCsp(ancestor)).toContain("frame-ancestors 'none'");
  });

  it("supports explicit self-embedding without allowing arbitrary origins", () => {
    const csp = widgetDocumentCsp("'self'");
    expect(csp).toContain("frame-ancestors 'self'");
    expect(csp).not.toContain("frame-ancestors *");
  });

  it("escapes all dangerous HTML punctuation in titles and visitor-controlled preview labels", () => {
    const malicious = '</script><img src=x onerror="alert(1)">&\u2028\u2029';
    const html = renderWidgetDocument({
      uuid: "11111111-1111-4111-8111-111111111111",
      config: {
        ...config,
        type: "ranking",
        pageLinksEnabled: true,
        title: "<>&\"' visitor",
        range: "30d",
      },
      preview: true,
      previewData: {
        ...previewData,
        type: "ranking",
        rows: [{ label: malicious, value: 8 }],
      },
      siteOrigin: "https://example.test?x=1&y=2",
      themeOverride: "dark",
    });
    expect(html).toContain("&lt;&gt;&amp;&quot;&#39; visitor");
    expect(html).toContain('data-theme="dark"');
    expect(html).toContain("Last 30 days");
    expect(html).not.toContain(malicious);
    expect(html).toContain("\\u003c/script\\u003e");
    expect(html).toContain("\\u0026");
    expect(html).toContain("\\u2028");
    expect(html).toContain("\\u2029");
    expect(html).toContain("https://example.test?x=1&amp;y=2");
  });
});
