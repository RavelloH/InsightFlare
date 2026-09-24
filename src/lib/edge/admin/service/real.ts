import { handleAccountLinksAdmin } from "@/lib/edge/admin/account-links";
import { handleAnalyticsEngineConfigAdmin } from "@/lib/edge/admin/analytics-engine/config";
import { handleApiKeysAdmin } from "@/lib/edge/admin/api-keys/handler";
import { requireActor } from "@/lib/edge/admin/auth";
import {
  handleLoginTurnstileConfigAdmin,
  handleLoginTurnstileTestAdmin,
} from "@/lib/edge/admin/auth/login-turnstile";
import {
  handleNotificationEmailConfigAdmin,
  handleNotificationEmailTestAdmin,
} from "@/lib/edge/admin/notifications/email";
import {
  handleNotificationEmailPreviewAdmin,
  handleNotificationPreferences,
  handleNotificationRead,
  handleNotificationRulePreviewAdmin,
  handleNotificationRuleRunAdmin,
  handleNotificationRulesAdmin,
  handleNotifications,
  handleNotificationsReadAll,
  handleNotificationTestAdmin,
} from "@/lib/edge/admin/notifications/handler";
import { handleRequestObservationAdmin } from "@/lib/edge/admin/observability/request-observation";
import { nf } from "@/lib/edge/admin/response";
import { handleScheduledTasksAdmin } from "@/lib/edge/admin/scheduled-tasks/handler";
import type { AdminServiceRequest } from "@/lib/edge/admin/service/index";
import {
  handleScriptSnippetAdmin,
  handleSiteConfigAdmin,
  handleSitesAdmin,
} from "@/lib/edge/admin/sites/handler";
import {
  handleDoDiagnosticAdmin,
  handleE2eFlushAdmin,
  handleSystemPerformanceAdmin,
} from "@/lib/edge/admin/system/handler";
import {
  handleMembersAdmin,
  handleTeamsAdmin,
} from "@/lib/edge/admin/teams/handlers";
import { handleTeamInvitesAdmin } from "@/lib/edge/admin/teams/invites";
import {
  handleAuthMeAdmin,
  handleProfileAdmin,
  handleUsersAdmin,
} from "@/lib/edge/admin/users/handlers";
/**
 * Real adapter for the admin service. Existing handlers remain the source of
 * business rules during migration; this adapter is the only place that knows
 * how the existing handler modules are composed.
 */
export async function executeRealAdminService(
  input: AdminServiceRequest,
): Promise<Response> {
  const { route, request, env, url } = input;

  switch (route) {
    case "session":
      return handleAuthMeAdmin(request, env);
    case "account-links":
      return handleAccountLinksAdmin(request, env);
    case "users":
      return handleUsersAdmin(request, env);
    case "profile":
      return handleProfileAdmin(request, env);
    case "teams":
      return handleTeamsAdmin(request, env);
    case "team-invites":
      return handleTeamInvitesAdmin(request, env, url);
    case "sites":
      return handleSitesAdmin(request, env, url);
    case "members":
      return handleMembersAdmin(request, env, url);
    case "site-config":
      return handleSiteConfigAdmin(request, env, url);
    case "script-snippet":
      return handleScriptSnippetAdmin(request, env, url);
    case "api-keys":
      return handleApiKeysAdmin(request, env, url);
    case "notification-email":
      return handleNotificationEmailConfigAdmin(request, env);
    case "notification-email/test":
      return handleNotificationEmailTestAdmin(request, env);
    case "login-turnstile":
      return handleLoginTurnstileConfigAdmin(request, env);
    case "login-turnstile/test":
      return handleLoginTurnstileTestAdmin(request, env);
    case "analytics-engine-config":
      return handleAnalyticsEngineConfigAdmin(request, env);
    case "request-observation":
      return handleRequestObservationAdmin(request, env, url);
    case "notification-email-preview":
      return handleNotificationEmailPreviewAdmin(request, env, url);
    case "notification-rules":
      return handleNotificationRulesAdmin(request, env, url);
    case "notification-rules/preview":
      return handleNotificationRulePreviewAdmin(request, env);
    case "notification-rules/run":
      return handleNotificationRuleRunAdmin(request, env);
    case "notification-test":
      return handleNotificationTestAdmin(request, env);
    case "system-performance":
      return handleSystemPerformanceAdmin(request, env, url, requireActor);
    case "scheduled-tasks":
      return handleScheduledTasksAdmin(request, env, url, requireActor);
    case "do-diagnostic":
      return handleDoDiagnosticAdmin(request, env, url, requireActor);
    case "e2e/flush":
      return handleE2eFlushAdmin(request, env, url, requireActor);
    case "notifications":
      return handleNotifications(request, env, url);
    case "notifications/preferences":
      return handleNotificationPreferences(request, env);
    case "notifications/read-all":
      return handleNotificationsReadAll(request, env);
    default:
      if (route.startsWith("notifications/")) {
        return handleNotificationRead(
          request,
          env,
          route.slice("notifications/".length),
        );
      }
      return nf();
  }
}
