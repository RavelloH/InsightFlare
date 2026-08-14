import { describe, expect, it, vi } from "vitest";

import {
  DIAGNOSTIC_CACHE_BYPASS_HEADER,
  issueDiagnosticCacheBypassToken,
  verifyDiagnosticCacheBypass,
} from "@/lib/edge/diagnostic-cache-bypass";
import { DiagnosticsSampler } from "@/lib/edge/diagnostics-sampler";
import type { Env } from "@/lib/edge/types";

const nowMs = Date.UTC(2026, 7, 14, 12, 0, 0);

function createEnv(
  consumeBypassNonce = vi.fn().mockResolvedValue(true),
  reserveCacheBypass = vi.fn().mockResolvedValue(true),
): {
  consumeBypassNonce: ReturnType<typeof vi.fn>;
  env: Env;
  reserveCacheBypass: ReturnType<typeof vi.fn>;
} {
  return {
    consumeBypassNonce,
    reserveCacheBypass,
    env: {
      MAIN_SECRET: "diagnostic-cache-bypass-test-secret",
      DIAGNOSTICS_SAMPLER: {
        getByName: vi.fn(() => ({ consumeBypassNonce, reserveCacheBypass })),
      },
    } as unknown as Env,
  };
}

function request(
  url = "https://app.test/api/private/v2/journeys/visitors?a=1&b=2",
  headers?: HeadersInit,
): Request {
  return new Request(url, { headers });
}

