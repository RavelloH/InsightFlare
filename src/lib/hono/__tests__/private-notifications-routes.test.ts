import { Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  handleNotificationPreferences,
  handleNotificationRead,
  handleNotifications,
  handleNotificationsReadAll,
} from "@/lib/edge/admin/notifications/handler";
import { nf } from "@/lib/edge/admin/response";
import { privateNotificationRoutes } from "@/lib/hono/routes/private/notifications";
import type { AppEnv } from "@/lib/hono/types";
vi.mock("@/lib/edge/admin/notifications/handler", () => ({
  handleNotificationRead: vi.fn(),
  handleNotifications: vi.fn(),
  handleNotificationPreferences: vi.fn(),
  handleNotificationsReadAll: vi.fn(),
}));
vi.mock("@/lib/edge/admin/response", () => ({
  nf: vi.fn(() => new Response("not found", { status: 404 })),
}));
const env = { DB: {} };
const ctx = {
  passThroughOnException: vi.fn(),
  waitUntil: vi.fn(),
} as unknown as ExecutionContext;
function request(path: string, init?: RequestInit): Request {
  return new Request(`https://app.test${path}`, init);
}
function createApp() {
  const app = new Hono<AppEnv>();
  app.route("/api/private/notifications", privateNotificationRoutes);
  return app;
}
describe("Hono private notification routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(handleNotifications).mockResolvedValue(new Response("ok"));
    vi.mocked(handleNotificationRead).mockResolvedValue(new Response("ok"));
    vi.mocked(handleNotificationPreferences).mockResolvedValue(
      new Response("ok"),
    );
    vi.mocked(handleNotificationsReadAll).mockResolvedValue(new Response("ok"));
  });

  it("routes GET /notifications to the notification list handler", async () => {
    const app = createApp();

    const response = await app.fetch(
      request("/api/private/notifications?teamId=team-1"),
      env as never,
      ctx,
    );

    expect(response.status).toBe(200);
    expect(handleNotifications).toHaveBeenCalledWith(
      expect.any(Request),
      env,
      new URL("https://app.test/api/private/notifications?teamId=team-1"),
    );
  });

  it("routes PATCH /notifications/:messageId to the single read handler", async () => {
    const app = createApp();

    const response = await app.fetch(
      request("/api/private/notifications/message-1", {
        method: "PATCH",
        body: JSON.stringify({ read: true }),
      }),
      env as never,
      ctx,
    );

    expect(response.status).toBe(200);
    expect(handleNotificationRead).toHaveBeenCalledWith(
      expect.any(Request),
      env,
      "message-1",
    );
  });

  it("routes PATCH /notifications to the bulk read handler", async () => {
    const app = createApp();

    const response = await app.fetch(
      request("/api/private/notifications", {
        method: "PATCH",
        body: JSON.stringify({ read: true, teamId: "team-1" }),
      }),
      env as never,
      ctx,
    );

    expect(response.status).toBe(200);
    expect(handleNotificationsReadAll).toHaveBeenCalledWith(
      expect.any(Request),
      env,
    );
  });

  it("routes notification preference requests to the preference handler", async () => {
    const app = createApp();

    const response = await app.fetch(
      request("/api/private/notifications/preferences", {
        method: "PATCH",
        body: JSON.stringify({ email: false }),
      }),
      env as never,
      ctx,
    );

    expect(response.status).toBe(200);
    expect(handleNotificationPreferences).toHaveBeenCalledWith(
      expect.any(Request),
      env,
    );
    expect(handleNotificationRead).not.toHaveBeenCalled();
  });

  it("returns not found for unsupported nested notification paths", async () => {
    const app = createApp();

    const response = await app.fetch(
      request("/api/private/notifications/message-1/extra"),
      env as never,
      ctx,
    );

    expect(response.status).toBe(404);
    expect(nf).toHaveBeenCalled();
  });
});
