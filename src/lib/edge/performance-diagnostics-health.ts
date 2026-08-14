import { DIAGNOSTICS_HEALTH_SAMPLER_NAME } from "./diagnostics-sampler";
import type { Env } from "./types";

export const DIAGNOSTIC_HEALTH_MAX_AGE_MS = 10 * 60 * 1000;

export interface PerformanceDiagnosticsHealth {
  available: boolean;
  fresh: boolean;
  lastHeartbeatAt: number | null;
}

export async function heartbeatPerformanceDiagnostics(
  env: Env,
): Promise<boolean> {
  const sampler = env.DIAGNOSTICS_SAMPLER;
  if (!sampler) return false;
  try {
    await sampler.getByName(DIAGNOSTICS_HEALTH_SAMPLER_NAME).heartbeat();
    return true;
  } catch {
    console.warn(
      JSON.stringify({ event: "performance_diagnostics_heartbeat_failed" }),
    );
    return false;
  }
}

export async function readPerformanceDiagnosticsHealth(
  env: Env,
  nowMs = Date.now(),
): Promise<PerformanceDiagnosticsHealth> {
  const sampler = env.DIAGNOSTICS_SAMPLER;
  if (!sampler) {
    return { available: false, fresh: false, lastHeartbeatAt: null };
  }
  try {
    const health = await sampler
      .getByName(DIAGNOSTICS_HEALTH_SAMPLER_NAME)
      .health();
    const lastHeartbeatAt = health.lastHeartbeatAt;
    const fresh =
      typeof lastHeartbeatAt === "number" &&
      Number.isFinite(lastHeartbeatAt) &&
      nowMs - lastHeartbeatAt >= 0 &&
      nowMs - lastHeartbeatAt <= DIAGNOSTIC_HEALTH_MAX_AGE_MS;
    return { available: true, fresh, lastHeartbeatAt: lastHeartbeatAt ?? null };
  } catch {
    return { available: false, fresh: false, lastHeartbeatAt: null };
  }
}
