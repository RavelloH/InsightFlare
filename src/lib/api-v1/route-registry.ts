import { z } from "zod";

import {
  type ApiV1ApplicationOperationId,
  CreateFunnelInputSchema,
  CreateSiteInputSchema,
  DeleteSiteInputSchema,
  FunnelResourceSchema,
  GetFunnelInputSchema,
  GetSiteInputSchema,
  GetTeamVisibleSavedFilterInputSchema,
  ListSitesInputSchema,
  ListTeamVisibleSavedFiltersInputSchema,
  PrivacySettingsSchema,
  SavedFilterDefinitionSchema,
  SavedFilterPageSchema,
  SharingSettingsSchema,
  SiteResourceSchema,
  SiteSettingsInputSchema,
  TrackingScriptSchema,
  TrackingSettingsSchema,
  UpdateFunnelInputSchema,
  UpdatePrivacySettingsInputSchema,
  UpdateSharingSettingsInputSchema,
  UpdateSiteInputSchema,
  UpdateTrackingSettingsInputSchema,
} from "@/lib/api-v1/application-registry";
import { apiV1CoreRouteRegistry } from "@/lib/api-v1/core-registry";
import {
  SiteBreakdownQueryDtoSchema,
  SiteComparisonBreakdownQueryDtoSchema,
  SiteComparisonTimeseriesQueryDtoSchema,
  SiteCrossBreakdownQueryDtoSchema,
  SiteEventDetailQueryDtoSchema,
  SiteEventFieldsQueryDtoSchema,
  SiteEventFieldValuesQueryDtoSchema,
  SiteEventsSearchQueryDtoSchema,
  SiteEventsSummaryQueryDtoSchema,
  SiteEventsTimeseriesQueryDtoSchema,
  SiteEventTypeDetailQueryDtoSchema,
  SiteEventTypesQueryDtoSchema,
  SiteFilterValuesQueryDtoSchema,
  SiteFunnelAnalysisQueryDtoSchema,
  SiteOverviewComparisonQueryDtoSchema,
  SiteOverviewQueryDtoSchema,
  SitePagesQueryDtoSchema,
  SitePerformanceBreakdownDimensionSchema,
  SitePerformanceBreakdownQueryDtoSchema,
  SitePerformanceSummaryQueryDtoSchema,
  SitePerformanceTimeseriesQueryDtoSchema,
  SiteRealtimeActiveVisitorsQueryDtoSchema,
  SiteRealtimeEventsQueryDtoSchema,
  SiteRealtimeSessionsQueryDtoSchema,
  SiteRealtimeSnapshotQueryDtoSchema,
  SiteReferrersQueryDtoSchema,
  SiteRetentionCohortsQueryDtoSchema,
  SiteSessionDetailQueryDtoSchema,
  SiteSessionEventsQueryDtoSchema,
  SiteSessionsSearchQueryDtoSchema,
  SiteTimeseriesQueryDtoSchema,
  SiteVisitorDetailQueryDtoSchema,
  SiteVisitorEventsQueryDtoSchema,
  SiteVisitorSessionsQueryDtoSchema,
  SiteVisitorsSearchQueryDtoSchema,
  TeamBreakdownQueryDtoSchema,
  TeamComparisonBreakdownQueryDtoSchema,
  TeamComparisonOverviewQueryDtoSchema,
  TeamComparisonTimeseriesQueryDtoSchema,
  TeamOverviewQueryDtoSchema,
  TeamSitesQueryDtoSchema,
  TeamTimeseriesQueryDtoSchema,
} from "@/lib/api-v1/dto/analytics";
import { TypedBatchRequestSchema } from "@/lib/api-v1/dto/batch";
import type { ApiV1ErrorCode } from "@/lib/api-v1/errors";
import {
  AnalyticsBreakdownResponseSchema,
  AnalyticsComparisonBreakdownResponseSchema,
  AnalyticsComparisonOverviewResponseSchema,
  AnalyticsComparisonTimeseriesResponseSchema,
  AnalyticsCrossBreakdownResponseSchema,
  AnalyticsEventDetailResponseSchema,
  AnalyticsEventFieldsResponseSchema,
  AnalyticsEventFieldValuesResponseSchema,
  AnalyticsEventsSearchResponseSchema,
  AnalyticsEventsSummaryResponseSchema,
  AnalyticsEventsTimeseriesResponseSchema,
  AnalyticsEventTypeDetailResponseSchema,
  AnalyticsEventTypesResponseSchema,
  AnalyticsFilterValuesResponseSchema,
  AnalyticsFunnelAnalysisResponseSchema,
  AnalyticsJourneyEventsResponseSchema,
  AnalyticsJourneySessionsResponseSchema,
  AnalyticsOverviewResponseSchema,
  AnalyticsPagesResponseSchema,
  AnalyticsPerformanceBreakdownResponseSchema,
  AnalyticsPerformanceSummaryResponseSchema,
  AnalyticsPerformanceTimeseriesResponseSchema,
  AnalyticsRealtimeActiveVisitorsResponseSchema,
  AnalyticsRealtimeEventsResponseSchema,
  AnalyticsRealtimeSessionsResponseSchema,
  AnalyticsRealtimeSnapshotResponseSchema,
  AnalyticsReferrersResponseSchema,
  AnalyticsRetentionCohortsResponseSchema,
  AnalyticsSchemaResponseSchema,
  AnalyticsSessionDetailResponseSchema,
  AnalyticsSessionsSearchResponseSchema,
  AnalyticsTimeseriesResponseSchema,
  AnalyticsVisitorDetailResponseSchema,
  AnalyticsVisitorsSearchResponseSchema,
  TeamAnalyticsSitesResponseSchema,
  TypedBatchResponseSchema,
} from "@/lib/api-v1/wire";
import {
  analyticsOperationById,
  type AnalyticsOperationId,
} from "@/lib/edge/analytics/operation-registry";

export type ApiV1RouteLifecycle = "planned" | "exposed";
export type ApiV1HttpMethod = "GET" | "POST" | "PATCH" | "DELETE";

export interface ApiV1AnalyticsRouteDescriptor<Id extends string> {
  readonly id: Id;
  readonly lifecycle: ApiV1RouteLifecycle;
  readonly method: ApiV1HttpMethod;
  readonly path: string;
  readonly operationId: AnalyticsOperationId;
  readonly scopes: readonly string[];
  readonly conditionalScopes?: readonly {
    readonly when:
      | "filter.type=saved"
      | "a.filter.type=saved|b.filter.type=saved";
    readonly scopes: readonly string[];
  }[];
  readonly requestSchema:
    | typeof SiteOverviewQueryDtoSchema
    | typeof TeamOverviewQueryDtoSchema;
  readonly responseSchema: typeof AnalyticsOverviewResponseSchema;
  readonly declaredErrors: readonly ApiV1ErrorCode[];
}

export interface ApiV1AnalyticsSchemaRouteDescriptor<Id extends string> {
  readonly id: Id;
  readonly lifecycle: ApiV1RouteLifecycle;
  readonly method: "GET";
  readonly path: string;
  readonly scopes: readonly string[];
  readonly responseSchema: typeof AnalyticsSchemaResponseSchema;
  readonly declaredErrors: readonly [
    "missing_scope",
    "resource_not_found",
    "validation_failed",
    "internal_error",
    "method_not_allowed",
  ];
}

export interface ApiV1AnalyticsComparisonRouteDescriptor<Id extends string> {
  readonly id: Id;
  readonly lifecycle: ApiV1RouteLifecycle;
  readonly method: "POST";
  readonly path: string;
  readonly operationId:
    | "site.analytics.comparisonOverview"
    | "site.analytics.comparisonTimeseries"
    | "site.analytics.comparisonBreakdown"
    | "team.analytics.comparisonOverview"
    | "team.analytics.comparisonTimeseries"
    | "team.analytics.comparisonBreakdown";
  readonly variants:
    | readonly ["previous-period", "explicit"]
    | readonly ["explicit"];
  readonly scopes: readonly string[];
  readonly conditionalScopes?: ApiV1AnalyticsRouteDescriptor<string>["conditionalScopes"];
  readonly requestSchema:
    | typeof SiteOverviewComparisonQueryDtoSchema
    | typeof SiteComparisonTimeseriesQueryDtoSchema
    | typeof SiteComparisonBreakdownQueryDtoSchema
    | typeof TeamComparisonOverviewQueryDtoSchema
    | typeof TeamComparisonTimeseriesQueryDtoSchema
    | typeof TeamComparisonBreakdownQueryDtoSchema;
  readonly responseSchema:
    | typeof AnalyticsComparisonOverviewResponseSchema
    | typeof AnalyticsComparisonTimeseriesResponseSchema
    | typeof AnalyticsComparisonBreakdownResponseSchema;
  readonly declaredErrors: readonly ApiV1ErrorCode[];
}

export interface ApiV1AnalyticsTimeseriesRouteDescriptor<Id extends string> {
  readonly id: Id;
  readonly lifecycle: ApiV1RouteLifecycle;
  readonly method: "POST";
  readonly path: string;
  readonly scopes: readonly string[];
  readonly conditionalScopes?: ApiV1AnalyticsRouteDescriptor<string>["conditionalScopes"];
  readonly operationId: AnalyticsOperationId;
  readonly requestSchema:
    | typeof SiteTimeseriesQueryDtoSchema
    | typeof TeamTimeseriesQueryDtoSchema;
  readonly responseSchema: typeof AnalyticsTimeseriesResponseSchema;
  readonly declaredErrors: readonly string[];
}

