"use client";

import { memo, useEffect, useMemo, useRef, useState } from "react";
import { Bar, BarChart, CartesianGrid, XAxis, YAxis } from "recharts";
import {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig,
} from "@/components/ui/chart";
import { AutoResizer } from "@/components/ui/auto-resizer";
import { AutoTransition } from "@/components/ui/auto-transition";
import { intlLocale } from "@/lib/dashboard/format";
import type { DashboardInterval } from "@/lib/dashboard/query-state";
import type { Locale } from "@/lib/i18n/config";
import { cn } from "@/lib/utils";

interface SiteTrafficStackChartProps {
  data: Array<{
    timestampMs: number;
    sites: Array<{
      siteId: string;
      views: number;
      visitors: number;
    }>;
  }>;
  sites: Array<{
    id: string;
    name: string;
  }>;
  locale: Locale;
  interval: DashboardInterval;
  viewsLabel: string;
  visitorsLabel: string;
  className?: string;
}

interface TrafficPairBarChartProps {
  data: Array<{
    timestampMs: number;
    views: number;
    visitors: number;
  }>;
  locale: Locale;
  interval: DashboardInterval;
  viewsLabel: string;
  visitorsLabel: string;
  compact?: boolean;
  maxPoints?: number;
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

function safeCount(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.round(value));
}

function useChartVisibility(rootMargin = "120px 0px") {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [isVisible, setIsVisible] = useState(false);
  const [hasMeasuredVisibility, setHasMeasuredVisibility] = useState(false);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    if (typeof IntersectionObserver === "undefined") {
      setIsVisible(true);
      setHasMeasuredVisibility(true);
      return;
    }

    const observer = new IntersectionObserver(
      (entries) => {
        const entry = entries[0];
        const nextVisible = Boolean(
          entry?.isIntersecting || (entry?.intersectionRatio ?? 0) > 0,
        );
        setIsVisible(nextVisible);
        setHasMeasuredVisibility(true);
      },
      {
        root: null,
        rootMargin,
        threshold: 0.01,
      },
    );

    observer.observe(container);
    return () => {
      observer.disconnect();
    };
  }, [rootMargin]);

  return {
    containerRef,
    isVisible,
    hasMeasuredVisibility,
  };
}

function useAnimationOnChartSwitch({
  switchKey,
  hasData,
  isVisible,
  hasMeasuredVisibility,
}: {
  switchKey: string;
  hasData: boolean;
  isVisible: boolean;
  hasMeasuredVisibility: boolean;
}): boolean {
  const appliedKeyRef = useRef<string | null>(null);
  const animationEnabledRef = useRef(false);

  if (appliedKeyRef.current !== switchKey && hasMeasuredVisibility) {
    appliedKeyRef.current = switchKey;
    animationEnabledRef.current = hasData && isVisible;
  }

  if (appliedKeyRef.current !== switchKey) {
    // Before first visibility snapshot, keep this frame conservative.
    return hasData && isVisible;
  }

  return animationEnabledRef.current;
}

function downsampleTrafficData(
  data: Array<{ timestampMs: number; views: number; visitors: number }>,
  maxPoints: number,
): Array<{ timestampMs: number; views: number; visitors: number }> {
  if (
    !Number.isFinite(maxPoints) ||
    maxPoints <= 0 ||
    data.length <= maxPoints
  ) {
    return data;
  }

  const chunkSize = Math.ceil(data.length / maxPoints);
  const next: Array<{ timestampMs: number; views: number; visitors: number }> =
    [];

  for (let index = 0; index < data.length; index += chunkSize) {
    const chunk = data.slice(index, index + chunkSize);
    if (chunk.length === 0) continue;

    const timestampMs = chunk[chunk.length - 1]?.timestampMs ?? 0;
    let views = 0;
    let visitors = 0;

    for (const point of chunk) {
      views += safeCount(point.views);
      visitors += safeCount(point.visitors);
    }

    next.push({
      timestampMs,
      views,
      visitors: Math.min(visitors, views),
    });
  }

  return next;
}

