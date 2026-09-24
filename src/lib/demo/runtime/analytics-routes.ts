import { getDemoTeams } from "@/lib/demo/admin/users";
import {
  generateDemoDimension,
  generateDemoOverview,
  generateDemoPages,
  generateDemoPagesDashboard,
  generateDemoPerformance,
  generateDemoReferrers,
  generateDemoReferrerSummary,
  generateDemoRetention,
  generateDemoTrend,
} from "@/lib/demo/analytics";
import {
  generateDemoBrowserCrossBreakdown,
  generateDemoBrowserRadar,
  generateDemoBrowserVersionBreakdown,
  generateDemoClientCrossBreakdown,
  generateDemoReferrerRadar,
} from "@/lib/demo/realtime/browser-client";
import {
  generateDemoEventFields,
  generateDemoEventRecordDetail,
  generateDemoEventsRecords,
  generateDemoEventsSummary,
  generateDemoEventsTrend,
  generateDemoEventTypeContext,
  generateDemoEventTypeDetail,
  generateDemoEventTypeFieldValues,
} from "@/lib/demo/realtime/events";
import { parseDemoInterval } from "@/lib/demo/realtime/filters";
import { generateDemoFunnels } from "@/lib/demo/realtime/funnels";
import { generateDemoGoals } from "@/lib/demo/realtime/goals";
import {
  generateDemoJourneyEventDetail,
  generateDemoSessionDetail,
  generateDemoSessions,
  generateDemoVisitorDetail,
  generateDemoVisitors,
} from "@/lib/demo/realtime/journeys";
import {
  generateDemoBrowserEngineTrend,
  generateDemoBrowserTrend,
  generateDemoChannelTrend,
  generateDemoClientDimensionTrend,
  generateDemoReferrerTrend,
} from "@/lib/demo/realtime/share-trends";
import { generateDemoTeamDashboard } from "@/lib/demo/realtime/team-dashboard";
import {
  generateDemoFilterValues,
  generateDemoGeoPoints,
  generateDemoOverviewClientTab,
  generateDemoOverviewGeoTab,
  generateDemoOverviewPageTab,
  generateDemoOverviewSourceTab,
  generateDemoUtmDimension,
  generateDemoUtmTrend,
} from "@/lib/demo/realtime/utm-overview";

