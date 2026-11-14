import { useId, useMemo } from "react";
import {
  calculateChartYAxisWidth,
  ChartContainer,
  ChartLegend,
  ChartLegendContent,
  ChartTooltip,
  ChartTooltipIndicator,
} from "@insightflare/ui/chart";
import { Spinner } from "@insightflare/ui/spinner";
import {
  Area,
  AreaChart,
  CartesianGrid,
  type TooltipProps,
  XAxis,
  YAxis,
} from "recharts";

import { numberFormat, percentFormat } from "../charts/chart-format";
import {
  createChartAxisDateFormatter,
  createChartTooltipDateFormatter,
} from "../charts/chart-time";
import type { ChartLocale, DashboardInterval } from "../charts/types";
import { cn } from "../utils/cn";

export interface GoalTimeseriesMetric {
  readonly converted: number;
  readonly rate: number;
  readonly total: number;
}

export interface GoalTimeseriesChartPoint {
  readonly sessions: GoalTimeseriesMetric;
  readonly sessionsRate: number;
  readonly timestampMs: number;
  readonly visitors: GoalTimeseriesMetric;
  readonly visitorsRate: number;
  readonly comparisonSessions?: GoalTimeseriesMetric;
  readonly comparisonSessionsRate?: number;
  readonly comparisonVisitors?: GoalTimeseriesMetric;
  readonly comparisonVisitorsRate?: number;
}

export interface GoalTimeseriesLabels {
  readonly visitors: string;
  readonly sessions: string;
}

/** Props-only goal conversion-rate timeseries; points are already bucketed. */
export interface GoalTimeseriesViewProps {
  readonly data: ReadonlyArray<GoalTimeseriesChartPoint>;
  readonly labels: GoalTimeseriesLabels;
  readonly locale: ChartLocale;
  readonly timeZone: string;
  readonly interval: DashboardInterval;
  readonly loading?: boolean;
  readonly hasComparison?: boolean;
  readonly comparisonLabel?: string;
}

