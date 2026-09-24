import { describe, expect, it } from "vitest";

import {
  DEMO_SITE_PROFILES,
  type DemoSiteProfile,
} from "@/lib/demo/data/site-profiles";
import {
  getVisitorFingerprint,
  getVisitorReturnRate,
  getVisitorUniverseSize,
  sampleActiveVisitors,
  visitorIdFromIndex,
  visitorIndexFromId,
} from "@/lib/demo/realtime/visitor-pool";
const SITE_ID = "demo-site-001";
describe("mock/visitor-pool", () => {
  describe("getVisitorUniverseSize", () => {
    it("returns a cached, positive integer in a reasonable range", () => {
      const a = getVisitorUniverseSize(SITE_ID);
      const b = getVisitorUniverseSize(SITE_ID);
      expect(a).toBe(b);
      expect(a).toBeGreaterThanOrEqual(800);
      expect(a).toBeLessThanOrEqual(50_000);
    });
  });

  describe("getVisitorReturnRate", () => {
    it("clamps to [0.02, 0.85]", () => {
      const rate = getVisitorReturnRate(SITE_ID);
      expect(rate).toBeGreaterThanOrEqual(0.02);
      expect(rate).toBeLessThanOrEqual(0.85);
    });

    it("falls back to the default return rate for missing profile values", () => {
      const profile: DemoSiteProfile = {
        ...DEMO_SITE_PROFILES[0],
        id: "missing-return-rate-site",
        visitorReturnRate: undefined,
      };
      DEMO_SITE_PROFILES.push(profile);

      try {
        expect(getVisitorReturnRate(profile.id)).toBe(0.25);
      } finally {
        DEMO_SITE_PROFILES.pop();
      }
    });
  });

  describe("visitorIdFromIndex / visitorIndexFromId", () => {
    it("round-trips an index", () => {
      const id = visitorIdFromIndex(SITE_ID, 42);
      expect(id).toMatch(/^v-/);
      expect(visitorIndexFromId(id)).toBe(42);
    });

    it("clamps negative indices to 0", () => {
      expect(visitorIdFromIndex(SITE_ID, -5)).toBe(
        visitorIdFromIndex(SITE_ID, 0),
      );
    });

    it("floors fractional indices", () => {
      expect(visitorIdFromIndex(SITE_ID, 7.9)).toBe(
        visitorIdFromIndex(SITE_ID, 7),
      );
    });

    it("returns NaN for IDs without a trailing index suffix", () => {
      expect(visitorIndexFromId("malformed")).toBeNaN();
      expect(visitorIndexFromId("")).toBeNaN();
    });
  });

  describe("getVisitorFingerprint", () => {
    it("returns a stable fingerprint per visitor", () => {
      const a = getVisitorFingerprint(SITE_ID, "v-001-000042");
      const b = getVisitorFingerprint(SITE_ID, "v-001-000042");
      expect(a).toBe(b);
      expect(a.country).toBeTruthy();
      expect(a.browser).toBeTruthy();
      expect(a.osVersion).toBeTruthy();
      expect(a.deviceType).toBeTruthy();
      expect(a.language).toBeTruthy();
      expect(a.screenSize).toBeTruthy();
      expect(Number.isFinite(a.latitude)).toBe(true);
      expect(Number.isFinite(a.longitude)).toBe(true);
    });

    it("returns different fingerprints for different visitor IDs (most of the time)", () => {
      const fingerprints = new Set<string>();
      for (let i = 0; i < 20; i += 1) {
        const fp = getVisitorFingerprint(
          SITE_ID,
          `v-001-${i.toString(36).padStart(6, "0")}`,
        );
        fingerprints.add(`${fp.country}|${fp.browser}|${fp.osVersion}`);
      }
      // At minimum, more than one distinct fingerprint across 20 visitors.
      expect(fingerprints.size).toBeGreaterThan(1);
    });
  });

  describe("sampleActiveVisitors", () => {
    it("returns at most `count` unique visitor IDs", () => {
      const ids = sampleActiveVisitors(SITE_ID, 0, 86_400_000, 200);
      expect(ids.length).toBeLessThanOrEqual(200);
      expect(new Set(ids).size).toBe(ids.length);
    });

    it("returns the entire universe when count >= universeSize", () => {
      const universeSize = getVisitorUniverseSize(SITE_ID);
      const ids = sampleActiveVisitors(SITE_ID, 0, 1, universeSize + 100);
      expect(ids.length).toBe(universeSize);
      expect(new Set(ids).size).toBe(universeSize);
    });

    it("clamps count to at least 1", () => {
      const ids = sampleActiveVisitors(SITE_ID, 0, 86_400_000, 0);
      expect(ids.length).toBeGreaterThanOrEqual(1);
    });

    it("returns a non-empty set for typical windows", () => {
      const ids = sampleActiveVisitors(SITE_ID, 0, 86_400_000, 50);
      expect(ids.length).toBeGreaterThan(0);
      for (const id of ids) {
        expect(id).toMatch(/^v-/);
      }
    });
  });
});
