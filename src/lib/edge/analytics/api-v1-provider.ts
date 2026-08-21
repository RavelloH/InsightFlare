/**
 * API v1 composition boundary for historical and realtime analytics providers.
 * HTTP route modules import only this surface; D1 query-runtime modules and the
 * Durable Object transport remain behind it.
 */
export { createOverviewReader } from "@/lib/edge/query/overview-contract-adapter";
export { readSiteBreakdown } from "@/lib/edge/query-runtime/site-breakdown";
export { readSiteCrossBreakdown } from "@/lib/edge/query-runtime/site-cross-breakdown";
export {
  readSiteEventDetail,
  readSiteEventRecords,
} from "@/lib/edge/query-runtime/site-event-records";
export {
  readSiteEventFields,
  readSiteEventFieldValues,
  readSiteEventsSummary,
  readSiteEventsTimeseries,
  readSiteEventTypeDetail,
  readSiteEventTypes,
} from "@/lib/edge/query-runtime/site-events";
export { readSiteFilterValues } from "@/lib/edge/query-runtime/site-filter-values";
export { readSiteFunnelAnalysis } from "@/lib/edge/query-runtime/site-funnel-analysis";
export {
  readSiteSessionDetail,
  readSiteSessionEvents,
  readSiteSessions,
  readSiteVisitorDetail,
  readSiteVisitorEvents,
  readSiteVisitors,
  readSiteVisitorSessions,
} from "@/lib/edge/query-runtime/site-journeys";
export {
  readSitePages,
  readSiteReferrers,
} from "@/lib/edge/query-runtime/site-pages";
export {
  readSitePerformanceBreakdown,
  readSitePerformanceSummary,
  readSitePerformanceTimeseries,
} from "@/lib/edge/query-runtime/site-performance";
export {
  readSiteRealtimeActiveVisitors,
  readSiteRealtimeEvents,
  readSiteRealtimeSessions,
  readSiteRealtimeSnapshot,
} from "@/lib/edge/query-runtime/site-realtime";
export { readSiteRetention } from "@/lib/edge/query-runtime/site-retention";
export { readTeamBreakdown } from "@/lib/edge/query-runtime/team-breakdown";
export { readTeamOverview } from "@/lib/edge/query-runtime/team-overview";
export { readTeamSites } from "@/lib/edge/query-runtime/team-sites";
export { readTeamTimeseries } from "@/lib/edge/query-runtime/team-timeseries";
