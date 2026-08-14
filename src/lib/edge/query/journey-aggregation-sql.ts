interface VisitorAggregationOptions {
  searchWhere?: string;
  browserVersionExpression?: string;
  orderBy: string;
  limitOffset?: string;
}

interface SessionAggregationOptions {
  searchWhere?: string;
  browserVersionExpression?: string;
  orderBy: string;
  limitOffset?: string;
}

/**
 * Builds the shared set-based visitor aggregation used by list and detail
 * queries. Ranking once lets the aggregate pick first/last values without a
 * correlated ORDER BY/LIMIT subquery for every output row.
 */
export function buildVisitorAggregationSql(
  options: VisitorAggregationOptions,
): string {
  const browserVersion = options.browserVersionExpression ?? "browser_version";
  return `
ranked_visits AS (
  SELECT
    fv.*,
    ROW_NUMBER() OVER (
      PARTITION BY fv.visitor_id
      ORDER BY fv.started_at ASC, fv.visit_id ASC
    ) AS first_rank,
    ROW_NUMBER() OVER (
      PARTITION BY fv.visitor_id
      ORDER BY fv.started_at DESC, fv.visit_id DESC
    ) AS latest_rank
  FROM filtered_visits fv
  WHERE fv.visitor_id != ''
  ${options.searchWhere ?? ""}
),
visitor_metrics AS (
  SELECT
    visitor_id,
    MAX(CASE WHEN latest_rank = 1 THEN session_id END) AS sessionId,
    MIN(started_at) AS firstSeenAt,
    MAX(started_at) AS lastSeenAt,
    COUNT(*) AS views,
    COUNT(DISTINCT CASE WHEN session_id != '' THEN session_id ELSE NULL END) AS sessions,
    MAX(CASE WHEN latest_rank = 1 THEN country END) AS country,
    MAX(CASE WHEN latest_rank = 1 THEN region END) AS region,
    MAX(CASE WHEN latest_rank = 1 THEN region_code END) AS regionCode,
    MAX(CASE WHEN latest_rank = 1 THEN city END) AS city,
    MAX(CASE WHEN first_rank = 1 THEN referrer_host END) AS referrerHost,
    MAX(CASE WHEN first_rank = 1 THEN referrer_url END) AS referrerUrl,
    MAX(CASE WHEN latest_rank = 1 THEN browser END) AS browser,
    MAX(CASE WHEN latest_rank = 1 THEN ${browserVersion} END) AS browserVersion,
    MAX(CASE WHEN latest_rank = 1 THEN os END) AS os,
    MAX(CASE WHEN latest_rank = 1 THEN os_version END) AS osVersion,
    MAX(CASE WHEN latest_rank = 1 THEN device_type END) AS deviceType,
    MAX(CASE WHEN latest_rank = 1 THEN screen_width END) AS screenWidth,
    MAX(CASE WHEN latest_rank = 1 THEN screen_height END) AS screenHeight
  FROM ranked_visits
  GROUP BY visitor_id
),
event_counts AS (
  SELECT visitor_id, COUNT(*) AS events
  FROM event_source
  WHERE visitor_id != ''
  GROUP BY visitor_id
)
SELECT
  vm.visitor_id AS visitorId,
  COALESCE(vm.sessionId, '') AS sessionId,
  vm.firstSeenAt,
  vm.lastSeenAt,
  vm.views,
  vm.sessions,
  COALESCE(ec.events, 0) AS events,
  COALESCE(vm.country, '') AS country,
  COALESCE(vm.region, '') AS region,
  COALESCE(vm.regionCode, '') AS regionCode,
  COALESCE(vm.city, '') AS city,
  COALESCE(vm.referrerHost, '') AS referrerHost,
  COALESCE(vm.referrerUrl, '') AS referrerUrl,
  COALESCE(vm.browser, '') AS browser,
  COALESCE(vm.browserVersion, '') AS browserVersion,
  COALESCE(vm.os, '') AS os,
  COALESCE(vm.osVersion, '') AS osVersion,
  COALESCE(vm.deviceType, '') AS deviceType,
  vm.screenWidth,
  vm.screenHeight
FROM visitor_metrics vm
LEFT JOIN event_counts ec ON ec.visitor_id = vm.visitor_id
ORDER BY ${options.orderBy}
${options.limitOffset ?? ""}
`;
}

/**
 * Builds the shared set-based session aggregation. The separate geo CTE keeps
 * the first valid coordinate pair together while the main ranking handles all
 * other first/last session attributes.
 */
