import { afterEach, describe, expect, it, vi } from "vitest";

import {
  WIDGET_SCRIPT_VARIANTS,
  widgetClientScript,
} from "@/lib/widgets/client/scripts";
import {
  type WidgetConfig,
  widgetConfigSchema,
  type WidgetData,
} from "@/lib/widgets/contract";
import { renderWidgetDocument } from "@/lib/widgets/embed";
import { WIDGET_EMBED_MESSAGES } from "@/lib/widgets/embed-messages";

// The host-page loader ships as a static file at a stable URL.
import WIDGET_EMBED_LOADER from "../../../../public/widgets/embed.js?raw";

const uuid = "11111111-1111-4111-8111-111111111111";
const base = {
  from: 0,
  to: 1,
  timeZone: "UTC",
  updatedAt: 1,
};

function config(overrides: Partial<WidgetConfig>): WidgetConfig {
  return widgetConfigSchema.parse({
    title: "Widget",
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
    ...overrides,
  });
}

/** Loads a rendered widget document into the test DOM and runs its script. */
function run(html: string) {
  const parsed = new DOMParser().parseFromString(html, "text/html");
  const scripts = Array.from(parsed.querySelectorAll("script"));
  const executable = scripts.find((script) => !script.type);
  for (const script of scripts) if (!script.type) script.remove();
  document.body.innerHTML = parsed.body.innerHTML;
  // Indirect eval runs the classic, non-module script in global scope.
  (0, eval)(executable?.textContent ?? "");
}

function renderPreview(widget: WidgetConfig, data: WidgetData) {
  run(
    renderWidgetDocument({
      uuid,
      config: widget,
      preview: true,
      previewData: data,
    }),
  );
}

const content = () => document.getElementById("widget-content")!;
const status = () => document.getElementById("widget-status")!;

afterEach(() => {
  document.body.innerHTML = "";
  vi.unstubAllGlobals();
});

