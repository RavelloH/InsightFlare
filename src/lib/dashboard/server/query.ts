import "@tanstack/react-start/server-only";

import { readBoundedBody } from "@/lib/api-v1";
import { startTechnologyInitialReads } from "@/lib/dashboard/client/data/browser";
import { startEventsInitialReads } from "@/lib/dashboard/client/data/events";
import { startGeoInitialReads } from "@/lib/dashboard/client/data/geo";
import { startOverviewInitialReads } from "@/lib/dashboard/client/data/overview";
import { startPagesInitialReads } from "@/lib/dashboard/client/data/pages";
import { startPerformanceInitialReads } from "@/lib/dashboard/client/data/performance";
import {
  startCampaignsInitialReads,
  startReferrersInitialReads,
} from "@/lib/dashboard/client/data/referrers";
import { startSessionsInitialReads } from "@/lib/dashboard/client/data/sessions";
import type {
  PrivateReadTransport,
  PrivateRequestParams,
} from "@/lib/dashboard/client/data/types";
import { startVisitorsInitialReads } from "@/lib/dashboard/client/data/visitors";
import {
  type DeferredPrivateReads,
  privateReadIdentity,
} from "@/lib/dashboard/client/request";
import { toQueryString } from "@/lib/dashboard/client/utils";
import type { ManagementJsonValue } from "@/lib/dashboard/management-data";
import { readReportingTimeZoneFromCookie } from "@/lib/dashboard/query-preferences";
import type { TimeWindow } from "@/lib/dashboard/query-state";
import type { TeamDashboardData } from "@/lib/dashboard/team-dashboard-query";
import { runWithDimensionPageBatch } from "@/lib/edge/analytics/composition";
import { withDashboardCache } from "@/lib/edge/analytics/composition/dashboard-cache";
import {
  resolveDashboardSession,
  resolveTeamDashboardScope,
} from "@/lib/edge/analytics/composition/ssr-query-runtime";
import {
  executePrivateQuery,
  executePrivateTeamDashboard,
} from "@/lib/edge/analytics/interfaces/dashboard/private";
import type { EdgeSessionClaims } from "@/lib/edge/auth/session-auth";
import {
  resolvePrivateSite,
  resolvePrivateSiteForSession,
} from "@/lib/edge/auth/site-access";
import { currentInvocationLogger } from "@/lib/edge/observability/logger";
import { appNow } from "@/lib/edge/runtime/e2e-clock";
import type { Env } from "@/lib/edge/types";

export interface ResolvedTeamDashboardRequest {
  readonly env: Env;
  readonly request: Request;
  readonly session: EdgeSessionClaims;
  readonly teamId: string;
  readonly allowedSiteIds?: readonly string[];
  readonly timeZone: string;
}

export type TeamDashboardRequestResolution =
  ResolvedTeamDashboardRequest | Response;

/** Resolves authenticated SSR inputs without bypassing existing team ACLs. */
export async function resolveTeamDashboardRequest(input: {
  request: Request;
  env: Env;
  teamId: string;
}): Promise<TeamDashboardRequestResolution> {
  const team = await resolveTeamDashboardScope(input);
  if (team instanceof Response) return team;

  return {
    env: input.env,
    request: input.request,
    session: team.session,
    teamId: team.teamId,
    allowedSiteIds: team.allowedSiteIds,
    timeZone: readReportingTimeZoneFromCookie(
      input.request.headers.get("cookie"),
    ),
  };
}

/** Share the exact authenticated HTTP cache and response contract for sidebar
 * snapshots. No self-HTTP, no cross-user/site-ACL cache reuse. */
