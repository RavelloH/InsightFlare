// Public entry point for the versioned HTTP API.
export { createAnalysisDefinitionReader } from "./analytics/analysis-definition-reader";
export {
  handleSiteComparison,
  handleSiteComparisonBreakdown,
  handleTeamComparison,
  handleTeamComparisonBreakdown,
} from "./analytics/comparison";
export { handlePlannedSiteFunnelAnalysis } from "./analytics/funnel-analysis";
export {
  handlePlannedSiteGoalSummary,
  handlePlannedSiteGoalTimeseries,
} from "./analytics/goal-analysis";
export { handlePlannedSiteOverview } from "./analytics/overview-handler";
export { handlePlannedSiteBreakdown } from "./analytics/site-breakdown";
export { handlePlannedSiteCrossBreakdown } from "./analytics/site-cross-breakdown";
export {
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
} from "./analytics/site-list";
export { handleTeamBreakdown } from "./analytics/team-breakdown";
export { handlePlannedTeamOverview } from "./analytics/team-overview";
export { handlePlannedTeamSites } from "./analytics/team-sites";
export { handlePlannedTeamTimeseries } from "./analytics/team-timeseries";
export { handlePlannedSiteTimeseries } from "./analytics/timeseries-handler";
export { requireScope } from "./application/auth-helpers";
export { dispatchApiV1CoreRoute } from "./application/core-dispatcher";
export {
  API_V1_BATCH_BODY_MAX_BYTES,
  API_V1_BATCH_ITEM_BODY_MAX_BYTES,
  inspectJsonBudget,
  readBoundedBody,
  serializedUtf8ByteLength,
} from "./application/request-budget";
export { executeTypedBatch, TypedBatchValidationError } from "./batch/handler";
export { SitePerformanceBreakdownDimensionSchema } from "./contract/dto/analytics";
export { TypedBatchRequestSchema } from "./contract/dto/batch";
export { fromRequestBodyError, fromZodIssues } from "./contract/errors";
export {
  jsonError,
  jsonSuccess,
  methodNotAllowed,
} from "./contract/wire-helpers";
export { handlePlannedResourceRoute } from "./resources/handler";
export { handlePlannedSavedFilters } from "./resources/saved-filters-handler";
export {
  handlePlannedSiteAnalyticsSchema,
  handlePlannedTeamAnalyticsSchema,
} from "./schema/handler";
