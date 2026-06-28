import {
  PUBLIC_QUERY_CACHE_OPTIONS,
  withDashboardCache,
} from "@/lib/edge/dashboard-cache";
import type { Env } from "@/lib/edge/types";

import { jsonResponse } from "./core";
import { fetchPublicSite, notAllowed, resolvePrivateSite } from "./core";
import { routeQuery } from "./router";
import { handleTeamDashboard } from "./team";

export async function handlePrivateQuery(
  request: Request,
  env: Env,
  url: URL,
  ctx?: ExecutionContext,
): Promise<Response> {
  const pathname = url.pathname.replace(/^\/api\/private\//, "");
  const isFunnelResource = pathname === "funnels";
  if (request.method !== "GET") {
    if (
      !isFunnelResource ||
      (request.method !== "POST" && request.method !== "DELETE")
    ) {
      return notAllowed();
    }
  }
  if (pathname === "team-dashboard") {
    return handleTeamDashboard(request, env, url);
  }
  const site = await resolvePrivateSite(request, env, url);
  if (site instanceof Response) return site;
  if (isFunnelResource) {
    return routeQuery(
      env,
      site.id,
      pathname,
      url,
      { publicMode: false },
      request,
    );
  }
  // Auth has passed; wrap the read-only dispatch with the edge cache so two
  // dashboards (and two viewers of the same site) don't repeatedly re-issue
  // the same aggregation SQL against D1.
  return withDashboardCache(ctx, url, () =>
    routeQuery(env, site.id, pathname, url, { publicMode: false }, request),
  );
}

export async function handlePublicQuery(
  request: Request,
  env: Env,
  url: URL,
  ctx?: ExecutionContext,
): Promise<Response> {
  if (request.method !== "GET") return notAllowed();
  const site = await fetchPublicSite(env, url);
  if (site instanceof Response) return site;
  const segments = url.pathname.split("/").filter(Boolean);
  const pathname = segments.slice(3).join("/");
  if (pathname === "site") {
    return withDashboardCache(
      ctx,
      url,
      async () =>
        jsonResponse({
          ok: true,
          data: {
            slug: decodeURIComponent(segments[2] || ""),
            name: site.name,
            domain: site.domain,
            id: site.id,
          },
        }),
      PUBLIC_QUERY_CACHE_OPTIONS,
    );
  }
  return withDashboardCache(
    ctx,
    url,
    () =>
      routeQuery(env, site.id, pathname, url, { publicMode: true }, request),
    PUBLIC_QUERY_CACHE_OPTIONS,
  );
}
