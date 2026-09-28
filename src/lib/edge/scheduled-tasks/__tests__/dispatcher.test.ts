import { DatabaseSync } from "node:sqlite";

import { beforeEach, describe, expect, it, vi } from "vitest";

const runScheduledTask = vi.hoisted(() => vi.fn());
const runHourlyAggregation = vi.hoisted(() => vi.fn());
const runNotificationTick = vi.hoisted(() => vi.fn());
const runDatabaseMaintenance = vi.hoisted(() => vi.fn());

vi.mock("@/lib/edge/scheduled-tasks/runner", () => ({
  STALE_RUNNING_MS: 6 * 60 * 60 * 1000,
  runScheduledTask,
}));
vi.mock("@/lib/edge/scheduled-tasks/hourly-rollup", () => ({
  runHourlyAggregation,
}));
vi.mock("@/lib/notifications/edge/notification-task", () => ({
  runNotificationTick,
}));
vi.mock("@/lib/edge/scheduled-tasks/database-maintenance", () => ({
  runDatabaseMaintenance,
}));

const { dispatchInternalScheduledTasks } =
  await import("@/lib/edge/scheduled-tasks/dispatcher");

class FakeD1Database {
  readonly db = new DatabaseSync(":memory:");
  readonly calls: Array<{ method: "all" | "run"; sql: string }> = [];
  failNextUpdate = false;

  constructor() {
    this.db.exec(`
      CREATE TABLE scheduled_task_schedule_state (
        task_key TEXT PRIMARY KEY,
        enabled INTEGER NOT NULL DEFAULT 1,
        next_run_at INTEGER NOT NULL,
        last_run_at INTEGER,
        claim_token TEXT,
        claim_expires_at INTEGER,
        last_error TEXT,
        updated_at INTEGER NOT NULL DEFAULT (unixepoch())
      );
    `);
  }

  prepare(sql: string) {
    const database = this.db;
    return {
      bind: (...bindings: Array<string | number | null>) => ({
        all: async <T>() => {
          this.calls.push({ method: "all", sql });
          return {
            results: database
              .prepare(sql)
              .all(...bindings)
              .map((row) => ({ ...row }) as T),
          };
        },
        run: async () => {
          this.calls.push({ method: "run", sql });
          if (this.failNextUpdate && sql.includes("UPDATE")) {
            this.failNextUpdate = false;
            throw new Error("database unavailable");
          }
          return {
            meta: {
              changes: Number(database.prepare(sql).run(...bindings).changes),
            },
          };
        },
      }),
    };
  }

  close() {
    this.db.close();
  }
}

function observability() {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  } as never;
}

function seed(d1: FakeD1Database, key: string, nextRunAt: number, enabled = 1) {
  d1.db
    .prepare(
      "INSERT INTO scheduled_task_schedule_state (task_key, enabled, next_run_at) VALUES (?, ?, ?)",
    )
    .run(key, enabled, nextRunAt);
}

function createEnv(d1: FakeD1Database) {
  return { DB: d1 as unknown as D1Database } as never;
}