export interface ApiV1AnalyticsTeamSitesRouteDescriptor<Id extends string> {
  readonly id: Id;
  readonly lifecycle: ApiV1RouteLifecycle;
  readonly method: "POST";
  readonly path: string;
  readonly operationId: "team.analytics.sites";
  readonly scopes: readonly string[];
  readonly requestSchema: typeof TeamSitesQueryDtoSchema;
  readonly responseSchema: typeof TeamAnalyticsSitesResponseSchema;
  readonly declaredErrors: readonly string[];
}

export interface ApiV1AnalyticsBreakdownRouteDescriptor<Id extends string> {
  readonly id: Id;
  readonly lifecycle: ApiV1RouteLifecycle;
  readonly method: "POST";
  readonly path: string;
  readonly operationId: AnalyticsOperationId;
  readonly scopes: readonly string[];
  readonly conditionalScopes?: ApiV1AnalyticsRouteDescriptor<string>["conditionalScopes"];
  readonly requestSchema: typeof SiteBreakdownQueryDtoSchema;
  readonly responseSchema: typeof AnalyticsBreakdownResponseSchema;
  readonly declaredErrors: readonly string[];
}

export interface ApiV1AnalyticsTeamBreakdownRouteDescriptor<Id extends string> {
  readonly id: Id;
  readonly lifecycle: ApiV1RouteLifecycle;
  readonly method: "POST";
  readonly path: string;
  readonly operationId: "team.analytics.breakdown";
  readonly scopes: readonly string[];
  readonly requestSchema: typeof TeamBreakdownQueryDtoSchema;
  readonly responseSchema: typeof AnalyticsBreakdownResponseSchema;
  readonly declaredErrors: readonly ApiV1ErrorCode[];
}

export interface ApiV1AnalyticsCrossBreakdownRouteDescriptor<
  Id extends string,
> {
  readonly id: Id;
  readonly lifecycle: ApiV1RouteLifecycle;
  readonly method: "POST";
  readonly path: string;
  readonly operationId: "site.analytics.crossBreakdown";
  readonly scopes: readonly string[];
  readonly conditionalScopes?: ApiV1AnalyticsRouteDescriptor<string>["conditionalScopes"];
  readonly requestSchema: typeof SiteCrossBreakdownQueryDtoSchema;
  readonly responseSchema: typeof AnalyticsCrossBreakdownResponseSchema;
  readonly declaredErrors: readonly string[];
}

export interface ApiV1AnalyticsListRouteDescriptor<Id extends string> {
  readonly id: Id;
  readonly lifecycle: ApiV1RouteLifecycle;
  readonly method: "POST";
  readonly path: string;
  readonly operationId: "site.analytics.pages" | "site.analytics.referrers";
  readonly scopes: readonly string[];
  readonly conditionalScopes?: ApiV1AnalyticsRouteDescriptor<string>["conditionalScopes"];
  readonly requestSchema:
    | typeof SitePagesQueryDtoSchema
    | typeof SiteReferrersQueryDtoSchema;
  readonly responseSchema:
    | typeof AnalyticsPagesResponseSchema
    | typeof AnalyticsReferrersResponseSchema;
  readonly declaredErrors: readonly string[];
}

export interface ApiV1AnalyticsFilterValuesRouteDescriptor<Id extends string> {
  readonly id: Id;
  readonly lifecycle: ApiV1RouteLifecycle;
  readonly method: "POST";
  readonly path: string;
  readonly operationId: "site.analytics.filterValues";
  readonly scopes: readonly string[];
  readonly conditionalScopes?: ApiV1AnalyticsRouteDescriptor<string>["conditionalScopes"];
  readonly requestSchema: typeof SiteFilterValuesQueryDtoSchema;
  readonly responseSchema: typeof AnalyticsFilterValuesResponseSchema;
  readonly declaredErrors: readonly string[];
}

export interface ApiV1AnalyticsRetentionRouteDescriptor<Id extends string> {
  readonly id: Id;
  readonly lifecycle: ApiV1RouteLifecycle;
  readonly method: "POST";
  readonly path: string;
  readonly operationId: "site.analytics.retentionCohorts";
  readonly scopes: readonly string[];
  readonly conditionalScopes?: ApiV1AnalyticsRouteDescriptor<string>["conditionalScopes"];
  readonly requestSchema: typeof SiteRetentionCohortsQueryDtoSchema;
  readonly responseSchema: typeof AnalyticsRetentionCohortsResponseSchema;
  readonly declaredErrors: readonly string[];
}

export interface ApiV1AnalyticsFunnelAnalysisRouteDescriptor<
  Id extends string,
> {
  readonly id: Id;
  readonly lifecycle: ApiV1RouteLifecycle;
  readonly method: "POST";
  readonly path: string;
  readonly operationId: "site.analytics.funnelAnalysis";
  readonly scopes: readonly string[];
  readonly conditionalScopes?: ApiV1AnalyticsRouteDescriptor<string>["conditionalScopes"];
  readonly requestSchema: typeof SiteFunnelAnalysisQueryDtoSchema;
  readonly responseSchema: typeof AnalyticsFunnelAnalysisResponseSchema;
  readonly declaredErrors: readonly string[];
}

export interface ApiV1AnalyticsPerformanceRouteDescriptor<Id extends string> {
  readonly id: Id;
  readonly lifecycle: ApiV1RouteLifecycle;
  readonly method: "POST";
  readonly path: string;
  readonly operationId:
    | "site.analytics.performanceSummary"
    | "site.analytics.performanceTimeseries"
    | "site.analytics.performanceBreakdown";
  readonly scopes: readonly string[];
  readonly conditionalScopes?: ApiV1AnalyticsRouteDescriptor<string>["conditionalScopes"];
  readonly pathParameterSchemas?: Readonly<Record<string, z.ZodType>>;
  readonly requestSchema:
    | typeof SitePerformanceSummaryQueryDtoSchema
    | typeof SitePerformanceTimeseriesQueryDtoSchema
    | typeof SitePerformanceBreakdownQueryDtoSchema;
  readonly responseSchema:
    | typeof AnalyticsPerformanceSummaryResponseSchema
    | typeof AnalyticsPerformanceTimeseriesResponseSchema
    | typeof AnalyticsPerformanceBreakdownResponseSchema;
  readonly declaredErrors: readonly string[];
}

export interface ApiV1AnalyticsEventsRouteDescriptor<Id extends string> {
  readonly id: Id;
  readonly lifecycle: ApiV1RouteLifecycle;
  readonly method: "POST";
  readonly path: string;
  readonly operationId:
    | "site.analytics.eventsSummary"
    | "site.analytics.eventsTimeseries";
  readonly scopes: readonly string[];
  readonly conditionalScopes?: ApiV1AnalyticsRouteDescriptor<string>["conditionalScopes"];
  readonly requestSchema:
    | typeof SiteEventsSummaryQueryDtoSchema
    | typeof SiteEventsTimeseriesQueryDtoSchema;
  readonly responseSchema:
    | typeof AnalyticsEventsSummaryResponseSchema
    | typeof AnalyticsEventsTimeseriesResponseSchema;
  readonly declaredErrors: readonly string[];
}

export interface ApiV1AnalyticsEventRecordsRouteDescriptor<Id extends string> {
  readonly id: Id;
  readonly lifecycle: ApiV1RouteLifecycle;
  readonly method: "POST";
  readonly path: string;
  readonly operationId:
    | "site.analytics.eventsSearch"
    | "site.analytics.eventDetail";
  readonly scopes: readonly string[];
  readonly conditionalScopes?: ApiV1AnalyticsRouteDescriptor<string>["conditionalScopes"];
  readonly requestSchema:
    | typeof SiteEventsSearchQueryDtoSchema
    | typeof SiteEventDetailQueryDtoSchema;
  readonly responseSchema:
    | typeof AnalyticsEventsSearchResponseSchema
    | typeof AnalyticsEventDetailResponseSchema;
  readonly declaredErrors: readonly string[];
}

export interface ApiV1AnalyticsEventTypesRouteDescriptor<Id extends string> {
  readonly id: Id;
  readonly lifecycle: ApiV1RouteLifecycle;
  readonly method: "POST";
  readonly path: string;
  readonly operationId:
    | "site.analytics.eventTypes"
    | "site.analytics.eventTypeDetail"
    | "site.analytics.eventFields"
    | "site.analytics.eventFieldValues";
  readonly scopes: readonly string[];
  readonly conditionalScopes?: ApiV1AnalyticsRouteDescriptor<string>["conditionalScopes"];
  readonly requestSchema:
    | typeof SiteEventTypesQueryDtoSchema
    | typeof SiteEventTypeDetailQueryDtoSchema
    | typeof SiteEventFieldsQueryDtoSchema
    | typeof SiteEventFieldValuesQueryDtoSchema;
  readonly responseSchema:
    | typeof AnalyticsEventTypesResponseSchema
    | typeof AnalyticsEventTypeDetailResponseSchema
    | typeof AnalyticsEventFieldsResponseSchema
    | typeof AnalyticsEventFieldValuesResponseSchema;
  readonly declaredErrors: readonly string[];
}

