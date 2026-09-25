import type {
  CanonicalQuery,
  CanonicalResult,
  QueryContext,
  QueryOperation,
  QueryTime,
} from "@/lib/edge/analytics/contract";
import type {
  PerformanceQueryMode,
  RealtimeQueryMode,
} from "@/lib/edge/analytics/contract";

import type { AnalyticsOperationId } from "./operation-registry";

/**
 * API v1 keeps its public operation ids for routing and documentation.  The
 * application service receives only this canonical query vocabulary.
 */
export const API_V1_QUERY_OPERATION_MAP = {
  "site.analytics.overview": "overview",
  "team.analytics.overview": "overview",
  "site.analytics.timeseries": "trend",
  "team.analytics.timeseries": "trend",
  "team.analytics.sites": "team-sites",
  "site.analytics.breakdown": "dimension",
  "team.analytics.breakdown": "dimension",
  "site.analytics.crossBreakdown": "cross-dimension",
  "site.analytics.comparison": "comparison",
  "team.analytics.comparison": "comparison",
  "site.analytics.comparisonBreakdown": "comparison-breakdown",
  "team.analytics.comparisonBreakdown": "comparison-breakdown",
  "site.analytics.pages": "pages",
  "site.analytics.referrers": "referrers",
  "site.analytics.channels": "channels",
  "site.analytics.filterValues": "filter-values",
  "site.analytics.retentionCohorts": "retention",
  "site.analytics.funnelAnalysis": "funnel-analysis",
  "site.analytics.goalSummary": "goal-summary",
  "site.analytics.goalTimeseries": "goal-timeseries",
  "site.analytics.performanceSummary": "performance",
  "site.analytics.performanceTimeseries": "performance",
  "site.analytics.performanceBreakdown": "performance",
  "site.analytics.eventsSummary": "event-summary",
  "site.analytics.eventsTimeseries": "event-trend",
  "site.analytics.eventsSearch": "event-records",
  "site.analytics.eventDetail": "event-record-detail",
  "site.analytics.journeyEventDetail": "journey-event-detail",
  "site.analytics.eventTypes": "event-types",
  "site.analytics.eventTypeDetail": "event-type-detail",
  "site.analytics.eventFields": "event-fields",
  "site.analytics.eventFieldValues": "event-field-values",
  "site.analytics.visitorDetail": "visitor-detail",
  "site.analytics.sessionDetail": "session-detail",
  "site.analytics.visitorsSearch": "visitors",
  "site.analytics.sessionsSearch": "sessions",
  "site.analytics.visitorEvents": "visitor-events",
  "site.analytics.visitorSessions": "visitor-sessions",
  "site.analytics.sessionEvents": "session-events",
  "site.analytics.realtimeSnapshot": "realtime",
  "site.analytics.realtimeActiveVisitors": "realtime",
  "site.analytics.realtimeEvents": "realtime",
  "site.analytics.realtimeSessions": "realtime",
} as const satisfies Record<AnalyticsOperationId, QueryOperation>;

/** Canonical operation mapping derived directly from the API operation table. */
export type ApiV1CanonicalOperationMap = typeof API_V1_QUERY_OPERATION_MAP;
export type ApiV1CanonicalOperation<Operation extends AnalyticsOperationId> =
  ApiV1CanonicalOperationMap[Operation];
export type ApiV1CanonicalQuery<Operation extends AnalyticsOperationId> =
  CanonicalQuery<ApiV1CanonicalOperation<Operation>>;
export type ApiV1CanonicalResult<Operation extends AnalyticsOperationId> =
  CanonicalResult<ApiV1CanonicalOperation<Operation>>;

type ApiV1QueryVariantMap = typeof API_V1_QUERY_VARIANT_MAP;
export type ApiV1CanonicalMode<Operation extends AnalyticsOperationId> =
  Operation extends keyof ApiV1QueryVariantMap
    ? ApiV1QueryVariantMap[Operation]
    : never;

type DistributiveOmit<Value, Key extends PropertyKey> = Value extends unknown
  ? Omit<Value, Key>
  : never;

/**
 * The route-level query is the canonical operation query before the adapter
 * binds request context/time and the API operation's canonical mode.
 */
export type ApiV1InvocationQuery<Operation extends AnalyticsOperationId> =
  DistributiveOmit<
    ApiV1CanonicalQuery<Operation>,
    "context" | "time" | "mode"
  > & {
    readonly context?: QueryContext;
    readonly time?: QueryTime;
    readonly mode?: ApiV1CanonicalMode<Operation>;
    readonly startMs?: number;
    readonly endExclusiveMs?: number;
    readonly timeZone?: string;
    readonly siteId?: string;
    readonly teamId?: string;
    readonly allowedSiteIds?: readonly string[];
    readonly window?: {
      readonly startMs?: number;
      readonly endExclusiveMs?: number;
      readonly timeZone?: string;
      readonly nowMs?: number;
    };
  };

const API_V1_QUERY_VARIANT_MAP = {
  "site.analytics.breakdown": "breakdown",
  "team.analytics.breakdown": "breakdown",
  "site.analytics.channels": "list",
  "site.analytics.performanceSummary": "summary",
  "site.analytics.performanceTimeseries": "timeseries",
  "site.analytics.performanceBreakdown": "breakdown",
  "site.analytics.realtimeSnapshot": "snapshot",
  "site.analytics.realtimeActiveVisitors": "active-visitors",
  "site.analytics.realtimeEvents": "events",
  "site.analytics.realtimeSessions": "sessions",
} as const satisfies Partial<
  Record<
    AnalyticsOperationId,
    | Exclude<PerformanceQueryMode, "dashboard">
    | RealtimeQueryMode
    | "breakdown"
    | "list"
  >
>;

export type CanonicalQueryOperation =
  (typeof API_V1_QUERY_OPERATION_MAP)[AnalyticsOperationId];

export function canonicalQueryOperationFor<
  Operation extends AnalyticsOperationId,
>(operation: Operation): (typeof API_V1_QUERY_OPERATION_MAP)[Operation] {
  return API_V1_QUERY_OPERATION_MAP[operation];
}

export function canonicalQueryVariantFor<
  Operation extends AnalyticsOperationId,
>(operation: Operation): ApiV1CanonicalMode<Operation> | undefined {
  return API_V1_QUERY_VARIANT_MAP[
    operation as keyof typeof API_V1_QUERY_VARIANT_MAP
  ] as ApiV1CanonicalMode<Operation> | undefined;
}
