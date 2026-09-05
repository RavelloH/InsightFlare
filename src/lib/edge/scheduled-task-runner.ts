import { measureExternalFetch } from "@/lib/edge/observability-bindings";
import {
  currentInvocationLogger,
  type InvocationLogger,
} from "@/lib/edge/observability-logger";
import {
  type ScheduledTaskLogLevel,
  type ScheduledTaskRetentionConfig,
  type ScheduledTaskStatus,
} from "@/lib/scheduled-tasks";

import { readRetentionConfig } from "./retention-config";
import type { Env } from "./types";

type JsonValue =
  string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

type LogData = Record<string, JsonValue>;

export interface ScheduledTaskLogger {
  debug(event: string, message: string, data?: LogData): Promise<void>;
  info(event: string, message: string, data?: LogData): Promise<void>;
  warn(event: string, message: string, data?: LogData): Promise<void>;
  error(event: string, message: string, data?: LogData): Promise<void>;
}

export interface ScheduledTaskContext {
  env: Env;
  runId: string;
  invocationId: string;
  scheduledTime: number | null;
  startedAt: number;
  logger: ScheduledTaskLogger;
  externalFetch: typeof fetch;
  retention?: ScheduledTaskRetentionConfig;
}

export interface ScheduledTaskDefinition {
  key: string;
  name: string;
  triggerType?: "cron" | "manual" | "retry";
  scopeType?: string;
  scopeId?: string | null;
}

export interface ScheduledTaskOutcome {
  status?: Exclude<ScheduledTaskStatus, "running">;
  summary?: Record<string, unknown>;
}

export const STALE_RUNNING_MS = 6 * 60 * 60 * 1000;
const MAX_BUFFERED_LOG_ENTRIES = 500;
const MAX_BUFFERED_LOG_BYTES = 512 * 1024;
const LOG_BATCH_SIZE = 50;

function safeJsonStringify(value: unknown): string {
  try {
    return JSON.stringify(value ?? {});
  } catch {
    return "{}";
  }
}

function normalizeError(error: unknown): {
  name: string;
  message: string;
  stack: string | null;
} {
  if (error instanceof Error) {
    return {
      name: error.name || "Error",
      message: error.message || "Scheduled task failed",
      stack: error.stack ?? null,
    };
  }
  return {
    name: "Error",
    message: String(error || "Scheduled task failed"),
    stack: null,
  };
}

function normalizeScheduledAtMs(
  scheduledTime: number | undefined,
): number | null {
  if (typeof scheduledTime !== "number" || !Number.isFinite(scheduledTime)) {
    return null;
  }
  return scheduledTime;
}

async function bestEffortRun(
  label: string,
  action: () => Promise<void>,
  observability?: Pick<InvocationLogger, "warn">,
): Promise<void> {
  try {
    await action();
  } catch (error) {
    void label;
    void error;
    observability?.warn("scheduled_task.persistence_write_failed");
  }
}

interface BufferedTaskLogger {
  logger: ScheduledTaskLogger;
  flush(): Promise<void>;
}

function createLogger(
  env: Env,
  runId: string,
  taskKey: string,
  expiresAtSec: number,
  observability?: InvocationLogger,
): BufferedTaskLogger {
  let sequence = 0;
  let bufferedBytes = 0;
  const entries: Array<{
    id: string;
    sequence: number;
    level: ScheduledTaskLogLevel;
    event: string;
    message: string;
    dataJson: string;
    createdAtMs: number;
  }> = [];
  const write = async (
    level: ScheduledTaskLogLevel,
    event: string,
    message: string,
    data: LogData = {},
  ) => {
    sequence += 1;
    const createdAtMs = Date.now();
    const dataJson = safeJsonStringify(data);
    const encodedBytes = event.length + message.length + dataJson.length + 160;
    if (
      entries.length < MAX_BUFFERED_LOG_ENTRIES &&
      bufferedBytes + encodedBytes <= MAX_BUFFERED_LOG_BYTES
    ) {
      entries.push({
        id: crypto.randomUUID(),
        sequence,
        level,
        event: event.slice(0, 120),
        message: message.slice(0, 500),
        dataJson,
        createdAtMs,
      });
      bufferedBytes += encodedBytes;
    }
    // Persisted task logs can contain operator-facing identifiers. The Worker
    // record mirrors only the stable event and level, never its message/data.
    const eventCode = `scheduled_task.${event.slice(0, 120)}`;
    if (level === "error") observability?.error(eventCode);
    else if (level === "warn") observability?.warn(eventCode);
    else observability?.info(eventCode);
  };
  return {
    logger: {
      debug: (event, message, data) => write("debug", event, message, data),
      info: (event, message, data) => write("info", event, message, data),
      warn: (event, message, data) => write("warn", event, message, data),
      error: (event, message, data) => write("error", event, message, data),
    },
    async flush() {
      if (entries.length === 0) return;
      const statements = entries.map((entry) =>
        env.DB.prepare(
          `
              INSERT INTO scheduled_task_run_logs (
                id, run_id, task_key, sequence, level, event, message,
                data_json, created_at_ms, expires_at
              ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            `,
        ).bind(
          entry.id,
          runId,
          taskKey,
          entry.sequence,
          entry.level,
          entry.event,
          entry.message,
          entry.dataJson,
          entry.createdAtMs,
          expiresAtSec,
        ),
      );
      await bestEffortRun(
        "logs-flush",
        async () => {
          for (
            let offset = 0;
            offset < statements.length;
            offset += LOG_BATCH_SIZE
          ) {
            await env.DB.batch(
              statements.slice(offset, offset + LOG_BATCH_SIZE),
            );
          }
        },
        observability,
      );
      entries.length = 0;
    },
  };
}

