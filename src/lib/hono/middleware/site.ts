import type { MiddlewareHandler } from "hono";

import { jsonError } from "@/lib/api-v1";
import {
  and,
  compileD1Query,
  createD1DatabaseClient,
  eq,
  filter,
  limit,
  param,
  project,
  scan,
} from "@/lib/db";
import { schema } from "@/lib/db/schema";
import { canAccessSiteId } from "@/lib/edge/auth/api-key-auth";
import {
  fetchPublicSite,
  resolvePrivateSiteForSession,
} from "@/lib/edge/auth/site-access";
import type { AppEnv } from "@/lib/hono/types";
import { requestUrl } from "@/lib/hono/utils/context";

function hasStringId<Row extends { id: string | null }>(
  row: Row,
): row is Row & { id: string } {
  return typeof row.id === "string";
}

export function resolvePrivateSiteMiddleware(): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const session = c.get("session");
    if (!session) {
      throw new Error("private session context missing");
    }
    const site = await resolvePrivateSiteForSession(
      c.req.raw,
      c.env,
      requestUrl(c),
      session,
    );
    if (site instanceof Response) {
      c.res = site;
      return site;
    }
    c.set("privateSite", site);
    c.set("site", site);
    await next();
  };
}
export function resolvePublicSiteMiddleware(): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const site = await fetchPublicSite(c.env, requestUrl(c));
    if (site instanceof Response) {
      c.res = site;
      return site;
    }
    c.set("publicSite", {
      ...site,
      slug: c.req.param("slug"),
    });
    await next();
  };
}
export function resolveApiSiteMiddleware(): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const principal = c.get("apiPrincipal");
    const siteId = c.req.param("siteId");
    if (!principal || !siteId || !canAccessSiteId(principal, siteId)) {
      const response = jsonError(
        "site_not_found",
        "Site not found",
        404,
        undefined,
        c.req.raw,
      );
      c.res = response;
      return response;
    }

    const sites = scan(schema.sites);
    const matchingSites = filter(
      sites,
      and(
        eq(sites.columns.id, param(siteId)),
        eq(sites.columns.team_id, param(principal.teamId)),
      ),
    );
    const apiSiteQuery = limit(
      project(matchingSites, {
        id: matchingSites.columns.id,
        teamId: matchingSites.columns.team_id,
        name: matchingSites.columns.name,
        domain: matchingSites.columns.domain,
        publicEnabled: matchingSites.columns.public_enabled,
        publicSlug: matchingSites.columns.public_slug,
        createdAt: matchingSites.columns.created_at,
        updatedAt: matchingSites.columns.updated_at,
      }),
      1,
    );
    const row = await createD1DatabaseClient(c.env.DB).first(
      compileD1Query(apiSiteQuery, { tag: "hono.sites.first" }),
    );

    if (!row || !hasStringId(row)) {
      const response = jsonError(
        "site_not_found",
        "Site not found",
        404,
        undefined,
        c.req.raw,
      );
      c.res = response;
      return response;
    }

    c.set("apiSite", row);
    await next();
  };
}