export function buildSessionAggregationSql(
  options: SessionAggregationOptions,
): string {
  const browserVersion = options.browserVersionExpression ?? "browser_version";
  return `
ranked_visits AS (
  SELECT
    fv.*,
    ROW_NUMBER() OVER (
      PARTITION BY fv.session_id
      ORDER BY fv.started_at ASC, fv.visit_id ASC
    ) AS first_rank,
    ROW_NUMBER() OVER (
      PARTITION BY fv.session_id
      ORDER BY fv.started_at DESC, fv.visit_id DESC
    ) AS latest_rank
  FROM filtered_visits fv
  WHERE fv.session_id != ''
  ${options.searchWhere ?? ""}
),
geo_ranked AS (
  SELECT
    session_id,
    latitude,
    longitude,
    ROW_NUMBER() OVER (
      PARTITION BY session_id
      ORDER BY started_at ASC, visit_id ASC
    ) AS geo_rank
  FROM ranked_visits
  WHERE latitude IS NOT NULL
    AND longitude IS NOT NULL
    AND ABS(latitude) <= 90
    AND ABS(longitude) <= 180
),
session_metrics AS (
  SELECT
    session_id,
    MAX(CASE WHEN first_rank = 1 THEN visitor_id END) AS visitorId,
    MIN(started_at) AS startedAt,
    MAX(COALESCE(ended_at, last_activity_at, started_at)) AS endedAt,
    SUM(COALESCE(duration_ms, 0)) AS totalDurationMs,
    MAX(CASE WHEN LOWER(COALESCE(status, '')) = 'open' THEN 1 ELSE 0 END) AS active,
    COUNT(*) AS views,
    CASE WHEN COUNT(*) <= 1 THEN 1 ELSE 0 END AS bounce,
    MAX(CASE WHEN first_rank = 1 THEN pathname END) AS entryPath,
    MAX(CASE WHEN latest_rank = 1 THEN pathname END) AS exitPath,
    MAX(CASE WHEN first_rank = 1 THEN referrer_host END) AS referrerHost,
    MAX(CASE WHEN first_rank = 1 THEN referrer_url END) AS referrerUrl,
    MAX(CASE WHEN first_rank = 1 THEN country END) AS country,
    MAX(CASE WHEN first_rank = 1 THEN region END) AS region,
    MAX(CASE WHEN first_rank = 1 THEN region_code END) AS regionCode,
    MAX(CASE WHEN first_rank = 1 THEN city END) AS city,
    MAX(CASE WHEN first_rank = 1 THEN browser END) AS browser,
    MAX(CASE WHEN first_rank = 1 THEN ${browserVersion} END) AS browserVersion,
    MAX(CASE WHEN first_rank = 1 THEN os END) AS os,
    MAX(CASE WHEN first_rank = 1 THEN os_version END) AS osVersion,
    MAX(CASE WHEN first_rank = 1 THEN device_type END) AS deviceType,
    MAX(CASE WHEN first_rank = 1 THEN screen_width END) AS screenWidth,
    MAX(CASE WHEN first_rank = 1 THEN screen_height END) AS screenHeight
  FROM ranked_visits
  GROUP BY session_id
),
event_counts AS (
  SELECT session_id, COUNT(*) AS events
  FROM event_source
  WHERE session_id != ''
  GROUP BY session_id
),
geo_first AS (
  SELECT session_id, latitude, longitude
  FROM geo_ranked
  WHERE geo_rank = 1
)
SELECT
  sm.session_id AS sessionId,
  COALESCE(sm.visitorId, '') AS visitorId,
  sm.startedAt,
  sm.endedAt,
  sm.totalDurationMs,
  sm.active,
  sm.views,
  COALESCE(ec.events, 0) AS events,
  sm.bounce,
  COALESCE(sm.entryPath, '') AS entryPath,
  COALESCE(sm.exitPath, '') AS exitPath,
  COALESCE(sm.referrerHost, '') AS referrerHost,
  COALESCE(sm.referrerUrl, '') AS referrerUrl,
  COALESCE(sm.country, '') AS country,
  COALESCE(sm.region, '') AS region,
  COALESCE(sm.regionCode, '') AS regionCode,
  COALESCE(sm.city, '') AS city,
  gf.latitude,
  gf.longitude,
  COALESCE(sm.browser, '') AS browser,
  COALESCE(sm.browserVersion, '') AS browserVersion,
  COALESCE(sm.os, '') AS os,
  COALESCE(sm.osVersion, '') AS osVersion,
  COALESCE(sm.deviceType, '') AS deviceType,
  sm.screenWidth,
  sm.screenHeight
FROM session_metrics sm
LEFT JOIN event_counts ec ON ec.session_id = sm.session_id
LEFT JOIN geo_first gf ON gf.session_id = sm.session_id
ORDER BY ${options.orderBy}
${options.limitOffset ?? ""}
`;
}
