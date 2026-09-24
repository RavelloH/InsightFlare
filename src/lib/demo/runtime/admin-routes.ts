import { normalizeTimeZone } from "@/lib/analytics/time-zone";
import {
  defaultAnalyticsEngineConfig,
  redactAnalyticsEngineConfig,
} from "@/lib/analytics-engine-config";
import { generateDemoDoDiagnostic } from "@/lib/demo/admin/durable-objects";
import {
  createDemoNotificationRule,
  generateDemoNotificationMessages,
  generateDemoNotificationRules,
  generateDemoNotificationTest,
} from "@/lib/demo/admin/notifications";
import {
  generateDemoScheduledTasks,
  updateDemoScheduledTasks,
} from "@/lib/demo/admin/scheduled-tasks";
import { generateDemoSystemPerformance } from "@/lib/demo/admin/system-performance";
import {
  generateDemoApiKeys,
  generateDemoTeamInvites,
  getDemoMembers,
  getDemoScriptSnippet,
  getDemoSiteConfig,
  getDemoSites,
  getDemoTeams,
  getDemoUser,
  getDemoUsers,
} from "@/lib/demo/admin/users";
import {
  generateDemoNotificationRulePreview,
  generateDemoNotificationRuleRun,
  nowSeconds,
} from "@/lib/demo/notifications/rules";
import { demoBadRequest } from "@/lib/demo/realtime/envelope";
import {
  createDemoFunnel,
  deleteDemoFunnel,
  updateDemoFunnel,
} from "@/lib/demo/realtime/funnels";
import {
  createDemoGoal,
  deleteDemoGoal,
  updateDemoGoal,
} from "@/lib/demo/realtime/goals";
import { demoRequestObservationResponse } from "@/lib/demo/realtime/request-observation-handler";
import {
  defaultNotificationEmailConfig,
  redactNotificationEmailConfig,
} from "@/lib/notifications/email-config";

