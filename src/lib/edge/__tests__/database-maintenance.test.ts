import type { DatabaseSync } from "node:sqlite";

import { describe, expect, it } from "vitest";

import { createMigratedDatabase } from "@/../scripts/schema/database";
import { runDatabaseMaintenance } from "@/lib/edge/scheduled-tasks/database-maintenance";

class FakeD1Database {
  readonly db: DatabaseSync;

  constructor() {
    this.db = createMigratedDatabase();
  }

  prepare(sql: string) {
    return {
      bind: (...bindings: Array<string | number | null>) => ({
        run: async () => ({
          meta: {
            changes: Number(this.db.prepare(sql).run(...bindings).changes),
          },
        }),
      }),
      run: async () => ({
        meta: { changes: Number(this.db.prepare(sql).run().changes) },
      }),
    };
  }

  close() {
    this.db.close();
  }
}

function context(d1: FakeD1Database) {
  const logger = {
    debug: async () => undefined,
    info: async () => undefined,
    warn: async () => undefined,
    error: async () => undefined,
  };
  return {
    env: { DB: d1 as unknown as D1Database },
    runId: "maintenance-run",
    invocationId: "maintenance-invocation",
    scheduledTime: Date.now(),
    startedAt: Date.now(),
    logger,
    externalFetch: fetch,
  } as never;
}

describe("database maintenance", () => {
  it("deletes expired records in batches and preserves null/future records", async () => {
    const d1 = new FakeD1Database();
    d1.db
      .prepare(
        "INSERT INTO users (id, email, name, username) VALUES (?, ?, ?, ?)",
      )
      .run("user-1", "user@example.test", "User", "user");
    d1.db
      .prepare(
        "INSERT INTO teams (id, name, slug, owner_user_id) VALUES (?, ?, ?, ?)",
      )
      .run("team-1", "Team", "team", "user-1");
    const now = Math.floor(Date.now() / 1000);
    const insertLog = d1.db.prepare(
      `INSERT INTO scheduled_task_run_logs (
        id, run_id, task_key, sequence, level, event, message,
        created_at_ms, expires_at
      ) VALUES (?, 'run-1', 'task-1', ?, 'info', 'event', 'message', ?, ?)`,
    );
    for (let index = 0; index < 105; index += 1) {
      insertLog.run(`expired-log-${index}`, index, Date.now(), now - 1);
    }
    insertLog.run("future-log", 105, Date.now(), now + 100);
    d1.db
      .prepare(
        `INSERT INTO scheduled_task_runs (
          id, invocation_id, task_key, task_name, trigger_type, status,
          started_at_ms, scope_type, summary_json, created_at, expires_at
        ) VALUES (?, 'invocation-1', 'task-1', 'Task', 'schedule', ?, ?, 'global', '{}', ?, ?)`,
      )
      .run(
        "stale-run",
        "running",
        Date.now() - 7 * 60 * 60 * 1000,
        now,
        now + 100,
      );
    const insertNotification = d1.db.prepare(
      `INSERT INTO notification_messages (
        id, team_id, user_id, type, severity, requires_attention, title,
        data_json, channels_json, delivery_status, delivery_results_json,
        created_at, updated_at, expires_at
      ) VALUES (?, 'team-1', 'user-1', 'system', 'info', 0, 'Notice',
        '{}', '[]', 'sent', '{}', ?, ?, ?)`,
    );
    insertNotification.run("expired-notification", now, now, now - 1);
    insertNotification.run("null-notification", now, now, null);

    const result = await runDatabaseMaintenance(context(d1));

    expect(result).toMatchObject({
      status: "success",
      summary: {
        logsDeleted: 105,
        runsDeleted: 0,
        notificationsDeleted: 1,
        staleRunsMarkedFailed: 1,
      },
    });
    expect(
      d1.db
        .prepare("SELECT COUNT(*) AS count FROM scheduled_task_run_logs")
        .get(),
    ).toEqual({
      count: 1,
    });
    expect(
      d1.db
        .prepare(
          "SELECT status, error_name AS errorName FROM scheduled_task_runs WHERE id = ?",
        )
        .get("stale-run"),
    ).toMatchObject({ status: "failed", errorName: "StaleRun" });
    expect(
      d1.db
        .prepare("SELECT COUNT(*) AS count FROM notification_messages")
        .get(),
    ).toEqual({ count: 1 });
    d1.close();
  });
});
