import { findSiteProfileByPublicSlug } from "@/lib/demo/data/site-profiles";
import { demoLocale } from "@/lib/demo/notifications/rules";
import {
  demoBadRequest,
  demoOk,
  extractErrorMessage,
  isErrorEnvelope,
} from "@/lib/demo/realtime/envelope";
import { DemoInvalidCursorError } from "@/lib/demo/realtime/pagination";
import { handleDemoSavedFilters } from "@/lib/demo/realtime/saved-filters";

import { handleDemoAdminRoutes } from "./runtime/admin-routes";
import {
  handleDemoAnalyticsRoutes,
  handleDemoAnalyticsWrite,
} from "./runtime/analytics-routes";
import type { DemoRequestOptions, DemoRuntimeContext } from "./runtime/context";
import {
  handleDemoPublicRoutes,
  handleDemoPublicSiteRoute,
} from "./runtime/public-routes";
import { demoNotFoundResponse } from "./runtime/shared";
function handleDemoRequestInner(options: DemoRequestOptions): unknown {
  const { path, method = "GET", params = {} } = options;
  const publicRouteMatch = path.match(/\/api\/public\/share\/([^/]+)\//);
  const publicSiteProfile = publicRouteMatch
    ? findSiteProfileByPublicSlug(publicRouteMatch[1] || "")
    : null;
  const apiV1SiteMatch = path.match(/\/api\/v1\/sites\/([^/]+)/);
  const siteId = String(
    params.siteId ||
      apiV1SiteMatch?.[1] ||
      publicSiteProfile?.id ||
      "demo-site-001",
  );
  const teamId = String(params.teamId || "");
  const bodyRecord =
    options.body && typeof options.body === "object"
      ? (options.body as Record<string, unknown>)
      : {};
  const locale = demoLocale(params.locale ?? bodyRecord.locale);
  const context: DemoRuntimeContext = {
    path,
    method,
    params,
    body: options.body,
    bodyRecord,
    siteId,
    teamId,
    locale,
    publicSiteProfile,
  };

  if (path.startsWith("/api/private/saved-filters")) {
    return handleDemoSavedFilters({
      path,
      method,
      siteId,
      params,
      body: options.body,
    });
  }

  const analyticsWrite = handleDemoAnalyticsWrite(context);
  if (analyticsWrite !== undefined) return analyticsWrite;

  const adminResult = handleDemoAdminRoutes(context);
  if (adminResult !== undefined) return adminResult;

  const publicSiteResult = handleDemoPublicSiteRoute(context);
  if (publicSiteResult !== undefined) return publicSiteResult;

  const analyticsResult = handleDemoAnalyticsRoutes(context);
  if (analyticsResult !== undefined) return analyticsResult;

  const publicResult = handleDemoPublicRoutes(context);
  if (publicResult !== undefined) return publicResult;
  return demoNotFoundResponse();
}
export function handleDemoRequest(options: DemoRequestOptions): unknown {
  try {
    const result: unknown = handleDemoRequestInner(options);
    if (
      result &&
      typeof result === "object" &&
      (result as { ok?: unknown }).ok === true &&
      typeof (result as { requestId?: unknown }).requestId !== "string"
    ) {
      return demoOk({ ...(result as Record<string, unknown>) });
    }
    return result;
  } catch (error) {
    if (error instanceof DemoInvalidCursorError)
      return demoBadRequest("Invalid cursor");
    throw error;
  }
}
export function demoRequest(
  options: Parameters<typeof handleDemoRequest>[0],
): unknown {
  const result = handleDemoRequest(options);
  if (isErrorEnvelope(result)) throw new Error(extractErrorMessage(result));
  return result;
}
