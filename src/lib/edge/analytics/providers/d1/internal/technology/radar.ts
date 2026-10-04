import { scopedFilterMetadata } from "@/lib/edge/analytics/contract";
import { queryWindowToTime } from "@/lib/edge/analytics/contract/helpers";
import {
  buildTechnologyRadarPlan,
  TECHNOLOGY_RADAR_OUTPUTS,
  type TechnologyRadarDimension,
} from "@/lib/edge/analytics/engine/technology-radar-report-plan";
import { queryAnalyticsReportOutputRowsFromD1 } from "@/lib/edge/analytics/providers/d1/internal/analytics-report-query";
import type {
  FilterDocument,
  QueryWindow,
  ReferrerRadarRow,
} from "@/lib/edge/analytics/providers/d1/internal/core";
import type { Env } from "@/lib/edge/types";

interface TechnologyRadarRow {
  readonly browser?: string;
  readonly referrer?: string;
  readonly sessions: number;
  readonly bounces: number;
  readonly avgDurationMs: number;
  readonly avgDepth: number;
  readonly visitors: number;
  readonly returningVisitors: number;
  readonly avgFrequency: number;
  readonly trafficShare: number;
}

async function queryTechnologyRadarFromD1(
  env: Env,
  siteId: string,
  window: QueryWindow,
  filters: FilterDocument,
  dimension: TechnologyRadarDimension,
  limit?: number,
): Promise<TechnologyRadarRow[]> {
  const metadata = scopedFilterMetadata(filters);
  const rows = await queryAnalyticsReportOutputRowsFromD1(
    env,
    buildTechnologyRadarPlan({
      siteId,
      // Prepared Page reads honor the current reader window.
      queryTime: queryWindowToTime(window),
      filters,
      ...(metadata ? { scopePlan: metadata.plan } : {}),
      dimension,
      ...(limit === undefined ? {} : { limit }),
    }),
    TECHNOLOGY_RADAR_OUTPUTS[dimension],
  );
  return rows.map((row) => ({
    ...(dimension === "browser"
      ? { browser: String(row.browser ?? "").trim() }
      : { referrer: String(row.referrer ?? "").trim() }),
    sessions: Number(row.sessions ?? 0),
    bounces: Number(row.bounces ?? 0),
    avgDurationMs: Number(row.avgDurationMs ?? 0),
    avgDepth: Number(row.avgDepth ?? 0),
    visitors: Number(row.visitors ?? 0),
    returningVisitors: Number(row.returningVisitors ?? 0),
    avgFrequency: Number(row.avgFrequency ?? 0),
    trafficShare: Number(row.trafficShare ?? 0),
  }));
}

export async function queryBrowserRadarFromD1(
  env: Env,
  siteId: string,
  window: QueryWindow,
  filters: FilterDocument,
): Promise<
  Array<{
    browser: string;
    sessions: number;
    bounces: number;
    avgDurationMs: number;
    avgDepth: number;
    visitors: number;
    returningVisitors: number;
    avgFrequency: number;
    trafficShare: number;
  }>
> {
  return (
    await queryTechnologyRadarFromD1(env, siteId, window, filters, "browser")
  )
    .filter((row) => row.browser!.length > 0 && row.visitors > 0)
    .map((row) => ({
      browser: row.browser!,
      sessions: row.sessions,
      bounces: row.bounces,
      avgDurationMs: row.avgDurationMs,
      avgDepth: row.avgDepth,
      visitors: row.visitors,
      returningVisitors: row.returningVisitors,
      avgFrequency: row.avgFrequency,
      trafficShare: row.trafficShare,
    }));
}

export async function queryReferrerRadarFromD1(
  env: Env,
  siteId: string,
  window: QueryWindow,
  filters: FilterDocument,
  limit: number,
): Promise<ReferrerRadarRow[]> {
  return (
    await queryTechnologyRadarFromD1(
      env,
      siteId,
      window,
      filters,
      "referrer",
      limit,
    )
  )
    .filter((row) => row.visitors > 0)
    .map((row) => ({
      referrer: row.referrer!,
      sessions: row.sessions,
      bounces: row.bounces,
      avgDurationMs: row.avgDurationMs,
      avgDepth: row.avgDepth,
      visitors: row.visitors,
      returningVisitors: row.returningVisitors,
      avgFrequency: row.avgFrequency,
      trafficShare: row.trafficShare,
    }));
}
