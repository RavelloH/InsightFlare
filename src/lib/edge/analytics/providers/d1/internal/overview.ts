import {
  queryWindowToTime,
  scopedFilterMetadata,
} from "@/lib/edge/analytics/contract";
import { buildLatestSiteActivityPlan } from "@/lib/edge/analytics/engine/latest-site-activity-report-plan";
import { buildOverviewAggregatePlan } from "@/lib/edge/analytics/engine/overview-aggregate-report-plan";
import { buildOverviewTrendPlan } from "@/lib/edge/analytics/engine/overview-trend-report-plan";
import { queryAnalyticsReportOutputRowsFromD1 } from "@/lib/edge/analytics/providers/d1/internal/analytics-report-query";
import {
  hasFilterDocument,
  queryOverviewForSitesFromHourlyRollups,
  queryTrendForSitesFromHourlyRollups,
} from "@/lib/edge/analytics/providers/d1/internal/hourly-rollup-queries";
import type { Env } from "@/lib/edge/types";

import type {
  ClientDimensionKey,
  FilterDocument,
  Interval,
  OverviewAggregateRow,
  PreferredSourceResult,
  QueryWindow,
  TrendAggregateRow,
} from "./core";
import { buildTimeBuckets, timeBucketTimestamp } from "./core";
import {
  type D1ReadDiagnostics,
  recordScopedFilterDiagnostics,
} from "./diagnostics";
import {
  queryOverviewClientDimensionsFromD1,
  queryOverviewGeoDimensionsFromD1,
} from "./dimensions";
import type { EventMembershipFallback } from "./event-membership-fallback";
export async function queryOverviewFromD1(
  env: Env,
  siteId: string,
  window: QueryWindow,
  filters: FilterDocument,
  diagnostics?: D1ReadDiagnostics,
  membership?: EventMembershipFallback,
): Promise<OverviewAggregateRow> {
  const readerTime = queryWindowToTime(window);
  const bound = membership?.bindPlan(
    (context) =>
      buildOverviewAggregatePlan({
        siteId,
        queryTime: readerTime,
        filters,
        scopePlan: context.scopePlan,
        qualificationDependencyRefs: context.qualificationDependencyRefs,
      }),
    readerTime,
  );
  const plan =
    bound?.plan ??
    buildOverviewAggregatePlan({
      siteId,
      queryTime: readerTime,
      filters,
    });
  recordScopedFilterDiagnostics(diagnostics, scopedFilterMetadata(filters));
  const rows = await queryAnalyticsReportOutputRowsFromD1(
    env,
    plan,
    "overview-aggregate",
    undefined,
    diagnostics,
    bound?.executionInputs,
  );
  const row = rows[0] ?? {};
  return {
    views: Number(row.views ?? 0),
    sessions: Number(row.sessions ?? 0),
    visitors: Number(row.visitors ?? 0),
    bounces: Number(row.bounces ?? 0),
    totalDuration: Number(row.totalDuration ?? 0),
    durationViews: Number(row.durationViews ?? 0),
  };
}
export async function queryTrendFromD1(
  env: Env,
  siteId: string,
  window: QueryWindow,
  interval: Interval,
  filters: FilterDocument,
  diagnostics?: D1ReadDiagnostics,
  membership?: EventMembershipFallback,
): Promise<TrendAggregateRow[]> {
  const buckets = buildTimeBuckets(window, interval);
  const readerTime = queryWindowToTime(window);
  const bound = membership?.bindPlan(
    (context) =>
      buildOverviewTrendPlan({
        siteId,
        queryTime: readerTime,
        filters,
        interval,
        scopePlan: context.scopePlan,
        qualificationDependencyRefs: context.qualificationDependencyRefs,
      }),
    readerTime,
  );
  const plan =
    bound?.plan ??
    buildOverviewTrendPlan({
      siteId,
      queryTime: readerTime,
      filters,
      interval,
    });
  recordScopedFilterDiagnostics(diagnostics, scopedFilterMetadata(filters));
  const rows = await queryAnalyticsReportOutputRowsFromD1(
    env,
    plan,
    "overview-trend",
    undefined,
    diagnostics,
    bound?.executionInputs,
  );
  return rows.map((row) => ({
    bucket: Number(row.bucket ?? 0),
    timestampMs: timeBucketTimestamp(buckets, Number(row.bucket ?? 0)),
    views: Number(row.views ?? 0),
    visitors: Number(row.visitors ?? 0),
    sessions: Number(row.sessions ?? 0),
    bounces: Number(row.bounces ?? 0),
    totalDuration: Number(row.totalDuration ?? 0),
    durationViews: Number(row.durationViews ?? 0),
  }));
}
/**
 * Site-level activity is a composite concern, not a breakdown metric. Keep
 * the filter and half-open window aligned with the overview/trend readers.
 */
