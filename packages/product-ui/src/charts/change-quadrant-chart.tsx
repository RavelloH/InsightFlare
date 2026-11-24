import { memo, useMemo } from "react";
import {
  type ChartConfig,
  ChartContainer,
  ChartTooltip,
} from "@insightflare/ui/chart";
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
  className?: string;
}

type Tone = "rise" | "fall" | "steady";
type PlotPoint = ChangeQuadrantPoint & {
  x: number;
  y: number;
  z: number;
  tone: Tone;
  callout: boolean;
  /** Put the label on the left of dots in the right half of the chart. */
  labelLeft: boolean;
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
      {payload.callout ? (
        <text
          x={payload.labelLeft ? cx - radius - 4 : cx + radius + 4}
          y={cy + 3}
          textAnchor={payload.labelLeft ? "end" : "start"}
          className="fill-foreground text-[10px]"
        >
          {payload.label.length > 18
            ? payload.label.slice(0, 17) + "…"
            : payload.label}
        </text>
      ) : null}
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
  className,
}: ChangeQuadrantChartProps) {
  const plot = useMemo<PlotPoint[]>(() => {
    const visible = points.filter(
      (point) => point.value > 0 && Number.isFinite(point.change),
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
        x: point.value,
        y: Math.max(-Y_LIMIT, Math.min(Y_LIMIT, point.change)),
        z: point.weight ?? point.value,
        tone,
        callout: tone !== "steady",
        labelLeft: false,
      };
    });
  }, [points, threshold]);
  const rawExtent = Math.max(
    threshold * 1.5,
    ...plot.map((point) => Math.abs(point.y) * 1.15),
  );
  const yExtent = Math.ceil(rawExtent / 10) * 10;
  const yTicks = [-yExtent, -threshold, 0, threshold, yExtent];
  const xMin = Math.max(1, Math.min(...plot.map((point) => point.x)) / 1.8);
  const xMax = Math.max(10, ...plot.map((point) => point.x)) * 1.8;
  const xTicks = logTicks(xMin, xMax);
  const xMiddle = Math.sqrt(xMin * xMax);
  for (const point of plot) point.labelLeft = point.x > xMiddle;
  const config = {
    value: { label: labels.value, color: TONE_COLORS.steady },
  } satisfies ChartConfig;

  if (!plot.length) {
    return (
      <div
        className={cn(
          "flex h-60 items-center justify-center text-xs text-muted-foreground",
          className,
        )}
      >
        {emptyLabel}
      </div>
    );
  }

  return (
    <ChartContainer
      config={config}
      className={cn("aspect-auto h-64 w-full", className)}
    >
      <ScatterChart margin={{ top: 8, right: 24, bottom: 4, left: 0 }}>
        <CartesianGrid strokeDasharray="3 3" />
        <ReferenceArea
          y1={-yExtent}
          y2={-threshold}
          fill="var(--color-chart-secondary-3)"
          fillOpacity={0.06}
          ifOverflow="hidden"
        />
        <ReferenceArea
          y1={threshold}
          y2={yExtent}
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
            new Intl.NumberFormat(locale, { notation: "compact" }).format(
              Number(value),
            )
          }
          name={labels.value}
        />
        <YAxis
          type="number"
          dataKey="y"
          domain={[-yExtent, yExtent]}
          ticks={yTicks}
          tickLine={false}
          axisLine={false}
          width={48}
          tickFormatter={(value) => {
            const number = Math.round(Number(value));
            return `${number > 0 ? "+" : ""}${number}%`;
          }}
          name={labels.change}
        />
        <ZAxis type="number" dataKey="z" range={[40, 420]} />
        <ChartTooltip
          cursor={false}
          content={({ active, payload }) => {
            const point = payload?.[0]?.payload as PlotPoint | undefined;
            if (!active || !point) return null;
            return (
              <div className="grid min-w-36 gap-1 border border-border/50 bg-background px-2.5 py-1.5 text-xs shadow-xl">
                <div className="font-medium">{point.label}</div>
                <div className="flex justify-between gap-4">
                  <span className="text-muted-foreground">{labels.value}</span>
                  <span className="font-mono tabular-nums">
                    {numberFormat(locale, point.value)}
                  </span>
                </div>
                <div className="flex justify-between gap-4">
                  <span className="text-muted-foreground">{labels.change}</span>
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
  );
});
