import { handleApiKeysAdmin } from "./admin-api-keys";
import { requireActor } from "./admin-auth";
import { nf } from "./admin-response";
import { handleScheduledTasksAdmin } from "./admin-scheduled-tasks";
import {
  handleScriptSnippetAdmin,
  handleSiteConfigAdmin,
  handleSitesAdmin,
} from "./admin-sites";
import {
  handleDoDiagnosticAdmin,
  handleSystemPerformanceAdmin,
} from "./admin-system";
import { handleMembersAdmin, handleTeamsAdmin } from "./admin-teams";
import {
  handleAuthLoginAdmin,
  handleAuthMeAdmin,
  handleProfileAdmin,
  handleUsersAdmin,
} from "./admin-users";
import type { Env } from "./types";

/**
 * Compatibility wrapper. Production routing lives in src/lib/hono/routes.
 */
export async function handlePrivateAdmin(
  request: Request,
  env: Env,
  url: URL,
): Promise<Response> {
  const p = url.pathname;
  if (p === "/api/private/admin/auth/login")
    return handleAuthLoginAdmin(request, env);
  if (p === "/api/private/admin/auth/me")
    return handleAuthMeAdmin(request, env);
  if (p === "/api/private/admin/users") return handleUsersAdmin(request, env);
  if (p === "/api/private/admin/profile")
    return handleProfileAdmin(request, env);
  if (p === "/api/private/admin/teams") return handleTeamsAdmin(request, env);
  if (p === "/api/private/admin/sites")
    return handleSitesAdmin(request, env, url);
  if (p === "/api/private/admin/members")
    return handleMembersAdmin(request, env, url);
  if (p === "/api/private/admin/site-config")
    return handleSiteConfigAdmin(request, env, url);
  if (p === "/api/private/admin/script-snippet")
    return handleScriptSnippetAdmin(request, env, url);
  if (p === "/api/private/admin/api-keys")
    return handleApiKeysAdmin(request, env, url);
  if (p === "/api/private/admin/system-performance")
    return handleSystemPerformanceAdmin(request, env, url, requireActor);
  if (p === "/api/private/admin/scheduled-tasks")
    return handleScheduledTasksAdmin(request, env, url, requireActor);
  if (p === "/api/private/admin/do-diagnostic")
    return handleDoDiagnosticAdmin(request, env, url, requireActor);
  return nf();
}
