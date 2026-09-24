import { Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { readPublicLoginTurnstileRuntimeConfig } from "@/lib/edge/auth/login-turnstile-runtime";
import { publicRoutes } from "@/lib/hono/routes/public";
import type { AppEnv } from "@/lib/hono/types";

vi.mock("@/lib/edge/auth/login-turnstile-runtime", () => ({
  readPublicLoginTurnstileRuntimeConfig: vi.fn(),
}));

const env = { DB: {} };

function request(path: string, init?: RequestInit): Request {
  return new Request(`https://app.test${path}`, init);
}

function createApp() {
  const app = new Hono<AppEnv>();
  app.route("/api/public", publicRoutes);
  return app;
}

describe("public login security routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(readPublicLoginTurnstileRuntimeConfig).mockResolvedValue({
      enabled: false,
      siteKey: "",
      mode: "invisible",
    });
  });

  it("returns public login security config without caching", async () => {
    const response = await createApp().fetch(
      request("/api/public/login-security"),
      env as never,
    );
    const body = (await response.json()) as Record<string, any>;

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(body.data.turnstile).toEqual({
      enabled: false,
      siteKey: "",
      mode: "invisible",
    });
    expect(readPublicLoginTurnstileRuntimeConfig).toHaveBeenCalledWith(env);
  });
});
