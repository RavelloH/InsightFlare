import { describe, expect, it } from "vitest";

import {
  DIAGNOSTICS_SAMPLER_SHARDS,
  diagnosticsSamplerDay,
  diagnosticsSamplerName,
  diagnosticsSamplerShard,
  perShardDailySampleLimit,
} from "@/lib/edge/diagnostics-sampler";

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
});
