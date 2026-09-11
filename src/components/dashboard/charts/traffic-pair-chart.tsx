import type { TooltipProps } from "recharts";

import { type ChartConfig, ChartTooltipIndicator } from "@/components/ui/chart";
import { intlLocale } from "@/lib/dashboard/format";
import type { DashboardInterval } from "@/lib/dashboard/query-state";
import {
  downsampleTrafficData,
  fillMissingTrafficData,
  safeChartCount,
} from "@/lib/dashboard/traffic-chart-data";
import type { Locale } from "@/lib/i18n/config";

export interface TrafficPairDataPoint {
  timestampMs: number;
  views: number;
  visitors: number;
}

export interface TrafficPairChartPoint extends TrafficPairDataPoint {
  nonVisitorViews: number;
}

export interface TrafficPairComparisonChartPoint extends TrafficPairChartPoint {
  currentVisitors: number;
  currentNonVisitorViews: number;
  comparisonViews: number;
  comparisonVisitors: number;
  comparisonNonVisitorViews: number;
}

export interface TrafficPairRange {
  from: number;
  to: number;
}

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

export function createTrafficPairChartConfig(
  viewsLabel: string,
  visitorsLabel: string,
): ChartConfig {
  return {
    visitors: {
      ...TRAFFIC_PAIR_CHART_CONFIG.visitors,
      label: visitorsLabel,
    },
    nonVisitorViews: {
      ...TRAFFIC_PAIR_CHART_CONFIG.nonVisitorViews,
      label: viewsLabel,
    },
  };
}

export function createTrafficPairChartData(
  data: ReadonlyArray<TrafficPairDataPoint>,
  interval: DashboardInterval,
  timeZone: string,
  maxPoints?: number,
  range?: TrafficPairRange,
  dataIsComplete = false,
): TrafficPairChartPoint[] {
  const completed = dataIsComplete
    ? Array.from(data)
    : fillMissingTrafficData(Array.from(data), interval, timeZone, range);
  const normalized = downsampleTrafficData(
    completed,
    maxPoints ?? completed.length,
  );

  return normalized.map((point) => {
    const views = safeChartCount(point.views);
    const visitors = Math.min(safeChartCount(point.visitors), views);
    return {
      timestampMs: point.timestampMs,
      views,
      visitors,
      nonVisitorViews: Math.max(0, views - visitors),
    };
  });
}

export function createTrafficPairComparisonChartData(
  data: ReadonlyArray<TrafficPairDataPoint>,
  comparisonData: ReadonlyArray<TrafficPairDataPoint>,
  interval: DashboardInterval,
  timeZone: string,
  maxPoints?: number,
  range?: TrafficPairRange,
  comparisonRange?: TrafficPairRange,
  dataIsComplete = false,
): TrafficPairComparisonChartPoint[] {
  const current = createTrafficPairChartData(
    data,
    interval,
    timeZone,
    maxPoints,
    range,
    dataIsComplete,
  );
  const comparison = createTrafficPairChartData(
    comparisonData,
    interval,
    timeZone,
    maxPoints,
    comparisonRange ?? range,
    dataIsComplete,
  );

  return current.map((point, index) => {
    const comparisonPoint = comparison[index];
    return {
      ...point,
      currentVisitors: point.visitors,
      currentNonVisitorViews: point.nonVisitorViews,
      comparisonViews: comparisonPoint?.views ?? 0,
      comparisonVisitors: comparisonPoint?.visitors ?? 0,
      comparisonNonVisitorViews: comparisonPoint?.nonVisitorViews ?? 0,
    };
  });
}

export function createTrafficPairComparisonChartConfig(
  currentPeriodLabel: string,
  comparisonLabel: string,
  viewsLabel: string,
  visitorsLabel: string,
): ChartConfig {
  return {
    comparisonVisitors: {
      label: `${comparisonLabel} · ${visitorsLabel}`,
      color: "var(--color-compare-chart-3)",
    },
    comparisonNonVisitorViews: {
      label: `${comparisonLabel} · ${viewsLabel}`,
      color: "var(--color-compare-chart-1)",
    },
    currentVisitors: {
      label: `${currentPeriodLabel} · ${visitorsLabel}`,
      color: "var(--color-chart-3)",
    },
    currentNonVisitorViews: {
      label: `${currentPeriodLabel} · ${viewsLabel}`,
      color: "var(--color-chart-1)",
    },
  };
}

