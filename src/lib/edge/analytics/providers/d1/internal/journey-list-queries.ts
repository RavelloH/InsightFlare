import type { ScopedDatasetSql } from "@/lib/edge/analytics/contract";
import { SITE_PK_FROM_SITE_ID_SQL } from "@/lib/edge/site-identity-sql";
import type { Env } from "@/lib/edge/types";
import { pageResult } from "@/lib/pagination";

import type {
  FilterDocument,
  JourneyEventRow,
  ListSort,
  QueryWindow,
  SessionListSortKey,
  SessionRow,
  VisitorListSortKey,
  VisitorRow,
} from "./core";
import {
  browserMajorVersionExpr,
  buildCustomEventSourceCte,
  buildVisitFilterSql,
  buildVisitSourceCte,
  DEFAULT_SESSION_LIST_SORT,
  DEFAULT_VISITOR_LIST_SORT,
  eventSourceBindings,
  queryD1All,
  visitSourceBindings,
} from "./core";
import {
  buildSessionAggregationSql,
  buildVisitorAggregationSql,
} from "./journey-aggregation-sql";
import {
  buildJourneySearchSql,
  mapJourneyEventRow,
  mapSessionRow,
  mapVisitorRow,
  sessionListOrderBy,
  visitorListOrderBy,
  whereClauseWithTarget,
} from "./journey-helpers";
import { scopedDatasetFor } from "./scoped-dataset";

export interface VisitorListCursor {
  sortValue: number;
  lastSeenAt?: number;
  visitorId: string;
}

export interface SessionListCursor {
  sortValue: number;
  startedAt?: number;
  sessionId: string;
}

export interface VisitorListPage {
  rows: VisitorRow[];
  nextCursor: VisitorListCursor | null;
}

export interface SessionListPage {
  rows: SessionRow[];
  nextCursor: SessionListCursor | null;
}

export interface JourneyEventCursor {
  readonly occurredAt: number;
  readonly id: string;
}

export interface JourneyEventPage {
  readonly items: readonly JourneyEventRow[];
  readonly pagination: {
    readonly limit: number;
    readonly returned: number;
    readonly hasMore: boolean;
    readonly nextCursor: JourneyEventCursor | null;
  };
}

function hasJourneyFilters(filters: FilterDocument): boolean {
  return filters.root !== null;
}

function fullEntityFilterCtes(
  entity: "visitor" | "session",
  filterClause: string,
  searchCondition?: string,
): string {
  // Legacy direct-reader path. Prepared scoped queries use the canonical
  // scopedDataset relations below and never enter this branch.
  const column = entity === "visitor" ? "visitor_id" : "session_id";
  return `matched_${entity}s AS (
  SELECT DISTINCT visit_source.${column}
  FROM visit_source
  ${filterClause}
    AND visit_source.${column} != ''
    ${searchCondition ? `AND ${searchCondition}` : ""}
),
filtered_visits AS (
  SELECT v.*, 1 AS is_visit_observation
  FROM visit_source v
  INNER JOIN matched_${entity}s me ON me.${column} = v.${column}
)`;
}

const EVENT_ONLY_VISIT_PROJECTION = `
    e.visit_id,
    e.site_id,
    e.site_pk,
    e.visitor_id,
    e.session_id,
    NULL,
    e.occurred_at,
    e.occurred_at,
    e.occurred_at,
    e.occurred_at,
    NULL,
    NULL,
    NULL,
    e.pathname,
    e.query_string,
    e.hash_fragment,
    e.hostname,
    e.title,
    e.referrer_url,
    e.referrer_host,
    e.utm_source,
    e.utm_medium,
    e.utm_campaign,
    e.utm_term,
    e.utm_content,
    NULL,
    e.country,
    e.region,
    e.region_code,
    e.city,
    e.continent,
    NULL,
    NULL,
    NULL,
    NULL,
    e.timezone,
    e.as_organization,
    NULL,
    e.browser,
    e.browser_version,
    e.os,
    e.os_version,
    e.device_type,
    e.screen_width,
    e.screen_height,
    e.language,
    NULL,
    NULL,
    NULL,
    NULL,
    NULL,
    NULL,
    0 AS is_visit_observation`;

