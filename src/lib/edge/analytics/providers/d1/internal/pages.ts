import {
  analyticsFilterRegistry,
  effectiveScopeForPagination,
  filterFingerprint,
  type PagesDashboardMetric,
  type QueryAudience,
  scopedFilterMetadata,
  type SortDirection,
} from "@/lib/edge/analytics/contract";
import { queryWindowToTime } from "@/lib/edge/analytics/contract/helpers";
import type { ScopedFilterPlan } from "@/lib/edge/analytics/contract/scoped-filter";
import type { QueryTime } from "@/lib/edge/analytics/contract/types";
import type { PageDimensionSelection } from "@/lib/edge/analytics/engine/dimension-report-plan";
import {
  buildPageCardDetailsPlan,
  buildPageCardTitlesPlan,
  buildPageCardTrendPlan,
  PAGE_CARD_DETAILS_MULTI_OUTPUT_FIELDS,
  PAGE_CARD_DETAILS_MULTI_OUTPUT_IDS,
  PAGE_CARD_DETAILS_OUTPUT_IDS,
} from "@/lib/edge/analytics/engine/page-card-details-report-plan";
import {
  buildPageCardMetricsPlan,
  PAGE_CARD_METRICS_OUTPUT_ID,
} from "@/lib/edge/analytics/engine/page-card-metrics-report-plan";
import {
  buildPagesPagePlan,
  buildTopPagesPlan,
  type PageAggregateCursor,
} from "@/lib/edge/analytics/engine/page-report-plan";
import { PAGE_TAB_OUTPUT_IDS } from "@/lib/edge/analytics/engine/page-tabs-report-plan";
import {
  buildPagesWithTabsPlan,
  PAGES_WITH_TABS_OUTPUT_FIELDS,
  PAGES_WITH_TABS_OUTPUT_IDS,
} from "@/lib/edge/analytics/engine/pages-with-tabs-report-plan";
import { pageRoleDependencyRefs } from "@/lib/edge/analytics/engine/semantic/qualification-dependency";
import type { Env } from "@/lib/edge/types";
import { InvalidCursorError } from "@/lib/pagination";

import type {
  DeferredPagesAggregatePageQualification,
  DeferredPagesTabsQualification,
} from "./advanced-filter-execution";
import {
  type EventSummaryQualificationCompilationEvidence,
  executePagesAggregateQualificationProgram,
  executePagesTabsQualificationProgram,
  type PagesTabsQualificationReportQuery,
} from "./analytics-qualification-program";
import {
  queryAnalyticsReportOutputRowsFromD1,
  queryAnalyticsReportOutputSetRowsFromD1,
} from "./analytics-report-query";
import type {
  DimensionRow,
  FilterDocument,
  Interval,
  PageCardAggregateRow,
  PageCardTitleRow,
  PageCardTrendRow,
  PageRow,
  QueryWindow,
} from "./core";
import { buildTimeBuckets, timeBucketTimestamp } from "./core";
import type { D1ReadDiagnostics } from "./diagnostics";
import { queryPageTabsFromD1, queryVisitDimensionFromD1 } from "./dimensions";
import {
  bindPageVisitQualificationPreparation,
  pageVisitQualificationConsumerKey,
  type PageVisitQualificationPreparation,
  snapshotPageVisitQualificationPlan,
} from "./page-visit-qualification-execution";
import { type PageDashboardCursor } from "./pages-dashboard";
import {
  decodePageCursor,
  encodePageCursor,
  hasExactKeys,
  type PageResult,
  pageResult,
  paginationBindingForWindow,
} from "./pagination";
import type { QualificationExecutionInputs } from "./qualification-execution-inputs";

export interface PagesPageVisitQualification {
  readonly preparation: PageVisitQualificationPreparation;
  readonly queryTime: QueryTime;
  readonly scopePlan: ScopedFilterPlan;
  readonly consumerKey: unknown;
}

export function pagesAggregatePageQualificationConsumerKey(
  configuration: DeferredPagesAggregatePageQualification["pagesAggregatePageRequest"],
) {
  return pageVisitQualificationConsumerKey(
    "pages-aggregate-page",
    configuration,
  );
}

