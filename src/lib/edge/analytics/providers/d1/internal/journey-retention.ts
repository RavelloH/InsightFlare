import {
  type RetentionResult,
  scopedFilterMetadata,
} from "@/lib/edge/analytics/contract";
import { queryWindowToTime } from "@/lib/edge/analytics/contract/helpers";
import { buildJourneyRetentionPlan } from "@/lib/edge/analytics/engine/journey-retention-report-plan";
import { queryAnalyticsReportOutputRowsFromD1 } from "@/lib/edge/analytics/providers/d1/internal/analytics-report-query";
import type { Env } from "@/lib/edge/types";

import type { FilterDocument, Interval, QueryWindow } from "./core";
import { buildTimeBuckets, timeBucketTimestamp } from "./core";

export function parseRetentionGranularity(value: string | null): Interval {
  return value === "minute" ||
    value === "hour" ||
    value === "day" ||
    value === "week" ||
    value === "month"
    ? value
    : "week";
}

export type { RetentionResult } from "@/lib/edge/analytics/contract";

export function retentionResultFromRows(
  window: QueryWindow,
  granularity: Interval,
  rows: readonly Record<string, unknown>[],
): RetentionResult {
  const buckets = buildTimeBuckets(window, granularity);
  const cohortMap = new Map<
    number,
    { size: number; periods: Map<number, number> }
  >();
  for (const row of rows) {
    const cohortBucket = Number(row.cohortBucket ?? 0);
    const visitBucket = Number(row.visitBucket ?? 0);
    const visitors = Number(row.visitors ?? 0);

    if (!cohortMap.has(cohortBucket))
      cohortMap.set(cohortBucket, { size: 0, periods: new Map() });
    const cohort = cohortMap.get(cohortBucket)!;
    cohort.periods.set(visitBucket, visitors);
    if (visitBucket === cohortBucket) cohort.size = visitors;
  }

  return {
    granularity,
    cohorts: Array.from(cohortMap.entries())
      .sort(([left], [right]) => left - right)
      .map(([bucket, { size, periods }]) => ({
        bucket: timeBucketTimestamp(buckets, bucket),
        size,
        periods: Array.from(periods.entries())
          .sort(([left], [right]) => left - right)
          .map(([visitBucket, visitors]) => ({
            index: Math.max(0, visitBucket - bucket),
            visitors,
            rate: size > 0 ? visitors / size : 0,
          })),
      })),
  };
}

export async function queryRetentionFromD1(
  env: Env,
  siteId: string,
  window: QueryWindow,
  filters: FilterDocument,
  granularity: Interval,
): Promise<RetentionResult> {
  const metadata = scopedFilterMetadata(filters);
  const plan = buildJourneyRetentionPlan({
    siteId,
    queryTime: queryWindowToTime(window),
    filters,
    ...(metadata ? { scopePlan: metadata.plan } : {}),
    granularity,
  });
  const rows = await queryAnalyticsReportOutputRowsFromD1(
    env,
    plan,
    "journey-retention",
  );

  return retentionResultFromRows(window, granularity, rows);
}
