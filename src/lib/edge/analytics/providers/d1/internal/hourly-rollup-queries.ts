import { type StoredRollupRow } from "@/lib/edge/analytics/contract/hourly-rollup";
import { sitePksFromSiteIdsSql } from "@/lib/edge/sites/identity-sql";
import type { Env } from "@/lib/edge/types";
import { ONE_HOUR_MS } from "@/lib/edge/utils";

import { buildTimeBuckets, timeBucketTimestamp } from "./core-time";
import type {
  FilterDocument,
  Interval,
  OverviewAggregateRow,
  QueryWindow,
  TrendAggregateRow,
} from "./core-types";
import { type D1ReadDiagnostics, recordD1RowsRead } from "./diagnostics";
const D1_MAX_BOUND_PARAMETERS = 100;
function siteIdChunks(siteIds: string[], fixedBindingCount = 0): string[][] {
  const maxSiteIds = D1_MAX_BOUND_PARAMETERS - fixedBindingCount;
  const chunks: string[][] = [];
  for (let index = 0; index < siteIds.length; index += maxSiteIds) {
    chunks.push(siteIds.slice(index, index + maxSiteIds));
  }
  return chunks;
}
interface AggregationStateRow {
  siteId: string;
  aggregatedUntilHour: number;
}
interface RollupWindowGroup {
  siteIds: string[];
  split: NonNullable<ReturnType<typeof splitRollupWindow>>;
}
interface DetailVisitRow {
  siteId: string;
  startedAt: number;
  visitorId: string;
  sessionId: string;
  durationMs: number | null;
  perfTtfbMs: number | null;
  perfFcpMs: number | null;
  perfLcpMs: number | null;
  perfCls: number | null;
  perfInpMs: number | null;
}
interface PerfTotals {
  ttfbSum: number;
  ttfbCount: number;
  fcpSum: number;
  fcpCount: number;
  lcpSum: number;
  lcpCount: number;
  clsSum: number;
  clsCount: number;
  inpSum: number;
  inpCount: number;
}
interface MetricAccumulator {
  views: number;
  durationMsSum: number;
  durationMsCount: number;
  visitors: Set<string>;
  sessionCounts: Map<string, number>;
  sessionFirstAt: Map<string, number>;
  perf: PerfTotals;
}
interface BucketAccumulator extends MetricAccumulator {
  bucket: number;
  timestampMs: number;
}
interface SiteTrendAccumulator {
  bucketAccumulators: Map<number, BucketAccumulator>;
  sessionCounts: Map<string, number>;
  sessionFirstAt: Map<string, number>;
}
export function hasFilterDocument(filters: FilterDocument): boolean {
  return filters.root !== null;
}
function createPerfTotals(): PerfTotals {
  return {
    ttfbSum: 0,
    ttfbCount: 0,
    fcpSum: 0,
    fcpCount: 0,
    lcpSum: 0,
    lcpCount: 0,
    clsSum: 0,
    clsCount: 0,
    inpSum: 0,
    inpCount: 0,
  };
}
function createMetricAccumulator(): MetricAccumulator {
  return {
    views: 0,
    durationMsSum: 0,
    durationMsCount: 0,
    visitors: new Set<string>(),
    sessionCounts: new Map<string, number>(),
    sessionFirstAt: new Map<string, number>(),
    perf: createPerfTotals(),
  };
}
function createBucketAccumulator(
  bucket: number,
  timestampMs: number,
): BucketAccumulator {
  return {
    ...createMetricAccumulator(),
    bucket,
    timestampMs,
  };
}
function addFiniteMetric(
  perf: PerfTotals,
  key: "ttfb" | "fcp" | "lcp" | "cls" | "inp",
  value: number | null,
): void {
  if (typeof value !== "number" || !Number.isFinite(value)) return;
  if (key === "ttfb") {
    perf.ttfbSum += value;
    perf.ttfbCount += 1;
  } else if (key === "fcp") {
    perf.fcpSum += value;
    perf.fcpCount += 1;
  } else if (key === "lcp") {
    perf.lcpSum += value;
    perf.lcpCount += 1;
  } else if (key === "cls") {
    perf.clsSum += value;
    perf.clsCount += 1;
  } else {
    perf.inpSum += value;
    perf.inpCount += 1;
  }
}
function mergePerf(target: PerfTotals, source: PerfTotals): void {
  target.ttfbSum += source.ttfbSum;
  target.ttfbCount += source.ttfbCount;
  target.fcpSum += source.fcpSum;
  target.fcpCount += source.fcpCount;
  target.lcpSum += source.lcpSum;
  target.lcpCount += source.lcpCount;
  target.clsSum += source.clsSum;
  target.clsCount += source.clsCount;
  target.inpSum += source.inpSum;
  target.inpCount += source.inpCount;
}
function addSessionCount(
  counts: Map<string, number>,
  firstAt: Map<string, number>,
  sessionId: string,
  count: number,
  seenAt: number,
): void {
  const normalized = sessionId.trim();
  if (!normalized) return;
  counts.set(normalized, (counts.get(normalized) ?? 0) + count);
  const existing = firstAt.get(normalized);
  if (existing === undefined || seenAt < existing) {
    firstAt.set(normalized, seenAt);
  }
}
function addDetailVisit(accumulator: MetricAccumulator, row: DetailVisitRow) {
  accumulator.views += 1;
  const visitorId = row.visitorId.trim();
  if (visitorId) accumulator.visitors.add(visitorId);
  addSessionCount(
    accumulator.sessionCounts,
    accumulator.sessionFirstAt,
    row.sessionId,
    1,
    row.startedAt,
  );
  if (typeof row.durationMs === "number" && row.durationMs >= 0) {
    accumulator.durationMsSum += row.durationMs;
    accumulator.durationMsCount += 1;
  }
  addFiniteMetric(accumulator.perf, "ttfb", row.perfTtfbMs);
  addFiniteMetric(accumulator.perf, "fcp", row.perfFcpMs);
  addFiniteMetric(accumulator.perf, "lcp", row.perfLcpMs);
  addFiniteMetric(accumulator.perf, "cls", row.perfCls);
  addFiniteMetric(accumulator.perf, "inp", row.perfInpMs);
}
function parseJsonStringArray(value: string): string[] {
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map((item) => String(item ?? "").trim())
      .filter((item) => item.length > 0);
  } catch {
    return [];
  }
}
function parseSessionCountsJson(value: string): Array<[string, number]> {
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!Array.isArray(parsed)) return [];
    const rows: Array<[string, number]> = [];
    for (const item of parsed) {
      if (!Array.isArray(item) || item.length < 2) continue;
      const sessionId = String(item[0] ?? "").trim();
      const count = Number(item[1] ?? 0);
      if (!sessionId || !Number.isFinite(count) || count <= 0) continue;
      rows.push([sessionId, Math.trunc(count)]);
    }
    return rows;
  } catch {
    return [];
  }
}
function rollupPerf(row: StoredRollupRow): PerfTotals {
  return {
    ttfbSum: Number(row.perfTtfbSum ?? 0),
    ttfbCount: Number(row.perfTtfbCount ?? 0),
    fcpSum: Number(row.perfFcpSum ?? 0),
    fcpCount: Number(row.perfFcpCount ?? 0),
    lcpSum: Number(row.perfLcpSum ?? 0),
    lcpCount: Number(row.perfLcpCount ?? 0),
    clsSum: Number(row.perfClsSum ?? 0),
    clsCount: Number(row.perfClsCount ?? 0),
    inpSum: Number(row.perfInpSum ?? 0),
    inpCount: Number(row.perfInpCount ?? 0),
  };
}
function addStoredRollup(
  accumulator: MetricAccumulator,
  row: StoredRollupRow,
): void {
  const hourStartMs = row.hourBucket * ONE_HOUR_MS;
  accumulator.views += Number(row.views ?? 0);
  accumulator.durationMsSum += Number(row.durationMsSum ?? 0);
  accumulator.durationMsCount += Number(row.durationMsCount ?? 0);
  mergePerf(accumulator.perf, rollupPerf(row));
  for (const visitorId of parseJsonStringArray(row.visitorSetJson)) {
    accumulator.visitors.add(visitorId);
  }
  for (const [sessionId, count] of parseSessionCountsJson(
    row.sessionCountsJson,
  )) {
    addSessionCount(
      accumulator.sessionCounts,
      accumulator.sessionFirstAt,
      sessionId,
      count,
      hourStartMs,
    );
  }
}
function overviewFromAccumulator(
  accumulator: MetricAccumulator,
): OverviewAggregateRow {
  let bounces = 0;
  for (const count of accumulator.sessionCounts.values()) {
    if (count === 1) bounces += 1;
  }
  return {
    views: accumulator.views,
    sessions: accumulator.sessionCounts.size,
    visitors: accumulator.visitors.size,
    bounces,
    totalDuration: accumulator.durationMsSum,
    durationViews: accumulator.durationMsCount,
  };
}
function addMetricAccumulator(
  target: MetricAccumulator,
  source: MetricAccumulator,
): void {
  target.views += source.views;
  target.durationMsSum += source.durationMsSum;
  target.durationMsCount += source.durationMsCount;
  mergePerf(target.perf, source.perf);
  for (const visitorId of source.visitors) target.visitors.add(visitorId);
  for (const [sessionId, count] of source.sessionCounts.entries()) {
    addSessionCount(
      target.sessionCounts,
      target.sessionFirstAt,
      sessionId,
      count,
      source.sessionFirstAt.get(sessionId) ?? 0,
    );
  }
}
function splitRollupWindow(
  window: QueryWindow,
  aggregatedUntilHour: number,
): {
  rollupStartHour: number;
  rollupEndExclusiveHour: number;
  prefix: QueryWindow | null;
  suffix: QueryWindow | null;
} | null {
  const firstFullHour = Math.ceil(window.startMs / ONE_HOUR_MS);
  const endExclusiveHour = Math.floor(window.endExclusiveMs / ONE_HOUR_MS);
  const aggregatedEndExclusiveHour = aggregatedUntilHour + 1;
  const rollupEndExclusiveHour = Math.min(
    endExclusiveHour,
    aggregatedEndExclusiveHour,
  );
  if (firstFullHour >= rollupEndExclusiveHour) return null;

  const rollupStartMs = firstFullHour * ONE_HOUR_MS;
  const rollupEndExclusiveMs = rollupEndExclusiveHour * ONE_HOUR_MS;
  const prefix =
    window.startMs < rollupStartMs
      ? { ...window, endExclusiveMs: rollupStartMs }
      : null;
  const suffix =
    rollupEndExclusiveMs < window.endExclusiveMs
      ? { ...window, startMs: rollupEndExclusiveMs }
      : null;
  return {
    rollupStartHour: firstFullHour,
    rollupEndExclusiveHour,
    prefix,
    suffix,
  };
}
async function queryAggregationStates(
  env: Env,
  siteIds: string[],
  diagnostics?: D1ReadDiagnostics,
): Promise<Map<string, number>> {
  if (siteIds.length === 0) return new Map();
  const states = new Map<string, number>();
  const requested = new Set(siteIds);
  for (const chunk of siteIdChunks(siteIds)) {
    const result = await env.DB.prepare(
      `
      SELECT site_id AS siteId, aggregated_until_hour AS aggregatedUntilHour
      FROM visit_hourly_aggregation_state
      WHERE site_pk IN ${sitePksFromSiteIdsSql(chunk.length)}
    `,
    )
      .bind(...chunk)
      .all<AggregationStateRow>();
    recordD1RowsRead(diagnostics, result);
    for (const row of result.results) {
      const siteId = String(row.siteId ?? "");
      const aggregatedUntilHour = Number(row.aggregatedUntilHour);
      if (!requested.has(siteId) || !Number.isFinite(aggregatedUntilHour)) {
        continue;
      }
      states.set(siteId, aggregatedUntilHour);
    }
  }
  return states;
}
function groupSitesByRollupWindow(
  siteIds: string[],
  states: Map<string, number>,
  window: QueryWindow,
): RollupWindowGroup[] {
  const groups = new Map<string, RollupWindowGroup>();
  for (const siteId of siteIds) {
    const aggregatedUntilHour = states.get(siteId);
    if (aggregatedUntilHour === undefined) continue;
    const split = splitRollupWindow(window, aggregatedUntilHour);
    if (!split) continue;
    const key = [
      split.rollupStartHour,
      split.rollupEndExclusiveHour,
      split.prefix?.startMs ?? "",
      split.prefix?.endExclusiveMs ?? "",
      split.suffix?.startMs ?? "",
      split.suffix?.endExclusiveMs ?? "",
    ].join(":");
    const existing = groups.get(key);
    if (existing) {
      existing.siteIds.push(siteId);
    } else {
      groups.set(key, { siteIds: [siteId], split });
    }
  }
  return [...groups.values()];
}
async function queryDetailAccumulatorsForSites(
  env: Env,
  siteIds: string[],
  window: QueryWindow,
  diagnostics?: D1ReadDiagnostics,
): Promise<Map<string, MetricAccumulator>> {
  if (siteIds.length === 0 || window.endExclusiveMs <= window.startMs) {
    return new Map();
  }
  const accumulators = new Map<string, MetricAccumulator>();
  for (const chunk of siteIdChunks(siteIds, 2)) {
    const result = await env.DB.prepare(
      `
      SELECT
        site_id AS siteId,
        started_at AS startedAt,
        COALESCE(visitor_id, '') AS visitorId,
        COALESCE(session_id, '') AS sessionId,
        duration_ms AS durationMs,
        perf_ttfb_ms AS perfTtfbMs,
        perf_fcp_ms AS perfFcpMs,
        perf_lcp_ms AS perfLcpMs,
        perf_cls AS perfCls,
        perf_inp_ms AS perfInpMs
      FROM visits
      WHERE site_pk IN ${sitePksFromSiteIdsSql(chunk.length)}
        AND started_at >= ? AND started_at < ?
    `,
    )
      .bind(...chunk, window.startMs, window.endExclusiveMs)
      .all<DetailVisitRow>();
    recordD1RowsRead(diagnostics, result);

    for (const row of result.results) {
      const siteId = row.siteId;
      const accumulator = accumulators.get(siteId) ?? createMetricAccumulator();
      addDetailVisit(accumulator, row);
      accumulators.set(siteId, accumulator);
    }
  }
  return accumulators;
}
async function queryStoredRollupsForSites(
  env: Env,
  siteIds: string[],
  startHour: number,
  endExclusiveHour: number,
  diagnostics?: D1ReadDiagnostics,
): Promise<StoredRollupRow[]> {
  if (siteIds.length === 0 || endExclusiveHour <= startHour) return [];
  const rollups: StoredRollupRow[] = [];
  for (const chunk of siteIdChunks(siteIds, 2)) {
    const result = await env.DB.prepare(
      `
      SELECT
        site_id AS siteId,
        hour_bucket AS hourBucket,
        views,
        sessions,
        visitors,
        bounces,
        duration_ms_sum AS durationMsSum,
        duration_ms_count AS durationMsCount,
        visitor_set_json AS visitorSetJson,
        session_counts_json AS sessionCountsJson,
        perf_ttfb_sum AS perfTtfbSum,
        perf_ttfb_count AS perfTtfbCount,
        perf_fcp_sum AS perfFcpSum,
        perf_fcp_count AS perfFcpCount,
        perf_lcp_sum AS perfLcpSum,
        perf_lcp_count AS perfLcpCount,
        perf_cls_sum AS perfClsSum,
        perf_cls_count AS perfClsCount,
        perf_inp_sum AS perfInpSum,
        perf_inp_count AS perfInpCount
      FROM visit_hourly_rollups
      WHERE site_pk IN ${sitePksFromSiteIdsSql(chunk.length)}
        AND hour_bucket >= ? AND hour_bucket < ?
      ORDER BY hour_bucket ASC
    `,
    )
      .bind(...chunk, startHour, endExclusiveHour)
      .all<StoredRollupRow>();
    recordD1RowsRead(diagnostics, result);
    rollups.push(...result.results);
  }
  return rollups.sort(
    (left, right) =>
      left.hourBucket - right.hourBucket ||
      left.siteId.localeCompare(right.siteId),
  );
}
export async function queryOverviewForSitesFromHourlyRollupsPartial(
  env: Env,
  siteIds: string[],
  window: QueryWindow,
  diagnostics?: D1ReadDiagnostics,
): Promise<Map<string, OverviewAggregateRow>> {
  if (siteIds.length === 0) return new Map();
  const states = await queryAggregationStates(env, siteIds, diagnostics);
  const result = new Map<string, OverviewAggregateRow>();
  for (const group of groupSitesByRollupWindow(siteIds, states, window)) {
    const bySite = new Map<string, MetricAccumulator>();
    const ensure = (siteId: string) => {
      const existing = bySite.get(siteId);
      if (existing) return existing;
      const next = createMetricAccumulator();
      bySite.set(siteId, next);
      return next;
    };

    for (const rollup of await queryStoredRollupsForSites(
      env,
      group.siteIds,
      group.split.rollupStartHour,
      group.split.rollupEndExclusiveHour,
      diagnostics,
    )) {
      addStoredRollup(ensure(rollup.siteId), rollup);
    }

    for (const detailWindow of [group.split.prefix, group.split.suffix]) {
      if (!detailWindow) continue;
      const detail = await queryDetailAccumulatorsForSites(
        env,
        group.siteIds,
        detailWindow,
        diagnostics,
      );
      for (const [siteId, accumulator] of detail.entries()) {
        addMetricAccumulator(ensure(siteId), accumulator);
      }
    }
    for (const siteId of group.siteIds) {
      result.set(
        siteId,
        overviewFromAccumulator(
          bySite.get(siteId) ?? createMetricAccumulator(),
        ),
      );
    }
  }
  return result;
}
export async function queryOverviewForSitesFromHourlyRollups(
  env: Env,
  siteIds: string[],
  window: QueryWindow,
  diagnostics?: D1ReadDiagnostics,
): Promise<Map<string, OverviewAggregateRow> | null> {
  const rollup = await queryOverviewForSitesFromHourlyRollupsPartial(
    env,
    siteIds,
    window,
    diagnostics,
  );
  return rollup.size === siteIds.length ? rollup : null;
}
function bucketIndexForTimestamp(
  buckets: ReturnType<typeof buildTimeBuckets>,
  timestampMs: number,
): number | null {
  let lower = 0;
  let upper = buckets.length - 1;
  while (lower <= upper) {
    const middle = lower + Math.floor((upper - lower) / 2);
    const bucket = buckets[middle];
    if (timestampMs < bucket.startMs) {
      upper = middle - 1;
    } else if (timestampMs >= bucket.endExclusiveMs) {
      lower = middle + 1;
    } else {
      return bucket.index;
    }
  }
  return null;
}
function canUseHourlyRollupsForTrend(
  buckets: ReturnType<typeof buildTimeBuckets>,
): boolean {
  return buckets.every(
    (bucket) =>
      bucket.startMs % ONE_HOUR_MS === 0 &&
      bucket.endExclusiveMs % ONE_HOUR_MS === 0,
  );
}
function ensureTrendBucket(
  trend: SiteTrendAccumulator,
  bucket: number,
  timestampMs: number,
): BucketAccumulator {
  const existing = trend.bucketAccumulators.get(bucket);
  if (existing) return existing;
  const next = createBucketAccumulator(bucket, timestampMs);
  trend.bucketAccumulators.set(bucket, next);
  return next;
}
function createSiteTrendAccumulator(): SiteTrendAccumulator {
  return {
    bucketAccumulators: new Map(),
    sessionCounts: new Map(),
    sessionFirstAt: new Map(),
  };
}
function addRollupToTrend(
  trend: SiteTrendAccumulator,
  rollup: StoredRollupRow,
  buckets: ReturnType<typeof buildTimeBuckets>,
): void {
  const hourStartMs = rollup.hourBucket * ONE_HOUR_MS;
  const bucket = bucketIndexForTimestamp(buckets, hourStartMs);
  if (bucket === null) return;
  const bucketAccumulator = ensureTrendBucket(
    trend,
    bucket,
    timeBucketTimestamp(buckets, bucket),
  );
  bucketAccumulator.views += Number(rollup.views ?? 0);
  bucketAccumulator.durationMsSum += Number(rollup.durationMsSum ?? 0);
  bucketAccumulator.durationMsCount += Number(rollup.durationMsCount ?? 0);
  mergePerf(bucketAccumulator.perf, rollupPerf(rollup));
  for (const visitorId of parseJsonStringArray(rollup.visitorSetJson)) {
    bucketAccumulator.visitors.add(visitorId);
  }
  for (const [sessionId, count] of parseSessionCountsJson(
    rollup.sessionCountsJson,
  )) {
    addSessionCount(
      trend.sessionCounts,
      trend.sessionFirstAt,
      sessionId,
      count,
      hourStartMs,
    );
  }
}
function addStoredRollupToOverviewAndTrend(
  overview: MetricAccumulator,
  trend: SiteTrendAccumulator | null,
  row: StoredRollupRow,
  buckets: ReturnType<typeof buildTimeBuckets>,
): void {
  const hourStartMs = row.hourBucket * ONE_HOUR_MS;
  const visitors = parseJsonStringArray(row.visitorSetJson);
  const sessions = parseSessionCountsJson(row.sessionCountsJson);
  const perf = rollupPerf(row);

  overview.views += Number(row.views ?? 0);
  overview.durationMsSum += Number(row.durationMsSum ?? 0);
  overview.durationMsCount += Number(row.durationMsCount ?? 0);
  mergePerf(overview.perf, perf);

  let bucketAccumulator: BucketAccumulator | null = null;
  if (trend) {
    const bucket = bucketIndexForTimestamp(buckets, hourStartMs);
    if (bucket !== null) {
      bucketAccumulator = ensureTrendBucket(
        trend,
        bucket,
        timeBucketTimestamp(buckets, bucket),
      );
      bucketAccumulator.views += Number(row.views ?? 0);
      bucketAccumulator.durationMsSum += Number(row.durationMsSum ?? 0);
      bucketAccumulator.durationMsCount += Number(row.durationMsCount ?? 0);
      mergePerf(bucketAccumulator.perf, perf);
    }
  }

  for (const visitorId of visitors) {
    overview.visitors.add(visitorId);
    bucketAccumulator?.visitors.add(visitorId);
  }
  for (const [sessionId, count] of sessions) {
    addSessionCount(
      overview.sessionCounts,
      overview.sessionFirstAt,
      sessionId,
      count,
      hourStartMs,
    );
    if (trend) {
      addSessionCount(
        trend.sessionCounts,
        trend.sessionFirstAt,
        sessionId,
        count,
        hourStartMs,
      );
    }
  }
}
function addDetailToTrend(
  trend: SiteTrendAccumulator,
  row: DetailVisitRow,
  buckets: ReturnType<typeof buildTimeBuckets>,
): void {
  const bucket = bucketIndexForTimestamp(buckets, row.startedAt);
  if (bucket === null) return;
  const bucketAccumulator = ensureTrendBucket(
    trend,
    bucket,
    timeBucketTimestamp(buckets, bucket),
  );
  bucketAccumulator.views += 1;
  const visitorId = row.visitorId.trim();
  if (visitorId) bucketAccumulator.visitors.add(visitorId);
  if (typeof row.durationMs === "number" && row.durationMs >= 0) {
    bucketAccumulator.durationMsSum += row.durationMs;
    bucketAccumulator.durationMsCount += 1;
  }
  addFiniteMetric(bucketAccumulator.perf, "ttfb", row.perfTtfbMs);
  addFiniteMetric(bucketAccumulator.perf, "fcp", row.perfFcpMs);
  addFiniteMetric(bucketAccumulator.perf, "lcp", row.perfLcpMs);
  addFiniteMetric(bucketAccumulator.perf, "cls", row.perfCls);
  addFiniteMetric(bucketAccumulator.perf, "inp", row.perfInpMs);
  addSessionCount(
    trend.sessionCounts,
    trend.sessionFirstAt,
    row.sessionId,
    1,
    row.startedAt,
  );
}
async function queryDetailVisitsForSites(
  env: Env,
  siteIds: string[],
  window: QueryWindow,
  diagnostics?: D1ReadDiagnostics,
): Promise<DetailVisitRow[]> {
  if (siteIds.length === 0 || window.endExclusiveMs <= window.startMs) {
    return [];
  }
  const visits: DetailVisitRow[] = [];
  for (const chunk of siteIdChunks(siteIds, 2)) {
    const result = await env.DB.prepare(
      `
      SELECT
        site_id AS siteId,
        started_at AS startedAt,
        COALESCE(visitor_id, '') AS visitorId,
        COALESCE(session_id, '') AS sessionId,
        duration_ms AS durationMs,
        perf_ttfb_ms AS perfTtfbMs,
        perf_fcp_ms AS perfFcpMs,
        perf_lcp_ms AS perfLcpMs,
        perf_cls AS perfCls,
        perf_inp_ms AS perfInpMs
      FROM visits
      WHERE site_pk IN ${sitePksFromSiteIdsSql(chunk.length)}
        AND started_at >= ? AND started_at < ?
      ORDER BY started_at ASC
    `,
    )
      .bind(...chunk, window.startMs, window.endExclusiveMs)
      .all<DetailVisitRow>();
    recordD1RowsRead(diagnostics, result);
    visits.push(...result.results);
  }
  return visits.sort(
    (left, right) =>
      left.startedAt - right.startedAt ||
      left.siteId.localeCompare(right.siteId),
  );
}
export interface SiteTrendRow extends TrendAggregateRow {
  siteId: string;
}
export interface HourlyRollupOverviewAndTrend {
  overview: Map<string, OverviewAggregateRow>;
  trend: Map<string, SiteTrendRow[]> | null;
}
function trendRowsFromAccumulator(
  siteId: string,
  trend: SiteTrendAccumulator,
  buckets: ReturnType<typeof buildTimeBuckets>,
): SiteTrendRow[] {
  for (const [sessionId, count] of trend.sessionCounts.entries()) {
    const firstAt = trend.sessionFirstAt.get(sessionId);
    if (firstAt === undefined) continue;
    const bucket = bucketIndexForTimestamp(buckets, firstAt);
    if (bucket === null) continue;
    const bucketAccumulator = ensureTrendBucket(
      trend,
      bucket,
      timeBucketTimestamp(buckets, bucket),
    );
    bucketAccumulator.sessionCounts.set(sessionId, count);
  }
  const rows: SiteTrendRow[] = [];
  for (const bucketAccumulator of trend.bucketAccumulators.values()) {
    let bounces = 0;
    for (const count of bucketAccumulator.sessionCounts.values()) {
      if (count === 1) bounces += 1;
    }
    rows.push({
      siteId,
      bucket: bucketAccumulator.bucket,
      timestampMs: bucketAccumulator.timestampMs,
      views: bucketAccumulator.views,
      visitors: bucketAccumulator.visitors.size,
      sessions: bucketAccumulator.sessionCounts.size,
      bounces,
      totalDuration: bucketAccumulator.durationMsSum,
      durationViews: bucketAccumulator.durationMsCount,
    });
  }
  return rows.sort((left, right) => left.bucket - right.bucket);
}
/**
 * Reads a site's hourly rollups once when a caller needs both overview and
 * trend data for the same window. The regular overview/trend helpers remain
 * available for callers that only need one representation.
 */
