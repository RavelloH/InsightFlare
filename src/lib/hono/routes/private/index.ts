import { Hono } from "hono";

import { handlePrivateAdmin } from "@/lib/edge/admin";
import { handlePrivateArchive } from "@/lib/edge/archive-query";
import type { AppEnv } from "@/lib/hono/types";

import { privateQueryRoutes } from "./query";

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

privateRoutes.route("/", privateQueryRoutes);
