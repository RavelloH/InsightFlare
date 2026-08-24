import "@tanstack/react-start/server-only";

import {
  buildCalendarBucketPlan,
  type ComparisonBreakdownQuery,
  type ComparisonProvider,
  type ComparisonQuery,
  type ComparisonRawBreakdownResult,
  type ComparisonRawMetrics,
  type ComparisonRawTrendResult,
  type ComparisonTrendQuery,
  type FilterDocument,
  type QuerySource,
  type QueryTime,
} from "@/lib/edge/analytics/contract";
import type { QueryWindow } from "@/lib/edge/analytics/providers/d1/internal/core";
import { queryEventSummaryMetricsFromD1 } from "@/lib/edge/analytics/providers/d1/internal/events-summary";
import { queryEventsTrendFromD1 } from "@/lib/edge/analytics/providers/d1/internal/events-trend";
import { listTeamSites } from "@/lib/edge/analytics/providers/d1/internal/team";
import { createOverviewReader } from "@/lib/edge/analytics/providers/d1/operations/overview-reader";
import { readSiteBreakdown } from "@/lib/edge/analytics/providers/d1/operations/site-breakdown";
import type { Env } from "@/lib/edge/types";

export interface ComparisonProviderOptions {
  readonly env: Env;
  readonly siteId?: string;
  readonly teamId?: string;
  readonly allowedSiteIds?: readonly string[];
}

const EMPTY_FILTER: FilterDocument = { version: 1, root: null };

function filtersOf(time: QueryTime, filters: FilterDocument | undefined) {
  return { time, filters: filters ?? EMPTY_FILTER };
}

function windowOf(time: QueryTime): QueryWindow {
  return {
    startMs: time.range.startMs,
    endExclusiveMs: time.range.endExclusiveMs,
    nowMs: time.capturedAtMs,
    timeZone: time.reportingTimeZone,
  };
}

function sourceOf(values: readonly QuerySource[]): QuerySource {
  if (values.length === 0) return "raw";
  return values.every((value) => value === values[0]) ? values[0]! : "mixed";
}

function emptyMetrics(): ComparisonRawMetrics {
  return {
    views: 0,
    sessions: 0,
    visitors: 0,
    bounces: 0,
    totalDurationMs: 0,
    durationViews: 0,
    events: 0,
  };
}

function siteIdsForTeam(options: ComparisonProviderOptions) {
  return listTeamSites(options.env, options.teamId!).then((sites) => {
    const allowed = options.allowedSiteIds
      ? new Set(options.allowedSiteIds)
      : null;
    return sites.filter((site) => !allowed || allowed.has(site.id));
  });
}

async function readSiteMetrics(
  options: ComparisonProviderOptions,
  time: QueryTime,
  filters: FilterDocument,
) {
  const reader = createOverviewReader(options.env, options.siteId!);
  const [overview, events] = await Promise.all([
    reader.readOverview(filtersOf(time, filters)),
    queryEventSummaryMetricsFromD1(
      options.env,
      options.siteId!,
      windowOf(time),
      filters,
    ),
  ]);
  return {
    data: { ...overview.value, events: events.events },
    source: overview.source ?? "raw",
    approximateVisitors: Boolean(overview.approximateVisitors),
  };
}

async function readTeamMetrics(
  options: ComparisonProviderOptions,
  time: QueryTime,
  filters: FilterDocument,
) {
  const sites = await siteIdsForTeam(options);
  const results = await Promise.all(
    sites.map((site) =>
      Promise.all([
        createOverviewReader(options.env, site.id).readOverview(
          filtersOf(time, filters),
        ),
        queryEventSummaryMetricsFromD1(
          options.env,
          site.id,
          windowOf(time),
          filters,
        ),
      ]),
    ),
  );
  const data = results.reduce<ComparisonRawMetrics>(
    (total, [overview, events]) => ({
      views: total.views + overview.value.views,
      sessions: total.sessions + overview.value.sessions,
      visitors: total.visitors + overview.value.visitors,
      bounces: total.bounces + overview.value.bounces,
      totalDurationMs: total.totalDurationMs + overview.value.totalDurationMs,
      durationViews: total.durationViews + overview.value.durationViews,
      events: total.events + events.events,
    }),
    emptyMetrics(),
  );
  return {
    data,
    source: sourceOf(results.map(([overview]) => overview.source ?? "raw")),
    approximateVisitors: results.some(
      ([overview]) => overview.approximateVisitors,
    ),
  };
}

