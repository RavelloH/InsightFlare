import { buildTrafficChannelSqlExpression } from "@/lib/analytics/traffic-channel-rules";
import type { AnalyticsProviderRegistry } from "@/lib/edge/analytics/application/provider-registry";
import { typedQueryProviderFor } from "@/lib/edge/analytics/application/provider-registry";
import type {
  ChannelOverviewTabQuery,
  DimensionOverviewTabQuery,
  OverviewTableComparisonQuery,
  OverviewTabResult,
  PerformanceQuery,
  QueryInput,
  QueryTime,
} from "@/lib/edge/analytics/contract";
import { EMPTY_FILTER_DOCUMENT } from "@/lib/edge/analytics/contract";
import { comparisonPageTab } from "@/lib/edge/analytics/engine/comparison-page-tabs";
import {
  analyticsPageDimensionSelection,
  dimensionPageSelection,
  normalizeDimensionPageRequest,
  normalizeOverviewPageTableRequest,
  overviewPageTableDescriptor,
  PAGE_DIMENSION_SELECTIONS,
  type PageDimensionSelection,
} from "@/lib/edge/analytics/engine/dimension-report-plan";
import { normalizeEventNameDimensionListRequest } from "@/lib/edge/analytics/engine/event-type-summary-plan";
import { normalizeReferrerOverviewTableRequest } from "@/lib/edge/analytics/engine/referrer-report-plan";
import { normalizeSessionBoundaryDimensionRequest } from "@/lib/edge/analytics/engine/session-path-report-plan";
import {
  deferredChannelListQualificationFromQuery,
  deferredChannelOverviewQualificationFromQuery,
  deferredComparisonPageQualificationFromQuery,
  deferredEventNameDimensionQualificationFromQuery,
  deferredEventQualificationFromQuery,
  deferredFilterValuesQualificationFromQuery,
  deferredOverviewPageTableQualificationFromQuery,
  deferredPageDimensionQualificationFromQuery,
  deferredPagesAggregatePageQualificationFromQuery,
  deferredPagesTabsQualificationFromQuery,
  deferredPerformanceSummaryQualificationFromQuery,
  deferredReferrerOverviewQualificationFromQuery,
  deferredReferrersQualificationFromQuery,
  deferredSessionBoundaryDimensionQualificationFromQuery,
  deferredSessionBoundaryOverviewPageQualificationFromQuery,
  prepareDeferredComparisonPageQualificationFallback,
  prepareDeferredEventQualificationFallback,
} from "@/lib/edge/analytics/providers/d1/internal/advanced-filter-execution";
import {
  queryChannelAggregate,
  queryQualifiedChannelListFromD1,
} from "@/lib/edge/analytics/providers/d1/internal/channels";
import {
  decodeComparisonDimensionCursor,
  queryComparisonDimensionPageFromD1,
  queryComparisonSessionPathPageFromD1,
  tryQueryQualifiedComparisonDimensionPageFromD1,
} from "@/lib/edge/analytics/providers/d1/internal/comparison-dimensions";
import { comparisonReportFamilyForTab } from "@/lib/edge/analytics/providers/d1/internal/comparison-report-family";
import {
  geoTabLabel,
  mapDimensionRows,
  mapGeoTabs,
  mapTabs,
} from "@/lib/edge/analytics/providers/d1/internal/core";
import {
  cityValueExpr,
  clientDimensionDefinition,
  referrerDomainDimensionDefinition,
  regionValueExpr,
  utmDimensionDefinition,
} from "@/lib/edge/analytics/providers/d1/internal/core-dimensions";
import {
  decodeDimensionCursor,
  decodeSessionPathDimensionCursor,
  preflightQualifiedDimensionPageCursorFromD1,
  queryDimensionPageFromD1,
  queryQualifiedDimensionPageFromD1,
  querySessionBoundaryDimensionFromD1,
  querySessionBoundaryOverviewPageFromD1,
  querySessionPathDimensionPageFromD1,
} from "@/lib/edge/analytics/providers/d1/internal/dimensions";
import {
  queryEventNameDimensionFromD1,
  queryEventTypeAggregate,
} from "@/lib/edge/analytics/providers/d1/internal/events-summary";
import { queryFilterValuesPageFromD1 } from "@/lib/edge/analytics/providers/d1/internal/filter-values";
import { queryFilterValuesPageWithQualification } from "@/lib/edge/analytics/providers/d1/internal/filter-values-qualification-program";
import { executeGeoPointsQualificationProgram } from "@/lib/edge/analytics/providers/d1/internal/geo-points-qualification-program";
import {
  deferredGeoPointsQualificationFromQuery,
  geoPointsLimitFromQuery,
} from "@/lib/edge/analytics/providers/d1/internal/geo-points-qualification-request";
import {
  parseRetentionGranularity,
  queryRetentionFromD1,
} from "@/lib/edge/analytics/providers/d1/internal/journey-retention";
import { queryGeoPointAggregate } from "@/lib/edge/analytics/providers/d1/internal/journeys";
import {
  queryPagesPageFromD1,
  queryPagesWithTabsFromD1,
  queryPageTabsAggregate,
  queryQualifiedPagesAggregatePageFromD1,
  queryQualifiedPagesTabsFromD1,
} from "@/lib/edge/analytics/providers/d1/internal/pages";
import { decodePagesCursor } from "@/lib/edge/analytics/providers/d1/internal/pages";
import { queryPagesDashboard } from "@/lib/edge/analytics/providers/d1/internal/pages-dashboard";
import { executePagesDashboardQualificationProgram } from "@/lib/edge/analytics/providers/d1/internal/pages-dashboard-qualification-program";
import { deferredPagesDashboardQualificationFromQuery } from "@/lib/edge/analytics/providers/d1/internal/pages-dashboard-qualification-request";
import {
  mapPerformanceSummaries,
  queryPerformanceDashboardFromD1,
} from "@/lib/edge/analytics/providers/d1/internal/performance";
import { executePerformanceBreakdownDashboardQualificationProgram } from "@/lib/edge/analytics/providers/d1/internal/performance-breakdown-dashboard-qualification-program";
import { executePerformanceSummaryQualificationProgram } from "@/lib/edge/analytics/providers/d1/internal/performance-summary-qualification-program";
import { executePerformanceTimeseriesQualificationProgram } from "@/lib/edge/analytics/providers/d1/internal/performance-timeseries-qualification-program";
import {
  decodeReferrersCursor,
  queryQualifiedReferrersFlatPageFromD1,
  queryQualifiedReferrersPageFromD1,
  queryQualifiedReferrerSummaryFromD1,
  queryReferrersPageFromD1,
  queryReferrerSummaryFromD1,
  type ReferrerAggregateCursor,
} from "@/lib/edge/analytics/providers/d1/internal/referrers";
import { executeRetentionQualificationProgram } from "@/lib/edge/analytics/providers/d1/internal/retention-qualification-program";
import { deferredRetentionQualificationFromQuery } from "@/lib/edge/analytics/providers/d1/internal/retention-qualification-request";
import {
  readSitePerformanceBreakdown,
  readSitePerformanceSummary,
  readSitePerformanceTimeseries,
  serializePerformanceBreakdown,
  serializePerformanceTimeseries,
} from "@/lib/edge/analytics/providers/d1/operations/site-performance";
import type { FilterDocument } from "@/lib/filter-contract/filters";
import { InvalidCursorError } from "@/lib/pagination";

import {
  type D1SiteRuntimeBindings,
  numberField,
  stringField,
  timeWindow,
} from "./shared";
function overviewTabExpression(tab: string): string | null {
  const comparisonTab = comparisonReportFamilyForTab(tab);
  if (comparisonTab) return comparisonTab.cursorExpression;
  if (tab === "page.path") return "TRIM(COALESCE(pathname, ''))";
  if (tab === "page.query") return "TRIM(COALESCE(query_string, ''))";
  if (tab === "page.title") return "TRIM(COALESCE(title, ''))";
  if (tab === "page.hostname") return "TRIM(COALESCE(hostname, ''))";
  if (tab === "source.domain")
    return referrerDomainDimensionDefinition().labelExpr;
  if (tab === "source.link") return "TRIM(COALESCE(referrer_url, ''))";
  if (tab === "source.channel") return buildTrafficChannelSqlExpression();
  if (tab.startsWith("client.")) {
    return clientDimensionDefinition(
      tab.slice("client.".length) as
        "browser" | "osVersion" | "deviceType" | "language" | "screenSize",
    ).labelExpr;
  }
  if (tab.startsWith("utm.")) {
    return utmDimensionDefinition(
      tab.slice("utm.".length) as
        "source" | "medium" | "campaign" | "term" | "content",
    ).labelExpr;
  }
  if (tab === "geo.country") return "TRIM(COALESCE(country, ''))";
  if (tab === "geo.region") return regionValueExpr();
  if (tab === "geo.city") return cityValueExpr();
  if (tab === "geo.continent") return "TRIM(COALESCE(continent, ''))";
  if (tab === "geo.timezone") return "TRIM(COALESCE(timezone, ''))";
  if (tab === "geo.organization") return "TRIM(COALESCE(as_organization, ''))";
  return null;
}

