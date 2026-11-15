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
import type { D1ExecutionOptions } from "@/lib/edge/analytics/providers/d1/internal/execution-options";
import { bindWholeOriginalReader } from "@/lib/edge/analytics/providers/d1/internal/whole-filter-reader-preparation";
import type { Env } from "@/lib/edge/types";

import {
  bindTechnologyPageVisitQualification,
  type TechnologyPageVisitQualification,
} from "./page-visit-qualification";

interface TechnologyRadarMetrics {
  readonly sessions: number;
  readonly bounces: number;
  readonly avgDurationMs: number;
  readonly avgDepth: number;
  readonly visitors: number;
  readonly returningVisitors: number;
  readonly avgFrequency: number;
  readonly trafficShare: number;
}

type TechnologyRadarRow = TechnologyRadarMetrics & {
  readonly browser?: string;
  readonly referrer?: string;
};

/** Preserves the existing Radar DTO conversion for native and qualified rows. */
export function mapTechnologyRadarRows(
  rows: readonly Record<string, unknown>[],
  dimension: "browser",
): Array<TechnologyRadarMetrics & { readonly browser: string }>;
export function mapTechnologyRadarRows(
  rows: readonly Record<string, unknown>[],
  dimension: "referrer",
): Array<TechnologyRadarMetrics & { readonly referrer: string }>;
export function mapTechnologyRadarRows(
  rows: readonly Record<string, unknown>[],
  dimension: TechnologyRadarDimension,
): TechnologyRadarRow[];
export function mapTechnologyRadarRows(
  rows: readonly Record<string, unknown>[],
  dimension: TechnologyRadarDimension,
): TechnologyRadarRow[] {
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

async function queryTechnologyRadarFromD1(
  env: Env,
  siteId: string,
  window: QueryWindow,
  filters: FilterDocument,
  dimension: TechnologyRadarDimension,
  limit?: number,
  qualification?: TechnologyPageVisitQualification,
  wholeOriginalOwner?: object,
  execution?: D1ExecutionOptions,
): Promise<TechnologyRadarRow[]> {
  const metadata = scopedFilterMetadata(filters);
  const queryTime = qualification?.queryTime ?? queryWindowToTime(window);
  const wholeOriginal =
    !qualification && wholeOriginalOwner
      ? bindWholeOriginalReader({
          owner: wholeOriginalOwner,
          consumer: {
            kind: "page",
            family: "radar",
            reader: {
              kind: "technology-radar",
              configuration: {
                dimension,
                ...(limit === undefined ? {} : { limit }),
              },
            },
          },
          siteId,
          filters,
          queryTime: metadata?.time ?? queryWindowToTime(window),
          scopePlan: metadata?.plan,
          readerQueryTime: queryWindowToTime(window),
          ...(execution ? { execution } : {}),
        })
      : undefined;
  const plan =
    wholeOriginal?.plan ??
    buildTechnologyRadarPlan({
      siteId,
      queryTime,
      filters,
      ...(qualification
        ? {
            scopePlan: qualification.scopePlan,
            pageVisitQualification: true as const,
          }
        : metadata
          ? { scopePlan: metadata.plan }
          : {}),
      dimension,
      ...(limit === undefined ? {} : { limit }),
    });
  const bound =
    wholeOriginal ??
    bindTechnologyPageVisitQualification({
      siteId,
      filters,
      qualification,
      plan,
    });
  const rows = await queryAnalyticsReportOutputRowsFromD1(
    env,
    bound.plan,
    TECHNOLOGY_RADAR_OUTPUTS[dimension],
    undefined,
    undefined,
    bound.executionInputs,
    ...((wholeOriginal?.execution ? [wholeOriginal.execution] : []) as [
      D1ExecutionOptions?,
    ]),
  );
  return mapTechnologyRadarRows(rows, dimension);
}

export async function queryBrowserRadarFromD1(
  env: Env,
  siteId: string,
  window: QueryWindow,
  filters: FilterDocument,
  qualification?: TechnologyPageVisitQualification,
  wholeOriginalOwner?: object,
  execution?: D1ExecutionOptions,
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
    await queryTechnologyRadarFromD1(
      env,
      siteId,
      window,
      filters,
      "browser",
      undefined,
      qualification,
      ...((wholeOriginalOwner && execution
        ? [wholeOriginalOwner, execution]
        : wholeOriginalOwner
          ? [wholeOriginalOwner]
          : []) as [object?, D1ExecutionOptions?]),
    )
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
  qualification?: TechnologyPageVisitQualification,
  wholeOriginalOwner?: object,
  execution?: D1ExecutionOptions,
): Promise<ReferrerRadarRow[]> {
  return (
    await queryTechnologyRadarFromD1(
      env,
      siteId,
      window,
      filters,
      "referrer",
      limit,
      qualification,
      ...((wholeOriginalOwner && execution
        ? [wholeOriginalOwner, execution]
        : wholeOriginalOwner
          ? [wholeOriginalOwner]
          : []) as [object?, D1ExecutionOptions?]),
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
