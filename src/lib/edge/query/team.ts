import {
  queryOverviewForSitesFromHourlyRollupsPartial,
  queryTrendForSitesFromHourlyRollupsPartial,
} from "@/lib/edge/hourly-rollup";
import type { EdgeSessionClaims } from "@/lib/edge/session-auth";
import type { Env } from "@/lib/edge/types";

import type {
  Interval,
  OverviewAggregateRow,
  QueryWindow,
  TeamSiteRow,
} from "./core";
import {
  badRequest,
  buildTimeBuckets,
  buildVisitSourceCteForSites,
  jsonResponseWith,
  mapOverviewAggregate,
  parseInterval,
  parseWindow,
  percentChange,
  PRIVATE_CACHE_HEADERS,
  queryD1All,
  resolvePrivateTeam,
  resolvePrivateTeamForSession,
  type ResponseContext,
  timeBucketCase,
  timeBucketTimestamp,
  visitSourceBindingsForSites,
} from "./core";
import {
  type AnalyticsDataSource,
  analyticsDiagnosticHeaders,
  createD1ReadDiagnostics,
  type D1ReadDiagnostics,
  recordD1RowsRead,
} from "./diagnostics";

export async function queryTeamOverviewFromD1(
  env: Env,
  siteIds: string[],
  window: QueryWindow,
  diagnostics?: D1ReadDiagnostics,
): Promise<Map<string, OverviewAggregateRow>> {
  if (siteIds.length === 0) return new Map();
  const sql = `
WITH
${buildVisitSourceCteForSites(siteIds.length)},
session_rollup AS (
  SELECT site_id AS siteId, session_id, count(*) AS visit_count
  FROM visit_source
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
  FROM visit_source
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
    visitSourceBindingsForSites(siteIds, window),
    diagnostics,
  );
  return new Map(
    rows.map((row) => [
      String(row.siteId ?? ""),
      {
        views: Number(row.views ?? 0),
        sessions: Number(row.sessions ?? 0),
        visitors: Number(row.visitors ?? 0),
        bounces: Number(row.bounces ?? 0),
        totalDuration: Number(row.totalDuration ?? 0),
        durationViews: Number(row.durationViews ?? 0),
      } satisfies OverviewAggregateRow,
    ]),
  );
}

async function queryTeamOverviewAggregate(
  env: Env,
  siteIds: string[],
  window: QueryWindow,
  diagnostics?: D1ReadDiagnostics,
): Promise<{
  value: Map<string, OverviewAggregateRow>;
  source: AnalyticsDataSource;
}> {
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
): Promise<TeamTrendRow[]> {
  if (siteIds.length === 0) return [];
  const buckets = buildTimeBuckets(window, interval);
  const bucket = timeBucketCase(buckets, "started_at");
  const sql = `
WITH
${buildVisitSourceCteForSites(siteIds.length)}
SELECT
  site_id AS siteId,
  ${bucket.sql} AS bucket,
  count(*) AS views,
  count(DISTINCT CASE WHEN visitor_id != '' THEN visitor_id ELSE NULL END) AS visitors
FROM visit_source
GROUP BY siteId, bucket
ORDER BY bucket ASC, siteId ASC
`;
  return (
    await queryD1All<Record<string, unknown>>(
      env,
      sql,
      [...visitSourceBindingsForSites(siteIds, window), ...bucket.bindings],
      diagnostics,
    )
  ).map((row) => ({
    siteId: String(row.siteId ?? ""),
    bucket: Number(row.bucket ?? 0),
    timestampMs: timeBucketTimestamp(buckets, Number(row.bucket ?? 0)),
    views: Number(row.views ?? 0),
    visitors: Number(row.visitors ?? 0),
  }));
}

async function queryTeamTrendAggregate(
  env: Env,
  siteIds: string[],
  window: QueryWindow,
  interval: Interval,
  diagnostics?: D1ReadDiagnostics,
): Promise<{ value: TeamTrendRow[]; source: AnalyticsDataSource }> {
  const rollup = await queryTrendForSitesFromHourlyRollupsPartial(
    env,
    siteIds,
    window,
    interval,
    diagnostics,
  );
  if (!rollup) {
    return {
      value: await queryTeamTrendFromD1(
        env,
        siteIds,
        window,
        interval,
        diagnostics,
      ),
      source: "raw",
    };
  }
  const rawSiteIds = siteIds.filter((siteId) => !rollup.has(siteId));
  const raw = await queryTeamTrendFromD1(
    env,
    rawSiteIds,
    window,
    interval,
    diagnostics,
  );
  const value = [
    ...[...rollup.values()].flat().map((row) => ({
      siteId: row.siteId,
      bucket: row.bucket,
      timestampMs: row.timestampMs,
      views: row.views,
      visitors: row.visitors,
    })),
    ...raw,
  ];
  return {
    value,
    source: rawSiteIds.length === 0 ? "rollup" : "mixed",
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

export async function handleTeamDashboard(
  request: Request,
  env: Env,
  url: URL,
  ctx?: ResponseContext,
): Promise<Response> {
  const window = parseWindow(url);
  if (!window) return badRequest("Invalid time window");
  const team = await resolvePrivateTeam(request, env, url);
  if (team instanceof Response) return team;

  return handleTeamDashboardForTeam(
    env,
    url,
    team.id,
    window,
    team.allowedSiteIds,
    ctx,
  );
}

export async function handleTeamDashboardForSession(
  request: Request,
  env: Env,
  url: URL,
  session: EdgeSessionClaims,
  ctx?: ResponseContext,
): Promise<Response> {
  const window = parseWindow(url);
  if (!window) return badRequest("Invalid time window");
  const team = await resolvePrivateTeamForSession(request, env, url, session);
  if (team instanceof Response) return team;

  return handleTeamDashboardForTeam(
    env,
    url,
    team.id,
    window,
    team.allowedSiteIds,
    ctx,
  );
}

export async function handleTeamDashboardForTeam(
  env: Env,
  url: URL,
  teamId: string,
  window: QueryWindow,
  allowedSiteIds?: string[],
  ctx?: ResponseContext,
): Promise<Response> {
  const interval = parseInterval(url);
  const diagnostics = createD1ReadDiagnostics();
  const allSites = await listTeamSites(env, teamId, diagnostics);
  const allowed =
    allowedSiteIds && allowedSiteIds.length > 0
      ? new Set(allowedSiteIds)
      : null;
  const sites = allowed
    ? allSites.filter((site) => allowed.has(site.id))
    : allSites;
  if (sites.length === 0) {
    return jsonResponseWith(
      ctx!,
      {
        ok: true,
        data: {
          sites: [],
          trend: [],
        },
      },
      200,
      {
        ...PRIVATE_CACHE_HEADERS,
        ...analyticsDiagnosticHeaders("raw", diagnostics),
      },
    );
  }

  const previousTo = Math.max(window.fromMs - 1, 0);
  const previousFrom = Math.max(previousTo - (window.toMs - window.fromMs), 0);
  const previousWindow: QueryWindow = {
    fromMs: previousFrom,
    toMs: previousTo,
    nowMs: window.nowMs,
    timeZone: window.timeZone,
  };
  const siteIds = sites.map((site) => site.id);
  const [currentOverview, previousOverview, trend] = await Promise.all([
    queryTeamOverviewAggregate(env, siteIds, window, diagnostics),
    queryTeamOverviewAggregate(env, siteIds, previousWindow, diagnostics),
    queryTeamTrendAggregate(env, siteIds, window, interval, diagnostics),
  ]);
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

  return jsonResponseWith(
    ctx!,
    {
      ok: true,
      data: {
        sites: sitePayload,
        trend: [...trendByBucket.values()].sort(
          (left, right) => left.bucket - right.bucket,
        ),
      },
    },
    200,
    {
      ...PRIVATE_CACHE_HEADERS,
      ...analyticsDiagnosticHeaders(source, diagnostics),
    },
  );
}
