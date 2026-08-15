import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  createInvocationLogger,
  MAX_INVOCATION_LOG_EVENTS,
} from "@/lib/edge/observability-logger";

describe("edge observability logger", () => {
  beforeEach(() => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("builds a request record with relative events and aggregate counters", () => {
    let now = 100;
    const logger = createInvocationLogger({
      source: "worker",
      trigger: "request",
      traceId: "trace-1",
      startedAt: "2026-08-15T12:00:00.000Z",
      now: () => now,
    });

    logger.info("request.started");
    now = 112.4;
    logger.setPerformance({
      cache: "MISS",
      dataSource: "raw",
      d1RowsReadAvailable: true,
    });
    logger.increment("d1Statements");
    logger.increment("d1RowsRead", 12.9);
    logger.warn("query.completed");
    logger.setRequest({
      route: "private.visitors.list",
      method: "GET",
      status: 200,
      outcome: "ok",
    });
    now = 125.6;

    expect(logger.build()).toEqual({
      v: 1,
      source: "worker",
      trigger: "request",
      traceId: "trace-1",
      startedAt: "2026-08-15T12:00:00.000Z",
      request: {
        route: "private.visitors.list",
        method: "GET",
        status: 200,
        outcome: "ok",
      },
      performance: {
        durationMs: 26,
        cache: "MISS",
        dataSource: "raw",
        d1RowsReadAvailable: true,
        d1Statements: 1,
        d1RowsRead: 12,
      },
      logs: [
        { timeMs: 0, level: "info", message: "request.started" },
        { timeMs: 12, level: "warn", message: "query.completed" },
      ],
    });
  });

  it("emits a structured record once at the most severe invocation level", () => {
    let now = 0;
    const logger = createInvocationLogger({
      source: "do",
      trigger: "alarm",
      now: () => now,
    });
    logger.error("flush.failed");
    logger.setPerformance({ failedStatements: 1 });
    now = 42;

    const first = logger.emit();
    now = 84;
    const second = logger.emit();

    expect(second).toBe(first);
    expect(console.error).toHaveBeenCalledOnce();
    expect(console.error).toHaveBeenCalledWith({
      v: 1,
      source: "do",
      trigger: "alarm",
      startedAt: expect.any(String),
      performance: { durationMs: 42, failedStatements: 1 },
      logs: [{ timeMs: 0, level: "error", message: "flush.failed" }],
    });
    expect(console.log).not.toHaveBeenCalled();
    expect(console.warn).not.toHaveBeenCalled();
  });

  it("uses warning output for client failures and normal output otherwise", () => {
    const clientFailure = createInvocationLogger({
      source: "worker",
      trigger: "request",
      now: () => 0,
    });
    clientFailure.setRequest({
      route: "api.public.share",
      method: "GET",
      status: 404,
      outcome: "error",
    });
    clientFailure.emit();

    const success = createInvocationLogger({
      source: "worker",
      trigger: "request",
      now: () => 0,
    });
    success.setRequest({
      route: "healthz",
      method: "GET",
      status: 200,
      outcome: "ok",
    });
    success.emit();

    expect(console.warn).toHaveBeenCalledOnce();
    expect(console.log).toHaveBeenCalledOnce();
    expect(console.error).not.toHaveBeenCalled();
  });

  it("bounds events and ignores invalid counter increments", () => {
    let now = 10;
    const logger = createInvocationLogger({
      source: "do",
      trigger: "alarm",
      maxEvents: 1,
      now: () => now,
    });
    logger.info("flush.started");
    now = 20;
    logger.info("flush.completed");
    logger.increment("d1RowsWritten", -1);
    logger.increment("d1RowsWritten", Number.NaN);
    logger.increment("d1RowsWritten", 3.9);

    expect(logger.build()).toMatchObject({
      performance: { durationMs: 10, d1RowsWritten: 3 },
      logs: [{ timeMs: 0, level: "info", message: "flush.started" }],
      logsTruncated: true,
    });
  });

  it("normalizes invalid limits and non-finite elapsed time", () => {
    const logger = createInvocationLogger({
      source: "worker",
      trigger: "request",
      maxEvents: 0,
      now: () => Number.NaN,
    });
    for (let index = 0; index < MAX_INVOCATION_LOG_EVENTS + 1; index += 1) {
      logger.info(`event.${index}`);
    }

    expect(logger.build()).toMatchObject({
      performance: { durationMs: 0 },
      logs: expect.arrayContaining([
        { timeMs: 0, level: "info", message: "event.0" },
      ]),
      logsTruncated: true,
    });
  });
});
