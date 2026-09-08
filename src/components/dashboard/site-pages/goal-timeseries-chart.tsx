import { useId, useMemo } from "react";
import {
  Area,
  AreaChart,
  CartesianGrid,
  type TooltipProps,
  XAxis,
  YAxis,
} from "recharts";

import {
  calculateChartYAxisWidth,
  ChartContainer,
  ChartLegend,
  ChartLegendContent,
  ChartTooltip,
} from "@/components/ui/chart";
import { Spinner } from "@/components/ui/spinner";
import {
  createChartAxisDateFormatter,
  createChartTooltipDateFormatter,
} from "@/lib/dashboard/chart-time";
import { numberFormat, percentFormat } from "@/lib/dashboard/format";
import type { DashboardInterval } from "@/lib/dashboard/query-state";
import {
  addZonedInterval,
  startOfZonedInterval,
} from "@/lib/dashboard/time-zone";
import type { GoalTimeseriesPoint } from "@/lib/edge-client";
import type { Locale } from "@/lib/i18n/config";
import type { AppMessages } from "@/lib/i18n/messages";
import { cn } from "@/lib/utils";

interface GoalChartMetric {
  converted: number;
  rate: number;
  total: number;
}

interface GoalChartPoint {
  sessions: GoalChartMetric;
  sessionsRate: number;
  timestampMs: number;
  visitors: GoalChartMetric;
  visitorsRate: number;
}

function safeCount(value: number): number {
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

function safeMetric(metric?: GoalTimeseriesPoint["visitors"]): GoalChartMetric {
  const total = safeCount(Number(metric?.total ?? 0));
  const converted = Math.min(total, safeCount(Number(metric?.converted ?? 0)));
  return {
    converted,
    rate:
      total > 0
        ? converted / total
        : Number.isFinite(metric?.conversionRate)
          ? Math.min(1, Math.max(0, metric?.conversionRate ?? 0))
          : 0,
    total,
  };
}

function mergeMetric(
  left: GoalChartMetric,
  right: GoalChartMetric,
): GoalChartMetric {
  const total = left.total + right.total;
  const converted = Math.min(total, left.converted + right.converted);
  return {
    converted,
    rate: total > 0 ? converted / total : 0,
    total,
  };
}

function createGoalChartPoint(
  timestampMs: number,
  sessions?: GoalChartMetric,
  visitors?: GoalChartMetric,
): GoalChartPoint {
  const nextSessions = sessions ?? { converted: 0, rate: 0, total: 0 };
  const nextVisitors = visitors ?? { converted: 0, rate: 0, total: 0 };
  return {
    sessions: nextSessions,
    sessionsRate: nextSessions.rate,
    timestampMs,
    visitors: nextVisitors,
    visitorsRate: nextVisitors.rate,
  };
}

function intervalStepMs(interval: DashboardInterval): number {
  if (interval === "minute") return 60 * 1_000;
  if (interval === "hour") return 60 * 60 * 1_000;
  if (interval === "day") return 24 * 60 * 60 * 1_000;
  if (interval === "week") return 7 * 24 * 60 * 60 * 1_000;
  return 30 * 24 * 60 * 60 * 1_000;
}

function normalizeGoalTimeseries(
  points: readonly GoalTimeseriesPoint[],
  from: number,
  to: number,
  interval: DashboardInterval,
  timeZone: string,
): GoalChartPoint[] {
  const safeFrom = Number.isFinite(from) ? from : (points[0]?.timestampMs ?? 0);
  const safeTo = Number.isFinite(to)
    ? Math.max(safeFrom, to)
    : (points.at(-1)?.timestampMs ?? safeFrom);
  const start = startOfZonedInterval(safeFrom, interval, timeZone);
  const end = startOfZonedInterval(safeTo, interval, timeZone);
  const pointByBucket = new Map<number, GoalChartPoint>();

  for (const point of points) {
    const timestampMs = Number(point.timestampMs);
    if (!Number.isFinite(timestampMs)) continue;
    const bucket = startOfZonedInterval(timestampMs, interval, timeZone);
    if (bucket < start || bucket > end) continue;
    const previous = pointByBucket.get(bucket);
    const sessions = safeMetric(point.sessions);
    const visitors = safeMetric(point.visitors);
    pointByBucket.set(
      bucket,
      previous
        ? createGoalChartPoint(
            bucket,
            mergeMetric(previous.sessions, sessions),
            mergeMetric(previous.visitors, visitors),
          )
        : createGoalChartPoint(bucket, sessions, visitors),
    );
  }

  const normalized: GoalChartPoint[] = [];
  const hardLimit = 2_000;
  let current = start;
  for (let index = 0; index < hardLimit && current <= end; index += 1) {
    normalized.push(
      pointByBucket.get(current) ?? createGoalChartPoint(current),
    );
    let next = addZonedInterval(current, interval, timeZone);
    if (!Number.isFinite(next) || next <= current) {
      next = current + intervalStepMs(interval);
    }
    current = next;
  }
  return normalized;
}

function GoalTimeseriesTooltip({
  active,
  interval,
  labels,
  locale,
  payload,
  timeZone,
}: TooltipProps<number, string> & {
  interval: DashboardInterval;
  labels: AppMessages["goals"];
  locale: Locale;
  timeZone: string;
}) {
  if (!active || !payload?.length) return null;
  const point = payload[0]?.payload as GoalChartPoint | undefined;
  if (!point) return null;
  const dateFormatter = createChartTooltipDateFormatter(
    locale,
    interval,
    timeZone,
  );
  const audiences = [
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

  return (
    <div className="grid min-w-[18rem] items-start gap-1.5 rounded-none border border-border/50 bg-background px-2.5 py-1.5 text-xs shadow-xl">
      <div className="font-medium">
        {dateFormatter.format(new Date(point.timestampMs))}
      </div>
      <div className="grid gap-1">
        {audiences.map(({ color, label, metric }) => (
          <div key={label} className="flex w-full items-center gap-3">
            <span className="inline-flex min-w-0 flex-1 items-center gap-2 overflow-hidden">
              <span
                aria-hidden="true"
                className="h-2.5 w-2.5 shrink-0 rounded-none"
                style={{ backgroundColor: color }}
              />
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

export function GoalTimeseriesChart({
  points,
  locale,
  labels,
  from,
  to,
  timeZone,
  interval,
  loading = false,
}: {
  readonly points: readonly GoalTimeseriesPoint[];
  readonly locale: Locale;
  readonly labels: AppMessages["goals"];
  readonly from: number;
  readonly to: number;
  readonly timeZone: string;
  readonly interval: DashboardInterval;
  readonly loading?: boolean;
}) {
  const gradientId = useId().replace(/:/g, "");
  const chartData = useMemo(
    () =>
      normalizeGoalTimeseries(
        loading ? [] : points,
        from,
        to,
        interval,
        timeZone,
      ),
    [from, interval, loading, points, timeZone, to],
  );
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
          }}
        >
          <AreaChart
            accessibilityLayer
            data={chartData}
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
