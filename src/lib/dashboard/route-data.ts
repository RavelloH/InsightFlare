import { createServerFn } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";

import { publicDashboardSiteId } from "@/lib/dashboard/client-request";
import { resolveDashboardInitialWindow } from "@/lib/dashboard/query-preferences";
import type { TimeWindow } from "@/lib/dashboard/query-state";
import {
  getDashboardRootContext,
  getDashboardTeamContext,
  getTeamSiteContext,
} from "@/lib/dashboard/server";
import { resolveTeamDashboardRequest } from "@/lib/dashboard/server-query";
import type { TeamDashboardSnapshot } from "@/lib/dashboard/team-dashboard-query";
import { readTeamDashboard } from "@/lib/edge/query-runtime/team-dashboard";
import { resolveEdgeRuntime } from "@/lib/edge/runtime";
import { fetchPublicSite } from "@/lib/edge-client";
import { fetchGithubReleases } from "@/lib/github-releases";

export const loadDashboardRoot = createServerFn({ method: "GET" }).handler(() =>
  getDashboardRootContext(),
);

/** Provides the SSR-safe initial query window to the dashboard shell. */
export const loadDashboardInitialWindow = createServerFn({
  method: "GET",
}).handler(
  (): TimeWindow =>
    resolveDashboardInitialWindow(getRequest().headers.get("cookie")),
);

export const loadDashboardTeam = createServerFn({ method: "GET" })
  .validator((data: { teamSlug: string }) => data)
  .handler(({ data }) => getDashboardTeamContext(data.teamSlug));

/** Loads the first team-dashboard snapshot on the server for a stable hydrate. */
export const loadTeamDashboardSnapshot = createServerFn({ method: "GET" })
  .validator((data: { teamId: string }) => data)
  .handler(async ({ data }): Promise<TeamDashboardSnapshot | null> => {
    const request = getRequest();
    const runtime = await resolveEdgeRuntime(request);
    const resolved = await resolveTeamDashboardRequest({
      request,
      env: runtime.env,
      teamId: data.teamId,
    });
    if (resolved instanceof Response) return null;

    const window = resolveDashboardInitialWindow(request.headers.get("cookie"));
    const result = await readTeamDashboard({
      env: resolved.env,
      teamId: resolved.teamId,
      window: {
        startMs: window.from,
        endExclusiveMs: window.to,
        nowMs: window.to,
        timeZone: window.timeZone,
      },
      interval: window.interval,
      allowedSiteIds: resolved.allowedSiteIds,
    });
    return {
      data: result.data,
      window: {
        from: window.from,
        to: window.to,
        interval: window.interval,
        timeZone: window.timeZone,
      },
      range: window.preset,
      fetchedAt: Date.now(),
    };
  });

export const loadDashboardSite = createServerFn({ method: "GET" })
  .validator((data: { teamSlug: string; siteSlug: string }) => data)
  .handler(({ data }) => getTeamSiteContext(data.teamSlug, data.siteSlug));

export const loadShareSite = createServerFn({ method: "GET" })
  .validator((data: { slug: string }) => data)
  .handler(async ({ data }) => {
    try {
      const site = await fetchPublicSite(data.slug);
      return { site, publicSiteId: publicDashboardSiteId(data.slug) };
    } catch {
      return null;
    }
  });

export const loadRequestOrigin = createServerFn({ method: "GET" }).handler(
  () => {
    const request = getRequest();
    const host =
      request.headers.get("x-forwarded-host") || request.headers.get("host");
    if (!host) return "";
    const proto =
      request.headers.get("x-forwarded-proto") ||
      (host.startsWith("localhost") || host.startsWith("127.0.0.1")
        ? "http"
        : "https");
    return `${proto}://${host}`;
  },
);

export const loadVersionReleases = createServerFn({ method: "GET" }).handler(
  async () => {
    try {
      return {
        releases: await fetchGithubReleases("RavelloH", "InsightFlare"),
        error: null,
      };
    } catch (error) {
      return {
        releases: [],
        error: error instanceof Error ? error.message : "Unknown error",
      };
    }
  },
);
