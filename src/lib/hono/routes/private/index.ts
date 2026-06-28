import { Hono } from "hono";

import { handlePrivateAdmin } from "@/lib/edge/admin";
import { handlePrivateArchive } from "@/lib/edge/archive-query";
import { handlePrivateQuery } from "@/lib/edge/query";
import type { AppEnv } from "@/lib/hono/types";

function urlFor(request: Request): URL {
  return new URL(request.url);
}

const dashboardQueryPaths = [
  "overview",
  "trend",
  "pages",
  "referrers",
  "pages-dashboard",
  "page-hash",
  "page-query",
  "event-types",
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
  "retention",
  "performance",
  "browser-trend",
  "browser-engine-trend",
  "browser-version-breakdown",
  "browser-cross-breakdown",
  "browser-radar",
  "referrer-radar",
  "referrer-dimension-trend",
  "client-dimension-trend",
  "utm-dimension-trend",
  "client-cross-breakdown",
  "utm-source",
  "utm-medium",
  "utm-campaign",
  "utm-term",
  "utm-content",
  "countries",
  "filter-options",
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
  "funnels",
  "team-dashboard",
] as const;

const adminPaths = [
  "auth/login",
  "auth/me",
  "users",
  "profile",
  "teams",
  "sites",
  "members",
  "site-config",
  "script-snippet",
  "api-keys",
  "system-performance",
  "scheduled-tasks",
  "do-diagnostic",
] as const;

export const privateRoutes = new Hono<AppEnv>();

for (const path of adminPaths) {
  privateRoutes.all(`/admin/${path}`, (c) =>
    handlePrivateAdmin(c.req.raw, c.env, urlFor(c.req.raw)),
  );
}

privateRoutes.all("/admin/*", (c) =>
  handlePrivateAdmin(c.req.raw, c.env, urlFor(c.req.raw)),
);

privateRoutes.all("/archive/manifest", (c) =>
  handlePrivateArchive(c.req.raw, c.env, urlFor(c.req.raw)),
);

privateRoutes.all("/archive/file", (c) =>
  handlePrivateArchive(c.req.raw, c.env, urlFor(c.req.raw)),
);

privateRoutes.all("/archive/*", (c) =>
  handlePrivateArchive(c.req.raw, c.env, urlFor(c.req.raw)),
);

for (const path of dashboardQueryPaths) {
  privateRoutes.all(`/${path}`, (c) =>
    handlePrivateQuery(
      c.req.raw,
      c.env,
      urlFor(c.req.raw),
      c.executionCtx as unknown as ExecutionContext,
    ),
  );
}

privateRoutes.all("/*", (c) =>
  handlePrivateQuery(
    c.req.raw,
    c.env,
    urlFor(c.req.raw),
    c.executionCtx as unknown as ExecutionContext,
  ),
);