export async function readCachedSidebarTeamDashboard(
  resolved: ResolvedTeamDashboardRequest,
  window: TimeWindow,
): Promise<TeamDashboardData | null> {
  const url = new URL("/api/private/team-dashboard", resolved.request.url);
  url.search = new URLSearchParams({
    teamId: resolved.teamId,
    from: String(window.from),
    to: String(window.to),
    interval: window.interval,
    timeZone: window.timeZone,
  }).toString();
  const request = new Request(url, {
    headers: resolved.request.headers,
    signal: resolved.request.signal,
  });
  const logger = currentInvocationLogger();
  const context = logger
    ? ({
        waitUntil: (work: Promise<unknown>) => {
          logger.track(work);
        },
      } as ExecutionContext)
    : undefined;
  const response = await withDashboardCache(
    context,
    url,
    () =>
      executePrivateTeamDashboard({
        env: resolved.env,
        teamId: resolved.teamId,
        allowedSiteIds: resolved.allowedSiteIds,
        url,
      }),
    {
      identity: {
        scope: "private-team",
        tenantId: resolved.teamId,
        route: "team-dashboard",
        audienceId: resolved.session.userId,
        allowedSiteIds: resolved.allowedSiteIds,
      },
      request,
    },
  );
  if (!response.ok) return null;
  const body = await readBoundedBody(response, 2 * 1024 * 1024);
  if (!body.ok) return null;
  const payload = JSON.parse(
    new TextDecoder("utf-8", { fatal: true }).decode(body.bytes),
  ) as {
    ok: boolean;
    data?: TeamDashboardData;
  };
  return payload.ok && payload.data ? payload.data : null;
}

/** Open one authenticated request-local execution scope. The returned map
 * contains independent promises; Start may stream each as soon as it settles.
 * Register reads (and cache writes) before the Worker returns its response,
 * so its existing emitWhenComplete drains the real work exactly once. */
export type SiteAnalyticsInitialPage =
  | "overview"
  | "pages"
  | "referrers"
  | "campaigns"
  | "browsers"
  | "devices"
  | "geo"
  | "performance"
  | "events"
  | "visitors"
  | "sessions";
