import { scopedFilterMetadata } from "@/lib/edge/analytics/contract";
import { queryWindowToTime } from "@/lib/edge/analytics/contract/helpers";
import {
  buildTechnologyReferrerChannelTrendPlan,
  buildTechnologyShareTrendPlan,
  CLIENT_DIMENSIONS,
  TECHNOLOGY_SHARE_TREND_OUTPUTS,
  type TechnologyShareTrendDimension,
  type TechnologyShareTrendQualificationConfiguration,
  UTM_DIMENSIONS,
} from "@/lib/edge/analytics/engine/technology-share-trend-report-plan";
import { queryAnalyticsReportOutputSetRowsFromD1 } from "@/lib/edge/analytics/providers/d1/internal/analytics-report-query";
import type {
  BrowserTrendBucketRow,
  BrowserTrendPointRow,
  BrowserTrendSeriesRow,
  ClientDimensionKey,
  FilterDocument,
  Interval,
  QueryWindow,
  TimeBucket,
  UtmDimensionKey,
} from "@/lib/edge/analytics/providers/d1/internal/core";
import {
  buildTimeBuckets,
  SHARE_TREND_OTHER_KEY,
  SHARE_TREND_OTHER_LABEL,
  SHARE_TREND_OTHER_TOKEN,
  shareTrendSeriesKey,
  timeBucketTimestamp,
} from "@/lib/edge/analytics/providers/d1/internal/core";
import type { Env } from "@/lib/edge/types";

export interface ShareTrendResult {
  series: BrowserTrendSeriesRow[];
  data: BrowserTrendPointRow[];
}

export interface ReferrerAndChannelTrendResult {
  source: ShareTrendResult;
  channel: ShareTrendResult;
}

type ShareTrendQueryRow = Record<string, unknown>;
type ShareTrendOutputKind = "single" | "source" | "channel";

const FALLBACK_KEY_BASE: Readonly<
  Record<TechnologyShareTrendDimension, string>
> = {
  browser: "browser",
  browserEngine: "engine",
  operatingSystem: "os",
  osVersion: "os-version",
  deviceType: "device",
  language: "language",
  screenSize: "screen",
  utmSource: "utm-source",
  utmMedium: "utm-medium",
  utmCampaign: "utm-campaign",
  utmTerm: "utm-term",
  utmContent: "utm-content",
  referrerDomain: "referrer-domain",
  trafficChannel: "channel",
};

