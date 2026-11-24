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

function median(values: readonly number[]) {
  const sorted = values.filter((value) => value > 0).sort((a, b) => a - b);
  if (!sorted.length) return 0;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2
    ? sorted[middle]!
    : (sorted[middle - 1]! + sorted[middle]!) / 2;
}

/**
 * Signed level of a bucket against the site's own median: 0 is usual, ±LEVELS
 * is four times (or a quarter of) the usual level or beyond.
 */
export function pulseLevel(value: number, usual: number): number {
  if (usual <= 0) return 0;
  if (value <= 0) return -LEVELS;
  const ratio = Math.log2(value / usual);
  // Within about ±15% of usual counts as usual.
  if (Math.abs(ratio) < 0.2) return 0;
  const level = Math.sign(ratio) * Math.ceil(Math.abs(ratio) * 2.5);
  return Math.max(-LEVELS, Math.min(LEVELS, level));
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
    () => merged.rows.map((row) => median(row.values)),
    [merged.rows],
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
  const hoveredUsual = hover ? (usual[hover.row] ?? 0) : 0;
  const hoveredPercent =
    hoveredUsual > 0
      ? Math.round(((hoveredValue - hoveredUsual) / hoveredUsual) * 100)
      : null;

  return (
    <div
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
                const level = pulseLevel(value, usual[rowIndex] ?? 0);
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
              {numberFormat(locale, Math.round(hoveredUsual))}
            </span>
          </div>
          {hoveredPercent !== null ? (
            <div
              className={cn(
                "font-mono tabular-nums",
                hoveredPercent > 0
                  ? "text-emerald-600"
                  : hoveredPercent < 0
                    ? "text-amber-600"
                    : "text-muted-foreground",
              )}
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
