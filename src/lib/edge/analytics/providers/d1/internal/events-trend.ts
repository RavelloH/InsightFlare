import { scopedFilterMetadata } from "@/lib/edge/analytics/contract";
import { queryWindowToTime } from "@/lib/edge/analytics/contract/helpers";
import {
  buildEventTrendOtherPlan,
  buildEventTrendPointsPlan,
  buildEventTrendSeriesPlan,
  buildEventTypeTrendPlan,
  EVENT_TREND_OUTPUTS,
} from "@/lib/edge/analytics/engine/event-trend-plan";
import type { Env } from "@/lib/edge/types";

import { queryAnalyticsReportOutputRowsFromD1 } from "./analytics-report-query";
import {
  type EventTrendPointRow,
  type EventTrendSeriesRow,
  type EventTypeTrendPointRow,
  type FilterDocument,
  type Interval,
  type QueryWindow,
} from "./core";
import {
  buildTimeBuckets,
  SHARE_TREND_OTHER_KEY,
  SHARE_TREND_OTHER_LABEL,
  SHARE_TREND_OTHER_TOKEN,
  shareTrendSeriesKey,
} from "./core";

function trendPlanInput(
  siteId: string,
  window: QueryWindow,
  filters: FilterDocument,
) {
  const metadata = scopedFilterMetadata(filters);
  return {
    siteId,
    queryTime: metadata?.time ?? queryWindowToTime(window),
    filters,
    ...(metadata ? { scopePlan: metadata.plan } : {}),
  };
}

function seriesRow(row: Record<string, unknown>): EventTrendSeriesRow {
  return {
    // Event names are non-NULL in the deployed schema. Keep an anomalous NULL
    // as-is at runtime so the existing series-label path retains its failure
    // behavior instead of silently inventing an empty name.
    eventName: row.eventName as string,
    events: Number(row.events ?? 0),
    sessions: Number(row.sessions ?? 0),
    visitors: Number(row.visitors ?? 0),
  };
}

export async function queryEventsTrendFromD1(
  env: Env,
  siteId: string,
  window: QueryWindow,
  interval: Interval,
  filters: FilterDocument,
  limit: number,
  eventName?: string,
) {
  const source = trendPlanInput(siteId, window, filters);
  const eventFilter = eventName !== undefined ? { eventName } : {};
  const seriesRows = (
    await queryAnalyticsReportOutputRowsFromD1(
      env,
      buildEventTrendSeriesPlan({ ...source, ...eventFilter, limit }),
      EVENT_TREND_OUTPUTS.series,
    )
  ).map(seriesRow);
  const buckets = buildTimeBuckets(window, interval);
  const seriesKeyByName = new Map<string, string>();
  const usedKeys = new Set<string>();
  for (const row of seriesRows) {
    seriesKeyByName.set(
      row.eventName,
      shareTrendSeriesKey(row.eventName, usedKeys, "event"),
    );
  }
  const seriesNames = seriesRows.map((row) => row.eventName);
  const trendRows = (
    await queryAnalyticsReportOutputRowsFromD1(
      env,
      buildEventTrendPointsPlan({
        ...source,
        ...eventFilter,
        interval,
        seriesNames,
        otherToken: SHARE_TREND_OTHER_TOKEN,
      }),
      EVENT_TREND_OUTPUTS.points,
    )
  ).map((row): EventTrendPointRow => ({
    bucket: Number(row.bucket ?? -1),
    seriesKey: String(row.seriesName ?? ""),
    events: Number(row.events ?? 0),
  }));
  const hasOther = trendRows.some(
    (row) => String(row.seriesKey) === SHARE_TREND_OTHER_TOKEN,
  );
  const [otherRow] = hasOther
    ? (
        await queryAnalyticsReportOutputRowsFromD1(
          env,
          buildEventTrendOtherPlan({
            ...source,
            ...eventFilter,
            seriesNames,
            otherLabel: SHARE_TREND_OTHER_LABEL,
          }),
          EVENT_TREND_OUTPUTS.other,
        )
      ).map(seriesRow)
    : [];
  const series: Array<{
    key: string;
    eventName: string;
    label: string;
    events: number;
    sessions: number;
    visitors: number;
    isOther?: boolean;
  }> = seriesRows.map((row) => ({
    key: seriesKeyByName.get(row.eventName)!,
    eventName: row.eventName,
    label: row.eventName,
    events: row.events,
    sessions: row.sessions,
    visitors: row.visitors,
  }));
  if (hasOther) {
    series.push({
      key: SHARE_TREND_OTHER_KEY,
      eventName: SHARE_TREND_OTHER_LABEL,
      label: SHARE_TREND_OTHER_LABEL,
      events:
        Number(otherRow?.events ?? 0) ||
        trendRows
          .filter((row) => String(row.seriesKey) === SHARE_TREND_OTHER_TOKEN)
          .reduce((sum, row) => sum + Number(row.events ?? 0), 0),
      sessions: Number(otherRow?.sessions ?? 0),
      visitors: Number(otherRow?.visitors ?? 0),
      isOther: true,
    });
  }
  const data = buckets.map((item) => ({
    bucket: item.index,
    timestampMs: item.timestampMs,
    totalEvents: 0,
    eventsBySeries: {} as Record<string, number>,
  }));
  for (const row of trendRows) {
    const bucketIndex = Number(row.bucket ?? -1);
    const point = data[bucketIndex];
    if (!point) continue;
    const rawSeries = String(row.seriesKey ?? "");
    const key =
      rawSeries === SHARE_TREND_OTHER_TOKEN
        ? SHARE_TREND_OTHER_KEY
        : (seriesKeyByName.get(rawSeries) ?? rawSeries);
    const events = Number(row.events ?? 0);
    point.eventsBySeries[key] = events;
    point.totalEvents += events;
  }
  return { series, data };
}

export async function queryEventTypeTrendFromD1(
  env: Env,
  siteId: string,
  window: QueryWindow,
  interval: Interval,
  filters: FilterDocument,
  eventName: string,
) {
  const source = trendPlanInput(siteId, window, filters);
  const rows = (
    await queryAnalyticsReportOutputRowsFromD1(
      env,
      buildEventTypeTrendPlan({ ...source, eventName, interval }),
      EVENT_TREND_OUTPUTS.typePoints,
    )
  ).map((row): EventTypeTrendPointRow => ({
    bucket: Number(row.bucket ?? -1),
    events: Number(row.events ?? 0),
    visitors: Number(row.visitors ?? 0),
  }));
  const buckets = buildTimeBuckets(window, interval);
  const data = buckets.map((item) => ({
    bucket: item.index,
    timestampMs: item.timestampMs,
    events: 0,
    visitors: 0,
  }));
  for (const row of rows) {
    const bucketIndex = Number(row.bucket ?? -1);
    const point = data[bucketIndex];
    if (!point) continue;
    point.events = Number(row.events ?? 0);
    point.visitors = Number(row.visitors ?? 0);
  }
  return { data };
}
