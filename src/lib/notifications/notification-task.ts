import { appNow } from "@/lib/edge/e2e-clock";
import type {
  ScheduledTaskContext,
  ScheduledTaskOutcome,
} from "@/lib/edge/scheduled-task-runner";
import type { Env } from "@/lib/edge/types";

import { deliverNotificationMessage } from "./delivery";
import {
  evaluateNotificationRule,
  type NotificationMessageDraft,
  type NotificationRuleEvaluationResult,
} from "./evaluator";
import { resolveNotificationLocale } from "./locale";
import { buildLocalizedNotificationMessageFields } from "./localized-message";
import {
  createNotificationMessage,
  type NotificationMessage,
} from "./message-store";
import {
  createNotificationInvocationCache,
  type NotificationInvocationCache,
} from "./notification-cache";
import {
  normalizeNotificationPreferences,
  shouldCreateUnreadAttention,
} from "./preferences";
import {
  advanceNotificationRuleSchedule,
  applyNotificationRuleManualRunResult,
  listDueNotificationRules,
  type NotificationRule,
  resolveNotificationRecipients,
} from "./rule-store";

export const NOTIFICATION_TASK_KEY = "notification_tick";
export const NOTIFICATION_TASK_NAME = "Notification dispatch";

export interface NotificationTaskSummary {
  rulesScanned: number;
  rulesChecked: number;
  rulesSkipped: number;
  rulesTriggered: number;
  messagesCreated: number;
  inAppCreated: number;
  emailAttempted: number;
  emailSent: number;
  emailFailed: number;
  skippedByPreference: number;
  emailSkipped: number;
  emailSkippedByPreference: number;
  emailSkippedBySystem: number;
  emailSkippedInvalidRecipient: number;
  durationMs: number;
}

function emptySummary(startedAt: number): NotificationTaskSummary {
  return {
    rulesScanned: 0,
    rulesChecked: 0,
    rulesSkipped: 0,
    rulesTriggered: 0,
    messagesCreated: 0,
    inAppCreated: 0,
    emailAttempted: 0,
    emailSent: 0,
    emailFailed: 0,
    skippedByPreference: 0,
    emailSkipped: 0,
    emailSkippedByPreference: 0,
    emailSkippedBySystem: 0,
    emailSkippedInvalidRecipient: 0,
    durationMs: Date.now() - startedAt,
  };
}

function collectDeliveryStats(
  summary: NotificationTaskSummary,
  message: NotificationMessage | null,
) {
  const email = message?.deliveryResults.email;
  if (!email || typeof email !== "object" || Array.isArray(email)) return;
  const status = String((email as Record<string, unknown>).status ?? "");
  if (status === "sent") {
    summary.emailAttempted += 1;
    summary.emailSent += 1;
    return;
  }
  if (status === "failed") {
    summary.emailAttempted += 1;
    summary.emailFailed += 1;
    return;
  }
  if (status === "skipped") {
    const reason = String((email as Record<string, unknown>).reason ?? "");
    summary.emailSkipped += 1;
    if (reason === "user_preference_disabled") {
      summary.skippedByPreference += 1;
      summary.emailSkippedByPreference += 1;
      return;
    }
    if (reason === "recipient_email_invalid") {
      summary.emailSkippedInvalidRecipient += 1;
      return;
    }
    if (
      reason === "system_email_unconfigured" ||
      reason === "secret_decryption_failed"
    ) {
      summary.emailSkippedBySystem += 1;
    }
  }
}

async function createAndDeliverMessages(input: {
  env: Env;
  context: ScheduledTaskContext;
  rule: NotificationRule;
  draft: NotificationMessageDraft;
  triggeredAt: number;
  summary: NotificationTaskSummary;
  cache: NotificationInvocationCache;
}): Promise<NotificationMessage[]> {
  const { env, context, rule, draft, triggeredAt, summary, cache } = input;
  const recipients = await resolveNotificationRecipients(env, rule);
  if (recipients.length === 0) {
    summary.rulesSkipped += 1;
    await context.logger.warn(
      "notification_rule_skipped",
      "Notification rule has no recipients",
      { ruleId: rule.id, recipientMode: rule.recipient.mode },
    );
    return [];
  }

  const batchId = crypto.randomUUID();
  const messages: NotificationMessage[] = [];
  await context.logger.info(
    "notification_rule_triggered",
    "Notification rule triggered",
    {
      ruleId: rule.id,
      batchId,
      recipientCount: recipients.length,
      ...(draft.data ?? {}),
    },
  );

  for (const user of recipients) {
    const locale = resolveNotificationLocale(user.preferredLocale);
    const localized = buildLocalizedNotificationMessageFields({
      draft,
      locale,
      timeZone: user.timeZone,
    });
    const preferences = normalizeNotificationPreferences(user.preferencesJson);
    const requiresAttention = shouldCreateUnreadAttention({
      preferences,
      type: draft.type,
      fallback: draft.requiresAttention,
    });
    const message = await createNotificationMessage(env, {
      teamId: rule.teamId,
      siteId: rule.siteId,
      userId: user.id,
      ruleId: rule.id,
      runId: context.runId,
      batchId,
      type: draft.type,
      severity: draft.severity,
      requiresAttention,
      title: localized.title,
      summary: localized.summary,
      bodyText: localized.bodyText,
      bodyHtml: "",
      data: {
        ruleId: rule.id,
        batchId,
        ...(draft.data ?? {}),
        locale: localized.locale,
      },
      triggeredAt,
    });
    summary.messagesCreated += 1;
    summary.inAppCreated += 1;
    await context.logger.info(
      "notification_messages_created",
      "Notification message created",
      {
        ruleId: rule.id,
        messageId: message.id,
        userId: user.id,
        batchId,
      },
    );
    const delivered = await deliverNotificationMessage(env, message, user, {
      logger: context.logger,
      fetchImpl: context.externalFetch,
      cache,
    });
    collectDeliveryStats(summary, delivered);
    if (delivered) messages.push(delivered);
  }
  return messages;
}

