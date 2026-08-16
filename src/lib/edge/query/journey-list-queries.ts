import type { Env } from "@/lib/edge/types";

import type {
  DashboardFilters,
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

const JOURNEY_LIST_CURSOR_MAX_LENGTH = 12_288;

export interface VisitorListCursor {
  sortKey: VisitorListSortKey;
  sortDirection: "asc" | "desc";
  sortValue: number;
  lastSeenAt: number;
  visitorId: string;
}

export interface SessionListCursor {
  sortKey: SessionListSortKey;
  sortDirection: "asc" | "desc";
  sortValue: number;
  startedAt: number;
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

function toBase64Url(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/u, "");
}

function fromBase64Url(value: string): string | null {
  try {
    const padded = value.replaceAll("-", "+").replaceAll("_", "/");
    const binary = atob(padded.padEnd(Math.ceil(padded.length / 4) * 4, "="));
    const bytes = Uint8Array.from(binary, (character) =>
      character.charCodeAt(0),
    );
    return new TextDecoder().decode(bytes);
  } catch {
    return null;
  }
}

function parseCursorValue(raw: string): Record<string, unknown> | null {
  if (raw.length === 0 || raw.length > JOURNEY_LIST_CURSOR_MAX_LENGTH) {
    return null;
  }
  const decoded = fromBase64Url(raw);
  if (!decoded) return null;
  try {
    const value: unknown = JSON.parse(decoded);
    return value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

export function serializeVisitorListCursor(cursor: VisitorListCursor): string {
  return toBase64Url(JSON.stringify(cursor));
}

export function parseVisitorListCursor(
  raw: string,
  sort: ListSort<VisitorListSortKey>,
): VisitorListCursor | null {
  const cursor = parseCursorValue(raw);
  if (
    !cursor ||
    cursor.sortKey !== sort.key ||
    cursor.sortDirection !== sort.direction ||
    typeof cursor.sortValue !== "number" ||
    !Number.isFinite(cursor.sortValue) ||
    typeof cursor.lastSeenAt !== "number" ||
    !Number.isFinite(cursor.lastSeenAt) ||
    typeof cursor.visitorId !== "string"
  ) {
    return null;
  }
  return {
    sortKey: sort.key,
    sortDirection: sort.direction,
    sortValue: cursor.sortValue,
    lastSeenAt: cursor.lastSeenAt,
    visitorId: cursor.visitorId,
  };
}

export function serializeSessionListCursor(cursor: SessionListCursor): string {
  return toBase64Url(JSON.stringify(cursor));
}

export function parseSessionListCursor(
  raw: string,
  sort: ListSort<SessionListSortKey>,
): SessionListCursor | null {
  const cursor = parseCursorValue(raw);
  if (
    !cursor ||
    cursor.sortKey !== sort.key ||
    cursor.sortDirection !== sort.direction ||
    typeof cursor.sortValue !== "number" ||
    !Number.isFinite(cursor.sortValue) ||
    typeof cursor.startedAt !== "number" ||
    !Number.isFinite(cursor.startedAt) ||
    typeof cursor.sessionId !== "string"
  ) {
    return null;
  }
  return {
    sortKey: sort.key,
    sortDirection: sort.direction,
    sortValue: cursor.sortValue,
    startedAt: cursor.startedAt,
    sessionId: cursor.sessionId,
  };
}

function visitorCursorFromRow(
  row: VisitorRow,
  sort: ListSort<VisitorListSortKey>,
): VisitorListCursor {
  return {
    sortKey: sort.key,
    sortDirection: sort.direction,
    sortValue: row[sort.key],
    lastSeenAt: row.lastSeenAt,
    visitorId: row.visitorId,
  };
}

function sessionCursorFromRow(
  row: SessionRow,
  sort: ListSort<SessionListSortKey>,
): SessionListCursor {
  return {
    sortKey: sort.key,
    sortDirection: sort.direction,
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
      cursor.lastSeenAt,
      cursor.lastSeenAt,
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
      cursor.startedAt,
      cursor.startedAt,
      cursor.sessionId,
    ],
  };
}

export async function queryVisitorsFromD1(
  env: Env,
  siteId: string,
  window: QueryWindow,
  filters: DashboardFilters,
  limit: number,
  targetVisitorId?: string,
  offset = 0,
  sort: ListSort<VisitorListSortKey> = DEFAULT_VISITOR_LIST_SORT,
  search?: string,
): Promise<VisitorRow[]> {
  const filter = buildVisitFilterSql(filters);
  const searchSql = buildJourneySearchSql(search);
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
  const targetClause = targetVisitorId
    ? whereClauseWithTarget(filter.clause, {
        column: "visitor_id",
        value: targetVisitorId,
      })
    : filter.clause;
  const sql = `
WITH
${buildVisitSourceCte()},
${buildCustomEventSourceCte()},
filtered_visits AS (
  SELECT *
  FROM visit_source
  ${targetClause}
)
${searchCte},
${buildVisitorAggregationSql({
  searchWhere,
  browserVersionExpression: browserMajorVersionExpr(),
  orderBy: visitorListOrderBy(sort),
  limitOffset: "LIMIT ? OFFSET ?",
})}`;
  return (
    await queryD1All<Record<string, unknown>>(env, sql, [
      ...visitSourceBindings(siteId, window),
      ...eventSourceBindings(siteId, window),
      ...(targetVisitorId ? [targetVisitorId] : []),
      ...filter.bindings,
      ...(searchSql?.bindings ?? []),
      limit,
      offset,
    ])
  ).map(mapVisitorRow);
}

export async function queryVisitorListPageFromD1(
  env: Env,
  siteId: string,
  window: QueryWindow,
  filters: DashboardFilters,
  options: {
    pageSize: number;
    sort: ListSort<VisitorListSortKey>;
    search?: string;
    cursor?: VisitorListCursor | null;
  },
): Promise<VisitorListPage> {
  const filter = buildVisitFilterSql(filters);
  const searchSql = buildJourneySearchSql(options.search);
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
${buildVisitSourceCte()},
${buildCustomEventSourceCte()},
filtered_visits AS (
  SELECT *
  FROM visit_source
  ${filter.clause}
)
${searchCte},
${buildVisitorAggregationSql({
  searchWhere,
  browserVersionExpression: browserMajorVersionExpr(),
  cursorWhere: cursor.clause,
  orderBy: visitorListOrderBy(options.sort),
  limitOffset: "LIMIT ?",
})}`;
  const records = await queryD1All<Record<string, unknown>>(env, sql, [
    ...visitSourceBindings(siteId, window),
    ...eventSourceBindings(siteId, window),
    ...filter.bindings,
    ...(searchSql?.bindings ?? []),
    ...cursor.bindings,
    options.pageSize + 1,
  ]);
  const hasMore = records.length > options.pageSize;
  const pageRecords = hasMore ? records.slice(0, options.pageSize) : records;
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
  filters: DashboardFilters,
  limit: number,
  target?: { type: "visitor" | "session"; value: string },
  offset = 0,
  sort: ListSort<SessionListSortKey> = DEFAULT_SESSION_LIST_SORT,
  search?: string,
): Promise<SessionRow[]> {
  const filter = buildVisitFilterSql(filters);
  const searchSql = buildJourneySearchSql(search);
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
  const targetColumn =
    target?.type === "visitor"
      ? "visitor_id"
      : target?.type === "session"
        ? "session_id"
        : "";
  const targetClause = target
    ? whereClauseWithTarget(filter.clause, {
        column: targetColumn,
        value: target.value,
      })
    : filter.clause;
  const sql = `
WITH
${buildVisitSourceCte()},
${buildCustomEventSourceCte()},
filtered_visits AS (
  SELECT *
  FROM visit_source
  ${targetClause}
)
${searchCte},
${buildSessionAggregationSql({
  searchWhere,
  browserVersionExpression: browserMajorVersionExpr(),
  orderBy: sessionListOrderBy(sort),
  limitOffset: "LIMIT ? OFFSET ?",
})}`;
  return (
    await queryD1All<Record<string, unknown>>(env, sql, [
      ...visitSourceBindings(siteId, window),
      ...eventSourceBindings(siteId, window),
      ...(target ? [target.value] : []),
      ...filter.bindings,
      ...(searchSql?.bindings ?? []),
      limit,
      offset,
    ])
  ).map(mapSessionRow);
}

export async function querySessionListPageFromD1(
  env: Env,
  siteId: string,
  window: QueryWindow,
  filters: DashboardFilters,
  options: {
    pageSize: number;
    sort: ListSort<SessionListSortKey>;
    search?: string;
    cursor?: SessionListCursor | null;
  },
): Promise<SessionListPage> {
  const filter = buildVisitFilterSql(filters);
  const searchSql = buildJourneySearchSql(options.search);
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
  const sql = `
WITH
${buildVisitSourceCte()},
${buildCustomEventSourceCte()},
filtered_visits AS (
  SELECT *
  FROM visit_source
  ${filter.clause}
)
${searchCte},
${buildSessionAggregationSql({
  searchWhere,
  browserVersionExpression: browserMajorVersionExpr(),
  cursorWhere: cursor.clause,
  orderBy: sessionListOrderBy(options.sort),
  limitOffset: "LIMIT ?",
})}`;
  const records = await queryD1All<Record<string, unknown>>(env, sql, [
    ...visitSourceBindings(siteId, window),
    ...eventSourceBindings(siteId, window),
    ...filter.bindings,
    ...(searchSql?.bindings ?? []),
    ...cursor.bindings,
    options.pageSize + 1,
  ]);
  const hasMore = records.length > options.pageSize;
  const pageRecords = hasMore ? records.slice(0, options.pageSize) : records;
  const rows = pageRecords.map(mapSessionRow);
  const lastRow = rows.at(-1);
  return {
    rows,
    nextCursor:
      hasMore && lastRow ? sessionCursorFromRow(lastRow, options.sort) : null,
  };
}

export async function queryJourneyEventsFromD1(
  env: Env,
  siteId: string,
  window: QueryWindow,
  filters: DashboardFilters,
  target: { type: "visitor" | "session"; value: string },
  limit: number,
): Promise<JourneyEventRow[]> {
  const filter = buildVisitFilterSql(filters);
  const targetColumn = target.type === "visitor" ? "visitor_id" : "session_id";
  const targetClause = whereClauseWithTarget(filter.clause, {
    column: targetColumn,
    value: target.value,
  });
  const sql = `
WITH
${buildVisitSourceCte()},
${buildCustomEventSourceCte()},
filtered_visits AS (
  SELECT *
  FROM visit_source
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
    fv.perf_inp_ms AS perfInpMs
  FROM event_source es
  INNER JOIN filtered_visits fv
    ON fv.visit_id = es.visit_id
)
SELECT *
FROM (
  SELECT * FROM page_events
  UNION ALL
  SELECT * FROM custom_event_rows
)
ORDER BY occurredAt DESC, id DESC
LIMIT ?
`;
  return (
    await queryD1All<Record<string, unknown>>(env, sql, [
      ...visitSourceBindings(siteId, window),
      ...eventSourceBindings(siteId, window),
      target.value,
      ...filter.bindings,
      limit,
    ])
  ).map(mapJourneyEventRow);
}
