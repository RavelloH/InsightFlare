import type { SessionListSortKey, VisitorListSortKey } from "./core";

interface VisitorAggregationOptions {
  pageSortKey?: VisitorListSortKey;
  searchWhere?: string;
  browserVersionExpression?: string;
  orderBy: string;
  cursorWhere?: string;
  limitOffset?: string;
  pageFirst?: boolean;
}

interface SessionAggregationOptions {
  pageSortKey?: SessionListSortKey;
  searchWhere?: string;
  browserVersionExpression?: string;
  orderBy: string;
  cursorWhere?: string;
  limitOffset?: string;
  pageFirst?: boolean;
}

export interface ScopedFactsSqlOptions {
  readonly visitsRelation: string;
  readonly eventsRelation: string;
}

/**
 * Shared session fact relations used by scoped filtering.  The raw relations
 * are already site- and time-window constrained, so keeping the aggregation
 * here makes the fact predicates use the same duration/views/events/bounce
 * semantics as the journey session list.
 */
export function buildSessionFactsSql(
  options: ScopedFactsSqlOptions,
  shared = false,
): string {
  const visits = options.visitsRelation;
  const events = options.eventsRelation;
  if (shared) {
    // The separate path can be cheaper for selective event-count predicates.
    // The shared path preserves event-only entities and site-local identities.
    return `
scope_session_totals AS (
  SELECT site_pk, site_id, session_id,
    SUM(duration) AS duration, SUM(views) AS views, SUM(events) AS events
  FROM (
    SELECT site_pk, site_id, session_id,
      SUM(COALESCE(duration_ms, 0)) AS duration, COUNT(*) AS views, 0 AS events
    FROM ${visits}
    WHERE TRIM(COALESCE(session_id, '')) != ''
    GROUP BY site_pk, site_id, session_id
    UNION ALL
    SELECT site_pk, site_id, session_id, 0, 0, COUNT(*)
    FROM ${events}
    WHERE TRIM(COALESCE(session_id, '')) != ''
    GROUP BY site_pk, site_id, session_id
  )
  GROUP BY site_pk, site_id, session_id
),
scope_session_facts AS (
  SELECT site_pk, site_id, session_id,
    CASE WHEN site_pk IS NOT NULL AND site_id IS NOT NULL THEN duration ELSE 0 END AS session_duration_ms,
    CASE WHEN site_pk IS NOT NULL AND site_id IS NOT NULL THEN views ELSE 0 END AS session_views,
    CASE WHEN site_pk IS NOT NULL AND site_id IS NOT NULL THEN events ELSE 0 END AS session_events,
    CASE WHEN site_pk IS NOT NULL AND site_id IS NOT NULL AND views = 1 THEN 1 ELSE 0 END AS session_bounce
  FROM scope_session_totals
)`;
  }
  return `
scope_session_visit_facts AS (
  SELECT
    site_pk,
    site_id,
    session_id,
    SUM(COALESCE(duration_ms, 0)) AS session_duration_ms,
    COUNT(*) AS session_views
  FROM ${visits}
  WHERE TRIM(COALESCE(session_id, '')) != ''
  GROUP BY site_pk, site_id, session_id
),
scope_session_event_facts AS (
  SELECT site_pk, site_id, session_id, COUNT(*) AS session_events
  FROM ${events}
  WHERE TRIM(COALESCE(session_id, '')) != ''
  GROUP BY site_pk, site_id, session_id
),
scope_session_facts AS (
  SELECT
    entities.site_pk,
    entities.site_id,
    entities.session_id,
    COALESCE(visit_facts.session_duration_ms, 0) AS session_duration_ms,
    COALESCE(visit_facts.session_views, 0) AS session_views,
    COALESCE(event_facts.session_events, 0) AS session_events,
    CASE WHEN COALESCE(visit_facts.session_views, 0) = 1 THEN 1 ELSE 0 END AS session_bounce
  FROM (
    SELECT DISTINCT site_pk, site_id, session_id
    FROM ${visits}
    WHERE TRIM(COALESCE(session_id, '')) != ''
    UNION
    SELECT DISTINCT site_pk, site_id, session_id
    FROM ${events}
    WHERE TRIM(COALESCE(session_id, '')) != ''
  ) entities
  LEFT JOIN scope_session_visit_facts visit_facts
    ON visit_facts.site_pk = entities.site_pk
   AND visit_facts.site_id = entities.site_id
   AND visit_facts.session_id = entities.session_id
  LEFT JOIN scope_session_event_facts event_facts
    ON event_facts.site_pk = entities.site_pk
   AND event_facts.site_id = entities.site_id
   AND event_facts.session_id = entities.session_id
)`;
}

