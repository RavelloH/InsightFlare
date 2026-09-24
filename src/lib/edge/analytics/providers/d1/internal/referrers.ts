import { type QueryAudience } from "@/lib/edge/analytics/contract";
import type { Env } from "@/lib/edge/types";

import type {
  FilterDocument,
  QueryWindow,
  ReferrerRow,
  ReferrerSummaryRow,
} from "./core";
import {
  buildVisitFilterSql,
  buildVisitSourceCte,
  queryD1All,
  visitSourceBindings,
} from "./core";
import type { D1ReadDiagnostics } from "./diagnostics";
import { queryReferrersFromD1 } from "./dimensions";
import { pageCursorBinding } from "./pages";
import {
  decodePageCursor,
  encodePageCursor,
  hasExactKeys,
  type PageResult,
  pageResult,
} from "./pagination";
import { scopedDatasetFor } from "./scoped-dataset";
export interface ReferrerAggregateCursor {
  /** The first two values are the concrete ORDER BY metrics. */
  readonly primary: number;
  readonly secondary: number;
  readonly referrer: string;
}
export type ReferrerPageSortKey = "views" | "visitors";
function referrerAggregateCursor(
  value: unknown,
): ReferrerAggregateCursor | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const candidate = value as Record<string, unknown>;
  return hasExactKeys(candidate, ["primary", "secondary", "referrer"]) &&
    typeof candidate.primary === "number" &&
    Number.isFinite(candidate.primary) &&
    typeof candidate.secondary === "number" &&
    Number.isFinite(candidate.secondary) &&
    typeof candidate.referrer === "string"
    ? (candidate as unknown as ReferrerAggregateCursor)
    : null;
}
export async function queryReferrerAggregate(
  env: Env,
  siteId: string,
  window: QueryWindow,
  filters: FilterDocument,
  limit: number,
  includeFullUrl: boolean,
  diagnostics?: D1ReadDiagnostics,
  search?: string,
): Promise<ReferrerRow[]> {
  return queryReferrersFromD1(
    env,
    siteId,
    window,
    filters,
    limit,
    includeFullUrl,
    diagnostics,
    search,
  );
}
/** Explicit Top-N reader for reports/cards. It intentionally has no cursor. */
export async function queryTopReferrersFromD1(
  env: Env,
  siteId: string,
  window: QueryWindow,
  filters: FilterDocument,
  limit: number,
  includeFullUrl: boolean,
  diagnostics?: D1ReadDiagnostics,
  search?: string,
): Promise<ReferrerRow[]> {
  return queryReferrersFromD1(
    env,
    siteId,
    window,
    filters,
    limit,
    includeFullUrl,
    diagnostics,
    search,
  );
}
/** Explicit aggregate for referrer summary cards. It is intentionally
 * independent from the paginated referrer collection. */