export async function startSiteAnalyticsStream(input: {
  request: Request;
  env: Env;
  siteId: string;
  window: TimeWindow;
  search: string;
  page?: SiteAnalyticsInitialPage;
}): Promise<DeferredPrivateReads> {
  const { request, env, siteId, window, search, page = "overview" } = input;
  const authUrl = new URL(request.url);
  authUrl.searchParams.set("siteId", siteId);
  const demoSession =
    import.meta.env.VITE_DEMO_MODE === "1"
      ? await resolveDashboardSession(request, env)
      : null;
  const site = demoSession
    ? await resolvePrivateSiteForSession(request, env, authUrl, demoSession)
    : await resolvePrivateSite(request, env, authUrl);
  if (site instanceof Response) return {};
  const reads: DeferredPrivateReads = {};
  const pending = new Map<string, Promise<ManagementJsonValue>>();
  const logger = currentInvocationLogger();
  // A fixed page identifier separates complete SSR invocations from CSR APIs.
  if (!authUrl.pathname.startsWith("/_serverFn/")) {
    logger?.setRouteKey(`page.dashboard.analytics.${page}`);
  }
  const capturedAtMs = appNow();
  const cacheContext = logger
    ? ({
        waitUntil: (work: Promise<unknown>) => {
          logger.track(work);
        },
      } as ExecutionContext)
    : undefined;
  const allowedPaths = new Set(
    page === "events"
      ? [
          "events-summary",
          "events-trend",
          "events-records",
          "events-compare-name",
          "events-compare-path",
        ]
      : page === "visitors"
        ? ["visitors"]
        : page === "sessions"
          ? ["sessions"]
          : page === "geo"
            ? [
                "overview-geo-points",
                "overview-geo-country",
                "overview-geo-region",
                "overview-geo-city",
              ]
            : page === "performance"
              ? ["performance"]
              : page === "browsers"
                ? [
                    "browser-trend",
                    "browser-engine-trend",
                    "browser-radar",
                    "browser-version-breakdown",
                    "browser-cross-breakdown",
                  ]
                : page === "devices"
                  ? ["client-dimension-trend", "client-cross-breakdown"]
                  : page === "campaigns"
                    ? ["utm-dimension-trend", "utm-source", "utm-term"]
                    : page === "pages"
                      ? ["pages-dashboard", "trend"]
                      : page === "referrers"
                        ? [
                            "referrer-summary",
                            "referrer-channel-dimension-trend",
                            "referrer-radar",
                            "overview-source-domain",
                            "overview-source-channel",
                          ]
                        : [
                            "overview",
                            "overview-page-path",
                            "overview-source-domain",
                            "overview-client-browser",
                            "overview-geo-country",
                            "overview-geo-points",
                          ],
  );
  const transport: PrivateReadTransport = <T>(
    path: string,
    params?: PrivateRequestParams,
  ): Promise<T> => {
    const pathname = path.replace(/^\/api\/private\//, "");
    if (
      !allowedPaths.has(pathname) ||
      path !== "/api/private/" + pathname ||
      params?.siteId !== site.id
    )
      return Promise.reject(new Error("invalid_ssr_query"));
    const key = privateReadIdentity(path, params);
    const existing = pending.get(key);
    if (existing) return existing as Promise<T>;
    const url = new URL(path + toQueryString(params), request.url);
    const child = new Request(url, {
      headers: request.headers,
      signal: request.signal,
    });
    // Large map responses are already JSON. Preserve the bounded UTF-8 body
    // instead of parsing thousands of rows and walking them again in Seroval.
    // Both geo planners start the raw request without consuming its value.
    const rawJson = pathname === "overview-geo-points";
    const execute = async (): Promise<ManagementJsonValue> => {
      const response = await withDashboardCache(
        cacheContext,
        url,
        () =>
          executePrivateQuery({
            env,
            siteId: site.id,
            pathname,
            url,
            request: child,
            dashboardMode: true,
            deferJsonSerialization: rawJson,
            batchExecution: { capturedAtMs, signal: request.signal },
          }),
        {
          identity: { scope: "private", tenantId: site.id, route: pathname },
          // Map normalization discards requestId/timestamp. On a cache hit
          // the sanitized JSON is sufficient; don't parse and re-stringify
          // the entire map just to reconstruct those two envelope fields.
          request: rawJson ? undefined : child,
          canonicalDeferredJson: rawJson,
        },
      );
      if (!response.ok) throw new Error("ssr_query_failed_" + response.status);
      const body = await readBoundedBody(response, 2 * 1024 * 1024);
      if (!body.ok) throw new Error("ssr_query_response_limit");
      const text = new TextDecoder("utf-8", { fatal: true }).decode(body.bytes);
      return rawJson ? text : (JSON.parse(text) as ManagementJsonValue);
    };
    const promise = logger
      ? logger.measure("dashboard.ssr.analytics", execute, {
          operation: pathname,
        })
      : execute();
    pending.set(key, promise);
    const deferred = promise.then(
      (value) =>
        rawJson && typeof value === "string" ? { json: value } : { value },
      () => null,
    );
    reads[key] = logger ? logger.track(deferred) : deferred;
    return promise as Promise<T>;
  };
  if (page === "events" || page === "visitors" || page === "sessions") {
    const start =
      page === "events"
        ? startEventsInitialReads
        : page === "visitors"
          ? startVisitorsInitialReads
          : startSessionsInitialReads;
    start(site.id, window, new URLSearchParams(search), transport);
    return reads;
  }
  if (page === "geo" || page === "performance") {
    const start =
      page === "geo" ? startGeoInitialReads : startPerformanceInitialReads;
    start(site.id, window, new URLSearchParams(search), transport);
    return reads;
  }
  if (page === "browsers" || page === "devices") {
    startTechnologyInitialReads(
      page,
      site.id,
      window,
      new URLSearchParams(search),
      transport,
    );
    return reads;
  }
  if (page === "campaigns") {
    startCampaignsInitialReads(
      site.id,
      window,
      new URLSearchParams(search),
      transport,
    );
    return reads;
  }
  if (page === "referrers") {
    startReferrersInitialReads(
      site.id,
      window,
      new URLSearchParams(search),
      transport,
    );
    return reads;
  }
  if (page === "pages") {
    startPagesInitialReads(
      site.id,
      window,
      new URLSearchParams(search),
      transport,
    );
    return reads;
  }
  startOverviewInitialReads(
    site.id,
    window,
    new URLSearchParams(search),
    transport,
    (action) => {
      const batch = runWithDimensionPageBatch(action, "private-dashboard");
      return logger ? logger.track(batch) : batch;
    },
  );
  return reads;
}
