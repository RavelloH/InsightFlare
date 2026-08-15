import { afterEach, describe, expect, it, vi } from "vitest";

import {
  advanceE2eClock,
  appNow,
  e2eClockNow,
  initializeE2eClock,
  setE2eClock,
} from "@/lib/edge/e2e-clock";

const CLOCK_KEY = "__insightflare_e2e_clock__";

afterEach(() => {
  Reflect.deleteProperty(globalThis, CLOCK_KEY);
  vi.restoreAllMocks();
});

describe("E2E clock", () => {
  it("uses system time until the E2E control plane sets a clock", () => {
    vi.spyOn(Date, "now").mockReturnValue(123);
    expect(e2eClockNow()).toBeNull();
    expect(appNow()).toBe(123);
  });

  it("normalizes, reads, and advances the controlled clock", () => {
    expect(setE2eClock(1_000.9)).toBe(1_000);
    expect(e2eClockNow()).toBe(1_000);
    expect(advanceE2eClock(250.9)).toBe(1_250);
    expect(appNow()).toBe(1_250);
  });

  it("ignores malformed global state and rejects invalid control values", () => {
    (globalThis as Record<string, unknown>)[CLOCK_KEY] = { nowMs: -1 };
    vi.spyOn(Date, "now").mockReturnValue(456);
    expect(e2eClockNow()).toBeNull();
    expect(appNow()).toBe(456);
    expect(() => setE2eClock(-1)).toThrow("non-negative");
    expect(() => advanceE2eClock(-1)).toThrow("non-negative");
  });

  it("initializes a newly created E2E isolate from its Worker configuration", () => {
    initializeE2eClock({
      INSIGHTFLARE_E2E: "1",
      INSIGHTFLARE_E2E_NOW: "789.9",
    });
    expect(appNow()).toBe(789);

    initializeE2eClock({
      INSIGHTFLARE_E2E: "1",
      INSIGHTFLARE_E2E_NOW: "456",
    });
    expect(appNow()).toBe(789);
  });

  it("does not enable a configured clock outside E2E", () => {
    initializeE2eClock({
      INSIGHTFLARE_E2E: "0",
      INSIGHTFLARE_E2E_NOW: "789",
    });
    expect(e2eClockNow()).toBeNull();
  });
});
