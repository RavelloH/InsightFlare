import { describe, expect, it, vi } from "vitest";

import {
  getInvocationLogger,
  instrumentEnv,
} from "@/lib/edge/observability/bindings";
import {
  createInvocationLogger,
  runWithInvocationLogger,
} from "@/lib/edge/observability/logger";
import { resolveEdgeRuntime } from "@/lib/edge/runtime";
import type { Env } from "@/lib/edge/types";

describe("edge runtime resolver", () => {
  it("returns explicit bindings, execution context, URL, and cf metadata", async () => {
    const env = { DB: {} } as never;
    const ctx = { waitUntil: vi.fn() } as unknown as ExecutionContext;
    const cf = { country: "US", isEUCountry: false };
    const request = new Request("https://edge.test/api/private?siteId=site-1", {
      method: "POST",
      headers: { "x-test": "yes" },
      body: "payload",
    });

    const runtime = await resolveEdgeRuntime(request, { env, ctx, cf });

    expect(runtime.env).toBe(env);
    expect(runtime.ctx).toBe(ctx);
    expect(runtime.url.searchParams.get("siteId")).toBe("site-1");
    expect(runtime.request).not.toBe(request);
    expect(runtime.request.headers.get("x-test")).toBe("yes");
    expect((runtime.request as Request & { cf?: unknown }).cf).toBe(cf);
  });

  it("reuses active SSR instrumentation without wrapping the same bindings twice", async () => {
    const statement = {
      bind: vi.fn(),
      all: vi.fn(async () => ({
        results: [],
        success: true,
        meta: { rows_read: 7, rows_written: 0 },
      })),
    };
    const env = {
      DB: { prepare: vi.fn(() => statement) },
    } as unknown as Env;
    const logger = createInvocationLogger({
      source: "worker",
      trigger: "request",
    });
    await runWithInvocationLogger(logger, async () => {
      const runtime = await resolveEdgeRuntime(
        new Request("https://edge.test/"),
        { env },
      );
      expect(getInvocationLogger(runtime.env)).toBe(logger);
      await runtime.env.DB.prepare("SELECT 1").all();
      const existing = instrumentEnv(env, logger);
      const second = await resolveEdgeRuntime(
        new Request("https://edge.test/"),
        { env: existing },
      );
      expect(second.env).toBe(existing);
      await second.env.DB.prepare("SELECT 1").all();
    });
    const snapshot = logger.build();
    expect(snapshot.performance.operations?.["d1.all"]?.count).toBe(2);
    expect(snapshot.performance.d1RowsRead).toBe(14);
    expect(env.DB.prepare).toHaveBeenCalledTimes(2);
  });

  it("uses null cf metadata when none is provided", async () => {
    const runtime = await resolveEdgeRuntime(
      new Request("https://edge.test/"),
      {
        env: {} as never,
      },
    );
    expect((runtime.request as Request & { cf?: unknown }).cf).toBeNull();
  });

  it("falls back to the worker env binding when no env is provided", async () => {
    const runtime = await resolveEdgeRuntime(new Request("https://edge.test/"));
    expect(runtime.url.toString()).toBe("https://edge.test/");
    expect(runtime.ctx.waitUntil).toBeTypeOf("function");
  });
});
