import { afterEach, describe, expect, it, vi } from "vitest";

import {
  DIAGNOSTICS_SAMPLER_SHARDS,
  DiagnosticsSampler,
  diagnosticsSamplerDay,
  diagnosticsSamplerName,
  diagnosticsSamplerShard,
  perShardDailySampleLimit,
} from "@/lib/edge/diagnostics-sampler";

const nowMs = Date.UTC(2026, 7, 14, 12, 0, 0);

function samplerWithStorage(initial: Record<string, unknown> = {}) {
  const values = new Map<string, unknown>(Object.entries(initial));
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
    put: vi.fn(
      async (
        keyOrEntries: string | Record<string, unknown>,
        value?: unknown,
      ) => {
        if (typeof keyOrEntries === "string") {
          values.set(keyOrEntries, value);
        } else {
          for (const [key, entry] of Object.entries(keyOrEntries)) {
            values.set(key, entry);
          }
        }
      },
    ),
    setAlarm: vi.fn(async (value: number) => {
      alarmAt = value;
    }),
  };
  const sampler = Object.create(
    DiagnosticsSampler.prototype,
  ) as DiagnosticsSampler;
  Object.defineProperty(sampler, "ctx", { value: { storage } });
  return {
    alarmAt: () => alarmAt,
    sampler,
    storage,
    values,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("DiagnosticsSampler sharding", () => {
  it("derives a stable bounded shard and UTC daily object name", () => {
    const timestamp = Date.UTC(2026, 7, 14, 23, 59, 59);
    const shard = diagnosticsSamplerShard("journey-v2", "detail");

    expect(shard).toBe(diagnosticsSamplerShard("journey-v2", "detail"));
    expect(shard).toBeGreaterThanOrEqual(0);
    expect(shard).toBeLessThan(DIAGNOSTICS_SAMPLER_SHARDS);
    expect(diagnosticsSamplerDay(timestamp)).toBe("2026-08-14");
    expect(diagnosticsSamplerName("journey-v2", "detail", timestamp)).toBe(
      `2026-08-14:${shard}`,
    );
  });

  it("converts a global cap into a hard aggregate shard budget", () => {
    expect(perShardDailySampleLimit(10_000)).toBe(625);
    expect(perShardDailySampleLimit(15)).toBe(0);
    expect(perShardDailySampleLimit(-1)).toBe(0);

    for (const globalLimit of [0, 15, 10_000, 160_000, 1_000_000]) {
      expect(
        perShardDailySampleLimit(globalLimit) * DIAGNOSTICS_SAMPLER_SHARDS,
      ).toBeLessThanOrEqual(globalLimit);
    }
  });

  it("enforces a per-shard quota and exposes health and heartbeat state", async () => {
    vi.spyOn(Date, "now").mockReturnValue(nowMs);
    const empty = samplerWithStorage();
    await expect(empty.sampler.health()).resolves.toEqual({
      acceptedCount: 0,
      lastAcceptedAt: null,
      lastHeartbeatAt: null,
    });

    await expect(empty.sampler.take(16)).resolves.toEqual({
      accepted: true,
      acceptedCount: 1,
      lastAcceptedAt: nowMs,
    });
    await expect(empty.sampler.take(16, nowMs + 1)).resolves.toEqual({
      accepted: false,
      acceptedCount: 1,
      lastAcceptedAt: nowMs,
    });

    await empty.sampler.heartbeat();
    await expect(empty.sampler.health()).resolves.toEqual({
      acceptedCount: 1,
      lastAcceptedAt: nowMs,
      lastHeartbeatAt: nowMs,
    });
  });

  it("validates one-time bypass nonces and schedules the earliest alarm", async () => {
    const { sampler, storage, alarmAt } = samplerWithStorage();
    const nonce = "n".repeat(16);

    await expect(
      sampler.consumeBypassNonce("short", nowMs + 1_000, nowMs),
    ).resolves.toBe(false);
    await expect(
      sampler.consumeBypassNonce(nonce, Number.POSITIVE_INFINITY, nowMs),
    ).resolves.toBe(false);
    await expect(sampler.consumeBypassNonce(nonce, nowMs, nowMs)).resolves.toBe(
      false,
    );

    await expect(
      sampler.consumeBypassNonce(nonce, nowMs + 1_000, nowMs),
    ).resolves.toBe(true);
    expect(alarmAt()).toBe(nowMs + 1_000);
    await expect(
      sampler.consumeBypassNonce(nonce, nowMs + 2_000, nowMs),
    ).resolves.toBe(false);

    const laterNonce = "m".repeat(16);
    await expect(
      sampler.consumeBypassNonce(laterNonce, nowMs + 2_000, nowMs),
    ).resolves.toBe(true);
    expect(storage.setAlarm).toHaveBeenCalledTimes(1);

    await expect(
      sampler.consumeBypassNonce(nonce, nowMs + 3_000, nowMs + 1_500),
    ).resolves.toBe(true);
    expect(storage.get).toHaveBeenCalledWith(`bypass:${nonce}`);
  });

  it("rate-limits cache bypass reservations without retaining actor ids", async () => {
    vi.spyOn(Date, "now").mockReturnValue(nowMs);
    const { sampler, storage, values, alarmAt } = samplerWithStorage();

    await expect(sampler.reserveCacheBypass("   ", nowMs)).resolves.toBe(false);
    await expect(
      sampler.reserveCacheBypass("admin-1", Number.NaN),
    ).resolves.toBe(false);
    await expect(sampler.reserveCacheBypass(" admin-1 ")).resolves.toBe(true);
    const rateKey = [...values.keys()].find((key) =>
      key.startsWith("bypass-rate:"),
    );
    expect(rateKey).toBeDefined();
    expect(rateKey).not.toContain("admin-1");
    expect(alarmAt()).toBe(nowMs + 60_000);

    // A finite, unexpired bucket is reused; an expired or malformed bucket is
    // treated as empty, while a full bucket is rejected without a write.
    await expect(
      sampler.reserveCacheBypass("admin-1", nowMs + 1_000),
    ).resolves.toBe(true);
    values.set(rateKey!, { count: 3, expiresAtMs: nowMs - 1 });
    await expect(
      sampler.reserveCacheBypass("admin-1", nowMs + 2_000),
    ).resolves.toBe(true);
    values.set(rateKey!, { count: Number.NaN, expiresAtMs: nowMs + 60_000 });
    await expect(
      sampler.reserveCacheBypass("admin-1", nowMs + 3_000),
    ).resolves.toBe(true);
    values.set(rateKey!, { count: 20, expiresAtMs: nowMs + 60_000 });
    await expect(
      sampler.reserveCacheBypass("admin-1", nowMs + 4_000),
    ).resolves.toBe(false);
    expect(storage.setAlarm).toHaveBeenCalledTimes(1);
  });

  it("cleans expired sampler entries and keeps the next earliest deadline", async () => {
    const { sampler, storage, values, alarmAt } = samplerWithStorage({
      "bypass:expired": nowMs - 1,
      "bypass:invalid": Number.NaN,
      "bypass:future-late": nowMs + 3_000,
      "bypass:future-later": nowMs + 5_000,
      "bypass-rate:empty": null,
      "bypass-rate:invalid": { count: 1, expiresAtMs: Number.NaN },
      "bypass-rate:expired": { count: 1, expiresAtMs: nowMs - 1 },
      "bypass-rate:future-early": {
        count: 1,
        expiresAtMs: nowMs + 1_000,
      },
      "bypass-rate:future-later": {
        count: 1,
        expiresAtMs: nowMs + 2_000,
      },
    });
    vi.spyOn(Date, "now").mockReturnValue(nowMs);

    await sampler.alarm();
    expect(storage.delete).toHaveBeenCalledWith("bypass:expired");
    expect(storage.delete).toHaveBeenCalledWith("bypass:invalid");
    expect(storage.delete).toHaveBeenCalledWith("bypass-rate:empty");
    expect(storage.delete).toHaveBeenCalledWith("bypass-rate:invalid");
    expect(storage.delete).toHaveBeenCalledWith("bypass-rate:expired");
    expect(alarmAt()).toBe(nowMs + 1_000);

    vi.spyOn(Date, "now").mockReturnValue(nowMs + 6_000);
    await sampler.alarm();
    expect(values.size).toBe(0);
    expect(storage.deleteAlarm).toHaveBeenCalledTimes(1);
  });
});