function mapShareTrendRows(
  rows: readonly ShareTrendQueryRow[],
  buckets: TimeBucket[],
  fallbackKeyBase: string,
  trendKind: ShareTrendOutputKind,
): ShareTrendResult {
  const topRows = rows
    .filter(
      (row) =>
        String(row.trendKind ?? "") === trendKind &&
        String(row.rowType ?? "") === "top",
    )
    .map((row) => ({
      label: String(row.label ?? "").trim(),
      views: Number(row.views ?? 0),
      visitors: Number(row.visitors ?? 0),
      sessions: Number(row.sessions ?? 0),
    }))
    .filter((row) => row.label.length > 0 && row.visitors > 0);
  const seriesRows = rows
    .filter(
      (row) =>
        String(row.trendKind ?? "") === trendKind &&
        String(row.rowType ?? "") === "series",
    )
    .map((row) => ({
      label: String(row.label ?? "").trim(),
      views: Number(row.views ?? 0),
      visitors: Number(row.visitors ?? 0),
      sessions: Number(row.sessions ?? 0),
    }))
    .filter((row) => row.label.length > 0 && row.visitors > 0);
  const bucketRows = rows
    .filter(
      (row) =>
        String(row.trendKind ?? "") === trendKind &&
        String(row.rowType ?? "") === "bucket",
    )
    .map(
      (row) =>
        ({
          bucket: Number(row.bucket ?? 0),
          label: String(row.label ?? "").trim(),
          views: Number(row.views ?? 0),
          visitors: Number(row.visitors ?? 0),
          sessions: Number(row.sessions ?? 0),
        }) satisfies BrowserTrendBucketRow,
    );

  if (seriesRows.length === 0) {
    return { series: [], data: [] };
  }

  const topLabels = topRows.map((row) => row.label);
  const seriesByLabel = new Map(
    seriesRows.map((row) => [row.label, row] as const),
  );
  const usedKeys = new Set<string>([SHARE_TREND_OTHER_KEY]);
  const series: BrowserTrendSeriesRow[] = [];
  const keyByLabel = new Map<string, string>();

  for (const label of topLabels) {
    const row = seriesByLabel.get(label);
    if (!row || row.visitors <= 0) continue;
    const key = shareTrendSeriesKey(label, usedKeys, fallbackKeyBase);
    keyByLabel.set(label, key);
    series.push({
      key,
      label,
      views: row.views,
      visitors: row.visitors,
      sessions: row.sessions,
    });
  }

  const otherRow = seriesByLabel.get(SHARE_TREND_OTHER_TOKEN);
  if (otherRow && otherRow.visitors > 0) {
    keyByLabel.set(SHARE_TREND_OTHER_TOKEN, SHARE_TREND_OTHER_KEY);
    series.push({
      key: SHARE_TREND_OTHER_KEY,
      label: SHARE_TREND_OTHER_LABEL,
      views: otherRow.views,
      visitors: otherRow.visitors,
      sessions: otherRow.sessions,
      isOther: true,
    });
  }

  const hasBucketOther = bucketRows.some(
    (row) => row.label === SHARE_TREND_OTHER_TOKEN && row.visitors > 0,
  );
  if (!otherRow && hasBucketOther) {
    keyByLabel.set(SHARE_TREND_OTHER_TOKEN, SHARE_TREND_OTHER_KEY);
    series.push({
      key: SHARE_TREND_OTHER_KEY,
      label: SHARE_TREND_OTHER_LABEL,
      views: 0,
      visitors: 0,
      sessions: 0,
      isOther: true,
    });
  }

  if (series.length === 0) {
    return { series: [], data: [] };
  }

  const createEmptyPoint = (bucket: number): BrowserTrendPointRow => ({
    bucket,
    timestampMs: timeBucketTimestamp(buckets, bucket),
    totalVisitors: 0,
    visitorsBySeries: Object.fromEntries(series.map((item) => [item.key, 0])),
  });

  const pointsByBucket = new Map<number, BrowserTrendPointRow>();
  for (const row of bucketRows) {
    const key = keyByLabel.get(row.label);
    if (!key) continue;
    const point =
      pointsByBucket.get(row.bucket) ?? createEmptyPoint(row.bucket);
    point.visitorsBySeries[key] = row.visitors;
    point.totalVisitors += row.visitors;
    pointsByBucket.set(row.bucket, point);
  }

  const data: BrowserTrendPointRow[] = [];
  for (const item of buckets)
    data.push(pointsByBucket.get(item.index) ?? createEmptyPoint(item.index));

  return { series, data };
}

export function mapQualifiedShareTrendRows(
  rows: readonly ShareTrendQueryRow[],
  window: QueryWindow,
  interval: Interval,
  configuration: TechnologyShareTrendQualificationConfiguration,
): ShareTrendResult | ReferrerAndChannelTrendResult {
  const buckets = buildTimeBuckets(window, interval);
  if (configuration.kind === "single")
    return mapShareTrendRows(
      rows,
      buckets,
      FALLBACK_KEY_BASE[configuration.dimension],
      "single",
    );
  return {
    source: mapShareTrendRows(
      rows,
      buckets,
      FALLBACK_KEY_BASE.referrerDomain,
      "source",
    ),
    channel: mapShareTrendRows(
      rows,
      buckets,
      FALLBACK_KEY_BASE.trafficChannel,
      "channel",
    ),
  };
}

function trendOutputIds(kind: ShareTrendOutputKind): readonly string[] {
  const outputs = TECHNOLOGY_SHARE_TREND_OUTPUTS[kind];
  return [outputs.top, outputs.series, outputs.bucket];
}

