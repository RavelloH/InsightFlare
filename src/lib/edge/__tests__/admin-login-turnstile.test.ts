import { beforeEach, describe, expect, it, vi } from "vitest";

import { requireActor } from "@/lib/edge/admin/auth";
import {
  handleLoginTurnstileConfigAdmin,
  handleLoginTurnstileTestAdmin,
} from "@/lib/edge/admin/auth/login-turnstile";
import { verifyTurnstileToken } from "@/lib/edge/auth/turnstile-siteverify";
import type { Env } from "@/lib/edge/types";
vi.mock("@/lib/edge/admin/auth", () => ({
  requireActor: vi.fn(),
}));
vi.mock("@/lib/edge/auth/turnstile-siteverify", () => ({
  verifyTurnstileToken: vi.fn(),
}));
interface MockStatement {
  bind: ReturnType<typeof vi.fn>;
  first: ReturnType<typeof vi.fn>;
  run: ReturnType<typeof vi.fn>;
  all: ReturnType<typeof vi.fn>;
}
const actor = {
  user: {
    id: "admin-1",
    username: "admin",
    email: "admin@example.test",
    name: "Admin",
    password_hash: null,
    system_role: "admin",
    timezone: "UTC",
    created_at: 1,
    updated_at: 1,
  },
  isAdmin: true,
};
function statement(options: { first?: unknown; runReject?: Error } = {}) {
  const stmt: MockStatement = {
    bind: vi.fn((..._args: unknown[]) => stmt),
    first: vi.fn().mockResolvedValue(options.first ?? null),
    run: options.runReject
      ? vi.fn().mockRejectedValue(options.runReject)
      : vi.fn().mockResolvedValue({ success: true }),
    all: vi.fn().mockResolvedValue({ results: [] }),
  };
  return stmt;
}
function createEnv(
  statements: MockStatement[],
  kv?: {
    put?: ReturnType<typeof vi.fn>;
    delete?: ReturnType<typeof vi.fn>;
  },
) {
  let index = 0;
  return {
    MAIN_SECRET: "main-secret",
    DB: {
      prepare: vi.fn(() => {
        const stmt = statements[index];
        index += 1;
        if (!stmt) throw new Error(`Unexpected SQL #${index}`);
        return stmt;
      }),
    } as unknown as D1Database,
    SITE_SETTINGS_KV: kv
      ? ({
          put: kv.put ?? vi.fn().mockResolvedValue(undefined),
          delete: kv.delete ?? vi.fn().mockResolvedValue(undefined),
          get: vi.fn().mockResolvedValue(null),
        } as unknown as KVNamespace)
      : undefined,
  } as Env;
}
function request(path: string, init?: RequestInit) {
  return new Request(`https://app.test${path}`, {
    method: "GET",
    ...init,
  });
}
function jsonRequest(path: string, body: unknown, method = "PATCH") {
  return request(path, {
    method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}
function configRow(value: Record<string, unknown>) {
  return {
    value_json: JSON.stringify({
      enabled: false,
      siteKey: "",
      secretKeyEncrypted: "",
      secretKeyHint: "",
      mode: "invisible",
      updatedAt: 0,
      updatedByUserId: "",
      ...value,
    }),
  };
}
async function jsonOf(response: Response) {
  return (await response.json()) as Record<string, any>;
}
describe("login Turnstile admin handlers", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.restoreAllMocks();
    vi.mocked(requireActor).mockResolvedValue(actor);
    vi.mocked(verifyTurnstileToken).mockResolvedValue({
      ok: true,
      hostname: "app.test",
    });
  });

  it("passes through auth responses and rejects non-admin users", async () => {
    const unauthorized = new Response("unauthorized", { status: 401 });
    vi.mocked(requireActor).mockResolvedValueOnce(unauthorized);

    await expect(
      handleLoginTurnstileConfigAdmin(
        request("/api/private/admin/login-turnstile-config"),
        createEnv([]),
      ),
    ).resolves.toBe(unauthorized);

    vi.mocked(requireActor).mockResolvedValueOnce({ ...actor, isAdmin: false });
    const forbidden = await handleLoginTurnstileTestAdmin(
      jsonRequest("/api/private/admin/login-turnstile-test", {
        siteKey: "site",
        secretKey: "secret",
        turnstileToken: "token",
      }),
      createEnv([]),
    );

    expect(forbidden.status).toBe(403);
  });

  it("reads, updates, and deletes runtime-synced config", async () => {
    vi.spyOn(Date, "now").mockReturnValue(123_456);
    const kvPut = vi.fn().mockResolvedValue(undefined);
    const kvDelete = vi.fn().mockResolvedValue(undefined);
    const env = createEnv(
      [
        statement({
          first: configRow({
            enabled: true,
            siteKey: "existing-site",
            secretKeyEncrypted: "encrypted",
            secretKeyHint: "••••cret",
            updatedAt: 1,
          }),
        }),
        statement(),
        statement({
          first: configRow({
            enabled: false,
            siteKey: "",
            secretKeyEncrypted: "",
          }),
        }),
        statement(),
      ],
      { put: kvPut, delete: kvDelete },
    );

    const readResponse = await handleLoginTurnstileConfigAdmin(
      request("/api/private/admin/login-turnstile-config"),
      env,
    );
    await expect(readResponse.json()).resolves.toMatchObject({
      ok: true,
      data: {
        enabled: true,
        siteKey: "existing-site",
        secretKeyConfigured: true,
      },
    });

    const updateResponse = await handleLoginTurnstileConfigAdmin(
      jsonRequest("/api/private/admin/login-turnstile-config", {
        enabled: true,
        siteKey: "updated-site",
        secretKey: "updated-secret",
      }),
      env,
    );
    const updateBody = await jsonOf(updateResponse);

    expect(updateResponse.status).toBe(200);
    expect(updateBody.data).toMatchObject({
      enabled: true,
      siteKey: "updated-site",
      secretKeyConfigured: true,
      secretKeyHint: "••••cret",
      updatedAt: 123_456,
    });
    expect(kvPut).toHaveBeenCalledWith(
      "system:login-turnstile:runtime",
      expect.stringContaining("updated-site"),
    );

    const deleteResponse = await handleLoginTurnstileConfigAdmin(
      request("/api/private/admin/login-turnstile-config", {
        method: "DELETE",
      }),
      env,
    );

    expect(deleteResponse.status).toBe(200);
    expect(kvDelete).toHaveBeenCalledWith("system:login-turnstile:runtime");
  });

  it("returns validation and runtime sync errors for config writes", async () => {
    const invalidResponse = await handleLoginTurnstileConfigAdmin(
      jsonRequest("/api/private/admin/login-turnstile-config", {
        enabled: true,
        siteKey: 123,
      }),
      createEnv([]),
    );
    expect(invalidResponse.status).toBe(400);

    const missingKvResponse = await handleLoginTurnstileConfigAdmin(
      jsonRequest("/api/private/admin/login-turnstile-config", {
        enabled: true,
        siteKey: "site-key",
        secretKey: "secret-key",
      }),
      createEnv([statement(), statement()]),
    );
    const body = await jsonOf(missingKvResponse);

    expect(missingKvResponse.status).toBe(400);
    expect(body.error.code).toBe("login_turnstile_runtime_sync_failed");

    const unsupported = await handleLoginTurnstileConfigAdmin(
      request("/api/private/admin/login-turnstile-config", { method: "PUT" }),
      createEnv([]),
    );
    expect(unsupported.status).toBe(405);
  });

  it("validates and verifies Turnstile test requests", async () => {
    const missingSiteKey = await handleLoginTurnstileTestAdmin(
      jsonRequest(
        "/api/private/admin/login-turnstile-test",
        {
          secretKey: "secret",
          turnstileToken: "token",
        },
        "POST",
      ),
      createEnv([]),
    );
    expect(missingSiteKey.status).toBe(400);

    const missingSecret = await handleLoginTurnstileTestAdmin(
      jsonRequest(
        "/api/private/admin/login-turnstile-test",
        {
          siteKey: "site",
          turnstileToken: "token",
        },
        "POST",
      ),
      createEnv([]),
    );
    expect(missingSecret.status).toBe(400);

    const missingToken = await handleLoginTurnstileTestAdmin(
      jsonRequest(
        "/api/private/admin/login-turnstile-test",
        {
          siteKey: "site",
          secretKey: "secret",
        },
        "POST",
      ),
      createEnv([]),
    );
    expect(missingToken.status).toBe(400);

    vi.mocked(verifyTurnstileToken).mockResolvedValueOnce({
      ok: false,
      reason: "siteverify_failed",
      errorCodes: ["invalid-input-response"],
    });
    const failed = await handleLoginTurnstileTestAdmin(
      jsonRequest(
        "/api/private/admin/login-turnstile-test",
        {
          siteKey: "site",
          secretKey: "secret",
          turnstileToken: "bad",
        },
        "POST",
      ),
      createEnv([]),
    );
    expect(failed.status).toBe(400);

    const success = await handleLoginTurnstileTestAdmin(
      jsonRequest(
        "/api/private/admin/login-turnstile-test",
        {
          siteKey: "site",
          secretKey: "secret",
          turnstileToken: "token",
        },
        "POST",
      ),
      createEnv([]),
    );
    await expect(success.json()).resolves.toMatchObject({
      ok: true,
      data: {
        verified: true,
        siteKey: "site",
        hostname: "app.test",
      },
    });

    const methodNotAllowed = await handleLoginTurnstileTestAdmin(
      request("/api/private/admin/login-turnstile-test"),
      createEnv([]),
    );
    expect(methodNotAllowed.status).toBe(405);
  });
});
