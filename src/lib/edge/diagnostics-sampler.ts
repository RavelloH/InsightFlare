import { DurableObject } from "cloudflare:workers";

import type { Env } from "./types";

export const DIAGNOSTICS_SAMPLER_SHARDS = 16;
export const DIAGNOSTICS_HEALTH_SAMPLER_NAME = "health:0";
export const DIAGNOSTICS_CACHE_BYPASS_SAMPLER_NAME = "cache-bypass";
export const MAX_DIAGNOSTIC_CACHE_BYPASSES_PER_MINUTE = 20;
const MAX_PER_SHARD_DAY = 10_000;

export interface DiagnosticsSampleDecision {
  accepted: boolean;
  acceptedCount: number;
  lastAcceptedAt: number | null;
}

export interface DiagnosticsSamplerHealth {
  acceptedCount: number;
  lastAcceptedAt: number | null;
  lastHeartbeatAt: number | null;
}

interface CacheBypassRateBucket {
  count: number;
  expiresAtMs: number;
}

function stableHash(value: string): number {
  let hash = 2_166_136_261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16_777_619);
  }
  return hash >>> 0;
}

export function diagnosticsSamplerDay(nowMs = Date.now()): string {
  return new Date(nowMs).toISOString().slice(0, 10);
}

export function diagnosticsSamplerShard(
  route: string,
  fingerprint: string,
): number {
  return (
    stableHash(`${route}\u0000${fingerprint}`) % DIAGNOSTICS_SAMPLER_SHARDS
  );
}

export function diagnosticsSamplerName(
  route: string,
  fingerprint: string,
  nowMs = Date.now(),
): string {
  return `${diagnosticsSamplerDay(nowMs)}:${diagnosticsSamplerShard(route, fingerprint)}`;
}

export function perShardDailySampleLimit(globalLimit: number): number {
  const normalized = Math.max(0, Math.trunc(globalLimit));
  return Math.min(
    MAX_PER_SHARD_DAY,
    Math.floor(normalized / DIAGNOSTICS_SAMPLER_SHARDS),
  );
}

/**
 * A sharded daily sampler. Callers pick a deterministic day/shard name, so
 * the quota is distributed and no single global object sits on every route.
 */
export class DiagnosticsSampler extends DurableObject<Env> {
  async take(
    globalDailyLimit: number,
    nowMs = Date.now(),
  ): Promise<DiagnosticsSampleDecision> {
    // Accept the global cap at the RPC boundary so a caller cannot
    // accidentally grant that full quota to every deterministic shard.
    const limit = perShardDailySampleLimit(globalDailyLimit);
    const acceptedCount =
      (await this.ctx.storage.get<number>("acceptedCount")) ?? 0;
    const lastAcceptedAt =
      (await this.ctx.storage.get<number>("lastAcceptedAt")) ?? null;
    if (acceptedCount >= limit) {
      return { accepted: false, acceptedCount, lastAcceptedAt };
    }

    const nextCount = acceptedCount + 1;
    await this.ctx.storage.put({
      acceptedCount: nextCount,
      lastAcceptedAt: nowMs,
    });
    return {
      accepted: true,
      acceptedCount: nextCount,
      lastAcceptedAt: nowMs,
    };
  }

  async health(): Promise<DiagnosticsSamplerHealth> {
    return {
      acceptedCount: (await this.ctx.storage.get<number>("acceptedCount")) ?? 0,
      lastAcceptedAt:
        (await this.ctx.storage.get<number>("lastAcceptedAt")) ?? null,
      lastHeartbeatAt:
        (await this.ctx.storage.get<number>("lastHeartbeatAt")) ?? null,
    };
  }

  async heartbeat(nowMs = Date.now()): Promise<void> {
    await this.ctx.storage.put("lastHeartbeatAt", nowMs);
  }

  async consumeBypassNonce(
    nonce: string,
    expiresAtMs: number,
    nowMs = Date.now(),
  ): Promise<boolean> {
    const normalizedNonce = nonce.trim();
    if (
      !/^[A-Za-z0-9_-]{16,96}$/.test(normalizedNonce) ||
      !Number.isFinite(expiresAtMs) ||
      expiresAtMs <= nowMs
    ) {
      return false;
    }
    const key = `bypass:${normalizedNonce}`;
    const seenAt = await this.ctx.storage.get<number>(key);
    if (typeof seenAt === "number" && seenAt >= nowMs) return false;
    await this.ctx.storage.put(key, expiresAtMs);
    const alarmAt = await this.ctx.storage.getAlarm();
    if (!alarmAt || expiresAtMs < alarmAt) {
      await this.ctx.storage.setAlarm(expiresAtMs);
    }
    return true;
  }

  async reserveCacheBypass(
    actorId: string,
    nowMs = Date.now(),
  ): Promise<boolean> {
    const normalizedActor = actorId.trim();
    if (!normalizedActor || !Number.isFinite(nowMs)) return false;
    const bucket = Math.floor(nowMs / 60_000);
    const expiresAtMs = (bucket + 1) * 60_000;
    // Durable Object storage must not retain a raw account identifier merely
    // for a short-lived rate-limit bucket.
    const key = `bypass-rate:${bucket}:${stableHash(normalizedActor).toString(36)}`;
    const previous = await this.ctx.storage.get<CacheBypassRateBucket>(key);
    const count =
      previous &&
      Number.isFinite(previous.count) &&
      Number.isFinite(previous.expiresAtMs) &&
      previous.expiresAtMs > nowMs
        ? previous.count
        : 0;
    if (count >= MAX_DIAGNOSTIC_CACHE_BYPASSES_PER_MINUTE) return false;
    await this.ctx.storage.put(key, { count: count + 1, expiresAtMs });
    const alarmAt = await this.ctx.storage.getAlarm();
    if (!alarmAt || expiresAtMs < alarmAt) {
      await this.ctx.storage.setAlarm(expiresAtMs);
    }
    return true;
  }

  async alarm(): Promise<void> {
    const nowMs = Date.now();
    const [nonceEntries, rateEntries] = await Promise.all([
      this.ctx.storage.list<number>({ prefix: "bypass:" }),
      this.ctx.storage.list<CacheBypassRateBucket>({ prefix: "bypass-rate:" }),
    ]);
    let nextAlarmAt: number | null = null;
    for (const [key, expiresAtMs] of nonceEntries) {
      if (!Number.isFinite(expiresAtMs) || expiresAtMs <= nowMs) {
        await this.ctx.storage.delete(key);
      } else if (nextAlarmAt === null || expiresAtMs < nextAlarmAt) {
        nextAlarmAt = expiresAtMs;
      }
    }
    for (const [key, bucket] of rateEntries) {
      if (
        !bucket ||
        !Number.isFinite(bucket.expiresAtMs) ||
        bucket.expiresAtMs <= nowMs
      ) {
        await this.ctx.storage.delete(key);
      } else if (nextAlarmAt === null || bucket.expiresAtMs < nextAlarmAt) {
        nextAlarmAt = bucket.expiresAtMs;
      }
    }
    if (nextAlarmAt === null) {
      await this.ctx.storage.deleteAlarm();
    } else {
      await this.ctx.storage.setAlarm(nextAlarmAt);
    }
  }
}
