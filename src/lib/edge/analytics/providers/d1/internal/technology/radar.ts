import type {
  FilterDocument,
  QueryWindow,
  ReferrerRadarRow,
} from "@/lib/edge/analytics/providers/d1/internal/core";
import {
  buildVisitFilterSql,
  buildVisitSourceCte,
  queryD1All,
  visitSourceBindings,
} from "@/lib/edge/analytics/providers/d1/internal/core";
import type { Env } from "@/lib/edge/types";

export async function queryBrowserRadarFromD1(
  env: Env,
  siteId: string,
  window: QueryWindow,
  filters: FilterDocument,
): Promise<
  Array<{
    browser: string;
    sessions: number;
    bounces: number;
    avgDurationMs: number;
    avgDepth: number;
    visitors: number;
    returningVisitors: number;
    avgFrequency: number;
    trafficShare: number;
  }>
> {
  const filter = buildVisitFilterSql(filters);

  const sql = `
WITH
${buildVisitSourceCte()},

filtered_visits AS MATERIALIZED (
  SELECT
    visit_id,
    visitor_id,
    session_id,
    TRIM(COALESCE(browser, '')) AS browser,
    CASE WHEN duration_ms IS NOT NULL AND duration_ms >= 0
         THEN duration_ms ELSE 0 END AS safe_duration_ms
  FROM visit_source
  ${filter.clause}
),

session_level AS (
  SELECT
    browser,
    session_id,
    count(*) AS visit_count,
    sum(safe_duration_ms) AS session_duration
  FROM filtered_visits
  WHERE browser != '' AND session_id != ''
  GROUP BY browser, session_id
),

browser_session_agg AS (
  SELECT
    browser,
    count(*) AS sessions,
    sum(CASE WHEN visit_count = 1 THEN 1 ELSE 0 END) AS bounces,
    CASE WHEN count(*) > 0
         THEN CAST(sum(session_duration) AS REAL) / count(*)
         ELSE 0 END AS avgDurationMs,
    CASE WHEN count(*) > 0
         THEN CAST(sum(visit_count) AS REAL) / count(*)
         ELSE 0 END AS avgDepth
  FROM session_level
  GROUP BY browser
),

visitor_level AS (
  SELECT
    browser,
    visitor_id,
    count(DISTINCT CASE WHEN session_id != '' THEN session_id ELSE NULL END) AS session_count
  FROM filtered_visits
  WHERE browser != '' AND visitor_id != ''
  GROUP BY browser, visitor_id
),

browser_visitor_agg AS (
  SELECT
    browser,
    count(*) AS visitors,
    sum(CASE WHEN session_count > 1 THEN 1 ELSE 0 END) AS returningVisitors,
    CASE WHEN count(*) > 0
         THEN CAST(sum(session_count) AS REAL) / count(*)
         ELSE 0 END AS avgFrequency
  FROM visitor_level
  GROUP BY browser
),

total_visitors AS (
  SELECT count(DISTINCT CASE WHEN visitor_id != '' THEN visitor_id ELSE NULL END) AS total
  FROM filtered_visits
  WHERE browser != ''
)

SELECT
  bsa.browser,
  bsa.sessions,
  bsa.bounces,
  bsa.avgDurationMs,
  bsa.avgDepth,
  bva.visitors,
  bva.returningVisitors,
  bva.avgFrequency,
  CASE WHEN tv.total > 0
       THEN CAST(bva.visitors AS REAL) / tv.total
       ELSE 0 END AS trafficShare
FROM browser_session_agg bsa
INNER JOIN browser_visitor_agg bva ON bsa.browser = bva.browser
CROSS JOIN total_visitors tv
ORDER BY bva.visitors DESC
`;

  const rows = await queryD1All<Record<string, unknown>>(env, sql, [
    ...visitSourceBindings(siteId, window),
    ...filter.bindings,
  ]);

  return rows
    .map((row) => ({
      browser: String(row.browser ?? "").trim(),
      sessions: Number(row.sessions ?? 0),
      bounces: Number(row.bounces ?? 0),
      avgDurationMs: Number(row.avgDurationMs ?? 0),
      avgDepth: Number(row.avgDepth ?? 0),
      visitors: Number(row.visitors ?? 0),
      returningVisitors: Number(row.returningVisitors ?? 0),
      avgFrequency: Number(row.avgFrequency ?? 0),
      trafficShare: Number(row.trafficShare ?? 0),
    }))
    .filter((row) => row.browser.length > 0 && row.visitors > 0);
}

