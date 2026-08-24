import type { QueryOperation } from "@/lib/edge/analytics/contract";

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
  "site.analytics.performanceSummary": "performance",
  "site.analytics.performanceTimeseries": "performance",
  "site.analytics.performanceBreakdown": "performance",
  "site.analytics.eventsSummary": "event-summary",
  "site.analytics.eventsTimeseries": "event-trend",
  "site.analytics.eventsSearch": "event-records",
  "site.analytics.eventDetail": "event-record-detail",
  "site.analytics.eventTypes": "event-types",
  "site.analytics.eventTypeDetail": "event-type-detail",
  "site.analytics.eventFields": "event-fields",
  "site.analytics.eventFieldValues": "event-field-values",
  "site.analytics.visitorDetail": "visitor-detail",
  "site.analytics.sessionDetail": "session-detail",
  "site.analytics.visitorsSearch": "visitors",
  "site.analytics.sessionsSearch": "sessions",
  "site.analytics.visitorEvents": "event-records",
  "site.analytics.visitorSessions": "sessions",
  "site.analytics.sessionEvents": "event-records",
  "site.analytics.realtimeSnapshot": "realtime",
  "site.analytics.realtimeActiveVisitors": "realtime",
  "site.analytics.realtimeEvents": "realtime",
  "site.analytics.realtimeSessions": "realtime",
} as const satisfies Record<AnalyticsOperationId, QueryOperation>;

export type CanonicalQueryOperation =
  (typeof API_V1_QUERY_OPERATION_MAP)[AnalyticsOperationId];

export function canonicalQueryOperationFor(
  operation: AnalyticsOperationId,
): CanonicalQueryOperation {
  return API_V1_QUERY_OPERATION_MAP[operation];
}
