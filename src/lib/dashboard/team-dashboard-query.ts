import { keepPreviousData, queryOptions } from "@tanstack/react-query";

import type { SiteData } from "@/lib/edge-client";

import type { RangePreset, TimeWindow } from "./query-state";
import { addZonedInterval, startOfZonedInterval } from "./time-zone";

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

function bucketStarts(window: TeamDashboardWindow): number[] {
  const starts: number[] = [];
  const end = startOfZonedInterval(window.to, window.interval, window.timeZone);
  let current = startOfZonedInterval(
    window.from,
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
  if (import.meta.env.VITE_DEMO_MODE === "1") {
    const { demoRequest } = await import("@/lib/realtime/mock");
    const result = demoRequest({
      path: "/api/private/team-dashboard",
      params: { teamId, ...window },
    }) as { ok: boolean; data?: Partial<TeamDashboardData> };
    return {
      sites: Array.isArray(result.data?.sites) ? result.data.sites : [],
      trend: Array.isArray(result.data?.trend) ? result.data.trend : [],
    };
  }

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
  enabled?: boolean;
}) {
  const initialSnapshot =
    input.snapshot &&
    sameTeamDashboardWindow(input.snapshot.window, input.window)
      ? input.snapshot
      : null;
  return queryOptions({
    queryKey: teamDashboardQueryKey(input.teamId, input.window),
    queryFn: async ({ signal }) => ({
      data: await fetchTeamDashboard(input.teamId, input.window, signal),
      window: input.window,
      range: input.range ?? "30d",
      fetchedAt: Date.now(),
    }),
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
  const timeline = new Map<
    number,
    {
      timestampMs: number;
      sites: Map<string, { views: number; visitors: number }>;
    }
  >(
    bucketStarts(window).map((timestampMs) => [
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
  const starts = bucketStarts(window);
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
