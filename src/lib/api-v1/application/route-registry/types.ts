// Static route descriptors stay together for API schema generation and policy review.
// Lookup behavior is kept in route-lookups.ts.
// Static route descriptors stay together for API schema generation and policy review.
// Lookup behavior is kept in route-lookups.ts.
import type { z } from "zod";

import { type ApiV1ApplicationOperationId } from "@/lib/api-v1/application/registry";
import type {
  SiteBreakdownQueryDtoSchema,
  SiteChannelsQueryDtoSchema,
  SiteComparisonBreakdownV2QueryDtoSchema,
  SiteComparisonQueryDtoSchema,
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
  SiteGoalSummaryQueryDtoSchema,
  SiteGoalTimeseriesQueryDtoSchema,
  SiteJourneyEventDetailQueryDtoSchema,
  SiteOverviewQueryDtoSchema,
  SitePagesQueryDtoSchema,
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
  TeamComparisonBreakdownV2QueryDtoSchema,
  TeamComparisonQueryDtoSchema,
  TeamOverviewQueryDtoSchema,
  TeamSitesQueryDtoSchema,
  TeamTimeseriesQueryDtoSchema,
} from "@/lib/api-v1/contract/dto/analytics";
import type { TypedBatchRequestSchema } from "@/lib/api-v1/contract/dto/batch";
import type { ApiV1ErrorCode } from "@/lib/api-v1/contract/errors";
import type {
  AnalyticsBreakdownResponseSchema,
  AnalyticsChannelsResponseSchema,
  AnalyticsComparisonBreakdownV2ResponseSchema,
  AnalyticsComparisonResponseSchema,
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
  AnalyticsGoalSummaryResponseSchema,
  AnalyticsGoalTimeseriesResponseSchema,
  AnalyticsJourneyEventDetailResponseSchema,
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
} from "@/lib/api-v1/contract/wire";
import { type AnalyticsOperationId } from "@/lib/edge/analytics/application/operation-registry";
export type ApiV1ComparisonOperationId =
  | "site.analytics.comparison"
  | "site.analytics.comparisonBreakdown"
  | "team.analytics.comparison"
  | "team.analytics.comparisonBreakdown";
export type ApiV1RouteLifecycle = "planned" | "exposed";
export type ApiV1HttpMethod = "GET" | "POST" | "PATCH" | "DELETE";
export interface ApiV1AnalyticsRouteDescriptor<Id extends string> {
  readonly id: Id;
  readonly lifecycle: ApiV1RouteLifecycle;
  readonly method: ApiV1HttpMethod;
  readonly path: string;
  readonly operationId: AnalyticsOperationId | ApiV1ComparisonOperationId;
  readonly scopes: readonly string[];
  readonly conditionalScopes?: readonly {
    readonly when:
      | "filter.type=saved"
      | "a.filter.type=saved|b.filter.type=saved"
      | "current.filter.type=saved|reference.filter.type=saved";
    readonly scopes: readonly string[];
  }[];
  readonly requestSchema:
    typeof SiteOverviewQueryDtoSchema | typeof TeamOverviewQueryDtoSchema;
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
    | "site.analytics.comparison"
    | "site.analytics.comparisonBreakdown"
    | "team.analytics.comparison"
    | "team.analytics.comparisonBreakdown";
  readonly scopes: readonly string[];
  readonly conditionalScopes?: ApiV1AnalyticsRouteDescriptor<string>["conditionalScopes"];
  readonly requestSchema:
    | typeof SiteComparisonQueryDtoSchema
    | typeof SiteComparisonBreakdownV2QueryDtoSchema
    | typeof TeamComparisonQueryDtoSchema
    | typeof TeamComparisonBreakdownV2QueryDtoSchema;
  readonly responseSchema:
    | typeof AnalyticsComparisonResponseSchema
    | typeof AnalyticsComparisonBreakdownV2ResponseSchema;
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
    typeof SiteTimeseriesQueryDtoSchema | typeof TeamTimeseriesQueryDtoSchema;
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
  readonly operationId:
    | "site.analytics.pages"
    | "site.analytics.referrers"
    | "site.analytics.channels";
  readonly scopes: readonly string[];
  readonly conditionalScopes?: ApiV1AnalyticsRouteDescriptor<string>["conditionalScopes"];
  readonly requestSchema:
    | typeof SitePagesQueryDtoSchema
    | typeof SiteReferrersQueryDtoSchema
    | typeof SiteChannelsQueryDtoSchema;
  readonly responseSchema:
    | typeof AnalyticsPagesResponseSchema
    | typeof AnalyticsReferrersResponseSchema
    | typeof AnalyticsChannelsResponseSchema;
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
export interface ApiV1AnalyticsGoalRouteDescriptor<Id extends string> {
  readonly id: Id;
  readonly lifecycle: ApiV1RouteLifecycle;
  readonly method: "POST";
  readonly path: string;
  readonly operationId:
    "site.analytics.goalSummary" | "site.analytics.goalTimeseries";
  readonly scopes: readonly string[];
  readonly conditionalScopes?: ApiV1AnalyticsRouteDescriptor<string>["conditionalScopes"];
  readonly requestSchema:
    | typeof SiteGoalSummaryQueryDtoSchema
    | typeof SiteGoalTimeseriesQueryDtoSchema;
  readonly responseSchema:
    | typeof AnalyticsGoalSummaryResponseSchema
    | typeof AnalyticsGoalTimeseriesResponseSchema;
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
    "site.analytics.eventsSummary" | "site.analytics.eventsTimeseries";
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
    "site.analytics.eventsSearch" | "site.analytics.eventDetail";
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
    | "site.analytics.sessionDetail"
    | "site.analytics.journeyEventDetail";
  readonly scopes: readonly string[];
  readonly requestSchema:
    | typeof SiteVisitorDetailQueryDtoSchema
    | typeof SiteSessionDetailQueryDtoSchema
    | typeof SiteJourneyEventDetailQueryDtoSchema;
  readonly responseSchema:
    | typeof AnalyticsVisitorDetailResponseSchema
    | typeof AnalyticsSessionDetailResponseSchema
    | typeof AnalyticsJourneyEventDetailResponseSchema;
  readonly declaredErrors: readonly string[];
}
export interface ApiV1AnalyticsJourneySearchRouteDescriptor<Id extends string> {
  readonly id: Id;
  readonly lifecycle: ApiV1RouteLifecycle;
  readonly method: "POST";
  readonly path: string;
  readonly operationId:
    "site.analytics.visitorsSearch" | "site.analytics.sessionsSearch";
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
export type ApiV1RouteVariantId = "default" | "previous-period" | "explicit";
