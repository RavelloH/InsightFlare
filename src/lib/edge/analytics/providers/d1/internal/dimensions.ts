import type { ScopedDatasetSql } from "@/lib/edge/analytics/contract";
import {
  analyticsFilterRegistry,
  effectiveScopeForPagination,
  filterFingerprint,
  type QueryAudience,
} from "@/lib/edge/analytics/contract";
import type { Env } from "@/lib/edge/types";

import type {
  ClientDimensionTabs,
  DimensionRow,
  FilterDocument,
  GeoDimensionTabs,
  GeoTabRow,
  QueryWindow,
  ReferrerRow,
} from "./core";
import {
  buildVisitFilterSql,
  buildVisitSourceCte,
  cityValueExpr,
  geoTabLabel,
  queryD1All,
  regionValueExpr,
  visitSourceBindings,
} from "./core";
import type { D1ReadDiagnostics } from "./diagnostics";
import {
  decodePageCursor,
  encodePageCursor,
  hasExactKeys,
  type PageResult,
  pageResult,
  paginationBindingForWindow,
} from "./pagination";
import {
  scopedDatasetFor,
  scopedDatasetForUnpreparedReader,
} from "./scoped-dataset";

export interface DimensionAggregateCursor {
  /** The first two values are the concrete ORDER BY metrics. */
  readonly primary: number;
  readonly secondary: number;
  readonly value: string;
}

export interface SessionPathDimensionCursor {
  readonly views: number;
  readonly value: string;
  /** Present on cursors created for visitor-sorted session paths. */
  readonly visitors?: number;
}

export type DimensionPageSortKey = "views" | "sessions" | "visitors";

function dimensionSortKey(
  value: DimensionPageSortKey | undefined,
): DimensionPageSortKey {
  return value === "visitors" || value === "sessions" ? value : "views";
}

function dimensionSortDirection(
  value: "asc" | "desc" | undefined,
): "asc" | "desc" {
  return value === "asc" ? "asc" : "desc";
}

function dimensionSortColumns(sortBy: DimensionPageSortKey): {
  primary: DimensionPageSortKey;
  secondary: DimensionPageSortKey;
} {
  if (sortBy === "visitors") return { primary: "visitors", secondary: "views" };
  if (sortBy === "sessions") return { primary: "sessions", secondary: "views" };
  return { primary: "views", secondary: "sessions" };
}

function dimensionCursor(value: unknown): DimensionAggregateCursor | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const candidate = value as Record<string, unknown>;
  return hasExactKeys(candidate, ["primary", "secondary", "value"]) &&
    typeof candidate.primary === "number" &&
    Number.isFinite(candidate.primary) &&
    typeof candidate.secondary === "number" &&
    Number.isFinite(candidate.secondary) &&
    typeof candidate.value === "string"
    ? (candidate as unknown as DimensionAggregateCursor)
    : null;
}

function sessionPathDimensionCursor(
  value: unknown,
): SessionPathDimensionCursor | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const candidate = value as Record<string, unknown>;
  if (
    hasExactKeys(candidate, ["views", "value"]) &&
    typeof candidate.views === "number" &&
    Number.isFinite(candidate.views) &&
    typeof candidate.value === "string"
  ) {
    return candidate as unknown as SessionPathDimensionCursor;
  }
  return hasExactKeys(candidate, ["views", "visitors", "value"]) &&
    typeof candidate.views === "number" &&
    Number.isFinite(candidate.views) &&
    typeof candidate.visitors === "number" &&
    Number.isFinite(candidate.visitors) &&
    typeof candidate.value === "string"
    ? (candidate as unknown as SessionPathDimensionCursor)
    : null;
}

type SessionPathKind = "entry" | "exit";

function dimensionCursorBinding(
  operation: string,
  siteId: string,
  window: QueryWindow,
  filters: FilterDocument,
  selectExpr: string,
  search?: string,
  audience: QueryAudience = "private-dashboard",
  sortBy: DimensionPageSortKey = "views",
  sortDirection: "asc" | "desc" = "desc",
): Promise<string> {
  return paginationBindingForWindow(window, [
    `analytics-${operation}-v1`,
    audience,
    siteId,
    window.startMs,
    window.endExclusiveMs,
    window.timeZone,
    filterFingerprint(filters, analyticsFilterRegistry),
    effectiveScopeForPagination(filters),
    selectExpr,
    search?.trim().toLowerCase() ?? "",
    sortBy,
    sortDirection,
  ]);
}

function scopedVisitDataset(
  siteId: string,
  window: QueryWindow,
  filters: FilterDocument,
): ScopedDatasetSql | null {
  return scopedDatasetFor(siteId, window, filters);
}

