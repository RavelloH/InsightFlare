import { getSiteSlug } from "@/components/dashboard/admin/team-management/model";
import type {
  TeamDashboardData,
  TeamDashboardSite,
  TeamDashboardTrendBucket,
  TeamTrafficPoint,
} from "@/lib/dashboard/team-dashboard-query";
import type { TeamData } from "@/lib/dashboard-api/client/edge";

/** Visitor change (in percent) that counts as a notable movement. */
export const NOTABLE_CHANGE_PERCENT = 30;

export interface WorkspaceSiteRow {
  site: TeamDashboardSite;
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

/** Previous-period value implied by a current value and its percent change. */
function previousValue(current: number, changePercent: number | null) {
  if (changePercent === null || !Number.isFinite(changePercent)) return null;
  const factor = 1 + changePercent / 100;
  return factor > 0 ? current / factor : null;
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

/**
 * Sums every site. Previous totals are rebuilt from each site's change rate;
 * when any site with traffic lacks one the total change is left unknown.
 */
export function buildWorkspaceTotals(
  sites: readonly TeamDashboardSite[],
): WorkspaceTotals {
  const sum = { visitors: 0, views: 0, sessions: 0, durationMs: 0 };
  const previous: Record<"visitors" | "views" | "sessions", number | null> = {
    visitors: 0,
    views: 0,
    sessions: 0,
  };
  let previousDurationMs: number | null = 0;
  for (const site of sites) {
    const overview = site.overview;
    if (!overview) continue;
    sum.visitors += overview.visitors;
    sum.views += overview.views;
    sum.sessions += overview.sessions;
    sum.durationMs += overview.totalDurationMs;
    for (const key of ["visitors", "views", "sessions"] as const) {
      const before = previousValue(
        overview[key],
        site.changeRates?.[key] ?? null,
      );
      const known = previous[key];
      previous[key] =
        known === null || (before === null && overview[key] > 0)
          ? null
          : known + (before ?? 0);
    }
    const sessionsBefore = previousValue(
      overview.sessions,
      site.changeRates?.sessions ?? null,
    );
    const avgBefore = previousValue(
      overview.avgDurationMs,
      site.changeRates?.avgDurationMs ?? null,
    );
    previousDurationMs =
      previousDurationMs === null ||
      ((sessionsBefore === null || avgBefore === null) && overview.sessions > 0)
        ? null
        : previousDurationMs + (sessionsBefore ?? 0) * (avgBefore ?? 0);
  }
  const avgDurationMs = sum.sessions > 0 ? sum.durationMs / sum.sessions : 0;
  const previousAvg =
    previousDurationMs !== null && previous.sessions
      ? previousDurationMs / previous.sessions
      : null;
  return {
    visitors: sum.visitors,
    views: sum.views,
    sessions: sum.sessions,
    avgDurationMs,
    change: {
      visitors: percentChange(sum.visitors, previous.visitors),
      views: percentChange(sum.views, previous.views),
      sessions: percentChange(sum.sessions, previous.sessions),
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

export function sortRows(
  rows: readonly WorkspaceSiteRow[],
  sort: WorkspaceSort,
) {
  const value = (row: WorkspaceSiteRow) =>
    sort === "change" ? (row.visitorsChange ?? -Infinity) : row[sort];
  return [...rows].sort(
    (left, right) =>
      value(right) - value(left) ||
      left.site.name.localeCompare(right.site.name),
  );
}