function scopedAggregationFilteredVisitsCte(
  dataset: ScopedDatasetSql,
  entity: "visitor" | "session",
  targetClause: string,
): string {
  const column = entity === "visitor" ? "visitor_id" : "session_id";
  const eventTargetClause = targetClause || "";
  return `filtered_visits AS (
  SELECT v.*, 1 AS is_visit_observation
  FROM ${dataset.visitRelation} v
  ${targetClause}
  UNION ALL
  SELECT ${EVENT_ONLY_VISIT_PROJECTION}
  FROM ${dataset.eventRelation} e
  INNER JOIN ${entity === "visitor" ? dataset.visitorRelation : dataset.sessionRelation} entity_ids
    ON entity_ids.site_pk = e.site_pk
   AND entity_ids.${column} = e.${column}
  WHERE NOT EXISTS (
    SELECT 1
    FROM ${dataset.visitRelation} existing_visit
    WHERE existing_visit.site_pk = e.site_pk
      AND existing_visit.${column} = e.${column}
  )
  ${eventTargetClause ? eventTargetClause.replace(/^WHERE\s+/i, "AND ") : ""}
)`;
}

/**
 * Establishes a target's site/window scope before reading its trajectory.
 * Empty trajectories are valid. Presence is established from the unfiltered
 * observation universe, so a target with only an in-window custom event (or a
 * session whose visit began before the window) is still a real target.
 */
export async function queryJourneyTargetExistsFromD1(
  env: Env,
  siteId: string,
  target: { readonly type: "visitor" | "session"; readonly value: string },
  window: QueryWindow,
): Promise<boolean> {
  const rows = await queryD1All<{ present: number }>(
    env,
    `
WITH entity_universe AS (
  SELECT ${target.type === "visitor" ? "visitor_id" : "session_id"} AS entity_id
  FROM visits
  WHERE site_pk = ${SITE_PK_FROM_SITE_ID_SQL}
    AND started_at >= ? AND started_at < ?
  UNION
  SELECT v.${target.type === "visitor" ? "visitor_id" : "session_id"} AS entity_id
  FROM custom_events ce
  INNER JOIN visits v
    ON v.site_pk = ce.site_pk AND v.visit_id = ce.visit_id
  WHERE ce.site_pk = ${SITE_PK_FROM_SITE_ID_SQL}
    AND ce.occurred_at >= ? AND ce.occurred_at < ?
)
SELECT 1 AS present
FROM entity_universe
WHERE entity_id = ?
LIMIT 1
`,
    [
      siteId,
      window.startMs,
      window.endExclusiveMs,
      siteId,
      window.startMs,
      window.endExclusiveMs,
      target.value,
    ],
  );
  return rows.length > 0;
}

function visitorCursorFromRow(
  row: VisitorRow,
  sort: ListSort<VisitorListSortKey>,
): VisitorListCursor {
  return sort.key === "lastSeenAt"
    ? { sortValue: row.lastSeenAt, visitorId: row.visitorId }
    : {
        sortValue: row[sort.key],
        lastSeenAt: row.lastSeenAt,
        visitorId: row.visitorId,
      };
}

function sessionCursorFromRow(
  row: SessionRow,
  sort: ListSort<SessionListSortKey>,
): SessionListCursor {
  return sort.key === "startedAt"
    ? { sortValue: row.startedAt, sessionId: row.sessionId }
    : {
        sortValue: sort.key === "durationMs" ? row.durationMs : row[sort.key],
        startedAt: row.startedAt,
        sessionId: row.sessionId,
      };
}

function visitorCursorFilter(
  cursor: VisitorListCursor,
  sort: ListSort<VisitorListSortKey>,
): { clause: string; bindings: Array<string | number> } {
  const column: Record<VisitorListSortKey, string> = {
    firstSeenAt: "vm.firstSeenAt",
    lastSeenAt: "vm.lastSeenAt",
    sessions: "vm.sessions",
    views: "vm.views",
  };
  const primary = column[sort.key];
  const operator = sort.direction === "asc" ? ">" : "<";
  if (sort.key === "lastSeenAt") {
    return {
      clause: `AND (${primary} ${operator} ? OR (${primary} = ? AND vm.visitor_id > ?))`,
      bindings: [cursor.sortValue, cursor.sortValue, cursor.visitorId],
    };
  }
  return {
    clause: `AND (
  ${primary} ${operator} ?
  OR (${primary} = ? AND (vm.lastSeenAt < ? OR (vm.lastSeenAt = ? AND vm.visitor_id > ?)))
)`,
    bindings: [
      cursor.sortValue,
      cursor.sortValue,
      cursor.lastSeenAt!,
      cursor.lastSeenAt!,
      cursor.visitorId,
    ],
  };
}

