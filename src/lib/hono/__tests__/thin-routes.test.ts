// @vitest-environment node

import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  handleNotificationEmailPreviewAdmin,
  handleNotificationPreferences,
  handleNotificationRead,
  handleNotificationRulePreviewAdmin,
  handleNotifications,
  handleNotificationsReadAll,
} from "@/lib/edge/admin-notifications";
import { handleAuthMeAdmin, handleUsersAdmin } from "@/lib/edge/admin-users";
import { handleAdminWs } from "@/lib/edge/admin-ws";
import {
  handleLegacyAuthLogin,
  handleLegacyAuthLogout,
} from "@/lib/edge/legacy-auth";
import { handleMapRelayRequest } from "@/lib/edge/map-relay";
import { handleReleasesCompareRequest } from "@/lib/edge/releases-compare";
import { privateAdminRoutes } from "@/lib/hono/routes/private/admin";
import { privateNotificationRoutes } from "@/lib/hono/routes/private/notifications";
import { privateRealtimeRoutes } from "@/lib/hono/routes/private/realtime";
import { privateReleaseRoutes } from "@/lib/hono/routes/private/releases";
import { privateSessionRoutes } from "@/lib/hono/routes/private/session";
import { publicResourceRoutes } from "@/lib/hono/routes/public/resources";
import { publicSessionRoutes } from "@/lib/hono/routes/public/session";
import { wellKnownRoutes } from "@/lib/hono/routes/well-known";

vi.mock("@/lib/edge/admin-ws", () => ({
  handleAdminWs: vi.fn(),
}));

vi.mock("@/lib/edge/map-relay", () => ({
  handleMapRelayRequest: vi.fn(),
}));

vi.mock("@/lib/edge/admin-users", () => ({
  handleAuthMeAdmin: vi.fn(),
  handleUsersAdmin: vi.fn(),
}));

vi.mock("@/lib/edge/admin-notifications", () => ({
  handleNotificationEmailPreviewAdmin: vi.fn(),
  handleNotificationPreferences: vi.fn(),
  handleNotificationRead: vi.fn(),
  handleNotificationRulePreviewAdmin: vi.fn(),
  handleNotifications: vi.fn(),
  handleNotificationsReadAll: vi.fn(),
}));

vi.mock("@/lib/edge/legacy-auth", () => ({
  handleLegacyAuthLogin: vi.fn(),
  handleLegacyAuthLogout: vi.fn(),
}));

vi.mock("@/lib/edge/releases-compare", () => ({
  handleReleasesCompareRequest: vi.fn(),
}));

const env = { DB: {} };

function request(path: string, init?: RequestInit) {
  return new Request(`https://app.test${path}`, init);
}

