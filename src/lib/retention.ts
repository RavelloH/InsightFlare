import type { ScheduledTaskRetentionConfig } from "./scheduled-tasks";

export const DEFAULT_RETENTION_CONFIG: ScheduledTaskRetentionConfig = {
  scheduledTaskLogsDays: 30,
  notificationTestDays: 30,
  notificationAttentionDays: 180,
  notificationDefaultDays: 120,
};

export const RETENTION_CONFIG_KEY = "scheduled-task-retention";
export const MIN_RETENTION_DAYS = 1;
export const MAX_RETENTION_DAYS = 3650;

function validRetentionDays(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isInteger(value) &&
    value >= MIN_RETENTION_DAYS &&
    value <= MAX_RETENTION_DAYS
  );
}

export function normalizeRetentionConfig(
  value:
    | Partial<ScheduledTaskRetentionConfig>
    | Record<string, unknown>
    | null
    | undefined,
): ScheduledTaskRetentionConfig {
  return {
    scheduledTaskLogsDays: validRetentionDays(value?.scheduledTaskLogsDays)
      ? value.scheduledTaskLogsDays
      : DEFAULT_RETENTION_CONFIG.scheduledTaskLogsDays,
    notificationTestDays: validRetentionDays(value?.notificationTestDays)
      ? value.notificationTestDays
      : DEFAULT_RETENTION_CONFIG.notificationTestDays,
    notificationAttentionDays: validRetentionDays(
      value?.notificationAttentionDays,
    )
      ? value.notificationAttentionDays
      : DEFAULT_RETENTION_CONFIG.notificationAttentionDays,
    notificationDefaultDays: validRetentionDays(value?.notificationDefaultDays)
      ? value.notificationDefaultDays
      : DEFAULT_RETENTION_CONFIG.notificationDefaultDays,
  };
}

export function mergeRetentionConfig(
  current: ScheduledTaskRetentionConfig,
  patch: Record<string, unknown>,
): ScheduledTaskRetentionConfig {
  return normalizeRetentionConfig({ ...current, ...patch });
}

export function retentionDaysForNotification(
  input: { type: string; severity: string },
  config: ScheduledTaskRetentionConfig = DEFAULT_RETENTION_CONFIG,
): number {
  if (input.type === "test") return config.notificationTestDays;
  if (input.severity === "warning" || input.severity === "critical") {
    return config.notificationAttentionDays;
  }
  return config.notificationDefaultDays;
}
