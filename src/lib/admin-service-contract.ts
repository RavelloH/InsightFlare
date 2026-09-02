/**
 * Shared vocabulary for management requests. This module must stay free of
 * server runtime imports so client components and edge adapters can use the
 * same route contract.
 */
export type AdminServiceRoute =
  | "session"
  | "account-links"
  | "users"
  | "profile"
  | "teams"
  | "team-invites"
  | "sites"
  | "members"
  | "site-config"
  | "script-snippet"
  | "api-keys"
  | "notification-email"
  | "notification-email/test"
  | "login-turnstile"
  | "login-turnstile/test"
  | "analytics-engine-config"
  | "request-observation"
  | "notification-email-preview"
  | "notification-rules"
  | "notification-rules/preview"
  | "notification-rules/run"
  | "notification-test"
  | "system-performance"
  | "scheduled-tasks"
  | "do-diagnostic"
  | "e2e/flush"
  | "notifications"
  | "notifications/preferences"
  | "notifications/read-all"
  | `notifications/${string}`;

const STATIC_ADMIN_SERVICE_ROUTES = new Set<AdminServiceRoute>([
  "account-links",
  "users",
  "profile",
  "teams",
  "team-invites",
  "sites",
  "members",
  "site-config",
  "script-snippet",
  "api-keys",
  "notification-email",
  "notification-email/test",
  "login-turnstile",
  "login-turnstile/test",
  "analytics-engine-config",
  "request-observation",
  "notification-email-preview",
  "notification-rules",
  "notification-rules/preview",
  "notification-rules/run",
  "notification-test",
  "system-performance",
  "scheduled-tasks",
  "do-diagnostic",
  "e2e/flush",
]);

export function adminServicePath(route: AdminServiceRoute): string {
  if (route === "session") return "/api/private/session";
  if (route === "notifications/read-all") {
    return "/api/private/notifications";
  }
  if (route === "notifications" || route.startsWith("notifications/")) {
    return `/api/private/${route}`;
  }
  return `/api/private/admin/${route}`;
}

function isStaticAdminServiceRoute(value: string): value is AdminServiceRoute {
  return STATIC_ADMIN_SERVICE_ROUTES.has(value as AdminServiceRoute);
}

export function adminServiceRouteForPath(
  pathname: string,
  method = "GET",
): AdminServiceRoute | null {
  if (pathname === "/api/private/session") return "session";

  if (pathname === "/api/private/notifications") {
    return method.toUpperCase() === "PATCH"
      ? "notifications/read-all"
      : "notifications";
  }
  if (pathname === "/api/private/notifications/preferences") {
    return "notifications/preferences";
  }
  const notificationPrefix = "/api/private/notifications/";
  if (pathname.startsWith(notificationPrefix)) {
    const messageId = pathname.slice(notificationPrefix.length).trim();
    if (!messageId || messageId.includes("/")) return null;
    const decodedMessageId = decodeURIComponent(messageId);
    if (decodedMessageId.includes("/")) return null;
    return `notifications/${decodedMessageId}`;
  }

  const adminPrefix = "/api/private/admin/";
  if (!pathname.startsWith(adminPrefix)) return null;
  const route = pathname.slice(adminPrefix.length).replace(/\/+$/, "");
  return isStaticAdminServiceRoute(route) ? route : null;
}
