import {
  type QueryAudience,
  scopedFilterMetadata,
} from "@/lib/edge/analytics/contract";
import { queryWindowToTime } from "@/lib/edge/analytics/contract/helpers";
import {
  buildReferrersPagePlan,
  buildReferrerSummaryPlan,
  type ReferrerPageSortKey,
} from "@/lib/edge/analytics/engine/referrer-report-plan";
import type {
  DeferredReferrerOverviewQualification,
  DeferredReferrersQualification,
} from "@/lib/edge/analytics/providers/d1/internal/advanced-filter-execution";
import type { Env } from "@/lib/edge/types";

import {
  executePageDimensionQualificationProgram,
  executeReferrersQualificationProgram,
} from "./analytics-qualification-program";
import {
  queryAnalyticsReportOutputRowsFromD1,
  queryAnalyticsReportOutputSetRowsFromD1,
} from "./analytics-report-query";
import type {
  FilterDocument,
  QueryWindow,
  ReferrerRow,
  ReferrerSummaryRow,
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
export interface ReferrerAggregateCursor {
  /** The first two values are the concrete ORDER BY metrics. */
  readonly primary: number;
  readonly secondary: number;
  readonly referrer: string;
}
export type { ReferrerPageSortKey } from "@/lib/edge/analytics/engine/referrer-report-plan";
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
  const metadata = scopedFilterMetadata(filters);
  const plan = buildReferrerSummaryPlan({
    siteId,
    queryTime: metadata?.time ?? queryWindowToTime(window),
    filters,
    ...(metadata ? { scopePlan: metadata.plan } : {}),
    topN,
  });
  const rows = await queryAnalyticsReportOutputSetRowsFromD1(
    env,
    plan,
    {
      outputIds: ["referrer-summary", "referrer-top-sources"],
      fields: [
        "rowType",
        "referrer",
        "totalViews",
        "directViews",
        "externalViews",
        "uniqueDomains",
        "uniqueLinks",
        "views",
      ],
      orderBy: [
        { field: "rowType", direction: "asc", nulls: "first" },
        { field: "views", direction: "desc", nulls: "last" },
        { field: "referrer", direction: "asc", nulls: "first" },
      ],
    },
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

type ReferrersQualificationExecution = Awaited<
  ReturnType<typeof executeReferrersQualificationProgram>
>;
type ExecutedReferrersQualification = Extract<
  ReferrersQualificationExecution,
  { readonly kind: "executed" }
>;

export type QualifiedReferrerSummaryResult =
  | {
      readonly kind: "executed";
      readonly summary: ReferrerSummaryRow;
      readonly evidence: ExecutedReferrersQualification["evidence"];
    }
  | Exclude<ReferrersQualificationExecution, { readonly kind: "executed" }>;

/** Executes the real Referrers summary report behind Count qualification. */
export async function queryQualifiedReferrerSummaryFromD1(input: {
  readonly env: Env;
  readonly deferred: DeferredReferrersQualification;
  readonly siteId: string;
  readonly topN: number;
  readonly diagnostics?: D1ReadDiagnostics;
}): Promise<QualifiedReferrerSummaryResult> {
  const execution = await executeReferrersQualificationProgram({
    env: input.env,
    deferred: input.deferred,
    query: {
      siteId: input.siteId,
      queryTime: input.deferred.time,
      filters: input.deferred.filters,
      scopePlan: input.deferred.metadata.plan,
      configuration: { kind: "summary", topN: input.topN },
      cursorToken: null,
      audience: input.deferred.referrersRequest.audience,
    },
    ...(input.diagnostics ? { diagnostics: input.diagnostics } : {}),
  });
  if (execution.kind !== "executed") return execution;
  const reportRows = execution.rows.filter((row) => row.rowKind === "report");
  const summary =
    reportRows.find((row) => row.outputId === "referrer-summary") ?? {};
  const topRows = reportRows.filter(
    (row) => row.outputId === "referrer-top-sources",
  );
  return {
    kind: "executed",
    summary: {
      totalViews: Number(summary.totalViews ?? 0),
      directViews: Number(summary.directViews ?? 0),
      externalViews: Number(summary.externalViews ?? 0),
      uniqueDomains: Number(summary.uniqueDomains ?? 0),
      uniqueLinks: Number(summary.uniqueLinks ?? 0),
      truncated: topRows.length > input.topN,
      topSources: topRows.slice(0, input.topN).map((row) => ({
        referrer: String(row.referrer ?? ""),
        views: Number(row.views ?? 0),
      })),
    },
    evidence: execution.evidence,
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
  const metadata = scopedFilterMetadata(filters);
  const plan = buildReferrersPagePlan({
    siteId,
    queryTime: metadata?.time ?? queryWindowToTime(window),
    filters,
    ...(metadata ? { scopePlan: metadata.plan } : {}),
    limit,
    includeFullUrl,
    ...(search !== undefined ? { search } : {}),
    sortBy,
    sortDirection,
    ...(cursor ? { cursor } : {}),
  });
  const rows = await queryAnalyticsReportOutputRowsFromD1(
    env,
    plan,
    "referrers-page",
    undefined,
    diagnostics,
  );
  return referrerPageFromRows({
    env,
    siteId,
    window,
    filters,
    limit,
    includeFullUrl,
    search,
    audience,
    sortBy,
    sortDirection,
    rows,
  });
}

type ReferrerPageQualificationExecution = Awaited<
  ReturnType<typeof executePageDimensionQualificationProgram>
>;
type ExecutedReferrerQualification = Extract<
  ReferrerPageQualificationExecution,
  { readonly kind: "executed" }
>;

export type QualifiedReferrersPageResult =
  | {
      readonly kind: "executed";
      readonly page: PageResult<ReferrerRow>;
      readonly evidence: ExecutedReferrerQualification["evidence"];
    }
  | Exclude<ReferrerPageQualificationExecution, { readonly kind: "executed" }>;

export async function referrerPageFromRows(input: {
  readonly env: Env;
  readonly siteId: string;
  readonly window: QueryWindow;
  readonly filters: FilterDocument;
  readonly limit: number;
  readonly includeFullUrl: boolean;
  readonly search?: string;
  readonly audience: QueryAudience;
  readonly sortBy: ReferrerPageSortKey;
  readonly sortDirection: "asc" | "desc";
  readonly rows: readonly Record<string, unknown>[];
}): Promise<PageResult<ReferrerRow>> {
  const {
    env,
    siteId,
    window,
    filters,
    limit,
    includeFullUrl,
    search,
    audience,
    sortBy,
    sortDirection,
    rows,
  } = input;
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

/** Executes the existing Referrer page report behind Count qualification. */
export async function queryQualifiedReferrersPageFromD1(input: {
  readonly env: Env;
  readonly deferred: DeferredReferrerOverviewQualification;
  readonly siteId: string;
  readonly window: QueryWindow;
  readonly filters: FilterDocument;
  readonly limit: number;
  readonly includeFullUrl: boolean;
  readonly search?: string;
  readonly cursor: ReferrerAggregateCursor | null;
  readonly cursorToken: string | null;
  readonly audience: QueryAudience;
  readonly sortBy: ReferrerPageSortKey;
  readonly sortDirection: "asc" | "desc";
  readonly diagnostics?: D1ReadDiagnostics;
}): Promise<QualifiedReferrersPageResult> {
  const prepared = input.deferred.referrerOverviewRequest;
  const execution = await executePageDimensionQualificationProgram({
    env: input.env,
    deferred: input.deferred,
    query: {
      siteId: input.siteId,
      queryTime: input.deferred.time,
      filters: input.deferred.filters,
      scopePlan: input.deferred.metadata.plan,
      family: "referrer-overview",
      tab: prepared.tab,
      includeFullUrl: input.includeFullUrl,
      limit: input.limit,
      cursor: input.cursor,
      cursorToken: input.cursorToken,
      ...(input.search !== undefined ? { search: input.search } : {}),
      sortBy: input.sortBy,
      sortDirection: input.sortDirection,
      audience: input.audience,
    },
    ...(input.diagnostics ? { diagnostics: input.diagnostics } : {}),
  });
  if (execution.kind !== "executed") return execution;
  const rows = execution.rows.filter(
    (row) => row.rowKind === "report" && row.outputId === "referrers-page",
  );
  const page = await referrerPageFromRows({
    env: input.env,
    siteId: input.siteId,
    window: input.window,
    filters: input.filters,
    limit: input.limit,
    includeFullUrl: input.includeFullUrl,
    search: input.search,
    audience: input.audience,
    sortBy: input.sortBy,
    sortDirection: input.sortDirection,
    rows,
  });
  return { kind: "executed", page, evidence: execution.evidence };
}

export type QualifiedReferrersFlatPageResult =
  | {
      readonly kind: "executed";
      readonly page: PageResult<ReferrerRow>;
      readonly evidence: ExecutedReferrersQualification["evidence"];
    }
  | Exclude<ReferrersQualificationExecution, { readonly kind: "executed" }>;

/** Executes the ordinary flat Referrers page behind Count qualification. */
export async function queryQualifiedReferrersFlatPageFromD1(input: {
  readonly env: Env;
  readonly deferred: DeferredReferrersQualification;
  readonly siteId: string;
  readonly window: QueryWindow;
  readonly filters: FilterDocument;
  readonly limit: number;
  readonly includeFullUrl: boolean;
  readonly search?: string;
  readonly cursor: ReferrerAggregateCursor | null;
  readonly cursorToken: string | null;
  readonly audience: QueryAudience;
  readonly sortBy: ReferrerPageSortKey;
  readonly sortDirection: "asc" | "desc";
  readonly diagnostics?: D1ReadDiagnostics;
}): Promise<QualifiedReferrersFlatPageResult> {
  const execution = await executeReferrersQualificationProgram({
    env: input.env,
    deferred: input.deferred,
    query: {
      siteId: input.siteId,
      queryTime: input.deferred.time,
      filters: input.deferred.filters,
      scopePlan: input.deferred.metadata.plan,
      configuration: {
        kind: "page",
        limit: input.limit,
        includeFullUrl: input.includeFullUrl,
        ...(input.search !== undefined ? { search: input.search } : {}),
        sortBy: input.sortBy,
        sortDirection: input.sortDirection,
        cursor: input.cursor,
      },
      cursorToken: input.cursorToken,
      audience: input.audience,
    },
    ...(input.diagnostics ? { diagnostics: input.diagnostics } : {}),
  });
  if (execution.kind !== "executed") return execution;
  const rows = execution.rows.filter(
    (row) => row.rowKind === "report" && row.outputId === "referrers-page",
  );
  const page = await referrerPageFromRows({
    env: input.env,
    siteId: input.siteId,
    window: input.window,
    filters: input.filters,
    limit: input.limit,
    includeFullUrl: input.includeFullUrl,
    search: input.search,
    audience: input.audience,
    sortBy: input.sortBy,
    sortDirection: input.sortDirection,
    rows,
  });
  return { kind: "executed", page, evidence: execution.evidence };
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
