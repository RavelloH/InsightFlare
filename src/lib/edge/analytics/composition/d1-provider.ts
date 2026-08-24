/**
 * Concrete D1/realtime assembly surface.
 *
 * Protocol adapters import this composition module instead of importing a
 * provider implementation. All provider wiring remains on this side of the
 * dependency boundary.
 */
export type { TeamDashboardQueryResult } from "@/lib/edge/analytics/providers/d1/internal/team";
export { createOverviewReader } from "@/lib/edge/analytics/providers/d1/operations/overview-reader";
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
export {
  readTeamDashboard,
  type ReadTeamDashboardInput,
  resolveTeamDashboardScope,
} from "@/lib/edge/analytics/providers/d1/operations/team-dashboard";
export { readTeamOverview } from "@/lib/edge/analytics/providers/d1/operations/team-overview";
export { readTeamSites } from "@/lib/edge/analytics/providers/d1/operations/team-sites";
export { readTeamTimeseries } from "@/lib/edge/analytics/providers/d1/operations/team-timeseries";
export {
  readSiteRealtimeActiveVisitors,
  readSiteRealtimeEvents,
  readSiteRealtimeSessions,
  readSiteRealtimeSnapshot,
} from "@/lib/edge/analytics/providers/realtime/operations/site-realtime";
