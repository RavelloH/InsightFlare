import type { MiddlewareHandler } from "hono";

import { canAccessSiteId } from "@/lib/edge/api-key-auth";
import { jsonError } from "@/lib/edge/api-v1-helpers";
import { fetchPublicSite, resolvePrivateSite } from "@/lib/edge/query/core";
import type { AppEnv, HonoApiSite } from "@/lib/hono/types";
import { requestUrl } from "@/lib/hono/utils/context";

export function resolvePrivateSiteMiddleware(): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const site = await resolvePrivateSite(c.req.raw, c.env, requestUrl(c));
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

    const row = await c.env.DB.prepare(
      `
        SELECT
          id,
          team_id AS teamId,
          name,
          domain,
          public_enabled AS publicEnabled,
          public_slug AS publicSlug,
          created_at AS createdAt,
          updated_at AS updatedAt
        FROM sites
        WHERE id=? AND team_id=?
        LIMIT 1
      `,
    )
      .bind(siteId, principal.teamId)
      .first<HonoApiSite>();

    if (!row) {
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