/**
 * Shared visitor facts for scoped membership.  Visitor sessions include
 * sessions represented only by an in-window event, matching the existing
 * event-only journey expansion.
 */
export function buildVisitorFactsSql(
  options: ScopedFactsSqlOptions,
  shared = false,
): string {
  const visits = options.visitsRelation;
  const events = options.eventsRelation;
  if (shared) {
    // Keep exact distinct sessions across both observation types, including
    // sessions represented only by an event. UNION ALL retains event counts.
    return `
scope_visitor_facts AS (
  SELECT site_pk, site_id, visitor_id,
    COUNT(DISTINCT CASE WHEN site_pk IS NOT NULL AND site_id IS NOT NULL
      AND TRIM(COALESCE(session_id, '')) != '' THEN session_id END) AS visitor_sessions,
    COUNT(CASE WHEN site_pk IS NOT NULL AND site_id IS NOT NULL AND is_visit = 1 THEN 1 END) AS visitor_views,
    COUNT(CASE WHEN site_pk IS NOT NULL AND site_id IS NOT NULL AND is_visit = 0 THEN 1 END) AS visitor_events
  FROM (
    SELECT site_pk, site_id, visitor_id, session_id, 1 AS is_visit
    FROM ${visits}
    WHERE TRIM(COALESCE(visitor_id, '')) != ''
    UNION ALL
    SELECT site_pk, site_id, visitor_id, session_id, 0 AS is_visit
    FROM ${events}
    WHERE TRIM(COALESCE(visitor_id, '')) != ''
  )
  GROUP BY site_pk, site_id, visitor_id
)`;
  }
  return `
scope_visitor_visit_facts AS (
  SELECT site_pk, site_id, visitor_id, COUNT(*) AS visitor_views
  FROM ${visits}
  WHERE TRIM(COALESCE(visitor_id, '')) != ''
  GROUP BY site_pk, site_id, visitor_id
),
scope_visitor_event_facts AS (
  SELECT site_pk, site_id, visitor_id, COUNT(*) AS visitor_events
  FROM ${events}
  WHERE TRIM(COALESCE(visitor_id, '')) != ''
  GROUP BY site_pk, site_id, visitor_id
),
scope_visitor_session_facts AS (
  SELECT site_pk, site_id, visitor_id, COUNT(DISTINCT session_id) AS visitor_sessions
  FROM (
    SELECT site_pk, site_id, visitor_id, session_id
    FROM ${visits}
    WHERE TRIM(COALESCE(visitor_id, '')) != ''
      AND TRIM(COALESCE(session_id, '')) != ''
    UNION
    SELECT site_pk, site_id, visitor_id, session_id
    FROM ${events}
    WHERE TRIM(COALESCE(visitor_id, '')) != ''
      AND TRIM(COALESCE(session_id, '')) != ''
  ) sessions
  GROUP BY site_pk, site_id, visitor_id
),
scope_visitor_facts AS (
  SELECT
    entities.site_pk,
    entities.site_id,
    entities.visitor_id,
    COALESCE(session_facts.visitor_sessions, 0) AS visitor_sessions,
    COALESCE(visit_facts.visitor_views, 0) AS visitor_views,
    COALESCE(event_facts.visitor_events, 0) AS visitor_events
  FROM (
    SELECT DISTINCT site_pk, site_id, visitor_id
    FROM ${visits}
    WHERE TRIM(COALESCE(visitor_id, '')) != ''
    UNION
    SELECT DISTINCT site_pk, site_id, visitor_id
    FROM ${events}
    WHERE TRIM(COALESCE(visitor_id, '')) != ''
  ) entities
  LEFT JOIN scope_visitor_session_facts session_facts
    ON session_facts.site_pk = entities.site_pk
   AND session_facts.site_id = entities.site_id
   AND session_facts.visitor_id = entities.visitor_id
  LEFT JOIN scope_visitor_visit_facts visit_facts
    ON visit_facts.site_pk = entities.site_pk
   AND visit_facts.site_id = entities.site_id
   AND visit_facts.visitor_id = entities.visitor_id
  LEFT JOIN scope_visitor_event_facts event_facts
    ON event_facts.site_pk = entities.site_pk
   AND event_facts.site_id = entities.site_id
   AND event_facts.visitor_id = entities.visitor_id
)`;
}

/**
 * The list sort keys are all aggregate metrics. Resolve the exact page
 * (including the look-ahead row and cursor) before computing first/latest
 * attributes, identity ranking, coordinates and custom-event counts.
 * Detail readers continue to use the unpaged aggregation.
 */
