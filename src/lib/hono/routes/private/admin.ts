import { Hono } from "hono";

import { handleApiKeysAdmin } from "@/lib/edge/admin-api-keys";
import { requireActor } from "@/lib/edge/admin-auth";
import { nf } from "@/lib/edge/admin-response";
import { handleScheduledTasksAdmin } from "@/lib/edge/admin-scheduled-tasks";
import {
  handleScriptSnippetAdmin,
  handleSiteConfigAdmin,
  handleSitesAdmin,
} from "@/lib/edge/admin-sites";
import {
  handleDoDiagnosticAdmin,
  handleSystemPerformanceAdmin,
} from "@/lib/edge/admin-system";
import { handleMembersAdmin, handleTeamsAdmin } from "@/lib/edge/admin-teams";
import {
  handleAuthLoginAdmin,
  handleAuthMeAdmin,
  handleProfileAdmin,
  handleUsersAdmin,
} from "@/lib/edge/admin-users";
import type { AppEnv } from "@/lib/hono/types";
import { requestUrl } from "@/lib/hono/utils/context";

export const privateAdminRoutes = new Hono<AppEnv>();

privateAdminRoutes.all("/auth/login", (c) =>
  handleAuthLoginAdmin(c.req.raw, c.env),
);
privateAdminRoutes.all("/auth/me", (c) => handleAuthMeAdmin(c.req.raw, c.env));
privateAdminRoutes.all("/users", (c) => handleUsersAdmin(c.req.raw, c.env));
privateAdminRoutes.all("/profile", (c) => handleProfileAdmin(c.req.raw, c.env));
privateAdminRoutes.all("/teams", (c) => handleTeamsAdmin(c.req.raw, c.env));
privateAdminRoutes.all("/sites", (c) =>
  handleSitesAdmin(c.req.raw, c.env, requestUrl(c)),
);
privateAdminRoutes.all("/members", (c) =>
  handleMembersAdmin(c.req.raw, c.env, requestUrl(c)),
);
privateAdminRoutes.all("/site-config", (c) =>
  handleSiteConfigAdmin(c.req.raw, c.env, requestUrl(c)),
);
privateAdminRoutes.all("/script-snippet", (c) =>
  handleScriptSnippetAdmin(c.req.raw, c.env, requestUrl(c)),
);
privateAdminRoutes.all("/api-keys", (c) =>
  handleApiKeysAdmin(c.req.raw, c.env, requestUrl(c)),
);
privateAdminRoutes.all("/system-performance", (c) =>
  handleSystemPerformanceAdmin(c.req.raw, c.env, requestUrl(c), requireActor),
);
privateAdminRoutes.all("/scheduled-tasks", (c) =>
  handleScheduledTasksAdmin(c.req.raw, c.env, requestUrl(c), requireActor),
);
privateAdminRoutes.all("/do-diagnostic", (c) =>
  handleDoDiagnosticAdmin(c.req.raw, c.env, requestUrl(c), requireActor),
);
privateAdminRoutes.all("/*", () => nf());
