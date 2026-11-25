import { OverlayScrollbar } from "@insightflare/ui/overlay-scrollbar";
import { RiArrowRightLine } from "@remixicon/react";

import type { WidgetConfig } from "@/lib/widgets/contract";
import { GEO_LAND_DOTS } from "@/lib/widgets/geo-data";
import { widgetPalette } from "@/lib/widgets/palette";

import type { widgetLabels } from "./labels";

export type WidgetTemplateId =
  | "metric"
  | "trend"
  | "comparison"
  | "ranking"
  | "distribution"
  | "donut"
  | "ratio"
  | "area"
  | "conversion"
  | "geo"
  | "realtimeBadge"
  | "realtimeTrend"
  | "realtimeMap";

/** One entry per distinct layout, not one entry per configurable metric. */
export function widgetTemplateConfig(
  baseline: WidgetConfig,
  template: WidgetTemplateId,
): WidgetConfig {
  switch (template) {
    case "metric":
      return { ...baseline, type: "metric", metric: "visitors" };
    case "realtimeBadge":
      return {
        ...baseline,
        type: "realtime",
        metric: "visitors",
        realtimeLayout: "badge",
      };
    case "realtimeTrend":
      return {
        ...baseline,
        type: "realtime",
        metric: "visitors",
        realtimeLayout: "trend",
      };
    case "realtimeMap":
      return {
        ...baseline,
        type: "realtime",
        metric: "visitors",
        realtimeLayout: "map",
        geoProjection: "globe",
      };
    case "geo":
      return {
        ...baseline,
        type: "geo",
        metric: "visitors",
        geoProjection: "flat",
      };
    case "trend":
      return {
        ...baseline,
        type: "trend",
        metric: "views",
        trendStyle: "line",
        trendMetrics: [],
      };
    case "area":
      return {
        ...baseline,
        type: "trend",
        metric: "visitors",
        trendStyle: "area",
        trendMetrics: [],
      };
    case "comparison":
      return {
        ...baseline,
        type: "trend",
        metric: "visitors",
        trendStyle: "line",
        trendMetrics: ["visitors", "views", "sessions"],
      };
    case "ranking":
      return {
        ...baseline,
        type: "ranking",
        metric: "views",
        dimension: "page.path",
        rankingStyle: "list",
      };
    case "distribution":
      return {
        ...baseline,
        type: "distribution",
        metric: "visitors",
        distributionStyle: "bars",
        distributionDimension: "client.deviceType",
      };
    case "donut":
      return {
        ...baseline,
        type: "distribution",
        metric: "visitors",
        distributionStyle: "donut",
        distributionDimension: "client.deviceType",
      };
    case "ratio":
      return {
        ...baseline,
        type: "distribution",
        metric: "visitors",
        distributionStyle: "ratio",
        distributionDimension: "client.deviceType",
      };
    case "conversion":
      return {
        ...baseline,
        type: "conversion",
        metric: "events",
        conversionKind: "event",
        eventName: "",
        goalId: "",
      };
  }
}

/** Small schematic drawings faithfully show which visual elements each layout has.
 * They are decorative, not data previews; no real analytics query is made here.
 */