describe("thin Hono route modules", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(handleAdminWs).mockResolvedValue(new Response("ws"));
    vi.mocked(handleMapRelayRequest).mockResolvedValue(new Response("map"));
    vi.mocked(handleLegacyAuthLogin).mockResolvedValue(new Response("login"));
    vi.mocked(handleLegacyAuthLogout).mockResolvedValue(new Response("logout"));
    vi.mocked(handleAuthMeAdmin).mockResolvedValue(new Response("me"));
    vi.mocked(handleNotifications).mockResolvedValue(
      new Response("notifications"),
    );
    vi.mocked(handleNotificationPreferences).mockResolvedValue(
      new Response("preferences"),
    );
    vi.mocked(handleNotificationRead).mockResolvedValue(new Response("read"));
    vi.mocked(handleNotificationsReadAll).mockResolvedValue(
      new Response("read-all"),
    );
    vi.mocked(handleNotificationEmailPreviewAdmin).mockResolvedValue(
      new Response("preview"),
    );
    vi.mocked(handleNotificationRulePreviewAdmin).mockResolvedValue(
      new Response("rule-preview"),
    );
    vi.mocked(handleReleasesCompareRequest).mockResolvedValue(
      new Response("release"),
    );
  });

  it("forwards public session, private realtime, resource, and release routes to edge handlers", async () => {
    await publicSessionRoutes.fetch(
      request("/", { method: "POST" }),
      env as never,
    );
    await publicSessionRoutes.fetch(
      request("/", { method: "DELETE" }),
      env as never,
    );
    await privateRealtimeRoutes.fetch(request("/ws"), env as never);
    await privateReleaseRoutes.fetch(request("/compare"), env as never);
    await publicResourceRoutes.fetch(
      request("/map/v1/styles/light/style.json"),
      env as never,
    );

    expect(handleAdminWs).toHaveBeenCalledTimes(1);
    expect(handleLegacyAuthLogin).toHaveBeenCalled();
    expect(handleLegacyAuthLogout).toHaveBeenCalled();
    expect(handleReleasesCompareRequest).toHaveBeenCalledWith(
      expect.any(Request),
      env,
    );
    expect(handleMapRelayRequest).toHaveBeenCalledWith(
      expect.any(Request),
      env,
    );
  });

  it("returns not found from private wildcard routes", async () => {
    vi.mocked(handleUsersAdmin).mockResolvedValue(new Response("me"));

    const sessionMiss = await privateSessionRoutes.fetch(
      request("/missing"),
      env as never,
    );
    const realtimeMiss = await privateRealtimeRoutes.fetch(
      request("/missing"),
      env as never,
    );
    const releasesMiss = await privateReleaseRoutes.fetch(
      request("/missing"),
      env as never,
    );

    expect(sessionMiss.status).toBe(404);
    expect(realtimeMiss.status).toBe(404);
    expect(releasesMiss.status).toBe(404);
  });

  it("forwards private session and notification routes", async () => {
    await privateSessionRoutes.fetch(request("/"), env as never);
    await privateNotificationRoutes.fetch(request("/"), env as never);
    await privateNotificationRoutes.fetch(
      request("/preferences"),
      env as never,
    );
    await privateNotificationRoutes.fetch(
      request("/preferences", { method: "PATCH" }),
      env as never,
    );
    await privateNotificationRoutes.fetch(
      request("/message-1", { method: "PATCH" }),
      env as never,
    );
    await privateNotificationRoutes.fetch(
      request("/", { method: "PATCH" }),
      env as never,
    );

    expect(handleAuthMeAdmin).toHaveBeenCalled();
    expect(handleNotifications).toHaveBeenCalled();
    expect(handleNotificationPreferences).toHaveBeenCalledTimes(2);
    expect(handleNotificationRead).toHaveBeenCalledWith(
      expect.any(Request),
      env,
      "message-1",
    );
    expect(handleNotificationsReadAll).toHaveBeenCalled();
  });

  it("forwards public session and canonical private admin notification preview", async () => {
    await publicSessionRoutes.fetch(
      request("/", { method: "POST" }),
      env as never,
    );
    await publicSessionRoutes.fetch(
      request("/", { method: "DELETE" }),
      env as never,
    );
    await privateAdminRoutes.fetch(
      request("/notification-email-preview"),
      env as never,
    );
    await privateAdminRoutes.fetch(
      request("/notification-rules/preview"),
      env as never,
    );

    expect(handleLegacyAuthLogin).toHaveBeenCalled();
    expect(handleLegacyAuthLogout).toHaveBeenCalled();
    expect(handleNotificationEmailPreviewAdmin).toHaveBeenCalledTimes(1);
    expect(handleNotificationRulePreviewAdmin).toHaveBeenCalled();
  });

  it("does not forward the removed private admin notification preview alias", async () => {
    const response = await privateAdminRoutes.fetch(
      request("/notifications/email-preview"),
      env as never,
    );

    expect(response.status).toBe(404);
    expect(handleNotificationEmailPreviewAdmin).not.toHaveBeenCalled();
  });

  it("serves well-known routes directly from the thin route module", async () => {
    const openapiHead = await wellKnownRoutes.fetch(
      request("/.well-known/openapi.json", { method: "HEAD" }),
      env as never,
    );
    const openapi = await wellKnownRoutes.fetch(
      request("/.well-known/openapi.json", {
        headers: { "x-forwarded-host": "api.example.test" },
      }),
      env as never,
    );
    const skillsHead = await wellKnownRoutes.fetch(
      request("/.well-known/skills.json", { method: "HEAD" }),
      env as never,
    );
    const skills = await wellKnownRoutes.fetch(
      request("/.well-known/skills.json"),
      env as never,
    );
    const securityHead = await wellKnownRoutes.fetch(
      request("/.well-known/security.txt", { method: "HEAD" }),
      env as never,
    );
    const security = await wellKnownRoutes.fetch(
      request("/.well-known/security.txt"),
      env as never,
    );
    const changePassword = await wellKnownRoutes.fetch(
      request("/.well-known/change-password"),
      env as never,
    );
    const health = await wellKnownRoutes.fetch(
      request("/.well-known/health"),
      env as never,
    );
    const publicMiss = await publicSessionRoutes.fetch(
      request("/missing"),
      env as never,
    );

    expect(openapiHead.status).toBe(200);
    expect((await openapi.json()) as unknown).toBeTruthy();
    expect(skillsHead.status).toBe(200);
    expect(skills.headers.get("content-type")).toContain("application/json");
    expect(skills.headers.get("access-control-allow-origin")).toBe("*");
    expect(skills.headers.get("cache-control")).toContain("max-age=3600");
    expect(await skills.text()).toContain("InsightFlare");
    expect(securityHead.status).toBe(200);
    expect(await security.text()).toContain("Contact:");
    expect(changePassword.status).toBe(302);
    expect(health.status).toBe(302);
    expect(publicMiss.status).toBe(404);
  });
});