export async function queryDimensionFromD1(
  env: Env,
  siteId: string,
  window: QueryWindow,
  filters: FilterDocument,
  limit: number,
  selectExpr: string,
  options?: {
    excludeEmpty?: boolean;
    search?: string;
    sortBy?: DimensionPageSortKey;
    sortDirection?: "asc" | "desc";
  },
  diagnostics?: D1ReadDiagnostics,
): Promise<DimensionRow[]> {
  const scopedDataset = scopedVisitDataset(siteId, window, filters);
  const filter = scopedDataset
    ? null
    : buildVisitFilterSql(filters, "visit_source", { window });
  const sortBy = dimensionSortKey(options?.sortBy);
  const sortDirection = dimensionSortDirection(options?.sortDirection);
  const { primary, secondary } = dimensionSortColumns(sortBy);
  const limitClause = limit > 0 ? "\nLIMIT ?" : "";
  const sql = `
WITH
${scopedDataset?.ctes ?? buildVisitSourceCte()},
filtered_visits AS (
  SELECT *
  FROM ${scopedDataset?.visitRelation ?? "visit_source"}
  ${filter?.clause ?? ""}
),
dimension_rollup AS (
  SELECT
    COALESCE(${selectExpr}, '') AS value,
    count(*) AS views,
    count(DISTINCT CASE WHEN session_id != '' THEN session_id ELSE NULL END) AS sessions,
    count(DISTINCT CASE WHEN visitor_id != '' THEN visitor_id ELSE NULL END) AS visitors
  FROM filtered_visits
  GROUP BY value
)
SELECT value, views, sessions, visitors
FROM dimension_rollup
${options?.excludeEmpty ? "WHERE TRIM(value) != ''" : ""}
${options?.search ? `${options?.excludeEmpty ? "AND" : "WHERE"} LOWER(value) LIKE ? ESCAPE '\\'` : ""}
ORDER BY ${primary} ${sortDirection}, ${secondary} ${sortDirection}, value ASC
${limitClause}
`;
  return (
    await queryD1All<Record<string, unknown>>(
      env,
      sql,
      [
        ...(scopedDataset
          ? scopedDataset.bindings.map((binding) => binding.value)
          : [
              ...visitSourceBindings(siteId, window),
              ...(filter?.bindings ?? []),
            ]),
        ...(options?.search
          ? [
              `%${options.search
                .trim()
                .toLowerCase()
                .replaceAll("\\", "\\\\")
                .replaceAll("%", "\\%")
                .replaceAll("_", "\\_")}%`,
            ]
          : []),
        ...(limit > 0 ? [limit] : []),
      ],
      diagnostics,
    )
  ).map((row) => ({
    value: String(row.value ?? ""),
    views: Number(row.views ?? 0),
    sessions: Number(row.sessions ?? 0),
    visitors: Number(row.visitors ?? 0),
  }));
}

/** Keyset-paginated variant for browsable dimension values. */
export async function queryDimensionPageFromD1(
  env: Env,
  siteId: string,
  window: QueryWindow,
  filters: FilterDocument,
  limit: number,
  selectExpr: string,
  options?: {
    excludeEmpty?: boolean;
    search?: string;
    sortBy?: DimensionPageSortKey;
    sortDirection?: "asc" | "desc";
  },
  cursor?: DimensionAggregateCursor | null,
  diagnostics?: D1ReadDiagnostics,
  audience: QueryAudience = "private-dashboard",
): Promise<PageResult<DimensionRow>> {
  const scopedDataset = scopedVisitDataset(siteId, window, filters);
  const sortBy = dimensionSortKey(options?.sortBy);
  const filter = scopedDataset
    ? null
    : buildVisitFilterSql(filters, "visit_source", { window });
  const sortDirection = dimensionSortDirection(options?.sortDirection);
  const { primary, secondary } = dimensionSortColumns(sortBy);
  const operator = sortDirection === "asc" ? ">" : "<";
  const cursorClause = cursor
    ? `
AND (
  ${primary} ${operator} ?
  OR (${primary} = ? AND ${secondary} ${operator} ?)
  OR (${primary} = ? AND ${secondary} = ? AND value > ?)
)`
    : "";
  const sql = `
WITH
${scopedDataset?.ctes ?? buildVisitSourceCte()},
filtered_visits AS (
  SELECT *
  FROM ${scopedDataset?.visitRelation ?? "visit_source"}
  ${filter?.clause ?? ""}
),
dimension_rollup AS (
  SELECT
    COALESCE(${selectExpr}, '') AS value,
    count(*) AS views,
    count(DISTINCT CASE WHEN session_id != '' THEN session_id ELSE NULL END) AS sessions,
    count(DISTINCT CASE WHEN visitor_id != '' THEN visitor_id ELSE NULL END) AS visitors
  FROM filtered_visits
  GROUP BY value
)
SELECT value, views, sessions, visitors
FROM dimension_rollup
WHERE 1 = 1
${options?.excludeEmpty ? "AND TRIM(value) != ''" : ""}
${options?.search ? "AND LOWER(value) LIKE ? ESCAPE '\\'" : ""}
${cursorClause}
ORDER BY views DESC, sessions DESC, value ASC
LIMIT ?
`;
  const orderedSql = sql.replace(
    "ORDER BY views DESC, sessions DESC, value ASC",
    `ORDER BY ${primary} ${sortDirection}, ${secondary} ${sortDirection}, value ASC`,
  );
  const cursorBindings = cursor
    ? [
        cursor.primary,
        cursor.primary,
        cursor.secondary,
        cursor.primary,
        cursor.secondary,
        cursor.value,
      ]
    : [];
  const rows = await queryD1All<Record<string, unknown>>(
    env,
    orderedSql,
    [
      ...(scopedDataset
        ? scopedDataset.bindings.map((binding) => binding.value)
        : [
            ...visitSourceBindings(siteId, window),
            ...(filter?.bindings ?? []),
          ]),
      ...(options?.search
        ? [
            `%${options.search
              .trim()
              .toLowerCase()
              .replaceAll("\\", "\\\\")
              .replaceAll("%", "\\%")
              .replaceAll("_", "\\_")}%`,
          ]
        : []),
      ...cursorBindings,
      limit + 1,
    ],
    diagnostics,
  );
  const mapped = rows.map((row) => ({
    value: String(row.value ?? ""),
    views: Number(row.views ?? 0),
    sessions: Number(row.sessions ?? 0),
    visitors: Number(row.visitors ?? 0),
  }));
  const page = pageResult(mapped, limit);
  const binding = await dimensionCursorBinding(
    "dimensions",
    siteId,
    window,
    filters,
    selectExpr,
    options?.search,
    audience,
    sortBy,
    sortDirection,
  );
  const nextCursor =
    page.hasMore && page.last
      ? await encodePageCursor(env, binding, {
          primary: page.last[primary],
          secondary: page.last[secondary],
          value: page.last.value,
        })
      : null;
  return {
    items: page.rows,
    pagination: {
      limit,
      returned: page.rows.length,
      hasMore: page.hasMore,
      nextCursor,
    },
  };
}

