import { describe, expect, it } from "vitest";

import { generateDemoNotificationMessages } from "@/lib/demo/admin/notifications";
import { getDemoSites, getDemoTeams } from "@/lib/demo/admin/users";

import { handleDemoAdminRoutes } from "./admin-routes";
import type { DemoRuntimeContext } from "./context";

const teamId = getDemoTeams()[0]!.id;
const siteId = getDemoSites(teamId)[0]!.id;
const baseContext: DemoRuntimeContext = {
  path: "",
  method: "GET",
  params: {},
  body: null,
  bodyRecord: {},
  siteId,
  teamId,
  locale: "en",
  publicSiteProfile: null,
};

function call(
  path: string,
  method = "GET",
  bodyRecord: Record<string, unknown> = {},
  params: Record<string, string | number> = {},
  body: unknown = bodyRecord,
) {
  return handleDemoAdminRoutes({
    ...baseContext,
    path,
    method,
    bodyRecord,
    params,
    body,
  });
}

describe("demo admin route dispatch", () => {
  it("serves the read-only administration collections and status endpoints", () => {
    const paths = [
      "/api/private/session",
      "/api/private/admin/auth/me",
      "/api/private/admin/users",
      "/api/private/admin/teams",
      "/api/private/admin/team-invites",
      "/api/private/admin/sites",
      "/api/private/admin/members",
      "/api/private/admin/site-config",
      "/api/private/admin/script-snippet",
      "/api/private/admin/api-keys",
      "/api/private/admin/analytics-engine-config",
      "/api/private/admin/request-observation",
      "/api/private/admin/notification-rules",
      "/api/private/notifications",
      "/api/private/notifications/preferences",
      "/api/private/admin/notification-email",
      "/api/private/admin/login-turnstile",
      "/api/public/login-security",
      "/api/private/admin/scheduled-tasks",
      "/api/private/admin/system-performance",
      "/api/private/admin/do-diagnostic",
    ];
    for (const path of paths) expect(call(path)).toBeDefined();
    expect(call("/not-an-admin-route")).toBeUndefined();
  });

  it("handles scheduled tasks, config changes, funnels, goals, and profile updates", () => {
    expect(
      call("/api/private/admin/scheduled-tasks", "PATCH", {
        retention: ["ignored"],
        retentionDays: 45,
        enabled: false,
      }),
    ).toMatchObject({ ok: true });
    expect(
      call("/api/private/admin/scheduled-tasks", "PATCH", {
        retention: { reportsDays: 30 },
        taskKey: "cleanup",
        enabled: true,
      }),
    ).toMatchObject({ ok: true });
    expect(
      call("/api/private/admin/analytics-engine-config", "POST", {
        accountId: " account ",
        apiToken: " token ",
      }),
    ).toMatchObject({
      ok: true,
      data: { accountId: "account", apiTokenHint: "••••demo" },
    });
    expect(
      call("/api/private/admin/analytics-engine-config", "PATCH", {
        apiToken: "token",
        clearApiToken: true,
      }),
    ).toMatchObject({ ok: true, data: { apiTokenHint: "" } });

    expect(
      call("/api/private/admin/funnels", "POST", { name: "Cart" }),
    ).toBeDefined();
    expect(
      call(
        "/api/private/admin/funnels",
        "PATCH",
        { name: "Updated" },
        { id: "missing" },
      ),
    ).toBeDefined();
    expect(
      call("/api/private/admin/funnels", "DELETE", {}, { id: "missing" }),
    ).toBeDefined();
    expect(
      call("/api/private/admin/goals", "POST", { name: "Signup" }),
    ).toBeDefined();
    expect(
      call(
        "/api/private/admin/goals",
        "PATCH",
        { name: "Updated" },
        { id: "missing" },
      ),
    ).toBeDefined();
    expect(
      call("/api/private/admin/goals", "DELETE", {}, { id: "missing" }),
    ).toBeDefined();

    expect(call("/api/public/session", "POST")).toMatchObject({ ok: true });
    expect(call("/api/private/auth/login", "POST")).toMatchObject({ ok: true });
    expect(call("/api/private/auth/me", "POST")).toMatchObject({ ok: true });
    expect(
      call("/api/private/profile", "PATCH", {
        username: "new",
        timeZone: "bad-zone",
      }),
    ).toMatchObject({ ok: true, data: { username: "new" } });
    expect(call("/api/private/profile", "PATCH", {}, {}, null)).toMatchObject({
      ok: true,
    });
    expect(
      call(
        "/api/private/site-config",
        "PATCH",
        {},
        {},
        { config: { trackHash: false } },
      ),
    ).toMatchObject({ ok: true, data: { trackHash: false } });
    expect(
      call("/api/private/site-config", "PATCH", {}, {}, { config: [] }),
    ).toMatchObject({ ok: true });
  });

  it("validates API keys and invite creation and returns notification action responses", () => {
    expect(
      call("/api/private/admin/api-keys", "POST", {
        name: "x",
        scopes: ["read"],
      }),
    ).toMatchObject({ ok: false });
    expect(
      call("/api/private/admin/api-keys", "POST", { name: "Key", scopes: [] }),
    ).toMatchObject({ ok: false });
    expect(
      call("/api/private/admin/api-keys", "POST", {
        name: "Key",
        scopes: ["read"],
        siteIds: [siteId],
      }),
    ).toMatchObject({ ok: true, data: { secret: expect.any(String) } });
    expect(
      call("/api/private/admin/api-keys", "PATCH", { keyId: "missing" }),
    ).toMatchObject({ ok: true, data: { status: "revoked" } });
    expect(
      call("/api/private/admin/api-keys", "DELETE", { keyId: "missing" }),
    ).toMatchObject({ ok: true });

    expect(
      call("/api/private/admin/team-invites", "POST", {
        role: "owner",
        email: "a@example.com",
      }),
    ).toMatchObject({ ok: false });
    expect(
      call("/api/private/admin/team-invites", "POST", { role: "member" }),
    ).toMatchObject({ ok: false });
    expect(
      call("/api/private/admin/team-invites", "POST", {
        role: "admin",
        email: "a@example.com",
      }),
    ).toMatchObject({
      ok: true,
      data: { invite: { payload: { teamRole: "admin", siteIds: [] } } },
    });
    expect(
      call("/api/private/admin/team-invites", "POST", {
        role: "member",
        email: "b@example.com",
        siteIds: [siteId],
      }),
    ).toMatchObject({
      ok: true,
      data: { invite: { payload: { teamRole: "member", siteIds: [siteId] } } },
    });

    expect(
      call("/api/private/admin/notification-email/test", "POST"),
    ).toMatchObject({ ok: true, data: { provider: "resend" } });
    expect(
      call("/api/private/admin/login-turnstile/test", "POST"),
    ).toMatchObject({ ok: true, data: { verified: true } });
    expect(call("/api/private/admin/login-turnstile", "DELETE")).toMatchObject({
      ok: true,
    });
    expect(
      call("/api/private/admin/login-turnstile", "PATCH", {
        secretKey: "secret",
        enabled: true,
      }),
    ).toMatchObject({ ok: true, data: { secretKeyConfigured: true } });
    expect(
      call(
        "/api/private/admin/notification-test",
        "POST",
        {},
        {},
        { enabled: true },
      ),
    ).toMatchObject({ ok: true });
    expect(call("/api/private/notifications", "PATCH")).toMatchObject({
      ok: true,
      data: { updated: 1 },
    });
    expect(
      call("/api/private/notifications/preferences", "PATCH"),
    ).toMatchObject({ ok: true, data: { webPush: false } });
    const notification = generateDemoNotificationMessages(teamId, "en")[0]!;
    expect(
      call(
        `/api/private/notifications/${encodeURIComponent(notification.id)}`,
        "PATCH",
      ),
    ).toMatchObject({ ok: true, data: { readAt: expect.any(Number) } });
    expect(call("/api/private/notifications/unknown", "PATCH")).toMatchObject({
      ok: true,
      data: null,
    });
    expect(
      call("/api/private/admin/notification-rules/preview", "POST", {}, {}, {}),
    ).toMatchObject({ ok: true });
    expect(
      call("/api/private/admin/notification-rules/run", "POST", {}, {}, {}),
    ).toMatchObject({ ok: true });
    expect(
      call(
        "/api/private/admin/notification-rules",
        "DELETE",
        {},
        { id: "rule-1" },
      ),
    ).toMatchObject({ ok: true, data: { removed: true } });
    expect(
      call("/api/private/admin/notification-rules", "POST", {}, {}, {}),
    ).toMatchObject({ ok: true });
  });

  it("normalizes email, site, team, member, and user mutations", () => {
    expect(
      call("/api/private/admin/notification-email", "DELETE"),
    ).toMatchObject({ ok: true });
    expect(
      call("/api/private/admin/notification-email", "PATCH", {
        enabled: true,
        provider: "none",
        resendApiKey: "secret",
        fromName: "Sender",
        fromEmail: "a@example.com",
        replyTo: "b@example.com",
      }),
    ).toMatchObject({
      ok: true,
      data: { enabled: true, provider: "none", resend: { configured: true } },
    });
    expect(
      call("/api/private/admin/notification-email", "PATCH", {
        enabled: "yes",
        provider: "other",
        clearResendApiKey: true,
      }),
    ).toMatchObject({
      ok: true,
      data: {
        enabled: false,
        provider: "resend",
        resend: { configured: false },
      },
    });

    expect(
      call("/api/private/admin/site", "POST", {
        siteId,
        name: "Renamed",
        domain: "new.example.com",
        publicEnabled: false,
        publicSlug: "new",
      }),
    ).toMatchObject({
      ok: true,
      data: { name: "Renamed", publicEnabled: false, publicSlug: "new" },
    });
    expect(call("/api/private/admin/site", "POST", {}, {}, null)).toMatchObject(
      { ok: true },
    );
    expect(call("/api/private/admin/teams", "PATCH", {})).toMatchObject({
      ok: false,
    });
    expect(
      call("/api/private/admin/teams", "PATCH", { teamId, intent: "remove" }),
    ).toMatchObject({ ok: true, data: { teams: expect.any(Array) } });
    expect(
      call("/api/private/admin/teams", "PATCH", { teamId, name: "x" }),
    ).toMatchObject({ ok: false });
    expect(
      call("/api/private/admin/teams", "PATCH", { teamId, name: "Updated" }),
    ).toMatchObject({ ok: true, data: { name: "Updated" } });
    expect(call("/api/private/admin/members", "PATCH", {})).toMatchObject({
      ok: false,
    });
    expect(
      call("/api/private/admin/members", "PATCH", { teamId }),
    ).toMatchObject({ ok: false });
    expect(
      call("/api/private/admin/members", "PATCH", { teamId, user: "user-1" }),
    ).toMatchObject({ ok: true });
    expect(
      call("/api/private/admin/users", "PATCH", { id: "user-2", teamId }),
    ).toMatchObject({ ok: true, data: { user: { id: "user-2" }, teamId } });
    expect(call("/api/private/admin/users", "POST", {})).toMatchObject({
      ok: true,
    });
    expect(call("/api/private/admin/unknown-write", "PATCH")).toMatchObject({
      ok: true,
      data: {},
    });
  });
});
