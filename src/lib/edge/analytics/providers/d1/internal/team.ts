import {
  type FilterDocument,
  scopedFilterMetadata,
} from "@/lib/edge/analytics/contract";
import {
  queryOverviewAndTrendForSitesFromHourlyRollupsPartial,
  queryOverviewForSitesFromHourlyRollupsPartial,
} from "@/lib/edge/hourly-rollup";
import { sitePksFromSiteIdsSql } from "@/lib/edge/site-identity-sql";
import type { Env } from "@/lib/edge/types";

import type {
  Interval,
  OverviewAggregateRow,
  QueryWindow,
  TeamSiteRow,
} from "./core";
import {
  buildTimeBuckets,
  buildVisitSourceCteForSites,
  mapOverviewAggregate,
  percentChange,
  queryD1All,
  timeBucketCase,
  timeBucketTimestamp,
  visitSourceBindingsForSites,
} from "./core";
import {
  type AnalyticsDataSource,
  createD1ReadDiagnostics,
  type D1ReadDiagnostics,
  recordD1RowsRead,
} from "./diagnostics";
import { compileScopedDatasetSql } from "./scoped-dataset";

// D1 permits at most 100 bound parameters per statement; visit sources use
// two additional bindings for the half-open time window.
const MAX_SITE_IDS_PER_D1_QUERY = 98;
const MAX_D1_BINDINGS = 100;

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

