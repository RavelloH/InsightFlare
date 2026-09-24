import {
  canManageSite,
  canManageTeam,
  canReadTeam,
} from "@/lib/edge/admin/access";
import { type Actor, requireActor } from "@/lib/edge/admin/auth";
import {
  bad,
  forb,
  jsonResponseFor,
  na,
  nf,
  parseJson,
} from "@/lib/edge/admin/response";
import { runScheduledTask } from "@/lib/edge/scheduled-tasks/runner";
import type { Env } from "@/lib/edge/types";
import { renderNotificationEmail } from "@/lib/notifications/edge/email-renderer";
import {
  countUnreadAttentionMessages,
  listNotificationMessagesForTeam,
  listNotificationMessagesForUser,
  markAllNotificationMessagesRead,
  markNotificationMessageRead,
} from "@/lib/notifications/edge/message-store";
import {
  createManualTestNotification,
  createNotificationRulePreview,
  NOTIFICATION_TASK_KEY,
  NOTIFICATION_TASK_NAME,
  type NotificationTaskSummary,
  runNotificationRuleManually,
} from "@/lib/notifications/edge/notification-task";
import {
  getUserNotificationPreferences,
  updateUserNotificationPreferences,
} from "@/lib/notifications/edge/preferences";
import {
  createNotificationRule,
  deleteNotificationRule,
  getNotificationRule,
  listNotificationRules,
  updateNotificationRule,
  type UpdateNotificationRuleInput,
} from "@/lib/notifications/edge/rule-store";
import { resolveNotificationLocale } from "@/lib/notifications/locale";
import type { NotificationMessage } from "@/lib/notifications/message";
import {
  notificationEmailPreviewMessage,
  type NotificationEmailPreviewType,
} from "@/lib/notifications/preview-data";
function stringParam(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}
function hasOwn(input: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(input, key);
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
function parseLimit(url: URL): number {
  const raw = Math.trunc(Number(url.searchParams.get("limit") ?? 50));
  if (!Number.isFinite(raw)) return 50;
  return Math.max(1, Math.min(100, raw));
}
function isPreviewType(value: string): value is NotificationEmailPreviewType {
  return (
    value === "test" ||
    value === "report" ||
    value === "milestone" ||
    value === "threshold" ||
    value === "change" ||
    value === "health"
  );
}
async function getManageableRule(env: Env, actor: Actor, ruleId: string) {
  const rule = await getNotificationRule(env, ruleId);
  if (!rule) throw new Error("Not Found");
  if (!(await canManageTeam(env, actor, rule.teamId))) {
    throw new Error("Forbidden");
  }
  if (rule.siteId && !(await canManageSite(env, actor, rule.siteId))) {
    throw new Error("Forbidden");
  }
  return rule;
}
function mapError(error: unknown, req: Request): Response {
  const message = error instanceof Error ? error.message : String(error);
  if (message === "Forbidden") return forb("Forbidden", undefined, req);
  if (message === "Not Found") return nf("Not Found", undefined, req);
  return bad(message || "Invalid notification request", undefined, req);
}
export async function handleNotificationRulesAdmin(
  req: Request,
  env: Env,
  url: URL,
): Promise<Response> {
  const actor = await requireActor(env, req);
  if (actor instanceof Response) return actor;

  try {
    if (req.method === "GET") {
      const teamId = url.searchParams.get("teamId")?.trim() || undefined;
      const siteId = url.searchParams.get("siteId")?.trim() || undefined;
      const rules = await listNotificationRules(env, actor, { teamId, siteId });
      return jsonResponseFor(req, { ok: true, data: rules });
    }

    if (req.method === "POST") {
      const body = await parseJson(req);
      const teamId = stringParam(body.teamId);
      if (!teamId) return bad("teamId is required", undefined, req);
      const rule = await createNotificationRule(env, actor, {
        teamId,
        siteId: stringParam(body.siteId) || null,
        name: stringParam(body.name) || "Notification rule",
        description: stringParam(body.description),
        type: Object.prototype.hasOwnProperty.call(body, "type")
          ? (stringParam(body.type) as never)
          : undefined,
        enabled: typeof body.enabled === "boolean" ? body.enabled : undefined,
        schedule: body.schedule ?? body.scheduleJson,
        condition:
          body.condition && typeof body.condition === "object"
            ? (body.condition as Record<string, unknown>)
            : undefined,
        recipient: body.recipient as never,
      });
      return jsonResponseFor(req, { ok: true, data: rule });
    }

    if (req.method === "PATCH") {
      const body = await parseJson(req);
      const ruleId = stringParam(body.ruleId || body.id);
      if (!ruleId) return bad("ruleId is required", undefined, req);
      const input: UpdateNotificationRuleInput = { ruleId };
      if (hasOwn(body, "teamId")) input.teamId = stringParam(body.teamId);
      if (hasOwn(body, "siteId")) {
        input.siteId = stringParam(body.siteId) || null;
      }
      if (hasOwn(body, "name")) input.name = stringParam(body.name);
      if (hasOwn(body, "description")) {
        input.description = stringParam(body.description);
      }
      if (hasOwn(body, "type")) input.type = stringParam(body.type) as never;
      if (hasOwn(body, "enabled") && typeof body.enabled === "boolean") {
        input.enabled = body.enabled;
      }
      if (hasOwn(body, "schedule")) input.schedule = body.schedule;
      if (hasOwn(body, "condition") && isRecord(body.condition)) {
        input.condition = body.condition;
      }
      if (hasOwn(body, "recipient")) input.recipient = body.recipient as never;
      const rule = await updateNotificationRule(env, actor, input);
      return jsonResponseFor(req, { ok: true, data: rule });
    }

    if (req.method === "DELETE") {
      const ruleId = url.searchParams.get("id")?.trim() || "";
      if (!ruleId) return bad("id is required", undefined, req);
      const removed = await deleteNotificationRule(env, actor, ruleId);
      return jsonResponseFor(req, { ok: true, data: { id: ruleId, removed } });
    }
  } catch (error) {
    return mapError(error, req);
  }
  return na(req);
}
export async function handleNotificationRulePreviewAdmin(
  req: Request,
  env: Env,
): Promise<Response> {
  const actor = await requireActor(env, req);
  if (actor instanceof Response) return actor;
  if (req.method !== "POST") return na(req);

  try {
    const body = await parseJson(req);
    const ruleId = stringParam(body.ruleId || body.id);
    if (!ruleId) return bad("ruleId is required", undefined, req);
    const rule = await getManageableRule(env, actor, ruleId);
    const evaluation = await createNotificationRulePreview(env, rule);
    return jsonResponseFor(req, { ok: true, data: evaluation });
  } catch (error) {
    return mapError(error, req);
  }
}
export async function handleNotificationRuleRunAdmin(
  req: Request,
  env: Env,
): Promise<Response> {
  const actor = await requireActor(env, req);
  if (actor instanceof Response) return actor;
  if (req.method !== "POST") return na(req);

  try {
    const body = await parseJson(req);
    const ruleId = stringParam(body.ruleId || body.id);
    if (!ruleId) return bad("ruleId is required", undefined, req);
    const rule = await getManageableRule(env, actor, ruleId);
    const payload: {
      current: Awaited<ReturnType<typeof runNotificationRuleManually>> | null;
    } = { current: null };
    await runScheduledTask(
      env,
      {
        key: NOTIFICATION_TASK_KEY,
        name: NOTIFICATION_TASK_NAME,
        triggerType: "manual",
        scopeType: "notification_rule",
        scopeId: rule.id,
      },
      undefined,
      async (context) => {
        payload.current = await runNotificationRuleManually({
          env,
          context,
          rule,
        });
        return {
          status:
            payload.current.summary.emailFailed > 0 ? "partial" : "success",
          summary: { ...payload.current.summary },
        };
      },
    );
    return jsonResponseFor(req, { ok: true, data: payload.current });
  } catch (error) {
    return mapError(error, req);
  }
}
export async function handleNotificationEmailPreviewAdmin(
  req: Request,
  env: Env,
  url: URL,
): Promise<Response> {
  const actor = await requireActor(env, req);
  if (actor instanceof Response) return actor;
  if (req.method !== "GET") return na(req);
  if (!actor.isAdmin) return forb("Forbidden", undefined, req);

  const rawType = url.searchParams.get("type")?.trim() || "report";
  const type = isPreviewType(rawType) ? rawType : "report";
  const locale = resolveNotificationLocale(url.searchParams.get("locale"));
  const format = url.searchParams.get("format")?.trim() || "html";
  const rendered = await renderNotificationEmail({
    message: notificationEmailPreviewMessage(type, locale),
    locale,
    timeZone: "Asia/Shanghai",
  });

  if (format === "text") {
    return new Response(rendered.text, {
      headers: { "content-type": "text/plain; charset=utf-8" },
    });
  }
  if (format === "json") {
    return jsonResponseFor(req, { ok: true, data: rendered });
  }
  return new Response(rendered.html, {
    headers: { "content-type": "text/html; charset=utf-8" },
  });
}
export async function handleNotifications(
  req: Request,
  env: Env,
  url: URL,
): Promise<Response> {
  const actor = await requireActor(env, req);
  if (actor instanceof Response) return actor;
  if (req.method !== "GET") return na(req);

  const requestedUserId = url.searchParams.get("userId")?.trim() || "";
  const teamId = url.searchParams.get("teamId")?.trim() || "";
  const siteId = url.searchParams.get("siteId")?.trim() || "";
  const ruleId = url.searchParams.get("ruleId")?.trim() || "";
  const type = url.searchParams.get("type")?.trim() || "";
  const severity = url.searchParams.get("severity")?.trim() || "";
  const unread = url.searchParams.get("unread") === "1";
  const beforeRaw = Math.trunc(Number(url.searchParams.get("before") ?? 0));
  const before =
    Number.isFinite(beforeRaw) && beforeRaw > 0 ? beforeRaw : undefined;
  const limit = parseLimit(url);

  try {
    if (
      teamId &&
      (actor.isAdmin || (await canManageTeam(env, actor, teamId)))
    ) {
      const messages = await listNotificationMessagesForTeam(env, {
        teamId,
        userId: requestedUserId || undefined,
        siteId: siteId || undefined,
        ruleId: ruleId || undefined,
        type: type || undefined,
        severity: severity || undefined,
        unread,
        limit,
        before,
      });
      return jsonResponseFor(req, {
        ok: true,
        data: {
          messages,
          unreadAttentionCount: await countUnreadAttentionMessages(
            env,
            actor.user.id,
          ),
        },
      });
    }
    const userId =
      actor.isAdmin && requestedUserId ? requestedUserId : actor.user.id;
    const messages = await listNotificationMessagesForUser(env, {
      userId,
      teamId: teamId || undefined,
      siteId: siteId || undefined,
      ruleId: ruleId || undefined,
      type: type || undefined,
      severity: severity || undefined,
      unread,
      limit,
      before,
    });
    return jsonResponseFor(req, {
      ok: true,
      data: {
        messages,
        unreadAttentionCount: await countUnreadAttentionMessages(
          env,
          actor.user.id,
        ),
      },
    });
  } catch (error) {
    return mapError(error, req);
  }
}
export async function handleNotificationPreferences(
  req: Request,
  env: Env,
): Promise<Response> {
  const actor = await requireActor(env, req);
  if (actor instanceof Response) return actor;
  if (req.method === "GET") {
    const preferences = await getUserNotificationPreferences(
      env,
      actor.user.id,
    );
    return jsonResponseFor(req, { ok: true, data: preferences });
  }
  if (req.method !== "PATCH") return na(req);
  const preferences = await updateUserNotificationPreferences(env, {
    userId: actor.user.id,
    preferences: await parseJson(req),
  });
  return jsonResponseFor(req, { ok: true, data: preferences });
}
export async function handleNotificationRead(
  req: Request,
  env: Env,
  messageId: string,
): Promise<Response> {
  const actor = await requireActor(env, req);
  if (actor instanceof Response) return actor;
  if (req.method !== "PATCH") return na(req);
  if (!messageId) return bad("messageId is required", undefined, req);
  const message = await markNotificationMessageRead(env, {
    messageId,
    userId: actor.user.id,
  });
  return jsonResponseFor(req, { ok: true, data: message });
}
export async function handleNotificationsReadAll(
  req: Request,
  env: Env,
): Promise<Response> {
  const actor = await requireActor(env, req);
  if (actor instanceof Response) return actor;
  if (req.method !== "PATCH") return na(req);
  const body = await parseJson(req);
  const teamId = stringParam(body.teamId) || undefined;
  const updated = await markAllNotificationMessagesRead(env, {
    userId: actor.user.id,
    teamId,
  });
  return jsonResponseFor(req, { ok: true, data: { updated } });
}
export async function handleNotificationTestAdmin(
  req: Request,
  env: Env,
): Promise<Response> {
  const actor = await requireActor(env, req);
  if (actor instanceof Response) return actor;
  if (req.method !== "POST") return na(req);
  const body = await parseJson(req);
  const teamId = stringParam(body.teamId);
  const siteId = stringParam(body.siteId) || null;
  const requestedUserId = stringParam(body.userId) || actor.user.id;
  if (!teamId) return bad("teamId is required", undefined, req);
  if (!(await canReadTeam(env, actor, teamId))) {
    return forb("Forbidden", undefined, req);
  }
  // Team readers may send a harmless test to themselves; sending to another
  // user requires team management permission.
  if (
    requestedUserId !== actor.user.id &&
    !(await canManageTeam(env, actor, teamId))
  ) {
    return forb(
      "Only team managers can send test notifications to other users",
      undefined,
      req,
    );
  }

  const payload: {
    current: {
      message: NotificationMessage | null;
      summary: NotificationTaskSummary;
    } | null;
  } = { current: null };
  await runScheduledTask(
    env,
    {
      key: NOTIFICATION_TASK_KEY,
      name: NOTIFICATION_TASK_NAME,
      triggerType: "manual",
      scopeType: "team",
      scopeId: teamId,
    },
    undefined,
    async (context) => {
      payload.current = await createManualTestNotification({
        env,
        context,
        teamId,
        siteId,
        userId: requestedUserId,
      });
      const current = payload.current;
      return {
        status:
          current.message?.deliveryStatus === "failed" ? "partial" : "success",
        summary: { ...current.summary },
      };
    },
  );
  const result = payload.current;
  return jsonResponseFor(req, {
    ok: true,
    data: {
      message: result?.message ?? null,
      summary: result?.summary ?? null,
    },
  });
}
