import { DatabaseSync } from "node:sqlite";

import { beforeEach, describe, expect, it, vi } from "vitest";

const runScheduledTask = vi.hoisted(() => vi.fn());
const runHourlyAggregation = vi.hoisted(() => vi.fn());
const runNotificationTick = vi.hoisted(() => vi.fn());
const runDatabaseMaintenance = vi.hoisted(() => vi.fn());

vi.mock("@/lib/edge/scheduled-task-runner", () => ({
  STALE_RUNNING_MS: 6 * 60 * 60 * 1000,
  runScheduledTask,
}));
vi.mock("@/lib/edge/hourly-rollup", () => ({ runHourlyAggregation }));
vi.mock("@/lib/notifications/notification-task", () => ({
  runNotificationTick,
}));
vi.mock("@/lib/edge/database-maintenance", () => ({
  runDatabaseMaintenance,
}));

const { dispatchInternalScheduledTasks } =
  await import("@/lib/edge/scheduled-task-dispatcher");

class FakeD1Database {
  readonly db = new DatabaseSync(":memory:");

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
        all: async <T>() => ({
          results: database
            .prepare(sql)
            .all(...bindings)
            .map((row) => ({ ...row }) as T),
        }),
        run: async () => ({
          meta: {
            changes: Number(database.prepare(sql).run(...bindings).changes),
          },
        }),
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
    d1.close();
  });

  it("does not claim disabled tasks", async () => {
    const d1 = new FakeD1Database();
    const now = Date.UTC(2026, 7, 31, 10, 30);
    seed(d1, "notification_tick", 0, 0);

    await dispatchInternalScheduledTasks(createEnv(d1), now, observability());

    expect(runScheduledTask).not.toHaveBeenCalled();
    d1.close();
  });
});
