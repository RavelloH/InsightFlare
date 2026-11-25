import { keepPreviousData, queryOptions } from "@tanstack/react-query";

import {
  addZonedInterval,
  startOfZonedInterval,
} from "@/lib/analytics/time-zone";
import type { SiteData } from "@/lib/dashboard-api/client/edge";

import type { RangePreset, TimeWindow } from "./query-state";
export interface TeamDashboardOverview {
  views: number;
  sessions: number;
  visitors: number;
  bounces: number;
  totalDurationMs: number;
  avgDurationMs: number;
  bounceRate: number;
  approximateVisitors: boolean;
}
export interface TeamDashboardSite extends SiteData {
  overview: TeamDashboardOverview;
  /** Optional for compatibility with snapshots from older server versions. */
  previousOverview?: TeamDashboardOverview;
  changeRates: Record<
    | "views"
    | "visitors"
    | "sessions"
    | "bounceRate"
    | "avgDurationMs"
    | "pagesPerSession",
    number | null
  >;
}
export interface TeamDashboardTrendBucket {
  bucket: number;
  timestampMs: number;
  sites: readonly {
    readonly siteId: string;
    readonly views: number;
    readonly visitors: number;
  }[];
}
export interface TeamDashboardData {
  sites: readonly TeamDashboardSite[];
  trend: readonly TeamDashboardTrendBucket[];
}
export type TeamDashboardWindow = Pick<
  TimeWindow,
  "from" | "to" | "interval" | "timeZone"
