import "@tanstack/react-start/server-only";

import type {
  FilterDocument,
  OverviewMetrics,
  OverviewReader,
  OverviewReaderInput,
  QueryTime,
  TrendPoint,
  TrendReaderInput,
  TrendReaderResult,
} from "@/lib/edge/analytics/contract";
import type {
  QueryWindow,
  TrendAggregateRow,
} from "@/lib/edge/analytics/providers/d1/internal/core";
import {
  createD1ReadDiagnostics,
  type D1ReadDiagnostics,
} from "@/lib/edge/analytics/providers/d1/internal/diagnostics";
import {
  queryLatestSiteActivity,
  queryOverviewAggregate,
  queryTrendAggregate,
} from "@/lib/edge/analytics/providers/d1/internal/overview";
import type { Env } from "@/lib/edge/types";

export function toQueryTime(window: QueryWindow): QueryTime {
  return {
    range: {
      startMs: window.startMs as QueryTime["range"]["startMs"],
      endExclusiveMs:
        window.endExclusiveMs as QueryTime["range"]["endExclusiveMs"],
    },
    reportingTimeZone: window.timeZone as QueryTime["reportingTimeZone"],
    capturedAtMs: window.nowMs as QueryTime["capturedAtMs"],
  };
}

function sourceFromDiagnostic(
  result: { diagnosticSource?: "raw" | "rollup" } | undefined,
): "raw" | "rollup" {
  return result?.diagnosticSource ?? "raw";
}

export function createOverviewReader(
  env: Env,
  siteId: string,
  diagnostics: D1ReadDiagnostics = createD1ReadDiagnostics(),
): OverviewReader {
  return {
    async readOverview(input: OverviewReaderInput) {
      const result = await queryOverviewAggregate(
        env,
        siteId,
        {
          startMs: input.time.range.startMs,
          endExclusiveMs: input.time.range.endExclusiveMs,
          nowMs: input.time.capturedAtMs,
          timeZone: input.time.reportingTimeZone,
        },
        input.filters,
        diagnostics,
      );
      return {
        value: {
          views: result.value.views,
          sessions: result.value.sessions,
          visitors: result.value.visitors,
          bounces: result.value.bounces,
          totalDurationMs: result.value.totalDuration,
          durationViews: result.value.durationViews,
        },
        source: sourceFromDiagnostic(result),
        approximateVisitors: Boolean(result.approximateVisitors),
      };
    },
    async readTrend(input: TrendReaderInput): Promise<TrendReaderResult> {
      const result = await queryTrendAggregate(
        env,
        siteId,
        {
          startMs: input.time.range.startMs,
          endExclusiveMs: input.time.range.endExclusiveMs,
          nowMs: input.time.capturedAtMs,
          timeZone: input.time.reportingTimeZone,
        },
        input.interval,
        input.filters,
        diagnostics,
      );
      return {
        value: result.value.map((row: TrendAggregateRow) => ({
          bucket: row.bucket,
          timestampMs: row.timestampMs as TrendPoint["timestampMs"],
          views: row.views,
          sessions: row.sessions,
          visitors: row.visitors,
          bounces: row.bounces,
          totalDurationMs: row.totalDuration,
          durationViews: row.durationViews,
        })),
        source: sourceFromDiagnostic(result),
        approximateVisitors: Boolean(result.approximateVisitors),
      };
    },
  };
}

export async function readLatestSiteActivity(
  env: Env,
  siteId: string,
  window: QueryWindow,
  filters: FilterDocument,
  diagnostics: D1ReadDiagnostics = createD1ReadDiagnostics(),
): Promise<number | null> {
  return queryLatestSiteActivity(env, siteId, window, filters, diagnostics);
}

export type { OverviewMetrics };
