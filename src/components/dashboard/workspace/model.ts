import { getSiteSlug } from "@/components/dashboard/admin/team-management/model";
import type {
  TeamDashboardData,
  TeamDashboardSite,
  TeamDashboardTrendBucket,
  TeamTrafficPoint,
} from "@/lib/dashboard/team-dashboard-query";
import {
  buildTeamSiteTrends,
  type TeamDashboardWindow,
} from "@/lib/dashboard/team-dashboard-query";
import type { SiteData, TeamData } from "@/lib/dashboard-api/client/edge";

/** Visitor change (in percent) that counts as a notable movement. */
export const NOTABLE_CHANGE_PERCENT = 30;

export interface WorkspaceSiteRow {
  site: SiteData;
  metricsStatus?: "pending" | "unavailable";
  team: TeamData;
  slug: string;
  visitors: number;
  views: number;
  sessions: number;
  bounceRate: number;
  visitorsChange: number | null;
  viewsChange: number | null;
  trend: TeamTrafficPoint[];
}

export interface WorkspaceTotals {
  visitors: number;
  views: number;
  sessions: number;
  avgDurationMs: number;
  /** Percent change against the previous period, or null when unknown. */
  change: Record<
    "visitors" | "views" | "sessions" | "avgDurationMs",
    number | null
  >;
}

function percentChange(current: number, previous: number | null) {
  if (previous === null || previous <= 0) return null;
  return ((current - previous) / previous) * 100;
}

export function buildWorkspaceRows(
  teams: readonly TeamData[],
  dataByTeam: ReadonlyMap<string, TeamDashboardData>,
  trendBySite: Readonly<Record<string, TeamTrafficPoint[]>>,
): WorkspaceSiteRow[] {
  return teams.flatMap((team) =>
    (dataByTeam.get(team.id)?.sites ?? []).map((site) => ({
      site,
      team,
      slug: getSiteSlug(site),
      visitors: site.overview?.visitors ?? 0,
      views: site.overview?.views ?? 0,
      sessions: site.overview?.sessions ?? 0,
      bounceRate: site.overview?.bounceRate ?? 0,
      visitorsChange: site.changeRates?.visitors ?? null,
      viewsChange: site.changeRates?.views ?? null,
      trend: trendBySite[site.id] ?? [],
    })),
  );
}

/** Sum actual per-site metrics for both periods, never invert rounded rates. */
export function buildWorkspaceTotals(
  sites: readonly TeamDashboardSite[],
): WorkspaceTotals {
  const sum = { visitors: 0, views: 0, sessions: 0, durationMs: 0 };
  const previous = { visitors: 0, views: 0, sessions: 0, durationMs: 0 };
  let previousComplete = true;
  for (const site of sites) {
    const overview = site.overview;
    if (!overview) continue;
    sum.visitors += overview.visitors;
    sum.views += overview.views;
    sum.sessions += overview.sessions;
    sum.durationMs += overview.totalDurationMs;
    const before = site.previousOverview;
    if (!before) {
      previousComplete = false;
      continue;
    }
    previous.visitors += before.visitors;
    previous.views += before.views;
    previous.sessions += before.sessions;
    previous.durationMs += before.totalDurationMs;
  }
  const avgDurationMs = sum.sessions > 0 ? sum.durationMs / sum.sessions : 0;
  const previousAvg =
    previousComplete && previous.sessions > 0
      ? previous.durationMs / previous.sessions
      : null;
  return {
    visitors: sum.visitors,
    views: sum.views,
    sessions: sum.sessions,
    avgDurationMs,
    change: {
      visitors: percentChange(
        sum.visitors,
        previousComplete ? previous.visitors : null,
      ),
      views: percentChange(sum.views, previousComplete ? previous.views : null),
      sessions: percentChange(
        sum.sessions,
        previousComplete ? previous.sessions : null,
      ),
      avgDurationMs: percentChange(avgDurationMs, previousAvg),
    },
  };
}

export function mergeTeamTrends(
  data: readonly TeamDashboardData[],
): TeamDashboardTrendBucket[] {
  return data.flatMap((item) => item.trend);
}

export type WorkspaceSort = "visitors" | "views" | "bounceRate" | "change";

export type WorkspaceSortDirection = "asc" | "desc";

export function sortRows(
  rows: readonly WorkspaceSiteRow[],
  sort: WorkspaceSort,
  direction: WorkspaceSortDirection = "desc",
) {
  const value = (row: WorkspaceSiteRow) =>
    sort === "change" ? row.visitorsChange : row[sort];
  return [...rows].sort((left, right) => {
    if (Boolean(left.metricsStatus) !== Boolean(right.metricsStatus))
      return left.metricsStatus ? 1 : -1;
    const a = value(left);
    const b = value(right);
    if (a === null && b !== null) return 1;
    if (b === null && a !== null) return -1;
    return (
      (a !== null && b !== null ? (direction === "asc" ? a - b : b - a) : 0) ||
      left.site.name.localeCompare(right.site.name)
    );
  });
}

/** Only the data, not transient fetch/error state, drives expensive chart work. */
export function combineWorkspaceQueries(
  results: readonly {
    data?: { data: TeamDashboardData };
    isPending: boolean;
    isFetching: boolean;
    isError: boolean;
  }[],
) {
  return {
    data: results.map((result) => result.data?.data),
    loading: results.some((result) => result.isPending),
    fetching: results.some((result) => result.isFetching),
    failed: results.map((result) => result.isError),
  };
}

export function deriveWorkspaceData(
  teams: readonly TeamData[],
  data: readonly (TeamDashboardData | undefined)[],
  window: TeamDashboardWindow,
  inventory: Readonly<Record<string, readonly SiteData[] | null>> = {},
  failed: readonly boolean[] = [],
) {
  const dataByTeam = new Map<string, TeamDashboardData>();
  teams.forEach((team, index) => {
    const item = data[index];
    if (item) dataByTeam.set(team.id, item);
  });
  const allData = [...dataByTeam.values()];
  const sites = allData.flatMap((item) => item.sites);
  const trendBySite = buildTeamSiteTrends(
    sites.map((site) => site.id),
    mergeTeamTrends(allData),
    window,
  );
  const rows = buildWorkspaceRows(teams, dataByTeam, trendBySite);
  teams.forEach((team, index) => {
    if (dataByTeam.has(team.id)) return;
    for (const site of inventory[team.id] ?? []) {
      rows.push({
        site,
        team,
        slug: getSiteSlug(site),
        metricsStatus: failed[index] ? "unavailable" : "pending",
        visitors: 0,
        views: 0,
        sessions: 0,
        bounceRate: 0,
        visitorsChange: null,
        viewsChange: null,
        trend: [],
      });
    }
  });
  // For an unbounded time range the actual start is not yet known.
  const initialBuckets =
    !sites.length && rows.length && window.from > 0
      ? (
          buildTeamSiteTrends([rows[0]!.site.id], [], window)[
            rows[0]!.site.id
          ] ?? []
        ).map((point) => point.timestampMs)
      : [];
  return {
    rows,
    siteCount: rows.length,
    totals: buildWorkspaceTotals(sites),
    bucketStarts: sites.length
      ? (trendBySite[sites[0]?.id ?? ""] ?? []).map(
          (point) => point.timestampMs,
        )
      : initialBuckets,
    rowsById: new Map(rows.map((row) => [row.site.id, row])),
    changePoints: rows.flatMap((row) =>
      row.visitorsChange === null
        ? []
        : [
            {
              id: row.site.id,
              label: row.site.name,
              value: row.visitors,
              change: row.visitorsChange,
              weight: row.views,
            },
          ],
    ),
  };
}
