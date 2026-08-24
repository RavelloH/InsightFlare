/**
 * API v1 composition boundary for historical and realtime analytics providers.
 * HTTP route modules import only this surface; D1 provider modules and the
 * Durable Object transport remain behind it.
 */
export { createOverviewReader } from "@/lib/edge/analytics/providers/d1/internal/overview-contract-adapter";
export { readSiteBreakdown } from "@/lib/edge/analytics/providers/d1/operations/site-breakdown";
export { readSiteChannels } from "@/lib/edge/analytics/providers/d1/operations/site-channels";
export { readSiteCrossBreakdown } from "@/lib/edge/analytics/providers/d1/operations/site-cross-breakdown";
export {
  readSiteEventDetail,
  readSiteEventRecords,
} from "@/lib/edge/analytics/providers/d1/operations/site-event-records";
export {
  readSiteEventFields,
  readSiteEventFieldValues,
  readSiteEventsSummary,
  readSiteEventsTimeseries,
  readSiteEventTypeDetail,
  readSiteEventTypes,
} from "@/lib/edge/analytics/providers/d1/operations/site-events";
export { readSiteFilterValues } from "@/lib/edge/analytics/providers/d1/operations/site-filter-values";
export { readSiteFunnelAnalysis } from "@/lib/edge/analytics/providers/d1/operations/site-funnel-analysis";
export {
  readSiteSessionDetail,
  readSiteSessionEvents,
  readSiteSessions,
  readSiteVisitorDetail,
  readSiteVisitorEvents,
  readSiteVisitors,
  readSiteVisitorSessions,
} from "@/lib/edge/analytics/providers/d1/operations/site-journeys";
export {
  readSitePages,
  readSiteReferrers,
} from "@/lib/edge/analytics/providers/d1/operations/site-pages";
export {
  readSitePerformanceBreakdown,
  readSitePerformanceSummary,
  readSitePerformanceTimeseries,
} from "@/lib/edge/analytics/providers/d1/operations/site-performance";
export { readSiteRetention } from "@/lib/edge/analytics/providers/d1/operations/site-retention";
export { readTeamBreakdown } from "@/lib/edge/analytics/providers/d1/operations/team-breakdown";
export { readTeamOverview } from "@/lib/edge/analytics/providers/d1/operations/team-overview";
export { readTeamSites } from "@/lib/edge/analytics/providers/d1/operations/team-sites";
export { readTeamTimeseries } from "@/lib/edge/analytics/providers/d1/operations/team-timeseries";
export {
  readSiteRealtimeActiveVisitors,
  readSiteRealtimeEvents,
  readSiteRealtimeSessions,
  readSiteRealtimeSnapshot,
} from "@/lib/edge/analytics/providers/realtime/operations/site-realtime";