function sessionCursorFilter(
  cursor: SessionListCursor,
  sort: ListSort<SessionListSortKey>,
): { clause: string; bindings: Array<string | number> } {
  const column: Record<SessionListSortKey, string> = {
    startedAt: "sm.startedAt",
    durationMs: "sm.totalDurationMs",
    views: "sm.views",
  };
  const primary = column[sort.key];
  const operator = sort.direction === "asc" ? ">" : "<";
  if (sort.key === "startedAt") {
    return {
      clause: `AND (${primary} ${operator} ? OR (${primary} = ? AND sm.session_id > ?))`,
      bindings: [cursor.sortValue, cursor.sortValue, cursor.sessionId],
    };
  }
  return {
    clause: `AND (
  ${primary} ${operator} ?
  OR (${primary} = ? AND (sm.startedAt < ? OR (sm.startedAt = ? AND sm.session_id > ?)))
)`,
    bindings: [
      cursor.sortValue,
      cursor.sortValue,
      cursor.startedAt!,
      cursor.startedAt!,
      cursor.sessionId,
    ],
  };
}

export async function queryVisitorsFromD1(
  env: Env,
  siteId: string,
  window: QueryWindow,
  filters: FilterDocument,
  limit: number,
  targetVisitorId?: string,
  offset = 0,
  sort: ListSort<VisitorListSortKey> = DEFAULT_VISITOR_LIST_SORT,
  search?: string,
): Promise<VisitorRow[]> {
  const rows: VisitorRow[] = [];
  let cursor: VisitorListCursor | null = null;
  let remaining = Math.max(0, Math.trunc(offset));
  const pageLimit = Math.max(1, Math.min(200, limit + remaining));
  while (rows.length < limit) {
    const page = await queryVisitorListPageFromD1(
      env,
      siteId,
      window,
      filters,
      {
        limit: pageLimit,
        sort,
        search,
        cursor,
      },
    );
    const candidates = targetVisitorId
      ? page.rows.filter((row) => row.visitorId === targetVisitorId)
      : page.rows;
    if (remaining >= candidates.length) {
      remaining -= candidates.length;
    } else {
      rows.push(
        ...candidates.slice(remaining, remaining + limit - rows.length),
      );
      remaining = 0;
    }
    if (rows.length >= limit || !page.nextCursor) break;
    cursor = page.nextCursor;
  }
  return rows;
}

export async function queryVisitorListPageFromD1(
  env: Env,
  siteId: string,
  window: QueryWindow,
  filters: FilterDocument,
  options: {
    limit: number;
    sort: ListSort<VisitorListSortKey>;
    search?: string;
    cursor?: VisitorListCursor | null;
  },
): Promise<VisitorListPage> {
  const scopedDataset = scopedDatasetFor(siteId, window, filters);
  const filter = scopedDataset ? null : buildVisitFilterSql(filters);
  const searchSql = buildJourneySearchSql(options.search);
  const hasFilters = !scopedDataset && hasJourneyFilters(filters);
  const expandEntities = hasFilters;
  const searchCte = searchSql
    ? `,
matched_visitors AS (
  SELECT DISTINCT visitor_id
  FROM filtered_visits
  WHERE visitor_id != '' AND ${searchSql.condition}
)`
    : "";
  const searchWhere = searchSql
    ? "AND fv.visitor_id IN (SELECT visitor_id FROM matched_visitors)"
    : "";
  const cursor = options.cursor
    ? visitorCursorFilter(options.cursor, options.sort)
    : { clause: "", bindings: [] };
  const sql = `
WITH
${scopedDataset?.ctes ?? `${buildVisitSourceCte()},\n${buildCustomEventSourceCte()}`},
${scopedDataset ? `event_source AS (SELECT * FROM ${scopedDataset.eventRelation}),` : ""}
${
  scopedDataset
    ? scopedAggregationFilteredVisitsCte(scopedDataset, "visitor", "")
    : expandEntities
      ? fullEntityFilterCtes(
          "visitor",
          filter?.clause ?? "",
          searchSql?.condition,
        )
      : `filtered_visits AS (
  SELECT visit_source.*, 1 AS is_visit_observation
  FROM visit_source
  ${filter?.clause ?? ""}
  )`
}
${expandEntities ? "" : searchCte},
${buildVisitorAggregationSql({
  searchWhere: expandEntities ? "" : searchWhere,
  browserVersionExpression: browserMajorVersionExpr(),
  cursorWhere: cursor.clause,
  orderBy: visitorListOrderBy(options.sort),
  limitOffset: "LIMIT ?",
})}`;
  const records = await queryD1All<Record<string, unknown>>(env, sql, [
    ...(scopedDataset
      ? scopedDataset.bindings.map((binding) => binding.value)
      : [
          ...visitSourceBindings(siteId, window),
          ...eventSourceBindings(siteId, window),
        ]),
    ...(filter?.bindings ?? []),
    ...(searchSql?.bindings ?? []),
    ...cursor.bindings,
    options.limit + 1,
  ]);
  const hasMore = records.length > options.limit;
  const pageRecords = hasMore ? records.slice(0, options.limit) : records;
  const rows = pageRecords.map(mapVisitorRow);
  const lastRow = rows.at(-1);
  return {
    rows,
    nextCursor:
      hasMore && lastRow ? visitorCursorFromRow(lastRow, options.sort) : null,
  };
}

