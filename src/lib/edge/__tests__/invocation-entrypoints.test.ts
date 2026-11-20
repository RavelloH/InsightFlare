import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { InvocationMetricsPoint } from "@/lib/edge/analytics-engine/invocation-schema";
import type { Env } from "@/lib/edge/types";
import type { AppEnv } from "@/lib/hono/types";

vi.mock("@tanstack/react-start/server-entry", () => ({
  default: {
    fetch: vi.fn(async () => new Response("page response")),
  },
}));
vi.mock("@/middleware", () => ({
  localeCookie: vi.fn(() => "if_locale=en"),
  resolvePageRequest: vi.fn(async () => ({ response: null, locale: null })),
}));
vi.mock("@/lib/hono/app", async () => {
  const { Hono } = await import("hono");
  const { observabilityMiddleware } =
    await import("@/lib/hono/middleware/observability");
  const app = new Hono<AppEnv>();
  app.use("*", observabilityMiddleware());
  app.all("/api/*", (c) => c.text("api"));
  return {
    default: {
      fetch: vi.fn((request: Request, env: Env, ctx: ExecutionContext) =>
        app.fetch(request, env, ctx),
      ),
    },
  };
});
vi.mock("@/lib/edge/scheduled-tasks/dispatcher", () => ({
  dispatchInternalScheduledTasks: vi.fn(async () => {}),
}));
vi.mock("@/lib/edge/ingest/alarm-sweep", () => ({
  sweepIngestAlarms: vi.fn(async () => {}),
}));

const { default: server } = await import("@/server");
const { default: startHandler } =
  await import("@tanstack/react-start/server-entry");
const { resolvePageRequest } = await import("@/middleware");
const { default: apiApp } = await import("@/lib/hono/app");
const { dispatchInternalScheduledTasks } =
  await import("@/lib/edge/scheduled-tasks/dispatcher");

function setup() {
  const points: InvocationMetricsPoint[] = [];
  const work: Promise<unknown>[] = [];
  const env = {
    DB: {} as D1Database,
    INGEST_DO: {} as DurableObjectNamespace,
    MAIN_SECRET: "test-secret",
    INVOCATION_METRICS: {
      writeDataPoint: vi.fn((point: InvocationMetricsPoint) =>
        points.push(point),
      ),
    },
  } as Env;
  const ctx = {
    waitUntil: (promise: Promise<unknown>) => {
      work.push(promise);
    },
    passThroughOnException: () => {},
  } as ExecutionContext;
  const finish = async () => {
    while (work.length) await Promise.all(work.splice(0));
  };
  return { points, env, ctx, work, finish };
}

describe("actual Worker top-level invocation entrypoints", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => vi.restoreAllMocks());

  it("records one page invocation; an internal Hono dispatch never adds a point", async () => {
    const f = setup();
    vi.mocked(resolvePageRequest).mockImplementationOnce(
      async (_request, _env, internalApi) => {
        const internalResponse = await internalApi(
          new Request("https://app.test/api/internal"),
        );
        expect(internalResponse.status).toBe(200);
        return { response: null, locale: null, pathname: "/en/app" };
      },
    );
    const response = await server.fetch(
      new Request("https://app.test/en/app?private=secret"),
      f.env,
      f.ctx,
    );
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("page response");
    await f.finish();
    expect(f.points).toHaveLength(1);
    expect(f.points[0].indexes).toEqual(["page.other:ok"]);
    expect(f.points[0].blobs[2]).toBe("page");
    expect(JSON.stringify(f.points)).not.toContain("private=secret");
    expect(vi.mocked(apiApp.fetch)).toHaveBeenCalledOnce();
    const forwarded = vi.mocked(apiApp.fetch).mock.calls[0][0] as Request;
    // The internal origin is proven by Request identity, never by a header.
    expect(
      forwarded.headers.get("x-insightflare-internal-page-request"),
    ).toBeNull();
    expect(vi.mocked(startHandler.fetch)).toHaveBeenCalledOnce();
  });

  it("records an actual external /api request despite forged internal headers", async () => {
    const f = setup();
    for (const headerValue of ["1", "true"]) {
      const response = await server.fetch(
        new Request("https://app.test/api/internal?token=CANARY_private", {
          headers: { "x-insightflare-internal-page-request": headerValue },
        }),
        f.env,
        f.ctx,
      );
      expect(response.status).toBe(200);
      expect(await response.text()).toBe("api");
      await f.finish();
      expect(f.points).toHaveLength(headerValue === "1" ? 1 : 2);
      expect(f.points.at(-1)?.indexes).toEqual(["api:/api/*:ok"]);
    }
    expect(vi.mocked(apiApp.fetch)).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(f.points)).not.toContain("CANARY_private");
  });

  it("uses a distinct trusted Server Function route key", async () => {
    const f = setup();
    const response = await server.fetch(
      new Request("https://app.test/_serverFn/sensitive-function", {
        method: "POST",
      }),
      f.env,
      f.ctx,
    );
    expect(response.status).toBe(200);
    await f.finish();
    expect(f.points).toHaveLength(1);
    expect(f.points[0].indexes).toEqual(["server_function.handler:ok"]);
    expect(f.points[0].blobs[4]).toBe("POST");
    expect(JSON.stringify(f.points)).not.toContain("sensitive-function");
  });

  it("records scheduled invocation once with and without a task dispatch", async () => {
    const disabled = setup();
    disabled.env.DISABLE_CRON_TASKS = "1";
    await server.scheduled(
      { scheduledTime: 123 } as ScheduledController,
      disabled.env,
      disabled.ctx,
    );
    await disabled.finish();
    expect(disabled.points).toHaveLength(1);
    expect(disabled.points[0].indexes).toEqual(["scheduled.tasks:ok"]);
    expect(dispatchInternalScheduledTasks).not.toHaveBeenCalled();

    const enabled = setup();
    await server.scheduled(
      { scheduledTime: 124 } as ScheduledController,
      enabled.env,
      enabled.ctx,
    );
    await enabled.finish();
    expect(enabled.points).toHaveLength(1);
    expect(enabled.points[0].indexes).toEqual(["scheduled.tasks:ok"]);
    expect(dispatchInternalScheduledTasks).toHaveBeenCalledOnce();
  });

  it("preserves scheduled retry rejection when its AE writer fails", async () => {
    const f = setup();
    const failure = new Error("scheduler retry original");
    vi.mocked(dispatchInternalScheduledTasks).mockRejectedValueOnce(failure);
    vi.mocked(f.env.INVOCATION_METRICS!.writeDataPoint).mockImplementation(
      () => {
        throw new Error("AE writer offline");
      },
    );
    await server.scheduled(
      { scheduledTime: 125 } as ScheduledController,
      f.env,
      f.ctx,
    );
    const results = await Promise.allSettled(f.work);
    expect(results[0]).toMatchObject({ status: "rejected", reason: failure });
    expect(f.points).toHaveLength(0);
    expect(f.env.INVOCATION_METRICS!.writeDataPoint).toHaveBeenCalledOnce();
  });
});
