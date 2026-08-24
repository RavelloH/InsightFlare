import type { Context } from "hono";
import type { Hono } from "hono";

import { createAnalysisDefinitionReader } from "@/lib/api-v1/analysis-definition-reader";
import { handlePlannedSiteAnalyticsSchema } from "@/lib/api-v1/analytics-schema-handler";
import {
  handleSiteComparison,
  handleSiteComparisonBreakdown,
} from "@/lib/api-v1/comparison-handler";
import { SitePerformanceBreakdownDimensionSchema } from "@/lib/api-v1/dto/analytics";
import {
  handlePlannedSiteFunnelAnalysis,
  type SiteFunnelAnalysisProvider,
} from "@/lib/api-v1/funnel-analysis-handler";
import { handlePlannedSiteOverview } from "@/lib/api-v1/overview-handler";
import { handlePlannedSavedFilters } from "@/lib/api-v1/saved-filters-handler";
import {
  handlePlannedSiteBreakdown,
  type SiteBreakdownReader,
} from "@/lib/api-v1/site-breakdown-handler";
import {
  handlePlannedSiteCrossBreakdown,
  type SiteCrossBreakdownReader,
} from "@/lib/api-v1/site-cross-breakdown-handler";
import {
  handlePlannedSiteChannels,
  handlePlannedSiteEventDetail,
  handlePlannedSiteEventFields,
  handlePlannedSiteEventFieldValues,
  handlePlannedSiteEventsSearch,
  handlePlannedSiteEventsSummary,
  handlePlannedSiteEventsTimeseries,
  handlePlannedSiteEventTypeDetail,
  handlePlannedSiteEventTypes,
  handlePlannedSiteFilterValues,
  handlePlannedSitePages,
  handlePlannedSitePerformanceBreakdown,
  handlePlannedSitePerformanceSummary,
  handlePlannedSitePerformanceTimeseries,
  handlePlannedSiteRealtimeActiveVisitors,
  handlePlannedSiteRealtimeEvents,
  handlePlannedSiteRealtimeSessions,
  handlePlannedSiteRealtimeSnapshot,
  handlePlannedSiteReferrers,
  handlePlannedSiteRetention,
  handlePlannedSiteSessionDetail,
  handlePlannedSiteSessionEvents,
  handlePlannedSiteSessionsSearch,
  handlePlannedSiteVisitorDetail,
  handlePlannedSiteVisitorEvents,
  handlePlannedSiteVisitorSessions,
  handlePlannedSiteVisitorsSearch,
  type SiteChannelsReader,
  type SiteEventDetailReader,
  type SiteEventFieldsReader,
  type SiteEventFieldValuesReader,
  type SiteEventsSearchReader,
  type SiteEventsSummaryReader,
  type SiteEventsTimeseriesReader,
  type SiteEventTypeDetailReader,
  type SiteEventTypesReader,
  type SiteFilterValuesReader,
  type SitePagesReader,
  type SitePerformanceBreakdownReader,
  type SitePerformanceSummaryReader,
  type SitePerformanceTimeseriesReader,
  type SiteRealtimeActiveVisitorsReader,
  type SiteRealtimeEventsReader,
  type SiteRealtimeSessionsReader,
  type SiteRealtimeSnapshotReader,
  type SiteReferrersReader,
  type SiteRetentionReader,
  type SiteSessionDetailReader,
  type SiteSessionEventsReader,
  type SiteSessionsSearchReader,
  type SiteVisitorDetailReader,
  type SiteVisitorEventsReader,
  type SiteVisitorSessionsReader,
  type SiteVisitorsSearchReader,
} from "@/lib/api-v1/site-list-handler";
import { handlePlannedSiteTimeseries } from "@/lib/api-v1/timeseries-handler";
import { jsonError } from "@/lib/api-v1/wire-helpers";
import {
  createOverviewReader,
  readSiteBreakdown,
  readSiteChannels,
  readSiteCrossBreakdown,
  readSiteEventDetail,
  readSiteEventFields,
  readSiteEventFieldValues,
  readSiteEventRecords,
  readSiteEventsSummary,
  readSiteEventsTimeseries,
  readSiteEventTypeDetail,
  readSiteEventTypes,
  readSiteFilterValues,
  readSiteFunnelAnalysis,
  readSitePages,
  readSitePerformanceBreakdown,
  readSitePerformanceSummary,
  readSitePerformanceTimeseries,
  readSiteRealtimeActiveVisitors,
  readSiteRealtimeEvents,
  readSiteRealtimeSessions,
  readSiteRealtimeSnapshot,
  readSiteReferrers,
  readSiteRetention,
  readSiteSessionDetail,
  readSiteSessionEvents,
  readSiteSessions,
  readSiteVisitorDetail,
  readSiteVisitorEvents,
  readSiteVisitors,
  readSiteVisitorSessions,
} from "@/lib/edge/analytics/adapters/api-v1";
import {
  createProviderRegistry,
  createReaderProviderRegistry,
} from "@/lib/edge/analytics/composition/create-provider-registry";
import {
  type AnalyticsResult,
  executeOverview,
  executeTrend,
  type OverviewQuery,
  type OverviewResult,
  type TrendQuery,
  type TrendResult,
} from "@/lib/edge/analytics/contract";
import type { ApiKeyPrincipal } from "@/lib/edge/api-key-auth";
import type { AppEnv } from "@/lib/hono/types";

