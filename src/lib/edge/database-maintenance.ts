import type {
  ScheduledTaskContext,
  ScheduledTaskOutcome,
} from "./scheduled-task-runner";

const DELETE_BATCH_SIZE = 100;
const MAX_DELETE_BATCHES_PER_TABLE = 1000;
const STALE_RUNNING_MS = 6 * 60 * 60 * 1000;

async function deleteExpiredInBatches(
  context: ScheduledTaskContext,
  table:
    | "scheduled_task_run_logs"
    | "scheduled_task_runs"
    | "notification_messages",
): Promise<number> {
  let deleted = 0;
  for (let batch = 0; batch < MAX_DELETE_BATCHES_PER_TABLE; batch += 1) {
    const result = await context.env.DB.prepare(
      `
        DELETE FROM ${table}
        WHERE id IN (
          SELECT id
          FROM ${table}
          WHERE expires_at < unixepoch()
          ORDER BY expires_at ASC
          LIMIT ?
        )
      `,
    )
      .bind(DELETE_BATCH_SIZE)
      .run();
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
  const staleResult = await env.DB.prepare(
    `
      UPDATE scheduled_task_runs
      SET
        status = 'failed',
        finished_at_ms = ?,
        duration_ms = ? - started_at_ms,
        error_name = COALESCE(error_name, 'StaleRun'),
        error_message = COALESCE(
          error_message,
          'Task run did not finish before the stale threshold'
        )
      WHERE status = 'running'
        AND started_at_ms < ?
    `,
  )
    .bind(now, now, now - STALE_RUNNING_MS)
    .run();
  const staleRunsMarkedFailed = Number(staleResult.meta?.changes ?? 0);

  // D1 supports PRAGMA optimize and uses it to refresh query-planner
  // statistics after the maintenance deletes.
  await env.DB.prepare("PRAGMA optimize").run();
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