function overviewDimensionSelection(
  tab: string,
): PageDimensionSelection | null {
  if (tab === "source.channel") return PAGE_DIMENSION_SELECTIONS.trafficChannel;
  const overviewTable = overviewPageTableDescriptor(tab);
  if (overviewTable) return overviewTable.selection;
  const overviewSelections: Readonly<Record<string, PageDimensionSelection>> = {
    "page.path": PAGE_DIMENSION_SELECTIONS.pagePath,
    "page.query": PAGE_DIMENSION_SELECTIONS.pageQuery,
    "page.title": PAGE_DIMENSION_SELECTIONS.pageTitle,
    "page.hostname": PAGE_DIMENSION_SELECTIONS.pageHostname,
  };
  return Object.hasOwn(overviewSelections, tab)
    ? overviewSelections[tab]!
    : analyticsPageDimensionSelection(tab);
}

function overviewComparisonDimensionSelection(
  tab: string,
): PageDimensionSelection | null {
  const comparisonTab = comparisonPageTab(tab);
  if (comparisonTab) return comparisonTab.selection;
  const comparisonSelections: Readonly<Record<string, PageDimensionSelection>> =
    {
      "page.path": PAGE_DIMENSION_SELECTIONS.pagePathTrimmed,
      "page.query": PAGE_DIMENSION_SELECTIONS.pageQueryTrimmed,
      "page.title": PAGE_DIMENSION_SELECTIONS.pageTitleTrimmed,
      "page.hostname": PAGE_DIMENSION_SELECTIONS.pageHostnameTrimmed,
      "source.domain": PAGE_DIMENSION_SELECTIONS.referrerDomain,
      "source.link": PAGE_DIMENSION_SELECTIONS.referrerUrl,
      "source.channel": PAGE_DIMENSION_SELECTIONS.trafficChannel,
      "client.browser": PAGE_DIMENSION_SELECTIONS.browser,
      "client.osVersion": PAGE_DIMENSION_SELECTIONS.osVersion,
      "client.deviceType": PAGE_DIMENSION_SELECTIONS.deviceType,
      "client.language": PAGE_DIMENSION_SELECTIONS.language,
      "client.screenSize": PAGE_DIMENSION_SELECTIONS.screenSize,
      "utm.source": PAGE_DIMENSION_SELECTIONS.utmSource,
      "utm.medium": PAGE_DIMENSION_SELECTIONS.utmMedium,
      "utm.campaign": PAGE_DIMENSION_SELECTIONS.utmCampaign,
      "utm.term": PAGE_DIMENSION_SELECTIONS.utmTerm,
      "utm.content": PAGE_DIMENSION_SELECTIONS.utmContent,
      "geo.country": PAGE_DIMENSION_SELECTIONS.countryTrimmed,
      "geo.region": PAGE_DIMENSION_SELECTIONS.region,
      "geo.city": PAGE_DIMENSION_SELECTIONS.city,
      "geo.continent": PAGE_DIMENSION_SELECTIONS.continentTrimmed,
      "geo.timezone": PAGE_DIMENSION_SELECTIONS.timezoneTrimmed,
      "geo.organization": PAGE_DIMENSION_SELECTIONS.organizationTrimmed,
    };
  return Object.hasOwn(comparisonSelections, tab)
    ? comparisonSelections[tab]!
    : null;
}
function isPerformanceQuery(input: QueryInput): input is PerformanceQuery {
  if (!("time" in input) || !("mode" in input)) return false;
  if (input.mode === "summary") return true;
  if (input.mode === "dashboard" || input.mode === "timeseries") {
    return (
      "interval" in input &&
      ["minute", "hour", "day", "week", "month"].includes(
        String(input.interval),
      )
    );
  }
  return (
    input.mode === "breakdown" &&
    "dimension" in input &&
    typeof input.dimension === "string" &&
    "metric" in input &&
    ["ttfb", "fcp", "lcp", "cls", "inp"].includes(String(input.metric))
  );
}

async function overviewPageTablePage(
  options: D1SiteRuntimeBindings,
  request: DimensionOverviewTabQuery | ChannelOverviewTabQuery,
  window: ReturnType<typeof timeWindow>,
  filters: FilterDocument,
  tab: string,
  controls: {
    readonly limit: number;
    readonly cursorText: string | null;
    readonly sortBy: "views" | "sessions" | "visitors";
    readonly sortDirection: "asc" | "desc";
    readonly search?: string;
  },
  operation: "dimension" | "channels" = "dimension",
) {
  const normalized = normalizeOverviewPageTableRequest({
    operation,
    mode: request.mode,
    tab,
    limit: controls.limit,
    cursor: controls.cursorText,
    sort: controls.sortBy,
    direction: controls.sortDirection,
    search: controls.search,
  });
  if (!normalized) throw new Error(`unsupported-overview-page-table:${tab}`);
  const audience = request.context.policy.audience;
  const deferred =
    operation === "channels"
      ? deferredChannelOverviewQualificationFromQuery(request)
      : deferredOverviewPageTableQualificationFromQuery(request);
  const qualifiedInput = deferred
    ? {
        env: options.env,
        siteId: options.siteId,
        window,
        queryTime: request.time,
        filters,
        ...(request.scopePlan ? { scopePlan: request.scopePlan } : {}),
        family: "overview-tab" as const,
        tab: normalized.tab,
        limit: normalized.limit,
        selection: normalized.selection,
        options: {
          excludeEmpty: normalized.excludeEmpty,
          ...(normalized.search !== undefined
            ? { search: normalized.search }
            : {}),
          sortBy: normalized.sortBy,
          sortDirection: normalized.sortDirection,
        },
        cursor: null,
        cursorToken: normalized.cursorText,
        audience,
        deferred,
        ...(options.diagnostics ? { diagnostics: options.diagnostics } : {}),
      }
    : undefined;
  let cursor: Awaited<ReturnType<typeof decodeDimensionCursor>>;
  try {
    cursor = await decodeDimensionCursor(
      options.env,
      options.siteId,
      window,
      filters,
      normalized.selection,
      normalized.search,
      normalized.cursorText,
      audience,
      normalized.sortBy,
      normalized.sortDirection,
    );
  } catch (error) {
    if (
      normalized.cursorText &&
      qualifiedInput &&
      error instanceof InvalidCursorError
    ) {
      await preflightQualifiedDimensionPageCursorFromD1(qualifiedInput);
      throw new InvalidCursorError("overview-tab");
    }
    throw error;
  }
  if (normalized.cursorText && !cursor) {
    if (qualifiedInput)
      await preflightQualifiedDimensionPageCursorFromD1(qualifiedInput);
    throw new InvalidCursorError("overview-tab");
  }
  if (qualifiedInput) {
    const qualified = await queryQualifiedDimensionPageFromD1({
      ...qualifiedInput,
      cursor,
    });
    if (qualified.kind === "executed") return qualified.page;
    const fallbackFilters = await prepareDeferredEventQualificationFallback(
      deferred!,
    );
    return queryDimensionPageFromD1(
      options.env,
      options.siteId,
      window,
      fallbackFilters,
      normalized.limit,
      normalized.selection,
      {
        excludeEmpty: normalized.excludeEmpty,
        ...(normalized.search !== undefined
          ? { search: normalized.search }
          : {}),
        sortBy: normalized.sortBy,
        sortDirection: normalized.sortDirection,
      },
      cursor,
      options.diagnostics,
      audience,
    );
  }
  return queryDimensionPageFromD1(
    options.env,
    options.siteId,
    window,
    filters,
    normalized.limit,
    normalized.selection,
    {
      excludeEmpty: normalized.excludeEmpty,
      ...(normalized.search !== undefined ? { search: normalized.search } : {}),
      sortBy: normalized.sortBy,
      sortDirection: normalized.sortDirection,
    },
    cursor,
    options.diagnostics,
    audience,
  );
}

