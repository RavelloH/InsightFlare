import { Hono } from "hono";

import { handlePublicQuery } from "@/lib/edge/query";
import { PUBLIC_QUERY_PATHS } from "@/lib/edge/query/router";
import type { AppEnv } from "@/lib/hono/types";

const publicQueryPaths = ["site", ...PUBLIC_QUERY_PATHS] as const;

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
