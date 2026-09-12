import type {
  FilterDocument,
  OverviewTableMetric,
  OverviewTableSortBy,
  QueryAudience,
  SortDirection,
} from "@/lib/edge/analytics/contract";
import {
  analyticsFilterRegistry,
  effectiveScopeForPagination,
  filterFingerprint,
} from "@/lib/edge/analytics/contract";
import type { Env } from "@/lib/edge/types";

import {
  buildVisitFilterSql,
  buildVisitSourceCte,
  queryD1All,
  visitSourceBindings,
} from "./core";
import type { DimensionRow, QueryWindow } from "./core-types";
import type { D1ReadDiagnostics } from "./diagnostics";
import {
  decodePageCursor,
  encodePageCursor,
  hasExactKeys,
  pageResult,
  paginationBindingForWindow,
} from "./pagination";
import { scopedDatasetFor } from "./scoped-dataset";

export interface ComparisonDimensionCursor {
  readonly sortClass: number;
  readonly primary: number;
  readonly secondary: number;
  readonly key: string;
}

function decodeComparisonCursor(
  value: unknown,
): ComparisonDimensionCursor | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const candidate = value as Record<string, unknown>;
  return hasExactKeys(candidate, [
    "sortClass",
    "primary",
    "secondary",
    "key",
  ]) &&
    typeof candidate.sortClass === "number" &&
    Number.isFinite(candidate.sortClass) &&
    typeof candidate.primary === "number" &&
    Number.isFinite(candidate.primary) &&
    typeof candidate.secondary === "number" &&
    Number.isFinite(candidate.secondary) &&
    typeof candidate.key === "string"
    ? (candidate as unknown as ComparisonDimensionCursor)
    : null;
}

interface ComparisonDimensionSide {
  readonly ctes: string;
  readonly relation: string;
  readonly filterClause: string;
  readonly bindings: readonly (string | number | null)[];
}

function renamedScopedDataset(
  dataset: ReturnType<typeof scopedDatasetFor>,
  prefix: string,
): ComparisonDimensionSide | null {
  if (!dataset) return null;
  const rename = (value: string) =>
    value
      .replace(/\bscope_[A-Za-z0-9_]*/g, (name) => `${prefix}_${name}`)
      .replace(/\bvisit_source\b/g, `${prefix}_visit_source`);
  return {
    ctes: rename(dataset.ctes),
    relation: rename(dataset.visitRelation),
    filterClause: "",
    bindings: dataset.bindings.map((binding) => binding.value),
  };
}

function comparisonSide(
  siteId: string,
  window: QueryWindow,
  filters: FilterDocument,
  prefix: string,
): ComparisonDimensionSide {
  const scoped = renamedScopedDataset(
    scopedDatasetFor(siteId, window, filters),
    prefix,
  );
  if (scoped) return scoped;
  const relation = `${prefix}_visit_source`;
  const filter = buildVisitFilterSql(filters, relation, { window });
  return {
    ctes: buildVisitSourceCte().replace("visit_source", relation),
    relation,
    filterClause: filter.clause,
    bindings: [...visitSourceBindings(siteId, window), ...filter.bindings],
  };
}

function relativeSql(current: string, reference: string): string {
  return `CASE WHEN ${reference} = 0 THEN CASE WHEN ${current} = 0 THEN 0.0 ELSE NULL END ELSE (${current} - ${reference}) * 1.0 / ${reference} END`;
}

function comparisonOrdering(
  metric: OverviewTableMetric,
  sortBy: OverviewTableSortBy,
  direction: SortDirection,
): { expression: string; cursorPredicate: string } {
  const metricColumn =
    metric === "visitors"
      ? "visitors"
      : metric === "sessions"
        ? "sessions"
        : "views";
  const source =
    sortBy === "reference"
      ? `reference_${metricColumn}`
      : sortBy === "change"
        ? "change_relative"
        : `current_${metricColumn}`;
  if (sortBy !== "change") {
    const secondary =
      sortBy === "reference"
        ? `current_${metricColumn}`
        : `reference_${metricColumn}`;
    const operator = direction === "asc" ? ">" : "<";
    return {
      expression: `${source} ${direction}, ${secondary} ${direction}, key ASC`,
      cursorPredicate: `(
        ${source} ${operator} ?
        OR (${source} = ? AND ${secondary} ${operator} ?)
        OR (${source} = ? AND ${secondary} = ? AND key > ?)
      )`,
    };
  }

  const classDirection = direction === "asc" ? "asc" : "desc";
  const classOperator = direction === "asc" ? ">" : "<";
  const valueOperator = direction === "asc" ? ">" : "<";
  return {
    expression: `change_class ${classDirection}, change_relative ${classDirection}, key ASC`,
    cursorPredicate: `(
      change_class ${classOperator} ?
      OR (change_class = ? AND (
        change_relative ${valueOperator} ?
        OR (change_relative = ? AND key > ?)
      ))
    )`,
  };
}

