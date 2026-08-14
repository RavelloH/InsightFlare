import { Hono } from "hono";

import { requireSessionMiddleware } from "@/lib/hono/middleware/session";
import type { AppEnv } from "@/lib/hono/types";

import { privateAdminRoutes } from "./admin";
import { privateArchiveRoutes } from "./archive";
import { privateNotificationRoutes } from "./notifications";
import {
  privateAdminPerformanceV2Routes,
  privatePerformanceV2Routes,
} from "./performance-v2";
import { privateQueryRoutes } from "./query";
import { privateRealtimeRoutes } from "./realtime";
import { privateReleaseRoutes } from "./releases";
import { privateSessionRoutes } from "./session";

export const privateRoutes = new Hono<AppEnv>();

privateRoutes.use("/*", requireSessionMiddleware());
privateRoutes.route("/session", privateSessionRoutes);
privateRoutes.route("/admin/v2", privateAdminPerformanceV2Routes);
privateRoutes.route("/admin", privateAdminRoutes);
privateRoutes.route("/archive", privateArchiveRoutes);
privateRoutes.route("/notifications", privateNotificationRoutes);
privateRoutes.route("/realtime", privateRealtimeRoutes);
privateRoutes.route("/releases", privateReleaseRoutes);
privateRoutes.route("/v2", privatePerformanceV2Routes);
privateRoutes.route("/", privateQueryRoutes);