export async function runNotificationTick(
  context: ScheduledTaskContext,
): Promise<ScheduledTaskOutcome> {
  const { env, logger, startedAt } = context;
  const now = Math.floor(appNow() / 1000);
  const summary = emptySummary(startedAt);
  const cache = createNotificationInvocationCache();

  await logger.info("notification_tick_start", "Notification tick started", {
    now,
  });
  const rules = await listDueNotificationRules(env, now);
  summary.rulesScanned = rules.length;
  await logger.info(
    "notification_candidates",
    "Loaded due notification rules",
    {
      count: rules.length,
    },
  );

  for (const rule of rules) {
    const checkedAt = Math.floor(appNow() / 1000);
    try {
      await logger.info(
        "notification_rule_checked",
        "Evaluating notification rule",
        {
          ruleId: rule.id,
          teamId: rule.teamId,
          siteId: rule.siteId,
          type: rule.type,
        },
      );
      const evaluation = await evaluateNotificationRule(
        env,
        rule,
        checkedAt,
        cache,
      );
      summary.rulesChecked += 1;

      if (evaluation.status === "skipped") {
        summary.rulesSkipped += 1;
        await logger.info(
          "notification_rule_skipped",
          "Notification rule was skipped",
          {
            ruleId: rule.id,
            type: rule.type,
            reason: evaluation.reason,
            ...(evaluation.data ?? {}),
          },
        );
        await advanceNotificationRuleSchedule(env, { rule, checkedAt });
        continue;
      }

      if (evaluation.status === "checked") {
        await logger.info(
          "notification_rule_not_triggered",
          "Notification rule was checked and did not trigger",
          {
            ruleId: rule.id,
            type: rule.type,
            summary: evaluation.summary,
            ...(evaluation.data ?? {}),
          },
        );
        await advanceNotificationRuleSchedule(env, { rule, checkedAt });
        continue;
      }

      summary.rulesTriggered += 1;
      await createAndDeliverMessages({
        env,
        context,
        rule,
        draft: evaluation.message,
        triggeredAt: checkedAt,
        summary,
        cache,
      });

      await advanceNotificationRuleSchedule(env, {
        rule,
        checkedAt,
        triggeredAt: checkedAt,
        cooldownUntil: evaluation.cooldownUntil ?? null,
        state: evaluation.state ?? rule.state,
      });
    } catch (error) {
      summary.rulesSkipped += 1;
      await logger.error(
        "notification_rule_failed",
        "Notification rule failed; continuing with remaining rules",
        {
          ruleId: rule.id,
          error: error instanceof Error ? error.message : String(error),
        },
      );
      await advanceNotificationRuleSchedule(env, { rule, checkedAt });
    }
  }

  summary.durationMs = Date.now() - startedAt;
  await logger.info("notification_tick_finish", "Notification tick finished", {
    ...summary,
  });
  return {
    status: summary.emailFailed > 0 ? "partial" : "success",
    summary: { ...summary },
  };
}

export async function createNotificationRulePreview(
  env: Env,
  rule: NotificationRule,
): Promise<NotificationRuleEvaluationResult> {
  return evaluateNotificationRule(
    env,
    rule,
    Math.floor(appNow() / 1000),
    createNotificationInvocationCache(),
  );
}

