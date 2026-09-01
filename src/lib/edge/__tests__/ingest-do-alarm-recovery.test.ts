import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { IngestDurableObject } from "@/lib/edge/ingest-do";
import type { Env } from "@/lib/edge/types";

const NOW = Date.UTC(2026, 4, 25, 12, 0, 0);
const RETRY_DELAY_MS = 60 * 1000;

type SqlRow = Record<string, unknown>;

interface TestAlarmContext {
  object: IngestDurableObject;
  state: DurableObjectState;
  getAlarmAt: () => number | null;
}

function createTestDo(options: {
  alarmAt: number | null;
  setAlarm?: (scheduledAt: number) => Promise<void>;
}): TestAlarmContext {
  let alarmAt = options.alarmAt;
  const storage = {
    sql: {
      exec: vi.fn((query: string) => ({
        toArray: () => {
          if (query.includes("FROM buffered_visits")) {
            return [
              {
                nextDueAt: NOW - 1,
                flushDueAt: NOW - 1,
                dirty: 1,
                status: "complete",
                lastActivityAt: NOW - 1,
                hiddenAt: null,
                visitId: "visit-1",
              } satisfies SqlRow,
            ];
          }
          return [];
        },
      })),
    },
    getAlarm: vi.fn(async () => alarmAt),
    setAlarm: vi.fn(async (scheduledAt: number) => {
      if (options.setAlarm) {
        return options.setAlarm(scheduledAt);
      }
      alarmAt = scheduledAt;
    }),
    deleteAlarm: vi.fn(async () => {
      alarmAt = null;
    }),
  };
  const state = {
    storage,
    blockConcurrencyWhile: vi.fn((callback: () => void | Promise<void>) =>
      Promise.resolve(callback()),
    ),
  } as unknown as DurableObjectState;
  const env = {
    DB: {} as D1Database,
    INGEST_DO: {} as DurableObjectNamespace,
    DAILY_SALT_SECRET: "test-secret-with-enough-entropy",
  } as Env;

  return {
    object: new IngestDurableObject(state, env),
    state,
    getAlarmAt: () => alarmAt,
  };
}

function rejectMaintenance(object: IngestDurableObject, error: Error): void {
  vi.spyOn(
    object as unknown as { runMaintenance: () => Promise<void> },
    "runMaintenance",
  ).mockRejectedValue(error);
}

beforeEach(() => {
  vi.useFakeTimers({ now: NOW });
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("IngestDurableObject alarm recovery", () => {
  it("schedules a bounded retry and rethrows the maintenance error", async () => {
    const maintenanceError = new Error("maintenance unavailable");
    const ctx = createTestDo({ alarmAt: null });
    rejectMaintenance(ctx.object, maintenanceError);

    await expect(ctx.object.alarm()).rejects.toBe(maintenanceError);

    expect(ctx.state.storage.setAlarm).toHaveBeenCalledWith(
      NOW + RETRY_DELAY_MS,
    );
    expect(ctx.getAlarmAt()).toBe(NOW + RETRY_DELAY_MS);
  });

  it("moves an already-consumed alarm to the retry time after failure", async () => {
    const maintenanceError = new Error("maintenance unavailable");
    const ctx = createTestDo({ alarmAt: NOW });
    rejectMaintenance(ctx.object, maintenanceError);

    await expect(
      ctx.object.alarm({ isRetry: true, retryCount: 1 }),
    ).rejects.toBe(maintenanceError);

    expect(ctx.state.storage.setAlarm).toHaveBeenCalledWith(
      NOW + RETRY_DELAY_MS,
    );
    expect(ctx.getAlarmAt()).toBe(NOW + RETRY_DELAY_MS);
  });

  it("does not replace the maintenance error when retry scheduling fails", async () => {
    const maintenanceError = new Error("maintenance unavailable");
    const scheduleError = new Error("alarm storage unavailable");
    const ctx = createTestDo({
      alarmAt: null,
      setAlarm: async () => {
        throw scheduleError;
      },
    });
    rejectMaintenance(ctx.object, maintenanceError);

    await expect(ctx.object.alarm()).rejects.toBe(maintenanceError);
    expect(ctx.state.storage.setAlarm).toHaveBeenCalledWith(
      NOW + RETRY_DELAY_MS,
    );
  });

  it("repairs a stranded overdue alarm during internal reconciliation", async () => {
    const ctx = createTestDo({ alarmAt: NOW - RETRY_DELAY_MS - 1 });

    const response = await ctx.object.fetch(
      new Request("https://ingest.internal/reconcile", { method: "POST" }),
    );

    expect(response.status).toBe(200);
    expect(ctx.state.storage.setAlarm).toHaveBeenCalledWith(NOW);
    expect(ctx.getAlarmAt()).toBe(NOW);

    // The grace period prevents subsequent requests from repeatedly writing
    // the same recovery Alarm before the platform dispatches it.
    await ctx.object.fetch(
      new Request("https://ingest.internal/reconcile", { method: "POST" }),
    );
    expect(ctx.state.storage.setAlarm).toHaveBeenCalledTimes(1);
  });
});
