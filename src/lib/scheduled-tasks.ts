export const SCHEDULED_TASK_LOG_RETENTION_DAYS = 30;

export type InternalSchedule =
  | { kind: "interval"; everyMinutes: 30 | 60 }
  | { kind: "daily"; timezone: "UTC" };

export interface ScheduledTaskRetentionConfig {
  scheduledTaskLogsDays: number;
  notificationTestDays: number;
  notificationAttentionDays: number;
  notificationDefaultDays: number;
}

export type ScheduledTaskStatus =
  | "running"
  | "success"
  | "partial"
  | "failed"
  | "skipped";

export type ScheduledTaskLogLevel = "debug" | "info" | "warn" | "error";

export interface ScheduledTaskDefinitionInfo {
  key: string;
  name: string;
  description: string;
  schedule: string;
  trigger: "cron" | "manual" | "event";
  enabled: boolean;
  internalSchedule: InternalSchedule;
}

export interface ScheduledTaskRun {
  id: string;
  invocationId: string;
  taskKey: string;
  taskName: string;
  triggerType: string;
  status: ScheduledTaskStatus;
  scheduledAt: number | null;
  startedAt: number;
  finishedAt: number | null;
  durationMs: number | null;
  scopeType: string;
  scopeId: string | null;
  summary: Record<string, unknown>;
  errorName: string | null;
  errorMessage: string | null;
  workerVersion: string | null;
  createdAt: number;
  expiresAt: number;
}

export interface ScheduledTaskRunLog {
  id: string;
  runId: string;
  taskKey: string;
  sequence: number;
  level: ScheduledTaskLogLevel;
  event: string;
  message: string;
  data: Record<string, unknown>;
  createdAt: number;
}

export interface ScheduledTaskRunGroup {
  id: string;
  triggerType: string;
  status: ScheduledTaskStatus;
  scheduledAt: number | null;
  startedAt: number;
  finishedAt: number | null;
  durationMs: number | null;
  taskCount: number;
  subtaskCount: number;
  successCount: number;
  partialCount: number;
  failedCount: number;
  skippedCount: number;
  runningCount: number;
  logsCount: number;
  summary: Record<string, unknown>;
  runs: ScheduledTaskRun[];
}

export interface ScheduledTaskSummary {
  key: string;
  name: string;
  description: string;
  schedule: string;
  trigger: "cron" | "manual" | "event";
  enabled: boolean;
  nextRunAt: number | null;
  lastRun: ScheduledTaskRun | null;
  runs30d: number;
  success30d: number;
  partial30d: number;
  failed30d: number;
  skipped30d: number;
  running: number;
  successRate30d: number | null;
  avgDurationMs: number | null;
}

export interface ScheduledTasksHealth {
  totalRuns24h: number;
  failedRuns24h: number;
  partialRuns24h: number;
  runningRuns: number;
  staleRunningRuns: number;
  successRate24h: number | null;
  lastRunAt: number | null;
}

export interface ScheduledTaskRunsMeta {
  page: number;
  pageSize: number;
  returned: number;
  hasMore: boolean;
  nextPage: number | null;
}

export interface ScheduledTasksData {
  ok: true;
  generatedAt: number;
  retentionDays: number;
  retention: ScheduledTaskRetentionConfig;
  tasks: ScheduledTaskSummary[];
  runs: ScheduledTaskRunGroup[];
  runsMeta: ScheduledTaskRunsMeta;
  selectedRun: ScheduledTaskRunGroup | null;
  logs: ScheduledTaskRunLog[];
  health: ScheduledTasksHealth;
}