export interface ApiV1AnalyticsJourneyDetailsRouteDescriptor<
  Id extends string,
> {
  readonly id: Id;
  readonly lifecycle: ApiV1RouteLifecycle;
  readonly method: "POST";
  readonly path: string;
  readonly operationId:
    | "site.analytics.visitorDetail"
    | "site.analytics.sessionDetail";
  readonly scopes: readonly string[];
  readonly requestSchema:
    | typeof SiteVisitorDetailQueryDtoSchema
    | typeof SiteSessionDetailQueryDtoSchema;
  readonly responseSchema:
    | typeof AnalyticsVisitorDetailResponseSchema
    | typeof AnalyticsSessionDetailResponseSchema;
  readonly declaredErrors: readonly string[];
}

export interface ApiV1AnalyticsJourneySearchRouteDescriptor<Id extends string> {
  readonly id: Id;
  readonly lifecycle: ApiV1RouteLifecycle;
  readonly method: "POST";
  readonly path: string;
  readonly operationId:
    | "site.analytics.visitorsSearch"
    | "site.analytics.sessionsSearch";
  readonly scopes: readonly string[];
  readonly conditionalScopes?: ApiV1AnalyticsRouteDescriptor<string>["conditionalScopes"];
  readonly requestSchema:
    | typeof SiteVisitorsSearchQueryDtoSchema
    | typeof SiteSessionsSearchQueryDtoSchema;
  readonly responseSchema:
    | typeof AnalyticsVisitorsSearchResponseSchema
    | typeof AnalyticsSessionsSearchResponseSchema;
  readonly declaredErrors: readonly string[];
}

export interface ApiV1AnalyticsRealtimeRouteDescriptor<Id extends string> {
  readonly id: Id;
  readonly lifecycle: ApiV1RouteLifecycle;
  readonly method: "POST";
  readonly path: string;
  readonly operationId: AnalyticsOperationId;
  readonly scopes: readonly string[];
  readonly requestSchema:
    | typeof SiteRealtimeSnapshotQueryDtoSchema
    | typeof SiteRealtimeActiveVisitorsQueryDtoSchema
    | typeof SiteRealtimeEventsQueryDtoSchema
    | typeof SiteRealtimeSessionsQueryDtoSchema;
  readonly responseSchema:
    | typeof AnalyticsRealtimeSnapshotResponseSchema
    | typeof AnalyticsRealtimeActiveVisitorsResponseSchema
    | typeof AnalyticsRealtimeEventsResponseSchema
    | typeof AnalyticsRealtimeSessionsResponseSchema;
  readonly declaredErrors: readonly string[];
}

export interface ApiV1AnalyticsJourneyTrajectoryRouteDescriptor<
  Id extends string,
> {
  readonly id: Id;
  readonly lifecycle: ApiV1RouteLifecycle;
  readonly method: "POST";
  readonly path: string;
  readonly operationId:
    | "site.analytics.visitorEvents"
    | "site.analytics.visitorSessions"
    | "site.analytics.sessionEvents";
  readonly scopes: readonly string[];
  readonly conditionalScopes?: ApiV1AnalyticsRouteDescriptor<string>["conditionalScopes"];
  readonly requestSchema:
    | typeof SiteVisitorEventsQueryDtoSchema
    | typeof SiteVisitorSessionsQueryDtoSchema
    | typeof SiteSessionEventsQueryDtoSchema;
  readonly responseSchema:
    | typeof AnalyticsJourneyEventsResponseSchema
    | typeof AnalyticsJourneySessionsResponseSchema;
  readonly declaredErrors: readonly string[];
}

export interface ApiV1ApplicationRouteDescriptor<Id extends string> {
  readonly id: Id;
  readonly lifecycle: ApiV1RouteLifecycle;
  readonly method: ApiV1HttpMethod;
  readonly path: string;
  readonly operationId: ApiV1ApplicationOperationId;
  readonly scopes: readonly string[];
  readonly requestSchema: z.ZodType;
  readonly responseSchema: z.ZodType;
  readonly declaredErrors: readonly ApiV1ErrorCode[];
}

export interface ApiV1BatchRouteDescriptor {
  readonly id: "batch";
  readonly lifecycle: ApiV1RouteLifecycle;
  readonly method: "POST";
  readonly path: "/api/v1/batch";
  readonly scopes: readonly ["analytics:read"];
  readonly requestSchema: typeof TypedBatchRequestSchema;
  readonly responseSchema: typeof TypedBatchResponseSchema;
  readonly declaredErrors: readonly [
    "validation_failed",
    "invalid_json",
    "payload_too_large",
    "unsupported_media_type",
    "batch_child_not_allowed",
    "deadline_exceeded",
    "internal_error",
  ];
}

function analyticsRoute<Id extends string>(
  descriptor: ApiV1AnalyticsRouteDescriptor<Id>,
): ApiV1AnalyticsRouteDescriptor<Id> {
  if (!analyticsOperationById(descriptor.operationId)) {
    throw new Error(`Unknown analytics operation: ${descriptor.operationId}`);
  }
  return descriptor;
}

/**
 * Target API v1 routes. Planned entries are not Hono registrations until the
 * consumer and rollout gates recorded in the migration matrix are satisfied.
 */
export const apiV1AnalyticsRouteRegistry = [
  analyticsRoute({
    id: "site.analytics.overview",
    lifecycle: "exposed",
    method: "POST",
    path: "/api/v1/sites/{siteId}/analytics/overview",
    operationId: "site.analytics.overview",
    scopes: ["analytics:read"],
    conditionalScopes: [
      {
        when: "filter.type=saved",
        scopes: ["analytics:read", "analysis:read"],
      },
    ],
    requestSchema: SiteOverviewQueryDtoSchema,
    responseSchema: AnalyticsOverviewResponseSchema,
    declaredErrors: [
      "validation_failed",
      "missing_scope",
      "resource_not_found",
      "data_unavailable",
      "deadline_exceeded",
      "internal_error",
    ],
  }),
  analyticsRoute({
    id: "team.analytics.overview",
    lifecycle: "exposed",
    method: "POST",
    path: "/api/v1/team/analytics/overview",
    operationId: "team.analytics.overview",
    scopes: ["analytics:read"],
    requestSchema: TeamOverviewQueryDtoSchema,
    responseSchema: AnalyticsOverviewResponseSchema,
    declaredErrors: [
      "validation_failed",
      "missing_scope",
      "resource_not_found",
      "data_unavailable",
      "deadline_exceeded",
      "internal_error",
      "method_not_allowed",
      "not_acceptable",
      "unsupported_media_type",
    ],
  }),
] as const;

export const apiV1AnalyticsComparisonRouteRegistry = [
  {
    id: "site.analytics.comparisonOverview",
    lifecycle: "exposed",
    method: "POST",
    path: "/api/v1/sites/{siteId}/analytics/comparison/overview",
    operationId: "site.analytics.comparisonOverview",
    variants: ["previous-period", "explicit"],
    scopes: ["analytics:read"],
    conditionalScopes: [
      {
        when: "filter.type=saved",
        scopes: ["analytics:read", "analysis:read"],
      },
    ],
    requestSchema: SiteOverviewComparisonQueryDtoSchema,
    responseSchema: AnalyticsComparisonOverviewResponseSchema,
    declaredErrors: [
      "validation_failed",
      "missing_scope",
      "resource_not_found",
      "unsupported_query",
      "deadline_exceeded",
      "internal_error",
      "method_not_allowed",
      "not_acceptable",
      "unsupported_media_type",
    ],
  },
  {
    id: "site.analytics.comparisonTimeseries",
    lifecycle: "exposed",
    method: "POST",
    path: "/api/v1/sites/{siteId}/analytics/comparison/timeseries",
    operationId: "site.analytics.comparisonTimeseries",
    variants: ["explicit"],
    scopes: ["analytics:read"],
    conditionalScopes: [
      {
        when: "a.filter.type=saved|b.filter.type=saved",
        scopes: ["analytics:read", "analysis:read"],
      },
    ],
    requestSchema: SiteComparisonTimeseriesQueryDtoSchema,
    responseSchema: AnalyticsComparisonTimeseriesResponseSchema,
    declaredErrors: [
      "validation_failed",
      "missing_scope",
      "resource_not_found",
      "unsupported_query",
      "deadline_exceeded",
      "internal_error",
      "method_not_allowed",
      "not_acceptable",
      "unsupported_media_type",
    ],
  },
  {
    id: "site.analytics.comparisonBreakdown",
    lifecycle: "exposed",
    method: "POST",
    path: "/api/v1/sites/{siteId}/analytics/comparison/breakdowns/{dimension}",
    operationId: "site.analytics.comparisonBreakdown",
    variants: ["explicit"],
    scopes: ["analytics:read"],
    conditionalScopes: [
      {
        when: "a.filter.type=saved|b.filter.type=saved",
        scopes: ["analytics:read", "analysis:read"],
      },
    ],
    requestSchema: SiteComparisonBreakdownQueryDtoSchema,
    responseSchema: AnalyticsComparisonBreakdownResponseSchema,
    declaredErrors: [
      "validation_failed",
      "missing_scope",
      "resource_not_found",
      "unsupported_query",
      "deadline_exceeded",
      "internal_error",
      "method_not_allowed",
      "not_acceptable",
      "unsupported_media_type",
    ],
  },
  {
    id: "team.analytics.comparisonOverview",
    lifecycle: "exposed",
    method: "POST",
    path: "/api/v1/team/analytics/comparison/overview",
    operationId: "team.analytics.comparisonOverview",
    variants: ["explicit"],
    scopes: ["analytics:read"],
    requestSchema: TeamComparisonOverviewQueryDtoSchema,
    responseSchema: AnalyticsComparisonOverviewResponseSchema,
    declaredErrors: [
      "validation_failed",
      "missing_scope",
      "unsupported_query",
      "deadline_exceeded",
      "internal_error",
      "method_not_allowed",
      "not_acceptable",
      "unsupported_media_type",
    ],
  },
  {
    id: "team.analytics.comparisonTimeseries",
    lifecycle: "exposed",
    method: "POST",
    path: "/api/v1/team/analytics/comparison/timeseries",
    operationId: "team.analytics.comparisonTimeseries",
    variants: ["explicit"],
    scopes: ["analytics:read"],
    requestSchema: TeamComparisonTimeseriesQueryDtoSchema,
    responseSchema: AnalyticsComparisonTimeseriesResponseSchema,
    declaredErrors: [
      "validation_failed",
      "missing_scope",
      "unsupported_query",
      "deadline_exceeded",
      "internal_error",
      "method_not_allowed",
      "not_acceptable",
      "unsupported_media_type",
    ],
  },
  {
    id: "team.analytics.comparisonBreakdown",
    lifecycle: "exposed",
    method: "POST",
    path: "/api/v1/team/analytics/comparison/breakdowns/{dimension}",
    operationId: "team.analytics.comparisonBreakdown",
    variants: ["explicit"],
    scopes: ["analytics:read"],
    requestSchema: TeamComparisonBreakdownQueryDtoSchema,
    responseSchema: AnalyticsComparisonBreakdownResponseSchema,
    declaredErrors: [
      "validation_failed",
      "missing_scope",
      "unsupported_query",
      "deadline_exceeded",
      "internal_error",
      "method_not_allowed",
      "not_acceptable",
      "unsupported_media_type",
    ],
  },
] as const satisfies readonly ApiV1AnalyticsComparisonRouteDescriptor<string>[];

