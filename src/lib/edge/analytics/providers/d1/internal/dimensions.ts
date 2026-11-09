import { buildTrafficChannelSqlExpression } from "@/lib/analytics/traffic-channel-rules";
import {
  analyticsFilterRegistry,
  effectiveScopeForPagination,
  filterFingerprint,
  type QueryAudience,
  type QueryTime,
  scopedFilterMetadata,
} from "@/lib/edge/analytics/contract";
import { queryWindowToTime } from "@/lib/edge/analytics/contract/helpers";
import type { ScopedFilterPlan } from "@/lib/edge/analytics/contract/scoped-filter";
import {
  buildOverviewClientDimensionsPlan,
  buildOverviewGeoDimensionsPlan,
  OVERVIEW_CARD_OUTPUT_FIELDS,
  OVERVIEW_CLIENT_DIMENSION_OUTPUTS,
  OVERVIEW_GEO_DIMENSION_OUTPUTS,
} from "@/lib/edge/analytics/engine/channel-client-geo-report-plan";
import {
  buildDimensionPagePlan,
  buildDimensionTopPlan,
  DIMENSION_PAGE_REPORT_OUTPUT,
  type OverviewPageTableTab,
  type PageDimensionSelection,
  type PageDimensionSelectionId,
  validatePageDimensionSelection,
} from "@/lib/edge/analytics/engine/dimension-report-plan";
import {
  buildPageTabsPlan,
  PAGE_TAB_OUTPUT_FIELDS,
  PAGE_TAB_OUTPUT_IDS,
  PAGE_TAB_OUTPUT_ORDER_BY,
} from "@/lib/edge/analytics/engine/page-tabs-report-plan";
import { buildTopReferrersPlan } from "@/lib/edge/analytics/engine/referrer-report-plan";
import { EVENT_FILTER_PAGE_VISIT_DEPENDENCY } from "@/lib/edge/analytics/engine/semantic/qualification-dependency";
import {
  buildSessionPathPagePlan,
  buildSessionPathTopPlan,
  type NormalizedSessionBoundaryDimensionRequest,
  SESSION_PATH_PAGE_REPORT_OUTPUT,
  SESSION_PATH_TOP_REPORT_OUTPUT,
  sessionPathCursorBinding,
} from "@/lib/edge/analytics/engine/session-path-report-plan";
import type { Env } from "@/lib/edge/types";
import { InvalidCursorError } from "@/lib/pagination";

import {
  type DeferredChannelOverviewQualification,
  type DeferredOverviewPageTableQualification,
  type DeferredPageDimensionQualification,
  type DeferredSessionBoundaryDimensionQualification,
  type DeferredSessionBoundaryOverviewPageQualification,
  type DeferredSessionBoundaryOverviewPageRequest,
  prepareDeferredEventQualificationFallback,
  prepareDeferredPageVisitQualification,
} from "./advanced-filter-execution";
import {
  type EventSummaryQualificationCompilationEvidence,
  executePageDimensionQualificationProgram,
  executeSessionBoundaryDimensionQualificationProgram,
  executeSessionBoundaryOverviewPageQualificationProgram,
  type PageDimensionQualificationReportQuery,
  type SessionBoundaryDimensionQualificationReportQuery,
  type SessionBoundaryOverviewPageQualificationReportQuery,
} from "./analytics-qualification-program";
import {
  queryAnalyticsReportOutputRowsFromD1,
  queryAnalyticsReportOutputSetRowsFromD1,
} from "./analytics-report-query";
import type {
  ClientDimensionTabs,
  DimensionRow,
  FilterDocument,
  GeoDimensionTabs,
  GeoTabRow,
  QueryWindow,
  ReferrerRow,
} from "./core";
import { cityValueExpr, geoTabLabel, regionValueExpr } from "./core";
import {
  clientDimensionDefinition,
  resolveCrossBreakdownDimension,
  utmDimensionDefinition,
} from "./core-dimensions";
import type { D1ReadDiagnostics } from "./diagnostics";
import type { AdvancedCountSqlFallbackReason } from "./diagnostics";
import {
  assertFilterValuesPageQualificationProjection,
  bindPageVisitQualificationPreparation,
  type FilterValuesPageQualificationProjection,
  pageVisitQualificationConsumerKey,
  type PageVisitQualificationPreparation,
  snapshotPageVisitQualificationPlan,
} from "./page-visit-qualification-execution";
import {
  decodePageCursor,
  encodePageCursor,
  hasExactKeys,
  type PageResult,
  pageResult,
  paginationBindingForWindow,
} from "./pagination";

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