function buildPageEntityCtes(
  options: VisitorAggregationOptions | SessionAggregationOptions,
  entity: "visitor" | "session",
): string {
  if (!options.pageFirst) return "";
  const id = entity === "visitor" ? "visitor_id" : "session_id";
  const alias = entity === "visitor" ? "vm" : "sm";
  const key = entity === "visitor" ? "visitorId" : "sessionId";
  // The first page only needs the primary sort and its stable time tie-break.
  // Full metrics are still calculated from the selected entities below.
  const sortKey = options.pageSortKey;
  const allMetrics =
    entity === "visitor"
      ? {
          firstSeenAt: "MIN(started_at) AS firstSeenAt",
          lastSeenAt: "MAX(started_at) AS lastSeenAt",
          views:
            "COUNT(CASE WHEN is_visit_observation = 1 THEN 1 END) AS views",
          sessions:
            "COUNT(DISTINCT CASE WHEN session_id != '' THEN session_id ELSE NULL END) AS sessions",
        }
      : {
          startedAt: "MIN(started_at) AS startedAt",
          durationMs: "SUM(COALESCE(duration_ms, 0)) AS totalDurationMs",
          views:
            "COUNT(CASE WHEN is_visit_observation = 1 THEN 1 END) AS views",
        };
  const tieBreak = entity === "visitor" ? "lastSeenAt" : "startedAt";
  const metrics = Object.entries(allMetrics)
    .filter(([key]) => !sortKey || key === sortKey || key === tieBreak)
    .map(([, expression]) => expression)
    .join(",\n      ");
  return `
page_metrics AS NOT MATERIALIZED (
  SELECT fv.${id}, ${metrics}
  FROM filtered_visits fv
  WHERE fv.${id} != ''
  ${options.searchWhere ?? ""}
  GROUP BY fv.${id}
),
page_entities AS MATERIALIZED (
  SELECT ${alias}.${id} AS ${key}
  FROM page_metrics ${alias}
  WHERE 1 = 1
  ${options.cursorWhere ?? ""}
  ORDER BY ${options.orderBy}
  ${options.limitOffset ?? ""}
),
`;
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
${buildPageEntityCtes(options, "visitor")}ranked_visits AS (
  SELECT
    fv.*,
    ROW_NUMBER() OVER (
      PARTITION BY fv.visitor_id
      ORDER BY fv.started_at ASC, fv.visit_id ASC
    ) AS first_rank,
    ROW_NUMBER() OVER (
      PARTITION BY fv.visitor_id
      ORDER BY fv.started_at DESC, fv.visit_id DESC
    ) AS latest_rank,
    ROW_NUMBER() OVER (
      PARTITION BY fv.visitor_id
      ORDER BY
        CASE WHEN TRIM(COALESCE(fv.user_id, '')) != '' THEN 0 ELSE 1 END,
        fv.started_at DESC,
        fv.visit_id DESC
    ) AS identity_rank
  FROM filtered_visits fv
  WHERE fv.visitor_id != ''
  ${options.searchWhere ?? ""}
  ${options.pageFirst ? "AND fv.visitor_id IN (SELECT visitorId FROM page_entities)" : ""}
),
visitor_metrics AS (
  SELECT
    visitor_id,
    MAX(CASE WHEN latest_rank = 1 THEN session_id END) AS sessionId,
    MAX(CASE WHEN identity_rank = 1 THEN user_id END) AS userId,
    MAX(CASE WHEN identity_rank = 1 THEN user_name END) AS userName,
    MIN(started_at) AS firstSeenAt,
    MAX(started_at) AS lastSeenAt,
    COUNT(CASE WHEN is_visit_observation = 1 THEN 1 END) AS views,
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
  WHERE ${options.pageFirst ? "visitor_id IN (SELECT visitorId FROM page_entities)" : "visitor_id != ''"}
  GROUP BY visitor_id
)
SELECT
  vm.visitor_id AS visitorId,
  COALESCE(vm.sessionId, '') AS sessionId,
  COALESCE(vm.userId, '') AS userId,
  COALESCE(vm.userName, '') AS userName,
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
WHERE 1 = 1
${options.pageFirst ? "" : (options.cursorWhere ?? "")}
ORDER BY ${options.orderBy}
${options.pageFirst ? "" : (options.limitOffset ?? "")}
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
  const validCoordinates =
    "latitude IS NOT NULL AND longitude IS NOT NULL AND ABS(latitude)<=90 AND ABS(longitude)<=180";
  // A paged list can compute both ends from the ascending rank and fold
  // its first valid coordinate pair into the same aggregate. Keep the
  // established detail/unpaged path as an independent ordering oracle.
  const latestWitness = options.pageFirst
    ? "first_rank = last_rank"
    : "latest_rank = 1";
  return `
${buildPageEntityCtes(options, "session")}ranked_visits AS (
  SELECT
    fv.*,${
      options.pageFirst
        ? `
    ROW_NUMBER() OVER (
      PARTITION BY fv.session_id
      ORDER BY CASE WHEN ${validCoordinates} THEN 0 ELSE 1 END, started_at ASC, visit_id ASC
    ) AS geo_rank,`
        : ""
    }
    ROW_NUMBER() OVER (
      PARTITION BY fv.session_id
      ORDER BY fv.started_at ASC, fv.visit_id ASC
    ) AS first_rank,
    ${
      options.pageFirst
        ? `COUNT(*) OVER (
      PARTITION BY fv.session_id
      ORDER BY fv.started_at ASC, fv.visit_id ASC
      ROWS BETWEEN UNBOUNDED PRECEDING AND UNBOUNDED FOLLOWING
    ) AS last_rank`
        : `ROW_NUMBER() OVER (
      PARTITION BY fv.session_id
      ORDER BY fv.started_at DESC, fv.visit_id DESC
    ) AS latest_rank`
    },
    ROW_NUMBER() OVER (
      PARTITION BY fv.session_id
      ORDER BY
        CASE WHEN TRIM(COALESCE(fv.user_id, '')) != '' THEN 0 ELSE 1 END,
        fv.started_at DESC,
        fv.visit_id DESC
    ) AS identity_rank
  FROM filtered_visits fv
  WHERE fv.session_id != ''
  ${options.searchWhere ?? ""}
  ${options.pageFirst ? "AND fv.session_id IN (SELECT sessionId FROM page_entities)" : ""}
),
${
  options.pageFirst
    ? ""
    : `geo_ranked AS (
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
`
}session_metrics AS (
  SELECT
    session_id,
    MAX(CASE WHEN first_rank = 1 THEN visitor_id END) AS visitorId,${
      options.pageFirst
        ? `
    MAX(CASE WHEN geo_rank = 1 AND ${validCoordinates} THEN latitude END) AS latitude,
    MAX(CASE WHEN geo_rank = 1 AND ${validCoordinates} THEN longitude END) AS longitude,`
        : ""
    }
    MAX(CASE WHEN identity_rank = 1 THEN user_id END) AS userId,
    MAX(CASE WHEN identity_rank = 1 THEN user_name END) AS userName,
    MIN(started_at) AS startedAt,
    MAX(COALESCE(ended_at, last_activity_at, started_at)) AS endedAt,
    SUM(COALESCE(duration_ms, 0)) AS totalDurationMs,
    MAX(CASE WHEN LOWER(COALESCE(status, '')) = 'open' THEN 1 ELSE 0 END) AS active,
    COUNT(CASE WHEN is_visit_observation = 1 THEN 1 END) AS views,
    CASE WHEN COUNT(CASE WHEN is_visit_observation = 1 THEN 1 END) = 1 THEN 1 ELSE 0 END AS bounce,
    MAX(CASE WHEN first_rank = 1 THEN pathname END) AS entryPath,
    MAX(CASE WHEN ${latestWitness} THEN pathname END) AS exitPath,
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
  WHERE ${options.pageFirst ? "session_id IN (SELECT sessionId FROM page_entities)" : "session_id != ''"}
  GROUP BY session_id
)${
    options.pageFirst
      ? ""
      : `,
geo_first AS (
  SELECT session_id, latitude, longitude
  FROM geo_ranked
  WHERE geo_rank = 1
)`
  }
SELECT
  sm.session_id AS sessionId,
  COALESCE(sm.visitorId, '') AS visitorId,
  COALESCE(sm.userId, '') AS userId,
  COALESCE(sm.userName, '') AS userName,
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
  ${options.pageFirst ? "sm" : "gf"}.latitude,
  ${options.pageFirst ? "sm" : "gf"}.longitude,
  COALESCE(sm.browser, '') AS browser,
  COALESCE(sm.browserVersion, '') AS browserVersion,
  COALESCE(sm.os, '') AS os,
  COALESCE(sm.osVersion, '') AS osVersion,
  COALESCE(sm.deviceType, '') AS deviceType,
  sm.screenWidth,
  sm.screenHeight
FROM session_metrics sm
LEFT JOIN event_counts ec ON ec.session_id = sm.session_id
${options.pageFirst ? "" : "LEFT JOIN geo_first gf ON gf.session_id = sm.session_id"}
WHERE 1 = 1
${options.pageFirst ? "" : (options.cursorWhere ?? "")}
ORDER BY ${options.orderBy}
${options.pageFirst ? "" : (options.limitOffset ?? "")}
`;
}