function tickDateFormat(
  locale: Locale,
  interval: DashboardInterval,
): Intl.DateTimeFormat {
  if (interval === "minute" || interval === "hour") {
    return new Intl.DateTimeFormat(intlLocale(locale), {
      month: "numeric",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  }
  if (interval === "day") {
    return new Intl.DateTimeFormat(intlLocale(locale), {
      month: "numeric",
      day: "numeric",
    });
  }
  return new Intl.DateTimeFormat(intlLocale(locale), {
    year: "2-digit",
    month: "short",
    day: interval === "week" ? "numeric" : undefined,
  });
}

function tooltipDateFormat(
  locale: Locale,
  interval: DashboardInterval,
): Intl.DateTimeFormat {
  if (interval === "minute" || interval === "hour") {
    return new Intl.DateTimeFormat(intlLocale(locale), {
      year: "numeric",
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  }
  return new Intl.DateTimeFormat(intlLocale(locale), {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

function SiteTrafficStackTooltip({
  active,
  payload,
  series,
  dateFormatter,
  viewsLabel,
  visitorsLabel,
}: {
  active?: boolean;
  payload?: Array<{ payload?: Record<string, unknown> }>;
  series: SiteTrafficSeriesItem[];
  dateFormatter: Intl.DateTimeFormat;
  viewsLabel: string;
  visitorsLabel: string;
}) {
  if (!active || !payload?.length) return null;

  const row = payload[0]?.payload;
  if (!row) return null;

  const timestamp = Number(row.timestampMs ?? 0);
  const groupCount = Math.max(1, series.length);
  const sqrtCount = Math.sqrt(groupCount);
  const minCandidate = Math.max(1, Math.floor(sqrtCount));
  const maxCandidate = Math.max(1, Math.ceil(sqrtCount));
  const candidateColumns =
    minCandidate === maxCandidate
      ? [minCandidate]
      : [minCandidate, maxCandidate];
  const columnCount = candidateColumns.reduce((best, current) => {
    const bestRows = Math.ceil(groupCount / best);
    const currentRows = Math.ceil(groupCount / current);
    const bestDelta = Math.abs(bestRows - best);
    const currentDelta = Math.abs(currentRows - current);
    if (currentDelta < bestDelta) return current;
    if (currentDelta > bestDelta) return best;
    return current > best ? current : best;
  }, candidateColumns[0]);
  const tooltipWidthPx = Math.max(280, Math.min(560, columnCount * 160));

  return (
    <div
      className="grid min-w-[280px] items-start gap-2 rounded-none border border-border/50 bg-background px-2.5 py-2 text-xs shadow-xl"
      style={{ width: `min(68vw, ${tooltipWidthPx}px)` }}
    >
      <div className="font-medium">
        {dateFormatter.format(new Date(timestamp))}
      </div>
      <div
        className="grid gap-1.5"
        style={{
          gridTemplateColumns: `repeat(${columnCount}, minmax(0, 1fr))`,
        }}
      >
        {series.map((item) => {
          const views = safeCount(Number(row[item.viewsKey] ?? 0));
          const visitors = safeCount(Number(row[item.visitorsKey] ?? 0));
          return (
            <div
              key={item.siteId}
              className="flex items-stretch overflow-hidden rounded-none"
            >
              <span
                className="w-1.5 shrink-0 self-stretch rounded-none"
                style={{ backgroundColor: item.viewsColor }}
              />
              <div className="min-w-0 flex-1 space-y-1 px-2 py-1.5">
                <div className="min-w-0 truncate font-medium">
                  {item.siteName}
                </div>
                <div className="flex items-center justify-between gap-3">
                  <span className="text-muted-foreground">{viewsLabel}</span>
                  <span className="font-mono tabular-nums">
                    {views.toLocaleString()}
                  </span>
                </div>
                <div className="flex items-center justify-between gap-3">
                  <span className="text-muted-foreground">{visitorsLabel}</span>
                  <span className="font-mono tabular-nums">
                    {visitors.toLocaleString()}
                  </span>
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

export const SiteTrafficStackChart = memo(function SiteTrafficStackChart({
  data,
  sites,
  locale,
  interval,
  viewsLabel,
  visitorsLabel,
  className,
}: SiteTrafficStackChartProps) {
  const cachedSiteOrderRef = useRef<string[] | null>(null);
  const [activeSiteIds, setActiveSiteIds] = useState<string[]>([]);
  const { containerRef, isVisible, hasMeasuredVisibility } =
    useChartVisibility();

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
    const nextSeries: SiteTrafficSeriesItem[] = orderedSites.map((site, index) => {
      const colors = pairs[index] ?? { views: "#2dd4bf", visitors: "#2dd4bf" };
      return {
        siteId: site.id,
        siteName: site.name,
        visitorsKey: `site${index}Visitors`,
        viewsKey: `site${index}Views`,
        visitorsColor: colors.visitors,
        viewsColor: colors.views,
      };
    });

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
      // Input is already sorted upstream by timestamp.
      data.map((point) => {
        const bySite = new Map(
          point.sites.map((sitePoint) => [
            sitePoint.siteId,
            {
              views: safeCount(sitePoint.views),
              visitors: safeCount(sitePoint.visitors),
            },
          ]),
        );

        const row: Record<string, number> = {
          timestampMs: point.timestampMs,
        };

        for (const item of series) {
          const values = bySite.get(item.siteId);
          row[item.visitorsKey] = values?.visitors ?? 0;
          row[item.viewsKey] = values?.views ?? 0;
        }

        return row;
      }),
    [data, series],
  );
  const tickFormatter = useMemo(
    () => tickDateFormat(locale, interval),
    [locale, interval],
  );
  const tooltipFormatter = useMemo(
    () => tooltipDateFormat(locale, interval),
    [locale, interval],
  );
  const legendKey = useMemo(
    () => series.map((item) => item.siteId).join("|"),
    [series],
  );
  const stackChartDataKey = useMemo(() => {
    const firstTimestamp = data[0]?.timestampMs ?? 0;
    const lastTimestamp = data[data.length - 1]?.timestampMs ?? 0;
    return `${interval}:${legendKey}:${data.length}:${firstTimestamp}:${lastTimestamp}`;
  }, [interval, legendKey, data]);
  const isAnimationActive = useAnimationOnChartSwitch({
    switchKey: stackChartDataKey,
    hasData: chartData.length > 0,
    isVisible,
    hasMeasuredVisibility,
  });

  return (
    <div ref={containerRef} className="space-y-2">
      <ChartContainer
        className={cn("h-[320px] w-full aspect-auto", className)}
        config={config}
      >
        <BarChart data={chartData} margin={{ left: 8, right: 8 }} barCategoryGap="22%" barGap={2}>
          <CartesianGrid vertical={false} />
          <XAxis
            dataKey="timestampMs"
            tickFormatter={(value) => tickFormatter.format(new Date(Number(value ?? 0)))}
            tickLine={false}
            axisLine={false}
            tickMargin={8}
            minTickGap={14}
          />
          <YAxis allowDecimals={false} tickLine={false} axisLine={false} width={36} />
          <ChartTooltip
            allowEscapeViewBox={{ x: false, y: true }}
            wrapperStyle={{ zIndex: 20 }}
            content={(
              <SiteTrafficStackTooltip
                series={series}
                dateFormatter={tooltipFormatter}
                viewsLabel={viewsLabel}
                visitorsLabel={visitorsLabel}
              />
            )}
          />
          {series.map((item) => (
            <Bar
              key={item.visitorsKey}
              dataKey={item.visitorsKey}
              stackId="visitors"
              fill={`var(--color-${item.visitorsKey})`}
              fillOpacity={
                !hasActiveSites || activeSiteIdSet.has(item.siteId) ? 1 : 0.28
              }
              radius={0}
              isAnimationActive={isAnimationActive}
              animationDuration={isAnimationActive ? 260 : 0}
            />
          ))}
          {series.map((item) => (
            <Bar
              key={item.viewsKey}
              dataKey={item.viewsKey}
              stackId="views"
              fill={`var(--color-${item.viewsKey})`}
              fillOpacity={
                !hasActiveSites || activeSiteIdSet.has(item.siteId) ? 1 : 0.28
              }
              radius={0}
              isAnimationActive={isAnimationActive}
              animationDuration={isAnimationActive ? 260 : 0}
            />
          ))}
        </BarChart>
      </ChartContainer>

      <AutoResizer initial className="min-h-5">
        <AutoTransition initial={false} duration={0.2}>
          <div
            key={legendKey}
            className="mx-auto flex w-full flex-wrap items-center justify-center gap-x-4 gap-y-1.5 text-xs"
          >
            {series.map((item) => (
              <button
                key={item.siteId}
                type="button"
                aria-pressed={activeSiteIdSet.has(item.siteId)}
                onClick={() =>
                  setActiveSiteIds((current) =>
                    current.includes(item.siteId)
                      ? current.filter((siteId) => siteId !== item.siteId)
                      : [...current, item.siteId],
                  )
                }
                className={cn(
                  "inline-flex min-w-0 cursor-pointer items-center gap-1.5 border-0 bg-transparent p-0 text-left transition-opacity focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring/60",
                  hasActiveSites && !activeSiteIdSet.has(item.siteId)
                    ? "opacity-45"
                    : "opacity-100",
                )}
              >
                <span
                  className="h-2.5 w-2.5 shrink-0"
                  style={{ backgroundColor: item.viewsColor }}
                />
                <span
                  className={cn(
                    "max-w-[180px] truncate",
                    activeSiteIdSet.has(item.siteId)
                      ? "text-foreground"
                      : "text-muted-foreground",
                  )}
                >
                  {item.siteName}
                </span>
              </button>
            ))}
          </div>
        </AutoTransition>
      </AutoResizer>
    </div>
  );
});

const TRAFFIC_PAIR_CHART_CONFIG = {
  visitors: {
    label: "visitors",
    color: "var(--color-chart-3)",
  },
  nonVisitorViews: {
    label: "views",
    color: "var(--color-chart-1)",
  },
} satisfies ChartConfig;

export const TrafficPairBarChart = memo(function TrafficPairBarChart({
  data,
  locale,
  interval,
  viewsLabel,
  visitorsLabel,
  compact = false,
  maxPoints,
  className,
}: TrafficPairBarChartProps) {
  const { containerRef, isVisible, hasMeasuredVisibility } =
    useChartVisibility();
  const chartData = useMemo(() => {
    const normalized = downsampleTrafficData(
      data,
      maxPoints ?? (compact ? 72 : data.length),
    );
    // Input is already sorted upstream by timestamp.
    return normalized.map((point) => {
      const views = safeCount(point.views);
      const visitors = Math.min(safeCount(point.visitors), views);
      return {
        timestampMs: point.timestampMs,
        visitors,
        nonVisitorViews: Math.max(0, views - visitors),
      };
    });
  }, [data, maxPoints, compact]);
  const config = useMemo(
    () => ({
      visitors: {
        ...TRAFFIC_PAIR_CHART_CONFIG.visitors,
        label: visitorsLabel,
      },
      nonVisitorViews: {
        ...TRAFFIC_PAIR_CHART_CONFIG.nonVisitorViews,
        label: viewsLabel,
      },
    }),
    [viewsLabel, visitorsLabel],
  );
  const tickFormatter = useMemo(
    () => tickDateFormat(locale, interval),
    [locale, interval],
  );
  const tooltipFormatter = useMemo(
    () => tooltipDateFormat(locale, interval),
    [locale, interval],
  );
  const pairChartDataKey = useMemo(() => {
    const firstTimestamp = chartData[0]?.timestampMs ?? 0;
    const lastTimestamp = chartData[chartData.length - 1]?.timestampMs ?? 0;
    return `${interval}:${compact ? "compact" : "regular"}:${chartData.length}:${firstTimestamp}:${lastTimestamp}`;
  }, [interval, compact, chartData]);
  const isAnimationActive = useAnimationOnChartSwitch({
    switchKey: pairChartDataKey,
    hasData: chartData.length > 0,
    isVisible,
    hasMeasuredVisibility,
  });

  return (
    <div ref={containerRef} className="w-full">
      <ChartContainer
        className={cn(
          compact ? "h-4 w-full aspect-auto" : "h-[180px] w-full aspect-auto",
          className,
        )}
        config={config}
      >
        <BarChart
          data={chartData}
          margin={compact ? { left: 0, right: 0, top: 0, bottom: 0 } : { left: 8, right: 8 }}
          barGap={0}
        >
          {compact ? null : <CartesianGrid vertical={false} />}
          {compact ? null : (
            <XAxis
              dataKey="timestampMs"
              tickFormatter={(value) => tickFormatter.format(new Date(Number(value ?? 0)))}
              tickLine={false}
              axisLine={false}
              tickMargin={8}
              minTickGap={14}
            />
          )}
          {compact ? null : (
            <YAxis allowDecimals={false} tickLine={false} axisLine={false} width={32} />
          )}
          {compact ? null : (
            <ChartTooltip
              allowEscapeViewBox={{ x: false, y: true }}
              wrapperStyle={{ zIndex: 20 }}
              content={(
                <ChartTooltipContent
                  indicator="line"
                  labelFormatter={(value, payload) => {
                    const timestamp = Number(payload?.[0]?.payload?.timestampMs ?? value ?? 0);
                    return tooltipFormatter.format(new Date(timestamp));
                  }}
                />
              )}
            />
          )}
          <Bar
            dataKey="visitors"
            stackId="traffic"
            fill="var(--color-visitors)"
            radius={0}
            isAnimationActive={isAnimationActive}
            animationDuration={isAnimationActive ? 220 : 0}
          />
          <Bar
            dataKey="nonVisitorViews"
            stackId="traffic"
            fill="var(--color-nonVisitorViews)"
            radius={0}
            isAnimationActive={isAnimationActive}
            animationDuration={isAnimationActive ? 220 : 0}
          />
        </BarChart>
      </ChartContainer>
    </div>
  );
});
