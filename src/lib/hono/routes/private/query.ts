import type { Context } from "hono";
import { Hono } from "hono";
import { z } from "zod";

import { readBoundedBody } from "@/lib/api-v1";
import { runWithDimensionPageBatch } from "@/lib/edge/analytics/composition";
import { withDashboardCache } from "@/lib/edge/analytics/composition/dashboard-cache";
import { resolveTeamDashboardScope } from "@/lib/edge/analytics/composition/ssr-query-runtime";
import {
  executePrivateQuery,
  executePrivateTeamDashboard,
} from "@/lib/edge/analytics/interfaces/dashboard/private";
import { notAllowed } from "@/lib/edge/analytics/interfaces/dashboard/protocol/responses";
import { DASHBOARD_QUERY_PATHS } from "@/lib/edge/analytics/interfaces/dashboard/protocol/router";
import { appNow } from "@/lib/edge/runtime/e2e-clock";
import { dashboardCacheMiddleware } from "@/lib/hono/middleware/dashboard-cache";
import {
  requireMethodMiddleware,
  requireMethodsMiddleware,
} from "@/lib/hono/middleware/method";
import { resolvePrivateSiteMiddleware } from "@/lib/hono/middleware/site";
import type { AppEnv } from "@/lib/hono/types";
import { executionContext, requestUrl } from "@/lib/hono/utils/context";
import { forb } from "@/lib/response";
const FUNNEL_PATH = "funnels";
const GOAL_PATH = "goals";
const TEAM_DASHBOARD_PATH = "team-dashboard";
function privateQuery(pathname: string) {
  return (c: Context<AppEnv>) => {
    const site = c.get("privateSite");
    if (!site) {
      throw new Error("private site context missing");
    }
    return executePrivateQuery({
      env: c.env,
      siteId: site.id,
      pathname,
      url: requestUrl(c),
      request: c.req.raw,
      dashboardMode: true,
    });
  };
}
export const privateQueryRoutes = new Hono<AppEnv>();
const PRIVATE_BATCH_MAX_BYTES = 48 * 1024;
const PRIVATE_BATCH_ITEM_MAX_BYTES = 512 * 1024;
const PRIVATE_BATCH_PATHS = new Set([
  "overview-page-path",
  "overview-page-title",
  "overview-page-hostname",
  "page-query",
  "overview-source-channel",
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
]);
const privateBatchSchema = z
  .object({
    items: z
      .array(
        z
          .object({
            path: z.string().refine((path) => PRIVATE_BATCH_PATHS.has(path)),
            query: z.string().max(8192),
          })
          .strict(),
      )
      .min(2)
      .max(4),
  })
  .strict();

/**
 * A bounded, same-site read-only pilot. Keep every child's canonical adapter,
 * validation and cache identity. Never dispatch arbitrary URLs or mutations.
 */
privateQueryRoutes.post(
  "/query-batch",
  resolvePrivateSiteMiddleware(),
  async (c) => {
    const site = c.get("privateSite");
    if (!site) throw new Error("private site context missing");
    const request = c.req.raw;
    const headers = {
      "cache-control": "private, no-store",
      vary: "authorization, cookie",
    };
    const fail = (status: 400 | 413 | 415, code: string) =>
      c.json({ ok: false, error: { code } }, status, headers);
    if (
      request.headers
        .get("content-type")
        ?.split(";")[0]
        ?.trim()
        .toLowerCase() !== "application/json"
    )
      return fail(415, "unsupported_media_type");
    const encoding = request.headers.get("content-encoding");
    if (encoding && encoding.trim().toLowerCase() !== "identity")
      return fail(415, "unsupported_media_type");
    const bounded = await readBoundedBody(request, PRIVATE_BATCH_MAX_BYTES);
    if (!bounded.ok)
      return bounded.reason === "too_large"
        ? fail(413, "body_too_large")
        : fail(400, "invalid_body");
    let parsed: unknown;
    try {
      parsed = JSON.parse(
        new TextDecoder("utf-8", { fatal: true }).decode(bounded.bytes),
      );
    } catch {
      return fail(400, "invalid_json");
    }
    const body = privateBatchSchema.safeParse(parsed);
    if (!body.success) return fail(400, "invalid_batch");
    const parentUrl = requestUrl(c);
    const items = body.data.items.map((item) => {
      const url = new URL(parentUrl);
      url.pathname = "/api/private/" + item.path;
      url.search = item.query;
      const siteIds = url.searchParams.getAll("siteId");
      const limit = Number(url.searchParams.get("limit"));
      if (
        siteIds.length !== 1 ||
        siteIds[0] !== site.id ||
        !Number.isInteger(limit) ||
        limit < 1 ||
        limit > 100 ||
        !url.searchParams.has("from") ||
        !url.searchParams.has("to") ||
        url.searchParams.has("compare")
      )
        return null;
      return { path: item.path, url };
    });
    if (items.some((item) => item === null))
      return fail(400, "invalid_batch_item");

    const capturedAtMs = appNow();
    const childHeaders = new Headers(request.headers);
    childHeaders.delete("content-length");
    childHeaders.delete("content-type");
    const results = await runWithDimensionPageBatch(
      () =>
        Promise.all(
          items.map(async (item) => {
            if (!item) throw new Error("Invalid batch item");
            try {
              const child = new Request(item.url, {
                headers: childHeaders,
                signal: request.signal,
              });
              const response = await withDashboardCache(
                executionContext(c),
                item.url,
                () =>
                  executePrivateQuery({
                    env: c.env,
                    siteId: site.id,
                    pathname: item.path,
                    url: item.url,
                    request: child,
                    dashboardMode: true,
                    batchExecution: { capturedAtMs, signal: request.signal },
                  }),
                {
                  identity: {
                    scope: "private",
                    tenantId: site.id,
                    route: item.path,
                  },
                  request: child,
                },
              );
              const result = await readBoundedBody(
                response,
                PRIVATE_BATCH_ITEM_MAX_BYTES,
              );
              if (!result.ok)
                return {
                  status: 502,
                  body: {
                    ok: false,
                    error: { code: "invalid_batch_response" },
                  },
                };
              return {
                status: response.status,
                body: JSON.parse(
                  new TextDecoder("utf-8", { fatal: true }).decode(
                    result.bytes,
                  ),
                ) as unknown,
              };
            } catch {
              return {
                status: 500,
                body: { ok: false, error: { code: "internal" } },
              };
            }
          }),
        ),
      "private-dashboard",
    );
    return c.json({ ok: true, items: results }, 200, headers);
  },
);