>;
export interface TeamDashboardSnapshot {
  data: TeamDashboardData;
  window: TeamDashboardWindow;
  range: RangePreset;
  fetchedAt: number;
}
export interface TeamTrafficPoint {
  timestampMs: number;
  views: number;
  visitors: number;
}
export interface TeamAggregateTrendPoint {
  timestampMs: number;
  sites: Array<{ siteId: string; views: number; visitors: number }>;
}
function intervalStepMs(interval: TeamDashboardWindow["interval"]): number {
  if (interval === "minute") return 60_000;
  if (interval === "hour") return 60 * 60_000;
  if (interval === "day") return 24 * 60 * 60_000;
  if (interval === "week") return 7 * 24 * 60 * 60_000;
  return 30 * 24 * 60 * 60_000;
}
function safeCount(value: number): number {
  return Number.isFinite(value) ? Math.max(0, value) : 0;
}
function bucketStarts(
  window: TeamDashboardWindow,
  firstDataTimestamp?: number,
): number[] {
  const starts: number[] = [];
  const end = startOfZonedInterval(window.to, window.interval, window.timeZone);
  let current = startOfZonedInterval(
    window.from > 0 ? window.from : (firstDataTimestamp ?? window.from),
    window.interval,
    window.timeZone,
  );
  const hardLimit = 2000;

  for (let index = 0; index < hardLimit && current <= end; index += 1) {
    starts.push(current);
    let next = addZonedInterval(current, window.interval, window.timeZone);
    if (!Number.isFinite(next) || next <= current) {
      next = current + intervalStepMs(window.interval);
    }
    current = next;
  }
  return starts;
}
export function teamDashboardQueryKey(
  teamId: string,
  window: TeamDashboardWindow,
) {
  return [
    "dashboard",
    "team-dashboard",
    teamId,
    window.from,
    window.to,
    window.interval,
    window.timeZone,
  ] as const;
}
export function sameTeamDashboardWindow(
  left: TeamDashboardWindow,
  right: TeamDashboardWindow,
): boolean {
  return (
    left.from === right.from &&
    left.to === right.to &&
    left.interval === right.interval &&
    left.timeZone === right.timeZone
  );
}
export async function fetchTeamDashboard(
  teamId: string,
  window: TeamDashboardWindow,
  signal?: AbortSignal,
): Promise<TeamDashboardData> {
  const params = new URLSearchParams({
    teamId,
    from: String(window.from),
    to: String(window.to),
    interval: window.interval,
    timeZone: window.timeZone,
  });
  const response = await fetch(`/api/private/team-dashboard?${params}`, {
    method: "GET",
    credentials: "include",
    signal,
  });
  if (!response.ok) throw new Error("fetch_team_dashboard_failed");
  const payload = (await response.json()) as {
    ok: boolean;
    data?: Partial<TeamDashboardData>;
  };
  if (!payload.ok || !payload.data)
    throw new Error("fetch_team_dashboard_failed");
  return {
    sites: Array.isArray(payload.data.sites) ? payload.data.sites : [],
    trend: Array.isArray(payload.data.trend) ? payload.data.trend : [],
  };
}
export function teamDashboardQueryOptions(input: {
  teamId: string;
  window: TeamDashboardWindow;
  range?: RangePreset;
  snapshot?: TeamDashboardSnapshot | null;
  readDeferredSnapshot?: () =>
    Promise<TeamDashboardSnapshot | null> | undefined;
  enabled?: boolean;
  retainInFlight?: boolean;
}) {
  const initialSnapshot =
    input.snapshot &&
    sameTeamDashboardWindow(input.snapshot.window, input.window)
      ? input.snapshot
      : null;
  return queryOptions({
    queryKey: teamDashboardQueryKey(input.teamId, input.window),
    queryFn: async (context) => {
      const deferred = input.readDeferredSnapshot?.();
      if (deferred) {
        const snapshot = await deferred.catch(() => null);
        if (
          snapshot &&
          sameTeamDashboardWindow(snapshot.window, input.window)
        ) {
          return snapshot;
        }
      }
      // Route prefetch should survive transient observer detach/reattach
      // during navigation. Do not consume the query abort signal while
      // joining an already-running server snapshot, either.
      const signal = input.retainInFlight ? undefined : context.signal;
      return {
        data: await fetchTeamDashboard(input.teamId, input.window, signal),
        window: input.window,
        range: input.range ?? "30d",
        fetchedAt: Date.now(),
      };
    },
    enabled: input.enabled ?? Boolean(input.teamId),
    initialData: initialSnapshot ?? undefined,
    initialDataUpdatedAt: initialSnapshot?.fetchedAt,
    placeholderData: keepPreviousData,
  });
}
export function buildTeamAggregateTrend(
  trend: readonly TeamDashboardTrendBucket[],
  window: TeamDashboardWindow,
): TeamAggregateTrendPoint[] {
  const firstDataTimestamp = trend.reduce<number | undefined>(
    (earliest, point) =>
      earliest === undefined
        ? point.timestampMs
        : Math.min(earliest, point.timestampMs),
    undefined,
  );
  const timeline = new Map<
    number,
    {
      timestampMs: number;
      sites: Map<string, { views: number; visitors: number }>;
    }
  >(
    bucketStarts(window, firstDataTimestamp).map((timestampMs) => [
      timestampMs,
      { timestampMs, sites: new Map() },
    ]),
  );

  for (const point of trend) {
    const bucket = startOfZonedInterval(
      point.timestampMs,
      window.interval,
      window.timeZone,
    );
    const target = timeline.get(bucket) ?? {
      timestampMs: bucket,
      sites: new Map(),
    };
    for (const sitePoint of point.sites) {
      const previous = target.sites.get(sitePoint.siteId) ?? {
        views: 0,
        visitors: 0,
      };
      target.sites.set(sitePoint.siteId, {
        views: previous.views + safeCount(sitePoint.views),
        visitors: previous.visitors + safeCount(sitePoint.visitors),
      });
    }
    timeline.set(bucket, target);
  }

  return [...timeline.values()]
    .sort((left, right) => left.timestampMs - right.timestampMs)
    .map((point) => ({
      timestampMs: point.timestampMs,
      sites: [...point.sites].map(([siteId, value]) => ({ siteId, ...value })),
    }));
}
export function buildTeamSiteTrends(
  siteIds: readonly string[],
  trend: readonly TeamDashboardTrendBucket[],
  window: TeamDashboardWindow,
): Record<string, TeamTrafficPoint[]> {
  const firstDataTimestamp = trend.reduce<number | undefined>(
    (earliest, point) =>
      earliest === undefined
        ? point.timestampMs
        : Math.min(earliest, point.timestampMs),
    undefined,
  );
  const starts = bucketStarts(window, firstDataTimestamp);
  const bySite = new Map<string, Map<number, TeamTrafficPoint>>();
  for (const siteId of siteIds) {
    bySite.set(
      siteId,
      new Map(
        starts.map((timestampMs) => [
          timestampMs,
          { timestampMs, views: 0, visitors: 0 },
        ]),
      ),
    );
  }

  for (const point of trend) {
    const bucket = startOfZonedInterval(
      point.timestampMs,
      window.interval,
      window.timeZone,
    );
    for (const sitePoint of point.sites) {
      const site = bySite.get(sitePoint.siteId);
      if (!site) continue;
      const current = site.get(bucket) ?? {
        timestampMs: bucket,
        views: 0,
        visitors: 0,
      };
      current.views += safeCount(sitePoint.views);
      current.visitors += safeCount(sitePoint.visitors);
      site.set(bucket, current);
    }
  }

  return Object.fromEntries(
    [...bySite].map(([siteId, points]) => [
      siteId,
      [...points.values()].sort(
        (left, right) => left.timestampMs - right.timestampMs,
      ),
    ]),
  );
}

// Compact sidebar charts have no axes or tooltip for individual buckets.
// With no positive counts their rendered paths are empty regardless of range.
const EMPTY_SIDEBAR_TRENDS: Record<string, TeamTrafficPoint[]> = {};
export function buildSidebarSiteTrends(
  siteIds: readonly string[],
  trend: readonly TeamDashboardTrendBucket[] | undefined,
  window: TeamDashboardWindow,
  visible: boolean,
): Record<string, TeamTrafficPoint[]> {
  if (!visible || !trend?.length || siteIds.length === 0)
    return EMPTY_SIDEBAR_TRENDS;
  const activeIds = new Set<string>();
  for (const bucket of trend) {
    for (const point of bucket.sites) {
      if (safeCount(point.views) > 0 || safeCount(point.visitors) > 0)
        activeIds.add(point.siteId);
    }
  }
  const chartSiteIds = siteIds.filter((id) => activeIds.has(id));
  if (chartSiteIds.length === 0) return EMPTY_SIDEBAR_TRENDS;
  return buildTeamSiteTrends(chartSiteIds, trend, window);
}
