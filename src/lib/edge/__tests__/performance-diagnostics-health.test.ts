import { describe, expect, it, vi } from "vitest";

import {
  DIAGNOSTIC_HEALTH_MAX_AGE_MS,
  heartbeatPerformanceDiagnostics,
  readPerformanceDiagnosticsHealth,
} from "@/lib/edge/performance-diagnostics-health";

describe("performance diagnostics health", () => {
  it("writes and reads the dedicated sampler heartbeat", async () => {
    const heartbeat = vi.fn().mockResolvedValue(undefined);
    const health = vi
      .fn()
      .mockResolvedValue({ lastHeartbeatAt: 1_000, acceptedCount: 0 });
    const env = {
      DIAGNOSTICS_SAMPLER: {
        getByName: vi.fn(() => ({ heartbeat, health })),
      },
    } as never;

    await expect(heartbeatPerformanceDiagnostics(env)).resolves.toBe(true);
    await expect(readPerformanceDiagnosticsHealth(env, 1_001)).resolves.toEqual(
      {
        available: true,
        fresh: true,
        lastHeartbeatAt: 1_000,
      },
    );
    expect(heartbeat).toHaveBeenCalledTimes(1);
  });

  it("fails closed for missing, stale, and unavailable sampler health", async () => {
    await expect(
      readPerformanceDiagnosticsHealth({} as never),
    ).resolves.toEqual({
      available: false,
      fresh: false,
      lastHeartbeatAt: null,
    });
    const staleEnv = {
      DIAGNOSTICS_SAMPLER: {
        getByName: vi.fn(() => ({
          health: vi.fn().mockResolvedValue({ lastHeartbeatAt: 0 }),
        })),
      },
    } as never;
    await expect(
      readPerformanceDiagnosticsHealth(
        staleEnv,
        DIAGNOSTIC_HEALTH_MAX_AGE_MS + 1,
      ),
    ).resolves.toMatchObject({ available: true, fresh: false });

    const unavailableEnv = {
      DIAGNOSTICS_SAMPLER: {
        getByName: vi.fn(() => ({
          health: vi.fn().mockRejectedValue(new Error("sampler unavailable")),
        })),
      },
    } as never;
    await expect(
      readPerformanceDiagnosticsHealth(unavailableEnv),
    ).resolves.toEqual({
      available: false,
      fresh: false,
      lastHeartbeatAt: null,
    });
  });

  it("swallows a heartbeat failure so scheduled work stays best-effort", async () => {
    const warning = vi
      .spyOn(console, "warn")
      .mockImplementation(() => undefined);
    const env = {
      DIAGNOSTICS_SAMPLER: {
        getByName: vi.fn(() => ({
          heartbeat: vi.fn().mockRejectedValue(new Error("DO unavailable")),
        })),
      },
    } as never;

    await expect(heartbeatPerformanceDiagnostics(env)).resolves.toBe(false);
    expect(warning).toHaveBeenCalledWith(
      JSON.stringify({ event: "performance_diagnostics_heartbeat_failed" }),
    );
  });
});
