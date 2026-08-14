import { beforeEach, describe, expect, it, vi } from "vitest";

import { requireActor } from "@/lib/edge/admin-auth";
import { handlePerformanceFoundationAdmin } from "@/lib/edge/admin-performance-foundation";
import type { Env } from "@/lib/edge/types";

vi.mock("@/lib/edge/admin-auth", () => ({
  requireActor: vi.fn(),
}));

type Statement = {
  bind: ReturnType<typeof vi.fn>;
  first: ReturnType<typeof vi.fn>;
  run: ReturnType<typeof vi.fn>;
};

const adminActor = {
  user: {
    id: "admin-1",
    username: "admin",
    email: "admin@example.test",
    name: "Admin",
    password_hash: "hash",
    system_role: "admin",
    timezone: "UTC",
    created_at: 1,
    updated_at: 1,
  },
  isAdmin: true,
};

const requireActorMock = vi.mocked(requireActor);

function statement(
  options: { first?: unknown; firstError?: unknown; changes?: number } = {},
): Statement {
  const stmt: Statement = {
    bind: vi.fn(),
    first: vi.fn(),
    run: vi.fn(),
  };
  stmt.bind.mockReturnValue(stmt);
  if ("firstError" in options) stmt.first.mockRejectedValue(options.firstError);
  else stmt.first.mockResolvedValue(options.first ?? null);
  stmt.run.mockResolvedValue({ meta: { changes: options.changes ?? 0 } });
  return stmt;
}

function env(statements: Statement[]): {
  env: Env;
  prepare: ReturnType<typeof vi.fn>;
} {
  let index = 0;
  const prepare = vi.fn(() => {
    const stmt = statements[index];
    index += 1;
    if (!stmt) throw new Error("unexpected statement");
    return stmt;
  });
  return { env: { DB: { prepare } } as unknown as Env, prepare };
}

function request(method = "GET", body?: Record<string, unknown>): Request {
  return new Request(
    "https://app.test/api/private/admin/performance-foundation",
    {
      method,
      headers: body ? { "content-type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    },
  );
}

describe("performance foundation admin handler", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    requireActorMock.mockResolvedValue(adminActor);
  });

  it("passes through authentication responses and denies non-admin actors", async () => {
    const unauthenticated = new Response(null, { status: 401 });
    const first = env([]);
    requireActorMock.mockResolvedValueOnce(unauthenticated);
    await expect(
      handlePerformanceFoundationAdmin(request(), first.env),
    ).resolves.toBe(unauthenticated);
    expect(first.prepare).not.toHaveBeenCalled();

    const forbidden = env([]);
    requireActorMock.mockResolvedValueOnce({ ...adminActor, isAdmin: false });
    await expect(
      handlePerformanceFoundationAdmin(request(), forbidden.env),
    ).resolves.toMatchObject({
      status: 403,
    });
    expect(forbidden.prepare).not.toHaveBeenCalled();
  });

  it("fails closed when the control cannot be read", async () => {
    const { env: testEnv } = env([
      statement({ firstError: new Error("missing table") }),
    ]);

    const response = await handlePerformanceFoundationAdmin(request(), testEnv);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      state: "disabled",
      unavailable: true,
    });
  });

  it("rejects unsupported methods and malformed updates", async () => {
    const method = env([]);
    await expect(
      handlePerformanceFoundationAdmin(request("POST"), method.env),
    ).resolves.toMatchObject({ status: 405 });
    expect(method.prepare).not.toHaveBeenCalled();

    const malformed = env([]);
    await expect(
      handlePerformanceFoundationAdmin(
        request("PUT", { state: "shadow" }),
        malformed.env,
      ),
    ).resolves.toMatchObject({ status: 400 });
    expect(malformed.prepare).not.toHaveBeenCalled();
  });

  it("rejects invalid JSON bodies before touching the control store", async () => {
    const malformed = env([]);
    const response = await handlePerformanceFoundationAdmin(
      new Request("https://app.test/api/private/admin/performance-foundation", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: "{",
      }),
      malformed.env,
    );

    expect(response.status).toBe(400);
    expect(malformed.prepare).not.toHaveBeenCalled();
  });

  it("uses a conditional revision update and reports stale CAS writes", async () => {
    const update = statement({ changes: 0 });
    const { env: testEnv, prepare } = env([update]);

    const response = await handlePerformanceFoundationAdmin(
      request("PUT", {
        state: "shadow",
        generation: "foundation-1",
        revision: 1,
      }),
      testEnv,
    );

    expect(response.status).toBe(409);
    expect(prepare).toHaveBeenCalledTimes(1);
    expect(update.bind).toHaveBeenCalledWith(
      "shadow",
      "foundation-1",
      "admin-1",
      expect.any(String),
      "foundation",
      1,
    );
  });

  it("returns the updated control after a successful CAS write", async () => {
    const update = statement({ changes: 1 });
    const read = statement({
      first: {
        name: "foundation",
        routeScope: "foundation",
        state: "shadow",
        generation: "foundation-1",
        revision: 2,
        updatedAt: 123,
      },
    });
    const { env: testEnv } = env([update, read]);

    const response = await handlePerformanceFoundationAdmin(
      request("PUT", {
        state: "shadow",
        generation: "foundation-1",
        revision: 1,
      }),
      testEnv,
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      state: "shadow",
      generation: "foundation-1",
      revision: 2,
    });
  });
});