export async function decodeDimensionCursor(
  env: Env,
  siteId: string,
  window: QueryWindow,
  filters: FilterDocument,
  selectExpr: string,
  search?: string,
  cursor?: string | null,
  audience: QueryAudience = "private-dashboard",
  sortBy: DimensionPageSortKey = "views",
  sortDirection: "asc" | "desc" = "desc",
): Promise<DimensionAggregateCursor | null> {
  return decodePageCursor<DimensionAggregateCursor>(
    env,
    await dimensionCursorBinding(
      "dimensions",
      siteId,
      window,
      filters,
      selectExpr,
      search,
      audience,
      sortBy,
      sortDirection,
    ),
    cursor,
    "dimensions",
    dimensionCursor,
  );
}

export async function querySessionPathDimensionFromD1(
  env: Env,
  siteId: string,
  window: QueryWindow,
  filters: FilterDocument,
  limit: number,
  kind: "entry" | "exit",
  diagnostics?: D1ReadDiagnostics,
  search?: string,
  sortBy: DimensionPageSortKey = "views",
  sortDirection: "asc" | "desc" = "desc",
): Promise<DimensionRow[]> {
  const scopedDataset =
    scopedVisitDataset(siteId, window, filters) ??
    scopedDatasetForUnpreparedReader(
      "dimension",
      siteId,
      window,
      filters,
      "session",
    );
  const filter = scopedDataset
    ? null
    : buildVisitFilterSql(filters, "visit_source", { window });
  const effectiveSortBy = dimensionSortKey(sortBy);
  const effectiveSortDirection = sortDirection === "asc" ? "asc" : "desc";
  const primary = effectiveSortBy;
  const secondary = effectiveSortBy === "visitors" ? "views" : null;
  const limitClause = limit > 0 ? "\nLIMIT ?" : "";
  const boundaryRank = kind === "entry" ? "first_rank" : "latest_rank";
  const visitSource = buildVisitSourceCte().replace(
    "visit_source AS (",
    "visit_source AS MATERIALIZED (",
  );
  const sql = `
WITH
${scopedDataset?.ctes ?? visitSource},
filtered_visits AS MATERIALIZED (
  SELECT
    visitor_id,
    session_id,
    started_at,
    visit_id,
    TRIM(COALESCE(pathname, '')) AS pathname
  FROM ${scopedDataset?.visitRelation ?? "visit_source"}
  ${filter?.clause ?? ""}
),
ranked_session_visits AS (
  SELECT
    vs.session_id,
    vs.visitor_id,
    TRIM(COALESCE(vs.pathname, '')) AS pathname,
    ROW_NUMBER() OVER (
      PARTITION BY vs.session_id
      ORDER BY vs.started_at ASC, vs.visit_id ASC
    ) AS first_rank,
    ROW_NUMBER() OVER (
      PARTITION BY vs.session_id
      ORDER BY vs.started_at DESC, vs.visit_id DESC
    ) AS latest_rank
  FROM filtered_visits vs
  WHERE vs.session_id != '' AND TRIM(COALESCE(vs.pathname, '')) != ''
),
session_edges AS (
  SELECT
    session_id,
    MAX(CASE WHEN first_rank = 1 THEN visitor_id END) AS visitor_id,
    MAX(CASE WHEN ${boundaryRank} = 1 THEN pathname END) AS value
  FROM ranked_session_visits
  GROUP BY session_id
)
SELECT
  value,
  count(*) AS views,
  count(*) AS sessions,
  count(DISTINCT CASE WHEN visitor_id != '' THEN visitor_id ELSE NULL END) AS visitors
FROM session_edges
WHERE TRIM(value) != ''
${search ? "AND LOWER(value) LIKE ? ESCAPE '\\'" : ""}
GROUP BY value
ORDER BY ${primary} ${effectiveSortDirection}, ${secondary ? `${secondary} ${effectiveSortDirection}, ` : ""}value ASC
${limitClause}
`;
  return (
    await queryD1All<Record<string, unknown>>(
      env,
      sql,
      [
        ...(scopedDataset
          ? scopedDataset.bindings.map((binding) => binding.value)
          : [
              ...visitSourceBindings(siteId, window),
              ...(filter?.bindings ?? []),
            ]),
        ...(search
          ? [
              `%${search
                .trim()
                .toLowerCase()
                .replaceAll("\\", "\\\\")
                .replaceAll("%", "\\%")
                .replaceAll("_", "\\_")}%`,
            ]
          : []),
        ...(limit > 0 ? [limit] : []),
      ],
      diagnostics,
    )
  ).map((row) => ({
    value: String(row.value ?? ""),
    views: Number(row.views ?? 0),
    sessions: Number(row.sessions ?? 0),
    visitors: Number(row.visitors ?? 0),
  }));
}

