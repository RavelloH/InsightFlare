import { describe, expect, it } from "vitest";

import {
  assertSavedFilterDocument,
  GetTeamVisibleSavedFilterInputSchema,
  ListTeamVisibleSavedFiltersInputSchema,
  SavedFilterDefinitionSchema,
} from "@/lib/api-v1/application-registry";
import { apiV1CoreRouteRegistry } from "@/lib/api-v1/core-registry";
import {
  apiV1AnalyticsBreakdownRouteRegistry,
  apiV1AnalyticsComparisonRouteRegistry,
  apiV1AnalyticsCrossBreakdownRouteRegistry,
  apiV1AnalyticsEventRecordsRouteRegistry,
  apiV1AnalyticsEventsRouteRegistry,
  apiV1AnalyticsEventTypesRouteRegistry,
  apiV1AnalyticsFilterValuesRouteRegistry,
  apiV1AnalyticsFunnelAnalysisRouteRegistry,
  apiV1AnalyticsJourneyDetailsRouteRegistry,
  apiV1AnalyticsJourneySearchRouteRegistry,
  apiV1AnalyticsJourneyTrajectoryRouteRegistry,
  apiV1AnalyticsListRouteRegistry,
  apiV1AnalyticsPerformanceRouteRegistry,
  apiV1AnalyticsRealtimeRouteRegistry,
  apiV1AnalyticsRetentionRouteRegistry,
  apiV1AnalyticsRouteById,
  apiV1AnalyticsRouteRegistry,
  apiV1AnalyticsSchemaRouteRegistry,
  apiV1AnalyticsTeamBreakdownRouteRegistry,
  apiV1AnalyticsTeamSitesRouteRegistry,
  apiV1AnalyticsTimeseriesRouteRegistry,
  apiV1ApplicationRouteById,
  apiV1ApplicationRouteRegistry,
  apiV1BatchEligibleRouteIds,
  apiV1BatchRouteById,
  apiV1NonBatchRouteRegistry,
  apiV1RouteById,
  apiV1RouteRegistry,
  apiV1RouteVariantIds,
  isApiV1BatchEligible,
  isApiV1RouteVariantId,
} from "@/lib/api-v1/route-registry";
import {
  analyticsOperationById,
  analyticsOperationRegistry,
} from "@/lib/edge/analytics/application/operation-registry";

