import { Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { requireActor } from "@/lib/edge/admin-auth";
import { readPerformanceControl } from "@/lib/edge/performance-controls";
import { performanceV2StubResponse } from "@/lib/edge/performance-v2";
import { privateRoutes } from "@/lib/hono/routes/private";
import {
  privateAdminPerformanceV2Routes,
  privatePerformanceV2Routes,
} from "@/lib/hono/routes/private/performance-v2";
import type { AppEnv } from "@/lib/hono/types";

vi.mock("@/lib/edge/performance-controls", () => ({
  readPerformanceControl: vi.fn(),
}));

const resolveSite = vi.fn();

vi.mock("@/lib/hono/middleware/site", () => ({
  resolvePrivateSiteMiddleware:
    () =>
    async (
      c: {
        set: (key: "privateSite" | "site", value: { id: string }) => void;
      },
      next: () => Promise<void>,
    ) => {
      resolveSite();
      c.set("privateSite", { id: "site-1" });
      c.set("site", { id: "site-1" });
      await next();
    },
}));

vi.mock("@/lib/edge/admin-auth", () => ({
  requireActor: vi.fn(),
}));

vi.mock("@/lib/hono/middleware/session", () => ({
  requireSessionMiddleware:
    () => async (_c: unknown, next: () => Promise<void>) =>
      next(),
}));

const control = vi.mocked(readPerformanceControl);
const actor = vi.mocked(requireActor);
const request = new Request(
  "https://app.test/api/private/v2/journeys/visitors",
);

function journeyApp() {
  const app = new Hono<AppEnv>();
  app.route("/v2", privatePerformanceV2Routes);
  return app;
}

function adminApp() {
  const app = new Hono<AppEnv>();
  app.route("/admin/v2", privateAdminPerformanceV2Routes);
  return app;
}

function privateApp() {
  const app = new Hono<AppEnv>();
  app.route("/api/private", privateRoutes);
  return app;
}

describe("performance v2 Foundation stubs", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    control.mockResolvedValue(null);
    actor.mockResolvedValue({ isAdmin: true } as never);
  });

  it("fails closed when the rollout control is unavailable", async () => {
    control.mockResolvedValue(null);

    const response = await performanceV2StubResponse(
      request,
      {} as never,
      "journey-v2",
    );

    expect(response.status).toBe(503);
    expect(response.headers.get("cache-control")).toBe("no-store");
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "performance_v2_disabled" },
      scope: "journey-v2",
      state: "disabled",
    });
  });

  it("does not expose a business handler even if Foundation is enabled", async () => {
    control.mockResolvedValue({ state: "enabled" } as never);

    const response = await performanceV2StubResponse(
      request,
      {} as never,
      "scheduled-tasks-v2",
    );

    await expect(response.json()).resolves.toMatchObject({
      error: { code: "performance_v2_not_implemented" },
      scope: "scheduled-tasks-v2",
    });
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  it("resolves a site only for allowlisted Journey routes before returning its stub", async () => {
    const response = await journeyApp().request(
      "https://app.test/v2/journeys/visitors",
      undefined,
      {} as never,
    );

    expect(response.status).toBe(503);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(resolveSite).toHaveBeenCalledTimes(1);
    expect(control).toHaveBeenCalledTimes(1);
  });

  it("rejects unknown Journey paths without site or control access", async () => {
    const response = await journeyApp().request(
      "https://app.test/v2/journeys/not-implemented",
      undefined,
      {} as never,
    );

    expect(response.status).toBe(404);
    expect(resolveSite).not.toHaveBeenCalled();
    expect(control).not.toHaveBeenCalled();
  });

  it("requires a system admin before the scheduled-task v2 stub reads controls", async () => {
    actor.mockResolvedValueOnce({ isAdmin: false } as never);

    const denied = await adminApp().request(
      "https://app.test/admin/v2/scheduled-tasks",
      undefined,
      {} as never,
    );
    expect(denied.status).toBe(403);
    expect(control).not.toHaveBeenCalled();

    const allowed = await adminApp().request(
      "https://app.test/admin/v2/scheduled-tasks",
      undefined,
      {} as never,
    );
    expect(allowed.status).toBe(503);
    expect(allowed.headers.get("cache-control")).toBe("no-store");
    expect(control).toHaveBeenCalledTimes(1);
  });

  it("mounts the admin v2 namespace ahead of the legacy admin namespace", async () => {
    const response = await privateApp().request(
      "https://app.test/api/private/admin/v2/scheduled-tasks",
      undefined,
      {} as never,
    );

    expect(response.status).toBe(503);
    expect(actor).toHaveBeenCalledTimes(1);
    expect(control).toHaveBeenCalledTimes(1);
  });
});