export async function queryReferrerRadarFromD1(
  env: Env,
  siteId: string,
  window: QueryWindow,
  filters: FilterDocument,
  limit: number,
): Promise<ReferrerRadarRow[]> {
  const filter = buildVisitFilterSql(filters);

  const sql = `
WITH
${buildVisitSourceCte()},

filtered_visits AS MATERIALIZED (
  SELECT
    visit_id,
    visitor_id,
    session_id,
    TRIM(COALESCE(referrer_host, '')) AS referrer,
    CASE WHEN duration_ms IS NOT NULL AND duration_ms >= 0
         THEN duration_ms ELSE 0 END AS safe_duration_ms
  FROM visit_source
  ${filter.clause}
),

session_level AS (
  SELECT
    referrer,
    session_id,
    count(*) AS visit_count,
    sum(safe_duration_ms) AS session_duration
  FROM filtered_visits
  WHERE session_id != ''
  GROUP BY referrer, session_id
),

referrer_session_agg AS (
  SELECT
    referrer,
    count(*) AS sessions,
    sum(CASE WHEN visit_count = 1 THEN 1 ELSE 0 END) AS bounces,
    CASE WHEN count(*) > 0
         THEN CAST(sum(session_duration) AS REAL) / count(*)
         ELSE 0 END AS avgDurationMs,
    CASE WHEN count(*) > 0
         THEN CAST(sum(visit_count) AS REAL) / count(*)
         ELSE 0 END AS avgDepth
  FROM session_level
  GROUP BY referrer
),

visitor_level AS (
  SELECT
    referrer,
    visitor_id,
    count(DISTINCT CASE WHEN session_id != '' THEN session_id ELSE NULL END) AS session_count
  FROM filtered_visits
  WHERE visitor_id != ''
  GROUP BY referrer, visitor_id
),

referrer_visitor_agg AS (
  SELECT
    referrer,
    count(*) AS visitors,
    sum(CASE WHEN session_count > 1 THEN 1 ELSE 0 END) AS returningVisitors,
    CASE WHEN count(*) > 0
         THEN CAST(sum(session_count) AS REAL) / count(*)
         ELSE 0 END AS avgFrequency
  FROM visitor_level
  GROUP BY referrer
),

total_visitors AS (
  SELECT count(DISTINCT CASE WHEN visitor_id != '' THEN visitor_id ELSE NULL END) AS total
  FROM filtered_visits
)

SELECT
  rsa.referrer,
  rsa.sessions,
  rsa.bounces,
  rsa.avgDurationMs,
  rsa.avgDepth,
  rva.visitors,
  rva.returningVisitors,
  rva.avgFrequency,
  CASE WHEN tv.total > 0
       THEN CAST(rva.visitors AS REAL) / tv.total
       ELSE 0 END AS trafficShare
FROM referrer_session_agg rsa
INNER JOIN referrer_visitor_agg rva ON rsa.referrer = rva.referrer
CROSS JOIN total_visitors tv
ORDER BY rva.visitors DESC, rsa.sessions DESC, rsa.referrer ASC
LIMIT ?
`;

  const rows = await queryD1All<Record<string, unknown>>(env, sql, [
    ...visitSourceBindings(siteId, window),
    ...filter.bindings,
    limit,
  ]);

  return rows
    .map((row) => ({
      referrer: String(row.referrer ?? "").trim(),
      sessions: Number(row.sessions ?? 0),
      bounces: Number(row.bounces ?? 0),
      avgDurationMs: Number(row.avgDurationMs ?? 0),
      avgDepth: Number(row.avgDepth ?? 0),
      visitors: Number(row.visitors ?? 0),
      returningVisitors: Number(row.returningVisitors ?? 0),
      avgFrequency: Number(row.avgFrequency ?? 0),
      trafficShare: Number(row.trafficShare ?? 0),
    }))
    .filter((row) => row.visitors > 0);
}