describe("target API v1 route registry", () => {
  it("keeps the batch allow-list explicit and read-only", () => {
    expect(apiV1BatchEligibleRouteIds).toContain("site.analytics.eventsSearch");
    expect(apiV1BatchEligibleRouteIds).toContain("site.saved-filters.list");
    expect(apiV1BatchEligibleRouteIds).not.toContain("batch");
    expect(apiV1BatchEligibleRouteIds).not.toContain("sites.create");
    for (const routeId of apiV1BatchEligibleRouteIds) {
      expect(apiV1RouteRegistry.some((route) => route.id === routeId)).toBe(
        true,
      );
    }
    expect(
      apiV1RouteRegistry
        .filter((route) => isApiV1BatchEligible(route.id))
        .every((route) => route.method === "GET" || route.method === "POST"),
    ).toBe(true);
  });
  it("revalidates saved-filter documents through the canonical filter registry", () => {
    expect(() =>
      assertSavedFilterDocument({ version: 1, root: null }),
    ).not.toThrow();
    expect(() =>
      assertSavedFilterDocument({ version: 2, root: null } as never),
    ).toThrow("unsupported_filter_version");
    expect(() =>
      assertSavedFilterDocument({
        version: 1,
        root: {
          kind: "condition",
          target: { kind: "field", field: "page.path" as never },
          operator: "eq",
          value: "/docs",
        },
      }),
    ).not.toThrow();
  });
  it("keeps each planned route bound to one known analytics operation", () => {
    expect(apiV1AnalyticsRouteRegistry).toHaveLength(2);
    for (const route of apiV1AnalyticsRouteRegistry) {
      expect(analyticsOperationById(route.operationId)).toBeDefined();
      expect(route.lifecycle).toBe("exposed");
      expect(route.method).toBe("POST");
      expect(route.path).toMatch(
        /^\/api\/v1\/(?:sites\/\{siteId\}|team)\/analytics\/overview$/u,
      );
    }
  });

  it("includes the planned site and team analytics schema catalog routes", () => {
    expect(apiV1AnalyticsSchemaRouteRegistry).toHaveLength(2);
    expect(apiV1AnalyticsSchemaRouteRegistry).toMatchObject([
      {
        id: "site.analytics.schema",
        method: "GET",
        path: "/api/v1/sites/{siteId}/analytics/schema",
        lifecycle: "exposed",
      },
      {
        id: "team.analytics.schema",
        method: "GET",
        path: "/api/v1/team/analytics/schema",
        lifecycle: "exposed",
      },
    ]);
  });

  it("includes the planned typed site and team timeseries routes", () => {
    expect(apiV1AnalyticsTimeseriesRouteRegistry).toHaveLength(2);
    expect(apiV1AnalyticsTimeseriesRouteRegistry).toMatchObject([
      {
        id: "site.analytics.timeseries",
        method: "POST",
        path: "/api/v1/sites/{siteId}/analytics/timeseries",
        lifecycle: "exposed",
      },
      {
        id: "team.analytics.timeseries",
        method: "POST",
        path: "/api/v1/team/analytics/timeseries",
        lifecycle: "exposed",
      },
    ]);
  });

  it("keeps team sites as an independent planned composite operation", () => {
    expect(apiV1AnalyticsTeamSitesRouteRegistry).toEqual([
      expect.objectContaining({
        id: "team.analytics.sites",
        method: "POST",
        path: "/api/v1/team/analytics/sites",
        lifecycle: "exposed",
        operationId: "team.analytics.sites",
      }),
    ]);
  });

  it("keeps site breakdown as a path-dimension query with saved-filter scope gating", () => {
    expect(apiV1AnalyticsBreakdownRouteRegistry).toEqual([
      expect.objectContaining({
        id: "site.analytics.breakdown",
        method: "POST",
        path: "/api/v1/sites/{siteId}/analytics/breakdowns/{dimension}",
        lifecycle: "exposed",
        operationId: "site.analytics.breakdown",
        conditionalScopes: [
          {
            when: "filter.type=saved",
            scopes: ["analytics:read", "analysis:read"],
          },
        ],
      }),
    ]);
  });

  it("keeps site cross-breakdown as an independent saved-filter-gated query", () => {
    expect(apiV1AnalyticsCrossBreakdownRouteRegistry).toEqual([
      expect.objectContaining({
        id: "site.analytics.crossBreakdown",
        method: "POST",
        path: "/api/v1/sites/{siteId}/analytics/cross-breakdowns",
        lifecycle: "exposed",
        operationId: "site.analytics.crossBreakdown",
        declaredErrors: expect.arrayContaining(["dimension_not_supported"]),
        conditionalScopes: [
          {
            when: "filter.type=saved",
            scopes: ["analytics:read", "analysis:read"],
          },
        ],
      }),
    ]);
  });

  it("keeps page and referrer composites separate from generic breakdowns", () => {
    expect(apiV1AnalyticsListRouteRegistry).toMatchObject([
      {
        id: "site.analytics.pages",
        path: "/api/v1/sites/{siteId}/analytics/pages",
        operationId: "site.analytics.pages",
      },
      {
        id: "site.analytics.referrers",
        path: "/api/v1/sites/{siteId}/analytics/referrers",
        operationId: "site.analytics.referrers",
      },
      {
        id: "site.analytics.channels",
        path: "/api/v1/sites/{siteId}/analytics/channels",
        operationId: "site.analytics.channels",
      },
    ]);
  });

  it("keeps filter values as a field-in-body query with saved-filter gating", () => {
    expect(apiV1AnalyticsFilterValuesRouteRegistry).toMatchObject([
      {
        id: "site.analytics.filterValues",
        path: "/api/v1/sites/{siteId}/analytics/filter-values",
        operationId: "site.analytics.filterValues",
      },
    ]);
  });

  it("keeps retention cohorts as a POST cohort-matrix query", () => {
    expect(apiV1AnalyticsRetentionRouteRegistry).toMatchObject([
      {
        id: "site.analytics.retentionCohorts",
        path: "/api/v1/sites/{siteId}/analytics/retention/cohorts",
        operationId: "site.analytics.retentionCohorts",
        method: "POST",
      },
    ]);
  });

  it("keeps funnel analysis as a typed body-ID operation", () => {
    expect(apiV1AnalyticsFunnelAnalysisRouteRegistry).toEqual([
      expect.objectContaining({
        id: "site.analytics.funnelAnalysis",
        method: "POST",
        path: "/api/v1/sites/{siteId}/analytics/funnel-analysis",
        operationId: "site.analytics.funnelAnalysis",
      }),
    ]);
  });

  it("keeps performance summary and timeseries as separate typed operations", () => {
    expect(apiV1AnalyticsPerformanceRouteRegistry).toMatchObject([
      {
        id: "site.analytics.performanceSummary",
        path: "/api/v1/sites/{siteId}/analytics/performance/summary",
        operationId: "site.analytics.performanceSummary",
      },
      {
        id: "site.analytics.performanceTimeseries",
        path: "/api/v1/sites/{siteId}/analytics/performance/timeseries",
        operationId: "site.analytics.performanceTimeseries",
      },
      {
        id: "site.analytics.performanceBreakdown",
        path: "/api/v1/sites/{siteId}/analytics/performance/breakdowns/{dimension}",
        operationId: "site.analytics.performanceBreakdown",
      },
    ]);
  });

  it("keeps event summary and timeseries as separate saved-filter-gated operations", () => {
    expect(apiV1AnalyticsEventsRouteRegistry).toMatchObject([
      {
        id: "site.analytics.eventsSummary",
        path: "/api/v1/sites/{siteId}/analytics/events/summary",
        operationId: "site.analytics.eventsSummary",
        conditionalScopes: [
          {
            when: "filter.type=saved",
            scopes: ["analytics:read", "analysis:read"],
          },
        ],
      },
      {
        id: "site.analytics.eventsTimeseries",
        path: "/api/v1/sites/{siteId}/analytics/events/timeseries",
        operationId: "site.analytics.eventsTimeseries",
      },
    ]);
  });

  it("keeps event search and opaque detail IDs in POST bodies", () => {
    expect(apiV1AnalyticsEventRecordsRouteRegistry).toMatchObject([
      {
        id: "site.analytics.eventsSearch",
        path: "/api/v1/sites/{siteId}/analytics/events/search",
        operationId: "site.analytics.eventsSearch",
      },
      {
        id: "site.analytics.eventDetail",
        path: "/api/v1/sites/{siteId}/analytics/events/detail",
        operationId: "site.analytics.eventDetail",
      },
    ]);
  });

  it("keeps event types, opaque names, fields, and values as separate POST operations", () => {
    expect(apiV1AnalyticsEventTypesRouteRegistry).toMatchObject([
      {
        id: "site.analytics.eventTypes",
        path: "/api/v1/sites/{siteId}/analytics/event-types",
        operationId: "site.analytics.eventTypes",
      },
      {
        id: "site.analytics.eventTypeDetail",
        path: "/api/v1/sites/{siteId}/analytics/event-types/detail",
        operationId: "site.analytics.eventTypeDetail",
      },
      {
        id: "site.analytics.eventFields",
        path: "/api/v1/sites/{siteId}/analytics/event-types/fields",
        operationId: "site.analytics.eventFields",
      },
      {
        id: "site.analytics.eventFieldValues",
        path: "/api/v1/sites/{siteId}/analytics/event-types/field-values",
        operationId: "site.analytics.eventFieldValues",
      },
    ]);
    for (const route of apiV1AnalyticsEventTypesRouteRegistry) {
      expect(route.method).toBe("POST");
      expect(route.conditionalScopes).toEqual([
        {
          when: "filter.type=saved",
          scopes: ["analytics:read", "analysis:read"],
        },
      ]);
    }
  });

  it("keeps visitor and session opaque IDs in window-scoped detail bodies", () => {
    expect(apiV1AnalyticsJourneyDetailsRouteRegistry).toMatchObject([
      {
        id: "site.analytics.visitorDetail",
        path: "/api/v1/sites/{siteId}/analytics/visitors/detail",
        operationId: "site.analytics.visitorDetail",
      },
      {
        id: "site.analytics.sessionDetail",
        path: "/api/v1/sites/{siteId}/analytics/sessions/detail",
        operationId: "site.analytics.sessionDetail",
      },
      {
        id: "site.analytics.journeyEventDetail",
        path: "/api/v1/sites/{siteId}/analytics/journey-events/detail",
        operationId: "site.analytics.journeyEventDetail",
      },
    ]);
  });

  it("keeps visitor and session searches separate and saved-filter gated", () => {
    expect(apiV1AnalyticsJourneySearchRouteRegistry).toMatchObject([
      {
        id: "site.analytics.visitorsSearch",
        path: "/api/v1/sites/{siteId}/analytics/visitors/search",
        operationId: "site.analytics.visitorsSearch",
      },
      {
        id: "site.analytics.sessionsSearch",
        path: "/api/v1/sites/{siteId}/analytics/sessions/search",
        operationId: "site.analytics.sessionsSearch",
      },
    ]);
  });

  it("keeps visitor and session trajectories separate and saved-filter gated", () => {
    expect(apiV1AnalyticsJourneyTrajectoryRouteRegistry).toMatchObject([
      {
        id: "site.analytics.visitorEvents",
        path: "/api/v1/sites/{siteId}/analytics/visitors/events",
        operationId: "site.analytics.visitorEvents",
      },
      {
        id: "site.analytics.visitorSessions",
        path: "/api/v1/sites/{siteId}/analytics/visitors/sessions",
        operationId: "site.analytics.visitorSessions",
      },
      {
        id: "site.analytics.sessionEvents",
        path: "/api/v1/sites/{siteId}/analytics/sessions/events",
        operationId: "site.analytics.sessionEvents",
      },
    ]);
    for (const route of apiV1AnalyticsJourneyTrajectoryRouteRegistry) {
      expect(route.conditionalScopes).toEqual([
        {
          when: "filter.type=saved",
          scopes: ["analytics:read", "analysis:read"],
        },
      ]);
    }
  });

  it("keeps realtime queries as distinct POST cache-bypass operations", () => {
    expect(apiV1AnalyticsRealtimeRouteRegistry).toMatchObject([
      {
        id: "site.analytics.realtimeSnapshot",
        path: "/api/v1/sites/{siteId}/analytics/realtime/snapshot",
      },
      {
        id: "site.analytics.realtimeActiveVisitors",
        path: "/api/v1/sites/{siteId}/analytics/realtime/active-visitors",
      },
      {
        id: "site.analytics.realtimeEvents",
        path: "/api/v1/sites/{siteId}/analytics/realtime/events",
      },
      {
        id: "site.analytics.realtimeSessions",
        path: "/api/v1/sites/{siteId}/analytics/realtime/sessions",
      },
    ]);
    for (const route of apiV1AnalyticsRealtimeRouteRegistry)
      expect(route.method).toBe("POST");
  });

  it("does not contain an unreferenced target operation", () => {
    const referenced = new Set(
      [
        ...apiV1AnalyticsRouteRegistry,
        ...apiV1AnalyticsComparisonRouteRegistry,
        ...apiV1AnalyticsTimeseriesRouteRegistry,
        ...apiV1AnalyticsTeamSitesRouteRegistry,
        ...apiV1AnalyticsTeamBreakdownRouteRegistry,
        ...apiV1AnalyticsBreakdownRouteRegistry,
        ...apiV1AnalyticsCrossBreakdownRouteRegistry,
        ...apiV1AnalyticsListRouteRegistry,
        ...apiV1AnalyticsFilterValuesRouteRegistry,
        ...apiV1AnalyticsRetentionRouteRegistry,
        ...apiV1AnalyticsFunnelAnalysisRouteRegistry,
        ...apiV1AnalyticsPerformanceRouteRegistry,
        ...apiV1AnalyticsEventsRouteRegistry,
        ...apiV1AnalyticsEventRecordsRouteRegistry,
        ...apiV1AnalyticsEventTypesRouteRegistry,
        ...apiV1AnalyticsJourneyDetailsRouteRegistry,
        ...apiV1AnalyticsJourneySearchRouteRegistry,
        ...apiV1AnalyticsJourneyTrajectoryRouteRegistry,
        ...apiV1AnalyticsRealtimeRouteRegistry,
      ].map((route) => route.operationId),
    );
    expect(
      analyticsOperationRegistry.map((operation) => operation.id).sort(),
    ).toEqual([...referenced].sort());
    expect(apiV1AnalyticsRouteById("site.analytics.overview")).toBeDefined();
    expect(apiV1AnalyticsRouteById("team.analytics.overview")).toBeDefined();
    expect(
      apiV1AnalyticsRouteById("site.analytics.realtimeEvents"),
    ).toMatchObject({
      path: "/api/v1/sites/{siteId}/analytics/realtime/events",
    });
    expect(apiV1AnalyticsRouteById("site.saved-filters.list")).toBeUndefined();
    expect(apiV1AnalyticsRouteById("does-not-exist")).toBeUndefined();
  });

  it("keeps each analytics operation result callback executable", () => {
    for (const operation of analyticsOperationRegistry) {
      (operation.result as (value: never) => void)({} as never);
    }
  });

  it("includes planned saved-filter collection and item contracts", () => {
    expect(apiV1ApplicationRouteRegistry).toHaveLength(19);
    expect(apiV1RouteRegistry).toHaveLength(69);
    expect(
      apiV1ApplicationRouteRegistry
        .filter((route) => route.id.startsWith("site.saved-filters."))
        .map((route) => route.operationId),
    ).toEqual(["savedFilters.list", "savedFilters.get"]);
    for (const route of apiV1ApplicationRouteRegistry.filter((route) =>
      route.id.startsWith("site.saved-filters."),
    )) {
      expect(route.lifecycle).toBe("exposed");
      expect(route.method).toBe("GET");
      expect(route.scopes).toEqual(["analysis:read"]);
    }
  });

  it("describes root, token, capabilities, and team discovery in the registry", () => {
    expect(apiV1CoreRouteRegistry.map((route) => route.id)).toEqual([
      "core.root",
      "core.token.get",
      "core.token.check",
      "core.capabilities",
      "core.team.get",
      "core.team.usage",
    ]);
    for (const route of apiV1CoreRouteRegistry) {
      expect(route.lifecycle).toBe("exposed");
      expect(route.requestSchema).toBeDefined();
      expect(route.responseSchema).toBeDefined();
    }
  });

  it("keeps application and batch lookups separated from the child graph", () => {
    expect(apiV1ApplicationRouteById("site.saved-filters.list")).toMatchObject({
      operationId: "savedFilters.list",
    });
    expect(apiV1ApplicationRouteById("batch")).toBeUndefined();
    expect(apiV1BatchRouteById("batch")).toMatchObject({
      path: "/api/v1/batch",
    });
    expect(apiV1BatchRouteById("site.saved-filters.list")).toBeUndefined();
    expect(apiV1NonBatchRouteRegistry).toHaveLength(
      apiV1RouteRegistry.length - 1,
    );
    expect(
      apiV1NonBatchRouteRegistry.some((route) => String(route.id) === "batch"),
    ).toBe(false);
  });

  it("returns undefined for an unknown canonical route id", () => {
    expect(apiV1RouteById("missing.route")).toBeUndefined();
  });

  it("exposes only stable comparison route variant IDs", () => {
    expect(isApiV1RouteVariantId("explicit")).toBe(true);
    expect(isApiV1RouteVariantId("unknown")).toBe(false);
    expect(
      apiV1RouteVariantIds(apiV1RouteById("site.analytics.comparison")!),
    ).toEqual(["default"]);
    expect(apiV1RouteVariantIds({})).toEqual(["default"]);
  });

  it("keeps saved-filter application schemas strict and owner-free", () => {
    expect(
      ListTeamVisibleSavedFiltersInputSchema.safeParse({
        siteId: "site-1",
        limit: 20,
        cursor: null,
        unexpected: true,
      }).success,
    ).toBe(false);
    expect(
      GetTeamVisibleSavedFilterInputSchema.safeParse({
        siteId: "site-1",
        id: "filter-1",
      }).success,
    ).toBe(true);
    expect(
      SavedFilterDefinitionSchema.safeParse({
        id: "filter-1",
        name: "Team filter",
        description: "",
        visibility: "team",
        filter: { version: 1, root: null },
        createdAt: "2026-08-01T00:00:00.000Z",
        updatedAt: "2026-08-01T00:00:00.000Z",
        ownerUserId: "user-1",
      }).success,
    ).toBe(false);
  });
});