export const apiV1AnalyticsSchemaRouteRegistry = [
  {
    id: "site.analytics.schema",
    lifecycle: "exposed",
    method: "GET",
    path: "/api/v1/sites/{siteId}/analytics/schema",
    scopes: ["analytics:read"],
    responseSchema: AnalyticsSchemaResponseSchema,
    declaredErrors: [
      "missing_scope",
      "resource_not_found",
      "validation_failed",
      "internal_error",
      "method_not_allowed",
    ],
  },
  {
    id: "team.analytics.schema",
    lifecycle: "exposed",
    method: "GET",
    path: "/api/v1/team/analytics/schema",
    scopes: ["analytics:read"],
    responseSchema: AnalyticsSchemaResponseSchema,
    declaredErrors: [
      "missing_scope",
      "resource_not_found",
      "validation_failed",
      "internal_error",
      "method_not_allowed",
    ],
  },
] as const satisfies readonly ApiV1AnalyticsSchemaRouteDescriptor<string>[];

export const apiV1AnalyticsTimeseriesRouteRegistry = [
  {
    id: "site.analytics.timeseries",
    lifecycle: "exposed",
    method: "POST",
    path: "/api/v1/sites/{siteId}/analytics/timeseries",
    operationId: "site.analytics.timeseries",
    scopes: ["analytics:read"],
    conditionalScopes: [
      {
        when: "filter.type=saved",
        scopes: ["analytics:read", "analysis:read"],
      },
    ],
    requestSchema: SiteTimeseriesQueryDtoSchema,
    responseSchema: AnalyticsTimeseriesResponseSchema,
    declaredErrors: [
      "validation_failed",
      "missing_scope",
      "resource_not_found",
      "data_unavailable",
      "deadline_exceeded",
      "internal_error",
      "method_not_allowed",
      "not_acceptable",
      "unsupported_media_type",
    ],
  },
  {
    id: "team.analytics.timeseries",
    lifecycle: "exposed",
    method: "POST",
    path: "/api/v1/team/analytics/timeseries",
    operationId: "team.analytics.timeseries",
    scopes: ["analytics:read"],
    requestSchema: TeamTimeseriesQueryDtoSchema,
    responseSchema: AnalyticsTimeseriesResponseSchema,
    declaredErrors: [
      "validation_failed",
      "missing_scope",
      "data_unavailable",
      "deadline_exceeded",
      "internal_error",
      "method_not_allowed",
      "not_acceptable",
      "unsupported_media_type",
    ],
  },
] as const satisfies readonly ApiV1AnalyticsTimeseriesRouteDescriptor<string>[];

export const apiV1AnalyticsTeamSitesRouteRegistry = [
  {
    id: "team.analytics.sites",
    lifecycle: "exposed",
    method: "POST",
    path: "/api/v1/team/analytics/sites",
    operationId: "team.analytics.sites",
    scopes: ["analytics:read"],
    requestSchema: TeamSitesQueryDtoSchema,
    responseSchema: TeamAnalyticsSitesResponseSchema,
    declaredErrors: [
      "validation_failed",
      "missing_scope",
      "data_unavailable",
      "deadline_exceeded",
      "internal_error",
      "method_not_allowed",
      "not_acceptable",
      "unsupported_media_type",
    ],
  },
] as const satisfies readonly ApiV1AnalyticsTeamSitesRouteDescriptor<string>[];

export const apiV1AnalyticsBreakdownRouteRegistry = [
  {
    id: "site.analytics.breakdown",
    lifecycle: "exposed",
    method: "POST",
    path: "/api/v1/sites/{siteId}/analytics/breakdowns/{dimension}",
    operationId: "site.analytics.breakdown",
    scopes: ["analytics:read"],
    conditionalScopes: [
      {
        when: "filter.type=saved",
        scopes: ["analytics:read", "analysis:read"],
      },
    ],
    requestSchema: SiteBreakdownQueryDtoSchema,
    responseSchema: AnalyticsBreakdownResponseSchema,
    declaredErrors: [
      "validation_failed",
      "missing_scope",
      "resource_not_found",
      "deadline_exceeded",
      "internal_error",
      "method_not_allowed",
      "not_acceptable",
      "unsupported_media_type",
    ],
  },
] as const satisfies readonly ApiV1AnalyticsBreakdownRouteDescriptor<string>[];

export const apiV1AnalyticsTeamBreakdownRouteRegistry = [
  {
    id: "team.analytics.breakdown",
    lifecycle: "exposed",
    method: "POST",
    path: "/api/v1/team/analytics/breakdowns/{dimension}",
    operationId: "team.analytics.breakdown",
    scopes: ["analytics:read"],
    requestSchema: TeamBreakdownQueryDtoSchema,
    responseSchema: AnalyticsBreakdownResponseSchema,
    declaredErrors: [
      "validation_failed",
      "missing_scope",
      "unsupported_query",
      "deadline_exceeded",
      "internal_error",
      "method_not_allowed",
      "not_acceptable",
      "unsupported_media_type",
    ],
  },
] as const satisfies readonly ApiV1AnalyticsTeamBreakdownRouteDescriptor<string>[];

export const apiV1AnalyticsCrossBreakdownRouteRegistry = [
  {
    id: "site.analytics.crossBreakdown",
    lifecycle: "exposed",
    method: "POST",
    path: "/api/v1/sites/{siteId}/analytics/cross-breakdowns",
    operationId: "site.analytics.crossBreakdown",
    scopes: ["analytics:read"],
    conditionalScopes: [
      {
        when: "filter.type=saved",
        scopes: ["analytics:read", "analysis:read"],
      },
    ],
    requestSchema: SiteCrossBreakdownQueryDtoSchema,
    responseSchema: AnalyticsCrossBreakdownResponseSchema,
    declaredErrors: [
      "validation_failed",
      "missing_scope",
      "resource_not_found",
      "deadline_exceeded",
      "internal_error",
      "method_not_allowed",
      "not_acceptable",
      "unsupported_media_type",
    ],
  },
] as const satisfies readonly ApiV1AnalyticsCrossBreakdownRouteDescriptor<string>[];