export async function queryReferrerSummaryFromD1(
  env: Env,
  siteId: string,
  window: QueryWindow,
  filters: FilterDocument,
  topN: number,
  diagnostics?: D1ReadDiagnostics,
): Promise<ReferrerSummaryRow> {
  const scopedDataset = scopedDatasetFor(siteId, window, filters);
  const filter = scopedDataset
    ? null
    : buildVisitFilterSql(filters, "visit_source", { window });
  const source = scopedDataset?.visitRelation ?? "visit_source";
  const ctes = scopedDataset?.ctes ?? buildVisitSourceCte();
  const bindings = scopedDataset
    ? scopedDataset.bindings.map((binding) => binding.value)
    : [...visitSourceBindings(siteId, window), ...(filter?.bindings ?? [])];
  const rows = await queryD1All<Record<string, unknown>>(
    env,
    `
WITH
${ctes},
filtered_visits AS MATERIALIZED (
  SELECT referrer_host, referrer_url
  FROM ${source}
  ${filter?.clause ?? ""}
),
summary_row AS (
  SELECT
    'summary' AS rowType,
    '' AS referrer,
    count(*) AS totalViews,
    SUM(CASE WHEN TRIM(COALESCE(referrer_host, '')) = '' THEN 1 ELSE 0 END) AS directViews,
    SUM(CASE WHEN TRIM(COALESCE(referrer_host, '')) != '' THEN 1 ELSE 0 END) AS externalViews,
    count(DISTINCT NULLIF(TRIM(COALESCE(referrer_host, '')), '')) AS uniqueDomains,
    count(DISTINCT NULLIF(TRIM(COALESCE(referrer_url, '')), '')) AS uniqueLinks,
    0 AS views,
    0 AS rowRank
  FROM filtered_visits
),
top_rollup AS (
  SELECT
    TRIM(COALESCE(referrer_host, '')) AS referrer,
    count(*) AS views
  FROM filtered_visits
  WHERE TRIM(COALESCE(referrer_host, '')) != ''
  GROUP BY referrer
),
top_rows AS (
  SELECT
    'top' AS rowType,
    referrer,
    NULL AS totalViews,
    NULL AS directViews,
    NULL AS externalViews,
    NULL AS uniqueDomains,
    NULL AS uniqueLinks,
    views,
    ROW_NUMBER() OVER (ORDER BY views DESC, referrer ASC) AS rowRank
  FROM top_rollup
)
SELECT rowType, referrer, totalViews, directViews, externalViews,
  uniqueDomains, uniqueLinks, views, rowRank
FROM (
  SELECT * FROM summary_row
  UNION ALL
  SELECT * FROM top_rows
)
WHERE rowType = 'summary' OR rowRank <= ?
ORDER BY CASE rowType WHEN 'summary' THEN 0 ELSE 1 END, rowRank ASC
`,
    [...bindings, topN + 1],
    diagnostics,
  );
  const summary = rows.find((row) => row.rowType === "summary") ?? {};
  const topRows = rows.filter((row) => row.rowType === "top");
  return {
    totalViews: Number(summary.totalViews ?? 0),
    directViews: Number(summary.directViews ?? 0),
    externalViews: Number(summary.externalViews ?? 0),
    uniqueDomains: Number(summary.uniqueDomains ?? 0),
    uniqueLinks: Number(summary.uniqueLinks ?? 0),
    truncated: topRows.length > topN,
    topSources: topRows.slice(0, topN).map((row) => ({
      referrer: String(row.referrer ?? ""),
      views: Number(row.views ?? 0),
    })),
  };
}
/** Keyset-paginated referrer aggregate. */
export async function queryReferrersPageFromD1(
  env: Env,
  siteId: string,
  window: QueryWindow,
  filters: FilterDocument,
  limit: number,
  includeFullUrl: boolean,
  search?: string,
  cursor?: ReferrerAggregateCursor | null,
  diagnostics?: D1ReadDiagnostics,
  audience: QueryAudience = "private-dashboard",
  sortBy: ReferrerPageSortKey = "views",
  sortDirection: "asc" | "desc" = "desc",
): Promise<PageResult<ReferrerRow>> {
  const scopedDataset = scopedDatasetFor(siteId, window, filters);
  const filter = scopedDataset
    ? null
    : buildVisitFilterSql(filters, "visit_source", { window });
  const keyExpr = includeFullUrl ? "referrer_url" : "referrer_host";
  const primary = sortBy === "visitors" ? "visitors" : "views";
  const secondary = sortBy === "visitors" ? "views" : "sessions";
  const operator = sortDirection === "asc" ? ">" : "<";
  const cursorClause = cursor
    ? `
WHERE ${primary} ${operator} ?
   OR (${primary} = ? AND ${secondary} ${operator} ?)
   OR (${primary} = ? AND ${secondary} = ? AND referrer > ?)`
    : "";
  const sql = `
WITH
${scopedDataset?.ctes ?? buildVisitSourceCte()},
filtered_visits AS (
  SELECT *
  FROM ${scopedDataset?.visitRelation ?? "visit_source"}
  ${filter?.clause ?? ""}
),
rollup AS (
  SELECT
    COALESCE(${keyExpr}, '') AS referrer,
    count(*) AS views,
    count(DISTINCT CASE WHEN session_id != '' THEN session_id ELSE NULL END) AS sessions,
    count(DISTINCT CASE WHEN visitor_id != '' THEN visitor_id ELSE NULL END) AS visitors
  FROM filtered_visits
  GROUP BY referrer
  ${search ? "HAVING LOWER(referrer) LIKE ? ESCAPE '\\'" : ""}
)
SELECT referrer, views, sessions, visitors
FROM rollup
${cursorClause}
  ORDER BY views DESC, sessions DESC, referrer ASC
LIMIT ?
`;
  const orderedSql = sql.replace(
    "ORDER BY views DESC, sessions DESC, referrer ASC",
    `ORDER BY ${primary} ${sortDirection}, ${secondary} ${sortDirection}, referrer ASC`,
  );
  const cursorBindings = cursor
    ? [
        cursor.primary,
        cursor.primary,
        cursor.secondary,
        cursor.primary,
        cursor.secondary,
        cursor.referrer,
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
      ...cursorBindings,
      limit + 1,
    ],
    diagnostics,
  );
  const mapped = rows.map((row) => ({
    referrer: String(row.referrer ?? ""),
    views: Number(row.views ?? 0),
    sessions: Number(row.sessions ?? 0),
    visitors: Number(row.visitors ?? 0),
  }));
  const page = pageResult(mapped, limit);
  const binding = await pageCursorBinding(
    "referrers",
    siteId,
    window,
    filters,
    [includeFullUrl, search?.trim().toLowerCase() ?? "", sortBy, sortDirection],
    audience,
  );
  const nextCursor =
    page.hasMore && page.last
      ? await encodePageCursor(env, binding, {
          primary: sortBy === "visitors" ? page.last.visitors : page.last.views,
          secondary:
            sortBy === "visitors" ? page.last.views : page.last.sessions,
          referrer: page.last.referrer,
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
export async function decodeReferrersCursor(
  env: Env,
  siteId: string,
  window: QueryWindow,
  filters: FilterDocument,
  includeFullUrl: boolean,
  search?: string,
  cursor?: string | null,
  audience: QueryAudience = "private-dashboard",
  sortBy: ReferrerPageSortKey = "views",
  sortDirection: "asc" | "desc" = "desc",
): Promise<ReferrerAggregateCursor | null> {
  const binding = await pageCursorBinding(
    "referrers",
    siteId,
    window,
    filters,
    [includeFullUrl, search?.trim().toLowerCase() ?? "", sortBy, sortDirection],
    audience,
  );
  return decodePageCursor(
    env,
    binding,
    cursor,
    "referrers",
    referrerAggregateCursor,
  );
}
