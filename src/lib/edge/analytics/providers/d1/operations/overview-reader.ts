import "@tanstack/react-start/server-only";

import type {
  FilterDocument,
  OverviewMetrics,
  OverviewReader,
  OverviewReaderInput,
  TrendPoint,
  TrendReaderInput,
  TrendReaderResult,
} from "@/lib/edge/analytics/contract";
import type { QueryWindow } from "@/lib/edge/analytics/contract";
import { queryWindowToTime } from "@/lib/edge/analytics/contract";
import type { TrendAggregateRow } from "@/lib/edge/analytics/providers/d1/internal/core";
import {
  createD1ReadDiagnostics,
  type D1ReadDiagnostics,
} from "@/lib/edge/analytics/providers/d1/internal/diagnostics";
import type { EventMembershipFallback } from "@/lib/edge/analytics/providers/d1/internal/event-membership-fallback";
import {
  type OverviewMembership,
  queryLatestSiteActivity,
  queryOverviewAggregate,
  queryTrendAggregate,
} from "@/lib/edge/analytics/providers/d1/internal/overview";
import type { Env } from "@/lib/edge/types";
export const toQueryTime = queryWindowToTime;
function sourceFromDiagnostic(
  result: { diagnosticSource?: "raw" | "rollup" } | undefined,
): "raw" | "rollup" {
  return result?.diagnosticSource ?? "raw";
}
export function createOverviewReader(
  env: Env,
  siteId: string,
  diagnostics: D1ReadDiagnostics = createD1ReadDiagnostics(),
  /**
   * Request-private entity membership for the fallback of one qualified
   * Overview request. Every read of this reader binds its own plan to it.
   */
  membership?: OverviewMembership,
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
        ...(membership ? [membership] : []),
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
        ...(membership ? [membership] : []),
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
  membership?: EventMembershipFallback,
): Promise<number | null> {
  return queryLatestSiteActivity(
    env,
    siteId,
    window,
    filters,
    diagnostics,
    membership,
  );
}
export type { OverviewMetrics };
