import type { Env } from "@/lib/edge/types";

import {
  getRequestId,
  notFound,
  type ResponseContext,
  utmDimensionDefinition,
} from "./core";
import {
  handleEventRecordDetail,
  handleEventsRecords,
  handleEventsSummary,
  handleEventsTrend,
  handleEventTypeDetail,
  handleEventTypeFieldValues,
  handleEventTypes,
} from "./events";
import { handleFunnel } from "./funnels";
import {
  handleRetention,
  handleSessionDetail,
  handleSessions,
  handleVisitorDetail,
  handleVisitors,
} from "./journeys";
import {
  handleFilterOptions,
  handleOverview,
  handleOverviewClientTab,
  handleOverviewGeoPoints,
  handleOverviewGeoTab,
  handleOverviewPageTab,
  handleOverviewSourceTab,
  handleTrend,
} from "./overview";
import {
  handleDimension,
  handlePages,
  handlePagesDashboard,
  handleReferrers,
} from "./pages";
import { handlePerformance } from "./performance";
import {
  handleBrowserCrossBreakdown,
  handleBrowserEngineTrend,
  handleBrowserRadar,
  handleBrowserTrend,
  handleBrowserVersionBreakdown,
  handleClientDimensionTrend,
  handleCrossBreakdown,
  handleReferrerDimensionTrend,
  handleReferrerRadar,
  handleUtmDimensionTrend,
} from "./technology";

export const PUBLIC_QUERY_PATHS = [
  "overview",
  "trend",
  "pages",
  "pages-dashboard",
  "referrers",
  "retention",
  "performance",
  "countries",
  "filter-options",
  "event-types",
  "page-hash",
  "page-query",
  "overview-page-path",
  "overview-page-title",
  "overview-page-hostname",
  "overview-page-entry",
  "overview-page-exit",
  "overview-source-domain",
  "overview-source-link",
  "overview-client-browser",
  "overview-client-os-version",
  "overview-client-device-type",
  "overview-client-language",
  "overview-client-screen-size",
  "overview-geo-country",
  "overview-geo-region",
  "overview-geo-city",
  "overview-geo-continent",
  "overview-geo-timezone",
  "overview-geo-organization",
  "overview-geo-points",
  "browser-trend",
  "browser-engine-trend",
  "browser-version-breakdown",
  "browser-cross-breakdown",
  "browser-radar",
  "referrer-radar",
  "referrer-dimension-trend",
  "client-dimension-trend",
  "client-cross-breakdown",
  "utm-dimension-trend",
  "utm-source",
  "utm-medium",
  "utm-campaign",
  "utm-term",
  "utm-content",
] as const;

export const DASHBOARD_QUERY_PATHS = [
  ...PUBLIC_QUERY_PATHS,
  "events-summary",
  "events-trend",
  "events-records",
  "event-type-field-values",
  "event-type-detail",
  "event-record-detail",
  "sessions",
  "session-detail",
  "visitor-detail",
  "visitors",
  "funnels",
  "team-dashboard",
] as const;

const PUBLIC_QUERY_PATH_SET = new Set<string>(PUBLIC_QUERY_PATHS);

