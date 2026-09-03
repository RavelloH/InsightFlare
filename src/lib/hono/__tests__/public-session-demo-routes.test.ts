// @vitest-environment node

import { afterEach, describe, expect, it, vi } from "vitest";

describe("demo public session route", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it("returns the demo session over HTTP without reading D1", async () => {
    vi.stubEnv("VITE_DEMO_MODE", "1");
    vi.resetModules();
    const { Hono } = await import("hono");
    const { publicSessionRoutes } =
      await import("@/lib/hono/routes/public/session");
    const app = new Hono();
    app.route("/api/public/session", publicSessionRoutes);
    const prepare = vi.fn(() => {
      throw new Error("D1 must not be used for demo login");
    });

    const response = await app.fetch(
      new Request("https://app.test/api/public/session", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          username: "demo",
          password: "demo",
          next: "/en/app",
        }),
      }),
      { DB: { prepare } },
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("set-cookie")).toContain(
      "if_session=demo-token",
    );
    expect(await response.json()).toMatchObject({
      ok: true,
      data: {
        next: "/en/app",
        user: { id: "demo-user-001" },
        teams: [{ id: "demo-team-001" }],
      },
    });
    expect(prepare).not.toHaveBeenCalled();
  }, 15_000);
});