privateQueryRoutes.all("/team-dashboard", async (c) => {
  if (c.req.raw.method !== "GET") return notAllowed();
  const session = c.get("session");
  if (!session) {
    throw new Error("private session context missing");
  }
  const url = requestUrl(c);
  const team = await resolveTeamDashboardScope({
    request: c.req.raw,
    env: c.env,
    teamId: url.searchParams.get("teamId") || "",
    session,
  });
  if (team instanceof Response) return team;

  return withDashboardCache(
    executionContext(c),
    url,
    () =>
      executePrivateTeamDashboard({
        env: c.env,
        teamId: team.teamId,
        allowedSiteIds: team.allowedSiteIds,
        url,
      }),
    {
      identity: {
        scope: "private-team",
        tenantId: team.teamId,
        route: "team-dashboard",
        audienceId: session.userId,
        allowedSiteIds: team.allowedSiteIds,
      },
      request: c.req.raw,
    },
  );
});
privateQueryRoutes.use(
  `/${FUNNEL_PATH}`,
  requireMethodsMiddleware(["GET", "POST", "PATCH", "DELETE"]),
);
privateQueryRoutes.all(
  `/${FUNNEL_PATH}`,
  resolvePrivateSiteMiddleware(),
  async (c) => {
    const method = c.req.raw.method;
    const site = c.get("privateSite");
    if (method !== "GET" && !site?.canManage) {
      return forb(
        "Funnel mutations require team owner or admin access",
        undefined,
        c.req.raw,
      );
    }
    return privateQuery(FUNNEL_PATH)(c);
  },
);
privateQueryRoutes.use(
  `/${GOAL_PATH}`,
  requireMethodsMiddleware(["GET", "POST", "PATCH", "DELETE"]),
);
privateQueryRoutes.all(
  `/${GOAL_PATH}`,
  resolvePrivateSiteMiddleware(),
  async (c) => {
    const method = c.req.raw.method;
    const site = c.get("privateSite");
    if (method !== "GET" && !site?.canManage) {
      return forb(
        "Goal mutations require team owner or admin access",
        undefined,
        c.req.raw,
      );
    }
    return privateQuery(GOAL_PATH)(c);
  },
);
for (const path of DASHBOARD_QUERY_PATHS) {
  if (path === FUNNEL_PATH || path === TEAM_DASHBOARD_PATH) continue;
  privateQueryRoutes.use(`/${path}`, requireMethodMiddleware("GET"));
  privateQueryRoutes.all(
    `/${path}`,
    resolvePrivateSiteMiddleware(),
    dashboardCacheMiddleware(),
    privateQuery(path),
  );
}
privateQueryRoutes.use("/*", requireMethodMiddleware("GET"));
privateQueryRoutes.all(
  "/*",
  resolvePrivateSiteMiddleware(),
  dashboardCacheMiddleware(),
  (c) => {
    const pathname = requestUrl(c).pathname.replace(/^\/api\/private\//, "");
    return privateQuery(pathname)(c);
  },
);