export const apiV1AnalyticsListRouteRegistry = [
  {
    id: "site.analytics.pages",
    lifecycle: "exposed",
    method: "POST",
    path: "/api/v1/sites/{siteId}/analytics/pages",
    operationId: "site.analytics.pages",
    scopes: ["analytics:read"],
    conditionalScopes: [
      {
        when: "filter.type=saved",
        scopes: ["analytics:read", "analysis:read"],
      },
    ],
    requestSchema: SitePagesQueryDtoSchema,
    responseSchema: AnalyticsPagesResponseSchema,
    declaredErrors: [
      "validation_failed",
      "missing_scope",
      "resource_not_found",
      "deadline_exceeded",
      "internal_error",
      "method_not_allowed",
      "not_acceptable",
      "unsupported_media_type",
    ],
  },
  {
    id: "site.analytics.referrers",
    lifecycle: "exposed",
    method: "POST",
    path: "/api/v1/sites/{siteId}/analytics/referrers",
    operationId: "site.analytics.referrers",
    scopes: ["analytics:read"],
    conditionalScopes: [
      {
        when: "filter.type=saved",
        scopes: ["analytics:read", "analysis:read"],
      },
    ],
    requestSchema: SiteReferrersQueryDtoSchema,
    responseSchema: AnalyticsReferrersResponseSchema,
    declaredErrors: [
      "validation_failed",
      "missing_scope",
      "resource_not_found",
      "deadline_exceeded",
      "internal_error",
      "method_not_allowed",
      "not_acceptable",
      "unsupported_media_type",
    ],
  },
] as const satisfies readonly ApiV1AnalyticsListRouteDescriptor<string>[];

export const apiV1AnalyticsFilterValuesRouteRegistry = [
  {
    id: "site.analytics.filterValues",
    lifecycle: "exposed",
    method: "POST",
    path: "/api/v1/sites/{siteId}/analytics/filter-values",
    operationId: "site.analytics.filterValues",
    scopes: ["analytics:read"],
    conditionalScopes: [
      {
        when: "filter.type=saved",
        scopes: ["analytics:read", "analysis:read"],
      },
    ],
    requestSchema: SiteFilterValuesQueryDtoSchema,
    responseSchema: AnalyticsFilterValuesResponseSchema,
    declaredErrors: [
      "validation_failed",
      "missing_scope",
      "resource_not_found",
      "deadline_exceeded",
      "internal_error",
      "method_not_allowed",
      "not_acceptable",
      "unsupported_media_type",
    ],
  },
] as const satisfies readonly ApiV1AnalyticsFilterValuesRouteDescriptor<string>[];

export const apiV1AnalyticsRetentionRouteRegistry = [
  {
    id: "site.analytics.retentionCohorts",
    lifecycle: "exposed",
    method: "POST",
    path: "/api/v1/sites/{siteId}/analytics/retention/cohorts",
    operationId: "site.analytics.retentionCohorts",
    scopes: ["analytics:read"],
    conditionalScopes: [
      {
        when: "filter.type=saved",
        scopes: ["analytics:read", "analysis:read"],
      },
    ],
    requestSchema: SiteRetentionCohortsQueryDtoSchema,
    responseSchema: AnalyticsRetentionCohortsResponseSchema,
    declaredErrors: [
      "validation_failed",
      "missing_scope",
      "resource_not_found",
      "deadline_exceeded",
      "internal_error",
      "method_not_allowed",
      "not_acceptable",
      "unsupported_media_type",
    ],
  },
] as const satisfies readonly ApiV1AnalyticsRetentionRouteDescriptor<string>[];

export const apiV1AnalyticsFunnelAnalysisRouteRegistry = [
  {
    id: "site.analytics.funnelAnalysis",
    lifecycle: "exposed",
    method: "POST",
    path: "/api/v1/sites/{siteId}/analytics/funnel-analysis",
    operationId: "site.analytics.funnelAnalysis",
    scopes: ["analytics:read"],
    conditionalScopes: [
      {
        when: "filter.type=saved",
        scopes: ["analytics:read", "analysis:read"],
      },
    ],
    requestSchema: SiteFunnelAnalysisQueryDtoSchema,
    responseSchema: AnalyticsFunnelAnalysisResponseSchema,
    declaredErrors: [
      "validation_failed",
      "missing_scope",
      "resource_not_found",
      "data_unavailable",
      "internal_error",
      "method_not_allowed",
      "not_acceptable",
      "unsupported_media_type",
    ],
  },
] as const satisfies readonly ApiV1AnalyticsFunnelAnalysisRouteDescriptor<string>[];

export const apiV1AnalyticsPerformanceRouteRegistry = [
  {
    id: "site.analytics.performanceSummary",
    lifecycle: "exposed",
    method: "POST",
    path: "/api/v1/sites/{siteId}/analytics/performance/summary",
    operationId: "site.analytics.performanceSummary",
    scopes: ["analytics:read"],
    conditionalScopes: [
      {
        when: "filter.type=saved",
        scopes: ["analytics:read", "analysis:read"],
      },
    ],
    requestSchema: SitePerformanceSummaryQueryDtoSchema,
    responseSchema: AnalyticsPerformanceSummaryResponseSchema,
    declaredErrors: [
      "validation_failed",
      "missing_scope",
      "resource_not_found",
      "deadline_exceeded",
      "internal_error",
      "method_not_allowed",
      "not_acceptable",
      "unsupported_media_type",
    ],
  },
  {
    id: "site.analytics.performanceTimeseries",
    lifecycle: "exposed",
    method: "POST",
    path: "/api/v1/sites/{siteId}/analytics/performance/timeseries",
    operationId: "site.analytics.performanceTimeseries",
    scopes: ["analytics:read"],
    conditionalScopes: [
      {
        when: "filter.type=saved",
        scopes: ["analytics:read", "analysis:read"],
      },
    ],
    requestSchema: SitePerformanceTimeseriesQueryDtoSchema,
    responseSchema: AnalyticsPerformanceTimeseriesResponseSchema,
    declaredErrors: [
      "validation_failed",
      "missing_scope",
      "resource_not_found",
      "deadline_exceeded",
      "internal_error",
      "method_not_allowed",
      "not_acceptable",
      "unsupported_media_type",
    ],
  },
  {
    id: "site.analytics.performanceBreakdown",
    lifecycle: "exposed",
    method: "POST",
    path: "/api/v1/sites/{siteId}/analytics/performance/breakdowns/{dimension}",
    operationId: "site.analytics.performanceBreakdown",
    pathParameterSchemas: {
      dimension: SitePerformanceBreakdownDimensionSchema,
    },
    scopes: ["analytics:read"],
    conditionalScopes: [
      {
        when: "filter.type=saved",
        scopes: ["analytics:read", "analysis:read"],
      },
    ],
    requestSchema: SitePerformanceBreakdownQueryDtoSchema,
    responseSchema: AnalyticsPerformanceBreakdownResponseSchema,
    declaredErrors: [
      "validation_failed",
      "missing_scope",
      "resource_not_found",
      "deadline_exceeded",
      "internal_error",
      "method_not_allowed",
      "not_acceptable",
      "unsupported_media_type",
    ],
  },
] as const satisfies readonly ApiV1AnalyticsPerformanceRouteDescriptor<string>[];

export const apiV1AnalyticsEventsRouteRegistry = [
  {
    id: "site.analytics.eventsSummary",
    lifecycle: "exposed",
    method: "POST",
    path: "/api/v1/sites/{siteId}/analytics/events/summary",
    operationId: "site.analytics.eventsSummary",
    scopes: ["analytics:read"],
    conditionalScopes: [
      {
        when: "filter.type=saved",
        scopes: ["analytics:read", "analysis:read"],
      },
    ],
    requestSchema: SiteEventsSummaryQueryDtoSchema,
    responseSchema: AnalyticsEventsSummaryResponseSchema,
    declaredErrors: [
      "validation_failed",
      "missing_scope",
      "resource_not_found",
      "deadline_exceeded",
      "internal_error",
      "method_not_allowed",
      "not_acceptable",
      "unsupported_media_type",
    ],
  },
  {
    id: "site.analytics.eventsTimeseries",
    lifecycle: "exposed",
    method: "POST",
    path: "/api/v1/sites/{siteId}/analytics/events/timeseries",
    operationId: "site.analytics.eventsTimeseries",
    scopes: ["analytics:read"],
    conditionalScopes: [
      {
        when: "filter.type=saved",
        scopes: ["analytics:read", "analysis:read"],
      },
    ],
    requestSchema: SiteEventsTimeseriesQueryDtoSchema,
    responseSchema: AnalyticsEventsTimeseriesResponseSchema,
    declaredErrors: [
      "validation_failed",
      "missing_scope",
      "resource_not_found",
      "deadline_exceeded",
      "internal_error",
      "method_not_allowed",
      "not_acceptable",
      "unsupported_media_type",
    ],
  },
] as const satisfies readonly ApiV1AnalyticsEventsRouteDescriptor<string>[];

export const apiV1AnalyticsEventRecordsRouteRegistry = [
  {
    id: "site.analytics.eventsSearch",
    lifecycle: "exposed",
    method: "POST",
    path: "/api/v1/sites/{siteId}/analytics/events/search",
    operationId: "site.analytics.eventsSearch",
    scopes: ["analytics:read"],
    conditionalScopes: [
      {
        when: "filter.type=saved",
        scopes: ["analytics:read", "analysis:read"],
      },
    ],
    requestSchema: SiteEventsSearchQueryDtoSchema,
    responseSchema: AnalyticsEventsSearchResponseSchema,
    declaredErrors: [
      "validation_failed",
      "missing_scope",
      "resource_not_found",
      "deadline_exceeded",
      "internal_error",
      "method_not_allowed",
      "not_acceptable",
      "unsupported_media_type",
    ],
  },
  {
    id: "site.analytics.eventDetail",
    lifecycle: "exposed",
    method: "POST",
    path: "/api/v1/sites/{siteId}/analytics/events/detail",
    operationId: "site.analytics.eventDetail",
    scopes: ["analytics:read"],
    requestSchema: SiteEventDetailQueryDtoSchema,
    responseSchema: AnalyticsEventDetailResponseSchema,
    declaredErrors: [
      "validation_failed",
      "missing_scope",
      "resource_not_found",
      "deadline_exceeded",
      "internal_error",
      "method_not_allowed",
      "not_acceptable",
      "unsupported_media_type",
    ],
  },
] as const satisfies readonly ApiV1AnalyticsEventRecordsRouteDescriptor<string>[];

