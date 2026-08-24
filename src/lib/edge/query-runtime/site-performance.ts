import "@tanstack/react-start/server-only";

import { SitePerformanceBreakdownDimensionSchema } from "@/lib/api-v1/dto/analytics";
import type { QueryWindow } from "@/lib/edge/query/core";
import type {
  PerformanceMetricKey,
  PerformanceSummaryRow,
  PerformanceTrendPointRow,
} from "@/lib/edge/query/core-types";
import {
  queryAllPerformanceTrendsFromD1,
  queryPerformanceCountriesFromD1,
  queryPerformanceRoutesFromD1,
  queryPerformanceSummariesFromD1,
} from "@/lib/edge/query/performance";
import {
  analyticsFilterRegistry,
  assertFilterAudience,
  executeTypedApplicationOperation,
  type FilterDocument,
  siteQueryContext,
  validateTypedQueryFilters,
} from "@/lib/edge/query-contract";
import { createQueryTime } from "@/lib/edge/query-contract/helpers";
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

function inputBase(input: ReadSitePerformanceInput) {
  const context = siteQueryContext(input.siteId, "api-v1");
  const filterError = validateTypedQueryFilters(context, input.filters);
  if (filterError) throw new Error(filterError.kind);
  try {
    assertFilterAudience(
      input.filters,
      analyticsFilterRegistry,
      context.policy.audience,
    );
  } catch {
    throw new Error("invalid-input");
  }
  return {
    context,
    time: createQueryTime(
      input.window.startMs,
      input.window.endExclusiveMs,
      input.window.timeZone,
      input.window.nowMs,
    ),
    filters: input.filters,
  };
}

export async function readSitePerformanceSummary(
  input: ReadSitePerformanceInput,
): Promise<{ readonly metrics: PerformanceMetrics }> {
  const result = await executeTypedApplicationOperation(
    "performance",
    inputBase(input),
    async () => ({
      value: await queryPerformanceSummariesFromD1(
        input.env,
        input.siteId,
        input.window,
        input.filters,
      ),
    }),
  );
  if (!result.ok) throw new Error(result.error.kind);
  return { metrics: result.data };
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
  const result = await executeTypedApplicationOperation(
    "performance",
    inputBase(input),
    async () => ({
      value: await queryAllPerformanceTrendsFromD1(
        input.env,
        input.siteId,
        input.window,
        input.interval,
        input.filters,
      ),
    }),
  );
  if (!result.ok) throw new Error(result.error.kind);
  return {
    interval: input.interval,
    series: {
      ttfb: result.data.ttfb.map(serializePoint),
      fcp: result.data.fcp.map(serializePoint),
      lcp: result.data.lcp.map(serializePoint),
      cls: result.data.cls.map(serializePoint),
      inp: result.data.inp.map(serializePoint),
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
  const result = await executeTypedApplicationOperation(
    "performance",
    inputBase(input),
    async () => ({
      value:
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
            ),
    }),
  );
  if (!result.ok) throw new Error(result.error.kind);
  return {
    dimension: dimension.data,
    metric: input.metric,
    items: result.data.map((row) => ({
      key: "pathname" in row ? row.pathname : row.country,
      label: "pathname" in row ? row.pathname : row.country,
      views: row.views,
      ...row.metrics[input.metric],
    })),
  };
}