describe("internal scheduled task dispatcher", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    runScheduledTask.mockResolvedValue(undefined);
  });

  it("runs only notification dispatch on a 30-minute tick", async () => {
    const d1 = new FakeD1Database();
    const now = Date.UTC(2026, 7, 31, 10, 30);
    const nowSeconds = now / 1000;
    seed(d1, "notification_tick", nowSeconds - 1);
    seed(d1, "visit_hourly_rollup", nowSeconds + 1);
    seed(d1, "database_maintenance", nowSeconds + 1);

    await dispatchInternalScheduledTasks(createEnv(d1), now, observability());

    expect(runScheduledTask).toHaveBeenCalledTimes(1);
    expect(runScheduledTask.mock.calls[0]?.[1].key).toBe("notification_tick");
    d1.close();
  });

  it("runs hourly and daily tasks when their schedules are due", async () => {
    const d1 = new FakeD1Database();
    const now = Date.UTC(2026, 7, 31, 10, 0);
    const nowSeconds = now / 1000;
    seed(d1, "notification_tick", 0);
    seed(d1, "visit_hourly_rollup", 0);
    seed(d1, "database_maintenance", 0);

    await dispatchInternalScheduledTasks(createEnv(d1), now, observability());

    expect(runScheduledTask.mock.calls.map((call) => call[1].key)).toEqual([
      "notification_tick",
      "visit_hourly_rollup",
      "database_maintenance",
    ]);
    expect(
      d1.db
        .prepare(
          "SELECT task_key, next_run_at AS nextRunAt FROM scheduled_task_schedule_state ORDER BY task_key",
        )
        .all(),
    ).toEqual([
      {
        task_key: "database_maintenance",
        nextRunAt: Date.UTC(2026, 8, 1) / 1000,
      },
      { task_key: "notification_tick", nextRunAt: nowSeconds + 1800 },
      { task_key: "visit_hourly_rollup", nextRunAt: nowSeconds + 3600 },
    ]);
    expect(d1.calls.filter(({ method }) => method === "run")).toHaveLength(6);
    expect(
      d1.calls.filter(({ method }) => method === "all")[0]?.sql,
    ).not.toMatch(/ORDER BY/i);
    d1.close();
  });

  it("allows only one concurrent tick to claim the same task", async () => {
    const d1 = new FakeD1Database();
    const now = Date.UTC(2026, 7, 31, 10, 30);
    seed(d1, "notification_tick", 0);

    await Promise.all([
      dispatchInternalScheduledTasks(createEnv(d1), now, observability()),
      dispatchInternalScheduledTasks(createEnv(d1), now, observability()),
    ]);

    expect(runScheduledTask).toHaveBeenCalledTimes(1);
    const attemptedClaims = d1.calls.filter(
      ({ method, sql }) =>
        method === "run" && sql.includes('SET "claim_token" = ?'),
    );
    expect(attemptedClaims).toHaveLength(2);
    expect(
      d1.calls.filter(
        ({ method, sql }) => method === "run" && sql.includes("UPDATE"),
      ),
    ).toHaveLength(3);
    d1.close();
  });

  it("replaces an expired claim with one conditional update", async () => {
    const d1 = new FakeD1Database();
    const now = Date.UTC(2026, 7, 31, 10, 30);
    const nowSeconds = now / 1000;
    seed(d1, "notification_tick", 0);
    d1.db
      .prepare(
        "UPDATE scheduled_task_schedule_state SET claim_token = ?, claim_expires_at = ? WHERE task_key = ?",
      )
      .run("expired-token", nowSeconds - 1, "notification_tick");
    runScheduledTask.mockImplementationOnce(async () => {
      const row = d1.db
        .prepare(
          "SELECT claim_token, claim_expires_at FROM scheduled_task_schedule_state WHERE task_key = ?",
        )
        .get("notification_tick") as {
        claim_token: string;
        claim_expires_at: number;
      };
      expect(row.claim_token).not.toBe("expired-token");
      expect(row.claim_expires_at).toBe(nowSeconds + 6 * 60 * 60);
    });

    await dispatchInternalScheduledTasks(createEnv(d1), now, observability());

    const claimUpdates = d1.calls.filter(
      ({ method, sql }) =>
        method === "run" &&
        sql.includes("UPDATE") &&
        sql.includes("claim_expires_at") &&
        sql.includes("claim_token"),
    );
    expect(claimUpdates).toHaveLength(2);
    expect(runScheduledTask).toHaveBeenCalledTimes(1);
    d1.close();
  });

  it("fails closed when the atomic claim update errors", async () => {
    const d1 = new FakeD1Database();
    const now = Date.UTC(2026, 7, 31, 10, 30);
    seed(d1, "notification_tick", 0);
    d1.failNextUpdate = true;

    await dispatchInternalScheduledTasks(createEnv(d1), now, observability());

    expect(runScheduledTask).not.toHaveBeenCalled();
    expect(
      d1.calls.filter(
        ({ method, sql }) => method === "run" && sql.includes("UPDATE"),
      ),
    ).toHaveLength(1);
    d1.close();
  });

  it("does not release a claim after ownership changes", async () => {
    const d1 = new FakeD1Database();
    const now = Date.UTC(2026, 7, 31, 10, 30);
    seed(d1, "notification_tick", 0);
    runScheduledTask.mockImplementationOnce(async () => {
      d1.db
        .prepare(
          "UPDATE scheduled_task_schedule_state SET claim_token = ? WHERE task_key = ?",
        )
        .run("replacement-owner", "notification_tick");
    });

    await dispatchInternalScheduledTasks(createEnv(d1), now, observability());

    expect(
      d1.db
        .prepare(
          "SELECT claim_token, last_run_at, next_run_at FROM scheduled_task_schedule_state WHERE task_key = ?",
        )
        .get("notification_tick"),
    ).toEqual({
      claim_token: "replacement-owner",
      last_run_at: null,
      next_run_at: 0,
    });
    d1.close();
  });

  it("does not claim disabled tasks", async () => {
    const d1 = new FakeD1Database();
    const now = Date.UTC(2026, 7, 31, 10, 30);
    seed(d1, "notification_tick", 0, 0);

    await dispatchInternalScheduledTasks(createEnv(d1), now, observability());

    expect(runScheduledTask).not.toHaveBeenCalled();
    expect(d1.calls.filter(({ method }) => method === "run")).toHaveLength(0);
    d1.close();
  });

  it("does not issue a claim update for a task that is not due", async () => {
    const d1 = new FakeD1Database();
    const now = Date.UTC(2026, 7, 31, 10, 30);
    seed(d1, "notification_tick", now / 1000 + 1);

    await dispatchInternalScheduledTasks(createEnv(d1), now, observability());

    expect(runScheduledTask).not.toHaveBeenCalled();
    expect(d1.calls.filter(({ method }) => method === "run")).toHaveLength(0);
    d1.close();
  });
});