export function pagesTabsQualificationConsumerKey(
  configuration: DeferredPagesTabsQualification["pagesTabsRequest"],
) {
  return pageVisitQualificationConsumerKey("pages-tabs", configuration);
}

function bindPagesReportQualification(input: {
  readonly plan: Parameters<typeof snapshotPageVisitQualificationPlan>[0];
  readonly siteId: string;
  readonly filters: FilterDocument;
  readonly qualification?: PagesPageVisitQualification;
}): {
  readonly plan: Parameters<typeof snapshotPageVisitQualificationPlan>[0];
  readonly executionInputs?: QualificationExecutionInputs;
} {
  if (!input.qualification) return { plan: input.plan };
  const plan = snapshotPageVisitQualificationPlan(input.plan);
  const executionInputs = bindPageVisitQualificationPreparation({
    preparation: input.qualification.preparation,
    siteId: input.siteId,
    filters: input.filters,
    queryTime: input.qualification.queryTime,
    scopePlan: input.qualification.scopePlan,
    consumerKey: input.qualification.consumerKey,
    plan,
  });
  return { plan, executionInputs };
}

function pageAggregateCursor(value: unknown): PageAggregateCursor | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const candidate = value as Record<string, unknown>;
  return hasExactKeys(candidate, [
    "views",
    "sessions",
    "pathname",
    "query",
    "hash",
  ]) &&
    typeof candidate.views === "number" &&
    Number.isFinite(candidate.views) &&
    typeof candidate.sessions === "number" &&
    Number.isFinite(candidate.sessions) &&
    typeof candidate.pathname === "string" &&
    typeof candidate.query === "string" &&
    typeof candidate.hash === "string"
    ? (candidate as unknown as PageAggregateCursor)
    : null;
}
export function pageCursorBinding(
  operation: string,
  siteId: string,
  window: QueryWindow,
  filters: FilterDocument,
  extra: readonly unknown[] = [],
  audience: QueryAudience = "private-dashboard",
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
    ...extra,
  ]);
}
export async function queryTopPagesFromD1(
  env: Env,
  siteId: string,
  window: QueryWindow,
  limit: number,
  includeDetails: boolean,
  filters: FilterDocument,
): Promise<PageRow[]> {
  const metadata = scopedFilterMetadata(filters);
  const plan = buildTopPagesPlan({
    siteId,
    queryTime: metadata?.time ?? queryWindowToTime(window),
    filters,
    ...(metadata ? { scopePlan: metadata.plan } : {}),
    limit,
    includeDetails,
  });
  const rows = await queryAnalyticsReportOutputRowsFromD1(
    env,
    plan,
    "top-pages",
  );
  return rows.map((row) => ({
    pathname: String(row.pathname ?? ""),
    query: String(row.queryValue ?? ""),
    hash: String(row.hashValue ?? ""),
    views: Number(row.views ?? 0),
    sessions: Number(row.sessions ?? 0),
  }));
}
export async function queryPagesFromD1(
  env: Env,
  siteId: string,
  window: QueryWindow,
  filters: FilterDocument,
  limit: number,
  includeDetails: boolean,
): Promise<PageRow[]> {
  return queryTopPagesFromD1(
    env,
    siteId,
    window,
    limit,
    includeDetails,
    filters,
  );
}
export async function queryPagesAggregate(
  env: Env,
  siteId: string,
  window: QueryWindow,
  filters: FilterDocument,
  limit: number,
  includeDetails: boolean,
): Promise<PageRow[]> {
  return queryPagesFromD1(env, siteId, window, filters, limit, includeDetails);
}
/** Keyset-paginated page aggregate. The legacy aggregate reader above remains
 * intentionally bounded for cards, reports, and other Top-N consumers. */
