import "@tanstack/react-start/server-only";

import { SitePerformanceBreakdownDimensionSchema } from "@/lib/api-v1/dto/analytics";
import { type FilterDocument } from "@/lib/edge/analytics/contract";
import type { QueryWindow } from "@/lib/edge/analytics/providers/d1/internal/core";
import type {
  PerformanceMetricKey,
  PerformanceSummaryRow,
  PerformanceTrendPointRow,
} from "@/lib/edge/analytics/providers/d1/internal/core-types";
import {
  queryAllPerformanceTrendsFromD1,
  queryPerformanceCountriesFromD1,
  queryPerformanceRoutesFromD1,
  queryPerformanceSummariesFromD1,
} from "@/lib/edge/analytics/providers/d1/internal/performance";
import type { Env } from "@/lib/edge/types";

type PerformanceMetrics = Record<PerformanceMetricKey, PerformanceSummaryRow>;
type PerformanceSeries = Record<
  PerformanceMetricKey,
  readonly {
    readonly timestamp: string;
    readonly avg: number | null;
    readonly p50: number | null;
    readonly p75: number | null;
    readonly p95: number | null;
    readonly samples: number;
  }[]
>;

export interface ReadSitePerformanceInput {
  readonly env: Env;
  readonly siteId: string;
  readonly window: QueryWindow;
  readonly filters: FilterDocument;
}

export interface ReadSitePerformanceTimeseriesInput extends ReadSitePerformanceInput {
  readonly interval: "minute" | "hour" | "day" | "week" | "month";
}
export interface ReadSitePerformanceBreakdownInput extends ReadSitePerformanceInput {
  readonly dimension: string;
  readonly metric: PerformanceMetricKey;
  readonly limit: number;
}

export async function readSitePerformanceSummary(
  input: ReadSitePerformanceInput,
): Promise<{ readonly metrics: PerformanceMetrics }> {
  return {
    metrics: await queryPerformanceSummariesFromD1(
      input.env,
      input.siteId,
      input.window,
      input.filters,
    ),
  };
}

function serializePoint(point: PerformanceTrendPointRow) {
  return {
    timestamp: new Date(point.timestampMs).toISOString(),
    avg: point.avg,
    p50: point.p50,
    p75: point.p75,
    p95: point.p95,
    samples: point.samples,
  };
}

export async function readSitePerformanceTimeseries(
  input: ReadSitePerformanceTimeseriesInput,
): Promise<{ readonly interval: string; readonly series: PerformanceSeries }> {
  const result = await queryAllPerformanceTrendsFromD1(
    input.env,
    input.siteId,
    input.window,
    input.interval,
    input.filters,
  );
  return {
    interval: input.interval,
    series: {
      ttfb: result.ttfb.map(serializePoint),
      fcp: result.fcp.map(serializePoint),
      lcp: result.lcp.map(serializePoint),
      cls: result.cls.map(serializePoint),
      inp: result.inp.map(serializePoint),
    },
  };
}

export async function readSitePerformanceBreakdown(
  input: ReadSitePerformanceBreakdownInput,
): Promise<{
  readonly dimension: string;
  readonly metric: PerformanceMetricKey;
  readonly items: readonly {
    readonly key: string;
    readonly label: string;
    readonly views: number;
    readonly avg: number | null;
    readonly p50: number | null;
    readonly p75: number | null;
    readonly p95: number | null;
    readonly samples: number;
  }[];
}> {
  const dimension = SitePerformanceBreakdownDimensionSchema.safeParse(
    input.dimension,
  );
  if (!dimension.success) throw new Error("unsupported-dimension");
  const result =
    dimension.data === "page.path"
      ? await queryPerformanceRoutesFromD1(
          input.env,
          input.siteId,
          input.window,
          input.filters,
          input.limit,
        )
      : await queryPerformanceCountriesFromD1(
          input.env,
          input.siteId,
          input.window,
          input.filters,
        );
  return {
    dimension: dimension.data,
    metric: input.metric,
    items: result.map((row) => ({
      key: "pathname" in row ? row.pathname : row.country,
      label: "pathname" in row ? row.pathname : row.country,
      views: row.views,
      ...row.metrics[input.metric],
    })),
  };
}