export async function querySessionsFromD1(
  env: Env,
  siteId: string,
  window: QueryWindow,
  filters: FilterDocument,
  limit: number,
  target?: { type: "visitor" | "session"; value: string },
  offset = 0,
  sort: ListSort<SessionListSortKey> = DEFAULT_SESSION_LIST_SORT,
  search?: string,
): Promise<SessionRow[]> {
  const rows: SessionRow[] = [];
  let cursor: SessionListCursor | null = null;
  let remaining = Math.max(0, Math.trunc(offset));
  const pageLimit = Math.max(1, Math.min(200, limit + remaining));
  while (rows.length < limit) {
    const page = await querySessionListPageFromD1(
      env,
      siteId,
      window,
      filters,
      {
        limit: pageLimit,
        sort,
        search,
        cursor,
        target,
      },
    );
    if (remaining >= page.rows.length) {
      remaining -= page.rows.length;
    } else {
      rows.push(...page.rows.slice(remaining, remaining + limit - rows.length));
      remaining = 0;
    }
    if (rows.length >= limit || !page.nextCursor) break;
    cursor = page.nextCursor;
  }
  return rows;
}

export async function querySessionListPageFromD1(
  env: Env,
  siteId: string,
  window: QueryWindow,
  filters: FilterDocument,
  options: {
    limit: number;
    sort: ListSort<SessionListSortKey>;
    search?: string;
    cursor?: SessionListCursor | null;
    target?: { readonly type: "visitor" | "session"; readonly value: string };
  },
): Promise<SessionListPage> {
  const scopedDataset = scopedDatasetFor(siteId, window, filters);
  const filter = scopedDataset ? null : buildVisitFilterSql(filters);
  const searchSql = buildJourneySearchSql(options.search);
  const hasFilters = !scopedDataset && hasJourneyFilters(filters);
  const expandEntities = hasFilters;
  const searchCte = searchSql
    ? `,
matched_sessions AS (
  SELECT DISTINCT session_id
  FROM filtered_visits
  WHERE session_id != '' AND ${searchSql.condition}
)`
    : "";
  const searchWhere = searchSql
    ? "AND fv.session_id IN (SELECT session_id FROM matched_sessions)"
    : "";
  const cursor = options.cursor
    ? sessionCursorFilter(options.cursor, options.sort)
    : { clause: "", bindings: [] };
  const targetColumn =
    options.target?.type === "visitor"
      ? "visitor_id"
      : options.target?.type === "session"
        ? "session_id"
        : "";
  const targetClause = options.target
    ? scopedDataset
      ? `WHERE ${targetColumn} = ?`
      : whereClauseWithTarget(filter?.clause ?? "", {
          column: targetColumn,
          value: options.target.value,
        })
    : (filter?.clause ?? "");
  const sql = `
WITH
${scopedDataset?.ctes ?? `${buildVisitSourceCte()},\n${buildCustomEventSourceCte()}`},
${scopedDataset ? `event_source AS (SELECT * FROM ${scopedDataset.eventRelation}),` : ""}
${
  scopedDataset
    ? scopedAggregationFilteredVisitsCte(scopedDataset, "session", targetClause)
    : expandEntities
      ? fullEntityFilterCtes("session", targetClause, searchSql?.condition)
      : `filtered_visits AS (
  SELECT visit_source.*, 1 AS is_visit_observation
  FROM visit_source
  ${targetClause}
  )`
}
${expandEntities ? "" : searchCte},
${buildSessionAggregationSql({
  searchWhere: expandEntities ? "" : searchWhere,
  browserVersionExpression: browserMajorVersionExpr(),
  cursorWhere: cursor.clause,
  orderBy: sessionListOrderBy(options.sort),
  limitOffset: "LIMIT ?",
})}`;
  const records = await queryD1All<Record<string, unknown>>(env, sql, [
    ...(scopedDataset
      ? scopedDataset.bindings.map((binding) => binding.value)
      : [
          ...visitSourceBindings(siteId, window),
          ...eventSourceBindings(siteId, window),
        ]),
    ...(scopedDataset && options.target
      ? [options.target.value, options.target.value]
      : options.target
        ? [options.target.value]
        : []),
    ...(filter?.bindings ?? []),
    ...(searchSql?.bindings ?? []),
    ...cursor.bindings,
    options.limit + 1,
  ]);
  const hasMore = records.length > options.limit;
  const pageRecords = hasMore ? records.slice(0, options.limit) : records;
  const rows = pageRecords.map(mapSessionRow);
  const lastRow = rows.at(-1);
  return {
    rows,
    nextCursor:
      hasMore && lastRow ? sessionCursorFromRow(lastRow, options.sort) : null,
  };
}

