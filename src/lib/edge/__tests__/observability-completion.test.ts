import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  createInvocationLogger,
  currentD1Operation,
  currentInvocationLogger,
  runWithD1Operation,
  runWithInvocationLogger,
} from "@/lib/edge/observability/logger";

describe("invocation completion consumers", () => {
  beforeEach(() => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });
  afterEach(() => vi.restoreAllMocks());

  it("notifies once, isolates sync and async failures and clears logging context", async () => {
    const waiting: Promise<unknown>[] = [];
    const waitUntil = vi.fn((work: Promise<unknown>) => waiting.push(work));
    const logger = createInvocationLogger({
      source: "worker",
      trigger: "request",
      waitUntil,
    });
    const success = vi.fn();
    logger.onComplete(() => {
      throw new Error("listener A failed");
    });
    logger.onComplete(async (snapshot) => {
      expect(currentInvocationLogger()).toBeUndefined();
      expect(currentD1Operation()).toBeUndefined();
      expect(Object.isFrozen(snapshot)).toBe(true);
      success(snapshot);
    });
    logger.onComplete(async () => {
      throw new Error("listener C failed");
    });
    await runWithInvocationLogger(logger, () =>
      runWithD1Operation("private.query", async () => {
        logger.setRequest({
          route: "/api/v1/events/secret",
          method: "POST",
          status: 202,
          outcome: "ok",
        });
        const first = logger.emit();
        const second = await logger.emitWhenComplete();
        expect(second).toBe(first);
      }),
    );
    await Promise.all(waiting);
    expect(success).toHaveBeenCalledOnce();
    expect(success.mock.calls[0]?.[0]).toMatchObject({
      routeGroup: "api",
      status: 202,
    });
    expect(waitUntil).toHaveBeenCalledOnce();
    expect(console.log).toHaveBeenCalledOnce();
    expect(console.error).not.toHaveBeenCalled();
  });

  it("never recurses into the original logger and cannot change the emitted record", async () => {
    const waiting: Promise<unknown>[] = [];
    const logger = createInvocationLogger({
      source: "do",
      trigger: "alarm",
      waitUntil: (work) => {
        waiting.push(work);
      },
    });
    logger.info("do.alarm.started");
    logger.onComplete(() => {
      logger.error("should.not.be.logged");
      logger.increment("d1Statements");
      logger.setPerformance({ cache: "HIT" });
      logger.startSpan("d1.all").end();
      logger.recordD1Operation("test", {
        durationMs: 5,
        rowsRead: 200,
        rowsReadAvailable: true,
      });
      logger.recordDoSqlOperation({ rowsRead: 123 });
      logger.track(Promise.resolve());
      logger.onComplete(() => {
        throw new Error("late subscription");
      });
    });
    const record = logger.emit();
    await Promise.all(waiting);
    expect(record.logs).toEqual([
      {
        timeMs: expect.any(Number),
        level: "info",
        message: "do.alarm.started",
      },
    ]);
    expect(record.performance.d1Statements).toBeUndefined();
    expect(logger.snapshot().sql.statements).toBe(0);
    expect(console.log).toHaveBeenCalledOnce();
  });

  it("does not block response on async consumer work or a broken waitUntil", async () => {
    let finish!: () => void;
    const work = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const observed = vi.fn();
    const logger = createInvocationLogger({
      source: "worker",
      trigger: "request",
      waitUntil: () => {
        throw new Error("worker closing");
      },
    });
    logger.onComplete(async () => {
      await work;
      observed();
    });
    const record = logger.emit();
    expect(record.source).toBe("worker");
    expect(observed).not.toHaveBeenCalled();
    finish();
    await work;
    await vi.waitFor(() => expect(observed).toHaveBeenCalledOnce());
  });

  it("waits for tracked business tasks but not listener work and emits once under race", async () => {
    let finish!: () => void;
    const background = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const tasks: Promise<unknown>[] = [];
    const logger = createInvocationLogger({
      source: "worker",
      trigger: "scheduled",
      waitUntil: (work) => {
        tasks.push(work);
      },
    });
    const seen = vi.fn();
    logger.onComplete(seen);
    logger.track(background);
    const pendingA = logger.emitWhenComplete();
    const pendingB = logger.emitWhenComplete();
    expect(console.log).not.toHaveBeenCalled();
    finish();
    const [a, b] = await Promise.all([pendingA, pendingB]);
    await Promise.all(tasks);
    expect(a).toBe(b);
    expect(seen).toHaveBeenCalledOnce();
    expect(seen.mock.calls[0]?.[0]).toMatchObject({
      trigger: "scheduled",
      routeGroup: "scheduled",
    });
    expect(console.log).toHaveBeenCalledOnce();
  });

  it("preserves a rejected DO alarm while its consumer also rejects", async () => {
    const waiting: Promise<unknown>[] = [];
    const logger = createInvocationLogger({
      source: "do",
      trigger: "alarm",
      waitUntil: (work) => {
        waiting.push(work);
      },
    });
    logger.onComplete(async () => {
      throw new Error("diagnostics failure");
    });
    const original = new Error("maintenance failed");
    async function alarm(): Promise<void> {
      try {
        throw original;
      } catch (error) {
        logger.error("do.alarm.failed");
        throw error;
      } finally {
        logger.emit();
      }
    }
    await expect(alarm()).rejects.toBe(original);
    await Promise.all(waiting);
    expect(console.error).toHaveBeenCalledOnce();
  });
});