export async function runNotificationRuleManually(input: {
  env: Env;
  context: ScheduledTaskContext;
  rule: NotificationRule;
}): Promise<{
  evaluation: NotificationRuleEvaluationResult;
  messages: NotificationMessage[];
  messageCount: number;
  summary: NotificationTaskSummary;
}> {
  const { env, context, rule } = input;
  const checkedAt = Math.floor(appNow() / 1000);
  const summary = emptySummary(context.startedAt);
  const cache = createNotificationInvocationCache();
  summary.rulesScanned = 1;

  await context.logger.info(
    "notification_rule_manual_run_start",
    "Manually running notification rule",
    {
      ruleId: rule.id,
      teamId: rule.teamId,
      siteId: rule.siteId,
      type: rule.type,
    },
  );
  const evaluation = await evaluateNotificationRule(
    env,
    rule,
    checkedAt,
    cache,
  );
  summary.rulesChecked = 1;

  if (evaluation.status === "skipped") {
    summary.rulesSkipped = 1;
    await context.logger.info(
      "notification_rule_skipped",
      "Notification rule was skipped during manual run",
      {
        ruleId: rule.id,
        type: rule.type,
        reason: evaluation.reason,
        ...(evaluation.data ?? {}),
      },
    );
    await applyNotificationRuleManualRunResult(env, { rule, checkedAt });
    summary.durationMs = Date.now() - context.startedAt;
    return { evaluation, messages: [], messageCount: 0, summary };
  }

  if (evaluation.status === "checked") {
    await context.logger.info(
      "notification_rule_not_triggered",
      "Notification rule was checked during manual run and did not trigger",
      {
        ruleId: rule.id,
        type: rule.type,
        summary: evaluation.summary,
        ...(evaluation.data ?? {}),
      },
    );
    await applyNotificationRuleManualRunResult(env, { rule, checkedAt });
    summary.durationMs = Date.now() - context.startedAt;
    return { evaluation, messages: [], messageCount: 0, summary };
  }

  summary.rulesTriggered = 1;
  const messages = await createAndDeliverMessages({
    env,
    context,
    rule,
    draft: evaluation.message,
    triggeredAt: checkedAt,
    summary,
    cache,
  });
  await applyNotificationRuleManualRunResult(env, {
    rule,
    checkedAt,
    triggeredAt: checkedAt,
    cooldownUntil: evaluation.cooldownUntil ?? null,
    state: evaluation.state ?? rule.state,
  });
  summary.durationMs = Date.now() - context.startedAt;
  return {
    evaluation,
    messages,
    messageCount: messages.length,
    summary,
  };
}

export async function createManualTestNotification(input: {
  env: Env;
  context: ScheduledTaskContext;
  teamId: string;
  siteId?: string | null;
  userId: string;
}): Promise<{
  message: NotificationMessage | null;
  summary: NotificationTaskSummary;
}> {
  const { env, context, teamId, siteId, userId } = input;
  const summary = emptySummary(context.startedAt);
  const cache = createNotificationInvocationCache();
  const now = Math.floor(appNow() / 1000);
  const user = await env.DB.prepare(
    `
      SELECT
        id,
        email,
        notification_preferences_json AS preferencesJson,
        preferred_locale AS preferredLocale,
        timezone AS timeZone
      FROM users
      WHERE id = ?
      LIMIT 1
    `,
  )
    .bind(userId)
    .first<{
      id: string;
      email: string;
      preferencesJson: string;
      preferredLocale?: string | null;
      timeZone?: string | null;
    }>();
  if (!user) {
    await context.logger.warn(
      "notification_delivery_skipped",
      "Manual test notification recipient was not found",
      { userId },
    );
    return { message: null, summary };
  }
  const locale = resolveNotificationLocale(user.preferredLocale);
  const localized = buildLocalizedNotificationMessageFields({
    draft: {
      type: "test",
      severity: "info",
      requiresAttention: false,
      title: "InsightFlare notification test",
      summary: "This is a test notification from InsightFlare.",
      bodyText:
        "This is a test notification from InsightFlare. If email is configured and enabled, this message also verifies Resend delivery.",
      data: { source: "manual_test" },
    },
    locale,
    timeZone: user.timeZone,
  });
  const message = await createNotificationMessage(env, {
    teamId,
    siteId: siteId ?? null,
    userId,
    runId: context.runId,
    batchId: crypto.randomUUID(),
    type: "test",
    severity: "info",
    requiresAttention: false,
    title: localized.title,
    summary: localized.summary,
    bodyText: localized.bodyText,
    bodyHtml: "",
    data: { source: "manual_test", locale: localized.locale },
    triggeredAt: now,
  });
  summary.messagesCreated = 1;
  summary.inAppCreated = 1;
  await context.logger.info(
    "notification_messages_created",
    "Manual test notification message created",
    { messageId: message.id, userId, teamId, siteId: siteId ?? null },
  );
  const delivered = await deliverNotificationMessage(env, message, user, {
    logger: context.logger,
    fetchImpl: context.externalFetch,
    cache,
  });
  collectDeliveryStats(summary, delivered);
  summary.durationMs = Date.now() - context.startedAt;
  return { message: delivered, summary };
}
