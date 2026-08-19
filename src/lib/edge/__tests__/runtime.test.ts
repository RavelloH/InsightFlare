import { describe, expect, it, vi } from "vitest";

import { resolveEdgeRuntime } from "@/lib/edge/runtime";

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