function TemplateDrawing({ type }: { type: WidgetTemplateId }) {
  const green = "var(--primary)";
  const palette3 = widgetPalette(3);
  const palette5 = widgetPalette(5);
  const grey = "var(--muted-foreground)";
  if (type === "realtimeBadge") {
    return (
      <div
        aria-hidden="true"
        className="flex h-[76px] items-center justify-center"
      >
        <div className="inline-flex items-center gap-1.5 border bg-card px-3 py-1.5 font-mono">
          <span className="size-1.5 rounded-full bg-primary" />
          <span className="text-[16px] font-semibold leading-none tracking-tight">
            42
          </span>
          <span className="text-[9px] text-muted-foreground">online</span>
          <svg
            viewBox="0 0 20 20"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.4"
            className="size-3 text-muted-foreground"
            aria-hidden="true"
          >
            <rect x="2.5" y="3.5" width="15" height="13" />
            <path d="M5 13l3.5-4 3 2.5L15 7" />
          </svg>
        </div>
      </div>
    );
  }
  if (type === "realtimeTrend") {
    return (
      <div
        aria-hidden="true"
        className="flex h-[76px] flex-col justify-between px-3.5 pt-2 pb-2"
      >
        <div className="flex items-center justify-between">
          <span className="font-mono text-lg font-semibold leading-none">
            42
          </span>
          <span className="text-[9px] text-muted-foreground">30m</span>
        </div>
        <div className="flex h-7 items-end gap-1">
          {Array.from({ length: 18 }, (_, i) => (
            <span
              key={i}
              className="flex-1 bg-primary/80"
              style={{
                height: `${25 + Math.round(Math.abs(Math.sin(i * 1.13)) * 70)}%`,
              }}
            />
          ))}
        </div>
      </div>
    );
  }
  if (type === "donut") {
    const sample = [62, 25, 13];
    return (
      <div
        aria-hidden="true"
        className="flex h-[76px] items-center justify-center gap-3 px-3"
      >
        <svg viewBox="0 0 64 64" className="size-[62px] shrink-0" fill="none">
          <circle
            cx="32"
            cy="32"
            r="24"
            stroke="var(--muted)"
            strokeWidth="9"
          />
          {sample.map((value, i) => (
            <circle
              key={i}
              cx="32"
              cy="32"
              r="24"
              stroke={palette3[i]}
              strokeWidth="9"
              strokeDasharray={`${(value / 100) * 150.796} 150.796`}
              strokeDashoffset={`${(-sample.slice(0, i).reduce((a, b) => a + b, 0) / 100) * 150.796}`}
              transform="rotate(-90 32 32)"
            />
          ))}
          <text
            x="32"
            y="35.5"
            textAnchor="middle"
            fill="var(--foreground)"
            fontSize="10"
            fontWeight="600"
          >
            7.8k
          </text>
        </svg>
        <div className="grid min-w-0 flex-1 gap-1.5">
          {sample.map((v, i) => (
            <div className="flex items-center gap-1.5" key={i}>
              <span
                className="size-1.5"
                style={{
                  background: palette3[i],
                }}
              />
              <span className="h-1 w-9 bg-muted-foreground/20" />
              <span className="ml-auto font-mono text-[9px] text-muted-foreground">
                {v}%
              </span>
            </div>
          ))}
        </div>
      </div>
    );
  }
  if (type === "ratio") {
    return (
      <div
        aria-hidden="true"
        className="flex h-[76px] flex-col justify-center gap-2 px-3.5"
      >
        <div className="flex h-3.5 w-full overflow-hidden bg-muted">
          {[40, 25, 17, 11, 7].map((n, i) => (
            <span
              key={i}
              style={{
                width: n + "%",
                background: palette5[i],
              }}
            />
          ))}
        </div>
        <div className="flex items-center justify-between gap-2">
          {[40, 25, 17, 11, 7].map((n, i) => (
            <span
              key={i}
              className="flex items-center gap-1 font-mono text-[9px] text-muted-foreground"
            >
              <span
                className="size-1.5"
                style={{
                  background: palette5[i],
                }}
              />
              {n}%
            </span>
          ))}
        </div>
      </div>
    );
  }
  if (type === "area") {
    return (
      <svg
        aria-hidden="true"
        className="h-[76px] w-full px-3 py-2"
        viewBox="0 0 210 60"
        preserveAspectRatio="none"
      >
        <path d="M0 50H210 M0 28H210" stroke="var(--border)" strokeWidth="1" />
        <path
          d="M2 47 L28 39 L54 44 L80 26 L106 33 L132 17 L158 23 L184 12 L208 20 L208 56 L2 56 Z"
          fill="var(--primary)"
          fillOpacity=".17"
        />
        <polyline
          points="2,47 28,39 54,44 80,26 106,33 132,17 158,23 184,12 208,20"
          stroke="var(--primary)"
          strokeWidth="2.3"
          fill="none"
          strokeLinejoin="round"
        />
      </svg>
    );
  }
  if (type === "metric") {
    return (
      <div
        aria-hidden="true"
        className="flex h-[76px] flex-col justify-center gap-2 px-3.5"
      >
        <div className="font-mono text-[24px] font-semibold leading-none tracking-tight text-foreground">
          12.8k
        </div>
        <div className="flex items-center gap-2">
          <span className="border border-primary/25 bg-primary/10 px-1 py-0.5 font-mono text-[10px] leading-none text-primary">
            +8.4%
          </span>
          <span className="h-1 w-12 bg-muted-foreground/20" />
        </div>
      </div>
    );
  }
  if (type === "realtimeMap") {
    return (
      <svg
        aria-hidden="true"
        className="h-[76px] w-full px-3"
        viewBox="0 0 240 92"
      >
        <circle
          cx="120"
          cy="46"
          r="39"
          fill="none"
          stroke="var(--border)"
          strokeWidth=".8"
        />
        {globeTemplateDots.map(([x, y], i) => (
          <circle
            key={i}
            cx={x}
            cy={y}
            r=".78"
            fill="var(--muted-foreground)"
            opacity=".42"
          />
        ))}
        <circle cx="132" cy="34" r="3" fill={green} opacity=".92" />
        <circle cx="97" cy="54" r="2.5" fill={green} opacity=".85" />
        <g>
          <rect
            x="3"
            y="3"
            width="53"
            height="15"
            fill="var(--card)"
            stroke="var(--border)"
          />
          <circle cx="11" cy="10.5" r="2" fill={green} />
          <text
            x="17"
            y="13.3"
            fill="var(--foreground)"
            fontSize="9"
            fontWeight="600"
          >
            42 online
          </text>
        </g>
      </svg>
    );
  }
  if (type === "geo") {
    return (
      <svg
        aria-hidden="true"
        className="h-[76px] w-full px-3"
        viewBox="0 0 240 92"
      >
        {geoTemplateDots.map(([x, y], i) => (
          <circle
            key={i}
            cx={x}
            cy={y}
            r="0.9"
            fill="var(--muted-foreground)"
            opacity=".42"
          />
        ))}
        <circle cx="58" cy="31" r="4" fill={green} opacity=".8" />
        <circle cx="162" cy="29" r="3.5" fill={green} opacity=".8" />
      </svg>
    );
  }
  if (type === "ranking") {
    return (
      <div
        aria-hidden="true"
        className="flex h-[76px] flex-col justify-center gap-2 px-3.5"
      >
        {[0, 1, 2].map((index) => (
          <div className="flex items-center gap-2" key={index}>
            <span className="flex size-4 shrink-0 items-center justify-center bg-muted font-mono text-[9px] text-foreground/70">
              {index + 1}
            </span>
            <span
              className="h-1.5 bg-muted-foreground/25"
              style={{ width: `${90 - index * 16}px` }}
            />
            <span className="ml-auto h-1.5 w-7 bg-muted-foreground/15" />
          </div>
        ))}
      </div>
    );
  }
  if (type === "distribution") {
    return (
      <div
        aria-hidden="true"
        className="flex h-[76px] flex-col justify-center gap-2 px-3.5"
      >
        {[0, 1, 2].map((index) => (
          <div className="space-y-1" key={index}>
            <div className="flex justify-between">
              <span className="h-1 w-14 bg-muted-foreground/20" />
              <span className="h-1 w-6 bg-muted-foreground/15" />
            </div>
            <div className="h-1 bg-muted">
              <div
                style={{
                  width: `${80 - index * 23}%`,
                  background: palette3[index],
                }}
                className="h-full"
              />
            </div>
          </div>
        ))}
      </div>
    );
  }
  const isComparison = type === "comparison";
  const isConversion = type === "conversion";
  return (
    <div
      aria-hidden="true"
      className="relative flex h-[76px] min-w-0 flex-col justify-end px-3.5 pb-2"
    >
      {isConversion ? (
        <span className="absolute left-3.5 top-2 font-mono text-[17px] font-semibold leading-none text-foreground">
          214
        </span>
      ) : null}
      <svg
        className={isConversion ? "h-[38px] w-full" : "h-[56px] w-full"}
        viewBox="0 0 210 56"
        preserveAspectRatio="none"
      >
        <path d="M0 51H210 M0 27H210" stroke="var(--border)" strokeWidth="1" />
        <polyline
          points="2,44 28,38 54,41 80,24 106,30 132,15 158,23 184,10 208,16"
          stroke={isComparison ? palette3[0] : green}
          strokeWidth="2.3"
          fill="none"
          strokeLinejoin="round"
        />
        {isComparison ? (
          <>
            <polyline
              points="2,33 28,44 54,28 80,35 106,20 132,27 158,16 184,24 208,8"
              stroke={palette3[1]}
              strokeWidth="1.8"
              fill="none"
              strokeLinejoin="round"
            />
            <polyline
              points="2,51 28,47 54,49 80,40 106,44 132,36 158,39 184,30 208,34"
              stroke={palette3[2]}
              strokeWidth="1.8"
              fill="none"
              strokeLinejoin="round"
            />
          </>
        ) : null}
        <path d="M0 56H210" stroke={grey} strokeOpacity=".09" />
      </svg>
    </div>
  );
}

