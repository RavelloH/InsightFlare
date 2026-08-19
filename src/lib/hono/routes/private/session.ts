import { Hono } from "hono";

import { executeAdminService } from "@/lib/edge/admin-service";
import type { AppEnv } from "@/lib/hono/types";
import { requestUrl } from "@/lib/hono/utils/context";
import { nf as notFound } from "@/lib/response";

export const privateSessionRoutes = new Hono<AppEnv>();

privateSessionRoutes.get("/", (c) =>
  executeAdminService({
    route: "session",
    request: c.req.raw,
    env: c.env,
    url: requestUrl(c),
  }),
);
privateSessionRoutes.all("/*", () => notFound());