export async function querySessionPathDimensionPageFromD1(
  env: Env,
  siteId: string,
  window: QueryWindow,
  filters: FilterDocument,
  limit: number,
  kind: SessionPathKind,
  diagnostics?: D1ReadDiagnostics,
  search?: string,
  cursor?: SessionPathDimensionCursor | null,
  audience: QueryAudience = "private-dashboard",
  sortBy: DimensionPageSortKey = "views",
  sortDirection: "asc" | "desc" = "desc",
): Promise<PageResult<DimensionRow>> {
  const scopedDataset =
    scopedVisitDataset(siteId, window, filters) ??
    scopedDatasetForUnpreparedReader(
      "dimension",
      siteId,
      window,
      filters,
      "session",
    );
  const filter = scopedDataset
    ? null
    : buildVisitFilterSql(filters, "visit_source", { window });
  const effectiveSortBy = dimensionSortKey(sortBy);
  const effectiveSortDirection = sortDirection === "asc" ? "asc" : "desc";
  const boundaryRank = kind === "entry" ? "first_rank" : "latest_rank";
  const visitSource = buildVisitSourceCte().replace(
    "visit_source AS (",
    "visit_source AS MATERIALIZED (",
  );
  const searchClause = search ? "AND LOWER(value) LIKE ? ESCAPE '\\'" : "";
  const operator = effectiveSortDirection === "asc" ? ">" : "<";
  const cursorClause = cursor
    ? effectiveSortBy === "visitors"
      ? `
AND (
  visitors ${operator} ?
  OR (visitors = ? AND views ${operator} ?)
  OR (visitors = ? AND views = ? AND value > ?)
)`
      : `AND (${effectiveSortBy} ${operator} ? OR (${effectiveSortBy} = ? AND value > ?))`
    : "";
  const orderBy =
    effectiveSortBy === "visitors"
      ? `ORDER BY visitors ${effectiveSortDirection}, views ${effectiveSortDirection}, value ASC`
      : `ORDER BY ${effectiveSortBy} ${effectiveSortDirection}, value ASC`;
  const sql = `
WITH
${scopedDataset?.ctes ?? visitSource},
filtered_visits AS MATERIALIZED (
  SELECT visitor_id, session_id, started_at, visit_id,
    TRIM(COALESCE(pathname, '')) AS pathname
  FROM ${scopedDataset?.visitRelation ?? "visit_source"}
  ${filter?.clause ?? ""}
),
ranked_session_visits AS (
  SELECT
    vs.session_id,
    vs.visitor_id,
    TRIM(COALESCE(vs.pathname, '')) AS pathname,
    ROW_NUMBER() OVER (
      PARTITION BY vs.session_id
      ORDER BY vs.started_at ASC, vs.visit_id ASC
    ) AS first_rank,
    ROW_NUMBER() OVER (
      PARTITION BY vs.session_id
      ORDER BY vs.started_at DESC, vs.visit_id DESC
    ) AS latest_rank
  FROM filtered_visits vs
  WHERE vs.session_id != '' AND TRIM(COALESCE(vs.pathname, '')) != ''
),
session_edges AS (
  SELECT
    session_id,
    MAX(CASE WHEN first_rank = 1 THEN visitor_id END) AS visitor_id,
    MAX(CASE WHEN ${boundaryRank} = 1 THEN pathname END) AS value
  FROM ranked_session_visits
  GROUP BY session_id
),
session_path_rollup AS (
  SELECT
    value,
    count(*) AS views,
    count(*) AS sessions,
    count(DISTINCT CASE WHEN visitor_id != '' THEN visitor_id ELSE NULL END) AS visitors
  FROM session_edges
  WHERE TRIM(value) != ''
  GROUP BY value
)
SELECT
  value,
  views,
  sessions,
  visitors
FROM session_path_rollup
WHERE 1 = 1
${searchClause}
${cursorClause}
${orderBy}
LIMIT ?
`;
  const searchBindings = search
    ? [
        `%${search
          .trim()
          .toLowerCase()
          .replaceAll("\\", "\\\\")
          .replaceAll("%", "\\%")
          .replaceAll("_", "\\_")}%`,
      ]
    : [];
  const cursorBindings = cursor
    ? effectiveSortBy === "visitors"
      ? [
          cursor.visitors ?? cursor.views,
          cursor.visitors ?? cursor.views,
          cursor.views,
          cursor.visitors ?? cursor.views,
          cursor.views,
          cursor.value,
        ]
      : [cursor.views, cursor.views, cursor.value]
    : [];
  const rows = await queryD1All<Record<string, unknown>>(
    env,
    sql,
    [
      ...(scopedDataset
        ? scopedDataset.bindings.map((binding) => binding.value)
        : [
            ...visitSourceBindings(siteId, window),
            ...(filter?.bindings ?? []),
          ]),
      ...searchBindings,
      ...cursorBindings,
      limit + 1,
    ],
    diagnostics,
  );
  const mapped = rows.map((row) => ({
    value: String(row.value ?? ""),
    views: Number(row.views ?? 0),
    sessions: Number(row.sessions ?? 0),
    visitors: Number(row.visitors ?? 0),
  }));
  const page = pageResult(mapped, limit);
  const binding = await paginationBindingForWindow(window, [
    `analytics-session-${kind}-v1`,
    siteId,
    window.startMs,
    window.endExclusiveMs,
    window.timeZone,
    filterFingerprint(filters, analyticsFilterRegistry),
    effectiveScopeForPagination(filters),
    search?.trim().toLowerCase() ?? "",
    audience,
    effectiveSortBy,
    effectiveSortDirection,
  ]);
  const nextCursor =
    page.hasMore && page.last
      ? await encodePageCursor(
          env,
          binding,
          effectiveSortBy === "visitors"
            ? {
                views: page.last.views,
                visitors: page.last.visitors,
                value: page.last.value,
              }
            : { views: page.last.views, value: page.last.value },
        )
      : null;
  return {
    items: page.rows,
    pagination: {
      limit,
      returned: page.rows.length,
      hasMore: page.hasMore,
      nextCursor,
    },
  };
}

