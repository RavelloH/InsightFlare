import { Hono } from "hono";

import { handlePrivateAdmin } from "@/lib/edge/admin";
import { handlePrivateArchive } from "@/lib/edge/archive-query";
import { handlePrivateQuery } from "@/lib/edge/query";
import { DASHBOARD_QUERY_PATHS } from "@/lib/edge/query/router";
import type { AppEnv } from "@/lib/hono/types";

function urlFor(request: Request): URL {
  return new URL(request.url);
}

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

for (const path of DASHBOARD_QUERY_PATHS) {
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