export const apiV1AnalyticsEventTypesRouteRegistry = [
  {
    id: "site.analytics.eventTypes",
    lifecycle: "exposed",
    method: "POST",
    path: "/api/v1/sites/{siteId}/analytics/event-types",
    operationId: "site.analytics.eventTypes",
    scopes: ["analytics:read"],
    conditionalScopes: [
      {
        when: "filter.type=saved",
        scopes: ["analytics:read", "analysis:read"],
      },
    ],
    requestSchema: SiteEventTypesQueryDtoSchema,
    responseSchema: AnalyticsEventTypesResponseSchema,
    declaredErrors: [
      "validation_failed",
      "missing_scope",
      "resource_not_found",
      "deadline_exceeded",
      "internal_error",
      "method_not_allowed",
      "not_acceptable",
      "unsupported_media_type",
    ],
  },
  {
    id: "site.analytics.eventTypeDetail",
    lifecycle: "exposed",
    method: "POST",
    path: "/api/v1/sites/{siteId}/analytics/event-types/detail",
    operationId: "site.analytics.eventTypeDetail",
    scopes: ["analytics:read"],
    conditionalScopes: [
      {
        when: "filter.type=saved",
        scopes: ["analytics:read", "analysis:read"],
      },
    ],
    requestSchema: SiteEventTypeDetailQueryDtoSchema,
    responseSchema: AnalyticsEventTypeDetailResponseSchema,
    declaredErrors: [
      "validation_failed",
      "missing_scope",
      "resource_not_found",
      "deadline_exceeded",
      "internal_error",
      "method_not_allowed",
      "not_acceptable",
      "unsupported_media_type",
    ],
  },
  {
    id: "site.analytics.eventFields",
    lifecycle: "exposed",
    method: "POST",
    path: "/api/v1/sites/{siteId}/analytics/event-types/fields",
    operationId: "site.analytics.eventFields",
    scopes: ["analytics:read"],
    conditionalScopes: [
      {
        when: "filter.type=saved",
        scopes: ["analytics:read", "analysis:read"],
      },
    ],
    requestSchema: SiteEventFieldsQueryDtoSchema,
    responseSchema: AnalyticsEventFieldsResponseSchema,
    declaredErrors: [
      "validation_failed",
      "missing_scope",
      "resource_not_found",
      "deadline_exceeded",
      "internal_error",
      "method_not_allowed",
      "not_acceptable",
      "unsupported_media_type",
    ],
  },
  {
    id: "site.analytics.eventFieldValues",
    lifecycle: "exposed",
    method: "POST",
    path: "/api/v1/sites/{siteId}/analytics/event-types/field-values",
    operationId: "site.analytics.eventFieldValues",
    scopes: ["analytics:read"],
    conditionalScopes: [
      {
        when: "filter.type=saved",
        scopes: ["analytics:read", "analysis:read"],
      },
    ],
    requestSchema: SiteEventFieldValuesQueryDtoSchema,
    responseSchema: AnalyticsEventFieldValuesResponseSchema,
    declaredErrors: [
      "validation_failed",
      "missing_scope",
      "resource_not_found",
      "deadline_exceeded",
      "internal_error",
      "method_not_allowed",
      "not_acceptable",
      "unsupported_media_type",
    ],
  },
] as const satisfies readonly ApiV1AnalyticsEventTypesRouteDescriptor<string>[];

export const apiV1AnalyticsJourneyDetailsRouteRegistry = [
  {
    id: "site.analytics.visitorDetail",
    lifecycle: "exposed",
    method: "POST",
    path: "/api/v1/sites/{siteId}/analytics/visitors/detail",
    operationId: "site.analytics.visitorDetail",
    scopes: ["analytics:read"],
    requestSchema: SiteVisitorDetailQueryDtoSchema,
    responseSchema: AnalyticsVisitorDetailResponseSchema,
    declaredErrors: [
      "validation_failed",
      "missing_scope",
      "resource_not_found",
      "deadline_exceeded",
      "internal_error",
      "method_not_allowed",
      "not_acceptable",
      "unsupported_media_type",
    ],
  },
  {
    id: "site.analytics.sessionDetail",
    lifecycle: "exposed",
    method: "POST",
    path: "/api/v1/sites/{siteId}/analytics/sessions/detail",
    operationId: "site.analytics.sessionDetail",
    scopes: ["analytics:read"],
    requestSchema: SiteSessionDetailQueryDtoSchema,
    responseSchema: AnalyticsSessionDetailResponseSchema,
    declaredErrors: [
      "validation_failed",
      "missing_scope",
      "resource_not_found",
      "deadline_exceeded",
      "internal_error",
      "method_not_allowed",
      "not_acceptable",
      "unsupported_media_type",
    ],
  },
] as const satisfies readonly ApiV1AnalyticsJourneyDetailsRouteDescriptor<string>[];

export const apiV1AnalyticsJourneySearchRouteRegistry = [
  {
    id: "site.analytics.visitorsSearch",
    lifecycle: "exposed",
    method: "POST",
    path: "/api/v1/sites/{siteId}/analytics/visitors/search",
    operationId: "site.analytics.visitorsSearch",
    scopes: ["analytics:read"],
    conditionalScopes: [
      {
        when: "filter.type=saved",
        scopes: ["analytics:read", "analysis:read"],
      },
    ],
    requestSchema: SiteVisitorsSearchQueryDtoSchema,
    responseSchema: AnalyticsVisitorsSearchResponseSchema,
    declaredErrors: [
      "validation_failed",
      "invalid_cursor",
      "missing_scope",
      "resource_not_found",
      "deadline_exceeded",
      "internal_error",
      "method_not_allowed",
      "not_acceptable",
      "unsupported_media_type",
    ],
  },
  {
    id: "site.analytics.sessionsSearch",
    lifecycle: "exposed",
    method: "POST",
    path: "/api/v1/sites/{siteId}/analytics/sessions/search",
    operationId: "site.analytics.sessionsSearch",
    scopes: ["analytics:read"],
    conditionalScopes: [
      {
        when: "filter.type=saved",
        scopes: ["analytics:read", "analysis:read"],
      },
    ],
    requestSchema: SiteSessionsSearchQueryDtoSchema,
    responseSchema: AnalyticsSessionsSearchResponseSchema,
    declaredErrors: [
      "validation_failed",
      "invalid_cursor",
      "missing_scope",
      "resource_not_found",
      "deadline_exceeded",
      "internal_error",
      "method_not_allowed",
      "not_acceptable",
      "unsupported_media_type",
    ],
  },
] as const satisfies readonly ApiV1AnalyticsJourneySearchRouteDescriptor<string>[];

export const apiV1AnalyticsJourneyTrajectoryRouteRegistry = [
  {
    id: "site.analytics.visitorEvents",
    lifecycle: "exposed",
    method: "POST",
    path: "/api/v1/sites/{siteId}/analytics/visitors/events",
    operationId: "site.analytics.visitorEvents",
    scopes: ["analytics:read"],
    conditionalScopes: [
      {
        when: "filter.type=saved",
        scopes: ["analytics:read", "analysis:read"],
      },
    ],
    requestSchema: SiteVisitorEventsQueryDtoSchema,
    responseSchema: AnalyticsJourneyEventsResponseSchema,
    declaredErrors: [
      "validation_failed",
      "missing_scope",
      "resource_not_found",
      "deadline_exceeded",
      "internal_error",
      "method_not_allowed",
      "not_acceptable",
      "unsupported_media_type",
    ],
  },
  {
    id: "site.analytics.visitorSessions",
    lifecycle: "exposed",
    method: "POST",
    path: "/api/v1/sites/{siteId}/analytics/visitors/sessions",
    operationId: "site.analytics.visitorSessions",
    scopes: ["analytics:read"],
    conditionalScopes: [
      {
        when: "filter.type=saved",
        scopes: ["analytics:read", "analysis:read"],
      },
    ],
    requestSchema: SiteVisitorSessionsQueryDtoSchema,
    responseSchema: AnalyticsJourneySessionsResponseSchema,
    declaredErrors: [
      "validation_failed",
      "missing_scope",
      "resource_not_found",
      "deadline_exceeded",
      "internal_error",
      "method_not_allowed",
      "not_acceptable",
      "unsupported_media_type",
    ],
  },
  {
    id: "site.analytics.sessionEvents",
    lifecycle: "exposed",
    method: "POST",
    path: "/api/v1/sites/{siteId}/analytics/sessions/events",
    operationId: "site.analytics.sessionEvents",
    scopes: ["analytics:read"],
    conditionalScopes: [
      {
        when: "filter.type=saved",
        scopes: ["analytics:read", "analysis:read"],
      },
    ],
    requestSchema: SiteSessionEventsQueryDtoSchema,
    responseSchema: AnalyticsJourneyEventsResponseSchema,
    declaredErrors: [
      "validation_failed",
      "missing_scope",
      "resource_not_found",
      "deadline_exceeded",
      "internal_error",
      "method_not_allowed",
      "not_acceptable",
      "unsupported_media_type",
    ],
  },
] as const satisfies readonly ApiV1AnalyticsJourneyTrajectoryRouteDescriptor<string>[];