async function referrerOverviewPage(
  options: D1SiteRuntimeBindings,
  request: DimensionOverviewTabQuery | ChannelOverviewTabQuery,
  window: ReturnType<typeof timeWindow>,
  filters: FilterDocument,
  tab: string,
  controls: {
    readonly limit: number;
    readonly cursorText: string | null;
    readonly sortBy: "views" | "sessions" | "visitors";
    readonly sortDirection: "asc" | "desc";
    readonly search?: string;
  },
) {
  const normalized = normalizeReferrerOverviewTableRequest({
    mode: request.mode,
    tab,
    limit: controls.limit,
    cursor: controls.cursorText,
    sort: controls.sortBy,
    direction: controls.sortDirection,
    search: controls.search,
  });
  if (!normalized) throw new Error(`unsupported-referrer-overview-tab:${tab}`);
  const audience = request.context.policy.audience;
  const deferred = deferredReferrerOverviewQualificationFromQuery(request);
  const qualifiedInput = deferred
    ? {
        env: options.env,
        deferred,
        siteId: options.siteId,
        window,
        filters,
        limit: normalized.limit,
        includeFullUrl: normalized.includeFullUrl,
        ...(normalized.search !== undefined
          ? { search: normalized.search }
          : {}),
        cursorToken: normalized.cursorText,
        audience,
        sortBy: normalized.sortBy,
        sortDirection: normalized.sortDirection,
        ...(options.diagnostics ? { diagnostics: options.diagnostics } : {}),
      }
    : undefined;
  let cursor: Awaited<ReturnType<typeof decodeReferrersCursor>>;
  try {
    cursor = await decodeReferrersCursor(
      options.env,
      options.siteId,
      window,
      filters,
      normalized.includeFullUrl,
      normalized.search,
      normalized.cursorText,
      audience,
      normalized.sortBy,
      normalized.sortDirection,
    );
  } catch (error) {
    if (
      normalized.cursorText &&
      qualifiedInput &&
      error instanceof InvalidCursorError
    ) {
      const execution = await queryQualifiedReferrersPageFromD1({
        ...qualifiedInput,
        cursor: null,
      });
      if (execution.kind !== "executed") {
        const fallbackFilters = await prepareDeferredEventQualificationFallback(
          deferred!,
        );
        await queryReferrersPageFromD1(
          options.env,
          options.siteId,
          window,
          fallbackFilters,
          normalized.limit,
          normalized.includeFullUrl,
          normalized.search,
          null,
          options.diagnostics,
          audience,
          normalized.sortBy,
          normalized.sortDirection,
        );
      }
      throw new InvalidCursorError("overview-tab");
    }
    throw error;
  }
  if (normalized.cursorText && !cursor) {
    if (qualifiedInput) {
      const execution = await queryQualifiedReferrersPageFromD1({
        ...qualifiedInput,
        cursor: null,
      });
      if (execution.kind !== "executed") {
        const fallbackFilters = await prepareDeferredEventQualificationFallback(
          deferred!,
        );
        await queryReferrersPageFromD1(
          options.env,
          options.siteId,
          window,
          fallbackFilters,
          normalized.limit,
          normalized.includeFullUrl,
          normalized.search,
          null,
          options.diagnostics,
          audience,
          normalized.sortBy,
          normalized.sortDirection,
        );
      }
    }
    throw new InvalidCursorError("overview-tab");
  }
  let page: Awaited<ReturnType<typeof queryReferrersPageFromD1>>;
  if (qualifiedInput) {
    const execution = await queryQualifiedReferrersPageFromD1({
      ...qualifiedInput,
      cursor,
    });
    if (execution.kind === "executed") {
      page = execution.page;
    } else {
      const fallbackFilters = await prepareDeferredEventQualificationFallback(
        deferred!,
      );
      page = await queryReferrersPageFromD1(
        options.env,
        options.siteId,
        window,
        fallbackFilters,
        normalized.limit,
        normalized.includeFullUrl,
        normalized.search,
        cursor,
        options.diagnostics,
        audience,
        normalized.sortBy,
        normalized.sortDirection,
      );
    }
  } else {
    page = await queryReferrersPageFromD1(
      options.env,
      options.siteId,
      window,
      filters,
      normalized.limit,
      normalized.includeFullUrl,
      normalized.search,
      cursor,
      options.diagnostics,
      audience,
      normalized.sortBy,
      normalized.sortDirection,
    );
  }
  return page;
}