async function executeTrendOutputs(
  env: Env,
  plan: ReturnType<typeof buildTechnologyShareTrendPlan>,
  outputKinds: readonly ShareTrendOutputKind[],
): Promise<ShareTrendQueryRow[]> {
  const selection = {
    outputIds: outputKinds.flatMap(trendOutputIds),
    fields: [
      "trendKind",
      "rowType",
      "bucket",
      "label",
      "views",
      "visitors",
      "sessions",
      "rowOrder",
    ],
    orderBy: [
      { field: "trendKind", direction: "asc", nulls: "first" },
      { field: "rowType", direction: "asc", nulls: "first" },
      { field: "rowOrder", direction: "asc", nulls: "first" },
      { field: "bucket", direction: "asc", nulls: "first" },
      { field: "label", direction: "asc", nulls: "first" },
    ],
  } as const;
  return queryAnalyticsReportOutputSetRowsFromD1(env, plan, selection);
}

export async function queryShareTrendFromD1(
  env: Env,
  siteId: string,
  window: QueryWindow,
  interval: Interval,
  filters: FilterDocument,
  limit: number,
  dimension: TechnologyShareTrendDimension,
): Promise<ShareTrendResult> {
  const buckets = buildTimeBuckets(window, interval);
  const metadata = scopedFilterMetadata(filters);
  const normalizedLimit = Math.min(Math.max(1, limit), 12);
  const plan = buildTechnologyShareTrendPlan({
    siteId,
    queryTime: queryWindowToTime(window),
    filters,
    ...(metadata ? { scopePlan: metadata.plan } : {}),
    interval,
    limit: normalizedLimit,
    dimension,
  });
  const rows = await executeTrendOutputs(env, plan, ["single"]);
  return mapShareTrendRows(
    rows,
    buckets,
    FALLBACK_KEY_BASE[dimension],
    "single",
  );
}

/** Reads Referrer and traffic-channel trends in one six-output statement. */
export async function queryReferrerAndChannelTrendFromD1(
  env: Env,
  siteId: string,
  window: QueryWindow,
  interval: Interval,
  filters: FilterDocument,
  limit: number,
): Promise<ReferrerAndChannelTrendResult> {
  const buckets = buildTimeBuckets(window, interval);
  const metadata = scopedFilterMetadata(filters);
  const normalizedLimit = Math.min(Math.max(1, limit), 12);
  const plan = buildTechnologyReferrerChannelTrendPlan({
    siteId,
    queryTime: queryWindowToTime(window),
    filters,
    ...(metadata ? { scopePlan: metadata.plan } : {}),
    interval,
    limit: normalizedLimit,
  });
  const rows = await executeTrendOutputs(env, plan, ["source", "channel"]);
  return {
    source: mapShareTrendRows(
      rows,
      buckets,
      FALLBACK_KEY_BASE.referrerDomain,
      "source",
    ),
    channel: mapShareTrendRows(
      rows,
      buckets,
      FALLBACK_KEY_BASE.trafficChannel,
      "channel",
    ),
  };
}

export async function queryClientDimensionTrendFromD1(
  env: Env,
  siteId: string,
  window: QueryWindow,
  interval: Interval,
  filters: FilterDocument,
  dimension: ClientDimensionKey,
  limit: number,
): Promise<ShareTrendResult> {
  return queryShareTrendFromD1(
    env,
    siteId,
    window,
    interval,
    filters,
    limit,
    CLIENT_DIMENSIONS[dimension],
  );
}

export async function queryUtmDimensionTrendFromD1(
  env: Env,
  siteId: string,
  window: QueryWindow,
  interval: Interval,
  filters: FilterDocument,
  dimension: UtmDimensionKey,
  limit: number,
): Promise<ShareTrendResult> {
  return queryShareTrendFromD1(
    env,
    siteId,
    window,
    interval,
    filters,
    limit,
    UTM_DIMENSIONS[dimension],
  );
}

export async function queryReferrerTrendFromD1(
  env: Env,
  siteId: string,
  window: QueryWindow,
  interval: Interval,
  filters: FilterDocument,
  limit: number,
): Promise<ShareTrendResult> {
  return queryShareTrendFromD1(
    env,
    siteId,
    window,
    interval,
    filters,
    limit,
    "referrerDomain",
  );
}
