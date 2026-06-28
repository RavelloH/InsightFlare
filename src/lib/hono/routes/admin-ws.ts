import { Hono } from "hono";

import { handleAdminWs } from "@/lib/edge/admin-ws";
import type { AppEnv } from "@/lib/hono/types";

export const adminWsRoutes = new Hono<AppEnv>();

adminWsRoutes.all("/admin/ws", (c) => handleAdminWs(c.req.raw, c.env));