function encodePayload(payload: unknown): string {
  const bytes = new TextEncoder().encode(JSON.stringify(payload));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function withToken(
  token: string,
  mutate: (parts: string[]) => string[],
  url?: string,
): Request {
  return request(url, {
    [DIAGNOSTIC_CACHE_BYPASS_HEADER]: mutate(token.split(".")).join("."),
  });
}

describe("diagnostic cache bypass token", () => {
  it("keeps a rate reservation until its minute bucket expires after a nonce alarm", async () => {
    const values = new Map<string, unknown>();
    let alarmAt: number | null = null;
    const storage = {
      delete: vi.fn(async (key: string) => values.delete(key)),
      deleteAlarm: vi.fn(async () => {
        alarmAt = null;
      }),
      get: vi.fn(async <T>(key: string) => values.get(key) as T | undefined),
      getAlarm: vi.fn(async () => alarmAt),
      list: vi.fn(
        async <T>({ prefix }: { prefix: string }) =>
          new Map(
            [...values.entries()].filter(([key]) => key.startsWith(prefix)),
          ) as Map<string, T>,
      ),
      put: vi.fn(async (key: string, value: unknown) => {
        values.set(key, value);
      }),
      setAlarm: vi.fn(async (value: number) => {
        alarmAt = value;
      }),
    };
    const sampler = Object.create(
      DiagnosticsSampler.prototype,
    ) as DiagnosticsSampler;
    Object.defineProperty(sampler, "ctx", { value: { storage } });
    const nonce = "n".repeat(16);

    await sampler.reserveCacheBypass("admin-1", nowMs);
    await sampler.consumeBypassNonce(nonce, nowMs + 1_000, nowMs);
    vi.spyOn(Date, "now").mockReturnValue(nowMs + 1_000);
    await sampler.alarm();
    vi.restoreAllMocks();

    expect([...values.keys()]).toEqual([
      expect.stringMatching(/^bypass-rate:\d+:[a-z0-9]+$/),
    ]);
    expect([...values.values()]).toEqual([
      { count: 1, expiresAtMs: nowMs + 60_000 },
    ]);
    expect(alarmAt).toBe(nowMs + 60_000);
  });

  it("accepts a one-time token bound to its actor and canonical request", async () => {
    const { env, consumeBypassNonce, reserveCacheBypass } = createEnv();
    const token = await issueDiagnosticCacheBypassToken({
      actorId: "admin-1",
      env,
      nowMs,
      request: request(
        "https://app.test/api/private/v2/journeys/visitors?b=2&a=1",
      ),
    });
    const signedRequest = request(undefined, {
      [DIAGNOSTIC_CACHE_BYPASS_HEADER]: token ?? "",
    });

    await expect(
      verifyDiagnosticCacheBypass({
        actorId: "admin-1",
        env,
        nowMs: nowMs + 1,
        request: signedRequest,
      }),
    ).resolves.toBe(true);
    expect(consumeBypassNonce).toHaveBeenCalledTimes(1);
    expect(reserveCacheBypass).toHaveBeenCalledWith("admin-1", nowMs);
    expect(consumeBypassNonce).toHaveBeenCalledWith(
      expect.stringMatching(/^[A-Za-z0-9_-]{16,96}$/),
      nowMs + 60_000,
      nowMs + 1,
    );
  });

  it("rejects replays and any change to the actor, method, or request", async () => {
    const consumeBypassNonce = vi
      .fn()
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false);
    const { env } = createEnv(consumeBypassNonce);
    const token = await issueDiagnosticCacheBypassToken({
      actorId: "admin-1",
      env,
      nowMs,
      request: request(),
    });
    const signedRequest = request(undefined, {
      [DIAGNOSTIC_CACHE_BYPASS_HEADER]: token ?? "",
    });

    await expect(
      verifyDiagnosticCacheBypass({
        actorId: "admin-1",
        env,
        nowMs: nowMs + 1,
        request: signedRequest,
      }),
    ).resolves.toBe(true);
    await expect(
      verifyDiagnosticCacheBypass({
        actorId: "admin-1",
        env,
        nowMs: nowMs + 2,
        request: signedRequest,
      }),
    ).resolves.toBe(false);
    await expect(
      verifyDiagnosticCacheBypass({
        actorId: "other-admin",
        env,
        nowMs: nowMs + 2,
        request: signedRequest,
      }),
    ).resolves.toBe(false);
    await expect(
      verifyDiagnosticCacheBypass({
        actorId: "admin-1",
        env,
        nowMs: nowMs + 2,
        request: new Request(signedRequest.url, {
          method: "POST",
          headers: signedRequest.headers,
        }),
      }),
    ).resolves.toBe(false);
    expect(consumeBypassNonce).toHaveBeenCalledTimes(2);
  });

  it("fails closed when the token is expired, altered, or no sampler is bound", async () => {
    const { env, consumeBypassNonce } = createEnv();
    const token = await issueDiagnosticCacheBypassToken({
      actorId: "admin-1",
      env,
      nowMs,
      ttlMs: 1_000,
      request: request(),
    });
    const alteredRequest = request(undefined, {
      [DIAGNOSTIC_CACHE_BYPASS_HEADER]: `${token}x`,
    });

    await expect(
      verifyDiagnosticCacheBypass({
        actorId: "admin-1",
        env,
        nowMs: nowMs + 1,
        request: alteredRequest,
      }),
    ).resolves.toBe(false);
    await expect(
      verifyDiagnosticCacheBypass({
        actorId: "admin-1",
        env,
        nowMs: nowMs + 1_000,
        request: request(undefined, {
          [DIAGNOSTIC_CACHE_BYPASS_HEADER]: token ?? "",
        }),
      }),
    ).resolves.toBe(false);
    await expect(
      verifyDiagnosticCacheBypass({
        actorId: "admin-1",
        env: { MAIN_SECRET: "diagnostic-cache-bypass-test-secret" } as Env,
        nowMs: nowMs + 1,
        request: request(undefined, {
          [DIAGNOSTIC_CACHE_BYPASS_HEADER]: token ?? "",
        }),
      }),
    ).resolves.toBe(false);
    expect(consumeBypassNonce).not.toHaveBeenCalled();
  });

  it("fails closed when nonce consumption throws", async () => {
    const { env } = createEnv(vi.fn().mockRejectedValue(new Error("offline")));
    const token = await issueDiagnosticCacheBypassToken({
      actorId: "admin-1",
      env,
      nowMs,
      request: request(),
    });

    await expect(
      verifyDiagnosticCacheBypass({
        actorId: "admin-1",
        env,
        nowMs: nowMs + 1,
        request: request(undefined, {
          [DIAGNOSTIC_CACHE_BYPASS_HEADER]: token ?? "",
        }),
      }),
    ).resolves.toBe(false);
  });

  it("does not issue a bypass token when the short-lived rate limit rejects it", async () => {
    const { env, reserveCacheBypass } = createEnv(
      vi.fn().mockResolvedValue(true),
      vi.fn().mockResolvedValue(false),
    );

    await expect(
      issueDiagnosticCacheBypassToken({
        actorId: "admin-1",
        env,
        nowMs,
        request: request(),
      }),
    ).resolves.toBeNull();
    expect(reserveCacheBypass).toHaveBeenCalledWith("admin-1", nowMs);
  });

  it("fails closed for missing configuration, malformed token framing, and signatures", async () => {
    const { env } = createEnv();
    const token = await issueDiagnosticCacheBypassToken({
      actorId: "admin-1",
      env,
      nowMs,
      request: request(),
    });
    expect(token).toBeTruthy();

    await expect(
      verifyDiagnosticCacheBypass({
        actorId: undefined,
        env,
        nowMs,
        request: request(),
      }),
    ).resolves.toBe(false);
    await expect(
      verifyDiagnosticCacheBypass({
        actorId: "admin-1",
        env,
        nowMs,
        request: request(),
      }),
    ).resolves.toBe(false);
    await expect(
      verifyDiagnosticCacheBypass({
        actorId: "admin-1",
        env,
        nowMs,
        request: request(undefined, {
          [DIAGNOSTIC_CACHE_BYPASS_HEADER]: "x".repeat(769),
        }),
      }),
    ).resolves.toBe(false);

    for (const malformed of [
      "v2.payload.signature",
      "v1.payload",
      "v1.payload.signature.extra",
      "v1.!invalid.signature",
    ]) {
      await expect(
        verifyDiagnosticCacheBypass({
          actorId: "admin-1",
          env,
          nowMs,
          request: request(undefined, {
            [DIAGNOSTIC_CACHE_BYPASS_HEADER]: malformed,
          }),
        }),
      ).resolves.toBe(false);
    }

    const badSignature = withToken(token!, (parts) => {
      parts[2] = `${parts[2]!.slice(0, -1)}${parts[2]!.endsWith("A") ? "B" : "A"}`;
      return parts;
    });
    await expect(
      verifyDiagnosticCacheBypass({
        actorId: "admin-1",
        env,
        nowMs,
        request: badSignature,
      }),
    ).resolves.toBe(false);

    const invalidSignatureEncoding = withToken(token!, (parts) => {
      parts[2] = "!";
      return parts;
    });
    await expect(
      verifyDiagnosticCacheBypass({
        actorId: "admin-1",
        env,
        nowMs,
        request: invalidSignatureEncoding,
      }),
    ).resolves.toBe(false);

    await expect(
      issueDiagnosticCacheBypassToken({
        actorId: "admin-1",
        env: { DIAGNOSTICS_SAMPLER: undefined } as unknown as Env,
        nowMs,
        request: request(),
      }),
    ).resolves.toBeNull();
    await expect(
      issueDiagnosticCacheBypassToken({
        actorId: "   ",
        env,
        nowMs,
        request: request(),
      }),
    ).resolves.toBeNull();
    await expect(
      issueDiagnosticCacheBypassToken({
        actorId: "admin-1",
        env: { DIAGNOSTICS_SAMPLER: env.DIAGNOSTICS_SAMPLER } as Env,
        nowMs,
        request: request(),
      }),
    ).resolves.toBeNull();
  });

  it("rejects payloads that do not satisfy the signed request schema", async () => {
    const { env } = createEnv();
    const payloads = [
      null,
      "not-an-object",
      {},
      {
        actorId: "admin-1",
        audience: "wrong-audience",
        requestPath: "/api/private/v2/journeys/visitors",
        nonce: "n".repeat(16),
        expiresAtMs: nowMs + 1_000,
      },
      {
        actorId: "admin-1",
        audience: "diagnostics-cache-bypass",
        requestPath: "relative",
        nonce: "n".repeat(16),
        expiresAtMs: nowMs + 1_000,
      },
      {
        actorId: "admin-1",
        audience: "diagnostics-cache-bypass",
        requestPath: "/api/private/v2/journeys/visitors",
        nonce: "short",
        expiresAtMs: nowMs + 1_000,
      },
      {
        actorId: "admin-1",
        audience: "diagnostics-cache-bypass",
        requestPath: "/api/private/v2/journeys/visitors",
        nonce: "n".repeat(16),
        expiresAtMs: "not-a-number",
      },
      {
        actorId: "admin-1",
        audience: "diagnostics-cache-bypass",
        requestPath: "/api/private/v2/journeys/visitors",
        nonce: "n".repeat(16),
        expiresAtMs: nowMs + 1_000,
      },
    ];
    for (const payload of payloads) {
      await expect(
        verifyDiagnosticCacheBypass({
          actorId: "admin-1",
          env,
          nowMs,
          request: request(undefined, {
            [DIAGNOSTIC_CACHE_BYPASS_HEADER]: `v1.${encodePayload(payload)}.signature`,
          }),
        }),
      ).resolves.toBe(false);
    }
  });

  it("canonicalizes duplicate and empty query parameters and bounds token TTL", async () => {
    const { env, reserveCacheBypass } = createEnv();
    vi.spyOn(Date, "now").mockReturnValue(nowMs);
    const noQueryToken = await issueDiagnosticCacheBypassToken({
      actorId: "admin-1",
      env,
      ttlMs: 100,
      request: request("https://app.test/api/private/v2/journeys/visitors"),
    });
    expect(noQueryToken).toBeTruthy();
    const duplicateQueryRequest = request(
      "https://app.test/api/private/v2/journeys/visitors?b=2&a=z&a=a&a=z",
    );
    const duplicateToken = await issueDiagnosticCacheBypassToken({
      actorId: "admin-1",
      env,
      nowMs,
      ttlMs: 120_000,
      request: duplicateQueryRequest,
    });
    expect(duplicateToken).toBeTruthy();
    expect(reserveCacheBypass).toHaveBeenCalledTimes(2);

    await expect(
      verifyDiagnosticCacheBypass({
        actorId: "admin-1",
        env,
        request: withToken(
          duplicateToken!,
          (parts) => parts,
          duplicateQueryRequest.url,
        ),
      }),
    ).resolves.toBe(true);
    await expect(
      verifyDiagnosticCacheBypass({
        actorId: "admin-1",
        env,
        nowMs: nowMs - 60_001,
        request: withToken(
          noQueryToken!,
          (parts) => parts,
          "https://app.test/api/private/v2/journeys/visitors",
        ),
      }),
    ).resolves.toBe(false);
  });
});