interface SiteAnalyticsRouteDependencies {
  readonly resolvePrincipal: (c: Context<AppEnv>) => ApiKeyPrincipal;
  readonly resourceNotFound: (c: Context<AppEnv>) => Response;
}

export function registerV1SiteAnalyticsRoutes(
  routes: Hono<AppEnv>,
  deps: SiteAnalyticsRouteDependencies,
): void {
  routes.post("/sites/:siteId/analytics/comparison", (c) => {
    const siteId = c.req.param("siteId");
    if (!siteId) return deps.resourceNotFound(c);
    return handleSiteComparison(
      c.req.raw,
      deps.resolvePrincipal(c),
      c.env,
      siteId,
      createAnalysisDefinitionReader(c.env, deps.resolvePrincipal(c)),
    );
  });
  routes.post(
    "/sites/:siteId/analytics/comparison/breakdowns/:dimension",
    (c) => {
      const siteId = c.req.param("siteId");
      const dimension = c.req.param("dimension");
      if (!siteId || !dimension) return deps.resourceNotFound(c);
      return handleSiteComparisonBreakdown(
        c.req.raw,
        deps.resolvePrincipal(c),
        c.env,
        siteId,
        dimension,
        createAnalysisDefinitionReader(c.env, deps.resolvePrincipal(c)),
      );
    },
  );
  routes.post("/sites/:siteId/analytics/overview", (c) => {
    const siteId = c.req.param("siteId");
    if (!siteId) return deps.resourceNotFound(c);
    return handlePlannedSiteOverview(
      c.req.raw,
      deps.resolvePrincipal(c),
      siteId,
      createProviderRegistry().registerCallback<
        OverviewQuery,
        AnalyticsResult<OverviewResult>
      >("site.analytics.overview", (query) =>
        executeOverview(createOverviewReader(c.env, siteId), query),
      ),
      { signal: c.req.raw.signal, capturedAtMs: Date.now() },
      createAnalysisDefinitionReader(c.env, deps.resolvePrincipal(c)),
    );
  });
  routes.all("/sites/:siteId/analytics/schema", (c) => {
    const siteId = c.req.param("siteId");
    if (!siteId) return deps.resourceNotFound(c);
    return handlePlannedSiteAnalyticsSchema(
      c.req.raw,
      deps.resolvePrincipal(c),
      siteId,
    );
  });
  routes.all("/sites/:siteId/saved-filters", (c) => {
    const siteId = c.req.param("siteId");
    if (!siteId) return deps.resourceNotFound(c);
    return handlePlannedSavedFilters(
      c.req.raw,
      c.env,
      deps.resolvePrincipal(c),
      siteId,
    );
  });
  routes.all("/sites/:siteId/saved-filters/:savedFilterId", (c) => {
    const siteId = c.req.param("siteId");
    const savedFilterId = c.req.param("savedFilterId");
    if (!siteId || !savedFilterId) return deps.resourceNotFound(c);
    return handlePlannedSavedFilters(
      c.req.raw,
      c.env,
      deps.resolvePrincipal(c),
      siteId,
      savedFilterId,
    );
  });
  routes.post("/sites/:siteId/analytics/timeseries", (c) => {
    const siteId = c.req.param("siteId");
    if (!siteId) return deps.resourceNotFound(c);
    return handlePlannedSiteTimeseries(
      c.req.raw,
      deps.resolvePrincipal(c),
      siteId,
      createProviderRegistry().registerCallback<
        TrendQuery,
        AnalyticsResult<TrendResult>
      >("site.analytics.timeseries", (query) =>
        executeTrend(createOverviewReader(c.env, siteId), query),
      ),
      { signal: c.req.raw.signal, capturedAtMs: Date.now() },
      createAnalysisDefinitionReader(c.env, deps.resolvePrincipal(c)),
    );
  });
  routes.post("/sites/:siteId/analytics/breakdowns/:dimension", (c) => {
    const siteId = c.req.param("siteId");
    const dimension = c.req.param("dimension");
    if (!siteId || !dimension) return deps.resourceNotFound(c);
    return handlePlannedSiteBreakdown(
      c.req.raw,
      deps.resolvePrincipal(c),
      siteId,
      dimension,
      createReaderProviderRegistry<SiteBreakdownReader>(
        "site.analytics.breakdown",
        (input) =>
          readSiteBreakdown({
            env: c.env,
            siteId: input.siteId,
            dimension: input.dimension,
            limit: input.limit,
            window: {
              startMs: input.startMs,
              endExclusiveMs: input.endExclusiveMs,
              timeZone: input.timeZone,
              nowMs: Date.now(),
            },
            filters: input.filters,
          }),
      ),
      { signal: c.req.raw.signal, capturedAtMs: Date.now() },
      createAnalysisDefinitionReader(c.env, deps.resolvePrincipal(c)),
    );
  });
  routes.post("/sites/:siteId/analytics/cross-breakdowns", (c) => {
    const siteId = c.req.param("siteId");
    if (!siteId) return deps.resourceNotFound(c);
    return handlePlannedSiteCrossBreakdown(
      c.req.raw,
      deps.resolvePrincipal(c),
      siteId,
      createReaderProviderRegistry<SiteCrossBreakdownReader>(
        "site.analytics.crossBreakdown",
        (input) =>
          readSiteCrossBreakdown({
            env: c.env,
            siteId: input.siteId,
            primaryDimension: input.primaryDimension,
            secondaryDimension: input.secondaryDimension,
            primaryLimit: input.primaryLimit,
            secondaryLimit: input.secondaryLimit,
            window: {
              startMs: input.startMs,
              endExclusiveMs: input.endExclusiveMs,
              timeZone: input.timeZone,
              nowMs: Date.now(),
            },
            filters: input.filters,
          }),
      ),
      { signal: c.req.raw.signal, capturedAtMs: Date.now() },
      createAnalysisDefinitionReader(c.env, deps.resolvePrincipal(c)),
    );
  });
  routes.post("/sites/:siteId/analytics/pages", (c) => {
    const siteId = c.req.param("siteId");
    if (!siteId) return deps.resourceNotFound(c);
    return handlePlannedSitePages(
      c.req.raw,
      deps.resolvePrincipal(c),
      siteId,
      createReaderProviderRegistry<SitePagesReader>(
        "site.analytics.pages",
        (input) =>
          readSitePages({
            env: c.env,
            siteId: input.siteId,
            limit: input.limit,
            includeDetails: input.includeDetails,
            window: {
              startMs: input.startMs,
              endExclusiveMs: input.endExclusiveMs,
              timeZone: input.timeZone,
              nowMs: Date.now(),
            },
            filters: input.filters,
          }),
      ),
      { signal: c.req.raw.signal, capturedAtMs: Date.now() },
      createAnalysisDefinitionReader(c.env, deps.resolvePrincipal(c)),
    );
  });
  routes.post("/sites/:siteId/analytics/referrers", (c) => {
    const siteId = c.req.param("siteId");
    if (!siteId) return deps.resourceNotFound(c);
    return handlePlannedSiteReferrers(
      c.req.raw,
      deps.resolvePrincipal(c),
      siteId,
      createReaderProviderRegistry<SiteReferrersReader>(
        "site.analytics.referrers",
        (input) =>
          readSiteReferrers({
            env: c.env,
            siteId: input.siteId,
            limit: input.limit,
            includeFullUrl: input.includeFullUrl,
            window: {
              startMs: input.startMs,
              endExclusiveMs: input.endExclusiveMs,
              timeZone: input.timeZone,
              nowMs: Date.now(),
            },
            filters: input.filters,
          }),
      ),
      { signal: c.req.raw.signal, capturedAtMs: Date.now() },
      createAnalysisDefinitionReader(c.env, deps.resolvePrincipal(c)),
    );
  });
  routes.post("/sites/:siteId/analytics/channels", (c) => {
    const siteId = c.req.param("siteId");
    if (!siteId) return deps.resourceNotFound(c);
    return handlePlannedSiteChannels(
      c.req.raw,
      deps.resolvePrincipal(c),
      siteId,
      createReaderProviderRegistry<SiteChannelsReader>(
        "site.analytics.channels",
        (input) =>
          readSiteChannels({
            env: c.env,
            siteId: input.siteId,
            limit: input.limit,
            window: {
              startMs: input.startMs,
              endExclusiveMs: input.endExclusiveMs,
              timeZone: input.timeZone,
              nowMs: Date.now(),
            },
            filters: input.filters,
          }),
      ),
      { signal: c.req.raw.signal, capturedAtMs: Date.now() },
      createAnalysisDefinitionReader(c.env, deps.resolvePrincipal(c)),
    );
  });
  routes.post("/sites/:siteId/analytics/filter-values", (c) => {
    const siteId = c.req.param("siteId");
    if (!siteId) return deps.resourceNotFound(c);
    return handlePlannedSiteFilterValues(
      c.req.raw,
      deps.resolvePrincipal(c),
      siteId,
      createReaderProviderRegistry<SiteFilterValuesReader>(
        "site.analytics.filterValues",
        (input) =>
          readSiteFilterValues({
            env: c.env,
            siteId: input.siteId,
            field: input.field,
            search: input.search,
            limit: input.page.limit,
            window: {
              startMs: input.startMs,
              endExclusiveMs: input.endExclusiveMs,
              timeZone: input.timeZone,
              nowMs: Date.now(),
            },
            filters: input.filters,
          }),
      ),
      { signal: c.req.raw.signal, capturedAtMs: Date.now() },
      createAnalysisDefinitionReader(c.env, deps.resolvePrincipal(c)),
    );
  });
  routes.post("/sites/:siteId/analytics/retention/cohorts", (c) => {
    const siteId = c.req.param("siteId");
    if (!siteId) return deps.resourceNotFound(c);
    return handlePlannedSiteRetention(
      c.req.raw,
      deps.resolvePrincipal(c),
      siteId,
      createReaderProviderRegistry<SiteRetentionReader>(
        "site.analytics.retentionCohorts",
        (input) =>
          readSiteRetention({
            env: c.env,
            siteId: input.siteId,
            granularity: input.granularity,
            window: {
              startMs: input.startMs,
              endExclusiveMs: input.endExclusiveMs,
              timeZone: input.timeZone,
              nowMs: Date.now(),
            },
            filters: input.filters,
          }),
      ),
      { signal: c.req.raw.signal, capturedAtMs: Date.now() },
      createAnalysisDefinitionReader(c.env, deps.resolvePrincipal(c)),
    );
  });
  routes.post("/sites/:siteId/analytics/funnel-analysis", (c) => {
    const siteId = c.req.param("siteId");
    if (!siteId) return deps.resourceNotFound(c);
    return handlePlannedSiteFunnelAnalysis(
      c.req.raw,
      deps.resolvePrincipal(c),
      siteId,
      createReaderProviderRegistry<SiteFunnelAnalysisProvider>(
        "site.analytics.funnelAnalysis",
        (input) => readSiteFunnelAnalysis({ env: c.env, ...input }),
      ),
      createAnalysisDefinitionReader(c.env, deps.resolvePrincipal(c)),
      { signal: c.req.raw.signal, capturedAtMs: Date.now() },
    );
  });
  routes.post("/sites/:siteId/analytics/performance/summary", (c) => {
    const siteId = c.req.param("siteId");
    if (!siteId) return deps.resourceNotFound(c);
    return handlePlannedSitePerformanceSummary(
      c.req.raw,
      deps.resolvePrincipal(c),
      siteId,
      createReaderProviderRegistry<SitePerformanceSummaryReader>(
        "site.analytics.performanceSummary",
        (input) =>
          readSitePerformanceSummary({
            env: c.env,
            siteId: input.siteId,
            window: {
              startMs: input.startMs,
              endExclusiveMs: input.endExclusiveMs,
              timeZone: input.timeZone,
              nowMs: Date.now(),
            },
            filters: input.filters,
          }),
      ),
      { signal: c.req.raw.signal, capturedAtMs: Date.now() },
      createAnalysisDefinitionReader(c.env, deps.resolvePrincipal(c)),
    );
  });
  routes.post("/sites/:siteId/analytics/performance/timeseries", (c) => {
    const siteId = c.req.param("siteId");
    if (!siteId) return deps.resourceNotFound(c);
    return handlePlannedSitePerformanceTimeseries(
      c.req.raw,
      deps.resolvePrincipal(c),
      siteId,
      createReaderProviderRegistry<SitePerformanceTimeseriesReader>(
        "site.analytics.performanceTimeseries",
        (input) =>
          readSitePerformanceTimeseries({
            env: c.env,
            siteId: input.siteId,
            interval: input.interval,
            window: {
              startMs: input.startMs,
              endExclusiveMs: input.endExclusiveMs,
              timeZone: input.timeZone,
              nowMs: Date.now(),
            },
            filters: input.filters,
          }),
      ),
      { signal: c.req.raw.signal, capturedAtMs: Date.now() },
      createAnalysisDefinitionReader(c.env, deps.resolvePrincipal(c)),
    );
  });
  routes.post(
    "/sites/:siteId/analytics/performance/breakdowns/:dimension",
    (c) => {
      const siteId = c.req.param("siteId");
      const dimension = c.req.param("dimension");
      if (!siteId || !dimension) return deps.resourceNotFound(c);
      const parsedDimension =
        SitePerformanceBreakdownDimensionSchema.safeParse(dimension);
      if (!parsedDimension.success) {
        return jsonError(
          "validation_failed",
          "Unsupported performance breakdown dimension.",
          400,
          {
            dimension,
            supportedDimensions:
              SitePerformanceBreakdownDimensionSchema.options,
          },
          c.req.raw,
        );
      }
      return handlePlannedSitePerformanceBreakdown(
        c.req.raw,
        deps.resolvePrincipal(c),
        siteId,
        createReaderProviderRegistry<SitePerformanceBreakdownReader>(
          "site.analytics.performanceBreakdown",
          (input) =>
            readSitePerformanceBreakdown({
              env: c.env,
              siteId: input.siteId,
              dimension: parsedDimension.data,
              metric: input.metric,
              limit: input.limit,
              window: {
                startMs: input.startMs,
                endExclusiveMs: input.endExclusiveMs,
                timeZone: input.timeZone,
                nowMs: Date.now(),
              },
              filters: input.filters,
            }),
        ),
        { signal: c.req.raw.signal, capturedAtMs: Date.now() },
        createAnalysisDefinitionReader(c.env, deps.resolvePrincipal(c)),
      );
    },
  );
  routes.post("/sites/:siteId/analytics/events/summary", (c) => {
    const siteId = c.req.param("siteId");
    if (!siteId) return deps.resourceNotFound(c);
    return handlePlannedSiteEventsSummary(
      c.req.raw,
      deps.resolvePrincipal(c),
      siteId,
      createReaderProviderRegistry<SiteEventsSummaryReader>(
        "site.analytics.eventsSummary",
        (input) =>
          readSiteEventsSummary({
            env: c.env,
            siteId: input.siteId,
            window: {
              startMs: input.startMs,
              endExclusiveMs: input.endExclusiveMs,
              timeZone: input.timeZone,
              nowMs: Date.now(),
            },
            filters: input.filters,
          }),
      ),
      { signal: c.req.raw.signal, capturedAtMs: Date.now() },
      createAnalysisDefinitionReader(c.env, deps.resolvePrincipal(c)),
    );
  });
  routes.post("/sites/:siteId/analytics/events/timeseries", (c) => {
    const siteId = c.req.param("siteId");
    if (!siteId) return deps.resourceNotFound(c);
    return handlePlannedSiteEventsTimeseries(
      c.req.raw,
      deps.resolvePrincipal(c),
      siteId,
      createReaderProviderRegistry<SiteEventsTimeseriesReader>(
        "site.analytics.eventsTimeseries",
        (input) =>
          readSiteEventsTimeseries({
            env: c.env,
            siteId: input.siteId,
            interval: input.interval,
            limit: input.limit,
            window: {
              startMs: input.startMs,
              endExclusiveMs: input.endExclusiveMs,
              timeZone: input.timeZone,
              nowMs: Date.now(),
            },
            filters: input.filters,
          }),
      ),
      { signal: c.req.raw.signal, capturedAtMs: Date.now() },
      createAnalysisDefinitionReader(c.env, deps.resolvePrincipal(c)),
    );
  });
  routes.post("/sites/:siteId/analytics/event-types", (c) => {
    const siteId = c.req.param("siteId");
    if (!siteId) return deps.resourceNotFound(c);
    return handlePlannedSiteEventTypes(
      c.req.raw,
      deps.resolvePrincipal(c),
      siteId,
      createReaderProviderRegistry<SiteEventTypesReader>(
        "site.analytics.eventTypes",
        (input) =>
          readSiteEventTypes({
            env: c.env,
            siteId: input.siteId,
            search: input.search,
            limit: input.page.limit,
            window: {
              startMs: input.startMs,
              endExclusiveMs: input.endExclusiveMs,
              timeZone: input.timeZone,
              nowMs: Date.now(),
            },
            filters: input.filters,
          }),
      ),
      { signal: c.req.raw.signal, capturedAtMs: Date.now() },
      createAnalysisDefinitionReader(c.env, deps.resolvePrincipal(c)),
    );
  });
  routes.post("/sites/:siteId/analytics/event-types/detail", (c) => {
    const siteId = c.req.param("siteId");
    if (!siteId) return deps.resourceNotFound(c);
    return handlePlannedSiteEventTypeDetail(
      c.req.raw,
      deps.resolvePrincipal(c),
      siteId,
      createReaderProviderRegistry<SiteEventTypeDetailReader>(
        "site.analytics.eventTypeDetail",
        (input) =>
          readSiteEventTypeDetail({
            env: c.env,
            siteId: input.siteId,
            eventName: input.eventName,
            interval: input.interval,
            window: {
              startMs: input.startMs,
              endExclusiveMs: input.endExclusiveMs,
              timeZone: input.timeZone,
              nowMs: Date.now(),
            },
            filters: input.filters,
          }),
      ),
      { signal: c.req.raw.signal, capturedAtMs: Date.now() },
      createAnalysisDefinitionReader(c.env, deps.resolvePrincipal(c)),
    );
  });
  routes.post("/sites/:siteId/analytics/event-types/fields", (c) => {
    const siteId = c.req.param("siteId");
    if (!siteId) return deps.resourceNotFound(c);
    return handlePlannedSiteEventFields(
      c.req.raw,
      deps.resolvePrincipal(c),
      siteId,
      createReaderProviderRegistry<SiteEventFieldsReader>(
        "site.analytics.eventFields",
        (input) =>
          readSiteEventFields({
            env: c.env,
            siteId: input.siteId,
            eventName: input.eventName,
            limit: input.page.limit,
            window: {
              startMs: input.startMs,
              endExclusiveMs: input.endExclusiveMs,
              timeZone: input.timeZone,
              nowMs: Date.now(),
            },
            filters: input.filters,
          }),
      ),
      { signal: c.req.raw.signal, capturedAtMs: Date.now() },
      createAnalysisDefinitionReader(c.env, deps.resolvePrincipal(c)),
    );
  });
  routes.post("/sites/:siteId/analytics/event-types/field-values", (c) => {
    const siteId = c.req.param("siteId");
    if (!siteId) return deps.resourceNotFound(c);
    return handlePlannedSiteEventFieldValues(
      c.req.raw,
      deps.resolvePrincipal(c),
      siteId,
      createReaderProviderRegistry<SiteEventFieldValuesReader>(
        "site.analytics.eventFieldValues",
        (input) =>
          readSiteEventFieldValues({
            env: c.env,
            siteId: input.siteId,
            eventName: input.eventName,
            fieldPath: input.fieldPath,
            fieldValueType: input.fieldValueType,
            search: input.search,
            limit: input.page.limit,
            window: {
              startMs: input.startMs,
              endExclusiveMs: input.endExclusiveMs,
              timeZone: input.timeZone,
              nowMs: Date.now(),
            },
            filters: input.filters,
          }),
      ),
      { signal: c.req.raw.signal, capturedAtMs: Date.now() },
      createAnalysisDefinitionReader(c.env, deps.resolvePrincipal(c)),
    );
  });
  routes.post("/sites/:siteId/analytics/events/search", (c) => {
    const siteId = c.req.param("siteId");
    if (!siteId) return deps.resourceNotFound(c);
    return handlePlannedSiteEventsSearch(
      c.req.raw,
      deps.resolvePrincipal(c),
      siteId,
      createReaderProviderRegistry<SiteEventsSearchReader>(
        "site.analytics.eventsSearch",
        (input) =>
          readSiteEventRecords({
            env: c.env,
            siteId: input.siteId,
            search: input.search,
            eventName: input.eventName,
            sort: input.sort,
            page: input.page,
            window: {
              startMs: input.startMs,
              endExclusiveMs: input.endExclusiveMs,
              timeZone: input.timeZone,
              nowMs: Date.now(),
            },
            filters: input.filters,
          }),
      ),
      { signal: c.req.raw.signal, capturedAtMs: Date.now() },
      createAnalysisDefinitionReader(c.env, deps.resolvePrincipal(c)),
    );
  });
  routes.post("/sites/:siteId/analytics/events/detail", (c) => {
    const siteId = c.req.param("siteId");
    if (!siteId) return deps.resourceNotFound(c);
    return handlePlannedSiteEventDetail(
      c.req.raw,
      deps.resolvePrincipal(c),
      siteId,
      createReaderProviderRegistry<SiteEventDetailReader>(
        "site.analytics.eventDetail",
        (input) =>
          readSiteEventDetail({
            env: c.env,
            siteId: input.siteId,
            eventId: input.eventId,
            window: {
              startMs: input.startMs,
              endExclusiveMs: input.endExclusiveMs,
              timeZone: input.timeZone,
              nowMs: Date.now(),
            },
          }),
      ),
      { signal: c.req.raw.signal, capturedAtMs: Date.now() },
    );
  });
  routes.post("/sites/:siteId/analytics/realtime/snapshot", (c) => {
    const siteId = c.req.param("siteId");
    if (!siteId) return deps.resourceNotFound(c);
    return handlePlannedSiteRealtimeSnapshot(
      c.req.raw,
      deps.resolvePrincipal(c),
      siteId,
      createReaderProviderRegistry<SiteRealtimeSnapshotReader>(
        "site.analytics.realtimeSnapshot",
        (input) =>
          readSiteRealtimeSnapshot({
            env: c.env,
            siteId: input.siteId,
            startMs: input.startMs,
            endExclusiveMs: input.endExclusiveMs,
            limit: input.limit,
            signal: input.signal,
          }),
      ),
      { signal: c.req.raw.signal, capturedAtMs: Date.now() },
    );
  });
  routes.post("/sites/:siteId/analytics/realtime/active-visitors", (c) => {
    const siteId = c.req.param("siteId");
    if (!siteId) return deps.resourceNotFound(c);
    return handlePlannedSiteRealtimeActiveVisitors(
      c.req.raw,
      deps.resolvePrincipal(c),
      siteId,
      createReaderProviderRegistry<SiteRealtimeActiveVisitorsReader>(
        "site.analytics.realtimeActiveVisitors",
        (input) =>
          readSiteRealtimeActiveVisitors({
            env: c.env,
            siteId: input.siteId,
            startMs: input.startMs,
            endExclusiveMs: input.endExclusiveMs,
            signal: input.signal,
          }),
      ),
      { signal: c.req.raw.signal, capturedAtMs: Date.now() },
    );
  });
  routes.post("/sites/:siteId/analytics/realtime/events", (c) => {
    const siteId = c.req.param("siteId");
    if (!siteId) return deps.resourceNotFound(c);
    return handlePlannedSiteRealtimeEvents(
      c.req.raw,
      deps.resolvePrincipal(c),
      siteId,
      createReaderProviderRegistry<SiteRealtimeEventsReader>(
        "site.analytics.realtimeEvents",
        (input) =>
          readSiteRealtimeEvents({
            env: c.env,
            siteId: input.siteId,
            startMs: input.startMs,
            endExclusiveMs: input.endExclusiveMs,
            limit: input.limit,
            signal: input.signal,
          }),
      ),
      { signal: c.req.raw.signal, capturedAtMs: Date.now() },
    );
  });
  routes.post("/sites/:siteId/analytics/realtime/sessions", (c) => {
    const siteId = c.req.param("siteId");
    if (!siteId) return deps.resourceNotFound(c);
    return handlePlannedSiteRealtimeSessions(
      c.req.raw,
      deps.resolvePrincipal(c),
      siteId,
      createReaderProviderRegistry<SiteRealtimeSessionsReader>(
        "site.analytics.realtimeSessions",
        (input) =>
          readSiteRealtimeSessions({
            env: c.env,
            siteId: input.siteId,
            startMs: input.startMs,
            endExclusiveMs: input.endExclusiveMs,
            limit: input.limit,
            signal: input.signal,
          }),
      ),
      { signal: c.req.raw.signal, capturedAtMs: Date.now() },
    );
  });
  routes.post("/sites/:siteId/analytics/visitors/detail", (c) => {
    const siteId = c.req.param("siteId");
    if (!siteId) return deps.resourceNotFound(c);
    return handlePlannedSiteVisitorDetail(
      c.req.raw,
      deps.resolvePrincipal(c),
      siteId,
      createReaderProviderRegistry<SiteVisitorDetailReader>(
        "site.analytics.visitorDetail",
        (input) =>
          readSiteVisitorDetail({
            env: c.env,
            siteId: input.siteId,
            visitorId: input.visitorId,
            window: {
              startMs: input.startMs,
              endExclusiveMs: input.endExclusiveMs,
              timeZone: input.timeZone,
              nowMs: Date.now(),
            },
          }),
      ),
      { signal: c.req.raw.signal, capturedAtMs: Date.now() },
    );
  });
  routes.post("/sites/:siteId/analytics/sessions/detail", (c) => {
    const siteId = c.req.param("siteId");
    if (!siteId) return deps.resourceNotFound(c);
    return handlePlannedSiteSessionDetail(
      c.req.raw,
      deps.resolvePrincipal(c),
      siteId,
      createReaderProviderRegistry<SiteSessionDetailReader>(
        "site.analytics.sessionDetail",
        (input) =>
          readSiteSessionDetail({
            env: c.env,
            siteId: input.siteId,
            sessionId: input.sessionId,
            window: {
              startMs: input.startMs,
              endExclusiveMs: input.endExclusiveMs,
              timeZone: input.timeZone,
              nowMs: Date.now(),
            },
          }),
      ),
      { signal: c.req.raw.signal, capturedAtMs: Date.now() },
    );
  });
  routes.post("/sites/:siteId/analytics/visitors/search", (c) => {
    const siteId = c.req.param("siteId");
    if (!siteId) return deps.resourceNotFound(c);
    return handlePlannedSiteVisitorsSearch(
      c.req.raw,
      deps.resolvePrincipal(c),
      siteId,
      createReaderProviderRegistry<SiteVisitorsSearchReader>(
        "site.analytics.visitorsSearch",
        (input) =>
          readSiteVisitors({
            env: c.env,
            siteId: input.siteId,
            search: input.search,
            sort: input.sort,
            page: input.page,
            filters: input.filters,
            window: {
              startMs: input.startMs,
              endExclusiveMs: input.endExclusiveMs,
              timeZone: input.timeZone,
              nowMs: Date.now(),
            },
          }),
      ),
      { signal: c.req.raw.signal, capturedAtMs: Date.now() },
      createAnalysisDefinitionReader(c.env, deps.resolvePrincipal(c)),
    );
  });
  routes.post("/sites/:siteId/analytics/sessions/search", (c) => {
    const siteId = c.req.param("siteId");
    if (!siteId) return deps.resourceNotFound(c);
    return handlePlannedSiteSessionsSearch(
      c.req.raw,
      deps.resolvePrincipal(c),
      siteId,
      createReaderProviderRegistry<SiteSessionsSearchReader>(
        "site.analytics.sessionsSearch",
        (input) =>
          readSiteSessions({
            env: c.env,
            siteId: input.siteId,
            search: input.search,
            sort: input.sort,
            page: input.page,
            filters: input.filters,
            window: {
              startMs: input.startMs,
              endExclusiveMs: input.endExclusiveMs,
              timeZone: input.timeZone,
              nowMs: Date.now(),
            },
          }),
      ),
      { signal: c.req.raw.signal, capturedAtMs: Date.now() },
      createAnalysisDefinitionReader(c.env, deps.resolvePrincipal(c)),
    );
  });
  routes.post("/sites/:siteId/analytics/visitors/events", (c) => {
    const siteId = c.req.param("siteId");
    if (!siteId) return deps.resourceNotFound(c);
    return handlePlannedSiteVisitorEvents(
      c.req.raw,
      deps.resolvePrincipal(c),
      siteId,
      createReaderProviderRegistry<SiteVisitorEventsReader>(
        "site.analytics.visitorEvents",
        (input) =>
          readSiteVisitorEvents({
            env: c.env,
            siteId: input.siteId,
            visitorId: input.visitorId,
            limit: input.limit,
            page: { limit: input.limit },
            filters: input.filters,
            window: {
              startMs: input.startMs,
              endExclusiveMs: input.endExclusiveMs,
              timeZone: input.timeZone,
              nowMs: Date.now(),
            },
          }),
      ),
      { signal: c.req.raw.signal, capturedAtMs: Date.now() },
      createAnalysisDefinitionReader(c.env, deps.resolvePrincipal(c)),
    );
  });
  routes.post("/sites/:siteId/analytics/visitors/sessions", (c) => {
    const siteId = c.req.param("siteId");
    if (!siteId) return deps.resourceNotFound(c);
    return handlePlannedSiteVisitorSessions(
      c.req.raw,
      deps.resolvePrincipal(c),
      siteId,
      createReaderProviderRegistry<SiteVisitorSessionsReader>(
        "site.analytics.visitorSessions",
        (input) =>
          readSiteVisitorSessions({
            env: c.env,
            siteId: input.siteId,
            visitorId: input.visitorId,
            limit: input.limit,
            page: { limit: input.limit },
            filters: input.filters,
            window: {
              startMs: input.startMs,
              endExclusiveMs: input.endExclusiveMs,
              timeZone: input.timeZone,
              nowMs: Date.now(),
            },
          }),
      ),
      { signal: c.req.raw.signal, capturedAtMs: Date.now() },
      createAnalysisDefinitionReader(c.env, deps.resolvePrincipal(c)),
    );
  });
  routes.post("/sites/:siteId/analytics/sessions/events", (c) => {
    const siteId = c.req.param("siteId");
    if (!siteId) return deps.resourceNotFound(c);
    return handlePlannedSiteSessionEvents(
      c.req.raw,
      deps.resolvePrincipal(c),
      siteId,
      createReaderProviderRegistry<SiteSessionEventsReader>(
        "site.analytics.sessionEvents",
        (input) =>
          readSiteSessionEvents({
            env: c.env,
            siteId: input.siteId,
            sessionId: input.sessionId,
            limit: input.limit,
            page: { limit: input.limit },
            filters: input.filters,
            window: {
              startMs: input.startMs,
              endExclusiveMs: input.endExclusiveMs,
              timeZone: input.timeZone,
              nowMs: Date.now(),
            },
          }),
      ),
      { signal: c.req.raw.signal, capturedAtMs: Date.now() },
      createAnalysisDefinitionReader(c.env, deps.resolvePrincipal(c)),
    );
  });
}
