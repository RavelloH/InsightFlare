import { Hono } from "hono";

import {
  handleLegacyAuthLogin,
  handleLegacyAuthLogout,
} from "@/lib/edge/legacy-auth";
import type { AppEnv } from "@/lib/hono/types";

export const authRoutes = new Hono<AppEnv>();

authRoutes.post("/login", (c) => handleLegacyAuthLogin(c.req.raw, c.env));
authRoutes.post("/logout", (c) => handleLegacyAuthLogout(c.req.raw));
