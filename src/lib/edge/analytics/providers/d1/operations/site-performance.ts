import "@tanstack/react-start/server-only";

import type { Interval } from "@/lib/edge/analytics/contract";
import { type FilterDocument } from "@/lib/edge/analytics/contract";
import {
  type SitePerformanceBreakdownDimension,
  SitePerformanceBreakdownDimensionSchema,
} from "@/lib/edge/analytics/contract/performance-dimensions";
import type { QueryWindow } from "@/lib/edge/analytics/providers/d1/internal/core";
import type {
  PerformanceCountryRow,
  PerformanceMetricKey,
  PerformanceRouteRow,
  PerformanceSummaryRow,
  PerformanceTrendPointRow,
} from "@/lib/edge/analytics/providers/d1/internal/core-types";
import type { D1ExecutionOptions } from "@/lib/edge/analytics/providers/d1/internal/execution-options";
import type { PerformancePageVisitQualification } from "@/lib/edge/analytics/providers/d1/internal/performance";
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
  readonly qualification?: PerformancePageVisitQualification;
  readonly wholeOriginalOwner?: object;
  readonly execution?: D1ExecutionOptions;
}
export interface ReadSitePerformanceTimeseriesInput extends ReadSitePerformanceInput {
  readonly interval: "minute" | "hour" | "day" | "week" | "month";
}
export interface ReadSitePerformanceBreakdownInput extends ReadSitePerformanceInput {
  readonly dimension: string;
  readonly metric: PerformanceMetricKey;
  readonly limit: number;
}

export function serializePerformanceBreakdown(
  dimension: SitePerformanceBreakdownDimension,
  metric: PerformanceMetricKey,
  rows: readonly (PerformanceRouteRow | PerformanceCountryRow)[],
): {
  readonly dimension: SitePerformanceBreakdownDimension;
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
} {
  return {
    dimension,
    metric,
    items: rows.map((row) => {
      const key = "pathname" in row ? row.pathname : row.country;
      return {
        key,
        label: key,
        views: row.views,
        ...row.metrics[metric],
      };
    }),
  };
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
      ...((input.wholeOriginalOwner && input.execution
        ? [input.qualification, input.wholeOriginalOwner, input.execution]
        : input.wholeOriginalOwner
          ? [input.qualification, input.wholeOriginalOwner]
          : input.qualification
            ? [input.qualification]
            : []) as [
        qualification?: PerformancePageVisitQualification,
        owner?: object,
        execution?: D1ExecutionOptions,
      ]),
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
export function serializePerformanceTimeseries(
  interval: Interval,
  trends: Record<PerformanceMetricKey, PerformanceTrendPointRow[]>,
): {
  readonly interval: Interval;
  readonly series: PerformanceSeries;
} {
  return {
    interval,
    series: {
      ttfb: trends.ttfb.map(serializePoint),
      fcp: trends.fcp.map(serializePoint),
      lcp: trends.lcp.map(serializePoint),
      cls: trends.cls.map(serializePoint),
      inp: trends.inp.map(serializePoint),
    },
  };
}
export async function readSitePerformanceTimeseries(
  input: ReadSitePerformanceTimeseriesInput,
): Promise<{
  readonly interval: Interval;
  readonly series: PerformanceSeries;
}> {
  const result = await queryAllPerformanceTrendsFromD1(
    input.env,
    input.siteId,
    input.window,
    input.interval,
    input.filters,
    ...((input.wholeOriginalOwner && input.execution
      ? [input.qualification, input.wholeOriginalOwner, input.execution]
      : input.wholeOriginalOwner
        ? [input.qualification, input.wholeOriginalOwner]
        : input.qualification
          ? [input.qualification]
          : []) as [
      qualification?: PerformancePageVisitQualification,
      owner?: object,
      execution?: D1ExecutionOptions,
    ]),
  );
  return serializePerformanceTimeseries(input.interval, result);
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
          ...((input.wholeOriginalOwner && input.execution
            ? [input.qualification, input.wholeOriginalOwner, input.execution]
            : input.wholeOriginalOwner
              ? [input.qualification, input.wholeOriginalOwner]
              : input.qualification
                ? [input.qualification]
                : []) as [
            qualification?: PerformancePageVisitQualification,
            owner?: object,
            execution?: D1ExecutionOptions,
          ]),
        )
      : await queryPerformanceCountriesFromD1(
          input.env,
          input.siteId,
          input.window,
          input.filters,
          ...((input.wholeOriginalOwner && input.execution
            ? [input.qualification, input.wholeOriginalOwner, input.execution]
            : input.wholeOriginalOwner
              ? [input.qualification, input.wholeOriginalOwner]
              : input.qualification
                ? [input.qualification]
                : []) as [
            qualification?: PerformancePageVisitQualification,
            owner?: object,
            execution?: D1ExecutionOptions,
          ]),
        );
  return serializePerformanceBreakdown(dimension.data, input.metric, result);
}