describe("composed widget client scripts", () => {
  it("only references message keys that every locale defines", () => {
    const keys = new Set(Object.keys(WIDGET_EMBED_MESSAGES.en));
    for (const locale of Object.values(WIDGET_EMBED_MESSAGES)) {
      expect(new Set(Object.keys(locale))).toEqual(keys);
    }
    for (const variant of WIDGET_SCRIPT_VARIANTS) {
      const referenced = [
        ...widgetClientScript(variant).matchAll(/\bmessages\.(\w+)/g),
      ].map((match) => match[1]!);
      expect(referenced.length).toBeGreaterThan(0);
      for (const key of referenced) expect(keys).toContain(key);
    }
  });

  it("registers exactly the renderers each variant needs", () => {
    const registered = (variant: (typeof WIDGET_SCRIPT_VARIANTS)[number]) =>
      [...widgetClientScript(variant).matchAll(/renderers\.(\w+) =/g)].map(
        (match) => match[1],
      );
    expect(registered("base")).toEqual([]);
    expect(registered("breakdown")).toEqual(["distribution"]);
    expect(registered("geo")).toEqual(["geo"]);
    expect(registered("realtime")).toEqual(["geo", "realtime"]);
  });

  it("renders a metric with its comparison", () => {
    renderPreview(config({}), {
      ...base,
      type: "metric",
      metric: "visitors",
      value: 42,
      change: 0.1,
    });
    expect(content().querySelector(".widget__value")?.textContent).toBe("42");
    const change = content().querySelector(".widget__change");
    expect(change?.getAttribute("data-direction")).toBe("up");
    expect(change?.getAttribute("aria-label")).toBe(
      WIDGET_EMBED_MESSAGES.en.percentageChange,
    );
    expect(status().hidden).toBe(true);
  });

  it("renders trend charts with a defined accessible label", () => {
    renderPreview(config({ type: "trend" }), {
      ...base,
      type: "trend",
      metric: "visitors",
      points: [
        { timestampMs: 1, value: 3 },
        { timestampMs: 2, value: 5 },
      ],
    });
    const chart = content().querySelector("svg.widget__chart");
    expect(chart?.getAttribute("aria-label")).toBe(
      `${WIDGET_EMBED_MESSAGES.en.chartDescription}: ${WIDGET_EMBED_MESSAGES.en.visitors}`,
    );
  });

  it("stretches every line chart and frames it with an axis and dates", () => {
    const points = [
      { timestampMs: Date.UTC(2026, 0, 1), value: 3 },
      { timestampMs: Date.UTC(2026, 0, 7), value: 5 },
    ];
    const axisTicks = () =>
      Array.from(content().querySelectorAll(".widget__axis span")).map(
        (tick) => tick.textContent,
      );

    renderPreview(config({ type: "trend" }), {
      ...base,
      type: "trend",
      metric: "visitors",
      points,
    });
    const svg = content().querySelector("svg.widget__chart")!;
    expect(svg.getAttribute("preserveAspectRatio")).toBe("none");
    expect(axisTicks()).toEqual(["6", "3", "0"]);
    // Dates sit in the plot column of the same grid as the axis.
    const grid = content().querySelector(".widget__trend-grid")!;
    expect(grid.lastElementChild?.className).toBe("widget__chart-labels");
    expect(grid.lastElementChild?.textContent).toBe("Jan 1Jan 7");

    renderPreview(
      config({ type: "trend", trendMetrics: ["visitors", "views"] }),
      {
        ...base,
        type: "trend",
        metric: "visitors",
        points,
        series: [
          { metric: "visitors", points },
          {
            metric: "views",
            points: points.map((p) => ({ ...p, value: 9 })),
          },
        ],
      },
    );
    expect(content().querySelectorAll("polyline")).toHaveLength(2);
    expect(axisTicks()).toEqual(["10", "5", "0"]);
  });

  it("plots goal conversion rates on a percentage axis", () => {
    renderPreview(
      config({
        type: "conversion",
        metric: "events",
        conversionKind: "goal",
        goalId: "goal",
      }),
      {
        ...base,
        type: "conversion",
        metric: "events",
        kind: "goal",
        label: "Signup",
        value: 12,
        rate: 0.031,
        total: 400,
        points: [
          { timestampMs: 1, value: 4, rate: 0.02 },
          { timestampMs: 2, value: 8, rate: 0.031 },
        ],
      },
    );
    const ticks = Array.from(
      content().querySelectorAll(".widget__axis span"),
    ).map((tick) => tick.textContent);
    expect(ticks).toEqual(["4%", "2%", "0%"]);
    expect(content().querySelector(".widget__secondary")?.textContent).toBe(
      `${WIDGET_EMBED_MESSAGES.en.conversionRate}: 3.1%`,
    );
    // The 3.1% peak reaches most of the plot instead of a flat 0..100% line.
    const y = content()
      .querySelector("polyline")!
      .getAttribute("points")!
      .split(" ")
      .map((point) => Number(point.split(",")[1]));
    expect(Math.min(...y)).toBeLessThan(60);
  });

  it("formats numbers and changes like the dashboard", () => {
    const metric = (value: number, change: number) => {
      renderPreview(config({}), {
        ...base,
        type: "metric",
        metric: "visitors",
        value,
        change,
      });
      return [
        content().querySelector(".widget__value")?.textContent,
        content().querySelector(".widget__change")?.textContent,
      ];
    };
    expect(metric(18753, 0.085)).toEqual(["18,753", "↑ +8.5%"]);
    expect(metric(2_400_000, -0.013)).toEqual(["2.4M", "↓ -1.3%"]);
    expect(metric(5, 0)).toEqual(["5", "0%"]);
  });

  it("draws ranking rows with a share background relative to the top row", () => {
    renderPreview(config({ type: "ranking" }), {
      ...base,
      type: "ranking",
      metric: "visitors",
      rows: [
        { label: "/a", value: 4000 },
        { label: "/b", value: 1000 },
      ],
    });
    const rows = Array.from(
      content().querySelectorAll<HTMLElement>(".widget__row"),
    );
    expect(
      rows.map((row) => row.style.getPropertyValue("--widget-share")),
    ).toEqual(["100%", "25%"]);
    expect(rows[0]!.querySelector(".widget__count")?.textContent).toBe("4,000");
    expect(content().querySelector(".widget__rank")).toBeNull();
  });

  it("places the realtime map counter above the map instead of over it", () => {
    renderPreview(config({ type: "realtime", realtimeLayout: "map" }), {
      ...base,
      type: "realtime",
      metric: "visitors",
      activeNow: 12,
      bars: [],
      points: [{ country: "US", lat: 39.5, lon: -97.5, value: 4 }],
      rows: [],
    });
    const [counter, map] = Array.from(content().children);
    expect(counter?.className).toBe("widget__realtime-map-counter");
    expect(map?.className).toBe("widget__geo-map");
    expect(map?.querySelector(".widget__realtime-map-counter")).toBeNull();
  });

  it("renders ranking rows", () => {
    renderPreview(config({ type: "ranking" }), {
      ...base,
      type: "ranking",
      metric: "visitors",
      rows: [
        { label: "/a", value: 2 },
        { label: "/b", value: 1 },
      ],
    });
    expect(content().querySelectorAll(".widget__row")).toHaveLength(2);
  });

  it.each([
    ["bars", ".widget__distribution-list"],
    ["donut", ".widget__donut-ring"],
    ["ratio", ".widget__ratio-track"],
  ] as const)("renders the %s distribution layout", (style, selector) => {
    renderPreview(config({ type: "distribution", distributionStyle: style }), {
      ...base,
      type: "distribution",
      metric: "visitors",
      rows: [
        { label: "Desktop", value: 3, percent: 0.75 },
        { label: "Mobile", value: 1, percent: 0.25 },
      ],
    });
    expect(content().querySelector(selector)).not.toBeNull();
  });

  it("renders the geo map container", () => {
    renderPreview(config({ type: "geo" }), {
      ...base,
      type: "geo",
      metric: "visitors",
      points: [{ country: "US", lat: 39.5, lon: -97.5, value: 4 }],
      unmapped: 0,
    });
    expect(content().querySelector(".widget__geo-map canvas")).not.toBeNull();
  });

  it("renders the realtime badge through its incremental renderer", () => {
    renderPreview(config({ type: "realtime", realtimeLayout: "badge" }), {
      ...base,
      type: "realtime",
      metric: "visitors",
      activeNow: 7,
      bars: [],
      points: [],
      rows: [],
    });
    expect(
      content().querySelector(".widget__realtime-number")?.textContent,
    ).toBe("7");
  });

  it("shows readable failure and update states for public widgets", async () => {
    const fetch = vi
      .fn()
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValueOnce(new Response(null, { status: 409 }));
    vi.stubGlobal("fetch", fetch);
    run(renderWidgetDocument({ uuid, config: config({}), revision: 3 }));
    await vi.waitFor(() =>
      expect(status().textContent).toContain(
        WIDGET_EMBED_MESSAGES.en.loadFailed,
      ),
    );
    expect(fetch).toHaveBeenCalledWith(
      `/api/public/widgets/${uuid}/data?revision=3`,
      expect.objectContaining({ credentials: "omit" }),
    );
    status().querySelector("button")!.click();
    await vi.waitFor(() =>
      expect(status().textContent).toContain(
        WIDGET_EMBED_MESSAGES.en.configurationChanged,
      ),
    );
  });
});

