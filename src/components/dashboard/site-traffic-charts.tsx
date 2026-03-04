"use client";

import { useMemo } from "react";
import { Bar, BarChart, CartesianGrid, XAxis, YAxis } from "recharts";
import {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig,
} from "@/components/ui/chart";
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
  className?: string;
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
  const match = color.trim().match(
    /oklch\s*\(\s*([\d.]+)%?\s+([\d.]+)%?\s+([\d.]+)\s*\)/i,
  );
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

function interpolateGradient(color1: string, color2: string, steps: number): string[] {
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

function deriveVisitorsColor(viewsHex: string): string {
  const oklch = rgbToOklch(hexToRgb(viewsHex));
  return rgbToHex(oklchToRgb({
    l: clamp(oklch.l + 0.14, 0, 0.95),
    c: clamp(oklch.c * 0.72, 0.01, 0.37),
    h: oklch.h,
  }));
}

function buildSiteColorPairs(
  count: number,
  baseColor = "oklch(0.85 0.13 165)",
): Array<{ views: string; visitors: string }> {
  if (count <= 0) return [];
  const complementary = generateComplementary(baseColor);
  const gradient = interpolateGradient(baseColor, complementary, Math.max(count, 2));
  return Array.from({ length: count }, (_, index) => {
    const views = gradient[index] ?? gradient[gradient.length - 1] ?? "#2dd4bf";
    return {
      views,
      visitors: deriveVisitorsColor(views),
    };
  });
}

function safeCount(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.round(value));
}

function tickDateFormat(locale: Locale, interval: DashboardInterval): Intl.DateTimeFormat {
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

function tooltipDateFormat(locale: Locale, interval: DashboardInterval): Intl.DateTimeFormat {
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

export function SiteTrafficStackChart({
  data,
  sites,
  locale,
  interval,
  viewsLabel,
  visitorsLabel,
  className,
}: SiteTrafficStackChartProps) {
  const { series, config } = useMemo(() => {
    // Mirrors NeutralPress DimensionStats: start from a base color, invert to complementary,
    // then interpolate in OKLCH for evenly perceived multi-site colors.
    const pairs = buildSiteColorPairs(sites.length);
    const nextSeries = sites.map((site, index) => {
      const colors = pairs[index] ?? { views: "#2dd4bf", visitors: "#86efac" };
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
  }, [sites, viewsLabel, visitorsLabel]);

  const chartData = [...data]
    .sort((left, right) => left.timestampMs - right.timestampMs)
    .map((point) => {
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
    });

  const tickFormatter = tickDateFormat(locale, interval);
  const tooltipFormatter = tooltipDateFormat(locale, interval);

  return (
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
        {series.map((item) => (
          <Bar
            key={item.visitorsKey}
            dataKey={item.visitorsKey}
            stackId="visitors"
            fill={`var(--color-${item.visitorsKey})`}
            radius={0}
          />
        ))}
        {series.map((item) => (
          <Bar
            key={item.viewsKey}
            dataKey={item.viewsKey}
            stackId="views"
            fill={`var(--color-${item.viewsKey})`}
            radius={0}
          />
        ))}
      </BarChart>
    </ChartContainer>
  );
}

export function TrafficPairBarChart({
  data,
  locale,
  interval,
  viewsLabel,
  visitorsLabel,
  compact = false,
  className,
}: TrafficPairBarChartProps) {
  const chartData = [...data]
    .sort((left, right) => left.timestampMs - right.timestampMs)
    .map((point) => {
      const views = safeCount(point.views);
      const visitors = Math.min(safeCount(point.visitors), views);
      return {
        timestampMs: point.timestampMs,
        visitors,
        nonVisitorViews: Math.max(0, views - visitors),
        views,
      };
    });

  const config = {
    visitors: {
      label: visitorsLabel,
      color: "var(--color-chart-3)",
    },
    nonVisitorViews: {
      label: viewsLabel,
      color: "var(--color-chart-1)",
    },
  } satisfies ChartConfig;
  const tickFormatter = tickDateFormat(locale, interval);
  const tooltipFormatter = tooltipDateFormat(locale, interval);

  return (
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
        />
        <Bar
          dataKey="nonVisitorViews"
          stackId="traffic"
          fill="var(--color-nonVisitorViews)"
          radius={0}
        />
      </BarChart>
    </ChartContainer>
  );
}
