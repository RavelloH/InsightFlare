import { describe, expect, it } from "vitest";

import { mulberry32 } from "@/lib/demo/generators/utils";
import {
  computeMetrics,
  dailyMetricFactor,
  dailyViewCount,
  demoIntervalStepMs,
  integrateViews,
  sampleTimestampByCurve,
  siteDayIntegral,
  siteHourShapeIntegral,
  siteRatios,
} from "@/lib/demo/realtime/site-curves";
const SITE_ID = "demo-site-001";
describe("mock/site-curves", () => {
  describe("siteHourShapeIntegral", () => {
    it("returns 0 when h1 >= h2", () => {
      expect(siteHourShapeIntegral(5, 5, 8, 10, 0.2)).toBe(0);
      expect(siteHourShapeIntegral(6, 5, 8, 10, 0.2)).toBe(0);
    });

    it("computes a positive integral over a full active window", () => {
      const value = siteHourShapeIntegral(0, 24, 8, 10, 0.2);
      expect(value).toBeGreaterThan(0);
    });

    it("handles midnight-wrapping active zones", () => {
      // riseHour + activeWidth > 24 → segments split across midnight.
      const value = siteHourShapeIntegral(0, 24, 20, 8, 0.1);
      expect(value).toBeGreaterThan(0);
    });

    it("is additive across sub-intervals", () => {
      const full = siteHourShapeIntegral(0, 24, 8, 10, 0.15);
      const left = siteHourShapeIntegral(0, 12, 8, 10, 0.15);
      const right = siteHourShapeIntegral(12, 24, 8, 10, 0.15);
      expect(left + right).toBeCloseTo(full, 6);
    });
  });

  describe("siteDayIntegral", () => {
    it("returns a positive cached value", () => {
      const a = siteDayIntegral(SITE_ID);
      const b = siteDayIntegral(SITE_ID);
      expect(a).toBe(b);
      expect(a).toBeGreaterThan(0);
    });
  });

  describe("dailyViewCount", () => {
    it("returns a positive integer", () => {
      const value = dailyViewCount(SITE_ID, 0);
      expect(Number.isInteger(value)).toBe(true);
      expect(value).toBeGreaterThan(0);
    });

    it("is deterministic per (site, day)", () => {
      expect(dailyViewCount(SITE_ID, 1)).toBe(dailyViewCount(SITE_ID, 1));
    });

    it("applies the weekend factor on Sat/Sun", () => {
      // Day 0 = Thursday. Day 2 = Saturday, day 3 = Sunday.
      const weekday = dailyViewCount(SITE_ID, 0);
      const weekendSat = dailyViewCount(SITE_ID, 2);
      const weekendSun = dailyViewCount(SITE_ID, 3);
      expect(weekday).toBeGreaterThan(0);
      expect(weekendSat).toBeGreaterThan(0);
      expect(weekendSun).toBeGreaterThan(0);
    });
  });

  describe("integrateViews", () => {
    it("returns 0 for inverted/empty windows", () => {
      expect(integrateViews(SITE_ID, 100, 100)).toBe(0);
      expect(integrateViews(SITE_ID, 200, 100)).toBe(0);
    });

    it("returns a positive count for a non-empty window", () => {
      const hourMs = 3_600_000;
      const day = 86_400_000;
      const value = integrateViews(SITE_ID, day, day + 6 * hourMs);
      expect(value).toBeGreaterThan(0);
    });

    it("is additive across consecutive sub-windows", () => {
      const day = 86_400_000;
      const full = integrateViews(SITE_ID, day, 2 * day);
      const half1 = integrateViews(SITE_ID, day, day + 12 * 3_600_000);
      const half2 = integrateViews(SITE_ID, day + 12 * 3_600_000, 2 * day);
      // Rounding may give a 1-2 difference but should still be close.
      expect(Math.abs(full - (half1 + half2))).toBeLessThanOrEqual(2);
    });
  });

  describe("siteRatios", () => {
    it("returns deterministic, reasonable ratios", () => {
      const a = siteRatios(SITE_ID);
      const b = siteRatios(SITE_ID);
      expect(a).toBe(b);
      expect(a.sessionsPerView).toBeGreaterThan(0);
      expect(a.sessionsPerView).toBeLessThan(1);
      expect(a.visitorsPerSession).toBeGreaterThan(0);
      expect(a.bounceRate).toBeGreaterThan(0);
      expect(a.avgDurationMs).toBeGreaterThan(0);
    });
  });

  describe("dailyMetricFactor", () => {
    it("returns 1 for unknown metric", () => {
      expect(dailyMetricFactor(SITE_ID, 0, "unknown")).toBe(1);
    });

    it("returns factors in reasonable ranges for known metrics", () => {
      const sessions = dailyMetricFactor(SITE_ID, 5, "sessions");
      const visitors = dailyMetricFactor(SITE_ID, 5, "visitors");
      const bounce = dailyMetricFactor(SITE_ID, 5, "bounce");
      const duration = dailyMetricFactor(SITE_ID, 5, "duration");
      expect(sessions).toBeGreaterThanOrEqual(0.88);
      expect(sessions).toBeLessThanOrEqual(1.12);
      expect(visitors).toBeGreaterThanOrEqual(0.9);
      expect(visitors).toBeLessThanOrEqual(1.1);
      expect(bounce).toBeGreaterThanOrEqual(0.78);
      expect(bounce).toBeLessThanOrEqual(1.22);
      expect(duration).toBeGreaterThanOrEqual(0.65);
      expect(duration).toBeLessThanOrEqual(1.35);
    });
  });

  describe("computeMetrics", () => {
    it("returns zeros for empty window", () => {
      const result = computeMetrics(SITE_ID, 100, 100);
      expect(result.views).toBe(0);
      expect(result.sessions).toBe(0);
      expect(result.visitors).toBe(0);
      expect(result.bounces).toBe(0);
      expect(result.bounceRate).toBe(0);
    });

    it("returns positive metrics for a typical day window", () => {
      const day = 86_400_000;
      const m = computeMetrics(SITE_ID, day, 2 * day);
      expect(m.views).toBeGreaterThan(0);
      expect(m.sessions).toBeGreaterThan(0);
      expect(m.visitors).toBeGreaterThan(0);
      expect(m.bounces).toBeLessThanOrEqual(m.sessions);
      expect(m.bounceRate).toBeGreaterThanOrEqual(0);
      expect(m.bounceRate).toBeLessThanOrEqual(1);
      expect(m.avgDurationMs).toBeGreaterThan(0);
      expect(m.approximateVisitors).toBe(false);
    });
  });

  describe("demoIntervalStepMs", () => {
    it("returns the expected step for each interval", () => {
      expect(demoIntervalStepMs("minute")).toBe(60_000);
      expect(demoIntervalStepMs("hour")).toBe(3_600_000);
      expect(demoIntervalStepMs("day")).toBe(86_400_000);
      expect(demoIntervalStepMs("week")).toBe(7 * 86_400_000);
      expect(demoIntervalStepMs("month")).toBe(30 * 86_400_000);
    });

    it("falls back to day for unknown intervals", () => {
      expect(demoIntervalStepMs("unknown")).toBe(86_400_000);
    });
  });

  describe("sampleTimestampByCurve", () => {
    it("returns `from` for inverted windows", () => {
      expect(sampleTimestampByCurve(SITE_ID, 200, 100, mulberry32(1))).toBe(
        200,
      );
    });

    it("returns `from` for non-finite endpoints", () => {
      expect(
        sampleTimestampByCurve(SITE_ID, Number.NaN, 100, mulberry32(1)),
      ).toBeNaN();
      expect(
        sampleTimestampByCurve(
          SITE_ID,
          100,
          Number.POSITIVE_INFINITY,
          mulberry32(1),
        ),
      ).toBe(100);
    });

    it("returns a timestamp inside [from, to)", () => {
      const day = 86_400_000;
      const r = mulberry32(7);
      for (let i = 0; i < 20; i += 1) {
        const t = sampleTimestampByCurve(SITE_ID, day, 2 * day, r);
        expect(t).toBeGreaterThanOrEqual(day);
        expect(t).toBeLessThan(2 * day);
      }
    });

    it("works with very small windows (fewer buckets)", () => {
      const r = mulberry32(9);
      const result = sampleTimestampByCurve(SITE_ID, 1000, 2000, r);
      expect(result).toBeGreaterThanOrEqual(1000);
      expect(result).toBeLessThan(2000);
    });
  });
});