import type { DemoRuntimeContext } from "./context";
import {
  demoLoginTurnstileConfig,
  demoNotificationPreferences,
} from "./shared";
export function handleDemoAdminRoutes(
  context: DemoRuntimeContext,
): unknown | undefined {
  const { path, method, params, body, bodyRecord, siteId, teamId, locale } =
    context;
  const options = { body };
  // Write operations → read-only stub
  if (
    method === "POST" ||
    method === "PATCH" ||
    method === "PUT" ||
    method === "DELETE"
  ) {
    if (path.includes("/admin/scheduled-tasks")) {
      const retentionPatch =
        bodyRecord.retention &&
        typeof bodyRecord.retention === "object" &&
        !Array.isArray(bodyRecord.retention)
          ? (bodyRecord.retention as Record<string, unknown>)
          : {};
      if (bodyRecord.retentionDays !== undefined) {
        retentionPatch.scheduledTaskLogsDays = bodyRecord.retentionDays;
      }
      updateDemoScheduledTasks({
        taskKey: bodyRecord.taskKey,
        enabled: bodyRecord.enabled,
        retention:
          Object.keys(retentionPatch).length > 0 ? retentionPatch : undefined,
        retentionDays: bodyRecord.retentionDays,
      });
      return { ok: true, data: generateDemoScheduledTasks(params) };
    }
    if (path.includes("/admin/analytics-engine-config")) {
      const body = bodyRecord as {
        accountId?: unknown;
        apiToken?: unknown;
        clearApiToken?: unknown;
      };
      const config = defaultAnalyticsEngineConfig();
      config.accountId = String(body.accountId ?? "").trim();
      config.configured =
        body.clearApiToken !== true &&
        String(body.apiToken ?? "").trim() !== "";
      config.apiTokenHint = config.configured ? "••••demo" : "";
      config.updatedAt = Date.now();
      return { ok: true, data: redactAnalyticsEngineConfig(config) };
    }
    if (path.includes("/funnels")) {
      if (method === "DELETE") return deleteDemoFunnel(siteId, params);
      if (method === "PATCH")
        return updateDemoFunnel(siteId, params, options.body);
      return createDemoFunnel(siteId, options.body);
    }
    if (path.includes("/goals") && !path.includes("/analytics/goals/")) {
      if (method === "DELETE") return deleteDemoGoal(siteId, params);
      if (method === "PATCH")
        return updateDemoGoal(siteId, params, options.body);
      return createDemoGoal(siteId, options.body);
    }
    // Special cases that need real-looking responses
    if (path === "/api/public/session" || path.includes("/auth/login")) {
      const user = getDemoUser();
      return { ok: true, data: { user, teams: getDemoTeams() } };
    }
    if (path.includes("/auth/me")) {
      const user = getDemoUser();
      return { ok: true, data: { user, teams: getDemoTeams() } };
    }
    if (path.includes("/profile")) {
      const body =
        options.body && typeof options.body === "object" ? options.body : {};
      const profileBody = body as {
        email?: unknown;
        name?: unknown;
        timeZone?: unknown;
        username?: unknown;
      };
      const hasTimeZone = Object.prototype.hasOwnProperty.call(
        body,
        "timeZone",
      );
      const user = getDemoUser();
      return {
        ok: true,
        data: {
          ...user,
          username: String(profileBody.username ?? user.username),
          email: String(profileBody.email ?? user.email),
          name: String(profileBody.name ?? user.name),
          timeZone: hasTimeZone
            ? normalizeTimeZone(String(profileBody.timeZone ?? ""))
            : user.timeZone,
        },
      };
    }
    if (path.includes("/site-config")) {
      const config =
        options.body &&
        typeof options.body === "object" &&
        "config" in options.body &&
        options.body.config &&
        typeof options.body.config === "object"
          ? (options.body.config as Record<string, unknown>)
          : {};
      return {
        ok: true,
        data: {
          ...getDemoSiteConfig(),
          ...config,
        },
      };
    }
    if (path.includes("/admin/notification-email/test")) {
      return {
        ok: true,
        data: {
          provider: "resend",
          messageId: "demo-email-message",
          durationMs: 128,
        },
      };
    }
    if (path.includes("/admin/login-turnstile/test")) {
      return { ok: true, data: { verified: true, hostname: "demo.local" } };
    }
    if (path.includes("/admin/login-turnstile")) {
      if (method === "DELETE") {
        return { ok: true, data: demoLoginTurnstileConfig() };
      }
      return {
        ok: true,
        data: demoLoginTurnstileConfig(bodyRecord),
      };
    }
    if (path.includes("/admin/api-keys")) {
      const body =
        options.body && typeof options.body === "object" ? options.body : {};
      const keyBody = body as {
        keyId?: unknown;
        name?: unknown;
        scopes?: unknown;
        siteIds?: unknown;
        teamId?: unknown;
      };
      const now = nowSeconds();
      const team = String(keyBody.teamId || teamId || getDemoTeams()[0].id);
      const keys = generateDemoApiKeys(team);
      if (!keyBody.keyId) {
        const createdName = String(keyBody.name ?? "").trim();
        if (createdName.length < 2) return demoBadRequest("name is required");
        if (!Array.isArray(keyBody.scopes) || keyBody.scopes.length === 0) {
          return demoBadRequest("at least one scope is required");
        }
      }
      if (keyBody.keyId) {
        const key = keys.find((item) => item.id === keyBody.keyId);
        if (method === "PATCH") {
          return {
            ok: true,
            data: {
              ...(key ?? {
                id: String(keyBody.keyId),
                teamId: team,
                name: "API key",
                prefix: "",
                scopes: [],
                siteIds: [],
                createdByUserId: "",
                expiresAt: 0,
                revokedAt: null,
                revokedByUserId: "",
                rotatedFromKeyId: "",
                lastUsedAt: null,
                createdAt: now,
                updatedAt: now,
                status: "active",
              }),
              status: "revoked",
              revokedAt: now,
              revokedByUserId: getDemoUser().id,
              updatedAt: now,
            },
          };
        }
      }
      return {
        ok: true,
        data: {
          key: {
            ...keys[0],
            id: `demo-api-key-created-${now}`,
            name: String(keyBody.name || "Demo API key"),
            scopes: Array.isArray(keyBody.scopes)
              ? keyBody.scopes
              : keys[0].scopes,
            siteIds: Array.isArray(keyBody.siteIds) ? keyBody.siteIds : [],
            createdAt: now,
            updatedAt: now,
            lastUsedAt: null,
            status: "active",
          },
          secret: `if_demo_${now.toString(36)}_preview_secret`,
        },
      };
    }
    if (path.includes("/admin/team-invites")) {
      const now = nowSeconds();
      const inviteTeamId = String(
        bodyRecord.teamId || teamId || getDemoTeams()[0].id,
      );
      const rawRole = String(bodyRecord.role || "").toLowerCase();
      if (rawRole && rawRole !== "member" && rawRole !== "admin") {
        return demoBadRequest("Invite role must be member or admin");
      }
      const role = rawRole === "admin" ? "admin" : "member";
      const email = String(bodyRecord.email || "").trim();
      if (!email) return demoBadRequest("A valid email is required");
      const siteIds =
        role === "member" && Array.isArray(bodyRecord.siteIds)
          ? bodyRecord.siteIds
          : [];
      const token = `demo_created_${role}_${now.toString(36)}`;
      return {
        ok: true,
        data: {
          invite: {
            id: `demo-team-invite-created-${now}`,
            type: "team_invite",
            teamId: inviteTeamId,
            userId: "",
            email,
            payload: { teamRole: role, siteIds },
            code: token,
            url: `https://demo.insightflare.net/invite#token=${token}`,
            createdByUserId: getDemoUser().id,
            createdAt: now,
            expiresAt: now + Number(bodyRecord.expiresInHours || 72) * 60 * 60,
            usedAt: null,
            usedByUserId: "",
            revokedAt: null,
            status: "active",
          },
          url: `https://demo.insightflare.net/invite#token=${token}`,
        },
      };
    }
    if (path.includes("/admin/notification-test")) {
      return {
        ok: true,
        data: generateDemoNotificationTest(options.body),
      };
    }
    if (path === "/api/private/notifications") {
      return { ok: true, data: { updated: 1 } };
    }
    if (path === "/api/private/notifications/preferences") {
      return { ok: true, data: demoNotificationPreferences };
    }
    const notificationReadMatch = path.match(
      /^\/api\/private\/notifications\/([^/]+)$/,
    );
    if (notificationReadMatch) {
      const messageId = decodeURIComponent(
        notificationReadMatch[1] || "demo-notification-message-attention",
      );
      const message =
        generateDemoNotificationMessages(
          teamId || getDemoTeams()[0].id,
          locale,
        ).find((item) => item.id === messageId) ?? null;
      return {
        ok: true,
        data: message
          ? { ...message, readAt: Math.floor(Date.now() / 1000) }
          : null,
      };
    }
    if (path.includes("/admin/notification-rules")) {
      if (path.includes("/admin/notification-rules/preview")) {
        return {
          ok: true,
          data: generateDemoNotificationRulePreview(options.body),
        };
      }
      if (path.includes("/admin/notification-rules/run")) {
        return {
          ok: true,
          data: generateDemoNotificationRuleRun(options.body),
        };
      }
      if (method === "DELETE") {
        return {
          ok: true,
          data: { id: String(params.id || ""), removed: true },
        };
      }
      return {
        ok: true,
        data: createDemoNotificationRule(options.body),
      };
    }
    if (path.includes("/admin/notification-email")) {
      if (method === "DELETE") {
        return {
          ok: true,
          data: redactNotificationEmailConfig(defaultNotificationEmailConfig()),
        };
      }
      const body =
        options.body && typeof options.body === "object" ? options.body : {};
      const emailBody = body as {
        clearResendApiKey?: unknown;
        enabled?: unknown;
        fromEmail?: unknown;
        fromName?: unknown;
        provider?: unknown;
        replyTo?: unknown;
        resendApiKey?: unknown;
      };
      const configured =
        typeof emailBody.resendApiKey === "string" &&
        emailBody.resendApiKey.trim().length > 0 &&
        emailBody.clearResendApiKey !== true;
      return {
        ok: true,
        data: {
          ...redactNotificationEmailConfig(defaultNotificationEmailConfig()),
          enabled:
            typeof emailBody.enabled === "boolean" ? emailBody.enabled : false,
          provider: emailBody.provider === "none" ? "none" : "resend",
          fromName: String(emailBody.fromName || "InsightFlare"),
          fromEmail: String(emailBody.fromEmail || ""),
          replyTo: String(emailBody.replyTo || ""),
          resend: {
            configured,
            apiKeyHint: configured ? "••••demo" : "",
          },
          updatedAt: Date.now(),
        },
      };
    }
    if (path.includes("/admin/site")) {
      const body =
        options.body && typeof options.body === "object" ? options.body : {};
      const siteBody = body as {
        siteId?: unknown;
        teamId?: unknown;
        name?: unknown;
        domain?: unknown;
        publicEnabled?: unknown;
        publicSlug?: unknown;
      };
      const existing =
        getDemoSites(String(siteBody.teamId || getDemoTeams()[0].id))[0] ||
        getDemoSites(getDemoTeams()[0].id)[0];
      return {
        ok: true,
        data: {
          ...existing,
          id: String(siteBody.siteId || existing.id),
          name: String(siteBody.name ?? existing.name),
          domain: String(siteBody.domain ?? existing.domain),
          publicEnabled:
            typeof siteBody.publicEnabled === "boolean"
              ? siteBody.publicEnabled
              : existing.publicEnabled,
          publicSlug:
            typeof siteBody.publicSlug === "string"
              ? siteBody.publicSlug
              : existing.publicSlug,
        },
      };
    }
    if (path.includes("/admin/teams")) {
      const teamId = String(params.teamId || bodyRecord.teamId || "").trim();
      if (!teamId) return demoBadRequest("teamId is required");
      const existing =
        getDemoTeams().find((team) => team.id === teamId) ?? getDemoTeams()[0];
      const intent = String(bodyRecord.intent ?? "").toLowerCase();
      if (intent === "remove" || intent === "delete") {
        return {
          ok: true,
          data: {
            teams: getDemoTeams().filter((team) => team.id !== teamId),
          },
        };
      }
      const name = String(bodyRecord.name ?? "").trim();
      if (name.length < 2) return demoBadRequest("Team name is required");
      return { ok: true, data: { ...existing, name } };
    }
    if (path.includes("/admin/members")) {
      const teamId = String(params.teamId || bodyRecord.teamId || "").trim();
      const userId = String(
        params.userId || bodyRecord.userId || bodyRecord.user || "",
      ).trim();
      if (!teamId) return demoBadRequest("teamId is required");
      if (!userId)
        return demoBadRequest("teamId and user identifier are required");
      return { ok: true, data: { teamId, members: getDemoMembers(teamId) } };
    }
    if (path.includes("/admin/users")) {
      const userId = String(
        params.userId || bodyRecord.userId || bodyRecord.id || "",
      ).trim();
      const teamId = String(params.teamId || bodyRecord.teamId || "").trim();
      const user = getDemoUsers()[0];
      return {
        ok: true,
        data: {
          user: { ...user, id: userId || user.id },
          ...(teamId ? { teamId } : {}),
        },
      };
    }
    // Generic write → return empty success
    return { ok: true, data: {} };
  }

  // GET routes
  if (path === "/api/private/session" || path.includes("/admin/auth/me")) {
    return { ok: true, data: { user: getDemoUser(), teams: getDemoTeams() } };
  }
  if (path.includes("/admin/users")) {
    return { ok: true, data: getDemoUsers() };
  }
  if (path.includes("/admin/teams")) {
    return { ok: true, data: getDemoTeams() };
  }
  if (path.includes("/admin/team-invites")) {
    const tid = teamId || getDemoTeams()[0].id;
    return { ok: true, data: generateDemoTeamInvites(tid) };
  }
  if (path.includes("/admin/sites")) {
    const tid = teamId || getDemoTeams()[0].id;
    return { ok: true, data: getDemoSites(tid) };
  }
  if (path.includes("/admin/members")) {
    const tid = teamId || getDemoTeams()[0].id;
    return { ok: true, data: getDemoMembers(tid) };
  }
  if (path.includes("/admin/site-config")) {
    return { ok: true, data: getDemoSiteConfig() };
  }
  if (path.includes("/admin/script-snippet")) {
    return { ok: true, data: getDemoScriptSnippet(siteId) };
  }
  if (path.includes("/admin/api-keys")) {
    const tid = teamId || getDemoTeams()[0].id;
    return { ok: true, data: generateDemoApiKeys(tid) };
  }
  if (path.includes("/admin/analytics-engine-config")) {
    const config = defaultAnalyticsEngineConfig();
    return { ok: true, data: redactAnalyticsEngineConfig(config) };
  }
  if (path.includes("/admin/request-observation")) {
    return demoRequestObservationResponse(params);
  }
  if (path.includes("/admin/notification-rules")) {
    return {
      ok: true,
      data: generateDemoNotificationRules(teamId || getDemoTeams()[0].id),
    };
  }
  if (path === "/api/private/notifications") {
    const messages = generateDemoNotificationMessages(
      teamId || getDemoTeams()[0].id,
      locale,
    );
    return {
      ok: true,
      data: {
        messages,
        unreadAttentionCount: messages.filter(
          (message) => message.requiresAttention && message.readAt === null,
        ).length,
      },
    };
  }
  if (path === "/api/private/notifications/preferences") {
    return { ok: true, data: demoNotificationPreferences };
  }
  if (path.includes("/admin/notification-email")) {
    return {
      ok: true,
      data: redactNotificationEmailConfig(defaultNotificationEmailConfig()),
    };
  }
  if (path.includes("/admin/login-turnstile")) {
    return { ok: true, data: demoLoginTurnstileConfig() };
  }
  if (path === "/api/public/login-security") {
    return {
      ok: true,
      data: {
        turnstile: {
          enabled: false,
          siteKey: "",
          mode: "invisible",
        },
      },
    };
  }
  if (path.includes("/admin/scheduled-tasks")) {
    return generateDemoScheduledTasks(params);
  }
  if (path.includes("/admin/system-performance")) {
    return generateDemoSystemPerformance(params);
  }
  if (path.includes("/admin/do-diagnostic")) {
    return generateDemoDoDiagnostic();
  }
  return undefined;
}
