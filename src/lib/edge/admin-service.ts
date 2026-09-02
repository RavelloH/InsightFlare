import type { AdminServiceRoute } from "@/lib/admin-service-contract";
import type { PublicAnalyticsEngineConfig } from "@/lib/analytics-engine-config";
import type { AdminPublicLoginTurnstileConfig } from "@/lib/auth/login-turnstile-config";
import type { ScriptSnippetData } from "@/lib/dashboard/management-data";
import type { TeamInviteData } from "@/lib/dashboard/management-data";
import type { NotificationPreferencesData } from "@/lib/edge-client";
import type {
  AccountUserData,
  ApiKeyData,
  MemberData,
  NotificationMessageData,
  NotificationRuleData,
  SiteData,
  TeamData,
} from "@/lib/edge-client-types";
import type { PublicNotificationEmailConfig } from "@/lib/notifications/email-config";
import type { ScheduledTasksData } from "@/lib/scheduled-tasks";
import type { SiteSettingsConfig } from "@/lib/site-settings";
import type { SystemPerformanceData } from "@/lib/system-performance";

export {
  adminServicePath,
  type AdminServiceRoute,
  adminServiceRouteForPath,
} from "@/lib/admin-service-contract";

import type { Env } from "./types";

/**
 * Management routes are deliberately modeled separately from analytics
 * operations. Analytics has a read-only query contract; admin service routes
 * also include mutations, tests, previews, and operational commands.
 */
export interface AdminServiceRequest {
  readonly route: AdminServiceRoute;
  readonly request: Request;
  readonly env: Env;
  readonly url: URL;
}

export interface AdminSessionData {
  readonly user: AccountUserData;
  readonly teams: TeamData[];
  readonly teamGroups?: {
    created: TeamData[];
    managed: TeamData[];
    member: TeamData[];
    system: TeamData[];
  };
}

export interface AdminNotificationsData {
  readonly messages: NotificationMessageData[];
  readonly unreadAttentionCount: number;
}

/** Read payloads used by SSR management loaders. */
export interface AdminServiceReadMap {
  session: AdminSessionData;
  teams: TeamData[];
  sites: SiteData[];
  members: MemberData[];
  "team-invites": TeamInviteData[];
  users: AccountUserData[];
  notifications: AdminNotificationsData;
  "site-config": SiteSettingsConfig;
  "script-snippet": ScriptSnippetData;
  "api-keys": ApiKeyData[];
  "notification-rules": NotificationRuleData[];
  "notification-email": PublicNotificationEmailConfig;
  "login-turnstile": AdminPublicLoginTurnstileConfig;
  "analytics-engine-config": PublicAnalyticsEngineConfig;
  "notifications/preferences": NotificationPreferencesData;
  "scheduled-tasks": ScheduledTasksData;
  "system-performance": SystemPerformanceData;
}

export async function executeAdminService(
  input: AdminServiceRequest,
): Promise<Response> {
  if (import.meta.env.VITE_DEMO_MODE === "1") {
    const { executeDemoAdminService } = await import("./admin-service-demo");
    return executeDemoAdminService(input);
  }

  const { executeRealAdminService } = await import("./admin-service-real");
  return executeRealAdminService(input);
}

/**
 * Typed server-side read helper. It intentionally returns null for auth,
 * permission, and malformed responses so SSR loaders can use their existing
 * unauthenticated/not-found fallback without leaking API response details.
 */
export async function readAdminService<K extends keyof AdminServiceReadMap>(
  input: Omit<AdminServiceRequest, "route"> & {
    readonly route: K;
  },
): Promise<AdminServiceReadMap[K] | null> {
  const response = await executeAdminService(input);
  if (!response.ok) return null;

  try {
    const payload = (await response.json()) as {
      ok?: unknown;
      data?: unknown;
    };
    if (payload.ok !== true) return null;
    return payload.data as AdminServiceReadMap[K];
  } catch {
    return null;
  }
}