export async function decodeSessionPathDimensionCursor(
  env: Env,
  siteId: string,
  window: QueryWindow,
  filters: FilterDocument,
  kind: SessionPathKind,
  search?: string,
  cursor?: string | null,
  audience: QueryAudience = "private-dashboard",
  sortBy: DimensionPageSortKey = "views",
  sortDirection: "asc" | "desc" = "desc",
): Promise<SessionPathDimensionCursor | null> {
  const effectiveSortBy = dimensionSortKey(sortBy);
  const effectiveSortDirection = sortDirection === "asc" ? "asc" : "desc";
  const decoded = await decodePageCursor<SessionPathDimensionCursor>(
    env,
    await paginationBindingForWindow(window, [
      `analytics-session-${kind}-v1`,
      siteId,
      window.startMs,
      window.endExclusiveMs,
      window.timeZone,
      filterFingerprint(filters, analyticsFilterRegistry),
      effectiveScopeForPagination(filters),
      search?.trim().toLowerCase() ?? "",
      audience,
      effectiveSortBy,
      effectiveSortDirection,
    ]),
    cursor,
    "session-dimension",
    sessionPathDimensionCursor,
  );
  return effectiveSortBy === "visitors" &&
    decoded &&
    decoded.visitors === undefined
    ? null
    : decoded;
}

export async function queryVisitDimensionFromD1(
  env: Env,
  siteId: string,
  window: QueryWindow,
  filters: FilterDocument,
  limit: number,
  selectExpr: string,
  options?: {
    excludeEmpty?: boolean;
    search?: string;
    sortBy?: DimensionPageSortKey;
    sortDirection?: "asc" | "desc";
  },
  diagnostics?: D1ReadDiagnostics,
): Promise<DimensionRow[]> {
  return queryDimensionFromD1(
    env,
    siteId,
    window,
    filters,
    limit,
    selectExpr,
    options,
    diagnostics,
  );
}

export async function querySessionBoundaryDimensionFromD1(
  env: Env,
  siteId: string,
  window: QueryWindow,
  filters: FilterDocument,
  limit: number,
  kind: "entry" | "exit",
  diagnostics?: D1ReadDiagnostics,
  search?: string,
  sortBy: DimensionPageSortKey = "views",
  sortDirection: "asc" | "desc" = "desc",
): Promise<DimensionRow[]> {
  return querySessionPathDimensionFromD1(
    env,
    siteId,
    window,
    filters,
    limit,
    kind,
    diagnostics,
    search,
    sortBy,
    sortDirection,
  );
}