function completePoints(
  time: QueryTime,
  interval: ComparisonTrendQuery["interval"],
  points: readonly {
    readonly bucket: number;
    readonly timestampMs: number;
    readonly views: number;
    readonly sessions: number;
    readonly visitors: number;
    readonly bounces: number;
    readonly totalDurationMs: number;
    readonly durationViews: number;
    readonly events?: number;
  }[],
  eventsByBucket: ReadonlyMap<number, number>,
): ComparisonRawTrendResult {
  const plan = buildCalendarBucketPlan({
    range: time.range,
    granularity: interval,
    reportingTimeZone: time.reportingTimeZone,
  });
  const byBucket = new Map(points.map((point) => [point.bucket, point]));
  return {
    interval,
    points: plan.buckets.map((bucket) => {
      const point = byBucket.get(bucket.index);
      return {
        bucket: bucket.index,
        timestampMs: bucket.startMs,
        fromMs: bucket.startMs,
        toMs: bucket.endExclusiveMs,
        views: point?.views ?? 0,
        sessions: point?.sessions ?? 0,
        visitors: point?.visitors ?? 0,
        bounces: point?.bounces ?? 0,
        totalDurationMs: point?.totalDurationMs ?? 0,
        durationViews: point?.durationViews ?? 0,
        events: eventsByBucket.get(bucket.index) ?? point?.events ?? 0,
      };
    }),
  };
}

async function readSiteTrend(
  options: ComparisonProviderOptions,
  time: QueryTime,
  filters: FilterDocument,
  interval: ComparisonTrendQuery["interval"],
) {
  const reader = createOverviewReader(options.env, options.siteId!);
  const window = windowOf(time);
  const [trend, events] = await Promise.all([
    reader.readTrend({ ...filtersOf(time, filters), interval }),
    queryEventsTrendFromD1(
      options.env,
      options.siteId!,
      window,
      interval,
      filters,
      1,
    ),
  ]);
  return {
    data: completePoints(
      time,
      interval,
      trend.value,
      new Map(events.data.map((point) => [point.bucket, point.totalEvents])),
    ),
    source: trend.source ?? "raw",
    approximateVisitors: Boolean(trend.approximateVisitors),
  };
}

async function readTeamTrend(
  options: ComparisonProviderOptions,
  time: QueryTime,
  filters: FilterDocument,
  interval: ComparisonTrendQuery["interval"],
) {
  const sites = await siteIdsForTeam(options);
  const results = await Promise.all(
    sites.map(async (site) => {
      const reader = createOverviewReader(options.env, site.id);
      const window = windowOf(time);
      const [trend, events] = await Promise.all([
        reader.readTrend({ ...filtersOf(time, filters), interval }),
        queryEventsTrendFromD1(
          options.env,
          site.id,
          window,
          interval,
          filters,
          1,
        ),
      ]);
      return { trend, events };
    }),
  );
  const totals = new Map<
    number,
    {
      bucket: number;
      timestampMs: number;
      views: number;
      sessions: number;
      visitors: number;
      bounces: number;
      totalDurationMs: number;
      durationViews: number;
      events: number;
    }
  >();
  for (const { trend, events } of results) {
    for (const point of trend.value) {
      const current = totals.get(point.bucket) ?? {
        bucket: point.bucket,
        timestampMs: point.timestampMs,
        views: 0,
        sessions: 0,
        visitors: 0,
        bounces: 0,
        totalDurationMs: 0,
        durationViews: 0,
        events: 0,
      };
      current.views += point.views;
      current.sessions += point.sessions;
      current.visitors += point.visitors;
      current.bounces += point.bounces;
      current.totalDurationMs += point.totalDurationMs;
      current.durationViews += point.durationViews;
      totals.set(point.bucket, current);
    }
    for (const point of events.data) {
      const current = totals.get(point.bucket);
      if (current) current.events += point.totalEvents;
      else {
        totals.set(point.bucket, {
          bucket: point.bucket,
          timestampMs: point.timestampMs,
          views: 0,
          sessions: 0,
          visitors: 0,
          bounces: 0,
          totalDurationMs: 0,
          durationViews: 0,
          events: point.totalEvents,
        });
      }
    }
  }
  return {
    data: completePoints(time, interval, [...totals.values()], new Map()),
    source: sourceOf(results.map(({ trend }) => trend.source ?? "raw")),
    approximateVisitors: results.some(({ trend }) => trend.approximateVisitors),
  };
}

