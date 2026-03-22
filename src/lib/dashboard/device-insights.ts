import type {
  BrowserCrossBreakdownDimensionData,
  BrowserTrendSeries,
} from "@/lib/edge-client";

export type ScreenBucketKey =
  | "phoneCompact"
  | "phone"
  | "tablet"
  | "laptop"
  | "desktopWide"
  | "unclassified";

export interface ScreenBucketSummary {
  key: ScreenBucketKey;
  visitors: number;
  share: number;
}

export interface ParsedScreenSize {
  width: number;
  height: number;
  viewportWidth: number;
}

export function parseScreenSizeLabel(label: string): ParsedScreenSize | null {
  const match = String(label ?? "").trim().match(/^(\d{2,5})x(\d{2,5})$/i);
  if (!match) return null;
  const width = Number(match[1]);
  const height = Number(match[2]);
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    return null;
  }
  return {
    width,
    height,
    viewportWidth: Math.min(width, height),
  };
}

export function classifyScreenBucket(label: string): ScreenBucketKey {
  const parsed = parseScreenSizeLabel(label);
  if (!parsed) return "unclassified";
  if (parsed.viewportWidth < 400) return "phoneCompact";
  if (parsed.viewportWidth < 768) return "phone";
  if (parsed.viewportWidth < 1024) return "tablet";
  if (parsed.viewportWidth < 1440) return "laptop";
  return "desktopWide";
}

export function aggregateScreenBuckets(
  series: BrowserTrendSeries[],
): {
  buckets: ScreenBucketSummary[];
  totalVisitors: number;
  classifiedVisitors: number;
} {
  const totals = new Map<ScreenBucketKey, number>([
    ["phoneCompact", 0],
    ["phone", 0],
    ["tablet", 0],
    ["laptop", 0],
    ["desktopWide", 0],
    ["unclassified", 0],
  ]);
  const totalVisitors = series.reduce((sum, item) => sum + item.visitors, 0);

  for (const item of series) {
    const bucket = item.isOther ? "unclassified" : classifyScreenBucket(item.label);
    totals.set(bucket, (totals.get(bucket) ?? 0) + item.visitors);
  }

  const buckets = Array.from(totals.entries())
    .map(([key, visitors]) => ({
      key,
      visitors,
      share: totalVisitors > 0 ? visitors / totalVisitors : 0,
    }))
    .filter((bucket) => bucket.visitors > 0);

  const classifiedVisitors = buckets
    .filter((bucket) => bucket.key !== "unclassified")
    .reduce((sum, bucket) => sum + bucket.visitors, 0);

  return {
    buckets,
    totalVisitors,
    classifiedVisitors,
  };
}

export function pickTopVisibleSeries(
  series: BrowserTrendSeries[],
): BrowserTrendSeries | null {
  const preferred = series.filter((item) => !item.isOther);
  const source = preferred.length > 0 ? preferred : series;
  return source.reduce<BrowserTrendSeries | null>((top, item) => {
    if (!top) return item;
    return item.visitors > top.visitors ? item : top;
  }, null);
}

export function pickTopCrossCell(
  data: BrowserCrossBreakdownDimensionData,
): {
  primaryLabel: string;
  secondaryLabel: string;
  visitors: number;
  share: number;
} | null {
  let top:
    | {
        primaryLabel: string;
        secondaryLabel: string;
        visitors: number;
      }
    | null = null;

  for (const row of data.rows) {
    for (const cell of row.cells) {
      if (cell.visitors <= 0 || cell.isOther || cell.isUnknown) continue;
      if (!top || cell.visitors > top.visitors) {
        top = {
          primaryLabel: row.label,
          secondaryLabel: cell.label,
          visitors: cell.visitors,
        };
      }
    }
  }

  if (!top) return null;
  return {
    ...top,
    share: data.totalVisitors > 0 ? top.visitors / data.totalVisitors : 0,
  };
}
