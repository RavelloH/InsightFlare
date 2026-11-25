import {
  memo,
  type ReactNode,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import { cn } from "../utils/cn";
import { numberFormat } from "./chart-format";
import {
  createChartAxisDateFormatter,
  createChartTooltipDateFormatter,
} from "./chart-time";
import type { ChartLocale, DashboardInterval } from "./types";

export interface SitePulseHeatmapRow {
  id: string;
  label: string;
  icon?: ReactNode;
  /** One value per bucket in `bucketStarts`. */
  values: readonly number[];
  /** Marks the row, e.g. a starred site. */
  highlighted?: boolean;
}

export interface SitePulseHeatmapLabels {
  value: string;
  usual: string;
  above: string;
  below: string;
  /** Template with a `{percent}` placeholder for a bucket against the usual level. */
  versusUsual: string;
}

export interface SitePulseHeatmapProps {
  rows: ReadonlyArray<SitePulseHeatmapRow>;
  bucketStarts: readonly number[];
  locale: ChartLocale;
  timeZone: string;
  interval: DashboardInterval;
  labels: SitePulseHeatmapLabels;
  onRowSelect?: (id: string) => void;
  /** Wider ranges are merged into at most this many columns. */
  maxColumns?: number;
  loading?: boolean;
  emptyLabel?: string;
  className?: string;
}

const LEVELS = 4;
/** Gap between cells, in whole pixels so every gap renders the same. */
const CELL_GAP = 2;

/** Include quiet buckets. For sparse sites, the mean retains a fractional
 * expected count even when the median is zero; busy sites use a robust median. */
export function pulseBaseline(values: readonly number[]): number {
  const sorted = values
    .filter((value) => Number.isFinite(value) && value >= 0)
    .sort((a, b) => a - b);
  if (!sorted.length) return 0;
  const middle = Math.floor(sorted.length / 2);
  const median =
    sorted.length % 2
      ? sorted[middle]!
      : (sorted[middle - 1]! + sorted[middle]!) / 2;
  return median < 3
    ? sorted.reduce((sum, value) => sum + value, 0) / sorted.length
    : median;
}

/** One-sided Poisson tail for small expected counts. */
function poissonTail(value: number, usual: number): number {
  const falling = value < usual;
  const end = falling ? Math.floor(value) : Math.ceil(value) - 1;
  if (!falling && end > 200) return 0;
  let term = Math.exp(-usual);
  let cumulative = end >= 0 ? term : 0;
  for (let k = 1; k <= end; k++) {
    term *= usual / k;
    cumulative += term;
  }
  return Math.max(0, Math.min(1, falling ? cumulative : 1 - cumulative));
}

/**
 * Relative deviation, capped by statistical evidence. A zero-count bucket
 * with a tiny expected count is ordinary, not a 100% traffic collapse.
 * Poisson tails are exact for sparse counts; a signed deviance approximation
 * keeps the cost bounded for high-volume sites. This is a visual heuristic.
 */
export function pulseLevel(value: number, usual: number): number {
  if (
    !Number.isFinite(value) ||
    !Number.isFinite(usual) ||
    value < 0 ||
    usual <= 0
  )
    return 0;
  const ratio = value === 0 ? -Infinity : Math.log2(value / usual);
  if (Math.abs(ratio) < 0.2) return 0;
  const relative = Math.min(LEVELS, Math.ceil(Math.abs(ratio) * 2.5));
  let evidence: number;
  if (usual <= 30) {
    const tail = poissonTail(value, usual);
    evidence =
      tail < 0.001 ? 4 : tail < 0.01 ? 3 : tail < 0.05 ? 2 : tail < 0.1 ? 1 : 0;
  } else {
    const deviance = Math.sqrt(
      Math.max(
        0,
        2 *
          (value === 0
            ? usual
            : value * Math.log(value / usual) - value + usual),
      ),
    );
    evidence =
      deviance > 3.09
        ? 4
        : deviance > 2.326
          ? 3
          : deviance > 1.645
            ? 2
            : deviance > 1.282
              ? 1
              : 0;
  }
  return Math.sign(ratio) * Math.min(relative, evidence) || 0;
}

/** Mixed in sRGB so the hue never drifts toward the neutral base. */
function cellColor(level: number) {
  if (level === 0) return "var(--color-muted)";
  const strength = 22 + ((Math.abs(level) - 1) / (LEVELS - 1)) * 70;
  const color =
    level > 0 ? "var(--color-chart-4)" : "var(--color-chart-secondary-3)";
  return `color-mix(in srgb, ${color} ${Math.round(strength)}%, var(--color-muted))`;
}

function mergeColumns(
  bucketStarts: readonly number[],
  rows: ReadonlyArray<SitePulseHeatmapRow>,
  maxColumns: number,
) {
  const size = Math.max(1, Math.ceil(bucketStarts.length / maxColumns));
  if (size === 1) return { starts: bucketStarts, rows, size };
  const starts = bucketStarts.filter((_, index) => index % size === 0);
  return {
    starts,
    size,
    rows: rows.map((row) => ({
      ...row,
      values: starts.map((_, column) =>
        row.values
          .slice(column * size, column * size + size)
          .reduce((sum, value) => sum + value, 0),
      ),
    })),
  };
}

export const SitePulseHeatmap = memo(function SitePulseHeatmap({
  rows,
  bucketStarts,
  locale,
  timeZone,
  interval,
  labels,
  onRowSelect,
  maxColumns = 60,
  loading = false,
  emptyLabel,
  className,
}: SitePulseHeatmapProps) {
  const container = useRef<HTMLDivElement>(null);
  const track = useRef<HTMLDivElement>(null);
  const [trackWidth, setTrackWidth] = useState(0);
  useEffect(() => {
    const element = track.current;
    if (!element || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(([entry]) =>
      setTrackWidth(Math.floor(entry?.contentRect.width ?? 0)),
    );
    observer.observe(element);
    return () => observer.disconnect();
  });
  const [hover, setHover] = useState<{
    row: number;
    column: number;
    x: number;
    y: number;
    flip: boolean;
  } | null>(null);
  const merged = useMemo(
    () => mergeColumns(bucketStarts, rows, maxColumns),
    [bucketStarts, rows, maxColumns],
  );
  const usual = useMemo(
    () => rows.map((row) => pulseBaseline(row.values)),
    [rows],
  );
  const usualAt = (row: number, column: number) =>
    (usual[row] ?? 0) *
    Math.max(
      0,
      Math.min(merged.size, bucketStarts.length - column * merged.size),
    );
  const axisFormatter = useMemo(
    () => createChartAxisDateFormatter(locale, interval, timeZone, "compact"),
    [locale, interval, timeZone],
  );
  const tooltipFormatter = useMemo(
    () => createChartTooltipDateFormatter(locale, interval, timeZone),
    [locale, interval, timeZone],
  );
  const columns = merged.starts.length;
  // Whole-pixel cells; until measured, fall back to fractional columns.
  const cellWidth =
    trackWidth > 0 && columns
      ? Math.max(
          2,
          Math.floor((trackWidth - CELL_GAP * (columns - 1)) / columns),
        )
      : 0;
  const cellLeft = (column: number) => column * (cellWidth + CELL_GAP);
  const ticks = columns
    ? [...new Set([0, Math.floor((columns - 1) / 2), columns - 1])]
    : [];

  if (!rows.length || !columns) {
    return (
      <div
        className={cn(
          "flex h-40 items-center justify-center text-xs text-muted-foreground",
          className,
        )}
      >
        {loading ? null : emptyLabel}
      </div>
    );
  }

  const hovered = hover ? merged.rows[hover.row] : undefined;
  const hoveredValue =
    hover && hovered ? (hovered.values[hover.column] ?? 0) : 0;
  const hoveredUsual = hover ? usualAt(hover.row, hover.column) : 0;
  const hoveredPercent =
    hoveredUsual > 0
      ? Math.round(((hoveredValue - hoveredUsual) / hoveredUsual) * 100)
      : null;

  return (
    <div
      data-slot="chart"
      className={cn(
        "relative w-full transition-opacity",
        loading && "opacity-60",
        className,
      )}
      ref={container}
      onMouseLeave={() => setHover(null)}
    >
      <div
        role="grid"
        aria-rowcount={merged.rows.length}
        aria-colcount={columns}
        className="grid items-center gap-x-3 gap-y-1"
        style={{ gridTemplateColumns: "minmax(7rem, 11rem) minmax(0, 1fr)" }}
      >
        {merged.rows.map((row, rowIndex) => (
          <div key={row.id} role="row" className="contents">
            <button
              type="button"
              role="rowheader"
              className={cn(
                "flex min-w-0 items-center gap-1.5 text-left text-xs text-muted-foreground hover:text-foreground",
                row.highlighted && "text-foreground",
                !onRowSelect && "cursor-default",
              )}
              onClick={() => onRowSelect?.(row.id)}
            >
              {row.icon}
              <span className="truncate">{row.label}</span>
            </button>
            <div
              className={cellWidth ? "flex h-6" : "grid h-6 gap-px"}
              style={
                cellWidth
                  ? { columnGap: CELL_GAP }
                  : {
                      gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))`,
                    }
              }
            >
              {row.values.map((value, column) => {
                const level = pulseLevel(value, usualAt(rowIndex, column));
                const active =
                  hover?.row === rowIndex && hover.column === column;
                return (
                  <div
                    key={merged.starts[column]}
                    role="gridcell"
                    aria-label={`${row.label} ${tooltipFormatter.format(
                      new Date(merged.starts[column]!),
                    )}: ${numberFormat(locale, value)}`}
                    className={cn(
                      "h-full shrink-0 cursor-pointer",
                      active && "outline outline-1 outline-foreground",
                    )}
                    style={{
                      background: cellColor(level),
                      ...(cellWidth ? { width: cellWidth } : {}),
                    }}
                    onMouseEnter={(event) => {
                      const box = container.current?.getBoundingClientRect();
                      const cell = event.currentTarget.getBoundingClientRect();
                      if (!box) return;
                      const x = cell.left - box.left + cell.width / 2;
                      setHover({
                        row: rowIndex,
                        column,
                        x,
                        y: cell.top - box.top,
                        flip: x > box.width * 0.6,
                      });
                    }}
                    onClick={() => onRowSelect?.(row.id)}
                  />
                );
              })}
            </div>
          </div>
        ))}
        <div />
        <div
          ref={track}
          className="relative h-4 text-[11px] text-muted-foreground"
        >
          {ticks.map((column) => {
            const last = column === columns - 1 && column !== 0;
            const position = cellWidth
              ? cellLeft(column) +
                (last ? cellWidth : column ? cellWidth / 2 : 0)
              : null;
            return (
              <span
                key={column}
                className={cn(
                  "absolute top-0.5 whitespace-nowrap",
                  last
                    ? "-translate-x-full"
                    : column !== 0 && "-translate-x-1/2",
                )}
                style={{
                  left:
                    position !== null
                      ? position
                      : last
                        ? "100%"
                        : `${((column + (column ? 0.5 : 0)) / columns) * 100}%`,
                }}
              >
                {axisFormatter.format(new Date(merged.starts[column]!))}
              </span>
            );
          })}
        </div>
      </div>

      <div className="mt-3 flex items-center justify-end gap-1.5 text-[11px] text-muted-foreground">
        <span>{labels.below}</span>
        {[-4, -2, 0, 2, 4].map((level) => (
          <span
            key={level}
            aria-hidden="true"
            className="size-3"
            style={{ background: cellColor(level) }}
          />
        ))}
        <span>{labels.above}</span>
      </div>

      {hover && hovered ? (
        <div
          data-chart-tooltip-active=""
          className="pointer-events-none absolute z-10 grid min-w-40 gap-1 border border-border/50 bg-background px-2.5 py-1.5 text-xs shadow-xl"
          style={{
            top: hover.y - 6,
            left: hover.x,
            transform: `translate(${hover.flip ? "calc(-100% - 8px)" : "8px"}, -100%)`,
          }}
        >
          <div className="font-medium">{hovered.label}</div>
          <div className="text-muted-foreground">
            {tooltipFormatter.format(new Date(merged.starts[hover.column]!))}
          </div>
          <div className="flex items-center justify-between gap-4">
            <span className="text-muted-foreground">{labels.value}</span>
            <span className="font-mono tabular-nums">
              {numberFormat(locale, hoveredValue)}
            </span>
          </div>
          <div className="flex items-center justify-between gap-4">
            <span className="text-muted-foreground">{labels.usual}</span>
            <span className="font-mono tabular-nums">
              {numberFormat(locale, Math.round(hoveredUsual * 100) / 100)}
            </span>
          </div>
          {hoveredPercent !== null ? (
            <div
              className="font-mono tabular-nums text-muted-foreground"
              style={{
                color:
                  pulseLevel(hoveredValue, hoveredUsual) > 0
                    ? "var(--color-chart-4)"
                    : pulseLevel(hoveredValue, hoveredUsual) < 0
                      ? "var(--color-chart-secondary-3)"
                      : undefined,
              }}
            >
              {labels.versusUsual.replace(
                "{percent}",
                `${hoveredPercent > 0 ? "+" : ""}${hoveredPercent}%`,
              )}
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
});
