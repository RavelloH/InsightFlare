import { Hono } from "hono";

import type { AppEnv } from "@/lib/hono/types";

import { privateAdminRoutes } from "./admin";
import { privateArchiveRoutes } from "./archive";
import { privateQueryRoutes } from "./query";

export const privateRoutes = new Hono<AppEnv>();

privateRoutes.route("/admin", privateAdminRoutes);
privateRoutes.route("/archive", privateArchiveRoutes);
privateRoutes.route("/", privateQueryRoutes);
