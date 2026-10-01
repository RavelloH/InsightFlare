import { useCallback, useId, useMemo, useState } from "react";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@insightflare/ui/card";
import {
  calculateChartYAxisWidth,
  type ChartConfig,
  ChartContainer,
  ChartLegend,
  ChartLegendContent,
  ChartTooltip,
} from "@insightflare/ui/chart";
import { Spinner } from "@insightflare/ui/spinner";
import { RiPulseLine } from "@remixicon/react";
import {
  Area,
  AreaChart,
  CartesianGrid,
  type TooltipProps,
  XAxis,
  YAxis,
} from "recharts";

import { cn } from "../utils/cn";

export interface RealtimeTrafficTrendDataPoint {
  readonly label: string;
  readonly tooltipLabel: string;
  readonly views: number;
  readonly visitors: number;
}

interface RealtimeTrafficTrendViewBaseProps {
  readonly data: ReadonlyArray<RealtimeTrafficTrendDataPoint>;
  readonly locale: string;
  readonly title: string;
  readonly viewsLabel: string;
  readonly visitorsLabel: string;
}

export type RealtimeTrafficTrendViewProps = RealtimeTrafficTrendViewBaseProps &
  ({ readonly state: "loading" } | { readonly state: "ready" });

interface RealtimeTrafficTooltipProps extends TooltipProps<number, string> {
  readonly locale: string;
  readonly viewsLabel: string;
  readonly visitorsLabel: string;
}

interface RealtimeTrafficChartPoint extends RealtimeTrafficTrendDataPoint {
  readonly nonVisitorViews: number;
}

function isRealtimeTrafficPoint(
  value: unknown,
): value is RealtimeTrafficTrendDataPoint {
  return (
    typeof value === "object" &&
    value !== null &&
    "label" in value &&
    typeof value.label === "string" &&
    "tooltipLabel" in value &&
    typeof value.tooltipLabel === "string" &&
    "views" in value &&
    typeof value.views === "number" &&
    "visitors" in value &&
    typeof value.visitors === "number"
  );
}

function safeCount(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
}