export function TrafficPairTooltip({
  active,
  payload,
  label,
  viewsLabel,
  visitorsLabel,
  tooltipFormatter,
  countFormatter,
}: TooltipProps<number, string> & {
  viewsLabel: string;
  visitorsLabel: string;
  tooltipFormatter: Intl.DateTimeFormat;
  countFormatter: Intl.NumberFormat;
}) {
  if (!active || !payload?.length) return null;
  const point = payload[0]?.payload as Partial<TrafficPairChartPoint> | null;
  const timestamp = Number(point?.timestampMs ?? label ?? 0);
  const views = safeChartCount(Number(point?.views ?? 0));
  const visitors = safeChartCount(Number(point?.visitors ?? 0));

  return (
    <div className="grid min-w-32 items-start gap-1.5 rounded-none border border-border/50 bg-background px-2.5 py-1.5 text-xs shadow-xl">
      <div className="font-medium">
        {tooltipFormatter.format(new Date(timestamp))}
      </div>
      <div className="grid gap-1.5">
        <div className="flex w-full items-center gap-2">
          <ChartTooltipIndicator color="var(--color-nonVisitorViews)" />
          <div className="flex flex-1 items-center justify-between gap-3 leading-none">
            <span className="text-muted-foreground">{viewsLabel}</span>
            <span className="font-mono font-medium tabular-nums text-foreground">
              {countFormatter.format(views)}
            </span>
          </div>
        </div>
        <div className="flex w-full items-center gap-2">
          <ChartTooltipIndicator color="var(--color-visitors)" />
          <div className="flex flex-1 items-center justify-between gap-3 leading-none">
            <span className="text-muted-foreground">{visitorsLabel}</span>
            <span className="font-mono font-medium tabular-nums text-foreground">
              {countFormatter.format(visitors)}
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}

export function TrafficPairComparisonTooltip({
  active,
  payload,
  label,
  currentPeriodLabel,
  comparisonLabel,
  viewsLabel,
  visitorsLabel,
  tooltipFormatter,
  countFormatter,
}: TooltipProps<number, string> & {
  currentPeriodLabel: string;
  comparisonLabel: string;
  viewsLabel: string;
  visitorsLabel: string;
  tooltipFormatter: Intl.DateTimeFormat;
  countFormatter: Intl.NumberFormat;
}) {
  if (!active || !payload?.length) return null;

  const point = payload[0]
    ?.payload as Partial<TrafficPairComparisonChartPoint> | null;
  const timestamp = Number(point?.timestampMs ?? label ?? 0);
  const views = safeChartCount(Number(point?.views ?? 0));
  const visitors = safeChartCount(Number(point?.visitors ?? 0));
  const comparisonViews = safeChartCount(Number(point?.comparisonViews ?? 0));
  const comparisonVisitors = safeChartCount(
    Number(point?.comparisonVisitors ?? 0),
  );

  const rows = [
    {
      label: `${currentPeriodLabel} · ${viewsLabel}`,
      color: "var(--color-chart-1)",
      value: views,
    },
    {
      label: `${currentPeriodLabel} · ${visitorsLabel}`,
      color: "var(--color-chart-3)",
      value: visitors,
    },
    {
      label: `${comparisonLabel} · ${viewsLabel}`,
      color: "var(--color-compare-chart-1)",
      value: comparisonViews,
    },
    {
      label: `${comparisonLabel} · ${visitorsLabel}`,
      color: "var(--color-compare-chart-3)",
      value: comparisonVisitors,
    },
  ];

  return (
    <div className="grid min-w-[220px] items-start gap-1.5 rounded-none border border-border/50 bg-background px-2.5 py-1.5 text-xs shadow-xl">
      <div className="font-medium">
        {tooltipFormatter.format(new Date(timestamp))}
      </div>
      <div className="grid gap-1.5">
        {rows.map((row) => (
          <div key={row.label} className="flex w-full items-center gap-2">
            <ChartTooltipIndicator color={row.color} />
            <div className="flex flex-1 items-center justify-between gap-3 leading-none">
              <span className="text-muted-foreground">{row.label}</span>
              <span className="font-mono font-medium tabular-nums text-foreground">
                {countFormatter.format(row.value)}
              </span>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

export function createTrafficPairCountFormatter(
  locale: Locale,
): Intl.NumberFormat {
  return new Intl.NumberFormat(intlLocale(locale));
}
