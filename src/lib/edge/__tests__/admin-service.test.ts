import { afterEach, describe, expect, it, vi } from "vitest";

import {
  adminServicePath,
  adminServiceRouteForPath,
} from "@/lib/admin-service-contract";
import { executeAdminService } from "@/lib/edge/admin-service";
import { executeDemoAdminService } from "@/lib/edge/admin-service-demo";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("admin service route contract", () => {
  it("round-trips static management routes", () => {
    const routes = [
      "session",
      "users",
      "teams",
      "notification-rules",
      "system-performance",
    ] as const;

    for (const route of routes) {
      expect(adminServiceRouteForPath(adminServicePath(route))).toBe(route);
    }
  });

  it("maps notification collection methods to distinct service operations", () => {
    expect(adminServiceRouteForPath("/api/private/notifications", "GET")).toBe(
      "notifications",
    );
    expect(
      adminServiceRouteForPath("/api/private/notifications", "PATCH"),
    ).toBe("notifications/read-all");
    expect(
      adminServiceRouteForPath(
        "/api/private/notifications/preferences",
        "PATCH",
      ),
    ).toBe("notifications/preferences");
  });

  it("rejects notification identifiers that escape their route segment", () => {
    expect(
      adminServiceRouteForPath(
        "/api/private/notifications/message%2Fid",
        "PATCH",
      ),
    ).toBeNull();
  });

  it("rejects non-management and unknown management paths", () => {
    expect(adminServiceRouteForPath("/api/private/overview")).toBeNull();
    expect(adminServiceRouteForPath("/api/private/admin/unknown")).toBeNull();
    expect(
      adminServiceRouteForPath("/api/private/admin/notifications/read-all"),
    ).toBeNull();
    expect(adminServiceRouteForPath("/api/public/session")).toBeNull();
  });

  it("normalizes server demo payloads to the admin response envelope", async () => {
    const request = new Request(
      "https://app.test/api/private/admin/system-performance?minutes=60",
    );
    const response = await executeDemoAdminService({
      route: "system-performance",
      request,
      env: {} as never,
      url: new URL(request.url),
    });
    const payload = (await response.json()) as {
      ok?: unknown;
      data?: { ok?: unknown; summary?: unknown };
    };

    expect(response.ok).toBe(true);
    expect(payload.ok).toBe(true);
    expect(payload.data?.ok).toBe(true);
    expect(payload.data?.summary).toBeDefined();
  });

  it("serves bot analytics mock data through the admin adapter", async () => {
    const request = new Request(
      "https://app.test/api/private/admin/bot-analytics?from=0&to=3600000&limit=10",
    );
    const response = await executeDemoAdminService({
      route: "bot-analytics",
      request,
      env: {} as never,
      url: new URL(request.url),
    });
    const payload = (await response.json()) as {
      ok?: unknown;
      data?: { ok?: unknown; events?: unknown[] };
    };

    expect(response.ok).toBe(true);
    expect(payload.ok).toBe(true);
    expect(payload.data?.ok).toBe(true);
    expect(payload.data?.events).toBeInstanceOf(Array);
  });

  it("serves notification email previews through the demo service adapter", async () => {
    const request = new Request(
      "https://app.test/api/private/admin/notification-email-preview?type=report&locale=zh&format=json",
    );
    const response = await executeDemoAdminService({
      route: "notification-email-preview",
      request,
      env: {} as never,
      url: new URL(request.url),
    });
    const payload = (await response.json()) as {
      ok?: unknown;
      data?: { subject?: unknown; html?: unknown; text?: unknown };
    };

    expect(response.ok).toBe(true);
    expect(payload.ok).toBe(true);
    expect(payload.data?.subject).toEqual(expect.any(String));
    expect(payload.data?.html).toEqual(expect.any(String));
    expect(payload.data?.text).toEqual(expect.any(String));
  });

  it("selects the server demo adapter for admin service requests", async () => {
    vi.stubEnv("VITE_DEMO_MODE", "1");
    const request = new Request(
      "https://app.test/api/private/admin/api-keys?teamId=team-demo",
    );
    const response = await executeAdminService({
      route: "api-keys",
      request,
      env: {} as never,
      url: new URL(request.url),
    });
    const payload = (await response.json()) as {
      ok?: unknown;
      data?: unknown[];
    };

    expect(response.ok).toBe(true);
    expect(payload.ok).toBe(true);
    expect(payload.data).toBeInstanceOf(Array);
  });
});
