import { Hono } from "hono";

import { publicApiGate } from "@/lib/hono/middleware/public-api-gate";
import type { AppEnv } from "@/lib/hono/types";

import { publicAccountLinkRoutes } from "./account-links";
import { publicLoginSecurityRoutes } from "./login-security";
import { publicQueryRoutes } from "./query";
import { publicResourceRoutes } from "./resources";
import { publicSessionRoutes } from "./session";
import { publicWidgetDataRoutes } from "./widgets";

export const publicRoutes = new Hono<AppEnv>();

publicRoutes.route("/session", publicSessionRoutes);
publicRoutes.route("/login-security", publicLoginSecurityRoutes);
publicRoutes.route("/account-links", publicAccountLinkRoutes);
publicRoutes.use("/share/*", publicApiGate());
publicRoutes.route("/share", publicQueryRoutes);
publicRoutes.route("/widgets", publicWidgetDataRoutes);
publicRoutes.use("/resources/*", publicApiGate({ allowImageDest: true }));
publicRoutes.route("/resources", publicResourceRoutes);
