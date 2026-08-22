import {
  memo,
  startTransition,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { Bar, BarChart, CartesianGrid, XAxis, YAxis } from "recharts";

import { AutoTransition } from "@/components/ui/auto-transition";
import {
  calculateChartYAxisWidth,
  type ChartConfig,
  ChartContainer,
  ChartTooltip,
  ChartTooltipIndicator,
  createChartNumberFormatter,
} from "@/components/ui/chart";
import { Spinner } from "@/components/ui/spinner";
import {
  type ChartAxisDateFormat,
  createChartAxisDateFormatter,
  createChartTooltipDateFormatter,
} from "@/lib/dashboard/chart-time";
import { intlLocale, numberFormat } from "@/lib/dashboard/format";
import type { DashboardInterval } from "@/lib/dashboard/query-state";
import {
  addZonedInterval,
  startOfZonedInterval,
} from "@/lib/dashboard/time-zone";
import { safeChartCount } from "@/lib/dashboard/traffic-chart-data";
import type { Locale } from "@/lib/i18n/config";
import type { AppMessages } from "@/lib/i18n/messages";
import { formatI18nTemplate } from "@/lib/i18n/template";
import { cn } from "@/lib/utils";

export interface SiteTrafficStackChartProps {
  data?: ReadonlyArray<{
    timestampMs: number;
    sites: ReadonlyArray<{
      siteId: string;
      views: number;
      visitors: number;
    }>;
  }>;
  sites: Array<{
    id: string;
    name: string;
  }>;
  from: number;
  to: number;
  locale: Locale;
  timeZone: string;
  interval: DashboardInterval;
  viewsLabel: string;
  visitorsLabel: string;
  messages: AppMessages;
  axisDateFormat?: ChartAxisDateFormat;
  loading?: boolean;
  className?: string;
}

interface SiteTrafficSeriesItem {
  siteId: string;
  siteName: string;
  visitorsKey: string;
  viewsKey: string;
  visitorsColor: string;
  viewsColor: string;
}

type SiteTrafficChartRow = Record<string, number> & {
  timestampMs: number;
};

const MAX_INITIAL_CHART_POINTS = 2_000;
const BAR_LAYER_FADE_DURATION_MS = 200;
const BAR_LAYER_FADE_FALLBACK_DELAY_MS = BAR_LAYER_FADE_DURATION_MS + 100;

function createZeroValueChartData(
  from: number,
  to: number,
  interval: DashboardInterval,
  timeZone: string,
  series: readonly SiteTrafficSeriesItem[],
): SiteTrafficChartRow[] {
  const start = startOfZonedInterval(from, interval, timeZone);
  const end = startOfZonedInterval(to, interval, timeZone);
  if (!Number.isFinite(start) || !Number.isFinite(end) || start > end) {
    return [];
  }

  const rows: SiteTrafficChartRow[] = [];
  let timestampMs = start;
  for (
    let index = 0;
    index < MAX_INITIAL_CHART_POINTS && timestampMs <= end;
    index += 1
  ) {
    const row: SiteTrafficChartRow = { timestampMs };
    for (const item of series) {
      row[item.visitorsKey] = 0;
      row[item.viewsKey] = 0;
    }
    rows.push(row);

    const nextTimestampMs = addZonedInterval(timestampMs, interval, timeZone);
    if (!Number.isFinite(nextTimestampMs) || nextTimestampMs <= timestampMs) {
      break;
    }
    timestampMs = nextTimestampMs;
  }

  return rows;
}

function createChartData(
  data: NonNullable<SiteTrafficStackChartProps["data"]>,
  series: readonly SiteTrafficSeriesItem[],
): SiteTrafficChartRow[] {
  return data.map((point) => {
    const bySite = new Map(
      point.sites.map((sitePoint) => [
        sitePoint.siteId,
        {
          views: safeChartCount(sitePoint.views),
          visitors: safeChartCount(sitePoint.visitors),
        },
      ]),
    );
    const row: SiteTrafficChartRow = { timestampMs: point.timestampMs };

    for (const item of series) {
      const values = bySite.get(item.siteId);
      row[item.visitorsKey] = values?.visitors ?? 0;
      row[item.viewsKey] = values?.views ?? 0;
    }
    return row;
  });
}

interface RGB {
  r: number;
  g: number;
  b: number;
}

interface OKLCh {
  l: number;
  c: number;
  h: number;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function isHexColor(color: string): boolean {
  return /^#([0-9A-Fa-f]{3}|[0-9A-Fa-f]{6})$/.test(color);
}

function isOKLChColor(color: string): boolean {
  return /^oklch\s*\(\s*[\d.]+%?\s+[\d.]+%?\s+[\d.]+\s*\)$/i.test(color.trim());
}

function expandHex(hex: string): string {
  if (hex.length === 4) {
    return `#${hex[1]}${hex[1]}${hex[2]}${hex[2]}${hex[3]}${hex[3]}`;
  }
  return hex;
}

function hexToRgb(hex: string): RGB {
  const normalized = expandHex(hex);
  return {
    r: parseInt(normalized.slice(1, 3), 16),
    g: parseInt(normalized.slice(3, 5), 16),
    b: parseInt(normalized.slice(5, 7), 16),
  };
}

function rgbToHex(rgb: RGB): string {
  const toHex = (n: number) => {
    const hex = Math.round(clamp(n, 0, 255)).toString(16);
    return hex.length === 1 ? `0${hex}` : hex;
  };
  return `#${toHex(rgb.r)}${toHex(rgb.g)}${toHex(rgb.b)}`;
}

function parseOKLCh(color: string): OKLCh {
  const match = color
    .trim()
    .match(/oklch\s*\(\s*([\d.]+)%?\s+([\d.]+)%?\s+([\d.]+)\s*\)/i);
  if (!match || !match[1] || !match[2] || !match[3]) {
    throw new Error(`Invalid OKLCh color: ${color}`);
  }

  const lRaw = parseFloat(match[1]);
  const cRaw = parseFloat(match[2]);
  const hRaw = parseFloat(match[3]);

  return {
    l: lRaw > 1 ? lRaw / 100 : lRaw,
    c: cRaw > 1 ? cRaw / 100 : cRaw,
    h: hRaw,
  };
}

function oklchToRgb(oklch: OKLCh): RGB {
  const hRad = (oklch.h * Math.PI) / 180;
  const a = oklch.c * Math.cos(hRad);
  const b = oklch.c * Math.sin(hRad);

  const l_ = oklch.l + 0.3963377774 * a + 0.2158037573 * b;
  const m_ = oklch.l - 0.1055613458 * a - 0.0638541728 * b;
  const s_ = oklch.l - 0.0894841775 * a - 1.291485548 * b;

  const l3 = l_ * l_ * l_;
  const m3 = m_ * m_ * m_;
  const s3 = s_ * s_ * s_;

  const lr = +4.0767416621 * l3 - 3.3077115913 * m3 + 0.2309699292 * s3;
  const lg = -1.2684380046 * l3 + 2.6097574011 * m3 - 0.3413193965 * s3;
  const lb = -0.0041960863 * l3 - 0.7034186147 * m3 + 1.707614701 * s3;

  const toSrgb = (channel: number) => {
    const abs = Math.abs(channel);
    if (abs <= 0.0031308) return channel * 12.92;
    return (Math.sign(channel) || 1) * (1.055 * Math.pow(abs, 1 / 2.4) - 0.055);
  };

  return {
    r: clamp(toSrgb(lr) * 255, 0, 255),
    g: clamp(toSrgb(lg) * 255, 0, 255),
    b: clamp(toSrgb(lb) * 255, 0, 255),
  };
}

function rgbToOklch(rgb: RGB): OKLCh {
  const fromSrgb = (channel: number) => {
    const abs = Math.abs(channel);
    if (abs <= 0.04045) return channel / 12.92;
    return (Math.sign(channel) || 1) * Math.pow((abs + 0.055) / 1.055, 2.4);
  };

  const r = fromSrgb(rgb.r / 255);
  const g = fromSrgb(rgb.g / 255);
  const b = fromSrgb(rgb.b / 255);

  const l = 0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b;
  const m = 0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b;
  const s = 0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b;

  const l_ = Math.cbrt(l);
  const m_ = Math.cbrt(m);
  const s_ = Math.cbrt(s);

  const L = 0.2104542553 * l_ + 0.793617785 * m_ - 0.0040720468 * s_;
  const a = 1.9779984951 * l_ - 2.428592205 * m_ + 0.4505937099 * s_;
  const B = 0.0259040371 * l_ + 0.7827717662 * m_ - 0.808675766 * s_;

  const C = Math.sqrt(a * a + B * B);
  let H = (Math.atan2(B, a) * 180) / Math.PI;
  if (H < 0) H += 360;

  return { l: L, c: C, h: H };
}

function interpolateGradient(
  color1: string,
  color2: string,
  steps: number,
): string[] {
  if (steps < 2) return [color1];
  const toOklch = (color: string): OKLCh => {
    if (isHexColor(color)) return rgbToOklch(hexToRgb(color));
    if (isOKLChColor(color)) return parseOKLCh(color);
    throw new Error(`Unsupported color format: ${color}`);
  };

  const from = toOklch(color1);
  const to = toOklch(color2);

  let h1 = from.h;
  let h2 = to.h;
  if (Math.abs(h2 - h1) > 180) {
    if (h2 > h1) h1 += 360;
    else h2 += 360;
  }

  return Array.from({ length: steps }, (_, index) => {
    const t = steps === 1 ? 0 : index / (steps - 1);
    const mixed: OKLCh = {
      l: from.l + (to.l - from.l) * t,
      c: from.c + (to.c - from.c) * t,
      h: (h1 + (h2 - h1) * t) % 360,
    };
    return rgbToHex(oklchToRgb(mixed));
  });
}

function toHexColor(color: string): string {
  if (isHexColor(color)) return expandHex(color);
  const [hex] = interpolateGradient(color, color, 2);
  if (!hex || !isHexColor(hex)) {
    throw new Error(`Unsupported color format: ${color}`);
  }
  return expandHex(hex);
}

function generateComplementary(color: string): string {
  const rgb = hexToRgb(toHexColor(color));
  return rgbToHex({
    r: 255 - rgb.r,
    g: 255 - rgb.g,
    b: 255 - rgb.b,
  });
}

function buildSiteColorPairs(
  count: number,
  baseColor = "oklch(0.85 0.13 165)",
): Array<{ views: string; visitors: string }> {
  if (count <= 0) return [];
  const complementary = generateComplementary(baseColor);
  const gradient = interpolateGradient(
    baseColor,
    complementary,
    Math.max(count, 2),
  );
  return Array.from({ length: count }, (_, index) => {
    const views = gradient[index] ?? gradient[gradient.length - 1] ?? "#2dd4bf";
    return {
      views,
      visitors: views,
    };
  });
}

function SiteTrafficStackTooltip({
  active,
  payload,
  series,
  dateFormatter,
  viewsLabel,
  visitorsLabel,
  activeSiteIds,
  locale,
  messages,
}: {
  active?: boolean;
  payload?: Array<{ payload?: Record<string, unknown> }>;
  series: SiteTrafficSeriesItem[];
  dateFormatter: Intl.DateTimeFormat;
  viewsLabel: string;
  visitorsLabel: string;
  activeSiteIds: string[];
  locale: Locale;
  messages: AppMessages;
}) {
  if (!active || !payload?.length) return null;

  const row = payload[0]?.payload;
  if (!row) return null;

  const timestamp = Number(row.timestampMs ?? 0);
  const activeSiteIdSet = new Set(activeSiteIds);
  const hasActiveSites = activeSiteIds.length > 0;

  const activeSeries = series.filter(
    (item) => !hasActiveSites || activeSiteIdSet.has(item.siteId),
  );

  let totalViews = 0;
  let totalVisitors = 0;

  for (const item of activeSeries) {
    totalViews += safeChartCount(Number(row[item.viewsKey] ?? 0));
    totalVisitors += safeChartCount(Number(row[item.visitorsKey] ?? 0));
  }

  return (
    <div className="grid min-w-[200px] items-start gap-1.5 rounded-none border border-border/50 bg-background px-2.5 py-2 text-xs shadow-xl">
      <div className="font-medium text-foreground">
        {dateFormatter.format(new Date(timestamp))}
      </div>
      <div className="grid gap-1">
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-1.5">
            <ChartTooltipIndicator color="var(--color-primary)" />
            <span className="text-muted-foreground">{viewsLabel}</span>
          </div>
          <span className="font-mono font-semibold tabular-nums text-foreground">
            {numberFormat(locale, totalViews)}
          </span>
        </div>
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-1.5">
            <ChartTooltipIndicator color="var(--color-chart-3)" />
            <span className="text-muted-foreground">{visitorsLabel}</span>
          </div>
          <span className="font-mono font-semibold tabular-nums text-foreground">
            {numberFormat(locale, totalVisitors)}
          </span>
        </div>
      </div>
      {hasActiveSites ? (
        <div className="border-t border-border/30 pt-1 text-[10px] text-muted-foreground">
          {formatI18nTemplate(messages.common.sitesFiltered, {
            active: activeSiteIdSet.size,
            total: series.length,
          })}
        </div>
      ) : null}
    </div>
  );
}

function useBarLayerTransition(
  chartData: SiteTrafficChartRow[],
  transitionKey: string,
): {
  displayedChartData: SiteTrafficChartRow[];
  barsVisible: boolean;
  onBarLayerTransitionEnd: (
    target: EventTarget | null,
    propertyName: string,
  ) => void;
} {
  const previousKeyRef = useRef<string | null>(null);
  const pendingChartDataRef = useRef(chartData);
  const isFadingOutRef = useRef(false);
  const fadeTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const revealFrameRef = useRef<number | null>(null);
  const [barsVisible, setBarsVisible] = useState(true);
  const [displayedChartData, setDisplayedChartData] = useState(chartData);

  const clearScheduledTransition = useCallback(() => {
    if (fadeTimeoutRef.current !== null) {
      clearTimeout(fadeTimeoutRef.current);
      fadeTimeoutRef.current = null;
    }
    if (revealFrameRef.current !== null) {
      cancelAnimationFrame(revealFrameRef.current);
      revealFrameRef.current = null;
    }
  }, []);

  const revealPendingData = useCallback(() => {
    if (!isFadingOutRef.current) return;

    clearScheduledTransition();
    isFadingOutRef.current = false;
    setDisplayedChartData(pendingChartDataRef.current);
    revealFrameRef.current = requestAnimationFrame(() => {
      setBarsVisible(true);
      revealFrameRef.current = null;
    });
  }, [clearScheduledTransition]);

  const onBarLayerTransitionEnd = useCallback(
    (target: EventTarget | null, propertyName: string) => {
      if (
        !isFadingOutRef.current ||
        propertyName !== "opacity" ||
        !(target instanceof Element) ||
        !target.classList.contains("recharts-bar-rectangles")
      ) {
        return;
      }

      // `transitionend` fires only after opacity has reached zero. The first
      // bar layer is sufficient because every layer uses the same transition.
      revealPendingData();
    },
    [revealPendingData],
  );

  useLayoutEffect(() => {
    const previousKey = previousKeyRef.current;
    previousKeyRef.current = transitionKey;
    pendingChartDataRef.current = chartData;
    if (previousKey === null) return;
    if (previousKey === transitionKey) {
      if (!isFadingOutRef.current) {
        setDisplayedChartData(chartData);
      }
      return;
    }

    const reduceMotion = window.matchMedia(
      "(prefers-reduced-motion: reduce)",
    ).matches;
    if (reduceMotion) {
      clearScheduledTransition();
      isFadingOutRef.current = false;
      setDisplayedChartData(chartData);
      setBarsVisible(true);
      return;
    }

    // Keep the existing chart data visible while its bar layers fade out.
    // The new data is applied only after the outgoing layers are transparent.
    clearScheduledTransition();
    isFadingOutRef.current = true;
    setBarsVisible(false);
    fadeTimeoutRef.current = setTimeout(() => {
      // Zero-height bars do not emit transition events; do not leave the
      // chart hidden if the browser has no rectangle layer to animate.
      revealPendingData();
    }, BAR_LAYER_FADE_FALLBACK_DELAY_MS);

    return () => {
      clearScheduledTransition();
    };
  }, [chartData, clearScheduledTransition, revealPendingData, transitionKey]);

  return { displayedChartData, barsVisible, onBarLayerTransitionEnd };
}

const SiteTrafficStackPlot = memo(function SiteTrafficStackPlot({
  chartData,
  config,
  series,
  activeSiteIds,
  className,
  tickFormatter,
  tooltipFormatter,
  viewsLabel,
  visitorsLabel,
  locale,
  messages,
  loading = false,
  barsVisible,
  onBarLayerTransitionEnd,
  onHoverPoint,
}: {
  chartData: SiteTrafficChartRow[];
  config: ChartConfig;
  series: SiteTrafficSeriesItem[];
  activeSiteIds: string[];
  className?: string;
  tickFormatter: Intl.DateTimeFormat;
  tooltipFormatter: Intl.DateTimeFormat;
  viewsLabel: string;
  visitorsLabel: string;
  locale: Locale;
  messages: AppMessages;
  loading: boolean;
  barsVisible: boolean;
  onBarLayerTransitionEnd: (
    target: EventTarget | null,
    propertyName: string,
  ) => void;
  onHoverPoint: (point: SiteTrafficChartRow | null) => void;
}) {
  const [hasChartSize, setHasChartSize] = useState(false);
  const chartRootRef = useRef<HTMLDivElement>(null);
  const handleChartResize = useCallback((width: number, height: number) => {
    if (width <= 0 || height <= 0) return;
    setHasChartSize(true);
  }, []);
  const yAxisNumberFormatter = useMemo(
    () => createChartNumberFormatter(intlLocale(locale)),
    [locale],
  );
  const yAxisWidth = useMemo(() => {
    const labels = chartData.map((row) => {
      let views = 0;
      let visitors = 0;

      for (const item of series) {
        views += safeChartCount(Number(row[item.viewsKey] ?? 0));
        visitors += safeChartCount(Number(row[item.visitorsKey] ?? 0));
      }

      return yAxisNumberFormatter.format(Math.max(views, visitors));
    });

    return calculateChartYAxisWidth(labels, 4);
  }, [chartData, series, yAxisNumberFormatter]);

  useLayoutEffect(() => {
    const root = chartRootRef.current;
    if (!root) return;

    const activeSiteIdSet = new Set(activeSiteIds);
    const hasActiveSites = activeSiteIds.length > 0;
    for (const [index, item] of series.entries()) {
      const opacity =
        !hasActiveSites || activeSiteIdSet.has(item.siteId) ? "1" : "0.28";
      const groups = root.querySelectorAll<SVGGElement>(
        `.site-traffic-series-${index}`,
      );
      for (const group of Array.from(groups)) {
        group.style.opacity = opacity;
      }
    }
  }, [activeSiteIds, chartData, series]);

  return (
    <div ref={chartRootRef} className="relative">
      <ChartContainer
        className={cn(
          "h-[320px] w-full aspect-auto transition-opacity duration-200 [&_.recharts-bar-rectangles]:transition-[filter,opacity] [&_.recharts-bar-rectangles]:duration-200 [&_.site-traffic-series]:transition-opacity [&_.site-traffic-series]:duration-200 motion-reduce:[&_.recharts-bar-rectangles]:transition-none motion-reduce:[&_.site-traffic-series]:transition-none",
          hasChartSize ? "opacity-100" : "opacity-0",
          loading
            ? "[&_.recharts-bar-rectangles]:brightness-50"
            : "[&_.recharts-bar-rectangles]:brightness-100",
          barsVisible
            ? "[&_.recharts-bar-rectangles]:opacity-100"
            : "[&_.recharts-bar-rectangles]:opacity-0",
          className,
        )}
        config={config}
        onChartResize={handleChartResize}
        onTransitionEnd={(event) =>
          onBarLayerTransitionEnd(event.target, event.propertyName)
        }
      >
        <BarChart
          data={chartData}
          margin={{ left: 0, right: 8 }}
          barCategoryGap="12%"
          barGap={2}
          onMouseMove={(state) => {
            if (
              state &&
              state.activePayload &&
              state.activePayload.length > 0
            ) {
              const activePoint = state.activePayload[0].payload as
                | SiteTrafficChartRow
                | undefined;
              onHoverPoint(activePoint ?? null);
            } else {
              onHoverPoint(null);
            }
          }}
          onMouseLeave={() => {
            onHoverPoint(null);
          }}
        >
          <CartesianGrid vertical={false} />
          <XAxis
            dataKey="timestampMs"
            tickFormatter={(value) =>
              tickFormatter.format(new Date(Number(value ?? 0)))
            }
            tickLine={false}
            axisLine={false}
            tickMargin={8}
            minTickGap={14}
          />
          <YAxis
            width={yAxisWidth}
            tickFormatter={(value) =>
              yAxisNumberFormatter.format(Number(value ?? 0))
            }
            allowDecimals={false}
            tickLine={false}
            axisLine={false}
            tickMargin={4}
          />
          <ChartTooltip
            allowEscapeViewBox={{ x: false, y: true }}
            wrapperStyle={{ zIndex: 20 }}
            content={
              <SiteTrafficStackTooltip
                series={series}
                dateFormatter={tooltipFormatter}
                viewsLabel={viewsLabel}
                visitorsLabel={visitorsLabel}
                activeSiteIds={activeSiteIds}
                locale={locale}
                messages={messages}
              />
            }
          />
          {series.map((item, index) => (
            <Bar
              key={item.visitorsKey}
              dataKey={item.visitorsKey}
              stackId="visitors"
              fill={`var(--color-${item.visitorsKey})`}
              className={`site-traffic-series site-traffic-series-${index}`}
              radius={0}
              isAnimationActive={false}
            />
          ))}
          {series.map((item, index) => (
            <Bar
              key={item.viewsKey}
              dataKey={item.viewsKey}
              stackId="views"
              fill={`var(--color-${item.viewsKey})`}
              className={`site-traffic-series site-traffic-series-${index}`}
              radius={0}
              isAnimationActive={false}
            />
          ))}
        </BarChart>
      </ChartContainer>
      <AutoTransition
        initial={false}
        aria-hidden={!loading && hasChartSize}
        className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center text-muted-foreground"
        transitionKey={loading || !hasChartSize ? "loading" : "ready"}
        duration={0.2}
        presenceMode="sync"
      >
        {loading || !hasChartSize ? (
          <Spinner key="chart-loading-indicator" className="size-5" />
        ) : null}
      </AutoTransition>
    </div>
  );
});

export const SiteTrafficStackChart = memo(function SiteTrafficStackChart({
  data,
  sites,
  from,
  to,
  locale,
  timeZone,
  interval,
  viewsLabel,
  visitorsLabel,
  messages,
  axisDateFormat = "regular",
  loading = false,
  className,
}: SiteTrafficStackChartProps) {
  const cachedSiteOrderRef = useRef<string[] | null>(null);
  const [activeSiteIds, setActiveSiteIds] = useState<string[]>([]);
  const [hoveredPoint, setHoveredPoint] = useState<SiteTrafficChartRow | null>(
    null,
  );
  const hoveredTimestampRef = useRef<number | null>(null);

  if (!cachedSiteOrderRef.current && sites.length > 0) {
    cachedSiteOrderRef.current = sites.map((site) => site.id);
  } else if (cachedSiteOrderRef.current && sites.length > 0) {
    const knownIds = new Set(cachedSiteOrderRef.current);
    for (const site of sites) {
      if (!knownIds.has(site.id)) {
        cachedSiteOrderRef.current.push(site.id);
        knownIds.add(site.id);
      }
    }
  }

  const orderedSites = useMemo(() => {
    const cachedOrder = cachedSiteOrderRef.current;
    if (!cachedOrder || sites.length < 2) {
      return sites;
    }

    const siteById = new Map(sites.map((site) => [site.id, site]));
    const nextSites: SiteTrafficStackChartProps["sites"] = [];

    for (const siteId of cachedOrder) {
      const site = siteById.get(siteId);
      if (site) {
        nextSites.push(site);
        siteById.delete(siteId);
      }
    }

    for (const site of siteById.values()) {
      nextSites.push(site);
    }

    return nextSites;
  }, [sites]);

  const { series, config } = useMemo(() => {
    // Mirrors NeutralPress DimensionStats: start from a base color, invert to complementary,
    // then interpolate in OKLCH for evenly perceived multi-site colors.
    const pairs = buildSiteColorPairs(orderedSites.length);
    const nextSeries: SiteTrafficSeriesItem[] = orderedSites.map(
      (site, index) => {
        const colors = pairs[index] ?? {
          views: "#2dd4bf",
          visitors: "#2dd4bf",
        };
        return {
          siteId: site.id,
          siteName: site.name,
          visitorsKey: `site${index}Visitors`,
          viewsKey: `site${index}Views`,
          visitorsColor: colors.visitors,
          viewsColor: colors.views,
        };
      },
    );

    const nextConfig: ChartConfig = {};
    for (const item of nextSeries) {
      nextConfig[item.visitorsKey] = {
        label: `${item.siteName} · ${visitorsLabel}`,
        color: item.visitorsColor,
      };
      nextConfig[item.viewsKey] = {
        label: `${item.siteName} · ${viewsLabel}`,
        color: item.viewsColor,
      };
    }

    return {
      series: nextSeries,
      config: nextConfig,
    };
  }, [orderedSites, viewsLabel, visitorsLabel]);

  useEffect(() => {
    const validSiteIds = new Set(series.map((item) => item.siteId));
    setActiveSiteIds((current) => {
      if (current.length === 0) return current;
      const next = current.filter((siteId) => validSiteIds.has(siteId));
      return next.length === current.length ? current : next;
    });
  }, [series]);

  const activeSiteIdSet = useMemo(
    () => new Set(activeSiteIds),
    [activeSiteIds],
  );
  const hasActiveSites = activeSiteIds.length > 0;

  const chartData = useMemo(
    () =>
      data
        ? createChartData(data, series)
        : createZeroValueChartData(from, to, interval, timeZone, series),
    [data, from, to, interval, timeZone, series],
  );
  const legendKey = useMemo(
    () => series.map((item) => item.siteId).join("|"),
    [series],
  );
  const barTransitionKey = useMemo(() => {
    const firstTimestamp = chartData[0]?.timestampMs ?? 0;
    const lastTimestamp = chartData[chartData.length - 1]?.timestampMs ?? 0;
    return `${data ? "data" : "initial"}:${interval}:${legendKey}:${chartData.length}:${firstTimestamp}:${lastTimestamp}`;
  }, [data, interval, legendKey, chartData]);
  const { displayedChartData, barsVisible, onBarLayerTransitionEnd } =
    useBarLayerTransition(chartData, barTransitionKey);

  const totals = useMemo(() => {
    const map = new Map<string, { views: number; visitors: number }>();
    for (const item of series) {
      let viewsSum = 0;
      let visitorsSum = 0;
      for (const row of displayedChartData) {
        viewsSum += row[item.viewsKey] ?? 0;
        visitorsSum += row[item.visitorsKey] ?? 0;
      }
      map.set(item.siteId, { views: viewsSum, visitors: visitorsSum });
    }
    return map;
  }, [displayedChartData, series]);

  const getSiteValues = (siteId: string, item: (typeof series)[number]) => {
    if (hoveredPoint) {
      const views = hoveredPoint[item.viewsKey] ?? 0;
      const visitors = hoveredPoint[item.visitorsKey] ?? 0;
      return { views, visitors };
    }
    return totals.get(siteId) ?? { views: 0, visitors: 0 };
  };
  const handleHoverPoint = useCallback((point: SiteTrafficChartRow | null) => {
    const nextTimestamp =
      point && Number.isFinite(point.timestampMs) ? point.timestampMs : null;
    if (hoveredTimestampRef.current === nextTimestamp) return;
    hoveredTimestampRef.current = nextTimestamp;
    setHoveredPoint(point);
  }, []);
  const handleToggleSite = useCallback((siteId: string) => {
    startTransition(() => {
      setActiveSiteIds((current) =>
        current.includes(siteId)
          ? current.filter((currentSiteId) => currentSiteId !== siteId)
          : [...current, siteId],
      );
    });
  }, []);

  useEffect(() => {
    hoveredTimestampRef.current = null;
    setHoveredPoint((current) => (current === null ? current : null));
  }, [displayedChartData]);

  const tickFormatter = useMemo(
    () =>
      createChartAxisDateFormatter(locale, interval, timeZone, axisDateFormat),
    [locale, interval, timeZone, axisDateFormat],
  );
  const tooltipFormatter = useMemo(
    () => createChartTooltipDateFormatter(locale, interval, timeZone),
    [locale, interval, timeZone],
  );
  return (
    <div className="space-y-4">
      <SiteTrafficStackPlot
        chartData={displayedChartData}
        config={config}
        series={series}
        activeSiteIds={activeSiteIds}
        className={className}
        tickFormatter={tickFormatter}
        tooltipFormatter={tooltipFormatter}
        viewsLabel={viewsLabel}
        visitorsLabel={visitorsLabel}
        locale={locale}
        messages={messages}
        loading={loading}
        barsVisible={barsVisible}
        onBarLayerTransitionEnd={onBarLayerTransitionEnd}
        onHoverPoint={handleHoverPoint}
      />

      <div className="flex flex-col gap-4 border-t border-border/40 pt-4">
        <div className="flex items-center justify-between text-xs">
          <span className="font-medium text-muted-foreground">
            <AutoTransition>
              {hoveredPoint ? (
                <span className="inline-flex items-center gap-1.5 text-primary font-medium">
                  <span className="relative flex h-2 w-2">
                    <span className="absolute inline-flex h-full w-full animate-ping rounded-none bg-primary/60 opacity-75"></span>
                    <span className="relative inline-flex h-2 w-2 rounded-none bg-primary"></span>
                  </span>
                  {tooltipFormatter.format(
                    new Date(Number(hoveredPoint.timestampMs)),
                  )}
                </span>
              ) : (
                messages.common.cumulativeTraffic
              )}
            </AutoTransition>
          </span>
          <span className="text-[11px] text-muted-foreground font-medium">
            {viewsLabel} / {visitorsLabel}
          </span>
        </div>

        <div className="grid gap-x-6 gap-y-0.5 grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
          {series.map((item) => {
            const { views, visitors } = getSiteValues(item.siteId, item);
            return (
              <button
                key={item.siteId}
                type="button"
                aria-pressed={activeSiteIdSet.has(item.siteId)}
                onClick={() => handleToggleSite(item.siteId)}
                className={cn(
                  "grid grid-cols-[minmax(0,1fr)_auto] items-center gap-3 rounded-none px-2.5 py-1 text-left border-0 bg-transparent cursor-pointer transition-all hover:bg-accent/40 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring/60",
                  hasActiveSites && !activeSiteIdSet.has(item.siteId)
                    ? "opacity-40"
                    : "opacity-100",
                )}
              >
                <div className="flex min-w-0 items-center gap-2">
                  <span
                    className="size-2.5 shrink-0 rounded-none"
                    style={{ backgroundColor: item.viewsColor }}
                  />
                  <span
                    className={cn(
                      "truncate font-medium text-xs",
                      activeSiteIdSet.has(item.siteId)
                        ? "text-foreground"
                        : "text-muted-foreground",
                    )}
                    title={item.siteName}
                  >
                    {item.siteName}
                  </span>
                </div>
                <AutoTransition>
                  <div
                    className="flex shrink-0 items-baseline gap-1.5 text-xs"
                    key={`${views}/${visitors}`}
                  >
                    <span className="font-mono tabular-nums text-foreground font-semibold">
                      {numberFormat(locale, views)}
                    </span>
                    <span className="text-[10px] text-muted-foreground font-light">
                      /
                    </span>
                    <span className="font-mono tabular-nums text-muted-foreground">
                      {numberFormat(locale, visitors)}
                    </span>
                  </div>
                </AutoTransition>
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
});