export async function queryOverviewAndTrendForSitesFromHourlyRollupsPartial(
  env: Env,
  siteIds: string[],
  window: QueryWindow,
  interval: Interval,
  diagnostics?: D1ReadDiagnostics,
): Promise<HourlyRollupOverviewAndTrend> {
  const overview = new Map<string, OverviewAggregateRow>();
  if (siteIds.length === 0) return { overview, trend: new Map() };

  const buckets = buildTimeBuckets(window, interval);
  const trend = canUseHourlyRollupsForTrend(buckets)
    ? new Map<string, SiteTrendRow[]>()
    : null;
  const states = await queryAggregationStates(env, siteIds, diagnostics);

  for (const group of groupSitesByRollupWindow(siteIds, states, window)) {
    const overviewBySite = new Map<string, MetricAccumulator>();
    const trendBySite = trend ? new Map<string, SiteTrendAccumulator>() : null;
    const ensureOverview = (siteId: string) => {
      const existing = overviewBySite.get(siteId);
      if (existing) return existing;
      const next = createMetricAccumulator();
      overviewBySite.set(siteId, next);
      return next;
    };
    const ensureTrend = (siteId: string) => {
      if (!trendBySite) return null;
      const existing = trendBySite.get(siteId);
      if (existing) return existing;
      const next = createSiteTrendAccumulator();
      trendBySite.set(siteId, next);
      return next;
    };

    for (const rollup of await queryStoredRollupsForSites(
      env,
      group.siteIds,
      group.split.rollupStartHour,
      group.split.rollupEndExclusiveHour,
      diagnostics,
    )) {
      const trendAccumulator = ensureTrend(rollup.siteId);
      addStoredRollupToOverviewAndTrend(
        ensureOverview(rollup.siteId),
        trendAccumulator,
        rollup,
        buckets,
      );
    }

    for (const detailWindow of [group.split.prefix, group.split.suffix]) {
      if (!detailWindow) continue;
      for (const row of await queryDetailVisitsForSites(
        env,
        group.siteIds,
        detailWindow,
        diagnostics,
      )) {
        addDetailVisit(ensureOverview(row.siteId), row);
        const trendAccumulator = ensureTrend(row.siteId);
        if (trendAccumulator) addDetailToTrend(trendAccumulator, row, buckets);
      }
    }

    for (const siteId of group.siteIds) {
      overview.set(
        siteId,
        overviewFromAccumulator(
          overviewBySite.get(siteId) ?? createMetricAccumulator(),
        ),
      );
      if (trend) {
        trend.set(
          siteId,
          trendRowsFromAccumulator(
            siteId,
            trendBySite?.get(siteId) ?? createSiteTrendAccumulator(),
            buckets,
          ),
        );
      }
    }
  }

  return { overview, trend };
}
export async function queryTrendForSitesFromHourlyRollupsPartial(
  env: Env,
  siteIds: string[],
  window: QueryWindow,
  interval: Interval,
  diagnostics?: D1ReadDiagnostics,
): Promise<Map<string, SiteTrendRow[]> | null> {
  if (siteIds.length === 0) return new Map();
  const buckets = buildTimeBuckets(window, interval);
  if (!canUseHourlyRollupsForTrend(buckets)) return null;
  const states = await queryAggregationStates(env, siteIds, diagnostics);
  const result = new Map<string, SiteTrendRow[]>();
  for (const group of groupSitesByRollupWindow(siteIds, states, window)) {
    const bySite = new Map<string, SiteTrendAccumulator>();
    const ensure = (siteId: string) => {
      const existing = bySite.get(siteId);
      if (existing) return existing;
      const next = createSiteTrendAccumulator();
      bySite.set(siteId, next);
      return next;
    };

    for (const rollup of await queryStoredRollupsForSites(
      env,
      group.siteIds,
      group.split.rollupStartHour,
      group.split.rollupEndExclusiveHour,
      diagnostics,
    )) {
      addRollupToTrend(ensure(rollup.siteId), rollup, buckets);
    }

    for (const detailWindow of [group.split.prefix, group.split.suffix]) {
      if (!detailWindow) continue;
      for (const row of await queryDetailVisitsForSites(
        env,
        group.siteIds,
        detailWindow,
        diagnostics,
      )) {
        addDetailToTrend(ensure(row.siteId), row, buckets);
      }
    }

    for (const siteId of group.siteIds) {
      result.set(
        siteId,
        trendRowsFromAccumulator(
          siteId,
          bySite.get(siteId) ?? createSiteTrendAccumulator(),
          buckets,
        ),
      );
    }
  }
  return result;
}
export async function queryTrendForSitesFromHourlyRollups(
  env: Env,
  siteIds: string[],
  window: QueryWindow,
  interval: Interval,
  diagnostics?: D1ReadDiagnostics,
): Promise<SiteTrendRow[] | null> {
  const rollup = await queryTrendForSitesFromHourlyRollupsPartial(
    env,
    siteIds,
    window,
    interval,
    diagnostics,
  );
  if (!rollup || rollup.size !== siteIds.length) return null;
  return [...rollup.values()]
    .flat()
    .sort(
      (left, right) =>
        left.bucket - right.bucket || left.siteId.localeCompare(right.siteId),
    );
}
