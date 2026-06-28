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

export interface QueryRouteContext {
  env: Env;
  siteId: string;
  url: URL;
  options: { publicMode: boolean };
  request?: Request;
  responseContext?: ResponseContext;
}

export type QueryRouteHandler = (
  context: QueryRouteContext,
) => Promise<Response>;

export const QUERY_ROUTE_HANDLERS: Record<string, QueryRouteHandler> = {
  overview: ({ env, siteId, url, responseContext }) =>
    handleOverview(env, siteId, url, responseContext),
  trend: ({ env, siteId, url, responseContext }) =>
    handleTrend(env, siteId, url, responseContext),
  pages: ({ env, siteId, url, options, responseContext }) =>
    handlePages(env, siteId, url, !options.publicMode, responseContext),
  referrers: ({ env, siteId, url, options, responseContext }) =>
    handleReferrers(
      env,
      siteId,
      url,
      options.publicMode ? 8 : 20,
      !options.publicMode,
      responseContext,
    ),
  funnels: ({ env, siteId, url, request, responseContext }) =>
    handleFunnel(env, siteId, url, responseContext, request as Request),
  "pages-dashboard": ({ env, siteId, url, responseContext }) =>
    handlePagesDashboard(env, siteId, url, responseContext),
  "page-hash": ({ env, siteId, url, responseContext }) =>
    handleDimension(
      env,
      siteId,
      url,
      "hash_fragment",
      undefined,
      responseContext,
    ),
  "page-query": ({ env, siteId, url, responseContext }) =>
    handleDimension(
      env,
      siteId,
      url,
      "query_string",
      undefined,
      responseContext,
    ),
  "event-types": ({ env, siteId, url, responseContext }) =>
    handleEventTypes(env, siteId, url, responseContext),
  "events-summary": ({ env, siteId, url, responseContext }) =>
    handleEventsSummary(env, siteId, url, responseContext),
  "events-trend": ({ env, siteId, url, responseContext }) =>
    handleEventsTrend(env, siteId, url, responseContext),
  "events-records": ({ env, siteId, url, responseContext }) =>
    handleEventsRecords(env, siteId, url, responseContext),
  "event-type-field-values": ({ env, siteId, url, responseContext }) =>
    handleEventTypeFieldValues(env, siteId, url, responseContext),
  "event-type-detail": ({ env, siteId, url, responseContext }) =>
    handleEventTypeDetail(env, siteId, url, responseContext),
  "event-record-detail": ({ env, siteId, url, responseContext }) =>
    handleEventRecordDetail(env, siteId, url, responseContext),
  sessions: ({ env, siteId, url, responseContext }) =>
    handleSessions(env, siteId, url, responseContext),
  "session-detail": ({ env, siteId, url, responseContext }) =>
    handleSessionDetail(env, siteId, url, responseContext),
  "visitor-detail": ({ env, siteId, url, responseContext }) =>
    handleVisitorDetail(env, siteId, url, responseContext),
  visitors: ({ env, siteId, url, responseContext }) =>
    handleVisitors(env, siteId, url, responseContext),
  retention: ({ env, siteId, url, responseContext }) =>
    handleRetention(env, siteId, url, responseContext),
  performance: ({ env, siteId, url, responseContext }) =>
    handlePerformance(env, siteId, url, responseContext),
  "browser-trend": ({ env, siteId, url, responseContext }) =>
    handleBrowserTrend(env, siteId, url, responseContext),
  "browser-engine-trend": ({ env, siteId, url, responseContext }) =>
    handleBrowserEngineTrend(env, siteId, url, responseContext),
  "browser-version-breakdown": ({ env, siteId, url, responseContext }) =>
    handleBrowserVersionBreakdown(env, siteId, url, responseContext),
  "browser-cross-breakdown": ({ env, siteId, url, responseContext }) =>
    handleBrowserCrossBreakdown(env, siteId, url, responseContext),
  "browser-radar": ({ env, siteId, url, responseContext }) =>
    handleBrowserRadar(env, siteId, url, responseContext),
  "referrer-radar": ({ env, siteId, url, responseContext }) =>
    handleReferrerRadar(env, siteId, url, responseContext),
  "referrer-dimension-trend": ({ env, siteId, url, responseContext }) =>
    handleReferrerDimensionTrend(env, siteId, url, responseContext),
  "client-dimension-trend": ({ env, siteId, url, responseContext }) =>
    handleClientDimensionTrend(env, siteId, url, responseContext),
  "utm-dimension-trend": ({ env, siteId, url, responseContext }) =>
    handleUtmDimensionTrend(env, siteId, url, responseContext),
  "client-cross-breakdown": ({ env, siteId, url, responseContext }) =>
    handleCrossBreakdown(env, siteId, url, responseContext),
  "utm-source": ({ env, siteId, url, responseContext }) =>
    handleDimension(
      env,
      siteId,
      url,
      utmDimensionDefinition("source").labelExpr,
      undefined,
      responseContext,
    ),
  "utm-medium": ({ env, siteId, url, responseContext }) =>
    handleDimension(
      env,
      siteId,
      url,
      utmDimensionDefinition("medium").labelExpr,
      undefined,
      responseContext,
    ),
  "utm-campaign": ({ env, siteId, url, responseContext }) =>
    handleDimension(
      env,
      siteId,
      url,
      utmDimensionDefinition("campaign").labelExpr,
      undefined,
      responseContext,
    ),
  "utm-term": ({ env, siteId, url, responseContext }) =>
    handleDimension(
      env,
      siteId,
      url,
      utmDimensionDefinition("term").labelExpr,
      undefined,
      responseContext,
    ),
  "utm-content": ({ env, siteId, url, responseContext }) =>
    handleDimension(
      env,
      siteId,
      url,
      utmDimensionDefinition("content").labelExpr,
      undefined,
      responseContext,
    ),
  countries: ({ env, siteId, url, responseContext }) =>
    handleDimension(
      env,
      siteId,
      url,
      "country",
      { ignoreGeo: true },
      responseContext,
    ),
  "filter-options": ({ env, siteId, url, responseContext }) =>
    handleFilterOptions(env, siteId, url, responseContext),
  "overview-page-path": ({ env, siteId, url, responseContext }) =>
    handleOverviewPageTab(env, siteId, url, "path", responseContext),
  "overview-page-title": ({ env, siteId, url, responseContext }) =>
    handleOverviewPageTab(env, siteId, url, "title", responseContext),
  "overview-page-hostname": ({ env, siteId, url, responseContext }) =>
    handleOverviewPageTab(env, siteId, url, "hostname", responseContext),
  "overview-page-entry": ({ env, siteId, url, responseContext }) =>
    handleOverviewPageTab(env, siteId, url, "entry", responseContext),
  "overview-page-exit": ({ env, siteId, url, responseContext }) =>
    handleOverviewPageTab(env, siteId, url, "exit", responseContext),
  "overview-source-domain": ({ env, siteId, url, responseContext }) =>
    handleOverviewSourceTab(env, siteId, url, "domain", responseContext),
  "overview-source-link": ({ env, siteId, url, responseContext }) =>
    handleOverviewSourceTab(env, siteId, url, "link", responseContext),
  "overview-client-browser": ({ env, siteId, url, responseContext }) =>
    handleOverviewClientTab(env, siteId, url, "browser", responseContext),
  "overview-client-os-version": ({ env, siteId, url, responseContext }) =>
    handleOverviewClientTab(env, siteId, url, "osVersion", responseContext),
  "overview-client-device-type": ({ env, siteId, url, responseContext }) =>
    handleOverviewClientTab(env, siteId, url, "deviceType", responseContext),
  "overview-client-language": ({ env, siteId, url, responseContext }) =>
    handleOverviewClientTab(env, siteId, url, "language", responseContext),
  "overview-client-screen-size": ({ env, siteId, url, responseContext }) =>
    handleOverviewClientTab(env, siteId, url, "screenSize", responseContext),
  "overview-geo-country": ({ env, siteId, url, responseContext }) =>
    handleOverviewGeoTab(env, siteId, url, "country", responseContext),
  "overview-geo-region": ({ env, siteId, url, responseContext }) =>
    handleOverviewGeoTab(env, siteId, url, "region", responseContext),
  "overview-geo-city": ({ env, siteId, url, responseContext }) =>
    handleOverviewGeoTab(env, siteId, url, "city", responseContext),
  "overview-geo-continent": ({ env, siteId, url, responseContext }) =>
    handleOverviewGeoTab(env, siteId, url, "continent", responseContext),
  "overview-geo-timezone": ({ env, siteId, url, responseContext }) =>
    handleOverviewGeoTab(env, siteId, url, "timezone", responseContext),
  "overview-geo-organization": ({ env, siteId, url, responseContext }) =>
    handleOverviewGeoTab(env, siteId, url, "organization", responseContext),
  "overview-geo-points": ({ env, siteId, url, responseContext }) =>
    handleOverviewGeoPoints(env, siteId, url, responseContext),
};

export function queryRouteHandler(
  pathname: string,
  options: { publicMode: boolean },
): QueryRouteHandler | null {
  if (options.publicMode && !PUBLIC_QUERY_PATH_SET.has(pathname)) {
    return null;
  }
  return QUERY_ROUTE_HANDLERS[pathname] ?? null;
}

export async function dispatchQueryRoute(
  env: Env,
  siteId: string,
  pathname: string,
  url: URL,
  options: { publicMode: boolean },
  request?: Request,
): Promise<Response> {
  const responseContext: ResponseContext | undefined = request
    ? { requestId: getRequestId(request) }
    : undefined;
  const handler = queryRouteHandler(pathname, options);
  if (!handler) return notFound();
  return handler({ env, siteId, url, options, request, responseContext });
}

/**
 * Compatibility wrapper. Production Hono routing calls dispatchQueryRoute.
 */
export async function routeQuery(
  env: Env,
  siteId: string,
  pathname: string,
  url: URL,
  options: { publicMode: boolean },
  request?: Request,
): Promise<Response> {
  return dispatchQueryRoute(env, siteId, pathname, url, options, request);
}