function scopedDatasetsForSites(
  siteIds: string[],
  window: QueryWindow,
  filters: FilterDocument,
): Array<{
  readonly siteIds: string[];
  readonly dataset: ReturnType<typeof compileScopedDatasetSql>;
}> {
  const metadata = scopedFilterMetadata(filters);
  if (!metadata) {
    throw new Error("team_dashboard_scoped_dataset_metadata_required");
  }
  if (siteIds.length === 0) return [];

  const probe = compileScopedDatasetSql({
    filters,
    plan: metadata.plan,
    siteIds: [siteIds[0]!],
    window,
  });
  const fixedBindingCount = probe.bindings.length - 2;
  const maxSitesPerQuery = Math.floor(
    (MAX_D1_BINDINGS - fixedBindingCount) / 2,
  );
  if (maxSitesPerQuery < 1) {
    throw new Error("team_dashboard_filter_binding_limit");
  }

  const datasets: Array<{
    readonly siteIds: string[];
    readonly dataset: ReturnType<typeof compileScopedDatasetSql>;
  }> = [];
  for (let index = 0; index < siteIds.length; index += maxSitesPerQuery) {
    const chunk = siteIds.slice(index, index + maxSitesPerQuery);
    const dataset = compileScopedDatasetSql({
      filters,
      plan: metadata.plan,
      siteIds: chunk,
      window,
    });
    if (dataset.bindings.length > MAX_D1_BINDINGS) {
      throw new Error("team_dashboard_filter_binding_limit");
    }
    datasets.push({ siteIds: chunk, dataset });
  }
  return datasets;
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

function buildTeamOverviewSourceCte(siteCount: number): string {
  return `
visit_source AS MATERIALIZED (
  SELECT site_id, visitor_id, session_id, duration_ms
  FROM visits
  WHERE site_pk IN ${sitePksFromSiteIdsSql(siteCount)}
    AND started_at >= ? AND started_at < ?
)`;
}

export async function queryTeamOverviewFromD1(
  env: Env,
  siteIds: string[],
  window: QueryWindow,
  diagnostics?: D1ReadDiagnostics,
  filters?: FilterDocument,
): Promise<Map<string, OverviewAggregateRow>> {
  if (siteIds.length === 0) return new Map();
  const result = new Map<string, OverviewAggregateRow>();
  const datasets = hasEffectiveFilter(filters)
    ? scopedDatasetsForSites(siteIds, window, filters)
    : siteIdChunks(siteIds).map((chunk) => ({
        siteIds: chunk,
        dataset: null,
      }));
  for (const { siteIds: chunk, dataset } of datasets) {
    const sourceCte = dataset
      ? `${dataset.ctes},`
      : `${buildTeamOverviewSourceCte(chunk.length)},`;
    const metricSource = dataset?.visitRelation ?? "visit_source";
    const sql = `
WITH
${sourceCte}
session_rollup AS (
  SELECT site_id AS siteId, session_id, count(*) AS visit_count
  FROM ${metricSource}
  WHERE session_id != ''
  GROUP BY siteId, session_id
),
combined AS (
  SELECT
    site_id AS siteId,
    count(*) AS views,
    count(DISTINCT CASE WHEN session_id != '' THEN session_id ELSE NULL END) AS sessions,
    count(DISTINCT CASE WHEN visitor_id != '' THEN visitor_id ELSE NULL END) AS visitors,
    0 AS bounces,
    COALESCE(sum(CASE WHEN duration_ms IS NOT NULL AND duration_ms >= 0 THEN duration_ms ELSE 0 END), 0) AS totalDuration,
    COALESCE(sum(CASE WHEN duration_ms IS NOT NULL AND duration_ms >= 0 THEN 1 ELSE 0 END), 0) AS durationViews
  FROM ${metricSource}
  GROUP BY siteId
  UNION ALL
  SELECT
    siteId,
    0 AS views,
    0 AS sessions,
    0 AS visitors,
    COALESCE(sum(CASE WHEN visit_count = 1 THEN 1 ELSE 0 END), 0) AS bounces,
    0 AS totalDuration,
    0 AS durationViews
  FROM session_rollup
  GROUP BY siteId
)
SELECT
  siteId,
  sum(views) AS views,
  sum(sessions) AS sessions,
  sum(visitors) AS visitors,
  sum(bounces) AS bounces,
  sum(totalDuration) AS totalDuration,
  sum(durationViews) AS durationViews
FROM combined
GROUP BY siteId
`;
    const rows = await queryD1All<Record<string, unknown>>(
      env,
      sql,
      dataset
        ? dataset.bindings.map((binding) => binding.value)
        : visitSourceBindingsForSites(chunk, window),
      diagnostics,
    );
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
  }
  return result;
}

async function queryTeamOverviewAggregate(
  env: Env,
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
  siteIds: string[],
  window: QueryWindow,
  interval: Interval,
  diagnostics?: D1ReadDiagnostics,
  filters?: FilterDocument,
): Promise<TeamTrendRow[]> {
  if (siteIds.length === 0) return [];
  const buckets = buildTimeBuckets(window, interval);
  const bucket = timeBucketCase(buckets, "started_at");
  const result: TeamTrendRow[] = [];
  const datasets = hasEffectiveFilter(filters)
    ? scopedDatasetsForSites(siteIds, window, filters)
    : siteIdChunks(siteIds).map((chunk) => ({
        siteIds: chunk,
        dataset: null,
      }));
  for (const { siteIds: chunk, dataset } of datasets) {
    const sourceCte = dataset
      ? `${dataset.ctes},`
      : `${buildVisitSourceCteForSites(chunk.length)},`;
    const metricSource = dataset?.visitRelation ?? "visit_source";
    const sql = `
WITH
${sourceCte}
SELECT
  site_id AS siteId,
  ${bucket.sql} AS bucket,
  count(*) AS views,
  count(DISTINCT CASE WHEN visitor_id != '' THEN visitor_id ELSE NULL END) AS visitors
FROM ${metricSource}
GROUP BY siteId, bucket
ORDER BY bucket ASC, siteId ASC
`;
    const rows = await queryD1All<Record<string, unknown>>(
      env,
      sql,
      [
        ...(dataset
          ? dataset.bindings.map((binding) => binding.value)
          : visitSourceBindingsForSites(chunk, window)),
        ...bucket.bindings,
      ],
      diagnostics,
    );
    result.push(
      ...rows.map((row) => ({
        siteId: String(row.siteId ?? ""),
        bucket: Number(row.bucket ?? 0),
        timestampMs: timeBucketTimestamp(buckets, Number(row.bucket ?? 0)),
        views: Number(row.views ?? 0),
        visitors: Number(row.visitors ?? 0),
      })),
    );
  }
  return result.sort(
    (left, right) =>
      left.bucket - right.bucket || left.siteId.localeCompare(right.siteId),
  );
}

async function queryTeamCurrentAggregates(
  env: Env,
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
    const [overview, trend] = await Promise.all([
      queryTeamOverviewFromD1(env, siteIds, window, diagnostics, filters),
      queryTeamTrendFromD1(
        env,
        siteIds,
        window,
        interval,
        diagnostics,
        filters,
      ),
    ]);
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
  const result = await env.DB.prepare(
    `
      SELECT
        id,
        team_id AS teamId,
        name,
        domain,
        public_enabled AS publicEnabled,
        public_slug AS publicSlug,
        created_at AS createdAt,
        updated_at AS updatedAt
      FROM sites
      WHERE team_id = ?
      ORDER BY created_at DESC
    `,
  )
    .bind(teamId)
    .all<TeamSiteRow>();
  recordD1RowsRead(diagnostics, result);
  return result.results;
}

export interface TeamDashboardQueryResult {
  readonly data: TeamDashboardData;
  readonly source: AnalyticsDataSource;
}

export interface TeamDashboardOverview {
  readonly views: number;
  readonly sessions: number;
  readonly visitors: number;
  readonly bounces: number;
  readonly totalDurationMs: number;
  readonly avgDurationMs: number;
  readonly bounceRate: number;
  readonly approximateVisitors: boolean;
}

export interface TeamDashboardSite extends TeamSiteRow {
  readonly overview: TeamDashboardOverview;
  readonly changeRates: Readonly<
    Record<
      | "views"
      | "visitors"
      | "sessions"
      | "bounceRate"
      | "avgDurationMs"
      | "pagesPerSession",
      number | null
    >
  >;
}

export interface TeamDashboardTrendBucket {
  readonly bucket: number;
  readonly timestampMs: number;
  readonly sites: readonly {
    readonly siteId: string;
    readonly views: number;
    readonly visitors: number;
  }[];
}

export interface TeamDashboardData {
  readonly sites: readonly TeamDashboardSite[];
  readonly trend: readonly TeamDashboardTrendBucket[];
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
      siteIds,
      window,
      interval,
      diagnostics,
      filters,
    ),
    queryTeamOverviewAggregate(
      env,
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