function rawBreakdownItem(item: {
  readonly key: string;
  readonly label: string;
  readonly views: number;
  readonly sessions: number;
  readonly visitors: number;
}) {
  return {
    key: item.key,
    label: item.label,
    views: item.views,
    sessions: item.sessions,
    visitors: item.visitors,
    bounces: 0,
    totalDurationMs: 0,
    durationViews: 0,
    events: 0,
  };
}

async function readBreakdownForSites(
  options: ComparisonProviderOptions,
  time: QueryTime,
  filters: FilterDocument,
  dimension: string,
): Promise<ComparisonRawBreakdownResult> {
  const sites = options.siteId
    ? [{ id: options.siteId }]
    : await siteIdsForTeam(options);
  const results = await Promise.all(
    sites.map((site) =>
      readSiteBreakdown({
        env: options.env,
        siteId: site.id,
        dimension,
        limit: 0,
        window: windowOf(time),
        filters,
      }),
    ),
  );
  const merged = new Map<string, ReturnType<typeof rawBreakdownItem>>();
  for (const result of results) {
    for (const item of result.items) {
      const previous = merged.get(item.key);
      if (!previous) merged.set(item.key, rawBreakdownItem(item));
      else {
        merged.set(item.key, {
          ...previous,
          views: previous.views + item.views,
          sessions: previous.sessions + item.sessions,
          visitors: previous.visitors + item.visitors,
        });
      }
    }
  }
  return { items: [...merged.values()], complete: true };
}

function providerMeta(
  time: QueryTime,
  source: QuerySource,
  approximateVisitors: boolean,
) {
  return { time, source, approximateVisitors };
}

export function createComparisonProviders(options: ComparisonProviderOptions) {
  const overview: ComparisonProvider<
    ComparisonRawMetrics,
    ComparisonQuery
  > = async ({ query }) => {
    const result = options.siteId
      ? await readSiteMetrics(
          options,
          query.time,
          query.filters ?? EMPTY_FILTER,
        )
      : await readTeamMetrics(
          options,
          query.time,
          query.filters ?? EMPTY_FILTER,
        );
    return {
      ok: true,
      data: result.data,
      meta: providerMeta(query.time, result.source, result.approximateVisitors),
    };
  };
  const trend: ComparisonProvider<
    ComparisonRawTrendResult,
    ComparisonTrendQuery
  > = async ({ query, comparison }) => {
    const result = options.siteId
      ? await readSiteTrend(
          options,
          query.time,
          query.filters ?? EMPTY_FILTER,
          comparison.interval,
        )
      : await readTeamTrend(
          options,
          query.time,
          query.filters ?? EMPTY_FILTER,
          comparison.interval,
        );
    return {
      ok: true,
      data: result.data,
      meta: providerMeta(query.time, result.source, result.approximateVisitors),
    };
  };
  const breakdown: ComparisonProvider<
    ComparisonRawBreakdownResult,
    ComparisonBreakdownQuery
  > = async ({ query, comparison }) => ({
    ok: true,
    data: await readBreakdownForSites(
      options,
      query.time,
      query.filters ?? EMPTY_FILTER,
      comparison.dimension,
    ),
    meta: providerMeta(query.time, "raw", false),
  });
  return { overview, trend, breakdown };
}
