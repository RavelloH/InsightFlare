import { Hono } from "hono";

import { handleAccountLinksAdmin } from "@/lib/edge/admin-account-links";
import { handleApiKeysAdmin } from "@/lib/edge/admin-api-keys";
import { requireActor } from "@/lib/edge/admin-auth";
import {
  handleBotAnalyticsAdmin,
  handleBotAnalyticsConfigAdmin,
} from "@/lib/edge/admin-bot-analytics";
import {
  handleLoginTurnstileConfigAdmin,
  handleLoginTurnstileTestAdmin,
} from "@/lib/edge/admin-login-turnstile";
import {
  handleNotificationEmailConfigAdmin,
  handleNotificationEmailTestAdmin,
} from "@/lib/edge/admin-notification-email";
import {
  handleNotificationEmailPreviewAdmin,
  handleNotificationRulePreviewAdmin,
  handleNotificationRuleRunAdmin,
  handleNotificationRulesAdmin,
  handleNotificationTestAdmin,
} from "@/lib/edge/admin-notifications";
import { nf } from "@/lib/edge/admin-response";
import { handleScheduledTasksAdmin } from "@/lib/edge/admin-scheduled-tasks";
import {
  handleScriptSnippetAdmin,
  handleSiteConfigAdmin,
  handleSitesAdmin,
} from "@/lib/edge/admin-sites";
import {
  handleDoDiagnosticAdmin,
  handleE2eFlushAdmin,
  handleSystemPerformanceAdmin,
} from "@/lib/edge/admin-system";
import { handleTeamInvitesAdmin } from "@/lib/edge/admin-team-invites";
import { handleMembersAdmin, handleTeamsAdmin } from "@/lib/edge/admin-teams";
import { handleProfileAdmin, handleUsersAdmin } from "@/lib/edge/admin-users";
import type { AppEnv } from "@/lib/hono/types";
import { requestUrl } from "@/lib/hono/utils/context";

export const privateAdminRoutes = new Hono<AppEnv>();

privateAdminRoutes.all("/account-links", (c) =>
  handleAccountLinksAdmin(c.req.raw, c.env),
);
privateAdminRoutes.all("/users", (c) => handleUsersAdmin(c.req.raw, c.env));
privateAdminRoutes.all("/profile", (c) => handleProfileAdmin(c.req.raw, c.env));
privateAdminRoutes.all("/teams", (c) => handleTeamsAdmin(c.req.raw, c.env));
privateAdminRoutes.all("/team-invites", (c) =>
  handleTeamInvitesAdmin(c.req.raw, c.env, requestUrl(c)),
);
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
privateAdminRoutes.all("/notification-email", (c) =>
  handleNotificationEmailConfigAdmin(c.req.raw, c.env),
);
privateAdminRoutes.all("/notification-email/test", (c) =>
  handleNotificationEmailTestAdmin(c.req.raw, c.env),
);
privateAdminRoutes.all("/login-turnstile", (c) =>
  handleLoginTurnstileConfigAdmin(c.req.raw, c.env),
);
privateAdminRoutes.all("/login-turnstile/test", (c) =>
  handleLoginTurnstileTestAdmin(c.req.raw, c.env),
);
privateAdminRoutes.all("/bot-analytics-config", (c) =>
  handleBotAnalyticsConfigAdmin(c.req.raw, c.env),
);
privateAdminRoutes.all("/bot-analytics", (c) =>
  handleBotAnalyticsAdmin(c.req.raw, c.env, requestUrl(c)),
);
privateAdminRoutes.all("/notification-email-preview", (c) =>
  handleNotificationEmailPreviewAdmin(c.req.raw, c.env, requestUrl(c)),
);
privateAdminRoutes.all("/notification-rules", (c) =>
  handleNotificationRulesAdmin(c.req.raw, c.env, requestUrl(c)),
);
// TODO(private-api): Consider migrating notification rule mutations to
// /notification-rules/:ruleId, /:ruleId/preview, and /:ruleId/run once the
// notification UI stabilizes. Keep the current body/query based shape for now
// to avoid unnecessary churn during the initial notification-system rollout.
privateAdminRoutes.all("/notification-rules/preview", (c) =>
  handleNotificationRulePreviewAdmin(c.req.raw, c.env),
);
privateAdminRoutes.all("/notification-rules/run", (c) =>
  handleNotificationRuleRunAdmin(c.req.raw, c.env),
);
privateAdminRoutes.all("/notification-test", (c) =>
  handleNotificationTestAdmin(c.req.raw, c.env),
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
privateAdminRoutes.all("/e2e/flush", (c) =>
  handleE2eFlushAdmin(c.req.raw, c.env, requestUrl(c), requireActor),
);
privateAdminRoutes.all("/*", () => nf());
