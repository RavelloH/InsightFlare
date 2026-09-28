import { project, scan, schema } from "@/lib/db";

export function notificationRuleRows() {
  const rules = scan(schema.notification_rules);
  return project(rules, {
    id: rules.columns.id,
    teamId: rules.columns.team_id,
    siteId: rules.columns.site_id,
    name: rules.columns.name,
    description: rules.columns.description,
    type: rules.columns.type,
    enabled: rules.columns.enabled,
    scheduleJson: rules.columns.schedule_json,
    conditionJson: rules.columns.condition_json,
    recipientJson: rules.columns.recipient_json,
    stateJson: rules.columns.state_json,
    lastCheckedAt: rules.columns.last_checked_at,
    lastTriggeredAt: rules.columns.last_triggered_at,
    nextRunAt: rules.columns.next_run_at,
    cooldownUntil: rules.columns.cooldown_until,
    createdByUserId: rules.columns.created_by_user_id,
    createdAt: rules.columns.created_at,
    updatedAt: rules.columns.updated_at,
  });
}

export function notificationMessageRows() {
  const messages = scan(schema.notification_messages);
  return project(messages, {
    id: messages.columns.id,
    teamId: messages.columns.team_id,
    siteId: messages.columns.site_id,
    userId: messages.columns.user_id,
    ruleId: messages.columns.rule_id,
    runId: messages.columns.run_id,
    batchId: messages.columns.batch_id,
    type: messages.columns.type,
    severity: messages.columns.severity,
    requiresAttention: messages.columns.requires_attention,
    title: messages.columns.title,
    summary: messages.columns.summary,
    bodyText: messages.columns.body_text,
    bodyHtml: messages.columns.body_html,
    dataJson: messages.columns.data_json,
    channelsJson: messages.columns.channels_json,
    deliveryStatus: messages.columns.delivery_status,
    deliveryResultsJson: messages.columns.delivery_results_json,
    errorMessage: messages.columns.error_message,
    readAt: messages.columns.read_at,
    dismissedAt: messages.columns.dismissed_at,
    archivedAt: messages.columns.archived_at,
    triggeredAt: messages.columns.triggered_at,
    createdAt: messages.columns.created_at,
    updatedAt: messages.columns.updated_at,
    sentAt: messages.columns.sent_at,
    failedAt: messages.columns.failed_at,
    expiresAt: messages.columns.expires_at,
  });
}

export function notificationRecipientRows() {
  const users = scan(schema.users);
  return project(users, {
    id: users.columns.id,
    email: users.columns.email,
    preferencesJson: users.columns.notification_preferences_json,
    preferredLocale: users.columns.preferred_locale,
    timeZone: users.columns.timezone,
  });
}