export async function queryPageTabsFromD1(
  env: Env,
  siteId: string,
  window: QueryWindow,
  filters: FilterDocument,
  limit: number,
): Promise<{
  path: DimensionRow[];
  title: DimensionRow[];
  hostname: DimensionRow[];
  entry: DimensionRow[];
  exit: DimensionRow[];
}> {
  const preparedDataset = scopedVisitDataset(siteId, window, filters);
  const expandedDataset =
    preparedDataset ??
    scopedDatasetForUnpreparedReader(
      "pages",
      siteId,
      window,
      filters,
      "session",
    );
  const scopedDataset = preparedDataset ?? expandedDataset;
  const filter = preparedDataset
    ? null
    : buildVisitFilterSql(filters, "rv", { window });
  const observationVisitRelation = preparedDataset
    ? preparedDataset.visitRelation
    : expandedDataset
      ? "scope_raw_visits"
      : "visit_source";
  const edgeVisitRelation =
    preparedDataset || !expandedDataset
      ? "filtered_visits"
      : expandedDataset.visitRelation;
  const visitSource = buildVisitSourceCte().replace(
    "visit_source AS (",
    "visit_source AS MATERIALIZED (",
  );
  const sql = `
WITH
${scopedDataset?.ctes ?? visitSource},
filtered_visits AS MATERIALIZED (
  SELECT
    visitor_id,
    session_id,
    started_at,
    visit_id,
    TRIM(COALESCE(pathname, '')) AS pathname,
    TRIM(COALESCE(title, '')) AS title,
    TRIM(COALESCE(hostname, '')) AS hostname
  FROM ${observationVisitRelation} rv
  ${filter?.clause ?? ""}
),
ranked_session_visits AS (
  SELECT
    vs.session_id,
    vs.visitor_id,
    TRIM(COALESCE(vs.pathname, '')) AS pathname,
    ROW_NUMBER() OVER (
      PARTITION BY vs.session_id
      ORDER BY vs.started_at ASC, vs.visit_id ASC
    ) AS first_rank,
    ROW_NUMBER() OVER (
      PARTITION BY vs.session_id
      ORDER BY vs.started_at DESC, vs.visit_id DESC
    ) AS latest_rank
  FROM ${edgeVisitRelation} vs
  WHERE vs.session_id != '' AND TRIM(COALESCE(vs.pathname, '')) != ''
),
session_edges AS (
  SELECT
    session_id,
    MAX(CASE WHEN first_rank = 1 THEN visitor_id END) AS visitor_id,
    MAX(CASE WHEN first_rank = 1 THEN pathname END) AS entry,
    MAX(CASE WHEN latest_rank = 1 THEN pathname END) AS exit
  FROM ranked_session_visits
  GROUP BY session_id
),
card_rows AS (
  SELECT
    'path' AS card_type,
    pathname AS value,
    COUNT(*) AS views,
    COUNT(DISTINCT CASE WHEN session_id != '' THEN session_id END) AS sessions,
    COUNT(DISTINCT CASE WHEN visitor_id != '' THEN visitor_id END) AS visitors
  FROM filtered_visits
  WHERE pathname != ''
  GROUP BY pathname
  UNION ALL
  SELECT
    'title' AS card_type,
    title AS value,
    COUNT(*) AS views,
    COUNT(DISTINCT CASE WHEN session_id != '' THEN session_id END) AS sessions,
    COUNT(DISTINCT CASE WHEN visitor_id != '' THEN visitor_id END) AS visitors
  FROM filtered_visits
  WHERE title != ''
  GROUP BY title
  UNION ALL
  SELECT
    'hostname' AS card_type,
    hostname AS value,
    COUNT(*) AS views,
    COUNT(DISTINCT CASE WHEN session_id != '' THEN session_id END) AS sessions,
    COUNT(DISTINCT CASE WHEN visitor_id != '' THEN visitor_id END) AS visitors
  FROM filtered_visits
  WHERE hostname != ''
  GROUP BY hostname
  UNION ALL
  SELECT
    'entry' AS card_type,
    entry AS value,
    COUNT(*) AS views,
    COUNT(*) AS sessions,
    COUNT(DISTINCT CASE WHEN visitor_id != '' THEN visitor_id END) AS visitors
  FROM session_edges
  WHERE entry != ''
  GROUP BY entry
  UNION ALL
  SELECT
    'exit' AS card_type,
    exit AS value,
    COUNT(*) AS views,
    COUNT(*) AS sessions,
    COUNT(DISTINCT CASE WHEN visitor_id != '' THEN visitor_id END) AS visitors
  FROM session_edges
  WHERE exit != ''
  GROUP BY exit
),
ranked_cards AS (
  SELECT
    card_type,
    value,
    views,
    sessions,
    visitors,
    ROW_NUMBER() OVER (
      PARTITION BY card_type
      ORDER BY views DESC, sessions DESC, value ASC
    ) AS card_rank
  FROM card_rows
)
SELECT card_type AS cardType, value, views, sessions, visitors
FROM ranked_cards
WHERE card_rank <= ?
ORDER BY card_type ASC, card_rank ASC
`;
  const rows = await queryD1All<Record<string, unknown>>(env, sql, [
    ...(scopedDataset
      ? scopedDataset.bindings.map((binding) => binding.value)
      : [...visitSourceBindings(siteId, window)]),
    ...(filter?.bindings ?? []),
    limit,
  ]);
  const byCard = new Map<string, DimensionRow[]>();
  for (const row of rows) {
    const card = String(row.cardType ?? "");
    const values = byCard.get(card) ?? [];
    values.push({
      value: String(row.value ?? ""),
      views: Number(row.views ?? 0),
      sessions: Number(row.sessions ?? 0),
      visitors: Number(row.visitors ?? 0),
    });
    byCard.set(card, values);
  }
  return {
    path: byCard.get("path") ?? [],
    title: byCard.get("title") ?? [],
    hostname: byCard.get("hostname") ?? [],
    entry: byCard.get("entry") ?? [],
    exit: byCard.get("exit") ?? [],
  };
}