export async function queryPagesPageFromD1(
  env: Env,
  siteId: string,
  window: QueryWindow,
  filters: FilterDocument,
  limit: number,
  includeDetails: boolean,
  cursor?: PageAggregateCursor | null,
  audience: QueryAudience = "private-dashboard",
  qualification?: PagesPageVisitQualification,
): Promise<PageResult<PageRow>> {
  const metadata = scopedFilterMetadata(filters);
  const queryTime =
    qualification?.queryTime ?? metadata?.time ?? queryWindowToTime(window);
  const scopePlan = qualification?.scopePlan ?? metadata?.plan;
  const builtPlan = buildPagesPagePlan({
    siteId,
    queryTime,
    filters,
    ...(scopePlan ? { scopePlan } : {}),
    ...(qualification
      ? { qualificationDependencyRefs: pageRoleDependencyRefs(scopePlan) }
      : {}),
    limit,
    includeDetails,
    ...(cursor ? { cursor } : {}),
  });
  const bound = bindPagesReportQualification({
    plan: builtPlan,
    siteId,
    filters,
    qualification,
  });
  const rows = await queryAnalyticsReportOutputRowsFromD1(
    env,
    bound.plan,
    "pages-page",
    undefined,
    undefined,
    bound.executionInputs,
  );
  const mapped = rows.map((row) => ({
    pathname: String(row.pathname ?? ""),
    query: String(row.queryValue ?? ""),
    hash: String(row.hashValue ?? ""),
    views: Number(row.views ?? 0),
    sessions: Number(row.sessions ?? 0),
  }));
  return {
    ...(await pageResultWithCursor({
      env,
      siteId,
      window,
      filters,
      limit,
      includeDetails,
      audience,
      rows: mapped,
    })),
  };
}

async function pageResultWithCursor(input: {
  readonly env: Env;
  readonly siteId: string;
  readonly window: QueryWindow;
  readonly filters: FilterDocument;
  readonly limit: number;
  readonly includeDetails: boolean;
  readonly audience: QueryAudience;
  readonly rows: readonly PageRow[];
}): Promise<PageResult<PageRow>> {
  const page = pageResult(input.rows, input.limit);
  const binding = await pageCursorBinding(
    "pages",
    input.siteId,
    input.window,
    input.filters,
    [input.includeDetails],
    input.audience,
  );
  const nextCursor =
    page.hasMore && page.last
      ? await encodePageCursor(input.env, binding, {
          views: page.last.views,
          sessions: page.last.sessions,
          pathname: page.last.pathname,
          query: page.last.query,
          hash: page.last.hash,
        })
      : null;
  return {
    items: page.rows,
    pagination: {
      limit: input.limit,
      returned: page.rows.length,
      hasMore: page.hasMore,
      nextCursor,
    },
  };
}

export async function queryQualifiedPagesAggregatePageFromD1(input: {
  readonly env: Env;
  readonly siteId: string;
  readonly window: QueryWindow;
  readonly filters: FilterDocument;
  readonly limit: number;
  readonly includeDetails: boolean;
  readonly cursorText: string | null;
  readonly audience: QueryAudience;
  readonly deferred: DeferredPagesAggregatePageQualification;
  readonly scopePlan?: Parameters<typeof buildPagesPagePlan>[0]["scopePlan"];
  readonly diagnostics?: D1ReadDiagnostics;
  readonly variant: string | undefined;
  readonly includeTabs: boolean | undefined;
}): Promise<
  | {
      readonly kind: "executed";
      readonly page: PageResult<PageRow>;
      readonly evidence: EventSummaryQualificationCompilationEvidence;
    }
  | Exclude<
      Awaited<ReturnType<typeof executePagesAggregateQualificationProgram>>,
      { readonly kind: "executed" }
    >
