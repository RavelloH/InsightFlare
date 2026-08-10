import { beforeEach, describe, expect, it, vi } from "vitest";

import { e2eRoutes } from "@/lib/hono/routes/e2e";

const { runHourlyAggregation, runNotificationTick, runScheduledTask } =
  vi.hoisted(() => ({
    runHourlyAggregation: vi.fn().mockResolvedValue({ status: "success" }),
    runNotificationTick: vi.fn().mockResolvedValue({ status: "success" }),
    runScheduledTask: vi.fn().mockResolvedValue(undefined),
  }));

vi.mock("@/lib/edge/hourly-rollup", () => ({ runHourlyAggregation }));
vi.mock("@/lib/edge/scheduled-task-runner", () => ({ runScheduledTask }));
vi.mock("@/lib/notifications/notification-task", () => ({
  runNotificationTick,
}));

function request(path: string, init?: RequestInit) {
  return new Request(`https://app.test/${path}`, init);
}

function controlRequest(path: string, init?: RequestInit) {
  const headers = new Headers(init?.headers);
  headers.set("x-insightflare-e2e-token", "control-token");
  return request(path, { ...init, headers });
}

function createEnv(input?: { exists?: boolean; response?: Response }) {
  const response = input?.response ?? Response.json({ ok: true, visits: {} });
  const statement = {
    bind: vi.fn().mockReturnThis(),
    first: vi
      .fn()
      .mockResolvedValue(input?.exists === false ? null : { id: "site-1" }),
  };
  const stub = { fetch: vi.fn().mockResolvedValue(response) };
  return {
    DB: { prepare: vi.fn().mockReturnValue(statement) },
    INGEST_DO: {
      get: vi.fn().mockReturnValue(stub),
      idFromName: vi.fn(() => "do-id"),
    },
    INSIGHTFLARE_E2E: "1",
    INSIGHTFLARE_E2E_CONTROL_TOKEN: "control-token",
    statement,
    stub,
  };
}

describe("E2E control routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("hides every route outside E2E mode or with an invalid token", async () => {
    const env = createEnv();
    const production = await e2eRoutes.fetch(controlRequest("clock"), {
      ...env,
      INSIGHTFLARE_E2E: "",
    } as never);
    const invalid = await e2eRoutes.fetch(request("clock"), env as never);
    expect(production.status).toBe(404);
    expect(invalid.status).toBe(404);
  });

  it("sets and advances the E2E clock while rejecting invalid input", async () => {
    const env = createEnv();
    const invalid = await e2eRoutes.fetch(
      controlRequest("clock/set", { method: "POST", body: "{}" }),
      env as never,
    );
    const set = await e2eRoutes.fetch(
      controlRequest("clock/set", {
        body: JSON.stringify({ nowMs: 1_000 }),
        headers: { "content-type": "application/json" },
        method: "POST",
      }),
      env as never,
    );
    const advance = await e2eRoutes.fetch(
      controlRequest("clock/advance", {
        body: JSON.stringify({ deltaMs: 250 }),
        headers: { "content-type": "application/json" },
        method: "POST",
      }),
      env as never,
    );
    const invalidAdvance = await e2eRoutes.fetch(
      controlRequest("clock/advance", {
        body: JSON.stringify({ deltaMs: -1 }),
        headers: { "content-type": "application/json" },
        method: "POST",
      }),
      env as never,
    );
    expect(invalid.status).toBe(400);
    expect(invalidAdvance.status).toBe(400);
    expect(await set.json()).toMatchObject({ data: { nowMs: 1_000 } });
    expect(await advance.json()).toMatchObject({ data: { nowMs: 1_250 } });
  });

  it("runs an explicit scheduled task and exposes guarded ingest operations", async () => {
    const env = createEnv();
    const invalidScheduled = await e2eRoutes.fetch(
      controlRequest("scheduled/run", { method: "POST", body: "{}" }),
      env as never,
    );
    const scheduled = await e2eRoutes.fetch(
      controlRequest("scheduled/run", {
        body: JSON.stringify({ key: "notification_tick" }),
        headers: { "content-type": "application/json" },
        method: "POST",
      }),
      env as never,
    );
    const invalidFlush = await e2eRoutes.fetch(
      controlRequest("ingest/flush", { method: "POST", body: "{}" }),
      createEnv({ exists: false }) as never,
    );
    const flushed = await e2eRoutes.fetch(
      controlRequest("ingest/flush", {
        body: JSON.stringify({ siteId: "site-1" }),
        headers: { "content-type": "application/json" },
        method: "POST",
      }),
      env as never,
    );
    const status = await e2eRoutes.fetch(
      controlRequest("ingest/status?siteId=site-1"),
      env as never,
    );
    const flushFailed = await e2eRoutes.fetch(
      controlRequest("ingest/flush", {
        body: JSON.stringify({ siteId: "site-1" }),
        headers: { "content-type": "application/json" },
        method: "POST",
      }),
      createEnv({ response: new Response("failed", { status: 500 }) }) as never,
    );
    const statusMissing = await e2eRoutes.fetch(
      controlRequest("ingest/status"),
      createEnv({ exists: false }) as never,
    );
    const statusFailed = await e2eRoutes.fetch(
      controlRequest("ingest/status?siteId=site-1"),
      createEnv({ response: new Response("failed", { status: 500 }) }) as never,
    );
    expect(invalidScheduled.status).toBe(400);
    expect(scheduled.status).toBe(200);
    expect(await scheduled.json()).toMatchObject({
      data: { key: "notification_tick" },
    });
    expect(runScheduledTask).toHaveBeenCalledTimes(1);
    expect(invalidFlush.status).toBe(400);
    expect(flushed.status).toBe(200);
    expect(status.status).toBe(200);
    expect(flushFailed.status).toBe(502);
    expect(statusMissing.status).toBe(400);
    expect(statusFailed.status).toBe(502);
    expect(env.stub.fetch).toHaveBeenCalledWith(
      "https://ingest.internal/diagnostic",
    );
  });
});