export async function queryReferrersFromD1(
  env: Env,
  siteId: string,
  window: QueryWindow,
  filters: FilterDocument,
  limit: number,
  includeFullUrl: boolean,
  diagnostics?: D1ReadDiagnostics,
  search?: string,
): Promise<ReferrerRow[]> {
  const scopedDataset = scopedVisitDataset(siteId, window, filters);
  const filter = scopedDataset
    ? null
    : buildVisitFilterSql(filters, "visit_source", { window });
  const keyExpr = includeFullUrl ? "referrer_url" : "referrer_host";
  const sql = `
WITH
${scopedDataset?.ctes ?? buildVisitSourceCte()},
filtered_visits AS (
  SELECT *
  FROM ${scopedDataset?.visitRelation ?? "visit_source"}
  ${filter?.clause ?? ""}
)
SELECT
  COALESCE(${keyExpr}, '') AS referrer,
  count(*) AS views,
  count(DISTINCT CASE WHEN session_id != '' THEN session_id ELSE NULL END) AS sessions,
  count(DISTINCT CASE WHEN visitor_id != '' THEN visitor_id ELSE NULL END) AS visitors
FROM filtered_visits
GROUP BY referrer
${search ? "HAVING LOWER(referrer) LIKE ? ESCAPE '\\'" : ""}
ORDER BY views DESC, sessions DESC, referrer ASC
LIMIT ?
`;
  return (
    await queryD1All<Record<string, unknown>>(
      env,
      sql,
      [
        ...(scopedDataset
          ? scopedDataset.bindings.map((binding) => binding.value)
          : [
              ...visitSourceBindings(siteId, window),
              ...(filter?.bindings ?? []),
            ]),
        ...(search
          ? [
              `%${search
                .trim()
                .toLowerCase()
                .replaceAll("\\", "\\\\")
                .replaceAll("%", "\\%")
                .replaceAll("_", "\\_")}%`,
            ]
          : []),
        limit,
      ],
      diagnostics,
    )
  ).map((row) => ({
    referrer: String(row.referrer ?? ""),
    views: Number(row.views ?? 0),
    sessions: Number(row.sessions ?? 0),
    visitors: Number(row.visitors ?? 0),
  }));
}

export async function queryOverviewClientDimensionsFromD1(
  env: Env,
  siteId: string,
  window: QueryWindow,
  filters: FilterDocument,
  limit: number,
): Promise<ClientDimensionTabs> {
  const scopedDataset = scopedVisitDataset(siteId, window, filters);
  const filter = scopedDataset
    ? null
    : buildVisitFilterSql(filters, "visit_source", { window });
  const sql = `
WITH
${scopedDataset?.ctes ?? buildVisitSourceCte()},
filtered_visits AS MATERIALIZED (
  SELECT
    session_id,
    TRIM(COALESCE(browser, '')) AS browser,
    TRIM(CASE
      WHEN TRIM(COALESCE(os, '')) != '' AND TRIM(COALESCE(os_version, '')) != ''
        THEN TRIM(os) || ' ' || TRIM(os_version)
      WHEN TRIM(COALESCE(os, '')) != '' THEN TRIM(os)
      ELSE TRIM(COALESCE(os_version, ''))
    END) AS osVersion,
    TRIM(COALESCE(device_type, '')) AS deviceType,
    TRIM(COALESCE(language, '')) AS language,
    CASE
      WHEN screen_width > 0 AND screen_height > 0
        THEN CAST(screen_width AS INTEGER) || 'x' || CAST(screen_height AS INTEGER)
      ELSE ''
    END AS screenSize
  FROM ${scopedDataset?.visitRelation ?? "visit_source"}
  ${filter?.clause ?? ""}
),
card_rows AS (
  SELECT 'browser' AS card_type, browser AS value, COUNT(*) AS views,
    COUNT(DISTINCT CASE WHEN session_id != '' THEN session_id END) AS sessions
  FROM filtered_visits WHERE browser != '' GROUP BY browser
  UNION ALL
  SELECT 'osVersion', osVersion, COUNT(*),
    COUNT(DISTINCT CASE WHEN session_id != '' THEN session_id END)
  FROM filtered_visits WHERE osVersion != '' GROUP BY osVersion
  UNION ALL
  SELECT 'deviceType', deviceType, COUNT(*),
    COUNT(DISTINCT CASE WHEN session_id != '' THEN session_id END)
  FROM filtered_visits WHERE deviceType != '' GROUP BY deviceType
  UNION ALL
  SELECT 'language', language, COUNT(*),
    COUNT(DISTINCT CASE WHEN session_id != '' THEN session_id END)
  FROM filtered_visits WHERE language != '' GROUP BY language
  UNION ALL
  SELECT 'screenSize', screenSize, COUNT(*),
    COUNT(DISTINCT CASE WHEN session_id != '' THEN session_id END)
  FROM filtered_visits WHERE screenSize != '' GROUP BY screenSize
),
ranked_cards AS (
  SELECT *, ROW_NUMBER() OVER (
    PARTITION BY card_type ORDER BY views DESC, sessions DESC, value ASC
  ) AS card_rank
  FROM card_rows
)
SELECT card_type AS cardType, value, views, sessions
FROM ranked_cards
WHERE card_rank <= ?
ORDER BY card_type ASC, card_rank ASC
`;
  const rows = await queryD1All<Record<string, unknown>>(env, sql, [
    ...(scopedDataset
      ? scopedDataset.bindings.map((binding) => binding.value)
      : [...visitSourceBindings(siteId, window), ...(filter?.bindings ?? [])]),
    limit,
  ]);
  const byCard = new Map<string, DimensionRow[]>();
  for (const row of rows) {
    const values = byCard.get(String(row.cardType ?? "")) ?? [];
    values.push({
      value: String(row.value ?? ""),
      views: Number(row.views ?? 0),
      sessions: Number(row.sessions ?? 0),
      visitors: 0,
    });
    byCard.set(String(row.cardType ?? ""), values);
  }
  return {
    browser: byCard.get("browser") ?? [],
    osVersion: byCard.get("osVersion") ?? [],
    deviceType: byCard.get("deviceType") ?? [],
    language: byCard.get("language") ?? [],
    screenSize: byCard.get("screenSize") ?? [],
  };
}

