import { DatabaseSync } from "node:sqlite";

import { describe, expect, it } from "vitest";

import { runDatabaseMaintenance } from "@/lib/edge/database-maintenance";

class FakeD1Database {
  readonly db = new DatabaseSync(":memory:");

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
    d1.db.exec(`
      CREATE TABLE scheduled_task_run_logs (id TEXT PRIMARY KEY, expires_at INTEGER);
      CREATE TABLE scheduled_task_runs (
        id TEXT PRIMARY KEY,
        expires_at INTEGER,
        status TEXT NOT NULL,
        started_at_ms INTEGER NOT NULL,
        finished_at_ms INTEGER,
        duration_ms INTEGER,
        error_name TEXT,
        error_message TEXT
      );
      CREATE TABLE notification_messages (id TEXT PRIMARY KEY, expires_at INTEGER);
    `);
    const now = Math.floor(Date.now() / 1000);
    for (let index = 0; index < 105; index += 1) {
      d1.db
        .prepare(
          "INSERT INTO scheduled_task_run_logs (id, expires_at) VALUES (?, ?)",
        )
        .run(`expired-log-${index}`, now - 1);
    }
    d1.db
      .prepare(
        "INSERT INTO scheduled_task_run_logs (id, expires_at) VALUES (?, ?)",
      )
      .run("future-log", now + 100);
    d1.db
      .prepare(
        "INSERT INTO scheduled_task_run_logs (id, expires_at) VALUES (?, NULL)",
      )
      .run("null-log");
    d1.db
      .prepare(
        "INSERT INTO scheduled_task_runs (id, expires_at, status, started_at_ms) VALUES (?, ?, ?, ?)",
      )
      .run("stale-run", now + 100, "running", Date.now() - 7 * 60 * 60 * 1000);
    d1.db
      .prepare(
        "INSERT INTO notification_messages (id, expires_at) VALUES (?, ?)",
      )
      .run("expired-notification", now - 1);

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
      count: 2,
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
    ).toEqual({ count: 0 });
    d1.close();
  });
});