function legacyDimensionCursorToken(selection: PageDimensionSelection): string {
  const fromCrossBreakdown = (dimension: string) => {
    const definition = resolveCrossBreakdownDimension(dimension);
    if (!definition)
      throw new Error(`missing-legacy-dimension-token:${dimension}`);
    return definition.labelExpr;
  };
  const tokens: Record<PageDimensionSelectionId, string> = {
    pagePath: "pathname",
    pagePathTrimmed: fromCrossBreakdown("page.path"),
    pageTitle: "title",
    pageTitleTrimmed: fromCrossBreakdown("page.title"),
    pageHostname: "hostname",
    pageHostnameTrimmed: fromCrossBreakdown("page.hostname"),
    pageQuery: "query_string",
    pageQueryTrimmed: fromCrossBreakdown("page.query"),
    pageHash: "hash_fragment",
    pageHashTrimmed: fromCrossBreakdown("page.hash"),
    referrerUrl: fromCrossBreakdown("referrer.url"),
    utmSource: utmDimensionDefinition("source").labelExpr,
    utmMedium: utmDimensionDefinition("medium").labelExpr,
    utmCampaign: utmDimensionDefinition("campaign").labelExpr,
    utmTerm: utmDimensionDefinition("term").labelExpr,
    utmContent: utmDimensionDefinition("content").labelExpr,
    country: "country",
    countryTrimmed: fromCrossBreakdown("geo.country"),
    region: regionValueExpr(),
    city: cityValueExpr(),
    continent: "continent",
    continentTrimmed: fromCrossBreakdown("geo.continent"),
    timezone: "timezone",
    timezoneTrimmed: fromCrossBreakdown("geo.timeZone"),
    organization: "as_organization",
    organizationTrimmed: fromCrossBreakdown("geo.organization"),
    browser: clientDimensionDefinition("browser").labelExpr,
    browserVersion: fromCrossBreakdown("client.browserVersion"),
    browserEngine: fromCrossBreakdown("client.browserEngine"),
    operatingSystem: clientDimensionDefinition("operatingSystem").labelExpr,
    osVersion: clientDimensionDefinition("osVersion").labelExpr,
    deviceType: clientDimensionDefinition("deviceType").labelExpr,
    language: clientDimensionDefinition("language").labelExpr,
    screenSize: clientDimensionDefinition("screenSize").labelExpr,
    userId: fromCrossBreakdown("user.id"),
    userName: fromCrossBreakdown("user.name"),
    referrerDomain: fromCrossBreakdown("referrer.domain"),
    trafficChannel: buildTrafficChannelSqlExpression(),
  };
  const token = tokens[selection.id];
  if (!token) throw new Error("unsupported-page-dimension-selection");
  return token;
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
  selection: PageDimensionSelection,
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
    legacyDimensionCursorToken(selection),
    search?.trim().toLowerCase() ?? "",
    sortBy,
    sortDirection,
  ]);
}