export async function queryOverviewGeoDimensionsFromD1(
  env: Env,
  siteId: string,
  window: QueryWindow,
  filters: FilterDocument,
  limit: number,
): Promise<GeoDimensionTabs> {
  const scopedDataset = scopedVisitDataset(siteId, window, filters);
  const filter = scopedDataset
    ? null
    : buildVisitFilterSql(filters, "visit_source", { window });
  const cardSources = [
    `SELECT 'country' AS card_type, country AS value, COUNT(*) AS views,
    COUNT(DISTINCT CASE WHEN session_id != '' THEN session_id END) AS sessions,
    COUNT(DISTINCT CASE WHEN visitor_id != '' THEN visitor_id END) AS visitors
  FROM filtered_visits WHERE country != '' GROUP BY country`,
    `SELECT 'region', region, COUNT(*),
    COUNT(DISTINCT CASE WHEN session_id != '' THEN session_id END),
    COUNT(DISTINCT CASE WHEN visitor_id != '' THEN visitor_id END)
  FROM filtered_visits WHERE region != '' GROUP BY region`,
    `SELECT 'city', city, COUNT(*),
    COUNT(DISTINCT CASE WHEN session_id != '' THEN session_id END),
    COUNT(DISTINCT CASE WHEN visitor_id != '' THEN visitor_id END)
  FROM filtered_visits WHERE city != '' GROUP BY city`,
    `SELECT 'continent', continent, COUNT(*),
    COUNT(DISTINCT CASE WHEN session_id != '' THEN session_id END),
    COUNT(DISTINCT CASE WHEN visitor_id != '' THEN visitor_id END)
  FROM filtered_visits WHERE continent != '' GROUP BY continent`,
    `SELECT 'timezone', timezone, COUNT(*),
    COUNT(DISTINCT CASE WHEN session_id != '' THEN session_id END),
    COUNT(DISTINCT CASE WHEN visitor_id != '' THEN visitor_id END)
  FROM filtered_visits WHERE timezone != '' GROUP BY timezone`,
    `SELECT 'organization', organization, COUNT(*),
    COUNT(DISTINCT CASE WHEN session_id != '' THEN session_id END),
    COUNT(DISTINCT CASE WHEN visitor_id != '' THEN visitor_id END)
  FROM filtered_visits WHERE organization != '' GROUP BY organization`,
  ];
  // D1 currently rejects compound SELECT statements with more than five terms.
  const maxCompoundTerms = 5;
  const rows = (
    await Promise.all(
      Array.from(
        { length: Math.ceil(cardSources.length / maxCompoundTerms) },
        (_, index) =>
          queryD1All<Record<string, unknown>>(
            env,
            `
WITH
${scopedDataset?.ctes ?? buildVisitSourceCte()},
filtered_visits AS MATERIALIZED (
  SELECT
    session_id,
    visitor_id,
    TRIM(COALESCE(country, '')) AS country,
    ${regionValueExpr()} AS region,
    ${cityValueExpr()} AS city,
    TRIM(COALESCE(continent, '')) AS continent,
    TRIM(COALESCE(timezone, '')) AS timezone,
    TRIM(COALESCE(as_organization, '')) AS organization
  FROM ${scopedDataset?.visitRelation ?? "visit_source"}
  ${filter?.clause ?? ""}
),
card_rows AS (
${cardSources
  .slice(index * maxCompoundTerms, (index + 1) * maxCompoundTerms)
  .join("\n  UNION ALL\n")}
),
ranked_cards AS (
  SELECT *, ROW_NUMBER() OVER (
    PARTITION BY card_type
    ORDER BY views DESC, sessions DESC, visitors DESC, value ASC
  ) AS card_rank
  FROM card_rows
)
SELECT card_type AS cardType, value, views, sessions, visitors
FROM ranked_cards
WHERE card_rank <= ?
ORDER BY card_type ASC, card_rank ASC
`,
            [
              ...(scopedDataset
                ? scopedDataset.bindings.map((binding) => binding.value)
                : [
                    ...visitSourceBindings(siteId, window),
                    ...(filter?.bindings ?? []),
                  ]),
              limit,
            ],
          ),
      ),
    )
  ).flat();
  const byCard = new Map<string, GeoTabRow[]>();
  for (const row of rows) {
    const card = String(row.cardType ?? "");
    const value = String(row.value ?? "");
    const values = byCard.get(card) ?? [];
    values.push({
      value,
      label: geoTabLabel(value, card as Parameters<typeof geoTabLabel>[1]),
      views: Number(row.views ?? 0),
      sessions: Number(row.sessions ?? 0),
      visitors: Number(row.visitors ?? 0),
    });
    byCard.set(card, values);
  }
  return {
    country: byCard.get("country") ?? [],
    region: byCard.get("region") ?? [],
    city: byCard.get("city") ?? [],
    continent: byCard.get("continent") ?? [],
    timezone: byCard.get("timezone") ?? [],
    organization: byCard.get("organization") ?? [],
  };
}
