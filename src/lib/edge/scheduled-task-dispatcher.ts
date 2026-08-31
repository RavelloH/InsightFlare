import { runNotificationTick } from "@/lib/notifications/notification-task";

import { runDatabaseMaintenance } from "./database-maintenance";
import { runHourlyAggregation } from "./hourly-rollup";
import type { InvocationLogger } from "./observability-logger";
import { SCHEDULED_TASKS } from "./scheduled-task-registry";
import { runScheduledTask, STALE_RUNNING_MS } from "./scheduled-task-runner";
import type { Env } from "./types";

const TASK_ORDER = [
  "notification_tick",
  "visit_hourly_rollup",
  "database_maintenance",
] as const;

interface ScheduleStateRow {
  taskKey: string;
  enabled: number;
  nextRunAt: number;
}

function nowSeconds(scheduledTime: number): number {
  return Math.max(0, Math.trunc(scheduledTime / 1000));
}

function nextDailyRunAt(now: number): number {
  const next = new Date(now * 1000);
  next.setUTCHours(0, 0, 0, 0);
  next.setUTCDate(next.getUTCDate() + 1);
  return Math.trunc(next.getTime() / 1000);
}

function nextRunAt(taskKey: string, now: number): number {
  const definition = SCHEDULED_TASKS.find((task) => task.key === taskKey);
  if (!definition) return now + 30 * 60;
  const schedule = definition.internalSchedule;
  if (schedule.kind === "daily") return nextDailyRunAt(now);
  const intervalSeconds = schedule.everyMinutes * 60;
  return (Math.floor(now / intervalSeconds) + 1) * intervalSeconds;
}

async function loadDueStates(
  env: Env,
  now: number,
): Promise<ScheduleStateRow[]> {
  const result = await env.DB.prepare(
    `
      SELECT
        task_key AS taskKey,
        enabled,
        next_run_at AS nextRunAt
      FROM scheduled_task_schedule_state
      WHERE enabled = 1 AND next_run_at <= ?
    `,
  )
    .bind(now)
    .all<ScheduleStateRow>();
  const due = new Map(result.results.map((row) => [String(row.taskKey), row]));
  return TASK_ORDER.flatMap((key) => {
    const row = due.get(key);
    return row ? [row] : [];
  });
}

async function claimTask(
  env: Env,
  taskKey: string,
  now: number,
  claimToken: string,
): Promise<boolean> {
  try {
    const result = await env.DB.prepare(
      `
        UPDATE scheduled_task_schedule_state
        SET claim_token = ?,
            claim_expires_at = ?,
            updated_at = unixepoch()
        WHERE task_key = ?
          AND enabled = 1
          AND next_run_at <= ?
          AND (
            claim_token IS NULL OR claim_expires_at IS NULL OR claim_expires_at < ?
          )
      `,
    )
      .bind(
        claimToken,
        now + Math.trunc(STALE_RUNNING_MS / 1000),
        taskKey,
        now,
        now,
      )
      .run();
    return Number(result.meta?.changes ?? 0) === 1;
  } catch {
    // Claiming is fail-closed: a database error must not turn into duplicate
    // work by allowing the task handler to run without ownership.
    return false;
  }
}

async function releaseTask(
  env: Env,
  taskKey: string,
  claimToken: string,
  scheduledTime: number,
  error: unknown,
): Promise<void> {
  const now = nowSeconds(scheduledTime);
  const next = nextRunAt(taskKey, now);
  const lastError = error ? String(error).slice(0, 1000) : null;
  await env.DB.prepare(
    `
      UPDATE scheduled_task_schedule_state
      SET last_run_at = ?,
          next_run_at = ?,
          claim_token = NULL,
          claim_expires_at = NULL,
          last_error = ?,
          updated_at = unixepoch()
      WHERE task_key = ? AND claim_token = ?
    `,
  )
    .bind(now, next, lastError, taskKey, claimToken)
    .run();
}

async function executeTask(
  env: Env,
  taskKey: string,
  scheduledTime: number,
  observability: InvocationLogger,
): Promise<void> {
  const definition = SCHEDULED_TASKS.find((task) => task.key === taskKey);
  if (!definition) return;
  const claimToken = crypto.randomUUID();
  const now = nowSeconds(scheduledTime);
  if (!(await claimTask(env, taskKey, now, claimToken))) return;

  try {
    const taskDefinition = {
      key: definition.key,
      name: definition.name,
      triggerType: "cron" as const,
    };
    if (taskKey === "notification_tick") {
      await runScheduledTask(
        env,
        taskDefinition,
        scheduledTime,
        runNotificationTick,
        observability,
      );
    } else if (taskKey === "visit_hourly_rollup") {
      await runScheduledTask(
        env,
        taskDefinition,
        scheduledTime,
        ({ logger }) => runHourlyAggregation(env, scheduledTime, { logger }),
        observability,
      );
    } else {
      await runScheduledTask(
        env,
        taskDefinition,
        scheduledTime,
        runDatabaseMaintenance,
        observability,
      );
    }
    await releaseTask(env, taskKey, claimToken, scheduledTime, null);
  } catch (error) {
    try {
      await releaseTask(env, taskKey, claimToken, scheduledTime, error);
    } catch {
      observability.warn("scheduled_task.claim_release_failed");
    }
    observability.error("scheduled_task.handler_failed");
  }
}

export async function dispatchInternalScheduledTasks(
  env: Env,
  scheduledTime: number,
  observability: InvocationLogger,
): Promise<void> {
  const dueStates = await loadDueStates(env, nowSeconds(scheduledTime));
  for (const state of dueStates) {
    await executeTask(env, state.taskKey, scheduledTime, observability);
  }
}