export async function routeQuery(
  env: Env,
  siteId: string,
  pathname: string,
  url: URL,
  options: { publicMode: boolean },
  request?: Request,
): Promise<Response> {
  const ctx: ResponseContext | undefined = request
    ? { requestId: getRequestId(request) }
    : undefined;

  if (pathname === "overview") return handleOverview(env, siteId, url, ctx);
  if (pathname === "trend") return handleTrend(env, siteId, url, ctx);
  if (pathname === "pages") {
    return handlePages(env, siteId, url, !options.publicMode, ctx);
  }
  if (pathname === "referrers") {
    return handleReferrers(
      env,
      siteId,
      url,
      options.publicMode ? 8 : 20,
      !options.publicMode,
      ctx,
    );
  }
  if (options.publicMode && !PUBLIC_QUERY_PATH_SET.has(pathname)) {
    return notFound();
  }
  if (pathname === "funnels") {
    return handleFunnel(env, siteId, url, ctx, request as Request);
  }
  if (pathname === "pages-dashboard") {
    return handlePagesDashboard(env, siteId, url, ctx);
  }
  if (pathname === "page-hash") {
    return handleDimension(env, siteId, url, "hash_fragment", undefined, ctx);
  }
  if (pathname === "page-query") {
    return handleDimension(env, siteId, url, "query_string", undefined, ctx);
  }
  if (pathname === "event-types") {
    return handleEventTypes(env, siteId, url, ctx);
  }
  if (pathname === "events-summary") {
    return handleEventsSummary(env, siteId, url, ctx);
  }
  if (pathname === "events-trend") {
    return handleEventsTrend(env, siteId, url, ctx);
  }
  if (pathname === "events-records") {
    return handleEventsRecords(env, siteId, url, ctx);
  }
  if (pathname === "event-type-field-values") {
    return handleEventTypeFieldValues(env, siteId, url, ctx);
  }
  if (pathname === "event-type-detail") {
    return handleEventTypeDetail(env, siteId, url, ctx);
  }
  if (pathname === "event-record-detail") {
    return handleEventRecordDetail(env, siteId, url, ctx);
  }
  if (pathname === "sessions") {
    return handleSessions(env, siteId, url, ctx);
  }
  if (pathname === "session-detail") {
    return handleSessionDetail(env, siteId, url, ctx);
  }
  if (pathname === "visitor-detail") {
    return handleVisitorDetail(env, siteId, url, ctx);
  }
  if (pathname === "visitors") {
    return handleVisitors(env, siteId, url, ctx);
  }
  if (pathname === "retention") {
    return handleRetention(env, siteId, url, ctx);
  }
  if (pathname === "performance") {
    return handlePerformance(env, siteId, url, ctx);
  }
  if (pathname === "browser-trend")
    return handleBrowserTrend(env, siteId, url, ctx);
  if (pathname === "browser-engine-trend") {
    return handleBrowserEngineTrend(env, siteId, url, ctx);
  }
  if (pathname === "browser-version-breakdown") {
    return handleBrowserVersionBreakdown(env, siteId, url, ctx);
  }
  if (pathname === "browser-cross-breakdown") {
    return handleBrowserCrossBreakdown(env, siteId, url, ctx);
  }
  if (pathname === "browser-radar") {
    return handleBrowserRadar(env, siteId, url, ctx);
  }
  if (pathname === "referrer-radar") {
    return handleReferrerRadar(env, siteId, url, ctx);
  }
  if (pathname === "referrer-dimension-trend") {
    return handleReferrerDimensionTrend(env, siteId, url, ctx);
  }
  if (pathname === "client-dimension-trend") {
    return handleClientDimensionTrend(env, siteId, url, ctx);
  }
  if (pathname === "utm-dimension-trend") {
    return handleUtmDimensionTrend(env, siteId, url, ctx);
  }
  if (pathname === "client-cross-breakdown") {
    return handleCrossBreakdown(env, siteId, url, ctx);
  }
  if (pathname === "utm-source") {
    return handleDimension(
      env,
      siteId,
      url,
      utmDimensionDefinition("source").labelExpr,
      undefined,
      ctx,
    );
  }
  if (pathname === "utm-medium") {
    return handleDimension(
      env,
      siteId,
      url,
      utmDimensionDefinition("medium").labelExpr,
      undefined,
      ctx,
    );
  }
  if (pathname === "utm-campaign") {
    return handleDimension(
      env,
      siteId,
      url,
      utmDimensionDefinition("campaign").labelExpr,
      undefined,
      ctx,
    );
  }
  if (pathname === "utm-term") {
    return handleDimension(
      env,
      siteId,
      url,
      utmDimensionDefinition("term").labelExpr,
      undefined,
      ctx,
    );
  }
  if (pathname === "utm-content") {
    return handleDimension(
      env,
      siteId,
      url,
      utmDimensionDefinition("content").labelExpr,
      undefined,
      ctx,
    );
  }
  if (pathname === "countries") {
    return handleDimension(
      env,
      siteId,
      url,
      "country",
      { ignoreGeo: true },
      ctx,
    );
  }
  if (pathname === "filter-options")
    return handleFilterOptions(env, siteId, url, ctx);
  if (pathname === "overview-page-path") {
    return handleOverviewPageTab(env, siteId, url, "path", ctx);
  }
  if (pathname === "overview-page-title") {
    return handleOverviewPageTab(env, siteId, url, "title", ctx);
  }
  if (pathname === "overview-page-hostname") {
    return handleOverviewPageTab(env, siteId, url, "hostname", ctx);
  }
  if (pathname === "overview-page-entry") {
    return handleOverviewPageTab(env, siteId, url, "entry", ctx);
  }
  if (pathname === "overview-page-exit") {
    return handleOverviewPageTab(env, siteId, url, "exit", ctx);
  }
  if (pathname === "overview-source-domain") {
    return handleOverviewSourceTab(env, siteId, url, "domain", ctx);
  }
  if (pathname === "overview-source-link") {
    return handleOverviewSourceTab(env, siteId, url, "link", ctx);
  }
  if (pathname === "overview-client-browser") {
    return handleOverviewClientTab(env, siteId, url, "browser", ctx);
  }
  if (pathname === "overview-client-os-version") {
    return handleOverviewClientTab(env, siteId, url, "osVersion", ctx);
  }
  if (pathname === "overview-client-device-type") {
    return handleOverviewClientTab(env, siteId, url, "deviceType", ctx);
  }
  if (pathname === "overview-client-language") {
    return handleOverviewClientTab(env, siteId, url, "language", ctx);
  }
  if (pathname === "overview-client-screen-size") {
    return handleOverviewClientTab(env, siteId, url, "screenSize", ctx);
  }
  if (pathname === "overview-geo-country") {
    return handleOverviewGeoTab(env, siteId, url, "country", ctx);
  }
  if (pathname === "overview-geo-region") {
    return handleOverviewGeoTab(env, siteId, url, "region", ctx);
  }
  if (pathname === "overview-geo-city") {
    return handleOverviewGeoTab(env, siteId, url, "city", ctx);
  }
  if (pathname === "overview-geo-continent") {
    return handleOverviewGeoTab(env, siteId, url, "continent", ctx);
  }
  if (pathname === "overview-geo-timezone") {
    return handleOverviewGeoTab(env, siteId, url, "timezone", ctx);
  }
  if (pathname === "overview-geo-organization") {
    return handleOverviewGeoTab(env, siteId, url, "organization", ctx);
  }
  if (pathname === "overview-geo-points") {
    return handleOverviewGeoPoints(env, siteId, url, ctx);
  }
  return notFound();
}