> {
  let cursor: PageAggregateCursor | null = null;
  let invalidCursor = false;
  if (input.cursorText) {
    try {
      cursor = await decodePagesCursor(
        input.env,
        input.siteId,
        input.window,
        input.filters,
        input.includeDetails,
        input.cursorText,
        input.audience,
      );
    } catch (error) {
      if (!(error instanceof InvalidCursorError)) throw error;
      invalidCursor = true;
    }
    if (!cursor) invalidCursor = true;
  }
  const metadata = scopedFilterMetadata(input.filters);
  const queryTime = metadata?.time ?? queryWindowToTime(input.window);
  const execution = await executePagesAggregateQualificationProgram({
    env: input.env,
    deferred: input.deferred,
    query: {
      env: input.env,
      siteId: input.siteId,
      queryTime,
      filters: input.filters,
      ...(input.scopePlan ? { scopePlan: input.scopePlan } : {}),
      limit: input.limit,
      includeDetails: input.includeDetails,
      cursor: invalidCursor ? null : cursor,
      cursorToken: input.cursorText,
      audience: input.audience,
      variant: input.variant,
      includeTabs: input.includeTabs,
    },
    ...(input.diagnostics ? { diagnostics: input.diagnostics } : {}),
  });
  if (execution.kind !== "executed") {
    if (input.diagnostics)
      input.diagnostics.advancedCountSqlFallbackReason =
        execution.fallbackReason;
    return execution;
  }
  if (invalidCursor) throw new InvalidCursorError("pages");
  const rows = execution.rows
    .filter(
      (row) =>
        row.rowKind === "report" && row.outputId === "pages-aggregate-page",
    )
    .map((row) => ({
      pathname: String(row.pathname ?? ""),
      query: String(row.queryValue ?? ""),
      hash: String(row.hashValue ?? ""),
      views: Number(row.views ?? 0),
      sessions: Number(row.sessions ?? 0),
    }));
  const page = await pageResultWithCursor({
    env: input.env,
    siteId: input.siteId,
    window: input.window,
    filters: input.filters,
    limit: input.limit,
    includeDetails: input.includeDetails,
    audience: input.audience,
    rows,
  });
  return { kind: "executed", page, evidence: execution.evidence };
}
export async function decodePagesCursor(
  env: Env,
  siteId: string,
  window: QueryWindow,
  filters: FilterDocument,
  includeDetails: boolean,
  cursor?: string | null,
  audience: QueryAudience = "private-dashboard",
): Promise<PageAggregateCursor | null> {
  const binding = await pageCursorBinding(
    "pages",
    siteId,
    window,
    filters,
    [includeDetails],
    audience,
  );
  return decodePageCursor(env, binding, cursor, "pages", pageAggregateCursor);
}
export async function queryPageTabsAggregate(
  env: Env,
  siteId: string,
  window: QueryWindow,
  filters: FilterDocument,
  limit: number,
  qualification?: PagesPageVisitQualification,
): Promise<{
  path: DimensionRow[];
  title: DimensionRow[];
  hostname: DimensionRow[];
  entry: DimensionRow[];
  exit: DimensionRow[];
}> {
  return queryPageTabsFromD1(
    env,
    siteId,
    window,
    filters,
    limit,
    qualification,
  );
}
export interface PagesWithTabsResult {
  readonly pages: PageResult<PageRow>;
  readonly tabs: PageTabsResult;
}

export interface PageTabsResult {
  readonly path: DimensionRow[];
  readonly title: DimensionRow[];
  readonly hostname: DimensionRow[];
  readonly entry: DimensionRow[];
  readonly exit: DimensionRow[];
}

