import {
  and,
  compileD1Query,
  createD1DatabaseClient,
  eq,
  filter,
  gt,
  inList,
  limit as limitPlan,
  lt,
  or,
  param,
  project,
  scan,
  schema,
  sort,
} from "@/lib/db";
import type { TeamDashboardData } from "@/lib/edge/analytics/contract";
import {
  EMPTY_FILTER_DOCUMENT,
  type FilterDocument,
  scopedFilterMetadata,
} from "@/lib/edge/analytics/contract";
import { queryWindowToTime } from "@/lib/edge/analytics/contract/helpers";
import {
  buildTeamRawDashboardReportPlan,
  TEAM_RAW_DASHBOARD_OUTPUT_FIELDS,
  TEAM_RAW_DASHBOARD_OUTPUTS,
} from "@/lib/edge/analytics/engine/team-raw-dashboard-report-plan";
import {
  queryOverviewAndTrendForSitesFromHourlyRollupsPartial,
  queryOverviewForSitesFromHourlyRollupsPartial,
} from "@/lib/edge/analytics/providers/d1/internal/hourly-rollup-queries";
import type { Env } from "@/lib/edge/types";

import {
  queryAnalyticsReportOutputRowsFromD1,
  queryAnalyticsReportOutputSetRowsFromD1,
} from "./analytics-report-query";
import type {
  Interval,
  OverviewAggregateRow,
  QueryWindow,
  TeamSiteRow,
} from "./core";
import {
  buildTimeBuckets,
  mapOverviewAggregate,
  percentChange,
  timeBucketTimestamp,
} from "./core";
import {
  type AnalyticsDataSource,
  createD1ReadDiagnostics,
  type D1ReadDiagnostics,
  recordD1RowsRead,
} from "./diagnostics";

// Preserve the parent raw reader's site chunk and request boundaries.
const MAX_SITE_IDS_PER_D1_QUERY = 98;

function teamSiteWithDomainId<Row extends { readonly id: string | null }>(
  row: Row,
): Omit<Row, "id"> & { readonly id: string } {
  // createSiteWithDefaultSettings generates and inserts a UUID for every site;
  // TeamSiteRow carries that existing domain invariant. SQLite's catalog still
  // reports the TEXT primary key as nullable, so narrow only this selected id.
  return { ...row, id: row.id as string };
}

function hasEffectiveFilter(
  filters?: FilterDocument,
): filters is FilterDocument {
  const scoped = scopedFilterMetadata(filters);
  // An empty entity-scoped document still carries semantics: an explicit
  // Session or Visitor scope must not take the rollup path and silently become
  // the default Event dataset.  An empty observation-scoped document is
  // equivalent to the unfiltered visit rollup and may retain that
  // optimization without changing its resolved scope.
  return (
    scoped?.plan.mode === "entity" ||
    (filters?.root !== null && filters?.root !== undefined)
  );
}
function siteIdChunks(siteIds: string[]): string[][] {
  const chunks: string[][] = [];
  for (
    let index = 0;
    index < siteIds.length;
    index += MAX_SITE_IDS_PER_D1_QUERY
  ) {
    chunks.push(siteIds.slice(index, index + MAX_SITE_IDS_PER_D1_QUERY));
  }
  return chunks;
}

function createTeamRawDashboardPlan(
  teamId: string,
  siteIds: readonly string[],
  window: QueryWindow,
  interval: Interval,
  filters?: FilterDocument,
  outputs: "overview" | "trend" | "dashboard" = "dashboard",
) {
  const effective = hasEffectiveFilter(filters);
  const metadata = effective ? scopedFilterMetadata(filters) : undefined;
  if (effective && !metadata)
    throw new Error("team_dashboard_scoped_dataset_metadata_required");
  return buildTeamRawDashboardReportPlan({
    teamId,
    siteIds,
    queryTime: queryWindowToTime(window),
    filters: effective ? filters! : EMPTY_FILTER_DOCUMENT,
    ...(metadata ? { scopePlan: metadata.plan } : {}),
    interval,
    outputs,
  });
}

