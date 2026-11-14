export const FIXTURE_START_MS = Date.UTC(2026, 6, 1);
export const FIXTURE_DAY_MS = 24 * 60 * 60 * 1000;

export function fixtureDay(index: number): number {
  return FIXTURE_START_MS + index * FIXTURE_DAY_MS;
}

export function fixtureWave(
  index: number,
  base: number,
  amplitude: number,
  phase = 0,
): number {
  const wave = Math.sin((index + phase) * 0.9) * amplitude;
  const drift = index * (amplitude / 10);
  return Math.max(0, Math.round(base + wave + drift));
}

export function formatFixtureCount(value: number): string {
  return new Intl.NumberFormat("en-US").format(Math.round(value));
}
