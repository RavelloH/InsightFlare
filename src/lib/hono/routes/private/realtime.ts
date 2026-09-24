import { Hono } from "hono";

import { handleAdminWs } from "@/lib/edge/admin/ws";
import type { AppEnv } from "@/lib/hono/types";
import { nf as notFound } from "@/lib/response";

export const privateRealtimeRoutes = new Hono<AppEnv>();

privateRealtimeRoutes.all("/ws", (c) => handleAdminWs(c.req.raw, c.env));
privateRealtimeRoutes.all("/*", () => notFound());