function comparisonCursorBinding(
  siteId: string,
  current: QueryWindow,
  currentFilters: FilterDocument,
  reference: QueryWindow,
  referenceFilters: FilterDocument,
  selectExpr: string,
  search: string | undefined,
  audience: QueryAudience,
  metric: OverviewTableMetric,
  sortBy: OverviewTableSortBy,
  direction: SortDirection,
): Promise<string> {
  return paginationBindingForWindow(current, [
    "analytics-overview-table-comparison-v1",
    audience,
    siteId,
    current.startMs,
    current.endExclusiveMs,
    current.timeZone,
    reference.startMs,
    reference.endExclusiveMs,
    reference.timeZone,
    filterFingerprint(currentFilters, analyticsFilterRegistry),
    effectiveScopeForPagination(currentFilters),
    filterFingerprint(referenceFilters, analyticsFilterRegistry),
    effectiveScopeForPagination(referenceFilters),
    selectExpr,
    search?.trim().toLowerCase() ?? "",
    metric,
    sortBy,
    direction,
  ]);
}

export async function decodeComparisonDimensionCursor(
  env: Env,
  siteId: string,
  current: QueryWindow,
  currentFilters: FilterDocument,
  reference: QueryWindow,
  referenceFilters: FilterDocument,
  selectExpr: string,
  search: string | undefined,
  cursor: string | null | undefined,
  audience: QueryAudience,
  metric: OverviewTableMetric,
  sortBy: OverviewTableSortBy,
  direction: SortDirection,
): Promise<ComparisonDimensionCursor | null> {
  return decodePageCursor(
    env,
    await comparisonCursorBinding(
      siteId,
      current,
      currentFilters,
      reference,
      referenceFilters,
      selectExpr,
      search,
      audience,
      metric,
      sortBy,
      direction,
    ),
    cursor,
    "overview-table-comparison",
    decodeComparisonCursor,
  );
}