// Downsample the actual Natural Earth land-dot mask for the schematic preview.
const geoTemplateDots = (() => {
  const bytes = atob(GEO_LAND_DOTS.bits);
  const dots: [number, number][] = [];
  for (let row = 0; row < GEO_LAND_DOTS.rows; row += 4) {
    for (let column = 0; column < GEO_LAND_DOTS.cols; column += 4) {
      const index = row * GEO_LAND_DOTS.cols + column;
      if (bytes.charCodeAt(index >> 3) & (1 << (index & 7))) {
        dots.push([column, row]);
      }
    }
  }
  return dots;
})();

const globeTemplateDots = geoTemplateDots.flatMap(([x, y]) => {
  const lon = (x / GEO_LAND_DOTS.cols) * 2 * Math.PI - Math.PI;
  const lat = Math.PI / 2 - (y / GEO_LAND_DOTS.rows) * Math.PI;
  const rotated = lon - Math.PI / 4;
  const visible = Math.cos(lat) * Math.cos(rotated);
  if (visible <= 0) return [];
  return [
    [
      120 + 39 * Math.cos(lat) * Math.sin(rotated),
      46 - 39 * Math.sin(lat),
    ] as const,
  ];
});

const templates = [
  {
    id: "realtimeBadge",
    title: "templateRealtimeBadge",
    hint: "templateRealtimeBadgeHint",
  },
  {
    id: "realtimeTrend",
    title: "templateRealtimeTrend",
    hint: "templateRealtimeTrendHint",
  },
  {
    id: "realtimeMap",
    title: "templateRealtimeMap",
    hint: "templateRealtimeMapHint",
  },
  { id: "metric", title: "templateMetric", hint: "templateMetricHint" },
  { id: "geo", title: "templateGeo", hint: "templateGeoHint" },
  { id: "donut", title: "templateDonut", hint: "templateDonutHint" },
  { id: "ratio", title: "templateRatio", hint: "templateRatioHint" },
  { id: "area", title: "templateArea", hint: "templateAreaHint" },
  { id: "trend", title: "templateTrend", hint: "templateTrendHint" },
  {
    id: "comparison",
    title: "templateComparison",
    hint: "templateComparisonHint",
  },
  { id: "ranking", title: "templateRanking", hint: "templateRankingHint" },
  {
    id: "distribution",
    title: "templateDistribution",
    hint: "templateDistributionHint",
  },
  {
    id: "conversion",
    title: "templateConversion",
    hint: "templateConversionHint",
  },
] as const satisfies readonly {
  id: WidgetTemplateId;
  title: keyof ReturnType<typeof widgetLabels>;
  hint: keyof ReturnType<typeof widgetLabels>;
}[];

