import type { Context } from "hono";
import { Hono } from "hono";

import { nf } from "@/lib/edge/admin-response";
import {
  type AdminServiceRoute,
  executeAdminService,
} from "@/lib/edge/admin-service";
import type { AppEnv } from "@/lib/hono/types";
import { requestUrl } from "@/lib/hono/utils/context";

export const privateAdminRoutes = new Hono<AppEnv>();

function adminServiceRoute(route: AdminServiceRoute) {
  return (c: Context<AppEnv>) =>
    executeAdminService({
      route,
      request: c.req.raw,
      env: c.env,
      url: requestUrl(c),
    });
}

privateAdminRoutes.all("/account-links", adminServiceRoute("account-links"));
privateAdminRoutes.all("/users", adminServiceRoute("users"));
privateAdminRoutes.all("/profile", adminServiceRoute("profile"));
privateAdminRoutes.all("/teams", adminServiceRoute("teams"));
privateAdminRoutes.all("/team-invites", adminServiceRoute("team-invites"));
privateAdminRoutes.all("/sites", adminServiceRoute("sites"));
privateAdminRoutes.all("/members", adminServiceRoute("members"));
privateAdminRoutes.all("/site-config", adminServiceRoute("site-config"));
privateAdminRoutes.all("/script-snippet", adminServiceRoute("script-snippet"));
privateAdminRoutes.all("/api-keys", adminServiceRoute("api-keys"));
privateAdminRoutes.all(
  "/notification-email",
  adminServiceRoute("notification-email"),
);
privateAdminRoutes.all(
  "/notification-email/test",
  adminServiceRoute("notification-email/test"),
);
privateAdminRoutes.all(
  "/login-turnstile",
  adminServiceRoute("login-turnstile"),
);
privateAdminRoutes.all(
  "/login-turnstile/test",
  adminServiceRoute("login-turnstile/test"),
);
privateAdminRoutes.all(
  "/analytics-engine-config",
  adminServiceRoute("analytics-engine-config"),
);
privateAdminRoutes.all(
  "/request-observation",
  adminServiceRoute("request-observation"),
);
privateAdminRoutes.all(
  "/notification-email-preview",
  adminServiceRoute("notification-email-preview"),
);
privateAdminRoutes.all(
  "/notification-rules",
  adminServiceRoute("notification-rules"),
);
privateAdminRoutes.all(
  "/notification-rules/preview",
  adminServiceRoute("notification-rules/preview"),
);
privateAdminRoutes.all(
  "/notification-rules/run",
  adminServiceRoute("notification-rules/run"),
);
privateAdminRoutes.all(
  "/notification-test",
  adminServiceRoute("notification-test"),
);
privateAdminRoutes.all(
  "/system-performance",
  adminServiceRoute("system-performance"),
);
privateAdminRoutes.all(
  "/scheduled-tasks",
  adminServiceRoute("scheduled-tasks"),
);
privateAdminRoutes.all("/do-diagnostic", adminServiceRoute("do-diagnostic"));
privateAdminRoutes.all("/e2e/flush", adminServiceRoute("e2e/flush"));

privateAdminRoutes.all("/*", () => nf());