export async function runScheduledTask(
  env: Env,
  definition: ScheduledTaskDefinition,
  scheduledTime: number | undefined,
  handler: (
    context: ScheduledTaskContext,
  ) => Promise<ScheduledTaskOutcome | undefined>,
  observability?: InvocationLogger,
): Promise<void> {
  // Manual tasks run beneath the Hono request scope; Cron supplies its logger
  // explicitly. Either path must keep task work in the outer invocation record.
  const activeObservability = observability ?? currentInvocationLogger();
  const startedAt = Date.now();
  const triggerType = definition.triggerType ?? "cron";
  const scheduledAt = normalizeScheduledAtMs(scheduledTime);
  const runId = crypto.randomUUID();
  const invocationId = crypto.randomUUID();
  const retention = await readRetentionConfig(env);
  const expiresAtSec =
    Math.floor(startedAt / 1000) +
    retention.scheduledTaskLogsDays * 24 * 60 * 60;

  await bestEffortRun(
    "run-start",
    async () => {
      await env.DB.prepare(
        `
        INSERT INTO scheduled_task_runs (
          id, invocation_id, task_key, task_name, trigger_type, status,
          scheduled_at_ms, started_at_ms, scope_type, scope_id, summary_json,
          worker_version, expires_at
        ) VALUES (?, ?, ?, ?, ?, 'running', ?, ?, ?, ?, '{}', ?, ?)
      `,
      )
        .bind(
          runId,
          invocationId,
          definition.key,
          definition.name,
          triggerType,
          scheduledAt,
          startedAt,
          definition.scopeType ?? "system",
          definition.scopeId ?? null,
          null,
          expiresAtSec,
        )
        .run();
    },
    activeObservability,
  );

  const buffered = createLogger(
    env,
    runId,
    definition.key,
    expiresAtSec,
    activeObservability,
  );
  const logger = buffered.logger;
  await logger.info("start", "Task run started", {
    triggerType,
    scheduledAt,
  });

  try {
    const outcome = (await handler({
      env,
      runId,
      invocationId,
      scheduledTime: scheduledAt,
      startedAt,
      logger,
      retention,
      externalFetch: (...args) =>
        measureExternalFetch(
          activeObservability,
          "external_fetch.scheduled_task",
          () => fetch(...args),
        ),
    })) ?? { status: "success" as const };
    const finishedAt = Date.now();
    const status = outcome.status ?? "success";
    const summary = outcome.summary ?? {};
    await logger.info("finish", "Task run finished", {
      status,
      durationMs: finishedAt - startedAt,
    });
    if (status !== "skipped") await buffered.flush();
    await bestEffortRun(
      "run-finish",
      async () => {
        await env.DB.prepare(
          `
          UPDATE scheduled_task_runs
          SET
            status = ?,
            finished_at_ms = ?,
            duration_ms = ?,
            summary_json = ?,
            error_name = NULL,
            error_message = NULL,
            error_stack = NULL
          WHERE id = ?
        `,
        )
          .bind(
            status,
            finishedAt,
            finishedAt - startedAt,
            safeJsonStringify(summary),
            runId,
          )
          .run();
      },
      activeObservability,
    );
  } catch (error) {
    const finishedAt = Date.now();
    const normalized = normalizeError(error);
    await logger.error("error", normalized.message, {
      name: normalized.name,
    });
    await buffered.flush();
    await bestEffortRun(
      "run-error",
      async () => {
        await env.DB.prepare(
          `
          UPDATE scheduled_task_runs
          SET
            status = 'failed',
            finished_at_ms = ?,
            duration_ms = ?,
            summary_json = ?,
            error_name = ?,
            error_message = ?,
            error_stack = ?
          WHERE id = ?
        `,
        )
          .bind(
            finishedAt,
            finishedAt - startedAt,
            "{}",
            normalized.name.slice(0, 120),
            normalized.message.slice(0, 1000),
            normalized.stack?.slice(0, 4000) ?? null,
            runId,
          )
          .run();
      },
      activeObservability,
    );
    throw error;
  }
}