export async function queryDimensionFromD1(
  env: Env,
  siteId: string,
  window: QueryWindow,
  filters: FilterDocument,
  limit: number,
  selectionInput: PageDimensionSelection,
  options?: {
    excludeEmpty?: boolean;
    search?: string;
    sortBy?: DimensionPageSortKey;
    sortDirection?: "asc" | "desc";
  },
  diagnostics?: D1ReadDiagnostics,
): Promise<DimensionRow[]> {
  const selection = validatePageDimensionSelection(selectionInput);
  const sortBy = dimensionSortKey(options?.sortBy);
  const sortDirection = dimensionSortDirection(options?.sortDirection);
  const metadata = scopedFilterMetadata(filters);
  const plan = buildDimensionTopPlan({
    siteId,
    queryTime: metadata?.time ?? queryWindowToTime(window),
    filters,
    ...(metadata ? { scopePlan: metadata.plan } : {}),
    limit,
    selection,
    excludeEmpty: options?.excludeEmpty,
    search: options?.search,
    sortBy,
    sortDirection,
  });
  return (
    await queryAnalyticsReportOutputRowsFromD1(
      env,
      plan,
      "dimension-top",
      undefined,
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
  selectionInput: PageDimensionSelection,
  options?: {
    excludeEmpty?: boolean;
    search?: string;
    sortBy?: DimensionPageSortKey;
    sortDirection?: "asc" | "desc";
  },
  cursor?: DimensionAggregateCursor | null,
  diagnostics?: D1ReadDiagnostics,
  audience: QueryAudience = "private-dashboard",
  qualification?: {
    readonly preparation: PageVisitQualificationPreparation;
    readonly queryTime: QueryTime;
    readonly scopePlan: ScopedFilterPlan;
    readonly consumer: string;
  },
): Promise<PageResult<DimensionRow>> {
  const selection = validatePageDimensionSelection(selectionInput);
  const sortBy = dimensionSortKey(options?.sortBy);
  const sortDirection = dimensionSortDirection(options?.sortDirection);
  const metadata = scopedFilterMetadata(filters);
  const queryTime =
    qualification?.queryTime ?? metadata?.time ?? queryWindowToTime(window);
  const scopePlan = qualification?.scopePlan ?? metadata?.plan;
  const builtPlan = buildDimensionPagePlan({
    siteId,
    queryTime,
    filters,
    ...(scopePlan ? { scopePlan } : {}),
    ...(qualification
      ? {
          qualificationDependencyRefs: [EVENT_FILTER_PAGE_VISIT_DEPENDENCY],
        }
      : {}),
    limit,
    selection,
    excludeEmpty: options?.excludeEmpty,
    search: options?.search,
    sortBy,
    sortDirection,
    cursor,
  });
  const plan = qualification
    ? snapshotPageVisitQualificationPlan(builtPlan)
    : builtPlan;
  const qualificationExecutionInputs = qualification
    ? bindPageVisitQualificationPreparation({
        preparation: qualification.preparation,
        siteId,
        filters,
        queryTime,
        scopePlan: qualification.scopePlan,
        consumerKey: dimensionPageQualificationConsumerKey(
          qualification.consumer,
          {
            limit,
            selection,
            excludeEmpty: options?.excludeEmpty,
            search: options?.search,
            sortBy,
            sortDirection,
            cursor,
            audience,
          },
        ),
        plan,
      })
    : undefined;
  const rows = await queryAnalyticsReportOutputRowsFromD1(
    env,
    plan,
    "dimension-page",
    undefined,
    diagnostics,
    qualificationExecutionInputs,
  );
  const mapped = rows.map((row) => ({
    value: String(row.value ?? ""),
    views: Number(row.views ?? 0),
    sessions: Number(row.sessions ?? 0),
    visitors: Number(row.visitors ?? 0),
  }));
  return dimensionPageResultFromRows({
    env,
    siteId,
    window,
    filters,
    limit,
    selection,
    options: { search: options?.search, sortBy, sortDirection },
    audience,
    rows: mapped,
  });
}

export function dimensionPageQualificationConsumerKey(
  consumer: string,
  configuration: {
    readonly limit: number;
    readonly selection: PageDimensionSelection;
    readonly excludeEmpty?: boolean;
    readonly search?: string;
    readonly sortBy: DimensionPageSortKey;
    readonly sortDirection: "asc" | "desc";
    readonly cursor?: DimensionAggregateCursor | null;
    readonly audience: QueryAudience;
  },
) {
  return pageVisitQualificationConsumerKey(consumer, configuration);
}

export async function dimensionPageResultFromRows(input: {
  readonly env: Env;
  readonly siteId: string;
  readonly window: QueryWindow;
  readonly filters: FilterDocument;
  readonly limit: number;
  readonly selection: PageDimensionSelection;
  readonly options: {
    readonly search?: string;
    readonly sortBy: DimensionPageSortKey;
    readonly sortDirection: "asc" | "desc";
  };
  readonly audience: QueryAudience;
  readonly rows: readonly DimensionRow[];
}): Promise<PageResult<DimensionRow>> {
  const { primary, secondary } = dimensionSortColumns(input.options.sortBy);
  const page = pageResult([...input.rows], input.limit);
  const binding = await dimensionCursorBinding(
    "dimensions",
    input.siteId,
    input.window,
    input.filters,
    input.selection,
    input.options.search,
    input.audience,
    input.options.sortBy,
    input.options.sortDirection,
  );
  const nextCursor =
    page.hasMore && page.last
      ? await encodePageCursor(input.env, binding, {
          primary: page.last[primary],
          secondary: page.last[secondary],
          value: page.last.value,
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

interface QualifiedDimensionPageInputBase {
  readonly env: Env;
  readonly siteId: string;
  readonly window: QueryWindow;
  readonly queryTime: QueryTime;
  readonly filters: FilterDocument;
  readonly scopePlan?: ScopedFilterPlan;
  readonly limit: number;
  readonly selection: PageDimensionSelection;
  readonly cursor: DimensionAggregateCursor | null;
  readonly cursorToken: string | null;
  readonly audience: QueryAudience;
  readonly diagnostics?: D1ReadDiagnostics;
}

export type QualifiedDimensionPageInput =
  | (QualifiedDimensionPageInputBase & {
      readonly family: "breakdown";
      readonly dimension: string;
      readonly options: {
        readonly excludeEmpty: false;
        readonly search?: string;
        readonly sortBy: DimensionPageSortKey;
        readonly sortDirection: "asc" | "desc";
      };
      readonly deferred: DeferredPageDimensionQualification;
    })
  | (QualifiedDimensionPageInputBase & {
      readonly family: "overview-tab";
      readonly tab: OverviewPageTableTab;
      readonly options: {
        readonly excludeEmpty: boolean;
        readonly search?: string;
        readonly sortBy: DimensionPageSortKey;
        readonly sortDirection: "asc" | "desc";
      };
      readonly deferred:
        | DeferredOverviewPageTableQualification
        | DeferredChannelOverviewQualification;
    });

export type QualifiedDimensionPageResult =
  | {
      readonly kind: "executed";
      readonly page: PageResult<DimensionRow>;
      readonly evidence: EventSummaryQualificationCompilationEvidence;
    }
  | {
      readonly kind: "legacy" | "unavailable";
      readonly fallbackReason: AdvancedCountSqlFallbackReason;
    };

function pageDimensionQualificationQuery(
  input: QualifiedDimensionPageInput,
): PageDimensionQualificationReportQuery {
  const common = {
    siteId: input.siteId,
    queryTime: input.queryTime,
    filters: input.filters,
    ...(input.scopePlan ? { scopePlan: input.scopePlan } : {}),
    selection: input.selection,
    limit: input.limit,
    cursor: input.cursor,
    cursorToken: input.cursorToken,
    ...(input.options.search !== undefined
      ? { search: input.options.search }
      : {}),
    sortBy: input.options.sortBy,
    sortDirection: input.options.sortDirection,
    audience: input.audience,
  };
  return input.family === "breakdown"
    ? {
        ...common,
        family: "breakdown",
        dimension: input.dimension,
        excludeEmpty: false,
      }
    : {
        ...common,
        family: "overview-tab",
        tab: input.tab,
        excludeEmpty: input.options.excludeEmpty,
      };
}

async function executeQualifiedDimensionPage(
  input: QualifiedDimensionPageInput,
) {
  return executePageDimensionQualificationProgram({
    env: input.env,
    deferred: input.deferred,
    query: pageDimensionQualificationQuery(input),
    ...(input.diagnostics ? { diagnostics: input.diagnostics } : {}),
  });
}

/** Runs the same prepared Page dimension report with shared Count controls. */
export async function queryQualifiedDimensionPageFromD1(
  input: QualifiedDimensionPageInput,
): Promise<QualifiedDimensionPageResult> {
  const execution = await executeQualifiedDimensionPage(input);
  if (execution.kind !== "executed") return execution;
  const mapped = execution.rows
    .filter(
      (row) =>
        row.rowKind === "report" &&
        row.outputId === DIMENSION_PAGE_REPORT_OUTPUT,
    )
    .map((row) => ({
      value: String(row.value ?? ""),
      views: Number(row.views ?? 0),
      sessions: Number(row.sessions ?? 0),
      visitors: Number(row.visitors ?? 0),
    }));
  const page = await dimensionPageResultFromRows({
    env: input.env,
    siteId: input.siteId,
    window: input.window,
    filters: input.filters,
    limit: input.limit,
    selection: input.selection,
    options: input.options,
    audience: input.audience,
    rows: mapped,
  });
  return { kind: "executed", page, evidence: execution.evidence };
}

/** Ensures Count errors retain precedence when the supplied cursor is bad. */
export async function preflightQualifiedDimensionPageCursorFromD1(
  input: QualifiedDimensionPageInput,
): Promise<void> {
  const execution = await executeQualifiedDimensionPage(input);
  if (execution.kind === "executed") return;
  const consumer =
    input.family === "overview-tab" && input.tab === "source.channel"
      ? "channel-overview"
      : undefined;
  const preparation = consumer
    ? await prepareDeferredPageVisitQualification(
        input.deferred,
        dimensionPageQualificationConsumerKey(consumer, {
          limit: input.limit,
          selection: input.selection,
          excludeEmpty: input.options.excludeEmpty,
          search: input.options.search,
          sortBy: input.options.sortBy,
          sortDirection: input.options.sortDirection,
          cursor: null,
          audience: input.audience,
        }),
      )
    : undefined;
  const fallbackFilters = preparation
    ? input.filters
    : await prepareDeferredEventQualificationFallback(input.deferred);
  await queryDimensionPageFromD1(
    input.env,
    input.siteId,
    input.window,
    fallbackFilters,
    input.limit,
    input.selection,
    input.options,
    null,
    input.diagnostics,
    input.audience,
    preparation
      ? {
          preparation,
          queryTime: input.queryTime,
          scopePlan: input.scopePlan ?? input.deferred.metadata.plan,
          consumer: consumer!,
        }
      : undefined,
  );
}

export async function decodeDimensionCursor(
  env: Env,
  siteId: string,
  window: QueryWindow,
  filters: FilterDocument,
  selectionInput: PageDimensionSelection,
  search?: string,
  cursor?: string | null,
  audience: QueryAudience = "private-dashboard",
  sortBy: DimensionPageSortKey = "views",
  sortDirection: "asc" | "desc" = "desc",
): Promise<DimensionAggregateCursor | null> {
  const selection = validatePageDimensionSelection(selectionInput);
  return decodePageCursor<DimensionAggregateCursor>(
    env,
    await dimensionCursorBinding(
      "dimensions",
      siteId,
      window,
      filters,
      selection,
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
  qualification?: {
    readonly preparation: PageVisitQualificationPreparation;
    readonly queryTime: QueryTime;
    readonly scopePlan: ScopedFilterPlan;
    readonly audience: QueryAudience;
  },
): Promise<DimensionRow[]> {
  const metadata = scopedFilterMetadata(filters);
  const queryTime =
    qualification?.queryTime ?? metadata?.time ?? queryWindowToTime(window);
  const scopePlan = qualification?.scopePlan ?? metadata?.plan;
  const builtPlan = buildSessionPathTopPlan({
    siteId,
    queryTime,
    filters,
    ...(scopePlan ? { scopePlan } : {}),
    ...(qualification
      ? {
          qualificationDependencyRefs: [EVENT_FILTER_PAGE_VISIT_DEPENDENCY],
        }
      : {}),
    limit,
    kind,
    search,
    sortBy: dimensionSortKey(sortBy),
    sortDirection: dimensionSortDirection(sortDirection),
  });
  const plan = qualification
    ? snapshotPageVisitQualificationPlan(builtPlan)
    : builtPlan;
  const qualificationExecutionInputs = qualification
    ? bindPageVisitQualificationPreparation({
        preparation: qualification.preparation,
        siteId,
        filters,
        queryTime,
        scopePlan: qualification.scopePlan,
        consumerKey: sessionPathTopQualificationConsumerKey({
          kind,
          limit,
          search,
          sortBy: dimensionSortKey(sortBy),
          sortDirection: dimensionSortDirection(sortDirection),
          audience: qualification.audience,
        }),
        plan,
      })
    : undefined;
  return (
    await queryAnalyticsReportOutputRowsFromD1(
      env,
      plan,
      "session-path-top",
      undefined,
      diagnostics,
      qualificationExecutionInputs,
    )
  ).map((row) => ({
    value: String(row.value ?? ""),
    views: Number(row.views ?? 0),
    sessions: Number(row.sessions ?? 0),
    visitors: Number(row.visitors ?? 0),
  }));
}

export function sessionPathTopQualificationConsumerKey(input: {
  readonly kind: SessionPathKind;
  readonly limit: number;
  readonly search?: string;
  readonly sortBy: DimensionPageSortKey;
  readonly sortDirection: "asc" | "desc";
  readonly audience: QueryAudience;
}) {
  return pageVisitQualificationConsumerKey("session-boundary-dimension", input);
}

export function sessionPathPageQualificationConsumerKey(
  consumer: "session-boundary-overview-page" | "filter-values",
  input: {
    readonly limit: number;
    readonly kind: SessionPathKind;
    readonly search?: string;
    readonly cursor?: SessionPathDimensionCursor | null;
    readonly audience: QueryAudience;
    readonly sortBy: DimensionPageSortKey;
    readonly sortDirection: "asc" | "desc";
  },
) {
  return pageVisitQualificationConsumerKey(consumer, input);
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
  qualification?: {
    readonly preparation: PageVisitQualificationPreparation;
    readonly queryTime: QueryTime;
    readonly scopePlan: ScopedFilterPlan;
    readonly audience: QueryAudience;
    readonly consumer: "session-boundary-overview-page" | "filter-values";
    readonly filterValuesProjection?: FilterValuesPageQualificationProjection;
  },
): Promise<PageResult<DimensionRow>> {
  const effectiveSortBy = dimensionSortKey(sortBy);
  const effectiveSortDirection = sortDirection === "asc" ? "asc" : "desc";
  const metadata = scopedFilterMetadata(filters);
  const queryTime =
    qualification?.queryTime ?? metadata?.time ?? queryWindowToTime(window);
  const scopePlan = qualification?.scopePlan ?? metadata?.plan;
  const builtPlan = buildSessionPathPagePlan({
    siteId,
    queryTime,
    filters,
    ...(scopePlan ? { scopePlan } : {}),
    ...(qualification
      ? {
          qualificationDependencyRefs: [EVENT_FILTER_PAGE_VISIT_DEPENDENCY],
        }
      : {}),
    limit,
    kind,
    search,
    sortBy: effectiveSortBy,
    sortDirection: effectiveSortDirection,
    cursor,
  });
  const plan = qualification
    ? snapshotPageVisitQualificationPlan(builtPlan)
    : builtPlan;
  const qualificationExecutionInputs = qualification
    ? bindPageVisitQualificationPreparation({
        preparation: qualification.preparation,
        siteId,
        filters,
        queryTime,
        scopePlan: qualification.scopePlan,
        consumerKey:
          qualification.consumer === "filter-values"
            ? assertFilterValuesPageQualificationProjection({
                projection: qualification.filterValuesProjection!,
                field:
                  kind === "entry" ? "session.entryPath" : "session.exitPath",
                limit,
                hasCursor: cursor !== undefined && cursor !== null,
                cursor,
                search,
                audience: qualification.audience,
              })
            : sessionPathPageQualificationConsumerKey(qualification.consumer, {
                limit,
                kind,
                search,
                cursor,
                audience: qualification.audience,
                sortBy: effectiveSortBy,
                sortDirection: effectiveSortDirection,
              }),
        plan,
      })
    : undefined;
  const rows = await queryAnalyticsReportOutputRowsFromD1(
    env,
    plan,
    "session-path-page",
    undefined,
    diagnostics,
    qualificationExecutionInputs,
  );
  return finalizeSessionPathDimensionPage({
    env,
    siteId,
    window,
    filters,
    limit,
    kind,
    search,
    audience,
    sortBy: effectiveSortBy,
    sortDirection: effectiveSortDirection,
    rows,
  });
}

export async function finalizeSessionPathDimensionPage(input: {
  readonly env: Env;
  readonly siteId: string;
  readonly window: QueryWindow;
  readonly filters: FilterDocument;
  readonly limit: number;
  readonly kind: SessionPathKind;
  readonly search?: string;
  readonly audience: QueryAudience;
  readonly sortBy: DimensionPageSortKey;
  readonly sortDirection: "asc" | "desc";
  readonly rows: readonly Record<string, unknown>[];
}): Promise<PageResult<DimensionRow>> {
  const mapped = input.rows.map((row) => ({
    value: String(row.value ?? ""),
    views: Number(row.views ?? 0),
    sessions: Number(row.sessions ?? 0),
    visitors: Number(row.visitors ?? 0),
  }));
  const page = pageResult(mapped, input.limit);
  const binding = await paginationBindingForWindow(
    input.window,
    sessionPathCursorBinding({
      operation: input.kind,
      siteId: input.siteId,
      window: input.window,
      filters: input.filters,
      search: input.search,
      audience: input.audience,
      sortBy: input.sortBy,
      sortDirection: input.sortDirection,
    }),
  );
  const nextCursor =
    page.hasMore && page.last
      ? await encodePageCursor(
          input.env,
          binding,
          input.sortBy === "visitors"
            ? {
                views: page.last.views,
                visitors: page.last.visitors,
                value: page.last.value,
              }
            : {
                views:
                  input.sortBy === "sessions"
                    ? page.last.sessions
                    : page.last.views,
                value: page.last.value,
              },
        )
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

export async function querySessionBoundaryOverviewPageFromD1(
  env: Env,
  siteId: string,
  window: QueryWindow,
  filters: FilterDocument,
  limit: number,
  kind: SessionPathKind,
  diagnostics: D1ReadDiagnostics | undefined,
  search: string | undefined,
  cursor: SessionPathDimensionCursor | null,
  cursorToken: string | null,
  audience: QueryAudience,
  sortBy: DimensionPageSortKey,
  sortDirection: "asc" | "desc",
  options: {
    readonly deferredQualification: DeferredSessionBoundaryOverviewPageQualification;
    readonly request: DeferredSessionBoundaryOverviewPageRequest;
    readonly queryTime: QueryTime;
    readonly scopePlan?: ScopedFilterPlan;
    readonly mode: "overview-tab";
    readonly tab: "page.entry" | "page.exit";
  },
): Promise<PageResult<DimensionRow>> {
  const deferred = options.deferredQualification;
  const prepared = deferred.sessionBoundaryOverviewPageRequest;
  const scopePlanMatches =
    options.scopePlan === undefined
      ? deferred.requestScopePlan === undefined
      : deferred.requestScopePlan !== undefined &&
        JSON.stringify(deferred.requestScopePlan) ===
          JSON.stringify(options.scopePlan);
  if (
    !prepared ||
    deferred.operation !== "session-boundary-overview-page" ||
    deferred.siteId !== siteId ||
    deferred.filters !== filters ||
    !deferred.requestTime ||
    !sameSessionBoundaryDimensionQueryTime(
      deferred.requestTime,
      options.queryTime,
    ) ||
    !sameSessionBoundaryDimensionQueryTime(deferred.time, options.queryTime) ||
    !scopePlanMatches ||
    options.request.mode !== prepared.mode ||
    options.request.tab !== prepared.tab ||
    options.request.kind !== prepared.kind ||
    options.request.dimension !== prepared.dimension ||
    options.request.limit !== prepared.limit ||
    options.request.cursorToken !== prepared.cursorToken ||
    options.request.search !== prepared.search ||
    options.request.sortBy !== prepared.sortBy ||
    options.request.sortDirection !== prepared.sortDirection ||
    options.request.audience !== prepared.audience ||
    prepared.mode !== options.mode ||
    prepared.tab !== options.tab ||
    prepared.kind !== kind ||
    prepared.dimension !==
      (kind === "entry" ? "session.entryPath" : "session.exitPath") ||
    prepared.limit !== limit ||
    prepared.search !== search ||
    prepared.cursorToken !== cursorToken ||
    prepared.sortBy !== dimensionSortKey(sortBy) ||
    prepared.sortDirection !== dimensionSortDirection(sortDirection) ||
    prepared.audience !== audience
  )
    throw new Error(
      "session_boundary_overview_page_qualification_request_mismatch",
    );

  const query: SessionBoundaryOverviewPageQualificationReportQuery = {
    siteId,
    queryTime: options.queryTime,
    filters,
    ...(options.scopePlan ? { scopePlan: options.scopePlan } : {}),
    mode: options.mode,
    tab: options.tab,
    dimension: prepared.dimension,
    kind: prepared.kind,
    limit: prepared.limit,
    cursor,
    cursorToken,
    ...(prepared.search !== undefined ? { search: prepared.search } : {}),
    sortBy: prepared.sortBy,
    sortDirection: prepared.sortDirection,
    audience: prepared.audience,
  };
  const execution =
    await executeSessionBoundaryOverviewPageQualificationProgram({
      env,
      deferred,
      query,
      ...(diagnostics ? { diagnostics } : {}),
    });
  if (execution.kind === "executed") {
    if (cursorToken !== null && cursor === null)
      throw new InvalidCursorError("overview-tab");
    return finalizeSessionPathDimensionPage({
      env,
      siteId,
      window,
      filters,
      limit,
      kind,
      search,
      audience,
      sortBy: dimensionSortKey(sortBy),
      sortDirection: dimensionSortDirection(sortDirection),
      rows: execution.rows.filter(
        (row) =>
          row.rowKind === "report" &&
          row.outputId === SESSION_PATH_PAGE_REPORT_OUTPUT,
      ),
    });
  }
  const fallbackAllowed =
    execution.kind === "unavailable"
      ? execution.fallbackReason.kind === "compile-budget" ||
        execution.fallbackReason.kind === "grouped-summary-unavailable" ||
        execution.fallbackReason.kind === "compiler-unavailable"
      : execution.fallbackReason.kind === "numeric-data-domain";
  if (!fallbackAllowed)
    throw new Error(
      "session_boundary_overview_page_qualification_proof_invalid",
    );
  if (diagnostics)
    diagnostics.advancedCountSqlFallbackReason = execution.fallbackReason;
  const preparation = await prepareDeferredPageVisitQualification(
    deferred,
    sessionPathPageQualificationConsumerKey("session-boundary-overview-page", {
      limit,
      kind,
      search,
      cursor,
      audience,
      sortBy: dimensionSortKey(sortBy),
      sortDirection: dimensionSortDirection(sortDirection),
    }),
  );
  const fallbackFilters = preparation
    ? filters
    : await prepareDeferredEventQualificationFallback(deferred);
  if (cursorToken !== null && cursor === null)
    throw new InvalidCursorError("overview-tab");
  return querySessionPathDimensionPageFromD1(
    env,
    siteId,
    window,
    fallbackFilters,
    limit,
    kind,
    diagnostics,
    search,
    cursor,
    audience,
    sortBy,
    sortDirection,
    preparation
      ? {
          preparation,
          queryTime: options.queryTime,
          scopePlan: options.scopePlan ?? deferred.metadata.plan,
          audience,
          consumer: "session-boundary-overview-page",
        }
      : undefined,
  );
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
    await paginationBindingForWindow(
      window,
      sessionPathCursorBinding({
        operation: kind,
        siteId,
        window,
        filters,
        search,
        audience,
        sortBy: effectiveSortBy,
        sortDirection: effectiveSortDirection,
      }),
    ),
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
  selection: PageDimensionSelection,
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
    selection,
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
  options?: {
    readonly deferredQualification?: DeferredSessionBoundaryDimensionQualification;
    readonly request?: NormalizedSessionBoundaryDimensionRequest;
    readonly queryTime?: QueryTime;
    readonly scopePlan?: ScopedFilterPlan;
    readonly audience?: QueryAudience;
  },
): Promise<DimensionRow[]> {
  const deferred = options?.deferredQualification;
  if (deferred) {
    const request = options.request;
    const queryTime = options.queryTime;
    const scopePlanMatches =
      options.scopePlan === undefined
        ? deferred.requestScopePlan === undefined
        : deferred.requestScopePlan !== undefined &&
          JSON.stringify(deferred.requestScopePlan) ===
            JSON.stringify(options.scopePlan);
    if (
      !request ||
      !queryTime ||
      deferred.operation !== "session-boundary-dimension" ||
      deferred.siteId !== siteId ||
      deferred.filters !== filters ||
      !deferred.requestTime ||
      !sameSessionBoundaryDimensionQueryTime(deferred.requestTime, queryTime) ||
      !sameSessionBoundaryDimensionQueryTime(deferred.time, queryTime) ||
      !scopePlanMatches ||
      request.kind !== kind ||
      request.limit !== limit ||
      request.search !== search ||
      request.sortBy !== dimensionSortKey(sortBy) ||
      request.sortDirection !== dimensionSortDirection(sortDirection) ||
      request.audience !== (options.audience ?? "private-dashboard") ||
      request.dimension !==
        (kind === "entry" ? "session.entryPath" : "session.exitPath")
    )
      throw new Error(
        "session_boundary_dimension_qualification_request_mismatch",
      );

    const query: SessionBoundaryDimensionQualificationReportQuery = {
      siteId,
      queryTime,
      filters,
      ...(options.scopePlan ? { scopePlan: options.scopePlan } : {}),
      dimension: request.dimension,
      kind: request.kind,
      limit: request.limit,
      ...(request.search !== undefined ? { search: request.search } : {}),
      sortBy: request.sortBy,
      sortDirection: request.sortDirection,
      audience: request.audience,
    };
    const execution = await executeSessionBoundaryDimensionQualificationProgram(
      {
        env,
        deferred,
        query,
        ...(diagnostics ? { diagnostics } : {}),
      },
    );
    if (execution.kind === "executed")
      return execution.rows
        .filter(
          (row) =>
            row.rowKind === "report" &&
            row.outputId === SESSION_PATH_TOP_REPORT_OUTPUT,
        )
        .map((row) => ({
          value: String(row.value ?? ""),
          views: Number(row.views ?? 0),
          sessions: Number(row.sessions ?? 0),
          visitors: Number(row.visitors ?? 0),
        }));
    if (
      execution.kind === "legacy" &&
      execution.fallbackReason.kind !== "numeric-data-domain"
    )
      throw new Error("session_boundary_dimension_qualification_proof_invalid");
    if (diagnostics)
      diagnostics.advancedCountSqlFallbackReason = execution.fallbackReason;
    const preparation = await prepareDeferredPageVisitQualification(
      deferred,
      sessionPathTopQualificationConsumerKey({
        kind,
        limit,
        search,
        sortBy: dimensionSortKey(sortBy),
        sortDirection: dimensionSortDirection(sortDirection),
        audience: request.audience,
      }),
    );
    const fallbackFilters = preparation
      ? filters
      : await prepareDeferredEventQualificationFallback(deferred);
    return querySessionPathDimensionFromD1(
      env,
      siteId,
      window,
      fallbackFilters,
      limit,
      kind,
      diagnostics,
      search,
      sortBy,
      sortDirection,
      preparation
        ? {
            preparation,
            queryTime: queryTime!,
            scopePlan: options.scopePlan ?? deferred.metadata.plan,
            audience: request.audience,
          }
        : undefined,
    );
  }
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

function sameSessionBoundaryDimensionQueryTime(
  left: QueryTime,
  right: QueryTime,
): boolean {
  const leftRead = left.readRange ?? left.range;
  const rightRead = right.readRange ?? right.range;
  return (
    left.range.startMs === right.range.startMs &&
    left.range.endExclusiveMs === right.range.endExclusiveMs &&
    leftRead.startMs === rightRead.startMs &&
    leftRead.endExclusiveMs === rightRead.endExclusiveMs &&
    JSON.stringify(left.filterRange) === JSON.stringify(right.filterRange) &&
    left.filterRangeEmpty === right.filterRangeEmpty &&
    left.fullHistory === right.fullHistory &&
    left.reportingTimeZone === right.reportingTimeZone &&
    left.capturedAtMs === right.capturedAtMs
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
  const metadata = scopedFilterMetadata(filters);
  const plan = buildPageTabsPlan({
    siteId,
    queryTime: metadata?.time ?? queryWindowToTime(window),
    filters,
    ...(metadata ? { scopePlan: metadata.plan } : {}),
    limit,
  });
  const rows = await queryAnalyticsReportOutputSetRowsFromD1(env, plan, {
    outputIds: PAGE_TAB_OUTPUT_IDS,
    fields: PAGE_TAB_OUTPUT_FIELDS,
    orderBy: PAGE_TAB_OUTPUT_ORDER_BY,
  });
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
  const metadata = scopedFilterMetadata(filters);
  const plan = buildTopReferrersPlan({
    siteId,
    queryTime: metadata?.time ?? queryWindowToTime(window),
    filters,
    ...(metadata ? { scopePlan: metadata.plan } : {}),
    limit,
    includeFullUrl,
    ...(search !== undefined ? { search } : {}),
  });
  const rows = await queryAnalyticsReportOutputRowsFromD1(
    env,
    plan,
    "referrers-top",
    undefined,
    diagnostics,
  );
  return rows.map((row) => ({
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
  const metadata = scopedFilterMetadata(filters);
  const plan = buildOverviewClientDimensionsPlan({
    siteId,
    queryTime: metadata?.time ?? queryWindowToTime(window),
    filters,
    ...(metadata ? { scopePlan: metadata.plan } : {}),
    limit,
  });
  const rows = await queryAnalyticsReportOutputSetRowsFromD1(env, plan, {
    outputIds: OVERVIEW_CLIENT_DIMENSION_OUTPUTS,
    fields: OVERVIEW_CARD_OUTPUT_FIELDS.client,
    orderBy: [
      { field: "cardType", direction: "asc", nulls: "first" },
      { field: "views", direction: "desc", nulls: "last" },
      { field: "sessions", direction: "desc", nulls: "last" },
      { field: "value", direction: "asc", nulls: "first" },
    ],
  });
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
  const metadata = scopedFilterMetadata(filters);
  const plan = buildOverviewGeoDimensionsPlan({
    siteId,
    queryTime: metadata?.time ?? queryWindowToTime(window),
    filters,
    ...(metadata ? { scopePlan: metadata.plan } : {}),
    limit,
  });
  const fields = OVERVIEW_CARD_OUTPUT_FIELDS.geo;
  const orderBy = [
    { field: "cardType", direction: "asc" as const, nulls: "first" as const },
    { field: "views", direction: "desc" as const, nulls: "last" as const },
    { field: "sessions", direction: "desc" as const, nulls: "last" as const },
    { field: "visitors", direction: "desc" as const, nulls: "last" as const },
    { field: "value", direction: "asc" as const, nulls: "first" as const },
  ];
  const [firstGeoCards, organizationCard] = await Promise.all([
    queryAnalyticsReportOutputSetRowsFromD1(env, plan, {
      outputIds: OVERVIEW_GEO_DIMENSION_OUTPUTS.slice(0, 5),
      fields,
      orderBy,
    }),
    queryAnalyticsReportOutputSetRowsFromD1(env, plan, {
      outputIds: OVERVIEW_GEO_DIMENSION_OUTPUTS.slice(5),
      fields,
      orderBy,
    }),
  ]);
  const rows = [...firstGeoCards, ...organizationCard];
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