export async function queryLatestSiteActivity(
  env: Env,
  siteId: string,
  window: QueryWindow,
  filters: FilterDocument,
  diagnostics?: D1ReadDiagnostics,
): Promise<number | null> {
  const plan = buildLatestSiteActivityPlan({
    siteId,
    queryTime: queryWindowToTime(window),
    filters,
  });
  recordScopedFilterDiagnostics(diagnostics, scopedFilterMetadata(filters));
  const rows = await queryAnalyticsReportOutputRowsFromD1(
    env,
    plan,
    "overview-latest-site-activity",
    undefined,
    diagnostics,
  );
  const row = rows[0];
  const raw = row?.lastActivityAt;
  if (raw === null || raw === undefined || raw === "") return null;
  const value = Number(raw);
  return Number.isSafeInteger(value) ? value : null;
}
export async function queryOverviewAggregate(
  env: Env,
  siteId: string,
  window: QueryWindow,
  filters: FilterDocument,
  diagnostics?: D1ReadDiagnostics,
  membership?: EventMembershipFallback,
): Promise<PreferredSourceResult<OverviewAggregateRow>> {
  const scopedMetadata = scopedFilterMetadata(filters);
  if (!hasFilterDocument(filters) && !scopedMetadata) {
    const rollup = await queryOverviewForSitesFromHourlyRollups(
      env,
      [siteId],
      window,
      diagnostics,
    );
    const value = rollup?.get(siteId);
    if (value) {
      return {
        value,
        source: "d1",
        diagnosticSource: "rollup",
        approximateVisitors: false,
      };
    }
  }
  return {
    value: await queryOverviewFromD1(
      env,
      siteId,
      window,
      filters,
      diagnostics,
      membership,
    ),
    source: "d1",
    diagnosticSource: "raw",
    approximateVisitors: false,
  };
}
export async function queryTrendAggregate(
  env: Env,
  siteId: string,
  window: QueryWindow,
  interval: Interval,
  filters: FilterDocument,
  diagnostics?: D1ReadDiagnostics,
  membership?: EventMembershipFallback,
): Promise<PreferredSourceResult<TrendAggregateRow[]>> {
  const scopedMetadata = scopedFilterMetadata(filters);
  if (!hasFilterDocument(filters) && !scopedMetadata) {
    const rollup = await queryTrendForSitesFromHourlyRollups(
      env,
      [siteId],
      window,
      interval,
      diagnostics,
    );
    if (rollup) {
      return {
        value: rollup
          .filter((row) => row.siteId === siteId)
          .map(({ siteId: _siteId, ...row }) => row),
        source: "d1",
        diagnosticSource: "rollup",
      };
    }
  }
  return {
    value: await queryTrendFromD1(
      env,
      siteId,
      window,
      interval,
      filters,
      diagnostics,
      membership,
    ),
    source: "d1",
    diagnosticSource: "raw",
  };
}
export async function buildOverviewClientDimensionTabs(
  env: Env,
  siteId: string,
  window: QueryWindow,
  filters: FilterDocument,
  limit: number,
) {
  return queryOverviewClientDimensionsFromD1(
    env,
    siteId,
    window,
    filters,
    limit,
  );
}
export async function buildOverviewGeoDimensionTabs(
  env: Env,
  siteId: string,
  window: QueryWindow,
  filters: FilterDocument,
  limit: number,
) {
  return queryOverviewGeoDimensionsFromD1(env, siteId, window, filters, limit);
}
export type OverviewPageTabKey =
  "path" | "title" | "hostname" | "entry" | "exit";
export type OverviewSourceTabKey = "domain" | "link";
export type OverviewClientTabKey = Exclude<
  ClientDimensionKey,
  "operatingSystem"
>;
export type OverviewGeoTabKey =
  "country" | "region" | "city" | "continent" | "timezone" | "organization";
