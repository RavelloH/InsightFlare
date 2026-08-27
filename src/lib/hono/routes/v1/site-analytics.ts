import type { Context } from "hono";
import type { Hono } from "hono";

import { createAnalysisDefinitionReader } from "@/lib/api-v1/analysis-definition-reader";
import { handlePlannedSiteAnalyticsSchema } from "@/lib/api-v1/analytics-schema-handler";
import {
  handleSiteComparison,
  handleSiteComparisonBreakdown,
} from "@/lib/api-v1/comparison-handler";
import { SitePerformanceBreakdownDimensionSchema } from "@/lib/api-v1/dto/analytics";
import { handlePlannedSiteFunnelAnalysis } from "@/lib/api-v1/funnel-analysis-handler";
import { handlePlannedSiteOverview } from "@/lib/api-v1/overview-handler";
import { handlePlannedSavedFilters } from "@/lib/api-v1/saved-filters-handler";
import { handlePlannedSiteBreakdown } from "@/lib/api-v1/site-breakdown-handler";
import { handlePlannedSiteCrossBreakdown } from "@/lib/api-v1/site-cross-breakdown-handler";
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
  handlePlannedSiteJourneyEventDetail,
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
} from "@/lib/api-v1/site-list-handler";
import { handlePlannedSiteTimeseries } from "@/lib/api-v1/timeseries-handler";
import { jsonError } from "@/lib/api-v1/wire-helpers";
import type { AnalyticsOperationId } from "@/lib/edge/analytics/application/operation-registry";
import { createApiV1ProviderRegistry } from "@/lib/edge/analytics/composition/api-v1-provider-registry";
import type { ApiKeyPrincipal } from "@/lib/edge/api-key-auth";
import type { AppEnv } from "@/lib/hono/types";

interface SiteAnalyticsRouteDependencies {
  readonly resolvePrincipal: (c: Context<AppEnv>) => ApiKeyPrincipal;
  readonly resourceNotFound: (c: Context<AppEnv>) => Response;
}

function providerRegistry(
  c: Context<AppEnv>,
  operation: AnalyticsOperationId,
  performanceDimension?: string,
) {
  return createApiV1ProviderRegistry({
    env: c.env,
    siteId: c.req.param("siteId") ?? "",
    operation,
    performanceDimension,
  });
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
      providerRegistry(c, "site.analytics.overview"),
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
      providerRegistry(c, "site.analytics.timeseries"),
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
      providerRegistry(c, "site.analytics.breakdown"),
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
      providerRegistry(c, "site.analytics.crossBreakdown"),
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
      providerRegistry(c, "site.analytics.pages"),
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
      providerRegistry(c, "site.analytics.referrers"),
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
      providerRegistry(c, "site.analytics.channels"),
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
      providerRegistry(c, "site.analytics.filterValues"),
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
      providerRegistry(c, "site.analytics.retentionCohorts"),
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
      providerRegistry(c, "site.analytics.funnelAnalysis"),
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
      providerRegistry(c, "site.analytics.performanceSummary"),
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
      providerRegistry(c, "site.analytics.performanceTimeseries"),
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
        providerRegistry(
          c,
          "site.analytics.performanceBreakdown",
          parsedDimension.data,
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
      providerRegistry(c, "site.analytics.eventsSummary"),
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
      providerRegistry(c, "site.analytics.eventsTimeseries"),
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
      providerRegistry(c, "site.analytics.eventTypes"),
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
      providerRegistry(c, "site.analytics.eventTypeDetail"),
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
      providerRegistry(c, "site.analytics.eventFields"),
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
      providerRegistry(c, "site.analytics.eventFieldValues"),
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
      providerRegistry(c, "site.analytics.eventsSearch"),
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
      providerRegistry(c, "site.analytics.eventDetail"),
      { signal: c.req.raw.signal, capturedAtMs: Date.now() },
    );
  });
  routes.post("/sites/:siteId/analytics/journey-events/detail", (c) => {
    const siteId = c.req.param("siteId");
    if (!siteId) return deps.resourceNotFound(c);
    return handlePlannedSiteJourneyEventDetail(
      c.req.raw,
      deps.resolvePrincipal(c),
      siteId,
      providerRegistry(c, "site.analytics.journeyEventDetail"),
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
      providerRegistry(c, "site.analytics.realtimeSnapshot"),
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
      providerRegistry(c, "site.analytics.realtimeActiveVisitors"),
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
      providerRegistry(c, "site.analytics.realtimeEvents"),
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
      providerRegistry(c, "site.analytics.realtimeSessions"),
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
      providerRegistry(c, "site.analytics.visitorDetail"),
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
      providerRegistry(c, "site.analytics.sessionDetail"),
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
      providerRegistry(c, "site.analytics.visitorsSearch"),
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
      providerRegistry(c, "site.analytics.sessionsSearch"),
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
      providerRegistry(c, "site.analytics.visitorEvents"),
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
      providerRegistry(c, "site.analytics.visitorSessions"),
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
      providerRegistry(c, "site.analytics.sessionEvents"),
      { signal: c.req.raw.signal, capturedAtMs: Date.now() },
      createAnalysisDefinitionReader(c.env, deps.resolvePrincipal(c)),
    );
  });
}