describe("host-page embed loader", () => {
  it("resizes only marked iframes whose window and origin both match", () => {
    // happy-dom does not load iframe pages; give each frame its own window.
    const frame = (marked: boolean) => {
      const element = document.createElement("iframe");
      if (marked) element.setAttribute("data-insightflare-widget", "");
      // happy-dom renders srcdoc frames locally instead of loading a URL.
      element.setAttribute("srcdoc", "");
      document.body.appendChild(element);
      Object.defineProperty(element, "src", {
        value: `https://insight.example/en/widget/${uuid}`,
      });
      Object.defineProperty(element, "contentWindow", {
        value: { postMessage: vi.fn() },
      });
      return element;
    };
    const marked = frame(true);
    const plain = frame(false);
    (0, eval)(WIDGET_EMBED_LOADER);
    // Frames present at startup are invited to report their height.
    expect(marked.contentWindow!.postMessage).toHaveBeenCalledWith(
      { type: "insightflare-widget-auto-height" },
      "https://insight.example",
    );
    expect(plain.contentWindow!.postMessage).not.toHaveBeenCalled();

    const post = (frame: HTMLIFrameElement, origin: string, height: unknown) =>
      window.dispatchEvent(
        new MessageEvent("message", {
          data: { type: "insightflare-widget-height", height },
          origin,
          source: frame.contentWindow,
        }),
      );

    post(marked, "https://evil.example", 120);
    expect(marked.style.height).toBe("");
    post(plain, "https://insight.example", 120);
    expect(plain.style.height).toBe("");
    post(marked, "https://insight.example", "nope");
    expect(marked.style.height).toBe("");
    post(marked, "https://insight.example", 120.2);
    expect(marked.style.height).toBe("121px");
    post(marked, "https://insight.example", 99999);
    expect(marked.style.height).toBe("4000px");
  });
});
