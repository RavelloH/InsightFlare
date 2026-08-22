import { describe, expect, it, vi } from "vitest";

import { mulberry32 } from "@/lib/realtime/demo-utils";
import {
  buildTimestampCurveDistribution,
  createTimestampCurveSampler,
  sampleTimestampByCurve,
} from "@/lib/realtime/mock/site-curves";

const SITE_ID = "demo-site-001";
const DAY_MS = 86_400_000;

describe("timestamp curve sampler", () => {
  it("builds one reusable distribution and preserves direct-call results", () => {
    const from = DAY_MS;
    const to = 2 * DAY_MS;
    const distribution = buildTimestampCurveDistribution(SITE_ID, from, to);
    expect(distribution).not.toBeNull();
    expect(distribution?.cumulative).toHaveLength(144);
    expect(distribution?.totalWeight).toBeGreaterThan(0);

    const sampler = createTimestampCurveSampler(SITE_ID, from, to);
    const directRng = mulberry32(1234);
    const samplerRng = mulberry32(1234);
    for (let index = 0; index < 20; index += 1) {
      expect(sampler(samplerRng)).toBe(
        sampleTimestampByCurve(SITE_ID, from, to, directRng),
      );
    }
  });

  it("keeps samples inside short and fractional windows", () => {
    const sampler = createTimestampCurveSampler(SITE_ID, 100.25, 100.75);
    const rng = mulberry32(99);
    for (let index = 0; index < 20; index += 1) {
      const value = sampler(rng);
      expect(value).toBeGreaterThanOrEqual(100.25);
      expect(value).toBeLessThan(100.75);
    }

    expect(sampleTimestampByCurve(SITE_ID, 1000, 1001, () => 1)).toBe(1000);
  });

  it("handles epoch-to-now windows without multiplying day work by buckets", () => {
    const distribution = buildTimestampCurveDistribution(
      SITE_ID,
      1,
      Date.now(),
    );

    expect(distribution?.cumulative).toHaveLength(256);
    expect(distribution?.totalWeight).toBeGreaterThan(0);
  });

  it("retains invalid-window behavior without consuming the RNG", () => {
    const rng = vi.fn(() => 0.5);
    expect(createTimestampCurveSampler(SITE_ID, 200, 100)(rng)).toBe(200);
    expect(rng).not.toHaveBeenCalled();
    expect(
      createTimestampCurveSampler(SITE_ID, Number.NaN, 100)(rng),
    ).toBeNaN();
  });
});
