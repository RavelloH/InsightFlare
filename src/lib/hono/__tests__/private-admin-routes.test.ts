import { Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { handleApiKeysAdmin } from "@/lib/edge/admin-api-keys";
import {
  handleLoginTurnstileConfigAdmin,
  handleLoginTurnstileTestAdmin,
} from "@/lib/edge/admin-login-turnstile";
import {
  handleNotificationEmailConfigAdmin,
  handleNotificationEmailTestAdmin,
} from "@/lib/edge/admin-notification-email";
import {
  handleNotificationEmailPreviewAdmin,
  handleNotificationRulePreviewAdmin,
  handleNotificationRuleRunAdmin,
  handleNotificationRulesAdmin,
  handleNotificationTestAdmin,
} from "@/lib/edge/admin-notifications";
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
import { handleProfileAdmin, handleUsersAdmin } from "@/lib/edge/admin-users";
import { privateAdminRoutes } from "@/lib/hono/routes/private/admin";
import type { AppEnv } from "@/lib/hono/types";

vi.mock("@/lib/edge/admin-api-keys", () => ({
  handleApiKeysAdmin: vi.fn(),
}));

vi.mock("@/lib/edge/admin-response", () => ({
  nf: vi.fn(() => new Response("not found", { status: 404 })),
}));

vi.mock("@/lib/edge/admin-notification-email", () => ({
  handleNotificationEmailConfigAdmin: vi.fn(),
  handleNotificationEmailTestAdmin: vi.fn(),
}));

vi.mock("@/lib/edge/admin-login-turnstile", () => ({
  handleLoginTurnstileConfigAdmin: vi.fn(),
  handleLoginTurnstileTestAdmin: vi.fn(),
}));

vi.mock("@/lib/edge/admin-notifications", () => ({
  handleNotificationEmailPreviewAdmin: vi.fn(),
  handleNotificationRulesAdmin: vi.fn(),
  handleNotificationRulePreviewAdmin: vi.fn(),
  handleNotificationRuleRunAdmin: vi.fn(),
  handleNotificationTestAdmin: vi.fn(),
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
  handleProfileAdmin: vi.fn(),
  handleUsersAdmin: vi.fn(),
}));

const env = { DB: {} };
const ctx = {
  passThroughOnException: vi.fn(),
  waitUntil: vi.fn(),
} as unknown as ExecutionContext;

const routeCases = [
  ["/users", handleUsersAdmin, false],
  ["/profile", handleProfileAdmin, false],
  ["/teams", handleTeamsAdmin, false],
  ["/sites", handleSitesAdmin, true],
  ["/members", handleMembersAdmin, true],
  ["/site-config", handleSiteConfigAdmin, true],
  ["/script-snippet", handleScriptSnippetAdmin, true],
  ["/api-keys", handleApiKeysAdmin, true],
  ["/notification-email", handleNotificationEmailConfigAdmin, false],
  ["/notification-email/test", handleNotificationEmailTestAdmin, false],
  ["/login-turnstile", handleLoginTurnstileConfigAdmin, false],
  ["/login-turnstile/test", handleLoginTurnstileTestAdmin, false],
  ["/notification-email-preview", handleNotificationEmailPreviewAdmin, true],
  ["/notification-rules", handleNotificationRulesAdmin, true],
  ["/notification-rules/preview", handleNotificationRulePreviewAdmin, false],
  ["/notification-rules/run", handleNotificationRuleRunAdmin, false],
  ["/notification-test", handleNotificationTestAdmin, false],
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

  it("does not register the removed notification email preview alias", async () => {
    const app = createApp();

    const response = await app.fetch(
      request("/api/private/admin/notifications/email-preview"),
      env as never,
      ctx,
    );

    expect(response.status).toBe(404);
    expect(handleNotificationEmailPreviewAdmin).not.toHaveBeenCalled();
    expect(nf).toHaveBeenCalled();
  });
});
