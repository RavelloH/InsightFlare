import {
  and,
  compileD1Mutation,
  compileD1Query,
  createD1DatabaseClient,
  eq,
  filter,
  isNull,
  lt,
  lte,
  or,
  param,
  project,
  scan,
  unixepoch,
  update,
} from "@/lib/db";
import { schema } from "@/lib/db/schema";
import type { InvocationLogger } from "@/lib/edge/observability/logger";
import type { Env } from "@/lib/edge/types";
import { runNotificationTick } from "@/lib/notifications/edge/notification-task";

import { runDatabaseMaintenance } from "./database-maintenance";
import { runHourlyAggregation } from "./hourly-rollup";
import { SCHEDULED_TASKS } from "./registry";
import { runScheduledTask, STALE_RUNNING_MS } from "./runner";

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
  const scheduleState = schema.scheduled_task_schedule_state;
  const states = scan(scheduleState);
  const dueStates = filter(
    states,
    and(
      eq(states.columns.enabled, param(1)),
      lte(states.columns.next_run_at, param(now)),
    ),
  );
  const query = project(dueStates, {
    taskKey: dueStates.columns.task_key,
    enabled: dueStates.columns.enabled,
    nextRunAt: dueStates.columns.next_run_at,
  });
  const result = await createD1DatabaseClient(env.DB).all(
    compileD1Query(query, {
      tag: "scheduled-tasks.scheduled_task_schedule_state.all",
    }),
  );
  const due = new Map<string, (typeof result.results)[number]>();
  for (const row of result.results) {
    if (typeof row.taskKey !== "string") continue;
    due.set(row.taskKey, row);
  }
  return TASK_ORDER.flatMap((key) => {
    const row = due.get(key);
    // Only known scheduled tasks survive this allowlisted key lookup, so the
    // nullable PK reported by generated schema metadata is refined here.
    return row ? [{ ...row, taskKey: key }] : [];
  });
}

async function claimTask(
  env: Env,
  taskKey: string,
  now: number,
  claimToken: string,
): Promise<boolean> {
  try {
    const scheduleState = schema.scheduled_task_schedule_state;
    const result = await createD1DatabaseClient(env.DB).run(
      compileD1Mutation(
        update(scheduleState, (columns) => ({
          set: {
            claim_token: claimToken,
            claim_expires_at: now + Math.trunc(STALE_RUNNING_MS / 1000),
            updated_at: unixepoch(),
          },
          where: and(
            eq(columns.task_key, param(taskKey)),
            eq(columns.enabled, param(1)),
            lte(columns.next_run_at, param(now)),
            or(
              isNull(columns.claim_token),
              isNull(columns.claim_expires_at),
              lt(columns.claim_expires_at, param(now)),
            ),
          ),
        })),
        { tag: "scheduled_tasks.dispatcher.claim" },
      ),
    );
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
  const scheduleState = schema.scheduled_task_schedule_state;
  await createD1DatabaseClient(env.DB).run(
    compileD1Mutation(
      update(scheduleState, (columns) => ({
        set: {
          last_run_at: now,
          next_run_at: next,
          claim_token: null,
          claim_expires_at: null,
          last_error: lastError,
          updated_at: unixepoch(),
        },
        where: and(
          eq(columns.task_key, param(taskKey)),
          eq(columns.claim_token, param(claimToken)),
        ),
      })),
      { tag: "scheduled_tasks.dispatcher.complete" },
    ),
  );
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