export const apiV1AnalyticsRealtimeRouteRegistry = [
  {
    id: "site.analytics.realtimeSnapshot",
    lifecycle: "exposed",
    method: "POST",
    path: "/api/v1/sites/{siteId}/analytics/realtime/snapshot",
    operationId: "site.analytics.realtimeSnapshot",
    scopes: ["analytics:read"],
    requestSchema: SiteRealtimeSnapshotQueryDtoSchema,
    responseSchema: AnalyticsRealtimeSnapshotResponseSchema,
    declaredErrors: [
      "validation_failed",
      "missing_scope",
      "deadline_exceeded",
      "data_unavailable",
      "internal_error",
      "method_not_allowed",
      "not_acceptable",
      "unsupported_media_type",
    ],
  },
  {
    id: "site.analytics.realtimeActiveVisitors",
    lifecycle: "exposed",
    method: "POST",
    path: "/api/v1/sites/{siteId}/analytics/realtime/active-visitors",
    operationId: "site.analytics.realtimeActiveVisitors",
    scopes: ["analytics:read"],
    requestSchema: SiteRealtimeActiveVisitorsQueryDtoSchema,
    responseSchema: AnalyticsRealtimeActiveVisitorsResponseSchema,
    declaredErrors: [
      "validation_failed",
      "missing_scope",
      "deadline_exceeded",
      "data_unavailable",
      "internal_error",
      "method_not_allowed",
      "not_acceptable",
      "unsupported_media_type",
    ],
  },
  {
    id: "site.analytics.realtimeEvents",
    lifecycle: "exposed",
    method: "POST",
    path: "/api/v1/sites/{siteId}/analytics/realtime/events",
    operationId: "site.analytics.realtimeEvents",
    scopes: ["analytics:read"],
    requestSchema: SiteRealtimeEventsQueryDtoSchema,
    responseSchema: AnalyticsRealtimeEventsResponseSchema,
    declaredErrors: [
      "validation_failed",
      "missing_scope",
      "deadline_exceeded",
      "data_unavailable",
      "internal_error",
      "method_not_allowed",
      "not_acceptable",
      "unsupported_media_type",
    ],
  },
  {
    id: "site.analytics.realtimeSessions",
    lifecycle: "exposed",
    method: "POST",
    path: "/api/v1/sites/{siteId}/analytics/realtime/sessions",
    operationId: "site.analytics.realtimeSessions",
    scopes: ["analytics:read"],
    requestSchema: SiteRealtimeSessionsQueryDtoSchema,
    responseSchema: AnalyticsRealtimeSessionsResponseSchema,
    declaredErrors: [
      "validation_failed",
      "missing_scope",
      "deadline_exceeded",
      "data_unavailable",
      "internal_error",
      "method_not_allowed",
      "not_acceptable",
      "unsupported_media_type",
    ],
  },
] as const satisfies readonly ApiV1AnalyticsRealtimeRouteDescriptor<string>[];

function applicationRoute<Id extends string>(
  descriptor: ApiV1ApplicationRouteDescriptor<Id>,
): ApiV1ApplicationRouteDescriptor<Id> {
  return descriptor;
}

/** Read-only saved-filter resources. These remain planned until rollout evidence is complete. */
export const apiV1ApplicationRouteRegistry = [
  applicationRoute({
    id: "sites.list",
    lifecycle: "exposed",
    method: "GET",
    path: "/api/v1/sites",
    operationId: "sites.list",
    scopes: ["site:read"],
    requestSchema: ListSitesInputSchema,
    responseSchema: z.array(SiteResourceSchema),
    declaredErrors: ["missing_scope", "internal_error"],
  }),
  applicationRoute({
    id: "sites.create",
    lifecycle: "exposed",
    method: "POST",
    path: "/api/v1/sites",
    operationId: "sites.create",
    scopes: ["site:write"],
    requestSchema: CreateSiteInputSchema,
    responseSchema: SiteResourceSchema,
    declaredErrors: [
      "validation_failed",
      "payload_too_large",
      "missing_scope",
      "conflict",
      "unsupported_media_type",
      "not_acceptable",
      "internal_error",
    ],
  }),
  applicationRoute({
    id: "sites.get",
    lifecycle: "exposed",
    method: "GET",
    path: "/api/v1/sites/{siteId}",
    operationId: "sites.get",
    scopes: ["site:read"],
    requestSchema: GetSiteInputSchema,
    responseSchema: SiteResourceSchema,
    declaredErrors: ["missing_scope", "resource_not_found", "internal_error"],
  }),
  applicationRoute({
    id: "sites.update",
    lifecycle: "exposed",
    method: "PATCH",
    path: "/api/v1/sites/{siteId}",
    operationId: "sites.update",
    scopes: ["site:write"],
    requestSchema: UpdateSiteInputSchema,
    responseSchema: SiteResourceSchema,
    declaredErrors: [
      "validation_failed",
      "payload_too_large",
      "missing_scope",
      "resource_not_found",
      "conflict",
      "unsupported_media_type",
      "not_acceptable",
      "internal_error",
    ],
  }),
  applicationRoute({
    id: "sites.delete",
    lifecycle: "exposed",
    method: "DELETE",
    path: "/api/v1/sites/{siteId}",
    operationId: "sites.delete",
    scopes: ["site:write"],
    requestSchema: DeleteSiteInputSchema,
    responseSchema: z.undefined(),
    declaredErrors: ["missing_scope", "resource_not_found", "internal_error"],
  }),
  applicationRoute({
    id: "settings.tracking.get",
    lifecycle: "exposed",
    method: "GET",
    path: "/api/v1/sites/{siteId}/settings/tracking",
    operationId: "settings.tracking.get",
    scopes: ["site_config:read"],
    requestSchema: SiteSettingsInputSchema,
    responseSchema: TrackingSettingsSchema,
    declaredErrors: ["missing_scope", "resource_not_found", "internal_error"],
  }),
  applicationRoute({
    id: "settings.tracking.update",
    lifecycle: "exposed",
    method: "PATCH",
    path: "/api/v1/sites/{siteId}/settings/tracking",
    operationId: "settings.tracking.update",
    scopes: ["site_config:write"],
    requestSchema: UpdateTrackingSettingsInputSchema,
    responseSchema: TrackingSettingsSchema,
    declaredErrors: [
      "validation_failed",
      "payload_too_large",
      "missing_scope",
      "resource_not_found",
      "unsupported_media_type",
      "not_acceptable",
      "internal_error",
    ],
  }),
  applicationRoute({
    id: "settings.privacy.get",
    lifecycle: "exposed",
    method: "GET",
    path: "/api/v1/sites/{siteId}/settings/privacy",
    operationId: "settings.privacy.get",
    scopes: ["site_config:read"],
    requestSchema: SiteSettingsInputSchema,
    responseSchema: PrivacySettingsSchema,
    declaredErrors: ["missing_scope", "resource_not_found", "internal_error"],
  }),
  applicationRoute({
    id: "settings.privacy.update",
    lifecycle: "exposed",
    method: "PATCH",
    path: "/api/v1/sites/{siteId}/settings/privacy",
    operationId: "settings.privacy.update",
    scopes: ["site_config:write"],
    requestSchema: UpdatePrivacySettingsInputSchema,
    responseSchema: PrivacySettingsSchema,
    declaredErrors: [
      "validation_failed",
      "payload_too_large",
      "missing_scope",
      "resource_not_found",
      "unsupported_media_type",
      "not_acceptable",
      "internal_error",
    ],
  }),
  applicationRoute({
    id: "settings.sharing.get",
    lifecycle: "exposed",
    method: "GET",
    path: "/api/v1/sites/{siteId}/settings/sharing",
    operationId: "settings.sharing.get",
    scopes: ["site_config:read"],
    requestSchema: SiteSettingsInputSchema,
    responseSchema: SharingSettingsSchema,
    declaredErrors: ["missing_scope", "resource_not_found", "internal_error"],
  }),
  applicationRoute({
    id: "settings.sharing.update",
    lifecycle: "exposed",
    method: "PATCH",
    path: "/api/v1/sites/{siteId}/settings/sharing",
    operationId: "settings.sharing.update",
    scopes: ["site_config:write"],
    requestSchema: UpdateSharingSettingsInputSchema,
    responseSchema: SharingSettingsSchema,
    declaredErrors: [
      "validation_failed",
      "payload_too_large",
      "missing_scope",
      "resource_not_found",
      "conflict",
      "unsupported_media_type",
      "not_acceptable",
      "internal_error",
    ],
  }),
  applicationRoute({
    id: "settings.tracking-script.get",
    lifecycle: "exposed",
    method: "GET",
    path: "/api/v1/sites/{siteId}/settings/tracking-script",
    operationId: "settings.trackingScript.get",
    scopes: ["site_config:read"],
    requestSchema: SiteSettingsInputSchema,
    responseSchema: TrackingScriptSchema,
    declaredErrors: ["missing_scope", "resource_not_found", "internal_error"],
  }),
  applicationRoute({
    id: "funnels.list",
    lifecycle: "exposed",
    method: "GET",
    path: "/api/v1/sites/{siteId}/funnels",
    operationId: "funnels.list",
    scopes: ["analysis:read"],
    requestSchema: SiteSettingsInputSchema,
    responseSchema: z.array(FunnelResourceSchema),
    declaredErrors: ["missing_scope", "resource_not_found", "internal_error"],
  }),
  applicationRoute({
    id: "funnels.create",
    lifecycle: "exposed",
    method: "POST",
    path: "/api/v1/sites/{siteId}/funnels",
    operationId: "funnels.create",
    scopes: ["analysis:write"],
    requestSchema: CreateFunnelInputSchema,
    responseSchema: FunnelResourceSchema,
    declaredErrors: [
      "validation_failed",
      "payload_too_large",
      "missing_scope",
      "resource_not_found",
      "unsupported_media_type",
      "not_acceptable",
      "internal_error",
    ],
  }),
  applicationRoute({
    id: "funnels.get",
    lifecycle: "exposed",
    method: "GET",
    path: "/api/v1/sites/{siteId}/funnels/{funnelId}",
    operationId: "funnels.get",
    scopes: ["analysis:read"],
    requestSchema: GetFunnelInputSchema,
    responseSchema: FunnelResourceSchema,
    declaredErrors: ["missing_scope", "resource_not_found", "internal_error"],
  }),
  applicationRoute({
    id: "funnels.update",
    lifecycle: "exposed",
    method: "PATCH",
    path: "/api/v1/sites/{siteId}/funnels/{funnelId}",
    operationId: "funnels.update",
    scopes: ["analysis:write"],
    requestSchema: UpdateFunnelInputSchema,
    responseSchema: FunnelResourceSchema,
    declaredErrors: [
      "validation_failed",
      "payload_too_large",
      "missing_scope",
      "resource_not_found",
      "unsupported_media_type",
      "not_acceptable",
      "internal_error",
    ],
  }),
  applicationRoute({
    id: "funnels.delete",
    lifecycle: "exposed",
    method: "DELETE",
    path: "/api/v1/sites/{siteId}/funnels/{funnelId}",
    operationId: "funnels.delete",
    scopes: ["analysis:write"],
    requestSchema: GetFunnelInputSchema,
    responseSchema: z.undefined(),
    declaredErrors: ["missing_scope", "resource_not_found", "internal_error"],
  }),
  applicationRoute({
    id: "site.saved-filters.list",
    lifecycle: "exposed",
    method: "GET",
    path: "/api/v1/sites/{siteId}/saved-filters",
    operationId: "savedFilters.list",
    scopes: ["analysis:read"],
    requestSchema: ListTeamVisibleSavedFiltersInputSchema,
    responseSchema: SavedFilterPageSchema,
    declaredErrors: [
      "missing_scope",
      "resource_not_found",
      "invalid_cursor",
      "internal_error",
    ],
  }),
  applicationRoute({
    id: "site.saved-filters.get",
    lifecycle: "exposed",
    method: "GET",
    path: "/api/v1/sites/{siteId}/saved-filters/{savedFilterId}",
    operationId: "savedFilters.get",
    scopes: ["analysis:read"],
    requestSchema: GetTeamVisibleSavedFilterInputSchema,
    responseSchema: SavedFilterDefinitionSchema,
    declaredErrors: [
      "missing_scope",
      "resource_not_found",
      "invalid_cursor",
      "internal_error",
    ],
  }),
] as const;

