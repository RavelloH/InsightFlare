/**
 * Process-local clock used only after the guarded E2E control endpoint enables
 * it. Production never writes this state, so its default is the system clock.
 */
type E2eClockState = { nowMs: number };

const CLOCK_KEY = "__insightflare_e2e_clock__";

type E2eClockEnv = {
  INSIGHTFLARE_E2E?: string;
  INSIGHTFLARE_E2E_NOW?: string;
};

function globalState(): E2eClockState | null {
  const value = (globalThis as Record<string, unknown>)[CLOCK_KEY];
  if (!value || typeof value !== "object") return null;
  const nowMs = Number((value as { nowMs?: unknown }).nowMs);
  return Number.isFinite(nowMs) && nowMs >= 0 ? { nowMs } : null;
}

export function appNow(): number {
  return globalState()?.nowMs ?? Date.now();
}

export function e2eClockNow(): number | null {
  return globalState()?.nowMs ?? null;
}

export function initializeE2eClock(env: E2eClockEnv): void {
  if (env.INSIGHTFLARE_E2E !== "1" || globalState()) return;
  const nowMs = Number(env.INSIGHTFLARE_E2E_NOW);
  if (Number.isFinite(nowMs) && nowMs >= 0) setE2eClock(nowMs);
}

export function setE2eClock(nowMs: number): number {
  if (!Number.isFinite(nowMs) || nowMs < 0) {
    throw new Error("E2E clock must be a non-negative timestamp.");
  }
  const normalized = Math.floor(nowMs);
  (globalThis as Record<string, unknown>)[CLOCK_KEY] = { nowMs: normalized };
  return normalized;
}

export function advanceE2eClock(deltaMs: number): number {
  if (!Number.isFinite(deltaMs) || deltaMs < 0) {
    throw new Error("E2E clock advance must be a non-negative duration.");
  }
  return setE2eClock(appNow() + Math.floor(deltaMs));
}
