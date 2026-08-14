import type { ScheduledTaskDefinitionInfo } from "@/lib/scheduled-tasks";

export const SCHEDULED_TASKS: ScheduledTaskDefinitionInfo[] = [
  {
    key: "visit_hourly_rollup",
    name: "Hourly visit aggregation",
    description:
      "Aggregates closed visit rows into hourly rollups for dashboard counters and trends.",
    schedule: "Every hour",
    trigger: "cron",
    enabled: true,
  },
  {
    key: "notification_tick",
    name: "Notification dispatch",
    description: "Evaluates notification rules and dispatches messages.",
    schedule: "Every 30 minutes",
    trigger: "cron",
    enabled: true,
  },
];

export function getScheduledTaskDefinition(
  key: string,
): ScheduledTaskDefinitionInfo | null {
  return SCHEDULED_TASKS.find((task) => task.key === key) ?? null;
}
