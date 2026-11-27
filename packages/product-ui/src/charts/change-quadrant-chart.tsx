import { memo, useMemo } from "react";
import { AutoTransition } from "@insightflare/ui/auto-transition";
import {
  type ChartConfig,
  ChartContainer,
  ChartTooltip,
} from "@insightflare/ui/chart";
import { Spinner } from "@insightflare/ui/spinner";
import {
  CartesianGrid,
  ReferenceArea,
  ReferenceLine,
  Scatter,
  ScatterChart,
  XAxis,
  YAxis,
  ZAxis,
} from "recharts";

import { cn } from "../utils/cn";
import { numberFormat } from "./chart-format";
import type { ChartLocale } from "./types";

export interface ChangeQuadrantPoint {
  id: string;
  label: string;
  /** Size of the item in the current period, e.g. visitors. */
  value: number;
  /** Percent change against the previous period. */
  change: number;
  /** Drives the dot size, e.g. views. */
  weight?: number;
}

export interface ChangeQuadrantLabels {
  value: string;
  change: string;
  weight?: string;
}

export interface ChangeQuadrantChartProps {
  points: ReadonlyArray<ChangeQuadrantPoint>;
  labels: ChangeQuadrantLabels;
  locale: ChartLocale;
  /** Changes beyond ± this percent are called out. */
  threshold?: number;
  onPointSelect?: (id: string) => void;
  emptyLabel?: string;
  loading?: boolean;
  loadingLabel?: string;
  className?: string;
}

type Tone = "rise" | "fall" | "steady";
type PlotPoint = ChangeQuadrantPoint & {
  x: number;
  y: number;
  z: number;
  tone: Tone;
};

const TONE_COLORS: Record<Tone, string> = {
  rise: "var(--color-chart-4)",
  fall: "var(--color-chart-secondary-3)",
  steady: "var(--color-muted-foreground)",
};
const Y_LIMIT = 200;

function formatChange(value: number) {
  return `${value > 0 ? "+" : ""}${value.toFixed(1)}%`;
}

/** 1, 2 and 5 steps per decade, thinned to at most five ticks. */
function logTicks(min: number, max: number) {
  const ticks: number[] = [];
  for (
    let decade = 10 ** Math.floor(Math.log10(min));
    decade <= max;
    decade *= 10
  )
    for (const step of [1, 2, 5])
      if (decade * step >= min && decade * step <= max)
        ticks.push(decade * step);
  const stride = Math.ceil(ticks.length / 5);
  return ticks.filter((_, index) => index % stride === 0);
}

function QuadrantDot(props: {
  cx?: number;
  cy?: number;
  size?: number;
  payload?: PlotPoint;
  onSelect?: (id: string) => void;
}) {
  const { cx = 0, cy = 0, size = 64, payload, onSelect } = props;
  if (!payload) return null;
  const radius = Math.max(3, Math.sqrt(size / Math.PI));
  const color = TONE_COLORS[payload.tone];
  return (
    <g
      className={onSelect ? "cursor-pointer" : undefined}
      onClick={() => onSelect?.(payload.id)}
    >
      <circle
        cx={cx}
        cy={cy}
        r={radius}
        fill={color}
        fillOpacity={payload.tone === "steady" ? 0.35 : 0.75}
        stroke={color}
        strokeWidth={1}
      />
    </g>
  );
}

