import { Hono } from "hono";

import { nf } from "@/lib/edge/admin-response";
import { executeAdminService } from "@/lib/edge/admin-service";
import type { AppEnv } from "@/lib/hono/types";
import { requestUrl } from "@/lib/hono/utils/context";

export const privateNotificationRoutes = new Hono<AppEnv>();

privateNotificationRoutes.get("/", (c) =>
  executeAdminService({
    route: "notifications",
    request: c.req.raw,
    env: c.env,
    url: requestUrl(c),
  }),
);
privateNotificationRoutes.get("/preferences", (c) =>
  executeAdminService({
    route: "notifications/preferences",
    request: c.req.raw,
    env: c.env,
    url: requestUrl(c),
  }),
);
privateNotificationRoutes.patch("/preferences", (c) =>
  executeAdminService({
    route: "notifications/preferences",
    request: c.req.raw,
    env: c.env,
    url: requestUrl(c),
  }),
);
privateNotificationRoutes.patch("/:messageId", (c) =>
  executeAdminService({
    route: `notifications/${c.req.param("messageId").trim()}`,
    request: c.req.raw,
    env: c.env,
    url: requestUrl(c),
  }),
);
privateNotificationRoutes.patch("/", (c) =>
  executeAdminService({
    route: "notifications/read-all",
    request: c.req.raw,
    env: c.env,
    url: requestUrl(c),
  }),
);
privateNotificationRoutes.all("/*", () => nf());
