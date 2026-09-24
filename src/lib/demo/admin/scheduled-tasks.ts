import { fnv1a, mulberry32, sInt } from "@/lib/demo/generators/utils";
import { demoPage } from "@/lib/demo/realtime/pagination";
import {
  DEFAULT_RETENTION_CONFIG,
  normalizeRetentionConfig,
} from "@/lib/retention";
import {
  type ScheduledTaskRun,
  type ScheduledTaskRunGroup,
  type ScheduledTaskRunLog,
  type ScheduledTasksData,
  type ScheduledTaskStatus,
  type ScheduledTaskSummary,
} from "@/lib/scheduled-tasks";

import { DAY_MS } from "./users";
const DEMO_SCHEDULED_TASK_DEFINITIONS = [
  {
    key: "visit_hourly_rollup",
    name: "Hourly visit aggregation",
    description:
      "Aggregates closed visit rows into hourly rollups for dashboard counters and trends.",
    schedule: "Every hour",
    trigger: "cron" as const,
    enabled: true,
    internalSchedule: { kind: "interval" as const, everyMinutes: 60 as const },
  },
  {
    key: "notification_tick",
    name: "Notification dispatch",
    description: "Evaluates notification rules and dispatches messages.",
    schedule: "Every 30 minutes",
    trigger: "cron" as const,
    enabled: true,
    internalSchedule: { kind: "interval" as const, everyMinutes: 30 as const },
  },
  {
    key: "database_maintenance",
    name: "Database maintenance",
    description:
      "Removes expired operational records, marks stale runs, and optimizes D1 query statistics.",
    schedule: "Every day",
    trigger: "cron" as const,
    enabled: true,
    internalSchedule: { kind: "daily" as const, timezone: "UTC" as const },
  },
];
let demoScheduledTaskRetention = { ...DEFAULT_RETENTION_CONFIG };
const demoScheduledTaskEnabled = new Map<string, boolean>();
export function updateDemoScheduledTasks(input: {
  taskKey?: unknown;
  enabled?: unknown;
  retention?: Record<string, unknown>;
  retentionDays?: unknown;
}): void {
  if (typeof input.taskKey === "string" && input.enabled !== undefined) {
    const enabled =
      typeof input.enabled === "boolean"
        ? input.enabled
        : Number(input.enabled) !== 0;
    demoScheduledTaskEnabled.set(input.taskKey, enabled);
  }
  const retentionPatch = { ...(input.retention ?? {}) };
  if (input.retentionDays !== undefined) {
    retentionPatch.scheduledTaskLogsDays = input.retentionDays;
  }
  if (Object.keys(retentionPatch).length > 0) {
    demoScheduledTaskRetention = normalizeRetentionConfig({
      ...demoScheduledTaskRetention,
      ...retentionPatch,
    });
  }
}
const DEMO_SCHEDULED_TICK_MS = 30 * 60 * 1000;
const DEMO_SCHEDULED_TICKS = 30 * 24 * 2;
function demoScheduledTaskStatus(
  taskKey: string,
  index: number,
): ScheduledTaskStatus {
  if (taskKey === "notification_tick") {
    if (index > 0 && index % 29 === 0) return "failed";
    if (index % 17 === 0) return "partial";
    if (index % 11 === 0) return "skipped";
    return "success";
  }
  if (taskKey === "visit_hourly_rollup") {
    if (index > 0 && index % 37 === 0) return "failed";
    if (index % 23 === 0) return "partial";
    if (index % 19 === 0) return "skipped";
    return "success";
  }
  if (index > 0 && index % 13 === 0) return "partial";
  if (index > 0 && index % 17 === 0) return "skipped";
  return "success";
}
function demoScheduledRuns(now: number): ScheduledTaskRun[] {
  const runs: ScheduledTaskRun[] = [];
  const latestTick =
    Math.floor(now / DEMO_SCHEDULED_TICK_MS) * DEMO_SCHEDULED_TICK_MS;
  const retentionMs = demoScheduledTaskRetention.scheduledTaskLogsDays * DAY_MS;
  let runIndex = 0;

  const pushRun = (input: {
    definition: (typeof DEMO_SCHEDULED_TASK_DEFINITIONS)[number];
    index: number;
    scheduledAt: number;
    startedAt: number;
    status: ScheduledTaskStatus;
    summary: Record<string, unknown>;
    durationMs: number;
  }) => {
    const { definition, index, scheduledAt, startedAt, status, summary } =
      input;
    const durationMs = input.durationMs;
    runs.push({
      id: `demo-run-${String(runIndex++).padStart(5, "0")}`,
      invocationId: `demo-invocation-${String(index).padStart(5, "0")}`,
      taskKey: definition.key,
      taskName: definition.name,
      triggerType: "cron",
      status,
      scheduledAt,
      startedAt,
      finishedAt: startedAt + durationMs,
      durationMs,
      scopeType: "system",
      scopeId: null,
      summary,
      errorName:
        status === "failed"
          ? definition.key === "visit_hourly_rollup"
            ? "D1BatchError"
            : "TaskError"
          : null,
      errorMessage:
        status === "failed"
          ? definition.key === "visit_hourly_rollup"
            ? "D1 batch rejected while updating one site rollup"
            : "Task failed while processing the scheduled workload"
          : status === "partial"
            ? "One subtask failed; remaining work completed"
            : null,
      workerVersion: "demo",
      createdAt: startedAt,
      expiresAt: startedAt + retentionMs,
    });
  };

  for (let index = 0; index < DEMO_SCHEDULED_TICKS; index += 1) {
    const scheduledAt = latestTick - index * DEMO_SCHEDULED_TICK_MS;
    const tickOffset = sInt(
      mulberry32(fnv1a(`scheduled-tick:${index}:offset`)),
      8_000,
      90_000,
    );
    const notification = DEMO_SCHEDULED_TASK_DEFINITIONS[1]!;
    const notificationStatus = demoScheduledTaskStatus(notification.key, index);
    const notificationRng = mulberry32(fnv1a(`notification-run:${index}`));
    const rulesScanned =
      notificationStatus === "skipped" ? 0 : sInt(notificationRng, 3, 12);
    pushRun({
      definition: notification,
      index,
      scheduledAt,
      startedAt: scheduledAt + tickOffset,
      status: notificationStatus,
      durationMs:
        notificationStatus === "skipped"
          ? sInt(notificationRng, 120, 380)
          : sInt(notificationRng, 600, 2_400),
      summary: {
        rulesScanned,
        rulesChecked: rulesScanned,
        rulesTriggered:
          notificationStatus === "skipped" ? 0 : sInt(notificationRng, 0, 4),
        rulesSkipped: notificationStatus === "skipped" ? rulesScanned : 0,
        messagesCreated:
          notificationStatus === "skipped" ? 0 : sInt(notificationRng, 0, 3),
        emailFailed: notificationStatus === "partial" ? 1 : 0,
      },
    });

    if (scheduledAt % (60 * 60 * 1000) === 0) {
      const hourly = DEMO_SCHEDULED_TASK_DEFINITIONS[0]!;
      const hourlyStatus = demoScheduledTaskStatus(hourly.key, index);
      const hourlyRng = mulberry32(fnv1a(`hourly-run:${index}`));
      const processedSites =
        hourlyStatus === "skipped" ? 0 : sInt(hourlyRng, 7, 12);
      const failedSites =
        hourlyStatus === "failed" ? 3 : hourlyStatus === "partial" ? 1 : 0;
      const hoursAggregated =
        hourlyStatus === "skipped"
          ? 0
          : processedSites * sInt(hourlyRng, 4, 14);
      pushRun({
        definition: hourly,
        index,
        scheduledAt,
        startedAt: scheduledAt + tickOffset + 2_000,
        status: hourlyStatus,
        durationMs:
          hourlyStatus === "skipped"
            ? sInt(hourlyRng, 140, 420)
            : sInt(hourlyRng, 1_300, 7_800),
        summary: {
          cutoffMs: scheduledAt - 12 * 60 * 60 * 1000,
          candidateSites: processedSites + (hourlyStatus === "skipped" ? 0 : 1),
          sitesProcessed: processedSites,
          sitesFailed: failedSites,
          sitesBlockedByOpenVisit: hourlyStatus === "partial" ? 1 : 0,
          hoursAggregated,
          rollupRowsWritten:
            hourlyStatus === "skipped"
              ? 0
              : hoursAggregated - sInt(hourlyRng, 0, 6),
        },
      });
    }

    if (scheduledAt % DAY_MS === 0) {
      const maintenance = DEMO_SCHEDULED_TASK_DEFINITIONS[2]!;
      const maintenanceIndex = Math.floor(
        index / (DAY_MS / DEMO_SCHEDULED_TICK_MS),
      );
      const maintenanceStatus = demoScheduledTaskStatus(
        maintenance.key,
        maintenanceIndex,
      );
      const maintenanceRng = mulberry32(
        fnv1a(`maintenance-run:${maintenanceIndex}`),
      );
      pushRun({
        definition: maintenance,
        index,
        scheduledAt,
        startedAt: scheduledAt + tickOffset + 4_000,
        status: maintenanceStatus,
        durationMs: sInt(maintenanceRng, 900, 3_200),
        summary: {
          logsDeleted:
            maintenanceStatus === "skipped" ? 0 : sInt(maintenanceRng, 12, 80),
          runsDeleted:
            maintenanceStatus === "skipped" ? 0 : sInt(maintenanceRng, 0, 12),
          notificationsDeleted:
            maintenanceStatus === "skipped" ? 0 : sInt(maintenanceRng, 0, 20),
          staleRunsMarkedFailed:
            maintenanceStatus === "partial" ? 1 : sInt(maintenanceRng, 0, 2),
        },
      });
    }
  }
  return runs;
}
function demoScheduledLogs(run: ScheduledTaskRun): ScheduledTaskRunLog[] {
  if (run.status === "skipped") return [];
  const summary = run.summary as Record<string, number>;
  const base = run.startedAt;
  const finishLog = {
    id: `${run.id}-log-3`,
    runId: run.id,
    taskKey: run.taskKey,
    sequence: 3,
    level: run.status === "failed" ? ("error" as const) : ("info" as const),
    event: run.status === "failed" ? "error" : "finish",
    message:
      run.status === "failed"
        ? (run.errorMessage ?? "Task failed")
        : "Task run finished",
    data: { status: run.status, durationMs: run.durationMs as number },
    createdAt: run.finishedAt as number,
  } satisfies ScheduledTaskRunLog;
  const rows: ScheduledTaskRunLog[] = [
    {
      id: `${run.id}-log-1`,
      runId: run.id,
      taskKey: run.taskKey,
      sequence: 1,
      level: "info",
      event: "start",
      message: "Task run started",
      data: { triggerType: run.triggerType, scheduledAt: run.scheduledAt },
      createdAt: base,
    },
    {
      id: `${run.id}-log-2`,
      runId: run.id,
      taskKey: run.taskKey,
      sequence: 2,
      level: "info",
      event:
        run.taskKey === "notification_tick"
          ? "notification_candidates"
          : run.taskKey === "database_maintenance"
            ? "database_maintenance_finish"
            : "aggregation_candidates",
      message:
        run.taskKey === "notification_tick"
          ? "Loaded due notification rules"
          : run.taskKey === "database_maintenance"
            ? "Database maintenance finished"
            : "Aggregation candidates loaded",
      data:
        run.taskKey === "notification_tick"
          ? { count: summary.rulesScanned ?? 0 }
          : run.taskKey === "database_maintenance"
            ? {
                logsDeleted: summary.logsDeleted,
                runsDeleted: summary.runsDeleted,
                notificationsDeleted: summary.notificationsDeleted,
              }
            : {
                candidateSites: summary.candidateSites ?? 0,
                lagHours: 12,
                maxHoursPerSite: 168,
              },
      createdAt: base + 120,
    },
  ];
  if (run.status === "partial" || run.status === "failed") {
    rows.push({
      id: `${run.id}-log-extra`,
      runId: run.id,
      taskKey: run.taskKey,
      sequence: 3,
      level: run.status === "failed" ? "error" : "warn",
      event:
        run.taskKey === "notification_tick"
          ? "notification_rule_failed"
          : run.taskKey === "database_maintenance"
            ? "database_maintenance_warning"
            : "site_aggregation_failed",
      message: run.errorMessage ?? "A subtask failed",
      data: { error: run.errorMessage ?? "Unknown task failure" },
      createdAt: base + 360,
    });
  }
  rows.push({ ...finishLog, sequence: rows.length + 1 });
  return rows.sort((left, right) => left.sequence - right.sequence);
}
function demoRunGroupKey(run: ScheduledTaskRun): string {
  return run.scheduledAt !== null
    ? `${run.triggerType}:${run.scheduledAt}`
    : run.invocationId;
}
function demoAggregateRunSummary(
  runs: ScheduledTaskRun[],
): Record<string, unknown> {
  const summary: Record<string, unknown> = {};
  for (const run of runs) {
    for (const [key, value] of Object.entries(run.summary)) {
      if (typeof value !== "number" || !Number.isFinite(value)) continue;
      summary[key] = Number(summary[key] ?? 0) + value;
    }
  }
  return summary;
}
function demoSubtaskCount(run: ScheduledTaskRun): number {
  const summary = run.summary;
  const key = Object.prototype.hasOwnProperty.call(summary, "rulesScanned")
    ? "rulesScanned"
    : Object.prototype.hasOwnProperty.call(summary, "candidateSites")
      ? "candidateSites"
      : Object.prototype.hasOwnProperty.call(summary, "sitesProcessed")
        ? "sitesProcessed"
        : null;
  const value = key ? summary[key] : 0;
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}
function demoGroupStatus(runs: ScheduledTaskRun[]): ScheduledTaskStatus {
  if (runs.some((run) => run.status === "failed")) return "failed";
  if (runs.some((run) => run.status === "running")) return "running";
  if (runs.some((run) => run.status === "partial")) return "partial";
  const skipped = runs.filter((run) => run.status === "skipped").length;
  const successful = runs.filter((run) => run.status === "success").length;
  if (skipped > 0 && successful === 0) return "skipped";
  return "success";
}
function demoScheduledRunGroups(
  runs: ScheduledTaskRun[],
): ScheduledTaskRunGroup[] {
  const grouped = new Map<string, ScheduledTaskRun[]>();
  for (const run of runs) {
    const key = demoRunGroupKey(run);
    const groupRuns = grouped.get(key) ?? [];
    groupRuns.push(run);
    grouped.set(key, groupRuns);
  }
  return Array.from(grouped.entries())
    .map(([id, groupRuns]) => {
      const orderedRuns = [...groupRuns].sort(
        (left, right) =>
          left.startedAt - right.startedAt ||
          left.taskKey.localeCompare(right.taskKey),
      );
      const startedAt = Math.min(...orderedRuns.map((run) => run.startedAt));
      const finishedValues = orderedRuns.map((run) => run.finishedAt);
      const finishedAt = finishedValues.some((value) => value === null)
        ? null
        : Math.max(...(finishedValues as number[]));
      return {
        id,
        triggerType: orderedRuns[0]?.triggerType ?? "cron",
        status: demoGroupStatus(orderedRuns),
        scheduledAt: orderedRuns[0]?.scheduledAt ?? null,
        startedAt,
        finishedAt,
        durationMs:
          finishedAt === null ? null : Math.max(0, finishedAt - startedAt),
        taskCount: orderedRuns.length,
        subtaskCount: orderedRuns.reduce(
          (total, run) => total + demoSubtaskCount(run),
          0,
        ),
        successCount: countByStatus(orderedRuns, "success"),
        partialCount: countByStatus(orderedRuns, "partial"),
        failedCount: countByStatus(orderedRuns, "failed"),
        skippedCount: countByStatus(orderedRuns, "skipped"),
        runningCount: countByStatus(orderedRuns, "running"),
        logsCount: orderedRuns.reduce(
          (count, run) => count + demoScheduledLogs(run).length,
          0,
        ),
        summary: demoAggregateRunSummary(orderedRuns),
        runs: orderedRuns,
      };
    })
    .sort((left, right) => right.startedAt - left.startedAt);
}
function countByStatus<T extends { status: ScheduledTaskStatus }>(
  runs: T[],
  status: ScheduledTaskStatus,
) {
  return runs.filter((run) => run.status === status).length;
}
function demoNextRunAt(
  definition: (typeof DEMO_SCHEDULED_TASK_DEFINITIONS)[number],
  now: number,
): number {
  if (definition.internalSchedule.kind === "daily") {
    const todayUtc = new Date(now);
    return Date.UTC(
      todayUtc.getUTCFullYear(),
      todayUtc.getUTCMonth(),
      todayUtc.getUTCDate() + 1,
    );
  }
  const intervalMs = definition.internalSchedule.everyMinutes * 60 * 1000;
  return (Math.floor(now / intervalMs) + 1) * intervalMs;
}
function demoTaskSummary(
  definition: (typeof DEMO_SCHEDULED_TASK_DEFINITIONS)[number],
  runs: ScheduledTaskRun[],
  now: number,
): ScheduledTaskSummary {
  const taskRuns = runs.filter((run) => run.taskKey === definition.key);
  const success30d = countByStatus(taskRuns, "success");
  const durations = taskRuns
    .map((run) => run.durationMs)
    .filter((value): value is number => typeof value === "number");
  const enabled =
    demoScheduledTaskEnabled.get(definition.key) ?? definition.enabled;
  return {
    ...definition,
    enabled,
    lastRun: taskRuns[0] ?? null,
    runs30d: taskRuns.length,
    success30d,
    partial30d: countByStatus(taskRuns, "partial"),
    failed30d: countByStatus(taskRuns, "failed"),
    skipped30d: countByStatus(taskRuns, "skipped"),
    running: countByStatus(taskRuns, "running"),
    successRate30d: taskRuns.length > 0 ? success30d / taskRuns.length : null,
    nextRunAt: enabled ? demoNextRunAt(definition, now) : null,
    avgDurationMs:
      durations.length > 0
        ? durations.reduce((sum, value) => sum + value, 0) / durations.length
        : null,
  };
}
export function generateDemoScheduledTasks(
  params: Record<string, string | number>,
): ScheduledTasksData {
  const now = Date.now();
  const allRuns = demoScheduledRuns(now);
  const allGroups = demoScheduledRunGroups(allRuns);
  const status = String(params.status || "");
  const filteredRuns = allGroups.filter(
    (run) => !status || run.status === status,
  );
  const runsPage = demoPage(
    filteredRuns,
    params,
    {
      operation: "scheduled-runs",
      status,
      sort: "startedAt:desc,groupId:asc",
    },
    50,
    100,
  );
  const runs = runsPage.items;
  const requestedRunId = String(params.runId || "");
  const selectedRun =
    (requestedRunId
      ? (filteredRuns.find((run) => run.id === requestedRunId) ??
        filteredRuns.find((group) =>
          group.runs.some((run) => run.id === requestedRunId),
        ) ??
        null)
      : runs[0]) ?? null;
  const runs24h = allGroups.filter(
    (run) => run.startedAt >= now - 24 * 60 * 60 * 1000,
  );
  const success24h = countByStatus(runs24h, "success");
  return {
    ok: true,
    generatedAt: now,
    retentionDays: demoScheduledTaskRetention.scheduledTaskLogsDays,
    retention: { ...demoScheduledTaskRetention },
    tasks: DEMO_SCHEDULED_TASK_DEFINITIONS.map((task) =>
      demoTaskSummary(task, allRuns, now),
    ),
    runs: {
      items: runs,
      pagination: runsPage.pagination,
    },
    selectedRun,
    logs: (() => {
      const items = selectedRun
        ? selectedRun.runs.flatMap((run) => demoScheduledLogs(run))
        : [];
      const logPage = demoPage(
        items,
        { ...params, cursor: params.logCursor ?? "" },
        {
          operation: "scheduled-run-logs",
          runId: selectedRun?.id ?? null,
          sort: "runStartedAt:asc,runId:asc,sequence:asc,logId:asc",
        },
        200,
        200,
      );
      return {
        items: logPage.items,
        pagination: logPage.pagination,
      };
    })(),
    health: {
      totalRuns24h: runs24h.length,
      failedRuns24h: countByStatus(runs24h, "failed"),
      partialRuns24h: countByStatus(runs24h, "partial"),
      runningRuns: countByStatus(runs24h, "running"),
      staleRunningRuns: 0,
      successRate24h: runs24h.length > 0 ? success24h / runs24h.length : null,
      lastRunAt: allRuns[0]?.startedAt ?? null,
    },
  };
}
