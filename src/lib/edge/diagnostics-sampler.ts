import { DurableObject } from "cloudflare:workers";

import type { Env } from "./types";

export const DIAGNOSTICS_SAMPLER_SHARDS = 16;
export const DIAGNOSTICS_HEALTH_SAMPLER_NAME = "health:0";
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
}
