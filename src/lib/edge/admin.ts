import { nf } from "./admin-response";
import { adminServiceRouteForPath, executeAdminService } from "./admin-service";
import { handleLegacyAuthLogin } from "./legacy-auth";
import { handlePublicAccountLinks } from "./public-account-links";
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
  if (p === "/api/public/session") return handleLegacyAuthLogin(request, env);
  if (p.startsWith("/api/public/account-links/"))
    return handlePublicAccountLinks(request, env, url);
  const route = adminServiceRouteForPath(p, request.method);
  if (!route) return nf();
  return executeAdminService({ route, request, env, url });
}