export const ChangeQuadrantChart = memo(function ChangeQuadrantChart({
  points,
  labels,
  locale,
  threshold = 30,
  onPointSelect,
  emptyLabel,
  loading = false,
  loadingLabel,
  className,
}: ChangeQuadrantChartProps) {
  const plot = useMemo<PlotPoint[]>(() => {
    const visible = points.filter(
      (point) =>
        Number.isFinite(point.value) &&
        point.value >= 0 &&
        Number.isFinite(point.change),
    );
    return visible.map((point) => {
      const tone: Tone =
        point.change >= threshold
          ? "rise"
          : point.change <= -threshold
            ? "fall"
            : "steady";
      return {
        ...point,
        // log(1 + count) allows a site that lost all its traffic to remain visible.
        x: point.value + 1,
        y: Math.max(-100, Math.min(Y_LIMIT, point.change)),
        z: Math.max(0, point.weight ?? point.value),
        tone,
      };
    });
  }, [points, threshold]);
  const upperTick = Math.min(
    Y_LIMIT,
    Math.ceil(
      Math.max(threshold * 1.5, ...plot.map((point) => point.y * 1.1)) / 10,
    ) * 10,
  );
  const upperExtent = upperTick + 10;
  const lowerExtent = -110;
  const yTicks = [...new Set([-100, -threshold, 0, threshold, upperTick])].sort(
    (a, b) => a - b,
  );
  const xMin = plot.length
    ? Math.max(0.8, Math.min(...plot.map((point) => point.x)) / 1.5)
    : 0.8;
  const xMax = Math.max(10, ...plot.map((point) => point.x)) * 1.5;
  const xTicks = [
    ...(xMin <= 1 ? [1] : []),
    ...logTicks(Math.max(1, xMin - 1), xMax - 1).map((value) => value + 1),
  ].filter((value) => value >= xMin && value <= xMax);
  const clippedUpper = plot.some((point) => point.change > Y_LIMIT);
  const compactFormatter = useMemo(
    () => new Intl.NumberFormat(locale, { notation: "compact" }),
    [locale],
  );
  const config = useMemo<ChartConfig>(
    () => ({ value: { label: labels.value, color: TONE_COLORS.steady } }),
    [labels.value],
  );

  return (
    <div className={cn("relative h-64 w-full", className)}>
      <ChartContainer
        config={config}
        className={cn(
          "aspect-auto h-full w-full transition-opacity",
          !plot.length && "opacity-0",
        )}
      >
        <ScatterChart margin={{ top: 8, right: 24, bottom: 4, left: 0 }}>
          <CartesianGrid strokeDasharray="3 3" />
          <ReferenceArea
            y1={lowerExtent}
            y2={-threshold}
            fill="var(--color-chart-secondary-3)"
            fillOpacity={0.06}
            ifOverflow="hidden"
          />
          <ReferenceArea
            y1={threshold}
            y2={upperExtent}
            fill="var(--color-chart-4)"
            fillOpacity={0.06}
            ifOverflow="hidden"
          />
          <ReferenceLine y={0} stroke="var(--color-border)" />
          <XAxis
            type="number"
            dataKey="x"
            scale="log"
            domain={[xMin, xMax]}
            ticks={xTicks}
            allowDataOverflow
            tickLine={false}
            axisLine={false}
            tickFormatter={(value) =>
              compactFormatter.format(Math.max(0, Number(value) - 1))
            }
            name={labels.value}
          />
          <YAxis
            type="number"
            dataKey="y"
            domain={[lowerExtent, upperExtent]}
            ticks={yTicks}
            tickLine={false}
            axisLine={false}
            width={48}
            tickFormatter={(value) => {
              const number = Math.round(Number(value));
              return `${number === Y_LIMIT && clippedUpper ? "≥" : ""}${number > 0 ? "+" : ""}${number}%`;
            }}
            name={labels.change}
          />
          <ZAxis type="number" dataKey="z" range={[40, 300]} />
          <ChartTooltip
            cursor={false}
            content={({ active, payload }) => {
              const point = payload?.[0]?.payload as PlotPoint | undefined;
              if (!active || !point) return null;
              return (
                <div className="grid min-w-36 gap-1 border border-border/50 bg-background px-2.5 py-1.5 text-xs shadow-xl">
                  <div className="font-medium">{point.label}</div>
                  <div className="flex justify-between gap-4">
                    <span className="text-muted-foreground">
                      {labels.value}
                    </span>
                    <span className="font-mono tabular-nums">
                      {numberFormat(locale, point.value)}
                    </span>
                  </div>
                  <div className="flex justify-between gap-4">
                    <span className="text-muted-foreground">
                      {labels.change}
                    </span>
                    <span
                      className="font-mono tabular-nums"
                      style={{
                        color:
                          point.tone === "steady"
                            ? undefined
                            : TONE_COLORS[point.tone],
                      }}
                    >
                      {formatChange(point.change)}
                    </span>
                  </div>
                  {labels.weight && point.weight !== undefined ? (
                    <div className="flex justify-between gap-4">
                      <span className="text-muted-foreground">
                        {labels.weight}
                      </span>
                      <span className="font-mono tabular-nums">
                        {numberFormat(locale, point.weight)}
                      </span>
                    </div>
                  ) : null}
                </div>
              );
            }}
          />
          <Scatter
            data={plot}
            isAnimationActive={false}
            shape={(props: unknown) => (
              <QuadrantDot
                {...(props as Parameters<typeof QuadrantDot>[0])}
                onSelect={onPointSelect}
              />
            )}
          />
        </ScatterChart>
      </ChartContainer>
      <AutoTransition
        initial={false}
        duration={0.2}
        transitionKey={
          loading && !plot.length ? "loading" : !plot.length ? "empty" : "ready"
        }
        className="pointer-events-none absolute inset-0 flex items-center justify-center text-xs text-muted-foreground"
      >
        {loading && !plot.length ? (
          <Spinner className="size-5" aria-label={loadingLabel} />
        ) : !plot.length ? (
          emptyLabel
        ) : null}
      </AutoTransition>
    </div>
  );
});