export async function queryJourneyEventsPageFromD1(
  env: Env,
  siteId: string,
  window: QueryWindow,
  filters: FilterDocument,
  target: { type: "visitor" | "session"; value: string },
  limit: number,
  cursor?: JourneyEventCursor | null,
): Promise<JourneyEventPage> {
  const scopedDataset = scopedDatasetFor(siteId, window, filters);
  const filter = scopedDataset ? null : buildVisitFilterSql(filters);
  const targetColumn = target.type === "visitor" ? "visitor_id" : "session_id";
  const targetClause = scopedDataset
    ? `WHERE ${targetColumn} = ?`
    : whereClauseWithTarget(filter?.clause ?? "", {
        column: targetColumn,
        value: target.value,
      });
  const eventTargetClause = scopedDataset ? `WHERE es.${targetColumn} = ?` : "";
  const customEventProjection = scopedDataset
    ? `
    es.session_id AS sessionId,
    es.visitor_id AS visitorId,
    es.pathname AS pathname,
    es.hash_fragment AS hash,
    es.title AS title,
    es.hostname AS hostname,
    es.referrer_host AS referrerHost,
    es.referrer_url AS referrerUrl,
    es.country AS country,
    es.region AS region,
    es.city AS city,
    es.browser AS browser,
    es.browser_version AS browserVersion,
    es.os AS os,
    es.os_version AS osVersion,
    es.device_type AS deviceType,
    es.screen_width AS screenWidth,
    es.screen_height AS screenHeight,
    0 AS durationMs,
    NULL AS perfTtfbMs,
    NULL AS perfFcpMs,
    NULL AS perfLcpMs,
    NULL AS perfCls,
    NULL AS perfInpMs`
    : `
    fv.session_id AS sessionId,
    fv.visitor_id AS visitorId,
    COALESCE(NULLIF(es.pathname, ''), fv.pathname) AS pathname,
    COALESCE(NULLIF(es.hash_fragment, ''), fv.hash_fragment) AS hash,
    COALESCE(NULLIF(es.title, ''), fv.title) AS title,
    COALESCE(NULLIF(es.hostname, ''), fv.hostname) AS hostname,
    COALESCE(NULLIF(es.referrer_host, ''), fv.referrer_host) AS referrerHost,
    COALESCE(NULLIF(es.referrer_url, ''), fv.referrer_url) AS referrerUrl,
    COALESCE(NULLIF(es.country, ''), fv.country) AS country,
    COALESCE(NULLIF(es.region, ''), fv.region) AS region,
    COALESCE(NULLIF(es.city, ''), fv.city) AS city,
    COALESCE(NULLIF(es.browser, ''), fv.browser) AS browser,
    fv.browser_version AS browserVersion,
    COALESCE(NULLIF(es.os, ''), fv.os) AS os,
    COALESCE(NULLIF(es.os_version, ''), fv.os_version) AS osVersion,
    COALESCE(NULLIF(es.device_type, ''), fv.device_type) AS deviceType,
    COALESCE(es.screen_width, fv.screen_width) AS screenWidth,
    COALESCE(es.screen_height, fv.screen_height) AS screenHeight,
    0 AS durationMs,
    fv.perf_ttfb_ms AS perfTtfbMs,
    fv.perf_fcp_ms AS perfFcpMs,
    fv.perf_lcp_ms AS perfLcpMs,
    fv.perf_cls AS perfCls,
    fv.perf_inp_ms AS perfInpMs`;
  const cursorClause = cursor
    ? "WHERE occurredAt < ? OR (occurredAt = ? AND id < ?)"
    : "";
  const sql = `
WITH
${scopedDataset?.ctes ?? `${buildVisitSourceCte()},\n${buildCustomEventSourceCte()}`},
${scopedDataset ? `event_source AS (SELECT * FROM ${scopedDataset.eventRelation}),` : ""}
filtered_visits AS (
  SELECT *
  FROM ${scopedDataset?.visitRelation ?? "visit_source"}
  ${targetClause}
),
page_events AS (
  SELECT
    visit_id AS id,
    'pageview' AS kind,
    'pageview' AS eventType,
    started_at AS occurredAt,
    visit_id AS visitId,
    session_id AS sessionId,
    visitor_id AS visitorId,
    pathname,
    hash_fragment AS hash,
    title,
    hostname,
    referrer_host AS referrerHost,
    referrer_url AS referrerUrl,
    country,
    region,
    city,
    browser,
    browser_version AS browserVersion,
    os,
    os_version AS osVersion,
    device_type AS deviceType,
    screen_width AS screenWidth,
    screen_height AS screenHeight,
    COALESCE(duration_ms, 0) AS durationMs,
    perf_ttfb_ms AS perfTtfbMs,
    perf_fcp_ms AS perfFcpMs,
    perf_lcp_ms AS perfLcpMs,
    perf_cls AS perfCls,
    perf_inp_ms AS perfInpMs
  FROM filtered_visits
),
custom_event_rows AS (
  SELECT
    es.event_id AS id,
    'custom' AS kind,
    es.event_name AS eventType,
    es.occurred_at AS occurredAt,
    es.visit_id AS visitId,
    ${customEventProjection}
  FROM event_source es
  ${scopedDataset ? "LEFT JOIN" : "INNER JOIN"} filtered_visits fv
    ON fv.visit_id = es.visit_id
  ${eventTargetClause}
)
SELECT *
FROM (
  SELECT * FROM page_events
  UNION ALL
  SELECT * FROM custom_event_rows
)
AS journey_events
${cursorClause}
ORDER BY occurredAt DESC, id DESC
LIMIT ?
`;
  const rows = await queryD1All<Record<string, unknown>>(env, sql, [
    ...(scopedDataset
      ? scopedDataset.bindings.map((binding) => binding.value)
      : [
          ...visitSourceBindings(siteId, window),
          ...eventSourceBindings(siteId, window),
        ]),
    target.value,
    ...(filter?.bindings ?? []),
    ...(scopedDataset ? [target.value] : []),
    ...(cursor ? [cursor.occurredAt, cursor.occurredAt, cursor.id] : []),
    limit + 1,
  ]);
  const mapped = rows.map(mapJourneyEventRow);
  const page = pageResult(mapped, limit);
  const last = page.last;
  return {
    items: page.rows,
    pagination: {
      limit,
      returned: page.rows.length,
      hasMore: page.hasMore,
      nextCursor:
        page.hasMore && last
          ? { occurredAt: last.occurredAt, id: last.id }
          : null,
    },
  };
}

export async function queryJourneyEventsFromD1(
  env: Env,
  siteId: string,
  window: QueryWindow,
  filters: FilterDocument,
  target: { type: "visitor" | "session"; value: string },
  limit: number,
): Promise<JourneyEventRow[]> {
  const page = await queryJourneyEventsPageFromD1(
    env,
    siteId,
    window,
    filters,
    target,
    limit,
  );
  return [...page.items];
}
