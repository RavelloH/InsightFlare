export type NotificationRuleType =
  "report" | "milestone" | "threshold" | "change" | "health" | "test";

export type NotificationMessageType =
  | "report"
  | "milestone"
  | "threshold"
  | "change"
  | "health"
  | "system"
  | "test";

export type NotificationSeverity = "info" | "success" | "warning" | "critical";

export type NotificationDeliveryStatus =
  "created" | "sending" | "sent" | "partial" | "failed" | "skipped";

export type NotificationChannel = "inApp" | "email" | "webPush";

const RULE_TYPES = new Set<NotificationRuleType>([
  "report",
  "milestone",
  "threshold",
  "change",
  "health",
  "test",
]);

const MESSAGE_TYPES = new Set<NotificationMessageType>([
  "report",
  "milestone",
  "threshold",
  "change",
  "health",
  "system",
  "test",
]);

const SEVERITIES = new Set<NotificationSeverity>([
  "info",
  "success",
  "warning",
  "critical",
]);

const DELIVERY_STATUSES = new Set<NotificationDeliveryStatus>([
  "created",
  "sending",
  "sent",
  "partial",
  "failed",
  "skipped",
]);

export function normalizeNotificationRuleType(
  value: unknown,
): NotificationRuleType {
  return RULE_TYPES.has(value as NotificationRuleType)
    ? (value as NotificationRuleType)
    : "test";
}

export function normalizeNotificationMessageType(
  value: unknown,
): NotificationMessageType {
  return MESSAGE_TYPES.has(value as NotificationMessageType)
    ? (value as NotificationMessageType)
    : "system";
}

export function normalizeNotificationSeverity(
  value: unknown,
): NotificationSeverity {
  return SEVERITIES.has(value as NotificationSeverity)
    ? (value as NotificationSeverity)
    : "info";
}

export function normalizeNotificationDeliveryStatus(
  value: unknown,
): NotificationDeliveryStatus {
  return DELIVERY_STATUSES.has(value as NotificationDeliveryStatus)
    ? (value as NotificationDeliveryStatus)
    : "created";
}

export function defaultRequiresAttention(input: {
  type: NotificationMessageType;
  severity: NotificationSeverity;
}): boolean {
  if (input.severity === "warning" || input.severity === "critical") {
    return true;
  }
  return input.type === "threshold" || input.type === "health";
}