export async function queryComparisonDimensionPageFromD1(
  env: Env,
  siteId: string,
  current: QueryWindow,
  currentFilters: FilterDocument,
  reference: QueryWindow,
  referenceFilters: FilterDocument,
  limit: number,
  selectExpr: string,
  options: {
    metric: OverviewTableMetric;
    sortBy: OverviewTableSortBy;
    direction: SortDirection;
    search?: string;
  },
  cursor: ComparisonDimensionCursor | null,
  audience: QueryAudience,
  diagnostics?: D1ReadDiagnostics,
): Promise<{
  readonly items: readonly (DimensionRow & {
    readonly key: string;
    readonly reference: {
      readonly views: number;
      readonly sessions: number;
      readonly visitors: number;
    };
    readonly change: {
      readonly views: {
        readonly absolute: number;
        readonly relative: number | null;
      };
      readonly sessions: {
        readonly absolute: number;
        readonly relative: number | null;
      };
      readonly visitors: {
        readonly absolute: number;
        readonly relative: number | null;
      };
    };
  })[];
  readonly pagination: {
    readonly limit: number;
    readonly returned: number;
    readonly hasMore: boolean;
    readonly nextCursor: string | null;
  };
}> {
  const currentSide = comparisonSide(
    siteId,
    current,
    currentFilters,
    "current",
  );
  const referenceSide = comparisonSide(
    siteId,
    reference,
    referenceFilters,
    "reference",
  );
  const searchClause = options.search?.trim()
    ? "AND LOWER(key) LIKE ? ESCAPE '\\'"
    : "";
  const ordering = comparisonOrdering(
    options.metric,
    options.sortBy,
    options.direction,
  );
  const cursorClause = cursor ? `AND ${ordering.cursorPredicate}` : "";
  const currentViews = "current_views";
  const referenceViews = "reference_views";
  const currentVisitors = "current_visitors";
  const referenceVisitors = "reference_visitors";
  const currentSessions = "current_sessions";
  const referenceSessions = "reference_sessions";
  const metricCurrent =
    options.metric === "visitors"
      ? currentVisitors
      : options.metric === "sessions"
        ? currentSessions
        : currentViews;
  const metricReference =
    options.metric === "visitors"
      ? referenceVisitors
      : options.metric === "sessions"
        ? referenceSessions
        : referenceViews;
  const changeRelative = relativeSql(metricCurrent, metricReference);
  const changeClass = `CASE WHEN ${metricReference} = 0 AND ${metricCurrent} > 0 THEN 1 ELSE 0 END`;
  const sql = `
WITH
${currentSide.ctes},
${referenceSide.ctes},
current_rollup AS (
  SELECT COALESCE(${selectExpr}, '') AS key,
    count(*) AS current_views,
    count(DISTINCT CASE WHEN session_id != '' THEN session_id ELSE NULL END) AS current_sessions,
    count(DISTINCT CASE WHEN visitor_id != '' THEN visitor_id ELSE NULL END) AS current_visitors
  FROM ${currentSide.relation}
  ${currentSide.filterClause}
  GROUP BY key
),
reference_rollup AS (
  SELECT COALESCE(${selectExpr}, '') AS key,
    count(*) AS reference_views,
    count(DISTINCT CASE WHEN session_id != '' THEN session_id ELSE NULL END) AS reference_sessions,
    count(DISTINCT CASE WHEN visitor_id != '' THEN visitor_id ELSE NULL END) AS reference_visitors
  FROM ${referenceSide.relation}
  ${referenceSide.filterClause}
  GROUP BY key
),
joined AS (
  SELECT
    keys.key AS key,
    COALESCE(c.current_views, 0) AS current_views,
    COALESCE(c.current_sessions, 0) AS current_sessions,
    COALESCE(c.current_visitors, 0) AS current_visitors,
    COALESCE(r.reference_views, 0) AS reference_views,
    COALESCE(r.reference_sessions, 0) AS reference_sessions,
    COALESCE(r.reference_visitors, 0) AS reference_visitors
  FROM (
    SELECT key FROM current_rollup
    UNION
    SELECT key FROM reference_rollup
  ) keys
  LEFT JOIN current_rollup c ON c.key = keys.key
  LEFT JOIN reference_rollup r ON r.key = keys.key
),
projected AS (
  SELECT *,
    ${changeRelative} AS change_relative,
    ${changeClass} AS change_class
  FROM joined
)
SELECT * FROM projected
WHERE key != ''
${searchClause}
${cursorClause}
ORDER BY ${ordering.expression}
LIMIT ?
`;
  const searchBindings = options.search?.trim()
    ? [
        `%${options.search
          .trim()
          .toLowerCase()
          .replaceAll("\\", "\\\\")
          .replaceAll("%", "\\%")
          .replaceAll("_", "\\_")}%`,
      ]
    : [];
  const cursorBindings = cursor
    ? options.sortBy === "change"
      ? [
          cursor.sortClass,
          cursor.sortClass,
          cursor.primary,
          cursor.primary,
          cursor.key,
        ]
      : [
          cursor.primary,
          cursor.primary,
          cursor.secondary,
          cursor.primary,
          cursor.secondary,
          cursor.key,
        ]
    : [];
  const rows = await queryD1All<Record<string, unknown>>(
    env,
    sql,
    [
      ...currentSide.bindings,
      ...referenceSide.bindings,
      ...searchBindings,
      ...cursorBindings,
      limit + 1,
    ],
    diagnostics,
  );
  const mapped = rows.map((row) => {
    const number = (name: string) => Number(row[name] ?? 0);
    const currentViewsValue = number(currentViews);
    const currentSessionsValue = number(currentSessions);
    const currentVisitorsValue = number(currentVisitors);
    const referenceViewsValue = number(referenceViews);
    const referenceSessionsValue = number(referenceSessions);
    const referenceVisitorsValue = number(referenceVisitors);
    const delta = (a: number, b: number) => ({
      absolute: a - b,
      relative: b === 0 ? (a === 0 ? 0 : null) : (a - b) / b,
    });
    return {
      key: String(row.key ?? ""),
      value: String(row.key ?? ""),
      views: currentViewsValue,
      sessions: currentSessionsValue,
      visitors: currentVisitorsValue,
      reference: {
        views: referenceViewsValue,
        sessions: referenceSessionsValue,
        visitors: referenceVisitorsValue,
      },
      change: {
        views: delta(currentViewsValue, referenceViewsValue),
        sessions: delta(currentSessionsValue, referenceSessionsValue),
        visitors: delta(currentVisitorsValue, referenceVisitorsValue),
      },
    };
  });
  const page = pageResult(mapped, limit);
  const binding = await comparisonCursorBinding(
    siteId,
    current,
    currentFilters,
    reference,
    referenceFilters,
    selectExpr,
    options.search,
    audience,
    options.metric,
    options.sortBy,
    options.direction,
  );
  const nextCursor =
    page.hasMore && page.last
      ? await encodePageCursor(env, binding, {
          sortClass:
            options.sortBy === "change"
              ? Number(
                  page.last.reference[options.metric] === 0 &&
                    page.last[options.metric] > 0
                    ? 1
                    : 0,
                )
              : 0,
          primary:
            options.sortBy === "reference"
              ? page.last.reference[options.metric]
              : options.sortBy === "change"
                ? (page.last.change[options.metric].relative ?? 0)
                : page.last[options.metric],
          secondary:
            options.sortBy === "current"
              ? page.last.reference[options.metric]
              : options.sortBy === "reference"
                ? page.last[options.metric]
                : 0,
          key: page.last.key,
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

/** Comparison variant for session entry/exit, where each session contributes
 * only its first/last page rather than every page view. */
export async function queryComparisonSessionPathPageFromD1(
  env: Env,
  siteId: string,
  current: QueryWindow,
  currentFilters: FilterDocument,
  reference: QueryWindow,
  referenceFilters: FilterDocument,
  limit: number,
  kind: "entry" | "exit",
  options: {
    metric: OverviewTableMetric;
    sortBy: OverviewTableSortBy;
    direction: SortDirection;
    search?: string;
  },
  cursor: ComparisonDimensionCursor | null,
  audience: QueryAudience,
  diagnostics?: D1ReadDiagnostics,
): Promise<Awaited<ReturnType<typeof queryComparisonDimensionPageFromD1>>> {
  const currentSide = comparisonSide(
    siteId,
    current,
    currentFilters,
    "current",
  );
  const referenceSide = comparisonSide(
    siteId,
    reference,
    referenceFilters,
    "reference",
  );
  const rank = kind === "entry" ? "first_rank" : "latest_rank";
  const searchClause = options.search?.trim()
    ? "AND LOWER(key) LIKE ? ESCAPE '\\'"
    : "";
  const ordering = comparisonOrdering(
    options.metric,
    options.sortBy,
    options.direction,
  );
  const cursorClause = cursor ? `AND ${ordering.cursorPredicate}` : "";
  const currentColumn =
    options.metric === "visitors"
      ? "current_visitors"
      : options.metric === "sessions"
        ? "current_sessions"
        : "current_views";
  const referenceColumn =
    options.metric === "visitors"
      ? "reference_visitors"
      : options.metric === "sessions"
        ? "reference_sessions"
        : "reference_views";
  const changeRelative = relativeSql(currentColumn, referenceColumn);
  const changeClass = `CASE WHEN ${referenceColumn} = 0 AND ${currentColumn} > 0 THEN 1 ELSE 0 END`;
  const sql = `
WITH
${currentSide.ctes},
${referenceSide.ctes},
current_ranked AS (
  SELECT session_id, visitor_id, TRIM(COALESCE(pathname, '')) AS pathname,
    ROW_NUMBER() OVER (
      PARTITION BY session_id
      ORDER BY started_at ${kind === "entry" ? "ASC" : "DESC"}, visit_id ${kind === "entry" ? "ASC" : "DESC"}
    ) AS ${rank}
  FROM ${currentSide.relation}
  ${currentSide.filterClause}
  WHERE session_id != '' AND TRIM(COALESCE(pathname, '')) != ''
),
reference_ranked AS (
  SELECT session_id, visitor_id, TRIM(COALESCE(pathname, '')) AS pathname,
    ROW_NUMBER() OVER (
      PARTITION BY session_id
      ORDER BY started_at ${kind === "entry" ? "ASC" : "DESC"}, visit_id ${kind === "entry" ? "ASC" : "DESC"}
    ) AS ${rank}
  FROM ${referenceSide.relation}
  ${referenceSide.filterClause}
  WHERE session_id != '' AND TRIM(COALESCE(pathname, '')) != ''
),
current_rollup AS (
  SELECT pathname AS key, count(*) AS current_views, count(*) AS current_sessions,
    count(DISTINCT CASE WHEN visitor_id != '' THEN visitor_id ELSE NULL END) AS current_visitors
  FROM current_ranked WHERE ${rank} = 1 GROUP BY pathname
),
reference_rollup AS (
  SELECT pathname AS key, count(*) AS reference_views, count(*) AS reference_sessions,
    count(DISTINCT CASE WHEN visitor_id != '' THEN visitor_id ELSE NULL END) AS reference_visitors
  FROM reference_ranked WHERE ${rank} = 1 GROUP BY pathname
),
joined AS (
  SELECT keys.key,
    COALESCE(c.current_views, 0) AS current_views,
    COALESCE(c.current_sessions, 0) AS current_sessions,
    COALESCE(c.current_visitors, 0) AS current_visitors,
    COALESCE(r.reference_views, 0) AS reference_views,
    COALESCE(r.reference_sessions, 0) AS reference_sessions,
    COALESCE(r.reference_visitors, 0) AS reference_visitors
  FROM (SELECT key FROM current_rollup UNION SELECT key FROM reference_rollup) keys
  LEFT JOIN current_rollup c ON c.key = keys.key
  LEFT JOIN reference_rollup r ON r.key = keys.key
),
projected AS (
  SELECT *, ${changeRelative} AS change_relative, ${changeClass} AS change_class
  FROM joined
)
SELECT * FROM projected
WHERE key != '' ${searchClause} ${cursorClause}
ORDER BY ${ordering.expression}
LIMIT ?
`;
  const searchBindings = options.search?.trim()
    ? [
        `%${options.search
          .trim()
          .toLowerCase()
          .replaceAll("\\", "\\\\")
          .replaceAll("%", "\\%")
          .replaceAll("_", "\\_")}%`,
      ]
    : [];
  const cursorBindings = cursor
    ? options.sortBy === "change"
      ? [
          cursor.sortClass,
          cursor.sortClass,
          cursor.primary,
          cursor.primary,
          cursor.key,
        ]
      : [
          cursor.primary,
          cursor.primary,
          cursor.secondary,
          cursor.primary,
          cursor.secondary,
          cursor.key,
        ]
    : [];
  const rows = await queryD1All<Record<string, unknown>>(
    env,
    sql,
    [
      ...currentSide.bindings,
      ...referenceSide.bindings,
      ...searchBindings,
      ...cursorBindings,
      limit + 1,
    ],
    diagnostics,
  );
  const mapped = rows.map((row) => {
    const number = (name: string) => Number(row[name] ?? 0);
    const cv = number("current_views");
    const cs = number("current_sessions");
    const cvis = number("current_visitors");
    const rv = number("reference_views");
    const rs = number("reference_sessions");
    const rvis = number("reference_visitors");
    const delta = (a: number, b: number) => ({
      absolute: a - b,
      relative: b === 0 ? (a === 0 ? 0 : null) : (a - b) / b,
    });
    return {
      key: String(row.key ?? ""),
      value: String(row.key ?? ""),
      views: cv,
      sessions: cs,
      visitors: cvis,
      reference: { views: rv, sessions: rs, visitors: rvis },
      change: {
        views: delta(cv, rv),
        sessions: delta(cs, rs),
        visitors: delta(cvis, rvis),
      },
    };
  });
  const page = pageResult(mapped, limit);
  const binding = await comparisonCursorBinding(
    siteId,
    current,
    currentFilters,
    reference,
    referenceFilters,
    `session.${kind}`,
    options.search,
    audience,
    options.metric,
    options.sortBy,
    options.direction,
  );
  const nextCursor =
    page.hasMore && page.last
      ? await encodePageCursor(env, binding, {
          sortClass:
            options.sortBy === "change"
              ? page.last.reference[options.metric] === 0 &&
                page.last[options.metric] > 0
                ? 1
                : 0
              : 0,
          primary:
            options.sortBy === "reference"
              ? page.last.reference[options.metric]
              : options.sortBy === "change"
                ? (page.last.change[options.metric].relative ?? 0)
                : page.last[options.metric],
          secondary:
            options.sortBy === "current"
              ? page.last.reference[options.metric]
              : options.sortBy === "reference"
                ? page.last[options.metric]
                : 0,
          key: page.last.key,
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