function mapOverviewRows(
  rows: readonly Record<string, unknown>[],
): Map<string, OverviewAggregateRow> {
  const result = new Map<string, OverviewAggregateRow>();
  for (const row of rows) {
    result.set(String(row.siteId ?? ""), {
      views: Number(row.views ?? 0),
      sessions: Number(row.sessions ?? 0),
      visitors: Number(row.visitors ?? 0),
      bounces: Number(row.bounces ?? 0),
      totalDuration: Number(row.totalDuration ?? 0),
      durationViews: Number(row.durationViews ?? 0),
    } satisfies OverviewAggregateRow);
  }
  return result;
}

function mapTrendRows(
  rows: readonly Record<string, unknown>[],
  buckets: ReturnType<typeof buildTimeBuckets>,
): TeamTrendRow[] {
  return rows
    .map((row) => {
      const bucket = Number(row.bucket ?? 0);
      return {
        siteId: String(row.siteId ?? ""),
        bucket,
        timestampMs: timeBucketTimestamp(buckets, bucket),
        views: Number(row.views ?? 0),
        visitors: Number(row.visitors ?? 0),
      };
    })
    .sort(
      (left, right) =>
        left.bucket - right.bucket || left.siteId.localeCompare(right.siteId),
    );
}

export async function queryTeamOverviewFromD1(
  env: Env,
  teamId: string,
  siteIds: string[],
  window: QueryWindow,
  diagnostics?: D1ReadDiagnostics,
  filters?: FilterDocument,
): Promise<Map<string, OverviewAggregateRow>> {
  if (siteIds.length === 0) return new Map();
  const result = new Map<string, OverviewAggregateRow>();
  for (const chunk of siteIdChunks(siteIds)) {
    const plan = createTeamRawDashboardPlan(
      teamId,
      chunk,
      window,
      "day",
      filters,
      "overview",
    );
    const rows = await queryAnalyticsReportOutputRowsFromD1(
      env,
      plan,
      TEAM_RAW_DASHBOARD_OUTPUTS.overview,
      undefined,
      diagnostics,
    );
    for (const [siteId, value] of mapOverviewRows(rows))
      result.set(siteId, value);
  }
  return result;
}

async function queryTeamOverviewAndTrendFromD1(
  env: Env,
  teamId: string,
  siteIds: string[],
  window: QueryWindow,
  interval: Interval,
  diagnostics?: D1ReadDiagnostics,
  filters?: FilterDocument,
): Promise<{
  readonly overview: Map<string, OverviewAggregateRow>;
  readonly trend: TeamTrendRow[];
}> {
  const overview = new Map<string, OverviewAggregateRow>();
  const trend: TeamTrendRow[] = [];
  const buckets = buildTimeBuckets(window, interval);
  for (const chunk of siteIdChunks(siteIds)) {
    const plan = createTeamRawDashboardPlan(
      teamId,
      chunk,
      window,
      interval,
      filters,
      "dashboard",
    );
    const rows = await queryAnalyticsReportOutputSetRowsFromD1(
      env,
      plan,
      {
        outputIds: Object.values(TEAM_RAW_DASHBOARD_OUTPUTS),
        fields: TEAM_RAW_DASHBOARD_OUTPUT_FIELDS,
        orderBy: [
          { field: "reportType", direction: "asc", nulls: "first" },
          { field: "bucket", direction: "asc", nulls: "first" },
          { field: "siteId", direction: "asc", nulls: "first" },
        ],
      },
      diagnostics,
    );
    for (const row of rows) {
      if (row.reportType === "overview") {
        const mapped = mapOverviewRows([row]);
        for (const [siteId, value] of mapped) overview.set(siteId, value);
      } else if (row.reportType === "trend") {
        trend.push(...mapTrendRows([row], buckets));
      }
    }
  }
  trend.sort(
    (left, right) =>
      left.bucket - right.bucket || left.siteId.localeCompare(right.siteId),
  );
  return { overview, trend };
}

