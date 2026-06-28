import { Hono } from "hono";

import type { AppEnv } from "@/lib/hono/types";

import { publicQueryRoutes } from "./query";

export const publicRoutes = new Hono<AppEnv>();

publicRoutes.route("/", publicQueryRoutes);