export const apiV1BatchRouteRegistry = [
  {
    id: "batch",
    lifecycle: "exposed",
    method: "POST",
    path: "/api/v1/batch",
    scopes: ["analytics:read"],
    requestSchema: TypedBatchRequestSchema,
    responseSchema: TypedBatchResponseSchema,
    declaredErrors: [
      "validation_failed",
      "invalid_json",
      "payload_too_large",
      "unsupported_media_type",
      "batch_child_not_allowed",
      "deadline_exceeded",
      "internal_error",
    ],
  },
] as const satisfies readonly ApiV1BatchRouteDescriptor[];

/**
 * Explicit allow-list for typed batch children. Keep this list independent of
 * route naming conventions so the runtime and generated OpenAPI contract
 * cannot silently disagree when a new route is added.
 */
export const apiV1BatchEligibleRouteIds = [
  "site.analytics.overview",
  "team.analytics.overview",
  "site.analytics.comparisonOverview",
  "site.analytics.comparisonTimeseries",
  "site.analytics.comparisonBreakdown",
  "team.analytics.comparisonOverview",
  "team.analytics.comparisonTimeseries",
  "team.analytics.comparisonBreakdown",
  "site.analytics.schema",
  "team.analytics.schema",
  "site.analytics.timeseries",
  "team.analytics.timeseries",
  "team.analytics.sites",
  "site.analytics.breakdown",
  "team.analytics.breakdown",
  "site.analytics.crossBreakdown",
  "site.analytics.pages",
  "site.analytics.referrers",
  "site.analytics.filterValues",
  "site.analytics.retentionCohorts",
  "site.analytics.funnelAnalysis",
  "site.analytics.performanceSummary",
  "site.analytics.performanceTimeseries",
  "site.analytics.performanceBreakdown",
  "site.analytics.eventsSummary",
  "site.analytics.eventsTimeseries",
  "site.analytics.eventsSearch",
  "site.analytics.eventDetail",
  "site.analytics.eventTypes",
  "site.analytics.eventTypeDetail",
  "site.analytics.eventFields",
  "site.analytics.eventFieldValues",
  "site.analytics.visitorDetail",
  "site.analytics.sessionDetail",
  "site.analytics.visitorsSearch",
  "site.analytics.sessionsSearch",
  "site.analytics.visitorEvents",
  "site.analytics.visitorSessions",
  "site.analytics.sessionEvents",
  "site.analytics.realtimeSnapshot",
  "site.analytics.realtimeActiveVisitors",
  "site.analytics.realtimeEvents",
  "site.analytics.realtimeSessions",
  "site.saved-filters.list",
  "site.saved-filters.get",
] as const;

const apiV1BatchEligibleRouteIdSet = new Set<string>(
  apiV1BatchEligibleRouteIds,
);

export function isApiV1BatchEligible(routeId: string): boolean {
  return apiV1BatchEligibleRouteIdSet.has(routeId);
}

export const apiV1RouteRegistry = [
  ...apiV1AnalyticsRouteRegistry,
  ...apiV1CoreRouteRegistry,
  ...apiV1AnalyticsComparisonRouteRegistry,
  ...apiV1AnalyticsSchemaRouteRegistry,
  ...apiV1AnalyticsTimeseriesRouteRegistry,
  ...apiV1AnalyticsTeamSitesRouteRegistry,
  ...apiV1AnalyticsBreakdownRouteRegistry,
  ...apiV1AnalyticsTeamBreakdownRouteRegistry,
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
  ...apiV1ApplicationRouteRegistry,
  ...apiV1BatchRouteRegistry,
] as const;

/** Stable rollout keys are derived from semantic route variants, never paths. */
export type ApiV1RouteVariantId = "default" | "previous-period" | "explicit";

export function isApiV1RouteVariantId(
  value: string,
): value is ApiV1RouteVariantId {
  return ["default", "previous-period", "explicit"].includes(value);
}

export function apiV1RouteVariantIds(
  route: object,
): readonly ApiV1RouteVariantId[] {
  const variants = (route as { variants?: readonly ApiV1RouteVariantId[] })
    .variants;
  return variants ?? ["default"];
}

/**
 * The canonical non-batch graph. Batch is deliberately kept as a separate
 * descriptor so consumers cannot accidentally enqueue another batch request or
 * make the batch registry recursive.
 */
export const apiV1NonBatchRouteRegistry = apiV1RouteRegistry.filter(
  (route) => route.id !== "batch",
);

export function apiV1ApplicationRouteById(
  id: string,
): (typeof apiV1ApplicationRouteRegistry)[number] | undefined {
  return apiV1ApplicationRouteRegistry.find((route) => route.id === id);
}

export function apiV1BatchRouteById(
  id: string,
): (typeof apiV1BatchRouteRegistry)[number] | undefined {
  return apiV1BatchRouteRegistry.find((route) => route.id === id);
}

export function apiV1AnalyticsRouteById(
  id: string,
):
  | Exclude<
      (typeof apiV1RouteRegistry)[number],
      (typeof apiV1ApplicationRouteRegistry)[number]
    >
  | undefined {
  return apiV1RouteRegistry.find(
    (route) =>
      route.id === id &&
      (route.id.startsWith("site.analytics.") ||
        route.id.startsWith("team.analytics.")),
  ) as
    | Exclude<
        (typeof apiV1RouteRegistry)[number],
        (typeof apiV1ApplicationRouteRegistry)[number]
      >
    | undefined;
}

export function apiV1RouteById(
  id: string,
): (typeof apiV1RouteRegistry)[number] | undefined {
  return apiV1RouteRegistry.find((route) => route.id === id);
}
