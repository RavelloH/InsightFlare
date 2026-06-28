import { Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { handleApiKeysAdmin } from "@/lib/edge/admin-api-keys";
import { nf } from "@/lib/edge/admin-response";
import { handleScheduledTasksAdmin } from "@/lib/edge/admin-scheduled-tasks";
import {
  handleScriptSnippetAdmin,
  handleSiteConfigAdmin,
  handleSitesAdmin,
} from "@/lib/edge/admin-sites";
import {
  handleDoDiagnosticAdmin,
  handleSystemPerformanceAdmin,
} from "@/lib/edge/admin-system";
import { handleMembersAdmin, handleTeamsAdmin } from "@/lib/edge/admin-teams";
import {
  handleAuthLoginAdmin,
  handleAuthMeAdmin,
  handleProfileAdmin,
  handleUsersAdmin,
} from "@/lib/edge/admin-users";
import { privateAdminRoutes } from "@/lib/hono/routes/private/admin";
import type { AppEnv } from "@/lib/hono/types";

vi.mock("@/lib/edge/admin-api-keys", () => ({
  handleApiKeysAdmin: vi.fn(),
}));

vi.mock("@/lib/edge/admin-response", () => ({
  nf: vi.fn(() => new Response("not found", { status: 404 })),
}));

vi.mock("@/lib/edge/admin-scheduled-tasks", () => ({
  handleScheduledTasksAdmin: vi.fn(),
}));

vi.mock("@/lib/edge/admin-sites", () => ({
  handleScriptSnippetAdmin: vi.fn(),
  handleSiteConfigAdmin: vi.fn(),
  handleSitesAdmin: vi.fn(),
}));

vi.mock("@/lib/edge/admin-system", () => ({
  handleDoDiagnosticAdmin: vi.fn(),
  handleSystemPerformanceAdmin: vi.fn(),
}));

vi.mock("@/lib/edge/admin-teams", () => ({
  handleMembersAdmin: vi.fn(),
  handleTeamsAdmin: vi.fn(),
}));

vi.mock("@/lib/edge/admin-users", () => ({
  handleAuthLoginAdmin: vi.fn(),
  handleAuthMeAdmin: vi.fn(),
  handleProfileAdmin: vi.fn(),
  handleUsersAdmin: vi.fn(),
}));

const env = { DB: {} };
const ctx = {
  passThroughOnException: vi.fn(),
  waitUntil: vi.fn(),
} as unknown as ExecutionContext;

const routeCases = [
  ["/auth/login", handleAuthLoginAdmin, false],
  ["/auth/me", handleAuthMeAdmin, false],
  ["/users", handleUsersAdmin, false],
  ["/profile", handleProfileAdmin, false],
  ["/teams", handleTeamsAdmin, false],
  ["/sites", handleSitesAdmin, true],
  ["/members", handleMembersAdmin, true],
  ["/site-config", handleSiteConfigAdmin, true],
  ["/script-snippet", handleScriptSnippetAdmin, true],
  ["/api-keys", handleApiKeysAdmin, true],
  ["/system-performance", handleSystemPerformanceAdmin, true, true],
  ["/scheduled-tasks", handleScheduledTasksAdmin, true, true],
  ["/do-diagnostic", handleDoDiagnosticAdmin, true, true],
] as const;

function request(path: string, init?: RequestInit): Request {
  return new Request(`https://app.test${path}`, init);
}

function createApp() {
  const app = new Hono<AppEnv>();
  app.route("/api/private/admin", privateAdminRoutes);
  return app;
}

describe("Hono private admin routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    for (const [, handler] of routeCases) {
      vi.mocked(handler).mockResolvedValue(new Response("ok"));
    }
  });

  it("routes each admin path directly to its handler", async () => {
    for (const [path, handler, includesUrl, includesActor] of routeCases) {
      const app = createApp();
      const response = await app.fetch(
        request(`/api/private/admin${path}`),
        env as never,
        ctx,
      );

      expect(response.status).toBe(200);
      if (includesActor) {
        expect(handler).toHaveBeenCalledWith(
          expect.any(Request),
          env,
          new URL(`https://app.test/api/private/admin${path}`),
          expect.any(Function),
        );
      } else if (includesUrl) {
        expect(handler).toHaveBeenCalledWith(
          expect.any(Request),
          env,
          new URL(`https://app.test/api/private/admin${path}`),
        );
      } else {
        expect(handler).toHaveBeenCalledWith(expect.any(Request), env);
      }
    }
  });

  it("returns the shared admin not found response for unknown admin paths", async () => {
    const app = createApp();

    const response = await app.fetch(
      request("/api/private/admin/unknown"),
      env as never,
      ctx,
    );

    expect(response.status).toBe(404);
    expect(nf).toHaveBeenCalled();
  });
});
