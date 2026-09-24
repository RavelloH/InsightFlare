import { Hono } from "hono";

import { handleTrackerScriptRequest } from "@/lib/edge/collector/script-endpoint";
import type { AppEnv } from "@/lib/hono/types";

export const scriptRoutes = new Hono<AppEnv>();

scriptRoutes.get("/script.js", (c) =>
  handleTrackerScriptRequest(c.req.raw, c.env),
);
