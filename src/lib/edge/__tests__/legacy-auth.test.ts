import { beforeEach, describe, expect, it, vi } from "vitest";

import { handleAuthLoginAdmin } from "@/lib/edge/admin/users/handlers";
import {
  handleLegacyAuthLogin,
  handleLegacyAuthLogout,
} from "@/lib/edge/auth/legacy-auth";
import { readLoginTurnstileRuntimeConfig } from "@/lib/edge/auth/login-turnstile-runtime";
import { decryptLoginTurnstileSecret } from "@/lib/edge/auth/secret-encryption";
import { verifyTurnstileToken } from "@/lib/edge/auth/turnstile-siteverify";
vi.mock("@/lib/edge/admin/users/handlers", () => ({
  handleAuthLoginAdmin: vi.fn(),
}));
vi.mock("@/lib/edge/auth/login-turnstile-runtime", () => ({
  readLoginTurnstileRuntimeConfig: vi.fn(),
}));
vi.mock("@/lib/edge/auth/secret-encryption", () => ({
  decryptLoginTurnstileSecret: vi.fn(),
}));
vi.mock("@/lib/edge/auth/turnstile-siteverify", () => ({
  verifyTurnstileToken: vi.fn(),
}));
const env = {
  MAIN_SECRET: "test-main-secret",
};
function jsonRequest(path: string, body: Record<string, unknown>): Request {
  return new Request(`https://app.test${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin: "https://app.test",
    },
    body: JSON.stringify(body),
  });
}
async function responseJson(response: Response) {
  return (await response.json()) as Record<string, unknown>;
}
function errorCode(body: Record<string, unknown>): string {
  const error = body.error;
  return error && typeof error === "object" && "code" in error
    ? String((error as { code?: unknown }).code ?? "")
    : "";
}
describe("legacy auth edge adapter", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(handleAuthLoginAdmin).mockResolvedValue(
      Response.json({
        ok: true,
        data: {
          user: {
            id: "user-1",
            username: "admin",
            name: "Admin",
            systemRole: "admin",
          },
          teams: [],
        },
      }),
    );
    vi.mocked(readLoginTurnstileRuntimeConfig).mockResolvedValue(null);
    vi.mocked(decryptLoginTurnstileSecret).mockResolvedValue(
      "turnstile-secret",
    );
    vi.mocked(verifyTurnstileToken).mockResolvedValue({
      ok: true,
      hostname: "app.test",
    });
  });

  it("logs in through the private auth handler and sets the legacy cookie", async () => {
    const response = await handleLegacyAuthLogin(
      jsonRequest("/api/public/session", {
        username: "admin",
        password: "secret",
        next: "/app/team",
      }),
      env as any,
    );
    const body = await responseJson(response);

    expect(response.status).toBe(200);
    expect(body.data).toEqual({ next: "/app/team" });
    expect(response.headers.get("set-cookie")).toContain("if_session=");
    expect(handleAuthLoginAdmin).toHaveBeenCalledWith(expect.any(Request), env);
  });

  it("maps legacy auth validation, credential, and logout branches", async () => {
    const invalid = await handleLegacyAuthLogin(
      jsonRequest("/api/public/session", { username: "a", password: "" }),
      env as any,
    );
    expect(invalid.status).toBe(400);

    vi.mocked(handleAuthLoginAdmin).mockResolvedValueOnce(
      Response.json({ ok: false }, { status: 401 }),
    );
    const denied = await handleLegacyAuthLogin(
      jsonRequest("/api/public/session", {
        username: "admin",
        password: "wrong",
        next: "https://evil.test",
      }),
      env as any,
    );
    expect(denied.status).toBe(401);

    const logout = handleLegacyAuthLogout(
      new Request("https://app.test/api/public/session", { method: "POST" }),
    );
    expect(logout.headers.get("set-cookie")).toContain("Max-Age=0");
  });

  it("maps legacy auth upstream failures and malformed success payloads", async () => {
    vi.mocked(handleAuthLoginAdmin).mockResolvedValueOnce(
      new Response("service unavailable", { status: 503 }),
    );
    const unavailable = await handleLegacyAuthLogin(
      jsonRequest("/api/public/session", {
        username: "admin",
        password: "secret",
      }),
      env as any,
    );
    expect(unavailable.status).toBe(503);

    vi.mocked(handleAuthLoginAdmin).mockResolvedValueOnce(
      new Response("not json", { status: 200 }),
    );
    const invalidJson = await handleLegacyAuthLogin(
      jsonRequest("/api/public/session", {
        username: "admin",
        password: "secret",
      }),
      env as any,
    );
    expect(invalidJson.status).toBe(502);

    vi.mocked(handleAuthLoginAdmin).mockResolvedValueOnce(
      Response.json({ ok: true, data: {} }),
    );
    const missingUser = await handleLegacyAuthLogin(
      jsonRequest("/api/public/session", {
        username: "admin",
        password: "secret",
      }),
      env as any,
    );
    expect(missingUser.status).toBe(502);
  });

  it("requires Turnstile before calling the password verifier when enabled", async () => {
    vi.mocked(readLoginTurnstileRuntimeConfig).mockResolvedValueOnce({
      enabled: true,
      siteKey: "0xsite",
      mode: "invisible",
      secretKeyEncrypted: "encrypted",
      updatedAt: 1,
    });

    const response = await handleLegacyAuthLogin(
      jsonRequest("/api/public/session", {
        username: "admin",
        password: "secret",
      }),
      env as any,
    );
    const body = await responseJson(response);

    expect(response.status).toBe(400);
    expect(errorCode(body)).toBe("turnstile_required");
    expect(handleAuthLoginAdmin).not.toHaveBeenCalled();
  });

  it("rejects failed Turnstile verification before password verification", async () => {
    vi.mocked(readLoginTurnstileRuntimeConfig).mockResolvedValueOnce({
      enabled: true,
      siteKey: "0xsite",
      mode: "invisible",
      secretKeyEncrypted: "encrypted",
      updatedAt: 1,
    });
    vi.mocked(verifyTurnstileToken).mockResolvedValueOnce({
      ok: false,
      reason: "siteverify_failed",
      errorCodes: [],
    });

    const response = await handleLegacyAuthLogin(
      jsonRequest("/api/public/session", {
        username: "admin",
        password: "secret",
        turnstileToken: "token",
      }),
      env as any,
    );
    const body = await responseJson(response);

    expect(response.status).toBe(400);
    expect(errorCode(body)).toBe("turnstile_failed");
    expect(handleAuthLoginAdmin).not.toHaveBeenCalled();
  });

  it("continues login after successful Turnstile verification", async () => {
    vi.mocked(readLoginTurnstileRuntimeConfig).mockResolvedValueOnce({
      enabled: true,
      siteKey: "0xsite",
      mode: "invisible",
      secretKeyEncrypted: "encrypted",
      updatedAt: 1,
    });

    const response = await handleLegacyAuthLogin(
      jsonRequest("/api/public/session", {
        username: "admin",
        password: "secret",
        turnstileToken: "token",
      }),
      env as any,
    );

    expect(response.status).toBe(200);
    expect(decryptLoginTurnstileSecret).toHaveBeenCalledWith(env, "encrypted");
    expect(verifyTurnstileToken).toHaveBeenCalledWith(
      expect.objectContaining({
        secret: "turnstile-secret",
        token: "token",
        expectedHostname: "app.test",
      }),
    );
    expect(handleAuthLoginAdmin).toHaveBeenCalled();
  });
});
