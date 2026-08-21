import { describe, expect, it, vi } from "vitest";

import { executeBoundedBatch } from "@/lib/api-v1/batch-scheduler";

describe("executeBoundedBatch", () => {
  it("preserves item order while bounding concurrent execution", async () => {
    let active = 0;
    let highWater = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const result = executeBoundedBatch(
      ["a", "b", "c"].map((id) => ({
        id,
        weight: 1,
        run: async () => {
          active += 1;
          highWater = Math.max(highWater, active);
          await gate;
          active -= 1;
          return id;
        },
      })),
      { maxConcurrency: 2, maxWeight: 3 },
    );
    await Promise.resolve();
    expect(highWater).toBe(2);
    release();
    await expect(result).resolves.toEqual([
      { id: "a", ok: true, value: "a" },
      { id: "b", ok: true, value: "b" },
      { id: "c", ok: true, value: "c" },
    ]);
  });

  it("enforces weighted budgets and retains partial failures", async () => {
    const run = vi.fn().mockResolvedValue("ok");
    await expect(
      executeBoundedBatch(
        [
          { id: "one", weight: 2, run },
          { id: "two", weight: 2, run },
          {
            id: "bad",
            weight: 1,
            run: async () => {
              throw new Error("fail");
            },
          },
        ],
        { maxConcurrency: 1, maxWeight: 3 },
      ),
    ).resolves.toEqual([
      { id: "one", ok: true, value: "ok" },
      { id: "two", ok: false, error: "budget_exceeded" },
      { id: "bad", ok: false, error: "internal_error" },
    ]);
    expect(run).toHaveBeenCalledOnce();
  });

  it("does not start work after deadline or abort", async () => {
    const run = vi.fn();
    await expect(
      executeBoundedBatch([{ id: "one", weight: 1, run }], {
        maxConcurrency: 1,
        maxWeight: 1,
        deadlineMs: 10,
        now: () => 10,
      }),
    ).resolves.toEqual([{ id: "one", ok: false, error: "deadline_exceeded" }]);
    expect(run).not.toHaveBeenCalled();
  });

  it("marks queued work cancelled when the caller aborts", async () => {
    const controller = new AbortController();
    const run = vi.fn(async (signal: AbortSignal) => {
      controller.abort();
      signal.throwIfAborted();
      return "never";
    });
    await expect(
      executeBoundedBatch(
        [
          { id: "first", weight: 1, run },
          { id: "second", weight: 1, run },
        ],
        { maxConcurrency: 1, maxWeight: 2, signal: controller.signal },
      ),
    ).resolves.toEqual([
      { id: "first", ok: false, error: "request_cancelled" },
      { id: "second", ok: false, error: "request_cancelled" },
    ]);
  });

  it("aborts an in-flight worker when the deadline timer fires", async () => {
    vi.useFakeTimers();
    try {
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const result = executeBoundedBatch(
        [
          {
            id: "slow",
            weight: 1,
            run: async () => {
              await gate;
              return "done";
            },
          },
        ],
        { maxConcurrency: 1, maxWeight: 1, deadlineMs: 10 },
      );
      await Promise.resolve();
      vi.advanceTimersByTime(10);
      release();
      await expect(result).resolves.toEqual([
        { id: "slow", ok: false, error: "deadline_exceeded" },
      ]);
    } finally {
      vi.useRealTimers();
    }
  });
});
