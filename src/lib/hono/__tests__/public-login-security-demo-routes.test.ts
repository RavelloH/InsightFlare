// @vitest-environment node

import { afterEach, describe, expect, it, vi } from "vitest";

describe("demo public login security route", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it("returns disabled Turnstile config without reading D1", async () => {
    vi.stubEnv("VITE_DEMO_MODE", "1");
    vi.resetModules();
    const { Hono } = await import("hono");
    const { publicLoginSecurityRoutes } =
      await import("@/lib/hono/routes/public/login-security");
    const app = new Hono();
    app.route("/api/public/login-security", publicLoginSecurityRoutes);
    const prepare = vi.fn(() => {
      throw new Error("D1 must not be used for demo login security");
    });

    const response = await app.fetch(
      new Request("https://app.test/api/public/login-security"),
      { DB: { prepare } },
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toMatchObject({
      ok: true,
      data: {
        turnstile: { enabled: false, siteKey: "", mode: "invisible" },
      },
    });
    expect(prepare).not.toHaveBeenCalled();

    const missing = await app.fetch(
      new Request("https://app.test/api/public/login-security/unknown", {
        method: "POST",
      }),
      { DB: { prepare } },
    );
    expect(missing.status).toBe(404);
  });
});