export async function overviewTabData(
  options: D1SiteRuntimeBindings,
  request: DimensionOverviewTabQuery | ChannelOverviewTabQuery,
  operation: "dimension" | "channels" = "dimension",
): Promise<OverviewTabResult> {
  const tab = stringField(request, "tab");
  const filters = request.filters ?? EMPTY_FILTER_DOCUMENT;
  const window = timeWindow(request.time);
  const limit = numberField(request, "limit", 100);
  const cursorText = stringField(request, "cursor") || null;
  const audience = request.context.policy.audience;
  const sortValue = stringField(request, "sort");
  const sortBy =
    sortValue === "visitors" || sortValue === "sessions" ? sortValue : "views";
  const sortDirection =
    stringField(request, "direction") === "asc" ? "asc" : "desc";
  const search = stringField(request, "search") || undefined;
  const kind = tab.split(".")[0];
  const comparison =
    request.comparison && typeof request.comparison === "object"
      ? (request.comparison as OverviewTableComparisonQuery)
      : null;
  const comparisonCurrent = request.current ?? null;
  const comparisonReference = request.reference ?? null;
  if (
    comparison &&
    comparisonCurrent?.time &&
    comparisonReference?.time &&
    (tab === "page.entry" || tab === "page.exit")
  ) {
    const pageKind = tab === "page.entry" ? "entry" : "exit";
    const currentWindow = timeWindow(comparisonCurrent.time);
    const referenceWindow = timeWindow(comparisonReference.time);
    const currentFilters = comparisonCurrent.filters ?? EMPTY_FILTER_DOCUMENT;
    const referenceFilters =
      comparisonReference.filters ?? EMPTY_FILTER_DOCUMENT;
    const deferredComparison =
      deferredComparisonPageQualificationFromQuery(request);
    let cursor: Awaited<ReturnType<typeof decodeComparisonDimensionCursor>> =
      null;
    let invalidComparisonCursor = false;
    try {
      cursor = await decodeComparisonDimensionCursor(
        options.env,
        options.siteId,
        currentWindow,
        currentFilters,
        referenceWindow,
        referenceFilters,
        `session.${pageKind}`,
        search,
        cursorText,
        audience,
        comparison.metric,
        comparison.sortBy,
        comparison.direction,
      );
      invalidComparisonCursor = cursorText !== null && cursor === null;
    } catch (error) {
      if (!deferredComparison || !(error instanceof InvalidCursorError))
        throw error;
      invalidComparisonCursor = true;
    }
    if (invalidComparisonCursor && !deferredComparison)
      throw new InvalidCursorError("overview-tab");
    if (deferredComparison) {
      const qualified = await tryQueryQualifiedComparisonDimensionPageFromD1({
        env: options.env,
        request,
        siteId: options.siteId,
        current: currentWindow,
        currentFilters,
        reference: referenceWindow,
        referenceFilters,
        selectExpr: `session.${pageKind}`,
        audience,
        cursor,
        cursorToken: cursorText,
        deferred: deferredComparison,
        ...(options.diagnostics ? { diagnostics: options.diagnostics } : {}),
      });
      if (qualified.kind === "executed") {
        if (invalidComparisonCursor)
          throw new InvalidCursorError("overview-tab");
        return {
          data: {
            items: qualified.page.items.map((row) => ({
              key: row.key,
              value: row.key,
              label: row.key,
              views: row.views,
              sessions: row.sessions,
              visitors: row.visitors,
              reference: row.reference,
              change: row.change,
            })),
            pagination: qualified.page.pagination,
          },
        };
      }
      const fallbackFilters =
        await prepareDeferredComparisonPageQualificationFallback(
          deferredComparison,
        );
      if (invalidComparisonCursor) throw new InvalidCursorError("overview-tab");
      const fallbackPage = await queryComparisonSessionPathPageFromD1(
        options.env,
        options.siteId,
        currentWindow,
        fallbackFilters.currentFilters,
        referenceWindow,
        fallbackFilters.referenceFilters,
        limit,
        pageKind,
        {
          metric: comparison.metric,
          sortBy: comparison.sortBy,
          direction: comparison.direction,
          search,
        },
        cursor,
        audience,
        options.diagnostics,
      );
      return {
        data: {
          items: fallbackPage.items.map((row) => ({
            key: row.key,
            value: row.key,
            label: row.key,
            views: row.views,
            sessions: row.sessions,
            visitors: row.visitors,
            reference: row.reference,
            change: row.change,
          })),
          pagination: fallbackPage.pagination,
        },
      };
    }
    if (cursorText && !cursor) throw new InvalidCursorError("overview-tab");
    const page = await queryComparisonSessionPathPageFromD1(
      options.env,
      options.siteId,
      currentWindow,
      currentFilters,
      referenceWindow,
      referenceFilters,
      limit,
      pageKind,
      {
        metric: comparison.metric,
        sortBy: comparison.sortBy,
        direction: comparison.direction,
        search,
      },
      cursor,
      audience,
    );
    return {
      data: {
        items: page.items.map((row) => ({
          key: row.key,
          value: row.key,
          label: row.key,
          views: row.views,
          sessions: row.sessions,
          visitors: row.visitors,
          reference: row.reference,
          change: row.change,
        })),
        pagination: page.pagination,
      },
    };
  }
  if (comparison && comparisonCurrent?.time && comparisonReference?.time) {
    const expression = overviewTabExpression(tab);
    const selection = overviewComparisonDimensionSelection(tab);
    if (expression && selection) {
      const currentWindow = timeWindow(comparisonCurrent.time);
      const referenceWindow = timeWindow(comparisonReference.time);
      const currentFilters = comparisonCurrent.filters ?? EMPTY_FILTER_DOCUMENT;
      const referenceFilters =
        comparisonReference.filters ?? EMPTY_FILTER_DOCUMENT;
      const deferredComparison =
        deferredComparisonPageQualificationFromQuery(request);
      let cursor = null as Awaited<
        ReturnType<typeof decodeComparisonDimensionCursor>
      >;
      let invalidComparisonCursor = false;
      try {
        cursor = await decodeComparisonDimensionCursor(
          options.env,
          options.siteId,
          currentWindow,
          currentFilters,
          referenceWindow,
          referenceFilters,
          expression,
          search,
          cursorText,
          audience,
          comparison.metric,
          comparison.sortBy,
          comparison.direction,
        );
        invalidComparisonCursor = cursorText !== null && cursor === null;
      } catch (error) {
        if (!deferredComparison || !(error instanceof InvalidCursorError))
          throw error;
        invalidComparisonCursor = true;
      }
      if (invalidComparisonCursor && !deferredComparison)
        throw new InvalidCursorError("overview-tab");
      if (deferredComparison) {
        const qualified = await tryQueryQualifiedComparisonDimensionPageFromD1({
          env: options.env,
          request,
          siteId: options.siteId,
          current: currentWindow,
          currentFilters,
          reference: referenceWindow,
          referenceFilters,
          selectExpr: expression,
          audience,
          cursor,
          cursorToken: cursorText,
          deferred: deferredComparison,
          ...(options.diagnostics ? { diagnostics: options.diagnostics } : {}),
        });
        if (qualified.kind === "executed") {
          if (invalidComparisonCursor)
            throw new InvalidCursorError("overview-tab");
          return {
            data: {
              items: qualified.page.items.map((row) => ({
                key: row.key,
                value: row.key,
                label: row.key,
                views: row.views,
                sessions: row.sessions,
                visitors: row.visitors,
                reference: row.reference,
                change: row.change,
              })),
              pagination: qualified.page.pagination,
            },
          };
        }
        const fallbackFilters =
          await prepareDeferredComparisonPageQualificationFallback(
            deferredComparison,
          );
        if (invalidComparisonCursor)
          throw new InvalidCursorError("overview-tab");
        const fallbackPage = await queryComparisonDimensionPageFromD1(
          options.env,
          options.siteId,
          currentWindow,
          fallbackFilters.currentFilters,
          referenceWindow,
          fallbackFilters.referenceFilters,
          limit,
          expression,
          {
            metric: comparison.metric,
            sortBy: comparison.sortBy,
            direction: comparison.direction,
            search,
            selection,
          },
          cursor,
          audience,
          options.diagnostics,
        );
        return {
          data: {
            items: fallbackPage.items.map((row) => ({
              key: row.key,
              value: row.key,
              label: row.key,
              views: row.views,
              sessions: row.sessions,
              visitors: row.visitors,
              reference: row.reference,
              change: row.change,
            })),
            pagination: fallbackPage.pagination,
          },
        };
      }
      if (cursorText && !cursor) throw new InvalidCursorError("overview-tab");
      const page = await queryComparisonDimensionPageFromD1(
        options.env,
        options.siteId,
        currentWindow,
        currentFilters,
        referenceWindow,
        referenceFilters,
        limit,
        expression,
        {
          metric: comparison.metric,
          sortBy: comparison.sortBy,
          direction: comparison.direction,
          search,
          selection,
        },
        cursor,
        audience,
      );
      return {
        data: {
          items: page.items.map((row) => ({
            key: row.key,
            value: row.key,
            label: row.key,
            views: row.views,
            sessions: row.sessions,
            visitors: row.visitors,
            reference: row.reference,
            change: row.change,
          })),
          pagination: page.pagination,
        },
      };
    }
  }
  if (tab === "source.channel") {
    if (operation === "channels") {
      const page = await overviewPageTablePage(
        options,
        request,
        window,
        filters,
        tab,
        {
          limit,
          cursorText,
          sortBy,
          sortDirection,
          ...(search !== undefined ? { search } : {}),
        },
        "channels",
      );
      return {
        data: {
          items: mapTabs([...page.items]),
          pagination: page.pagination,
        },
      };
    }
    const selection = PAGE_DIMENSION_SELECTIONS.trafficChannel;
    const cursor = await decodeDimensionCursor(
      options.env,
      options.siteId,
      window,
      filters,
      selection,
      search,
      cursorText,
      audience,
      sortBy,
      sortDirection,
    );
    if (cursorText && !cursor) throw new InvalidCursorError("overview-tab");
    const page = await queryDimensionPageFromD1(
      options.env,
      options.siteId,
      window,
      filters,
      limit,
      selection,
      {
        excludeEmpty: true,
        search,
        sortBy,
        sortDirection,
      },
      cursor,
      undefined,
      audience,
    );
    return {
      data: {
        items: mapTabs([...page.items]),
        pagination: page.pagination,
      },
    };
  }
  if (kind === "source") {
    const referrerRequest = normalizeReferrerOverviewTableRequest({
      mode: request.mode,
      tab,
      limit,
      cursor: cursorText,
      sort: sortBy,
      direction: sortDirection,
      search,
    });
    if (
      referrerRequest &&
      request.comparison === undefined &&
      request.current === undefined &&
      request.reference === undefined
    ) {
      const page = await referrerOverviewPage(
        options,
        request,
        window,
        filters,
        tab,
        { limit, cursorText, sortBy, sortDirection, search },
      );
      return {
        data: {
          items: page.items.map((row) => ({
            label: row.referrer,
            views: row.views,
            sessions: row.sessions,
            visitors: row.visitors,
          })),
          pagination: page.pagination,
        },
      };
    }
    const includeFullUrl = tab === "source.link";
    const referrerSortBy = sortBy === "visitors" ? "visitors" : "views";
    const cursor = await decodeReferrersCursor(
      options.env,
      options.siteId,
      window,
      filters,
      includeFullUrl,
      search,
      cursorText,
      audience,
      referrerSortBy,
      sortDirection,
    );
    if (cursorText && !cursor) throw new InvalidCursorError("overview-tab");
    const page = await queryReferrersPageFromD1(
      options.env,
      options.siteId,
      window,
      filters,
      limit,
      includeFullUrl,
      search,
      cursor,
      undefined,
      audience,
      referrerSortBy,
      sortDirection,
    );
    return {
      data: {
        items: page.items.map((row) => ({
          label: row.referrer,
          views: row.views,
          sessions: row.sessions,
          visitors: row.visitors,
        })),
        pagination: page.pagination,
      },
    };
  }
  if (kind === "page") {
    const pageTab = tab.slice("page.".length) as
      "path" | "query" | "title" | "hostname" | "entry" | "exit";
    if (pageTab === "entry" || pageTab === "exit") {
      const pageKind = pageTab === "entry" ? "entry" : "exit";
      const sessionTab =
        pageKind === "entry" ? ("page.entry" as const) : ("page.exit" as const);
      const deferredOverviewPage =
        deferredSessionBoundaryOverviewPageQualificationFromQuery(request);
      let cursor: Awaited<ReturnType<typeof decodeSessionPathDimensionCursor>>;
      try {
        cursor = await decodeSessionPathDimensionCursor(
          options.env,
          options.siteId,
          window,
          filters,
          pageKind,
          search,
          cursorText,
          audience,
          sortBy,
          sortDirection,
        );
      } catch (error) {
        if (!(error instanceof InvalidCursorError)) throw error;
        if (!deferredOverviewPage) throw new InvalidCursorError("overview-tab");
        cursor = null;
      }
      if (deferredOverviewPage) {
        const page = await querySessionBoundaryOverviewPageFromD1(
          options.env,
          options.siteId,
          window,
          filters,
          limit,
          pageKind,
          options.diagnostics,
          search,
          cursor,
          cursorText,
          audience,
          sortBy,
          sortDirection,
          {
            deferredQualification: deferredOverviewPage,
            request: {
              mode: "overview-tab",
              tab: sessionTab,
              kind: pageKind,
              dimension:
                pageKind === "entry" ? "session.entryPath" : "session.exitPath",
              limit,
              cursorToken: cursorText,
              ...(search !== undefined ? { search } : {}),
              sortBy,
              sortDirection,
              audience,
            },
            queryTime: request.time,
            ...(request.scopePlan ? { scopePlan: request.scopePlan } : {}),
            mode: request.mode,
            tab: sessionTab,
          },
        );
        return {
          data: {
            items: mapTabs([...page.items]),
            pagination: page.pagination,
          },
        };
      }
      if (cursorText && !cursor) throw new InvalidCursorError("overview-tab");
      const page = await querySessionPathDimensionPageFromD1(
        options.env,
        options.siteId,
        window,
        filters,
        limit,
        pageKind,
        undefined,
        search,
        cursor,
        audience,
        sortBy,
        sortDirection,
      );
      return {
        data: {
          items: mapTabs([...page.items]),
          pagination: page.pagination,
        },
      };
    }
    const pageTable = overviewPageTableDescriptor(tab);
    if (pageTable?.family === "page") {
      const page = await overviewPageTablePage(
        options,
        request,
        window,
        filters,
        tab,
        {
          limit,
          cursorText,
          sortBy,
          sortDirection,
          ...(search !== undefined ? { search } : {}),
        },
      );
      const items =
        pageTab === "query"
          ? page.items.map((row) => ({
              value: row.value,
              label: row.value,
              views: row.views,
              sessions: row.sessions,
              visitors: row.visitors,
            }))
          : mapTabs([...page.items]);
      return { data: { items, pagination: page.pagination } };
    }
    const selection = overviewDimensionSelection(`page.${pageTab}`);
    if (!selection) throw new Error(`unsupported-dimension:page.${pageTab}`);
    const cursor = await decodeDimensionCursor(
      options.env,
      options.siteId,
      window,
      filters,
      selection,
      search,
      cursorText,
      audience,
      sortBy,
      sortDirection,
    );
    if (cursorText && !cursor) throw new InvalidCursorError("overview-tab");
    const page = await queryDimensionPageFromD1(
      options.env,
      options.siteId,
      window,
      filters,
      limit,
      selection,
      { excludeEmpty: true, search, sortBy, sortDirection },
      cursor,
      undefined,
      audience,
    );
    const items =
      pageTab === "query"
        ? page.items.map((row) => ({
            value: row.value,
            label: row.value,
            views: row.views,
            sessions: row.sessions,
            visitors: row.visitors,
          }))
        : mapTabs([...page.items]);
    return { data: { items, pagination: page.pagination } };
  }
  if (kind === "client") {
    const descriptor = overviewPageTableDescriptor(tab);
    if (!descriptor || descriptor.family !== "client")
      throw new Error(`unsupported-dimension:${tab}`);
    const page = await overviewPageTablePage(
      options,
      request,
      window,
      filters,
      tab,
      {
        limit,
        cursorText,
        sortBy,
        sortDirection,
        ...(search ? { search } : {}),
      },
    );
    return {
      data: {
        items: mapTabs([...page.items]),
        pagination: page.pagination,
      },
    };
  }
  if (kind === "utm") {
    const descriptor = overviewPageTableDescriptor(tab);
    if (!descriptor || descriptor.family !== "utm") {
      return {
        data: {
          items: [],
          pagination: {
            limit,
            returned: 0,
            hasMore: false,
            nextCursor: null,
          },
        },
      };
    }
    const page = await overviewPageTablePage(
      options,
      request,
      window,
      filters,
      tab,
      {
        limit,
        cursorText,
        sortBy,
        sortDirection,
        ...(search ? { search } : {}),
      },
    );
    return {
      data: {
        items: mapTabs([...page.items]),
        pagination: page.pagination,
      },
    };
  }
  const geoTab = tab.slice("geo.".length) as
    "country" | "region" | "city" | "continent" | "timezone" | "organization";
  const descriptor = overviewPageTableDescriptor(tab);
  if (!descriptor || descriptor.family !== "geo")
    throw new Error(`unsupported-dimension:${tab}`);
  const page = await overviewPageTablePage(
    options,
    request,
    window,
    filters,
    tab,
    { limit, cursorText, sortBy, sortDirection, ...(search ? { search } : {}) },
  );
  return {
    data: {
      items: mapGeoTabs(
        page.items.map((row) => ({
          ...row,
          label: geoTabLabel(row.value, geoTab),
        })),
      ),
      pagination: page.pagination,
    },
  };
}
export function dimensionSelection(
  dimension: string,
): PageDimensionSelection | null {
  return dimensionPageSelection(dimension);
}
export function registerSiteContractProviders(
  registry: AnalyticsProviderRegistry,
  options: D1SiteRuntimeBindings,
): void {
  registry
    .register(
      "dimension",
      typedQueryProviderFor("dimension", async (input) => {
        const request = input;
        if (request.mode === "overview-tab") {
          return { value: await overviewTabData(options, request) };
        }
        const pageRequest =
          request.page && typeof request.page === "object"
            ? (request.page as { limit?: unknown; cursor?: unknown })
            : {};
        {
          const window = timeWindow(request.time);
          const filters = request.filters ?? EMPTY_FILTER_DOCUMENT;
          const limit =
            typeof pageRequest.limit === "number" &&
            Number.isFinite(pageRequest.limit)
              ? pageRequest.limit
              : numberField(request, "limit", 20);
          const sortRecord =
            request.sort && typeof request.sort === "object"
              ? (request.sort as { key?: unknown; direction?: unknown })
              : null;
          const sortBy =
            sortRecord?.key === "sessions" || sortRecord?.key === "visitors"
              ? sortRecord.key
              : "views";
          const sortDirection =
            sortRecord?.direction === "asc" ? "asc" : "desc";
          const search =
            typeof request.search === "string" ? request.search : undefined;
          const dimension = stringField(request, "dimension");
          if (dimension === "event.name") {
            const eventNameRequest = normalizeEventNameDimensionListRequest({
              mode: request.mode,
              dimension,
              page: request.page,
              limit: request.limit,
              search: request.search,
              audience: request.context.policy.audience,
            });
            const deferred = eventNameRequest
              ? deferredEventNameDimensionQualificationFromQuery(request)
              : undefined;
            const rows = eventNameRequest
              ? await queryEventNameDimensionFromD1(
                  options.env,
                  options.siteId,
                  window,
                  request.time,
                  filters,
                  eventNameRequest,
                  {
                    ...(deferred ? { deferredQualification: deferred } : {}),
                    ...(request.scopePlan
                      ? { scopePlan: request.scopePlan }
                      : {}),
                    ...(options.diagnostics
                      ? { diagnostics: options.diagnostics }
                      : {}),
                  },
                )
              : await queryEventTypeAggregate(
                  options.env,
                  options.siteId,
                  window,
                  filters,
                  limit,
                  search,
                );
            return { value: { items: mapDimensionRows(rows) } };
          }
          if (
            dimension === "session.entryPath" ||
            dimension === "session.exitPath"
          ) {
            const sessionBoundaryRequest =
              normalizeSessionBoundaryDimensionRequest({
                mode: request.mode,
                dimension,
                page: request.page,
                limit: request.limit,
                sort: request.sort,
                search: request.search,
                audience: request.context.policy.audience,
              });
            const deferred = sessionBoundaryRequest
              ? deferredSessionBoundaryDimensionQualificationFromQuery(request)
              : undefined;
            const rows = await querySessionBoundaryDimensionFromD1(
              options.env,
              options.siteId,
              window,
              filters,
              limit,
              dimension === "session.entryPath" ? "entry" : "exit",
              options.diagnostics,
              search,
              sortBy,
              sortDirection,
              sessionBoundaryRequest
                ? {
                    request: sessionBoundaryRequest,
                    queryTime: request.time,
                    ...(request.scopePlan
                      ? { scopePlan: request.scopePlan }
                      : {}),
                    audience: request.context.policy.audience,
                    ...(deferred ? { deferredQualification: deferred } : {}),
                  }
                : undefined,
            );
            return { value: { items: mapDimensionRows(rows) } };
          }
          const normalized = normalizeDimensionPageRequest({
            dimension,
            page: request.page,
            limit: request.limit,
            sort: request.sort,
            search: request.search,
          });
          if (!normalized)
            throw new Error(`unsupported-dimension:${dimension}`);
          const selection = normalized.selection;
          const audience = request.context.policy.audience;
          const deferred = deferredPageDimensionQualificationFromQuery(request);
          const normalizedCursorText = normalized.cursorText;
          const qualifiedInput = deferred
            ? {
                env: options.env,
                siteId: options.siteId,
                window,
                queryTime: request.time,
                filters,
                ...(request.scopePlan ? { scopePlan: request.scopePlan } : {}),
                family: "breakdown" as const,
                dimension: normalized.dimension,
                limit: normalized.limit,
                selection,
                options: {
                  excludeEmpty: false as const,
                  ...(normalized.search !== undefined
                    ? { search: normalized.search }
                    : {}),
                  sortBy: normalized.sortBy,
                  sortDirection: normalized.sortDirection,
                },
                cursor: null,
                cursorToken: normalizedCursorText,
                audience,
                deferred,
                ...(options.diagnostics
                  ? { diagnostics: options.diagnostics }
                  : {}),
              }
            : undefined;
          let cursor: Awaited<ReturnType<typeof decodeDimensionCursor>>;
          try {
            cursor = await decodeDimensionCursor(
              options.env,
              options.siteId,
              window,
              filters,
              selection,
              normalized.search,
              normalizedCursorText,
              audience,
              normalized.sortBy,
              normalized.sortDirection,
            );
          } catch (error) {
            if (
              normalizedCursorText &&
              qualifiedInput &&
              error instanceof InvalidCursorError
            )
              await preflightQualifiedDimensionPageCursorFromD1(qualifiedInput);
            throw error;
          }
          if (normalizedCursorText && !cursor) {
            if (qualifiedInput)
              await preflightQualifiedDimensionPageCursorFromD1(qualifiedInput);
            throw new InvalidCursorError("dimension");
          }
          let page: Awaited<ReturnType<typeof queryDimensionPageFromD1>>;
          if (qualifiedInput) {
            const qualified = await queryQualifiedDimensionPageFromD1({
              ...qualifiedInput,
              cursor,
            });
            if (qualified.kind === "executed") {
              page = qualified.page;
            } else {
              const fallbackFilters =
                await prepareDeferredEventQualificationFallback(deferred!);
              page = await queryDimensionPageFromD1(
                options.env,
                options.siteId,
                window,
                fallbackFilters,
                normalized.limit,
                selection,
                qualifiedInput.options,
                cursor,
                options.diagnostics,
                audience,
              );
            }
          } else {
            page = await queryDimensionPageFromD1(
              options.env,
              options.siteId,
              window,
              filters,
              normalized.limit,
              selection,
              {
                excludeEmpty: false,
                ...(normalized.search !== undefined
                  ? { search: normalized.search }
                  : {}),
                sortBy: normalized.sortBy,
                sortDirection: normalized.sortDirection,
              },
              cursor,
              options.diagnostics,
              audience,
            );
          }
          return {
            value: {
              items: mapDimensionRows([...page.items]),
              pagination: page.pagination,
            },
          };
        }
      }),
    )
    .register(
      "geo-points",
      typedQueryProviderFor("geo-points", async (input) => {
        const request = input;
        const deferred = deferredGeoPointsQualificationFromQuery(input);
        let filters = request.filters ?? EMPTY_FILTER_DOCUMENT;
        let limit = geoPointsLimitFromQuery(request);
        if (deferred) {
          const execution = await executeGeoPointsQualificationProgram({
            env: options.env,
            query: request,
            request: deferred,
            diagnostics: options.diagnostics,
          });
          if (execution.kind === "executed") return { value: execution.value };
          if (options.diagnostics)
            options.diagnostics.advancedCountSqlFallbackReason =
              execution.fallbackReason;
          filters = await prepareDeferredEventQualificationFallback(
            deferred.qualification,
          );
          limit = deferred.configuration.limit;
        }
        const aggregate = await queryGeoPointAggregate(
          options.env,
          options.siteId,
          timeWindow(request.time),
          filters,
          limit,
        );
        return {
          value: {
            points: aggregate.points,
            countryCounts: aggregate.countryCounts,
            regionCounts: aggregate.regionCounts,
            cityCounts: aggregate.cityCounts,
          },
        };
      }),
    )
    .register(
      "channels",
      typedQueryProviderFor("channels", async (input) => {
        const request = input;
        if (request.mode === "overview-tab") {
          return { value: await overviewTabData(options, request, "channels") };
        }
        const filters = request.filters ?? EMPTY_FILTER_DOCUMENT;
        const window = timeWindow(request.time);
        const limit = numberField(request, "limit", 100);
        const deferredChannelList =
          request.mode === "list"
            ? deferredChannelListQualificationFromQuery(request)
            : undefined;
        const requestFlags = request as unknown as Record<string, unknown>;
        const rows =
          deferredChannelList && request.mode === "list"
            ? (
                await queryQualifiedChannelListFromD1({
                  env: options.env,
                  siteId: options.siteId,
                  window,
                  queryTime: request.time,
                  filters,
                  ...(request.scopePlan
                    ? { scopePlan: request.scopePlan }
                    : {}),
                  mode: request.mode,
                  limit,
                  sourceLimit:
                    typeof request.limit === "number"
                      ? request.limit
                      : undefined,
                  audience: request.context.policy.audience,
                  hasComparison: requestFlags.comparison !== undefined,
                  hasCurrent: requestFlags.current !== undefined,
                  hasReference: requestFlags.reference !== undefined,
                  deferred: deferredChannelList,
                  ...(options.diagnostics
                    ? { diagnostics: options.diagnostics }
                    : {}),
                })
              ).rows
            : await queryChannelAggregate(
                options.env,
                options.siteId,
                window,
                filters,
                limit,
              );
        return {
          value: {
            items: rows.map((row) => ({
              channel: row.channel,
              views: row.views,
              sessions: row.sessions,
              visitors: row.visitors,
            })),
          },
        };
      }),
    )
    .register(
      "filter-values",
      typedQueryProviderFor("filter-values", async (input) => {
        const request = input;
        const qualified = deferredFilterValuesQualificationFromQuery(request);
        let field: string;
        let rows: Awaited<ReturnType<typeof queryFilterValuesPageFromD1>>;
        if (qualified) {
          field = qualified.configuration.field;
          rows = await queryFilterValuesPageWithQualification({
            env: options.env,
            query: request,
            request: qualified,
            ...(options.diagnostics
              ? { diagnostics: options.diagnostics }
              : {}),
          });
        } else {
          field = stringField(request, "field");
          const pageValue = request.page;
          const page =
            pageValue && typeof pageValue === "object"
              ? (pageValue as { limit?: unknown; cursor?: unknown })
              : {};
          const limit = page
            ? typeof page.limit === "number" && Number.isFinite(page.limit)
              ? page.limit
              : 50
            : numberField(request, "limit", 50);
          const cursor =
            page && typeof page.cursor === "string" ? page.cursor : null;
          rows = await queryFilterValuesPageFromD1(
            options.env,
            options.siteId,
            timeWindow(request.time),
            request.filters ?? EMPTY_FILTER_DOCUMENT,
            field,
            limit,
            cursor,
            typeof request.search === "string" ? request.search : undefined,
            request.context.policy.audience,
          );
        }
        return {
          value: {
            field,
            data: {
              items: rows.items.map((row) => ({
                value: row.value,
                label: row.value,
                occurrences: row.occurrences,
              })),
              pagination: rows.pagination,
            },
          },
        };
      }),
    )
    .register(
      "retention",
      typedQueryProviderFor("retention", async (input) => {
        const request = input as QueryInput &
          Record<string, unknown> & {
            readonly time: QueryTime;
            readonly granularity?: unknown;
          };
        const deferred = deferredRetentionQualificationFromQuery(request);
        const genericDeferred = deferredEventQualificationFromQuery(
          request,
          "retention",
        );
        if (
          genericDeferred &&
          (!deferred || genericDeferred !== deferred.qualification)
        )
          throw new Error("retention_qualification_request_changed");
        const window = timeWindow(request.time);
        const granularity = parseRetentionGranularity(
          stringField(request, "granularity", "week"),
        );
        let filters = request.filters ?? EMPTY_FILTER_DOCUMENT;
        if (deferred) {
          const qualified = await executeRetentionQualificationProgram({
            env: options.env,
            query: request,
            deferred,
            ...(options.diagnostics
              ? { diagnostics: options.diagnostics }
              : {}),
          });
          if (qualified.kind === "executed") return { value: qualified.result };
          if (options.diagnostics)
            options.diagnostics.advancedCountSqlFallbackReason =
              qualified.fallbackReason;
          filters = await prepareDeferredEventQualificationFallback(
            deferred.qualification,
          );
        }
        return {
          value: await queryRetentionFromD1(
            options.env,
            options.siteId,
            window,
            filters,
            granularity,
          ),
        };
      }),
    )
    .register(
      "performance",
      typedQueryProviderFor("performance", async (input) => {
        if (!input || !isPerformanceQuery(input)) {
          throw new Error("unsupported-performance-query-mode");
        }
        const request = input;
        const deferred = deferredPerformanceSummaryQualificationFromQuery(
          request as unknown as QueryInput & Record<string, unknown>,
        );
        const window = timeWindow(request.time);
        const filters = request.filters ?? EMPTY_FILTER_DOCUMENT;
        switch (request.mode) {
          case "summary": {
            if (deferred) {
              const qualified =
                await executePerformanceSummaryQualificationProgram({
                  env: options.env,
                  query: request as unknown as QueryInput &
                    Record<string, unknown>,
                  deferred,
                  ...(options.diagnostics
                    ? { diagnostics: options.diagnostics }
                    : {}),
                });
              if (qualified.kind === "executed")
                return {
                  value: {
                    metrics: mapPerformanceSummaries([
                      qualified.row as Record<string, unknown>,
                    ]),
                  },
                };
              const fallbackFilters =
                await prepareDeferredEventQualificationFallback(
                  deferred.qualification,
                );
              return {
                value: await readSitePerformanceSummary({
                  env: options.env,
                  siteId: options.siteId,
                  window,
                  filters: fallbackFilters,
                }),
              };
            }
            return {
              value: await readSitePerformanceSummary({
                env: options.env,
                siteId: options.siteId,
                window,
                filters,
              }),
            };
          }
          case "timeseries": {
            if (deferred?.configuration.mode === "timeseries") {
              const qualified =
                await executePerformanceTimeseriesQualificationProgram({
                  env: options.env,
                  query: request as unknown as QueryInput &
                    Record<string, unknown>,
                  deferred,
                  ...(options.diagnostics
                    ? { diagnostics: options.diagnostics }
                    : {}),
                });
              if (qualified.kind === "executed")
                return {
                  value: serializePerformanceTimeseries(
                    request.interval,
                    qualified.trends,
                  ),
                };
              const fallbackFilters =
                await prepareDeferredEventQualificationFallback(
                  deferred.qualification,
                );
              return {
                value: await readSitePerformanceTimeseries({
                  env: options.env,
                  siteId: options.siteId,
                  window,
                  filters: fallbackFilters,
                  interval: request.interval,
                }),
              };
            }
            return {
              value: await readSitePerformanceTimeseries({
                env: options.env,
                siteId: options.siteId,
                window,
                filters,
                interval: request.interval,
              }),
            };
          }
          case "breakdown": {
            if (deferred?.configuration.mode === "breakdown") {
              const qualified =
                await executePerformanceBreakdownDashboardQualificationProgram({
                  env: options.env,
                  query: request as unknown as QueryInput &
                    Record<string, unknown>,
                  deferred,
                  ...(options.diagnostics
                    ? { diagnostics: options.diagnostics }
                    : {}),
                });
              if (
                qualified.kind === "executed" &&
                qualified.value.mode === "breakdown"
              )
                return {
                  value: serializePerformanceBreakdown(
                    qualified.value.dimension,
                    qualified.value.metric,
                    qualified.value.rows,
                  ),
                };
              const fallbackFilters =
                await prepareDeferredEventQualificationFallback(
                  deferred.qualification,
                );
              return {
                value: await readSitePerformanceBreakdown({
                  env: options.env,
                  siteId: options.siteId,
                  window,
                  filters: fallbackFilters,
                  dimension: request.dimension,
                  metric: request.metric,
                  limit: request.limit ?? 20,
                }),
              };
            }
            return {
              value: await readSitePerformanceBreakdown({
                env: options.env,
                siteId: options.siteId,
                window,
                filters,
                dimension: request.dimension,
                metric: request.metric,
                limit: request.limit ?? 20,
              }),
            };
          }
          case "dashboard": {
            if (deferred?.configuration.mode === "dashboard") {
              const qualified =
                await executePerformanceBreakdownDashboardQualificationProgram({
                  env: options.env,
                  query: request as unknown as QueryInput &
                    Record<string, unknown>,
                  deferred,
                  ...(options.diagnostics
                    ? { diagnostics: options.diagnostics }
                    : {}),
                });
              if (
                qualified.kind === "executed" &&
                qualified.value.mode === "dashboard"
              )
                return { value: qualified.value.value };
              const fallbackFilters =
                await prepareDeferredEventQualificationFallback(
                  deferred.qualification,
                );
              return {
                value: await queryPerformanceDashboardFromD1(
                  options.env,
                  options.siteId,
                  window,
                  request.interval,
                  fallbackFilters,
                  request.limit ?? 18,
                ),
              };
            }
            return {
              value: await queryPerformanceDashboardFromD1(
                options.env,
                options.siteId,
                window,
                request.interval,
                filters,
                request.limit ?? 18,
              ),
            };
          }
        }
      }),
    )
    .register(
      "pages",
      typedQueryProviderFor("pages", async (input) => {
        const request = input;
        const filters = request.filters ?? EMPTY_FILTER_DOCUMENT;
        if (request.variant === "tabs") {
          deferredPagesAggregatePageQualificationFromQuery(request);
          const deferred = deferredPagesTabsQualificationFromQuery(request);
          if (deferred?.pagesTabsRequest.configuration === "tabs-only") {
            const limit = numberField(request, "limit", 20);
            const qualified = await queryQualifiedPagesTabsFromD1({
              env: options.env,
              siteId: options.siteId,
              window: timeWindow(request.time),
              filters,
              limit,
              includeDetails: false,
              cursorText: null,
              audience: request.context.policy.audience,
              deferred,
              ...(request.scopePlan ? { scopePlan: request.scopePlan } : {}),
              ...(options.diagnostics
                ? { diagnostics: options.diagnostics }
                : {}),
              variant: request.variant,
              includeTabs: request.includeTabs,
            });
            if (
              qualified.kind === "executed" &&
              qualified.configuration === "tabs-only"
            )
              return { value: qualified.tabs };
            if (qualified.kind === "executed")
              throw new Error(
                "pages_tabs_qualification_configuration_mismatch",
              );
            const fallbackFilters =
              await prepareDeferredEventQualificationFallback(deferred);
            return {
              value: await queryPageTabsAggregate(
                options.env,
                options.siteId,
                timeWindow(request.time),
                fallbackFilters,
                limit,
              ),
            };
          }
          return {
            value: await queryPageTabsAggregate(
              options.env,
              options.siteId,
              timeWindow(request.time),
              filters,
              numberField(request, "limit", 20),
            ),
          };
        }
        if (request.includeTabs === true) {
          deferredPagesAggregatePageQualificationFromQuery(request);
          const rawPage = request.page;
          const page =
            rawPage && typeof rawPage === "object"
              ? (rawPage as { limit?: unknown; cursor?: unknown })
              : {};
          const limit =
            page &&
            typeof page.limit === "number" &&
            Number.isFinite(page.limit)
              ? page.limit
              : numberField(request, "limit", 20);
          const cursorText =
            page && typeof page.cursor === "string" ? page.cursor : null;
          const deferred = deferredPagesTabsQualificationFromQuery(request);
          if (deferred?.pagesTabsRequest.configuration === "pages-with-tabs") {
            const qualified = await queryQualifiedPagesTabsFromD1({
              env: options.env,
              siteId: options.siteId,
              window: timeWindow(request.time),
              filters,
              limit,
              includeDetails: request.includeDetails === true,
              cursorText,
              audience: request.context.policy.audience,
              deferred,
              ...(request.scopePlan ? { scopePlan: request.scopePlan } : {}),
              ...(options.diagnostics
                ? { diagnostics: options.diagnostics }
                : {}),
              variant: request.variant,
              includeTabs: request.includeTabs,
            });
            if (
              qualified.kind === "executed" &&
              qualified.configuration === "pages-with-tabs"
            )
              return { value: qualified.result, source: "raw" };
            if (qualified.kind === "executed")
              throw new Error(
                "pages_tabs_qualification_configuration_mismatch",
              );
            const fallbackFilters =
              await prepareDeferredEventQualificationFallback(deferred);
            const fallbackCursor = await decodePagesCursor(
              options.env,
              options.siteId,
              timeWindow(request.time),
              fallbackFilters,
              request.includeDetails === true,
              cursorText,
              request.context.policy.audience,
            );
            if (cursorText && !fallbackCursor)
              throw new InvalidCursorError("pages");
            return {
              value: await queryPagesWithTabsFromD1(
                options.env,
                options.siteId,
                timeWindow(request.time),
                fallbackFilters,
                limit,
                request.includeDetails === true,
                fallbackCursor,
                request.context.policy.audience,
              ),
              source: "raw",
            };
          }
          const cursor = await decodePagesCursor(
            options.env,
            options.siteId,
            timeWindow(request.time),
            filters,
            request.includeDetails === true,
            cursorText,
            request.context.policy.audience,
          );
          if (cursorText && !cursor) throw new InvalidCursorError("pages");
          return {
            value: await queryPagesWithTabsFromD1(
              options.env,
              options.siteId,
              timeWindow(request.time),
              filters,
              limit,
              request.includeDetails === true,
              cursor,
              request.context.policy.audience,
            ),
            source: "raw",
          };
        }
        const rawPage = request.page;
        const page =
          rawPage && typeof rawPage === "object"
            ? (rawPage as { limit?: unknown; cursor?: unknown })
            : {};
        {
          const limit =
            typeof page.limit === "number" && Number.isFinite(page.limit)
              ? page.limit
              : numberField(request, "limit", 20);
          const cursorText =
            typeof page.cursor === "string" ? page.cursor : null;
          const includeDetails = request.includeDetails === true;
          deferredPagesTabsQualificationFromQuery(request);
          const deferred =
            deferredPagesAggregatePageQualificationFromQuery(request);
          if (deferred) {
            const qualified = await queryQualifiedPagesAggregatePageFromD1({
              env: options.env,
              siteId: options.siteId,
              window: timeWindow(request.time),
              filters,
              limit,
              includeDetails,
              cursorText,
              audience: request.context.policy.audience,
              deferred,
              ...(request.scopePlan ? { scopePlan: request.scopePlan } : {}),
              ...(options.diagnostics
                ? { diagnostics: options.diagnostics }
                : {}),
              variant: request.variant,
              includeTabs: request.includeTabs,
            });
            if (qualified.kind === "executed")
              return { value: qualified.page, source: "raw" };
            const fallbackFilters =
              await prepareDeferredEventQualificationFallback(deferred);
            const cursor = await decodePagesCursor(
              options.env,
              options.siteId,
              timeWindow(request.time),
              fallbackFilters,
              includeDetails,
              cursorText,
              request.context.policy.audience,
            );
            if (cursorText && !cursor) throw new InvalidCursorError("pages");
            return {
              value: await queryPagesPageFromD1(
                options.env,
                options.siteId,
                timeWindow(request.time),
                fallbackFilters,
                limit,
                includeDetails,
                cursor,
                request.context.policy.audience,
              ),
              source: "raw",
            };
          }
          const cursor = await decodePagesCursor(
            options.env,
            options.siteId,
            timeWindow(request.time),
            filters,
            includeDetails,
            cursorText,
            request.context.policy.audience,
          );
          if (cursorText && !cursor) throw new InvalidCursorError("pages");
          return {
            value: await queryPagesPageFromD1(
              options.env,
              options.siteId,
              timeWindow(request.time),
              filters,
              limit,
              includeDetails,
              cursor,
              request.context.policy.audience,
            ),
            source: "raw",
          };
        }
      }),
    )
    .register(
      "referrers",
      typedQueryProviderFor("referrers", async (input) => {
        const request = input;
        if (request.variant === "summary") {
          const topN = numberField(
            request,
            "topN",
            numberField(request, "limit", 5),
          );
          const deferred = deferredReferrersQualificationFromQuery(input);
          if (deferred?.referrersRequest.kind === "summary") {
            const execution = await queryQualifiedReferrerSummaryFromD1({
              env: options.env,
              deferred,
              siteId: options.siteId,
              topN,
              diagnostics: options.diagnostics,
            });
            if (execution.kind === "executed")
              return { value: execution.summary, source: "raw" };
            if (options.diagnostics)
              options.diagnostics.advancedCountSqlFallbackReason =
                execution.fallbackReason;
            const fallbackFilters =
              await prepareDeferredEventQualificationFallback(deferred);
            return {
              value: await queryReferrerSummaryFromD1(
                options.env,
                options.siteId,
                timeWindow(request.time),
                fallbackFilters,
                topN,
                options.diagnostics,
              ),
              source: "raw",
            };
          }
          return {
            value: await queryReferrerSummaryFromD1(
              options.env,
              options.siteId,
              timeWindow(request.time),
              request.filters ?? EMPTY_FILTER_DOCUMENT,
              topN,
              options.diagnostics,
            ),
            source: "raw",
          };
        }
        const rawPage = request.page;
        const page =
          rawPage && typeof rawPage === "object"
            ? (rawPage as { limit?: unknown; cursor?: unknown })
            : {};
        {
          const limit =
            typeof page.limit === "number" && Number.isFinite(page.limit)
              ? page.limit
              : numberField(request, "limit", 20);
          const cursorText =
            typeof page.cursor === "string" ? page.cursor : null;
          const sortBy =
            stringField(request, "sort") === "visitors" ? "visitors" : "views";
          const sortDirection =
            stringField(request, "direction") === "asc" ? "asc" : "desc";
          const window = timeWindow(request.time);
          const filters = request.filters ?? EMPTY_FILTER_DOCUMENT;
          const includeFullUrl = request.includeFullUrl === true;
          const search =
            typeof request.search === "string" ? request.search : undefined;
          const deferred = deferredReferrersQualificationFromQuery(input);
          let cursor: ReferrerAggregateCursor | null = null;
          let cursorError: InvalidCursorError | undefined;
          try {
            cursor = await decodeReferrersCursor(
              options.env,
              options.siteId,
              window,
              filters,
              includeFullUrl,
              search,
              cursorText,
              request.context.policy.audience,
              sortBy,
              sortDirection,
            );
          } catch (error) {
            if (error instanceof InvalidCursorError && cursorText)
              cursorError = error;
            else throw error;
          }
          if (cursorText && (!cursor || cursorError)) {
            if (deferred?.referrersRequest.kind === "page") {
              const execution = await queryQualifiedReferrersFlatPageFromD1({
                env: options.env,
                deferred,
                siteId: options.siteId,
                window,
                filters,
                limit,
                includeFullUrl,
                search,
                cursor: null,
                cursorToken: cursorText,
                audience: request.context.policy.audience,
                sortBy,
                sortDirection,
                diagnostics: options.diagnostics,
              });
              if (execution.kind !== "executed") {
                await prepareDeferredEventQualificationFallback(deferred);
              }
            }
            throw cursorError ?? new InvalidCursorError("referrers");
          }
          if (deferred?.referrersRequest.kind === "page") {
            const execution = await queryQualifiedReferrersFlatPageFromD1({
              env: options.env,
              deferred,
              siteId: options.siteId,
              window,
              filters,
              limit,
              includeFullUrl,
              search,
              cursor,
              cursorToken: cursorText,
              audience: request.context.policy.audience,
              sortBy,
              sortDirection,
              diagnostics: options.diagnostics,
            });
            if (execution.kind === "executed")
              return { value: execution.page, source: "raw" };
            const fallbackFilters =
              await prepareDeferredEventQualificationFallback(deferred);
            return {
              value: await queryReferrersPageFromD1(
                options.env,
                options.siteId,
                window,
                fallbackFilters,
                limit,
                includeFullUrl,
                search,
                cursor,
                options.diagnostics,
                request.context.policy.audience,
                sortBy,
                sortDirection,
              ),
              source: "raw",
            };
          }
          return {
            value: await queryReferrersPageFromD1(
              options.env,
              options.siteId,
              window,
              filters,
              limit,
              includeFullUrl,
              search,
              cursor,
              undefined,
              request.context.policy.audience,
              sortBy,
              sortDirection,
            ),
            source: "raw",
          };
        }
      }),
    )
    .register(
      "pages-dashboard",
      typedQueryProviderFor("pages-dashboard", async (input) => {
        const request = input;
        const deferred = deferredPagesDashboardQualificationFromQuery(request);
        if (deferred) {
          const qualified = await executePagesDashboardQualificationProgram({
            env: options.env,
            siteId: options.siteId,
            query: request as unknown as QueryInput & Record<string, unknown>,
            ...(options.diagnostics
              ? { diagnostics: options.diagnostics }
              : {}),
            ...(options.pagesDashboardQualificationCompile
              ? { compileProgram: options.pagesDashboardQualificationCompile }
              : {}),
          });
          if (qualified.kind === "executed" || qualified.kind === "empty")
            return { value: qualified.value, source: "raw" };
          const fallbackFilters =
            await prepareDeferredEventQualificationFallback(
              deferred.qualification,
            );
          return {
            value: await queryPagesDashboard(options.env, options.siteId, {
              window: timeWindow(request.time),
              filters: fallbackFilters,
              interval: deferred.configuration.interval,
              search: deferred.configuration.search,
              sort: request.sort,
              page: {
                limit: deferred.configuration.limit,
                cursor: deferred.configuration.cursorText,
              },
              audience: deferred.configuration.audience,
            }),
            source: "raw",
          };
        }
        return {
          value: await queryPagesDashboard(options.env, options.siteId, {
            window: timeWindow(request.time),
            filters: request.filters ?? EMPTY_FILTER_DOCUMENT,
            interval: request.interval,
            search: request.search,
            sort: request.sort,
            comparison: request.comparison,
            page: request.page ?? { limit: 12, cursor: null },
            audience: request.context.policy.audience,
          }),
        };
      }),
    );
}
