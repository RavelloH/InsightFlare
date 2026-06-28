import { Hono } from "hono";

import { handlePublicQuery } from "@/lib/edge/query";
import type { AppEnv } from "@/lib/hono/types";

const publicQueryPaths = [
  "site",
  "overview",
  "trend",
  "pages",
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

export const publicRoutes = new Hono<AppEnv>();

for (const path of publicQueryPaths) {
  publicRoutes.all(`/:slug/${path}`, (c) =>
    handlePublicQuery(
      c.req.raw,
      c.env,
      new URL(c.req.raw.url),
      c.executionCtx as unknown as ExecutionContext,
    ),
  );
}

publicRoutes.all("/:slug/*", (c) =>
  handlePublicQuery(
    c.req.raw,
    c.env,
    new URL(c.req.raw.url),
    c.executionCtx as unknown as ExecutionContext,
  ),
);