function pageTabsFromRows(
  rows: readonly Record<string, unknown>[],
): PageTabsResult {
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
/**
 * Reads paginated Page rows and all five tabs from one Logical plan and D1
 * statement, keeping the regular pages query and its cursor contract intact.
 */
export async function queryPagesWithTabsFromD1(
  env: Env,
  siteId: string,
  window: QueryWindow,
  filters: FilterDocument,
  limit: number,
  includeDetails: boolean,
  cursor?: PageAggregateCursor | null,
  audience: QueryAudience = "private-dashboard",
  qualification?: PagesPageVisitQualification,
): Promise<PagesWithTabsResult> {
  const metadata = scopedFilterMetadata(filters);
  const queryTime =
    qualification?.queryTime ?? metadata?.time ?? queryWindowToTime(window);
  const scopePlan = qualification?.scopePlan ?? metadata?.plan;
  const builtPlan = buildPagesWithTabsPlan({
    siteId,
    queryTime,
    filters,
    ...(scopePlan ? { scopePlan } : {}),
    ...(qualification
      ? { qualificationDependencyRefs: pageRoleDependencyRefs(scopePlan) }
      : {}),
    limit,
    includeDetails,
    ...(cursor ? { cursor } : {}),
  });
  const bound = bindPagesReportQualification({
    plan: builtPlan,
    siteId,
    filters,
    qualification,
  });
  const rows = await queryAnalyticsReportOutputSetRowsFromD1(
    env,
    bound.plan,
    {
      outputIds: PAGES_WITH_TABS_OUTPUT_IDS,
      fields: PAGES_WITH_TABS_OUTPUT_FIELDS,
      orderBy: [
        { field: "rowType", direction: "asc", nulls: "first" },
        { field: "cardType", direction: "asc", nulls: "first" },
        { field: "views", direction: "desc", nulls: "last" },
        { field: "sessions", direction: "desc", nulls: "last" },
        { field: "pathname", direction: "asc", nulls: "first" },
        { field: "queryValue", direction: "asc", nulls: "first" },
        { field: "hashValue", direction: "asc", nulls: "first" },
        { field: "value", direction: "asc", nulls: "first" },
      ],
    },
    undefined,
    bound.executionInputs,
  );
  const pageRows = rows
    .filter((row) => row.rowType === "page")
    .map((row) => ({
      pathname: String(row.pathname ?? ""),
      query: String(row.queryValue ?? ""),
      hash: String(row.hashValue ?? ""),
      views: Number(row.views ?? 0),
      sessions: Number(row.sessions ?? 0),
    }));
  const page = await pageResultWithCursor({
    env,
    siteId,
    window,
    filters,
    limit,
    includeDetails,
    audience,
    rows: pageRows,
  });
  return {
    pages: page,
    tabs: pageTabsFromRows(rows.filter((row) => row.rowType === "tab")),
  };
}

export type PagesTabsQualificationReadResult =
  | {
      readonly kind: "executed";
      readonly configuration: "tabs-only";
      readonly tabs: PageTabsResult;
      readonly evidence: EventSummaryQualificationCompilationEvidence;
    }
  | {
      readonly kind: "executed";
      readonly configuration: "pages-with-tabs";
      readonly result: PagesWithTabsResult;
      readonly evidence: EventSummaryQualificationCompilationEvidence;
    }
  | Exclude<
      Awaited<ReturnType<typeof executePagesTabsQualificationProgram>>,
      { readonly kind: "executed" }
    >;

/** Executes all Page tabs and the optional paginated Page report in one lowering. */
export async function queryQualifiedPagesTabsFromD1(input: {
  readonly env: Env;
  readonly siteId: string;
  readonly window: QueryWindow;
  readonly filters: FilterDocument;
  readonly limit: number;
  readonly includeDetails: boolean;
  readonly cursorText: string | null;
  readonly audience: QueryAudience;
  readonly deferred: DeferredPagesTabsQualification;
  readonly scopePlan?: Parameters<typeof buildPagesPagePlan>[0]["scopePlan"];
  readonly diagnostics?: D1ReadDiagnostics;
  readonly variant: string | undefined;
  readonly includeTabs: boolean | undefined;
}): Promise<PagesTabsQualificationReadResult> {
  const configuration = input.deferred.pagesTabsRequest.configuration;
  let cursor: PageAggregateCursor | null = null;
  let invalidCursor = false;
  if (configuration === "pages-with-tabs" && input.cursorText) {
    try {
      cursor = await decodePagesCursor(
        input.env,
        input.siteId,
        input.window,
        input.filters,
        input.includeDetails,
        input.cursorText,
        input.audience,
      );
    } catch (error) {
      if (!(error instanceof InvalidCursorError)) throw error;
      invalidCursor = true;
    }
    if (!cursor) invalidCursor = true;
  }
  const metadata = scopedFilterMetadata(input.filters);
  const query: PagesTabsQualificationReportQuery = {
    env: input.env,
    siteId: input.siteId,
    queryTime: metadata?.time ?? queryWindowToTime(input.window),
    filters: input.filters,
    ...(input.scopePlan ? { scopePlan: input.scopePlan } : {}),
    configuration,
    limit: input.limit,
    includeDetails: input.includeDetails,
    cursor: invalidCursor ? null : cursor,
    cursorToken: input.cursorText,
    audience: input.audience,
    variant: input.variant,
    includeTabs: input.includeTabs,
  };
  const execution = await executePagesTabsQualificationProgram({
    env: input.env,
    deferred: input.deferred,
    query,
    ...(input.diagnostics ? { diagnostics: input.diagnostics } : {}),
  });
  if (execution.kind !== "executed") {
    if (input.diagnostics)
      input.diagnostics.advancedCountSqlFallbackReason =
        execution.fallbackReason;
    return execution;
  }
  if (invalidCursor) throw new InvalidCursorError("pages");
  if (configuration === "tabs-only") {
    const tabRows = execution.rows.filter(
      (row) =>
        row.rowKind === "report" &&
        typeof row.outputId === "string" &&
        PAGE_TAB_OUTPUT_IDS.includes(row.outputId),
    );
    return {
      kind: "executed",
      configuration,
      tabs: pageTabsFromRows(tabRows),
      evidence: execution.evidence,
    };
  }
  const pageRows = execution.rows
    .filter((row) => row.rowKind === "report" && row.rowType === "page")
    .map((row) => ({
      pathname: String(row.pathname ?? ""),
      query: String(row.queryValue ?? ""),
      hash: String(row.hashValue ?? ""),
      views: Number(row.views ?? 0),
      sessions: Number(row.sessions ?? 0),
    }));
  const page = await pageResultWithCursor({
    env: input.env,
    siteId: input.siteId,
    window: input.window,
    filters: input.filters,
    limit: input.limit,
    includeDetails: input.includeDetails,
    audience: input.audience,
    rows: pageRows,
  });
  const tabRows = execution.rows.filter(
    (row) => row.rowKind === "report" && row.rowType === "tab",
  );
  return {
    kind: "executed",
    configuration,
    result: { pages: page, tabs: pageTabsFromRows(tabRows) },
    evidence: execution.evidence,
  };
}

export async function queryPageCardMetricsFromD1(
  env: Env,
  siteId: string,
  window: QueryWindow,
  filters: FilterDocument,
  options?: {
    pathnames?: string[];
    limit?: number;
    cursor?: PageDashboardCursor | null;
    search?: string;
    sort?: PagesDashboardMetric;
    direction?: SortDirection;
  },
): Promise<PageCardAggregateRow[]> {
  const metadata = scopedFilterMetadata(filters);
  const requestedPathnames = Array.from(
    new Set(
      (options?.pathnames ?? [])
        .map((pathname) => String(pathname ?? "").trim())
        .filter((pathname) => pathname.length > 0),
    ),
  );
  const search = options?.search?.trim();
  const plan = buildPageCardMetricsPlan({
    siteId,
    queryTime: queryWindowToTime(window),
    filters,
    ...(metadata ? { scopePlan: metadata.plan } : {}),
    ...(metadata ? { preparedTimePolicy: "reader-window-v1" as const } : {}),
    ...(requestedPathnames.length > 0 ? { pathnames: requestedPathnames } : {}),
    ...(typeof options?.limit === "number" ? { limit: options.limit } : {}),
    ...(options?.cursor ? { cursor: options.cursor } : {}),
    ...(search ? { search: search.toLowerCase() } : {}),
    sort: options?.sort ?? "views",
    direction: options?.direction ?? "desc",
  });
  const rows = await queryAnalyticsReportOutputRowsFromD1(
    env,
    plan,
    PAGE_CARD_METRICS_OUTPUT_ID,
  );
  return rows.map((row) => ({
    pathname: String(row.pathname ?? ""),
    views: Number(row.views ?? 0),
    sessions: Number(row.sessions ?? 0),
    visitors: Number(row.visitors ?? 0),
    bounces: Number(row.bounces ?? 0),
    totalDuration: Number(row.totalDuration ?? 0),
    durationViews: Number(row.durationViews ?? 0),
  }));
}
export async function queryPageCardTitlesFromD1(
  env: Env,
  siteId: string,
  window: QueryWindow,
  filters: FilterDocument,
  pathnames: string[],
  titleLimit: number,
): Promise<PageCardTitleRow[]> {
  const requestedPathnames = normalizePageCardPathnames(pathnames);
  if (requestedPathnames.length === 0) return [];

  const metadata = scopedFilterMetadata(filters);
  const plan = buildPageCardTitlesPlan({
    siteId,
    queryTime: queryWindowToTime(window),
    filters,
    ...(metadata ? { scopePlan: metadata.plan } : {}),
    pathnames: requestedPathnames,
    titleLimit,
  });
  const rows = await queryAnalyticsReportOutputRowsFromD1(
    env,
    plan,
    PAGE_CARD_DETAILS_OUTPUT_IDS.titles,
  );
  return rows.map((row) => ({
    pathname: String(row.pathname ?? ""),
    title: String(row.title ?? ""),
    views: Number(row.views ?? 0),
  }));
}
export async function queryPageCardTrendFromD1(
  env: Env,
  siteId: string,
  window: QueryWindow,
  interval: Interval,
  filters: FilterDocument,
  pathnames: string[],
): Promise<PageCardTrendRow[]> {
  const requestedPathnames = normalizePageCardPathnames(pathnames);
  if (requestedPathnames.length === 0) return [];

  const metadata = scopedFilterMetadata(filters);
  const buckets = buildTimeBuckets(window, interval);
  const plan = buildPageCardTrendPlan({
    siteId,
    queryTime: queryWindowToTime(window),
    interval,
    filters,
    ...(metadata ? { scopePlan: metadata.plan } : {}),
    pathnames: requestedPathnames,
  });
  const rows = await queryAnalyticsReportOutputRowsFromD1(
    env,
    plan,
    PAGE_CARD_DETAILS_OUTPUT_IDS.trend,
  );
  return rows.map((row) => ({
    pathname: String(row.pathname ?? ""),
    bucket: Number(row.bucket ?? 0),
    timestampMs: timeBucketTimestamp(buckets, Number(row.bucket ?? 0)),
    views: Number(row.views ?? 0),
    visitors: Number(row.visitors ?? 0),
  }));
}
export async function queryPageCardDetailsFromD1(
  env: Env,
  siteId: string,
  window: QueryWindow,
  interval: Interval,
  filters: FilterDocument,
  pathnames: string[],
  titleLimit: number,
): Promise<{ titles: PageCardTitleRow[]; trend: PageCardTrendRow[] }> {
  const requestedPathnames = normalizePageCardPathnames(pathnames);
  if (requestedPathnames.length === 0) return { titles: [], trend: [] };

  const metadata = scopedFilterMetadata(filters);
  const buckets = buildTimeBuckets(window, interval);
  const plan = buildPageCardDetailsPlan({
    siteId,
    queryTime: queryWindowToTime(window),
    interval,
    filters,
    ...(metadata ? { scopePlan: metadata.plan } : {}),
    pathnames: requestedPathnames,
    titleLimit,
  });
  const rows = await queryAnalyticsReportOutputSetRowsFromD1(env, plan, {
    outputIds: PAGE_CARD_DETAILS_MULTI_OUTPUT_IDS,
    fields: PAGE_CARD_DETAILS_MULTI_OUTPUT_FIELDS,
    orderBy: [
      { field: "rowKind", direction: "asc", nulls: "first" },
      { field: "pathname", direction: "asc", nulls: "first" },
      { field: "rowOrder", direction: "asc", nulls: "first" },
    ],
  });
  const titles: PageCardTitleRow[] = [];
  const trend: PageCardTrendRow[] = [];
  for (const row of rows) {
    if (row.rowKind === "title") {
      titles.push({
        pathname: String(row.pathname ?? ""),
        title: String(row.title ?? ""),
        views: Number(row.views ?? 0),
      });
      continue;
    }
    if (row.rowKind === "trend") {
      const trendBucket = Number(row.bucket ?? 0);
      trend.push({
        pathname: String(row.pathname ?? ""),
        bucket: trendBucket,
        timestampMs: timeBucketTimestamp(buckets, trendBucket),
        views: Number(row.views ?? 0),
        visitors: Number(row.visitors ?? 0),
      });
    }
  }
  return { titles, trend };
}

function normalizePageCardPathnames(pathnames: readonly unknown[]): string[] {
  return Array.from(
    new Set(
      pathnames
        .map((pathname) => String(pathname ?? "").trim())
        .filter((pathname) => pathname.length > 0),
    ),
  );
}
export async function queryDimensionAggregate(
  env: Env,
  siteId: string,
  window: QueryWindow,
  filters: FilterDocument,
  limit: number,
  selection: PageDimensionSelection,
  options?: { excludeEmpty?: boolean },
  diagnostics?: D1ReadDiagnostics,
): Promise<DimensionRow[]> {
  return queryVisitDimensionFromD1(
    env,
    siteId,
    window,
    filters,
    limit,
    selection,
    options,
    diagnostics,
  );
}
