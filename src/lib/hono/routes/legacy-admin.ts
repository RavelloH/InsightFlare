import { Hono } from "hono";

import {
  handleLegacyAdminMember,
  handleLegacyAdminProfile,
  handleLegacyAdminSite,
  handleLegacyAdminSiteConfig,
  handleLegacyAdminTeam,
  handleLegacyAdminUser,
} from "@/lib/edge/legacy-admin";
import type { AppEnv } from "@/lib/hono/types";

export const legacyAdminRoutes = new Hono<AppEnv>();

legacyAdminRoutes.post("/user", (c) => handleLegacyAdminUser(c.req.raw, c.env));
legacyAdminRoutes.post("/team", (c) => handleLegacyAdminTeam(c.req.raw, c.env));
legacyAdminRoutes.post("/site", (c) => handleLegacyAdminSite(c.req.raw, c.env));
legacyAdminRoutes.post("/member", (c) =>
  handleLegacyAdminMember(c.req.raw, c.env),
);
legacyAdminRoutes.post("/profile", (c) =>
  handleLegacyAdminProfile(c.req.raw, c.env),
);
legacyAdminRoutes.post("/site-config", (c) =>
  handleLegacyAdminSiteConfig(c.req.raw, c.env),
);