async function queryTeamOverviewAggregate(
  env: Env,
  teamId: string,
  siteIds: string[],
  window: QueryWindow,
  diagnostics?: D1ReadDiagnostics,
  filters?: FilterDocument,
): Promise<{
  value: Map<string, OverviewAggregateRow>;
  source: AnalyticsDataSource;
}> {
  if (hasEffectiveFilter(filters)) {
    return {
      value: await queryTeamOverviewFromD1(
        env,
        teamId,
        siteIds,
        window,
        diagnostics,
        filters,
      ),
      source: "raw",
    };
  }

  const rollup = await queryOverviewForSitesFromHourlyRollupsPartial(
    env,
    siteIds,
    window,
    diagnostics,
  );
  const rawSiteIds = siteIds.filter((siteId) => !rollup.has(siteId));
  if (rawSiteIds.length === 0) return { value: rollup, source: "rollup" };
  const raw = await queryTeamOverviewFromD1(
    env,
    teamId,
    rawSiteIds,
    window,
    diagnostics,
  );
  for (const [siteId, value] of raw.entries()) rollup.set(siteId, value);
  return {
    value: rollup,
    source: rawSiteIds.length === siteIds.length ? "raw" : "mixed",
  };
}
export interface TeamTrendRow {
  siteId: string;
  bucket: number;
  timestampMs: number;
  views: number;
  visitors: number;
}
export async function queryTeamTrendFromD1(
  env: Env,
  teamId: string,
  siteIds: string[],
  window: QueryWindow,
  interval: Interval,
  diagnostics?: D1ReadDiagnostics,
  filters?: FilterDocument,
): Promise<TeamTrendRow[]> {
  if (siteIds.length === 0) return [];
  const buckets = buildTimeBuckets(window, interval);
  const result: TeamTrendRow[] = [];
  for (const chunk of siteIdChunks(siteIds)) {
    const plan = createTeamRawDashboardPlan(
      teamId,
      chunk,
      window,
      interval,
      filters,
      "trend",
    );
    const rows = await queryAnalyticsReportOutputRowsFromD1(
      env,
      plan,
      TEAM_RAW_DASHBOARD_OUTPUTS.trend,
      undefined,
      diagnostics,
    );
    result.push(...mapTrendRows(rows, buckets));
  }
  return result.sort(
    (left, right) =>
      left.bucket - right.bucket || left.siteId.localeCompare(right.siteId),
  );
}
async function queryTeamCurrentAggregates(
  env: Env,
  teamId: string,
  siteIds: string[],
  window: QueryWindow,
  interval: Interval,
  diagnostics?: D1ReadDiagnostics,
  filters?: FilterDocument,
): Promise<{
  overview: {
    value: Map<string, OverviewAggregateRow>;
    source: AnalyticsDataSource;
  };
  trend: { value: TeamTrendRow[]; source: AnalyticsDataSource };
}> {
  if (hasEffectiveFilter(filters)) {
    const { overview, trend } = await queryTeamOverviewAndTrendFromD1(
      env,
      teamId,
      siteIds,
      window,
      interval,
      diagnostics,
      filters,
    );
    return {
      overview: { value: overview, source: "raw" },
      trend: { value: trend, source: "raw" },
    };
  }

  const rollup = await queryOverviewAndTrendForSitesFromHourlyRollupsPartial(
    env,
    siteIds,
    window,
    interval,
    diagnostics,
  );

  const overviewRawSiteIds = siteIds.filter(
    (siteId) => !rollup.overview.has(siteId),
  );
  if (overviewRawSiteIds.length > 0) {
    const raw = await queryTeamOverviewFromD1(
      env,
      teamId,
      overviewRawSiteIds,
      window,
      diagnostics,
    );
    for (const [siteId, value] of raw.entries())
      rollup.overview.set(siteId, value);
  }

  const trendRawSiteIds = rollup.trend
    ? siteIds.filter((siteId) => !rollup.trend?.has(siteId))
    : siteIds;
  const rawTrend = await queryTeamTrendFromD1(
    env,
    teamId,
    trendRawSiteIds,
    window,
    interval,
    diagnostics,
  );
  const trendValue = [
    ...(rollup.trend ? [...rollup.trend.values()].flat() : []),
    ...rawTrend,
  ];

  const overviewSource: AnalyticsDataSource =
    overviewRawSiteIds.length === 0
      ? "rollup"
      : overviewRawSiteIds.length === siteIds.length
        ? "raw"
        : "mixed";
  const trendSource: AnalyticsDataSource =
    trendRawSiteIds.length === 0
      ? "rollup"
      : trendRawSiteIds.length === siteIds.length
        ? "raw"
        : "mixed";

  return {
    overview: { value: rollup.overview, source: overviewSource },
    trend: { value: trendValue, source: trendSource },
  };
}
export async function listTeamSites(
  env: Env,
  teamId: string,
  diagnostics?: D1ReadDiagnostics,
): Promise<TeamSiteRow[]> {
  const sites = scan(schema.sites);
  const matchingSites = filter(sites, eq(sites.columns.team_id, param(teamId)));
  const selected = project(matchingSites, {
    id: matchingSites.columns.id,
    teamId: matchingSites.columns.team_id,
    name: matchingSites.columns.name,
    domain: matchingSites.columns.domain,
    publicEnabled: matchingSites.columns.public_enabled,
    publicSlug: matchingSites.columns.public_slug,
    createdAt: matchingSites.columns.created_at,
    updatedAt: matchingSites.columns.updated_at,
  });
  const teamSites = sort(selected, [
    { expression: selected.columns.createdAt, direction: "DESC" },
  ]);
  const result = await createD1DatabaseClient(env.DB).all(
    compileD1Query(teamSites, {
      tag: "analytics.sites.all",
    }),
  );
  recordD1RowsRead(diagnostics, result);
  return result.results.map(teamSiteWithDomainId);
}
export interface TeamSiteListPage {
  readonly rows: readonly TeamSiteRow[];
  readonly nextCursor: {
    readonly createdAt: number;
    readonly id: string;
  } | null;
}
export async function queryTeamSitesPageFromD1(
  env: Env,
  teamId: string,
  limit: number,
  cursor?: { readonly createdAt: number; readonly id: string } | null,
  allowedSiteIds?: readonly string[],
  diagnostics?: D1ReadDiagnostics,
): Promise<TeamSiteListPage> {
  if (allowedSiteIds && allowedSiteIds.length === 0) {
    return { rows: [], nextCursor: null };
  }
  const sites = scan(schema.sites);
  const teamPredicate = eq(sites.columns.team_id, param(teamId));
  const cursorPredicate = cursor
    ? or(
        lt(sites.columns.created_at, param(cursor.createdAt)),
        and(
          eq(sites.columns.created_at, param(cursor.createdAt)),
          gt(sites.columns.id, param(cursor.id)),
        ),
      )
    : undefined;
  const pagePredicate = cursorPredicate
    ? and(teamPredicate, cursorPredicate)
    : teamPredicate;
  const allowedPredicate = allowedSiteIds?.length
    ? inList(sites.columns.id, allowedSiteIds)
    : undefined;
  const predicate = allowedPredicate
    ? and(pagePredicate, allowedPredicate)
    : pagePredicate;
  const filtered = filter(sites, predicate);
  const selected = project(filtered, {
    id: filtered.columns.id,
    teamId: filtered.columns.team_id,
    name: filtered.columns.name,
    domain: filtered.columns.domain,
    publicEnabled: filtered.columns.public_enabled,
    publicSlug: filtered.columns.public_slug,
    createdAt: filtered.columns.created_at,
    updatedAt: filtered.columns.updated_at,
  });
  const ordered = sort(selected, [
    { expression: selected.columns.createdAt, direction: "DESC" },
    { expression: selected.columns.id, direction: "ASC" },
  ]);
  const result = await createD1DatabaseClient(env.DB).all(
    compileD1Query(limitPlan(ordered, limit + 1), {
      tag: "analytics.sites.all",
    }),
  );
  recordD1RowsRead(diagnostics, result);
  const hasMore = result.results.length > limit;
  const rawRows = hasMore ? result.results.slice(0, limit) : result.results;
  const rows = rawRows.map(teamSiteWithDomainId);
  const last = rows.at(-1);
  return {
    rows,
    nextCursor:
      hasMore && last ? { createdAt: last.createdAt, id: last.id } : null,
  };
}
export interface TeamDashboardQueryResult {
  readonly data: TeamDashboardData;
  readonly source: AnalyticsDataSource;
}
/** Typed team dashboard reader shared by private and API v1 adapters. */
export async function queryTeamDashboardForTeam(
  env: Env,
  teamId: string,
  window: QueryWindow,
  interval: Interval,
  allowedSiteIds?: string[],
  diagnostics = createD1ReadDiagnostics(),
  preloadedSites?: readonly TeamSiteRow[],
  filters?: FilterDocument,
): Promise<TeamDashboardQueryResult> {
  const allSites = preloadedSites
    ? [...preloadedSites]
    : await listTeamSites(env, teamId, diagnostics);
  const allowed =
    allowedSiteIds && allowedSiteIds.length > 0
      ? new Set(allowedSiteIds)
      : null;
  const sites = allowed
    ? allSites.filter((site) => allowed.has(site.id))
    : allSites;
  if (sites.length === 0) {
    return { data: { sites: [], trend: [] }, source: "raw" };
  }

  const durationMs = window.endExclusiveMs - window.startMs;
  const previousEndExclusiveMs = window.startMs;
  const previousStartMs = Math.max(previousEndExclusiveMs - durationMs, 0);
  const previousWindow: QueryWindow = {
    startMs: previousStartMs,
    endExclusiveMs: previousEndExclusiveMs,
    nowMs: window.nowMs,
    timeZone: window.timeZone,
  };
  const siteIds = sites.map((site) => site.id);
  const [current, previousOverview] = await Promise.all([
    queryTeamCurrentAggregates(
      env,
      teamId,
      siteIds,
      window,
      interval,
      diagnostics,
      filters,
    ),
    queryTeamOverviewAggregate(
      env,
      teamId,
      siteIds,
      previousWindow,
      diagnostics,
      filters,
    ),
  ]);
  const { overview: currentOverview, trend } = current;
  const source: AnalyticsDataSource = [
    currentOverview.source,
    previousOverview.source,
    trend.source,
  ].includes("raw")
    ? [currentOverview.source, previousOverview.source, trend.source].includes(
        "rollup",
      ) ||
      [currentOverview.source, previousOverview.source, trend.source].includes(
        "mixed",
      )
      ? "mixed"
      : "raw"
    : [currentOverview.source, previousOverview.source, trend.source].includes(
          "mixed",
        )
      ? "mixed"
      : "rollup";

  const sitePayload = sites.map((site, _index) => {
    const overview = mapOverviewAggregate(
      currentOverview.value.get(site.id) ?? {
        views: 0,
        sessions: 0,
        visitors: 0,
        bounces: 0,
        totalDuration: 0,
        durationViews: 0,
      },
    );
    const previous = mapOverviewAggregate(
      previousOverview.value.get(site.id) ?? {
        views: 0,
        sessions: 0,
        visitors: 0,
        bounces: 0,
        totalDuration: 0,
        durationViews: 0,
      },
    );
    const currentPagesPerSession =
      overview.sessions > 0 ? overview.views / overview.sessions : 0;
    const previousPagesPerSession =
      previous.sessions > 0 ? previous.views / previous.sessions : 0;

    return {
      ...site,
      overview,
      changeRates: {
        views: percentChange(overview.views, previous.views),
        visitors: percentChange(overview.visitors, previous.visitors),
        sessions: percentChange(overview.sessions, previous.sessions),
        bounceRate: percentChange(overview.bounceRate, previous.bounceRate),
        avgDurationMs: percentChange(
          overview.avgDurationMs,
          previous.avgDurationMs,
        ),
        pagesPerSession: percentChange(
          currentPagesPerSession,
          previousPagesPerSession,
        ),
      },
    };
  });

  const trendByBucket = new Map<
    number,
    {
      bucket: number;
      timestampMs: number;
      sites: Array<{ siteId: string; views: number; visitors: number }>;
    }
  >();

  for (const row of trend.value) {
    const bucket = row.bucket;
    const existing = trendByBucket.get(bucket) ?? {
      bucket,
      timestampMs: row.timestampMs,
      sites: [],
    };
    existing.sites.push({
      siteId: row.siteId,
      views: row.views,
      visitors: row.visitors,
    });
    trendByBucket.set(bucket, existing);
  }

  return {
    data: {
      sites: sitePayload,
      trend: [...trendByBucket.values()].sort(
        (left, right) => left.bucket - right.bucket,
      ),
    },
    source,
  };
}