export function WidgetTemplateGallery({
  copy,
  disabled,
  onSelect,
}: {
  copy: ReturnType<typeof widgetLabels>;
  disabled: boolean;
  onSelect: (template: WidgetTemplateId) => void;
}) {
  return (
    <section className="min-w-0 space-y-3" aria-label={copy.templateHeading}>
      <div className="flex flex-wrap items-end justify-between gap-2">
        <h2 className="text-sm font-semibold">{copy.templateHeading}</h2>
        <span className="text-xs tabular-nums text-muted-foreground">
          {templates.length} {copy.templateCount}
        </span>
      </div>
      <OverlayScrollbar
        axis="horizontal"
        showEdgeMasks
        className="min-w-0 w-full"
        contentClassName="flex w-max min-w-full snap-x snap-mandatory gap-3 pb-2"
      >
        {templates.map(({ id, title, hint }) => (
          <button
            key={id}
            type="button"
            disabled={disabled}
            onClick={() => onSelect(id)}
            aria-label={`${copy.createFromTemplate}: ${copy[title]}`}
            className="group flex w-[11.75rem] shrink-0 snap-start flex-col overflow-hidden border bg-card text-left transition-colors hover:border-primary/50 hover:bg-muted/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50"
          >
            <div className="w-full border-b bg-muted/15">
              <TemplateDrawing type={id} />
            </div>
            <div className="flex min-w-0 items-center gap-2 px-3 py-2.5">
              <div className="min-w-0 flex-1 space-y-0.5">
                <div className="truncate text-xs font-semibold">
                  {copy[title]}
                </div>
                <div
                  className="truncate text-[11px] text-muted-foreground"
                  title={copy[hint]}
                >
                  {copy[hint]}
                </div>
              </div>
              <RiArrowRightLine
                aria-hidden="true"
                className="size-4 shrink-0 text-muted-foreground/50 transition-transform group-hover:translate-x-0.5"
              />
            </div>
          </button>
        ))}
      </OverlayScrollbar>
    </section>
  );
}
