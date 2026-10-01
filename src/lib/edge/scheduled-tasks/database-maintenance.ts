import {
  and,
  coalesce,
  compileD1Mutation,
  createD1DatabaseClient,
  deleteFrom,
  eq,
  filter,
  inSubquery,
  limit,
  lt,
  param,
  project,
  scan,
  schema,
  sort,
  sub,
  unixepoch,
  update,
} from "@/lib/db";
import { optimizeD1Database } from "@/lib/db/d1-maintenance";

import type { ScheduledTaskContext, ScheduledTaskOutcome } from "./runner";

const DELETE_BATCH_SIZE = 100;
const MAX_DELETE_BATCHES_PER_TABLE = 1000;
const STALE_RUNNING_MS = 6 * 60 * 60 * 1000;
type ExpirableTable =
  | typeof schema.scheduled_task_run_logs
  | typeof schema.scheduled_task_runs
  | typeof schema.notification_messages;

function expiredBatchMutation(table: ExpirableTable) {
  const rows = scan(table);
  const expired = filter(rows, lt(rows.columns.expires_at, unixepoch()));
  const ordered = sort(expired, [
    { expression: expired.columns.expires_at, direction: "ASC" },
  ]);
  const limited = limit(ordered, DELETE_BATCH_SIZE);
  const batch = project(limited, {
    id: limited.columns.id,
  });
  return compileD1Mutation(
    deleteFrom(table, (target) => inSubquery(target.id, batch)),
    { tag: "scheduled_tasks.maintenance.delete_expired_batch" },
  );
}

async function deleteExpiredInBatches(
  context: ScheduledTaskContext,
  table:
    "scheduled_task_run_logs" | "scheduled_task_runs" | "notification_messages",
): Promise<number> {
  let deleted = 0;
  const client = createD1DatabaseClient(context.env.DB);
  const mutation =
    table === "scheduled_task_run_logs"
      ? expiredBatchMutation(schema.scheduled_task_run_logs)
      : table === "scheduled_task_runs"
        ? expiredBatchMutation(schema.scheduled_task_runs)
        : expiredBatchMutation(schema.notification_messages);
  for (let batch = 0; batch < MAX_DELETE_BATCHES_PER_TABLE; batch += 1) {
    const result = await client.run(mutation);
    const changes = Number(result.meta?.changes ?? 0);
    deleted += changes;
    if (changes < DELETE_BATCH_SIZE) break;
  }
  return deleted;
}

export async function runDatabaseMaintenance(
  context: ScheduledTaskContext,
): Promise<ScheduledTaskOutcome> {
  const { env, logger } = context;
  await logger.info(
    "database_maintenance_start",
    "Database maintenance started",
  );

  const logsDeleted = await deleteExpiredInBatches(
    context,
    "scheduled_task_run_logs",
  );
  const runsDeleted = await deleteExpiredInBatches(
    context,
    "scheduled_task_runs",
  );
  const notificationsDeleted = await deleteExpiredInBatches(
    context,
    "notification_messages",
  );

  const now = Date.now();
  const scheduledRuns = schema.scheduled_task_runs;
  const staleUpdate = update(scheduledRuns, (columns) => ({
    set: {
      status: "failed",
      finished_at_ms: now,
      duration_ms: sub(param(now), columns.started_at_ms),
      error_name: coalesce(columns.error_name, param("StaleRun")),
      error_message: coalesce(
        columns.error_message,
        param("Task run did not finish before the stale threshold"),
      ),
    },
    where: and(
      eq(columns.status, param("running")),
      lt(columns.started_at_ms, param(now - STALE_RUNNING_MS)),
    ),
  }));
  const staleResult = await createD1DatabaseClient(env.DB).run(
    compileD1Mutation(staleUpdate, {
      tag: "scheduled_tasks.maintenance.fail_stale_runs",
    }),
  );
  const staleRunsMarkedFailed = Number(staleResult.meta?.changes ?? 0);

  // D1 supports PRAGMA optimize and uses it to refresh query-planner
  // statistics after the maintenance deletes.
  await optimizeD1Database(env.DB);
  const summary = {
    logsDeleted,
    runsDeleted,
    notificationsDeleted,
    staleRunsMarkedFailed,
  };
  await logger.info(
    "database_maintenance_finish",
    "Database maintenance finished",
    summary,
  );
  return { status: "success", summary };
}