import type { DemoRuntimeContext } from "./context";
import {
  demoNotFoundResponse,
  demoShareTrendDimension,
  paginateDemoDetailCollection,
  paginateDemoEnvelope,
  validateDemoAnalyticsRequest,
} from "./shared";
export function handleDemoAnalyticsWrite(
  context: DemoRuntimeContext,
): unknown | undefined {
  const { path, method, params, bodyRecord, siteId } = context;
  if (
    method === "POST" &&
    (path.includes("/analytics/goals/summary") ||
      path.includes("/analytics/goals/timeseries"))
  ) {
    return generateDemoGoals(siteId, {
      ...params,
      id: String(bodyRecord.goalId ?? params.id ?? ""),
      operation: path.includes("/analytics/goals/timeseries")
        ? "goal-timeseries"
        : "goal-summary",
      ...(bodyRecord.interval !== undefined
        ? { interval: String(bodyRecord.interval) }
        : {}),
    });
  }
  return undefined;
}
export function handleDemoAnalyticsRoutes(
  context: DemoRuntimeContext,
): unknown | undefined {
  const { path, params, siteId, teamId } = context;
  // Analytics query routes
  const analyticsValidationError = validateDemoAnalyticsRequest(path, params);
  if (analyticsValidationError) return analyticsValidationError;
  if (path.includes("/filter-values")) {
    return paginateDemoEnvelope(
      generateDemoFilterValues(
        siteId,
        params,
        path.includes("/api/public/")
          ? "public-share"
          : path.includes("/api/v1/")
            ? "api-v1"
            : "private-dashboard",
      ),
      params,
      50,
      path.includes("/api/public/")
        ? "filter-values:public"
        : path.includes("/api/v1/")
          ? "filter-values:api-v1"
          : "filter-values:private",
      500,
    );
  }
  if (path.includes("/overview-page-path")) {
    return paginateDemoEnvelope(
      generateDemoOverviewPageTab(siteId, params, "path"),
      params,
      100,
      "overview-page-path",
    );
  }
  if (path.includes("/overview-page-title")) {
    return paginateDemoEnvelope(
      generateDemoOverviewPageTab(siteId, params, "title"),
      params,
      100,
      "overview-page-title",
    );
  }
  if (path.includes("/overview-page-hostname")) {
    return paginateDemoEnvelope(
      generateDemoOverviewPageTab(siteId, params, "hostname"),
      params,
      100,
      "overview-page-hostname",
    );
  }
  if (path.includes("/overview-page-entry")) {
    return paginateDemoEnvelope(
      generateDemoOverviewPageTab(siteId, params, "entry"),
      params,
      100,
      "overview-page-entry",
    );
  }
  if (path.includes("/overview-page-exit")) {
    return paginateDemoEnvelope(
      generateDemoOverviewPageTab(siteId, params, "exit"),
      params,
      100,
      "overview-page-exit",
    );
  }
  if (path.includes("/overview-source-channel")) {
    return paginateDemoEnvelope(
      generateDemoOverviewSourceTab(siteId, params, "channel"),
      params,
      100,
      "overview-source-channel",
    );
  }
  if (path.includes("/overview-source-domain")) {
    return paginateDemoEnvelope(
      generateDemoOverviewSourceTab(siteId, params, "domain"),
      params,
      100,
      "overview-source-domain",
    );
  }
  if (path.includes("/overview-source-link")) {
    return paginateDemoEnvelope(
      generateDemoOverviewSourceTab(siteId, params, "link"),
      params,
      100,
      "overview-source-link",
    );
  }
  if (path.includes("/referrer-summary")) {
    return generateDemoReferrerSummary(siteId, params);
  }
  if (path.includes("/overview-client-browser")) {
    return paginateDemoEnvelope(
      generateDemoOverviewClientTab(siteId, params, "browser"),
      params,
      100,
      "overview-client-browser",
    );
  }
  if (path.includes("/overview-client-os-version")) {
    return paginateDemoEnvelope(
      generateDemoOverviewClientTab(siteId, params, "osVersion"),
      params,
      100,
      "overview-client-os-version",
    );
  }
  if (path.includes("/overview-client-device-type")) {
    return paginateDemoEnvelope(
      generateDemoOverviewClientTab(siteId, params, "deviceType"),
      params,
      100,
      "overview-client-device-type",
    );
  }
  if (path.includes("/overview-client-language")) {
    return paginateDemoEnvelope(
      generateDemoOverviewClientTab(siteId, params, "language"),
      params,
      100,
      "overview-client-language",
    );
  }
  if (path.includes("/overview-client-screen-size")) {
    return paginateDemoEnvelope(
      generateDemoOverviewClientTab(siteId, params, "screenSize"),
      params,
      100,
      "overview-client-screen-size",
    );
  }
  if (path.includes("/overview-geo-country")) {
    return paginateDemoEnvelope(
      generateDemoOverviewGeoTab(siteId, params, "country"),
      params,
      100,
      "overview-geo-country",
    );
  }
  if (path.includes("/overview-geo-region")) {
    return paginateDemoEnvelope(
      generateDemoOverviewGeoTab(siteId, params, "region"),
      params,
      100,
      "overview-geo-region",
    );
  }
  if (path.includes("/overview-geo-city")) {
    return paginateDemoEnvelope(
      generateDemoOverviewGeoTab(siteId, params, "city"),
      params,
      100,
      "overview-geo-city",
    );
  }
  if (path.includes("/overview-geo-continent")) {
    return paginateDemoEnvelope(
      generateDemoOverviewGeoTab(siteId, params, "continent"),
      params,
      100,
      "overview-geo-continent",
    );
  }
  if (path.includes("/overview-geo-timezone")) {
    return paginateDemoEnvelope(
      generateDemoOverviewGeoTab(siteId, params, "timezone"),
      params,
      100,
      "overview-geo-timezone",
    );
  }
  if (path.includes("/overview-geo-organization")) {
    return paginateDemoEnvelope(
      generateDemoOverviewGeoTab(siteId, params, "organization"),
      params,
      100,
      "overview-geo-organization",
    );
  }
  if (path.includes("/overview-geo-points")) {
    return generateDemoGeoPoints(siteId, params);
  }
  if (
    path.includes("/journey-event-detail") ||
    path.includes("/journey-events/detail")
  ) {
    return generateDemoJourneyEventDetail(siteId, params);
  }
  if (path.includes("/visitor-events")) {
    return paginateDemoDetailCollection(
      generateDemoVisitorDetail(siteId, params),
      "events",
      params,
    );
  }
  if (path.includes("/visitor-sessions")) {
    return paginateDemoDetailCollection(
      generateDemoVisitorDetail(siteId, params),
      "sessions",
      params,
    );
  }
  if (path.includes("/session-events")) {
    return paginateDemoDetailCollection(
      generateDemoSessionDetail(siteId, params),
      "events",
      params,
    );
  }
  if (path.includes("/event-record-detail")) {
    return generateDemoEventRecordDetail(siteId, params);
  }
  if (
    (path.includes("/api/private/") || path.includes("/api/v1/")) &&
    (path.includes("/event-type-field-values") ||
      path.includes("/event-fields/values"))
  ) {
    return generateDemoEventTypeFieldValues(siteId, params);
  }
  if (
    (path.includes("/api/private/") || path.includes("/api/v1/")) &&
    (path.includes("/event-type-fields") || path.endsWith("/event-fields"))
  ) {
    return generateDemoEventFields(siteId, params);
  }
  if (path.includes("/event-type-context")) {
    return generateDemoEventTypeContext(siteId, params);
  }
  if (path.includes("/event-type-detail")) {
    return generateDemoEventTypeDetail(siteId, params);
  }
  if (path.includes("/events-summary")) {
    return generateDemoEventsSummary(siteId, params);
  }
  if (path.includes("/events-trend")) {
    return generateDemoEventsTrend(siteId, params);
  }
  if (path.includes("/events-records")) {
    return generateDemoEventsRecords(siteId, params);
  }
  if (path.includes("/team-dashboard")) {
    const tid = teamId || getDemoTeams()[0].id;
    return generateDemoTeamDashboard(tid, params);
  }
  if (path.includes("/pages-dashboard")) {
    return generateDemoPagesDashboard(siteId, params);
  }
  if (path.includes("/funnels")) {
    return generateDemoFunnels(siteId, params);
  }
  if (path.includes("/goal-summary") || path.includes("/goal-timeseries")) {
    params.operation = path.includes("goal-timeseries")
      ? "goal-timeseries"
      : "goal-summary";
    return generateDemoGoals(siteId, params);
  }
  if (path.includes("/goals")) {
    return generateDemoGoals(siteId, params);
  }
  if (path.includes("/retention")) {
    return generateDemoRetention(siteId, params);
  }
  if (path.includes("/performance")) {
    return generateDemoPerformance(siteId, params);
  }
  if (path.includes("/overview")) {
    return generateDemoOverview(siteId, params);
  }
  if (path.includes("/browser-cross-breakdown")) {
    return generateDemoBrowserCrossBreakdown(siteId, params);
  }
  if (path.includes("/browser-version-breakdown")) {
    return generateDemoBrowserVersionBreakdown(siteId, params);
  }
  if (path.includes("/browser-radar")) {
    return generateDemoBrowserRadar(siteId, params);
  }
  if (path.includes("/referrer-radar")) {
    return generateDemoReferrerRadar(siteId, params);
  }
  if (path.includes("/referrer-channel-dimension-trend")) {
    return {
      ok: true,
      interval: parseDemoInterval(params.interval),
      source: demoShareTrendDimension(
        generateDemoReferrerTrend(siteId, params, { maxLimit: 12 }),
      ),
      channel: demoShareTrendDimension(
        generateDemoChannelTrend(siteId, params, { maxLimit: 12 }),
      ),
    };
  }
  if (path.includes("/referrer-dimension-trend")) {
    return generateDemoReferrerTrend(siteId, params);
  }
  if (path.includes("/browser-trend")) {
    return generateDemoBrowserTrend(siteId, params);
  }
  if (path.includes("/browser-engine-trend")) {
    return generateDemoBrowserEngineTrend(siteId, params);
  }
  if (path.includes("/client-dimension-trend")) {
    return generateDemoClientDimensionTrend(siteId, params);
  }
  if (path.includes("/utm-dimension-trend")) {
    return generateDemoUtmTrend(siteId, params);
  }
  if (path.includes("/client-cross-breakdown")) {
    return generateDemoClientCrossBreakdown(siteId, params);
  }
  if (path.includes("/trend")) {
    return generateDemoTrend(siteId, params);
  }
  if (path.includes("/session-detail")) {
    return generateDemoSessionDetail(siteId, params);
  }
  if (path.includes("/visitor-detail")) {
    return generateDemoVisitorDetail(siteId, params);
  }
  if (path.includes("/sessions")) {
    return generateDemoSessions(siteId, params);
  }
  if (path.includes("/pages")) {
    return generateDemoPages(siteId, params, {
      includeTabs: !path.includes("/api/public/") && !path.includes("/api/v1/"),
      defaultLimit: 20,
    });
  }
  if (path.includes("/referrers")) {
    const isPublic = path.includes("/api/public/");
    return generateDemoReferrers(siteId, params, {
      allowFullUrl: !isPublic,
      defaultLimit: isPublic ? 8 : 20,
    });
  }
  if (path.includes("/utm-source")) {
    return generateDemoUtmDimension(siteId, "source", params);
  }
  if (path.includes("/utm-medium")) {
    return generateDemoUtmDimension(siteId, "medium", params);
  }
  if (path.includes("/utm-campaign")) {
    return generateDemoUtmDimension(siteId, "campaign", params);
  }
  if (path.includes("/utm-term")) {
    return generateDemoUtmDimension(siteId, "term", params);
  }
  if (path.includes("/utm-content")) {
    return generateDemoUtmDimension(siteId, "content", params);
  }
  if (path.includes("/visitors")) {
    return generateDemoVisitors(siteId, params);
  }
  if (path.includes("/countries")) {
    return generateDemoDimension(siteId, "countries", params);
  }
  if (path.includes("/devices")) {
    return demoNotFoundResponse();
  }
  if (path.includes("/page-hash")) {
    return generateDemoDimension(siteId, "page-hash", params);
  }
  if (path.includes("/page-query")) {
    return generateDemoDimension(siteId, "page-query", params);
  }
  if (path.includes("/event-types")) {
    return generateDemoDimension(siteId, "event-types", params);
  }
  return undefined;
}
