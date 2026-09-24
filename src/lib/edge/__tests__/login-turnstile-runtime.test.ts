import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  clearLoginTurnstileRuntimeCache,
  readLoginTurnstileRuntimeConfig,
  readPublicLoginTurnstileRuntimeConfig,
  writeLoginTurnstileRuntimeConfig,
} from "@/lib/edge/auth/login-turnstile-runtime";
import type { Env } from "@/lib/edge/types";
function kv(raw: string | null = null) {
  return {
    get: vi.fn().mockResolvedValue(raw),
    put: vi.fn().mockResolvedValue(undefined),
    delete: vi.fn().mockResolvedValue(undefined),
  };
}
function env(kvNamespace?: ReturnType<typeof kv>, extras: Partial<Env> = {}) {
  return {
    DB: {} as D1Database,
    INGEST_DO: {} as DurableObjectNamespace,
    SITE_SETTINGS_KV: kvNamespace as unknown as KVNamespace,
    ...extras,
  } as Env;
}
describe("login Turnstile runtime", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearLoginTurnstileRuntimeCache();
    delete process.env.INSIGHTFLARE_LOGIN_TURNSTILE_DISABLED;
  });

  it("returns null for missing KV binding, misses, and invalid JSON", async () => {
    await expect(readLoginTurnstileRuntimeConfig(env())).resolves.toBe(null);

    const emptyKv = kv(null);
    await expect(readLoginTurnstileRuntimeConfig(env(emptyKv))).resolves.toBe(
      null,
    );

    clearLoginTurnstileRuntimeCache();
    const invalidKv = kv("{");
    await expect(readLoginTurnstileRuntimeConfig(env(invalidKv))).resolves.toBe(
      null,
    );
  });

  it("returns valid runtime config and caches KV reads", async () => {
    const store = kv(
      JSON.stringify({
        enabled: true,
        siteKey: "0xsite",
        mode: "invisible",
        secretKeyEncrypted: "encrypted",
        updatedAt: 123,
      }),
    );
    const testEnv = env(store);

    await expect(readLoginTurnstileRuntimeConfig(testEnv)).resolves.toEqual({
      enabled: true,
      siteKey: "0xsite",
      mode: "invisible",
      secretKeyEncrypted: "encrypted",
      updatedAt: 123,
    });
    await readLoginTurnstileRuntimeConfig(testEnv);
    expect(store.get).toHaveBeenCalledTimes(1);
  });

  it("emergency disable overrides KV runtime config", async () => {
    const store = kv(
      JSON.stringify({
        enabled: true,
        siteKey: "0xsite",
        secretKeyEncrypted: "encrypted",
      }),
    );
    const testEnv = env(store, {
      INSIGHTFLARE_LOGIN_TURNSTILE_DISABLED: "1",
    });

    await expect(
      readPublicLoginTurnstileRuntimeConfig(testEnv),
    ).resolves.toEqual({
      enabled: false,
      siteKey: "",
      mode: "invisible",
    });
    expect(store.get).not.toHaveBeenCalled();
  });

  it("writes and deletes KV snapshots and clears cache", async () => {
    const store = kv(null);
    const testEnv = env(store);

    await writeLoginTurnstileRuntimeConfig(testEnv, {
      enabled: true,
      siteKey: "0xsite",
      mode: "invisible",
      secretKeyEncrypted: "encrypted",
      updatedAt: 1,
    });
    expect(store.put).toHaveBeenCalledWith(
      "system:login-turnstile:runtime",
      expect.stringContaining("encrypted"),
    );

    await writeLoginTurnstileRuntimeConfig(testEnv, null);
    expect(store.delete).toHaveBeenCalledWith("system:login-turnstile:runtime");
  });

  it("fails fast on admin writes without KV binding", async () => {
    await expect(writeLoginTurnstileRuntimeConfig(env(), null)).rejects.toThrow(
      "login_turnstile_kv_missing",
    );
  });
});
