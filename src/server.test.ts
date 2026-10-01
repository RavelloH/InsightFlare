import { beforeEach, describe, expect, it, vi } from "vitest";

import type { Env } from "@/lib/edge/types";

const mocks = vi.hoisted(() => {
  const logger = {
    error: vi.fn(),
    emit: vi.fn(),
    emitWhenComplete: vi.fn(),
    info: vi.fn(),
    measure: vi.fn(),
    setRequest: vi.fn(),
  };
  return {
    createInvocationLogger: vi.fn(() => logger),
    dispatchInternalScheduledTasks: vi.fn(),
    handlerFetch: vi.fn(),
    initializeE2eClock: vi.fn(),
    instrumentEnv: vi.fn((env: unknown) => env),
    logger,
    resolvePageRequest: vi.fn(),
    runWithInvocationLogger: vi.fn(),
    shouldUseHono: vi.fn(() => false),
    sweepIngestAlarms: vi.fn(),
  };
});

vi.mock("@tanstack/react-start/server-entry", () => ({
  default: { fetch: mocks.handlerFetch },
}));
vi.mock("@/lib/edge/ingest/alarm-sweep", () => ({
  sweepIngestAlarms: mocks.sweepIngestAlarms,
}));
vi.mock("@/lib/edge/observability/bindings", () => ({
  instrumentEnv: mocks.instrumentEnv,
}));
vi.mock("@/lib/edge/observability/logger", () => ({
  createInvocationLogger: mocks.createInvocationLogger,
  errorLogData: () => ({}),
  runWithInvocationLogger: mocks.runWithInvocationLogger,
}));
vi.mock("@/lib/edge/runtime/e2e-clock", () => ({
  initializeE2eClock: mocks.initializeE2eClock,
}));
vi.mock("@/lib/edge/scheduled-tasks/dispatcher", () => ({
  dispatchInternalScheduledTasks: mocks.dispatchInternalScheduledTasks,
}));
vi.mock("@/lib/hono/app", () => ({ default: { fetch: vi.fn() } }));
vi.mock("@/lib/hono/path-match", () => ({
  shouldUseHono: mocks.shouldUseHono,
}));
vi.mock("@/middleware", () => ({
  localeCookie: vi.fn(() => "locale=en"),
  resolvePageRequest: mocks.resolvePageRequest,
}));

import server from "./server";

describe("Worker server observability completion", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.logger.emitWhenComplete.mockResolvedValue({});
    mocks.logger.measure.mockImplementation(
      async (_operation: string, action: () => unknown) => action(),
    );
    mocks.runWithInvocationLogger.mockImplementation(
      async (_logger: unknown, action: () => unknown) => action(),
    );
    mocks.resolvePageRequest.mockResolvedValue({
      response: new Response("page", { status: 202 }),
      locale: null,
    });
    mocks.handlerFetch.mockResolvedValue(new Response("server function"));
    mocks.dispatchInternalScheduledTasks.mockResolvedValue(undefined);
    mocks.sweepIngestAlarms.mockResolvedValue(undefined);
  });

  it("registers page log completion without delaying the response", async () => {
    mocks.logger.emitWhenComplete.mockRejectedValueOnce(
      new Error("log sink failed"),
    );
    const executionCtx = { waitUntil: vi.fn() } as unknown as ExecutionContext;
    const env = { DEMO_MODE: "1" } as Env;

    const response = await server.fetch(
      new Request("https://example.test/dashboard"),
      env,
      executionCtx,
    );

    expect(response.status).toBe(202);
    expect(mocks.logger.emit).not.toHaveBeenCalled();
    expect(mocks.logger.emitWhenComplete).toHaveBeenCalledOnce();
    expect(executionCtx.waitUntil).toHaveBeenCalledOnce();
    const completion = vi.mocked(executionCtx.waitUntil).mock.calls[0]![0];
    await expect(completion).resolves.toBeUndefined();
  });

  it("waits for skipped scheduled-task logs and contains sink errors", async () => {
    let finishEmission!: () => void;
    const emission = new Promise<void>((resolve) => {
      finishEmission = resolve;
    });
    mocks.logger.emitWhenComplete.mockReturnValueOnce(emission);
    const executionCtx = { waitUntil: vi.fn() } as unknown as ExecutionContext;
    const env = { DISABLE_CRON_TASKS: "1" } as Env;
    let completed = false;

    const scheduled = server.scheduled(
      {} as ScheduledController,
      env,
      executionCtx,
    );
    void scheduled.then(() => {
      completed = true;
    });
    await vi.waitFor(() =>
      expect(mocks.logger.emitWhenComplete).toHaveBeenCalledOnce(),
    );
    await Promise.resolve();
    expect(completed).toBe(false);

    finishEmission();
    await expect(scheduled).resolves.toBeUndefined();
    expect(completed).toBe(true);
    expect(executionCtx.waitUntil).not.toHaveBeenCalled();
  });

  it("preserves scheduled task failures if log completion also fails", async () => {
    const taskError = new Error("scheduled task failed");
    mocks.dispatchInternalScheduledTasks.mockRejectedValueOnce(taskError);
    mocks.logger.emitWhenComplete.mockRejectedValueOnce(
      new Error("log sink failed"),
    );
    const executionCtx = { waitUntil: vi.fn() } as unknown as ExecutionContext;

    await server.scheduled({} as ScheduledController, {} as Env, executionCtx);

    expect(executionCtx.waitUntil).toHaveBeenCalledOnce();
    const completion = vi.mocked(executionCtx.waitUntil).mock.calls[0]![0];
    await expect(completion).rejects.toBe(taskError);
  });
});