function GoalTimeseriesTooltip({
  active,
  interval,
  labels,
  locale,
  payload,
  comparisonLabel,
  timeZone,
}: TooltipProps<number, string> & {
  interval: DashboardInterval;
  labels: GoalTimeseriesLabels;
  locale: ChartLocale;
  comparisonLabel?: string;
  timeZone: string;
}) {
  if (!active || !payload?.length) return null;
  const point = payload[0]?.payload as GoalTimeseriesChartPoint | undefined;
  if (!point) return null;
  const dateFormatter = createChartTooltipDateFormatter(
    locale,
    interval,
    timeZone,
  );
  const audiences: Array<{
    color: string;
    label: string;
    metric: GoalTimeseriesMetric;
  }> = [
    {
      color: "var(--color-visitorsRate)",
      label: labels.visitors,
      metric: point.visitors,
    },
    {
      color: "var(--color-sessionsRate)",
      label: labels.sessions,
      metric: point.sessions,
    },
  ];
  if (comparisonLabel && point.comparisonVisitors && point.comparisonSessions) {
    audiences.push(
      {
        color: "var(--color-comparisonVisitorsRate)",
        label: `${comparisonLabel} · ${labels.visitors}`,
        metric: point.comparisonVisitors,
      },
      {
        color: "var(--color-comparisonSessionsRate)",
        label: `${comparisonLabel} · ${labels.sessions}`,
        metric: point.comparisonSessions,
      },
    );
  }

  return (
    <div className="grid min-w-[18rem] items-start gap-1.5 rounded-none border border-border/50 bg-background px-2.5 py-1.5 text-xs shadow-xl">
      <div className="font-medium">
        {dateFormatter.format(new Date(point.timestampMs))}
      </div>
      <div className="grid gap-1">
        {audiences.map(({ color, label, metric }) => (
          <div key={label} className="flex w-full items-center gap-3">
            <span className="inline-flex min-w-0 flex-1 items-center gap-2 overflow-hidden">
              <ChartTooltipIndicator color={color} />
              <span className="truncate text-muted-foreground">{label}</span>
            </span>
            <span className="ml-auto min-w-[10.5rem] shrink-0 whitespace-nowrap text-right font-mono text-foreground tabular-nums">
              {numberFormat(locale, metric.converted)} /{" "}
              {numberFormat(locale, metric.total)} ·{" "}
              {percentFormat(locale, metric.rate)}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

export function GoalTimeseriesView({
  data,
  labels,
  locale,
  timeZone,
  interval,
  loading = false,
  hasComparison = false,
  comparisonLabel,
}: GoalTimeseriesViewProps) {
  const gradientId = useId().replace(/:/g, "");
  const axisFormatter = useMemo(
    () => createChartAxisDateFormatter(locale, interval, timeZone, "regular"),
    [interval, locale, timeZone],
  );
  const yAxisLabels = useMemo(
    () => [0, 0.25, 0.5, 0.75, 1].map((value) => percentFormat(locale, value)),
    [locale],
  );
  const yAxisWidth = useMemo(
    () => calculateChartYAxisWidth(yAxisLabels, 4),
    [yAxisLabels],
  );
  return (
    <div className="space-y-3">
      <div className="relative">
        <ChartContainer
          className={cn(
            "h-[280px] w-full min-w-0 aspect-auto transition-opacity duration-200 [&_.recharts-area-area]:transition-[filter] [&_.recharts-area-area]:duration-200",
            loading
              ? "[&_.recharts-area-area]:brightness-50"
              : "[&_.recharts-area-area]:brightness-100",
          )}
          data-goal-series="visitors,sessions"
          config={{
            sessionsRate: {
              label: labels.sessions,
              color: "var(--color-chart-1)",
            },
            visitorsRate: {
              label: labels.visitors,
              color: "var(--color-chart-3)",
            },
            ...(hasComparison
              ? {
                  comparisonSessionsRate: {
                    label: `${comparisonLabel ?? "Comparison"} · ${labels.sessions}`,
                    color: "var(--color-chart-secondary-1)",
                  },
                  comparisonVisitorsRate: {
                    label: `${comparisonLabel ?? "Comparison"} · ${labels.visitors}`,
                    color: "var(--color-chart-secondary-3)",
                  },
                }
              : {}),
          }}
        >
          <AreaChart
            accessibilityLayer
            data={data as GoalTimeseriesChartPoint[]}
            margin={{ left: 0, right: 8, top: 12 }}
          >
            <defs>
              <linearGradient
                id={`${gradientId}-visitors`}
                x1="0"
                y1="0"
                x2="0"
                y2="1"
              >
                <stop
                  offset="5%"
                  stopColor="var(--color-visitorsRate)"
                  stopOpacity={0.3}
                />
                <stop
                  offset="95%"
                  stopColor="var(--color-visitorsRate)"
                  stopOpacity={0.02}
                />
              </linearGradient>
              <linearGradient
                id={`${gradientId}-sessions`}
                x1="0"
                y1="0"
                x2="0"
                y2="1"
              >
                <stop
                  offset="5%"
                  stopColor="var(--color-sessionsRate)"
                  stopOpacity={0.3}
                />
                <stop
                  offset="95%"
                  stopColor="var(--color-sessionsRate)"
                  stopOpacity={0.02}
                />
              </linearGradient>
            </defs>
            <CartesianGrid vertical={false} />
            <XAxis
              dataKey="timestampMs"
              tickFormatter={(value) =>
                axisFormatter.format(new Date(Number(value ?? 0)))
              }
              tickLine={false}
              axisLine={false}
              tickMargin={8}
              minTickGap={14}
            />
            <YAxis
              width={yAxisWidth}
              domain={[0, 1]}
              tickFormatter={(value) => percentFormat(locale, Number(value))}
              tickLine={false}
              axisLine={false}
              tickMargin={4}
            />
            <ChartTooltip
              cursor={false}
              allowEscapeViewBox={{ x: false, y: true }}
              wrapperStyle={{ zIndex: 20 }}
              content={
                <GoalTimeseriesTooltip
                  interval={interval}
                  labels={labels}
                  locale={locale}
                  comparisonLabel={hasComparison ? comparisonLabel : undefined}
                  timeZone={timeZone}
                />
              }
            />
            <Area
              dataKey="visitorsRate"
              type="linear"
              stroke="var(--color-visitorsRate)"
              fill={`url(#${gradientId}-visitors)`}
              strokeWidth={2}
              dot={false}
              activeDot={{
                r: 3,
                stroke: "var(--color-visitorsRate)",
                fill: "var(--color-visitorsRate)",
              }}
            />
            <Area
              dataKey="sessionsRate"
              type="linear"
              stroke="var(--color-sessionsRate)"
              fill={`url(#${gradientId}-sessions)`}
              strokeWidth={2}
              dot={false}
              activeDot={{
                r: 3,
                stroke: "var(--color-sessionsRate)",
                fill: "var(--color-sessionsRate)",
              }}
            />
            {hasComparison
              ? [
                  <Area
                    key="comparisonVisitorsRate"
                    dataKey="comparisonVisitorsRate"
                    type="linear"
                    stroke="var(--color-comparisonVisitorsRate)"
                    fill="none"
                    strokeWidth={1.5}
                    dot={false}
                    activeDot={false}
                    connectNulls
                  />,
                  <Area
                    key="comparisonSessionsRate"
                    dataKey="comparisonSessionsRate"
                    type="linear"
                    stroke="var(--color-comparisonSessionsRate)"
                    fill="none"
                    strokeWidth={1.5}
                    dot={false}
                    activeDot={false}
                    connectNulls
                  />,
                ]
              : null}
            <ChartLegend
              content={
                <ChartLegendContent className="pt-2 flex-wrap justify-center gap-x-4 gap-y-2 [&>div>div]:h-2.5 [&>div>div]:w-2.5 [&>div>div]:shrink-0 [&>div>div]:rounded-none" />
              }
            />
          </AreaChart>
        </ChartContainer>
        <div
          aria-hidden={!loading}
          className="pointer-events-none absolute inset-x-0 top-0 bottom-8 z-10 flex items-center justify-center text-muted-foreground"
        >
          {loading ? <Spinner className="size-5" /> : null}
        </div>
      </div>
    </div>
  );
}
