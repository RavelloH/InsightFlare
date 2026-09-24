import { Hono } from "hono";

import { handlePublicAccountLinks } from "@/lib/edge/auth/public-account-links";
import type { AppEnv } from "@/lib/hono/types";
import { requestUrl } from "@/lib/hono/utils/context";
import { nf as notFound } from "@/lib/response";

export const publicAccountLinkRoutes = new Hono<AppEnv>();

publicAccountLinkRoutes.post("/inspect", (c) =>
  handlePublicAccountLinks(c.req.raw, c.env, requestUrl(c)),
);
publicAccountLinkRoutes.post("/complete", (c) =>
  handlePublicAccountLinks(c.req.raw, c.env, requestUrl(c)),
);
publicAccountLinkRoutes.all("/*", () => notFound());