function RealtimeTrafficTooltip({
  active,
  payload,
  locale,
  viewsLabel,
  visitorsLabel,
}: RealtimeTrafficTooltipProps) {
  const point = payload?.[0]?.payload;
  if (!active || !isRealtimeTrafficPoint(point)) return null;

  const visitors = Math.min(safeCount(point.visitors), safeCount(point.views));
  const views = safeCount(point.views);
  const formatter = new Intl.NumberFormat(locale);

  return (
    <div className="grid min-w-32 items-start gap-1.5 rounded-none border border-border/50 bg-background px-2.5 py-1.5 text-xs shadow-xl">
      <div className="font-medium">{point.tooltipLabel}</div>
      <div className="grid gap-1.5">
        <div className="flex w-full items-center gap-2">
          <span
            className="size-2.5 rounded-[2px]"
            style={{ backgroundColor: "var(--chart-1)" }}
            aria-hidden="true"
          />
          <div className="flex flex-1 items-center justify-between gap-3 leading-none">
            <span className="text-muted-foreground">{viewsLabel}</span>
            <span className="font-mono font-medium tabular-nums text-foreground">
              {formatter.format(views)}
            </span>
          </div>
        </div>
        <div className="flex w-full items-center gap-2">
          <span
            className="size-2.5 rounded-[2px]"
            style={{ backgroundColor: "var(--chart-3)" }}
            aria-hidden="true"
          />
          <div className="flex flex-1 items-center justify-between gap-3 leading-none">
            <span className="text-muted-foreground">{visitorsLabel}</span>
            <span className="font-mono font-medium tabular-nums text-foreground">
              {formatter.format(visitors)}
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}

export function RealtimeTrafficTrendView({
  data,
  locale,
  title,
  viewsLabel,
  visitorsLabel,
  state,
}: RealtimeTrafficTrendViewProps) {
  const gradientId = useId().replace(/:/g, "");
  const [hasChartSize, setHasChartSize] = useState(false);
  const handleChartResize = useCallback((width: number, height: number) => {
    if (width <= 0 || height <= 0) return;
    setHasChartSize(true);
  }, []);
  const chartData = useMemo<RealtimeTrafficChartPoint[]>(
    () =>
      data.map((point) => {
        const views = safeCount(point.views);
        const visitors = Math.min(safeCount(point.visitors), views);
        return { ...point, views, visitors, nonVisitorViews: views - visitors };
      }),
    [data],
  );
  const numberFormatter = useMemo(
    () => new Intl.NumberFormat(locale),
    [locale],
  );
  const yAxisWidth = useMemo(
    () =>
      calculateChartYAxisWidth(
        chartData.map((point) => numberFormatter.format(point.views)),
        4,
      ),
    [chartData, numberFormatter],
  );
  const chartConfig = useMemo(
    () =>
      ({
        visitors: { label: visitorsLabel, color: "var(--chart-3)" },
        nonVisitorViews: { label: viewsLabel, color: "var(--chart-1)" },
      }) satisfies ChartConfig,
    [viewsLabel, visitorsLabel],
  );
  const loading = state === "loading";

  return (
    <Card className="overflow-visible" aria-busy={loading}>
      <CardHeader>
        <CardTitle className="inline-flex items-center gap-2">
          <RiPulseLine className="size-4" aria-hidden="true" />
          {title}
        </CardTitle>
      </CardHeader>
      <CardContent>
        <div className="relative">
          <ChartContainer
            config={chartConfig}
            className={cn(
              "h-[280px] w-full aspect-auto transition-opacity duration-200",
              hasChartSize ? "opacity-100" : "opacity-0",
              loading
                ? "[&_.recharts-area-area]:brightness-50"
                : "[&_.recharts-area-area]:brightness-100",
            )}
            onChartResize={handleChartResize}
          >
            <AreaChart data={chartData} margin={{ left: 0, right: 8, top: 8 }}>
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
                    stopColor="var(--chart-3)"
                    stopOpacity={0.8}
                  />
                  <stop
                    offset="95%"
                    stopColor="var(--chart-3)"
                    stopOpacity={0.12}
                  />
                </linearGradient>
                <linearGradient
                  id={`${gradientId}-views`}
                  x1="0"
                  y1="0"
                  x2="0"
                  y2="1"
                >
                  <stop
                    offset="5%"
                    stopColor="var(--chart-1)"
                    stopOpacity={0.72}
                  />
                  <stop
                    offset="95%"
                    stopColor="var(--chart-1)"
                    stopOpacity={0.08}
                  />
                </linearGradient>
              </defs>
              <CartesianGrid vertical={false} />
              <XAxis
                dataKey="label"
                tickLine={false}
                axisLine={false}
                tickMargin={8}
                minTickGap={24}
              />
              <YAxis
                width={yAxisWidth}
                tickFormatter={(value) => numberFormatter.format(Number(value))}
                allowDecimals={false}
                tickLine={false}
                axisLine={false}
                tickMargin={4}
              />
              <ChartTooltip
                cursor={false}
                allowEscapeViewBox={{ x: false, y: true }}
                wrapperStyle={{ zIndex: 20 }}
                content={
                  <RealtimeTrafficTooltip
                    locale={locale}
                    viewsLabel={viewsLabel}
                    visitorsLabel={visitorsLabel}
                  />
                }
              />
              <Area
                dataKey="visitors"
                type="step"
                stackId="traffic"
                stroke="var(--chart-3)"
                fill={`url(#${gradientId}-visitors)`}
                strokeWidth={1.5}
                dot={false}
                activeDot={{
                  r: 2,
                  stroke: "var(--chart-3)",
                  fill: "var(--chart-3)",
                }}
                isAnimationActive={!loading}
                animationDuration={280}
              />
              <Area
                dataKey="nonVisitorViews"
                type="step"
                stackId="traffic"
                stroke="var(--chart-1)"
                fill={`url(#${gradientId}-views)`}
                strokeWidth={1.5}
                dot={false}
                activeDot={{
                  r: 2,
                  stroke: "var(--chart-1)",
                  fill: "var(--chart-1)",
                }}
                isAnimationActive={!loading}
                animationDuration={280}
              />
              <ChartLegend content={<ChartLegendContent />} />
            </AreaChart>
          </ChartContainer>
          <div
            aria-hidden={!loading && hasChartSize}
            className={cn(
              "pointer-events-none absolute inset-x-0 top-0 z-10 flex items-center justify-center text-muted-foreground transition-opacity duration-200",
              loading || !hasChartSize ? "opacity-100" : "opacity-0",
              "bottom-8",
            )}
          >
            <Spinner className="size-5" />
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
