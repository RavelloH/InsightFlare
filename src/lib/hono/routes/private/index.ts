import { Hono } from "hono";

import { handlePrivateArchive } from "@/lib/edge/archive-query";
import type { AppEnv } from "@/lib/hono/types";

import { privateAdminRoutes } from "./admin";
import { privateQueryRoutes } from "./query";

function urlFor(request: Request): URL {
  return new URL(request.url);
}

export const privateRoutes = new Hono<AppEnv>();

privateRoutes.route("/admin", privateAdminRoutes);

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
