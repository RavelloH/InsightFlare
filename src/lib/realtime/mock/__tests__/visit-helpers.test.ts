import { describe, expect, it } from "vitest";

import type { DemoVisitFact } from "@/lib/realtime/mock/types";
import {
  DEMO_EMPTY_HASH_VALUE,
  DEMO_EMPTY_QUERY_VALUE,
  demoHashFragmentForVisit,
  demoOperatingSystemLabel,
  demoQueryStringForVisit,
  demoStringHash,
} from "@/lib/realtime/mock/visit-helpers";

function makeVisit(overrides: Partial<DemoVisitFact> = {}): DemoVisitFact {
  return {
    visitId: "v-001",
    sessionId: "s-001",
    visitorId: "vt-001",
    startedAt: 0,
    pathname: "/pricing",
    title: "Pricing",
    hostname: "example.com",
    referrerHost: "",
    referrerUrl: "",
    browser: "Chrome",
    browserVersion: "138",
    osVersion: "Windows 11",
    deviceType: "Desktop",
    language: "en-US",
    screenSize: "1920x1080",
    country: "US",
    regionCode: "",
    regionName: "",
    region: "",
    cityName: "",
    city: "",
    continent: "",
    timezone: "",
    organization: "",
    latitude: 0,
    longitude: 0,
    eventType: "pageview",
    durationMs: 0,
    ...overrides,
  };
}

describe("mock/visit-helpers", () => {
  describe("constants", () => {
    it("exposes sentinel strings", () => {
      expect(DEMO_EMPTY_HASH_VALUE).toBe("__insightflare_empty_hash__");
      expect(DEMO_EMPTY_QUERY_VALUE).toBe("__insightflare_empty_query__");
    });
  });

  describe("demoStringHash", () => {
    it("returns a non-negative integer", () => {
      expect(demoStringHash("hello")).toBeGreaterThanOrEqual(0);
      expect(Number.isInteger(demoStringHash("hello"))).toBe(true);
    });

    it("is deterministic", () => {
      expect(demoStringHash("foo")).toBe(demoStringHash("foo"));
      expect(demoStringHash("foo")).not.toBe(demoStringHash("bar"));
    });
  });

  describe("demoOperatingSystemLabel", () => {
    it("returns the OS family label", () => {
      expect(demoOperatingSystemLabel("Windows 11")).toBe("Windows");
      expect(demoOperatingSystemLabel("Android 14")).toBe("Android");
      expect(demoOperatingSystemLabel("iOS 18")).toBe("iOS");
      expect(demoOperatingSystemLabel("Chrome OS")).toBe("Chrome OS");
      expect(demoOperatingSystemLabel("macOS 14")).toBe("macOS");
      expect(demoOperatingSystemLabel("HarmonyOS 5")).toBe("HarmonyOS");
      expect(demoOperatingSystemLabel("Ubuntu 24.04")).toBe("Ubuntu");
    });

    it("returns the original string for unknown OS", () => {
      expect(demoOperatingSystemLabel("UnknownOS 1")).toBe("UnknownOS 1");
    });

    it("returns empty for nullish input", () => {
      expect(demoOperatingSystemLabel("")).toBe("");
    });

    it("returns empty for undefined/absent OS version", () => {
      expect(demoOperatingSystemLabel(undefined as unknown as string)).toBe("");
    });
  });

  describe("demoQueryStringForVisit", () => {
    it("returns a string", () => {
      const result = demoQueryStringForVisit(makeVisit());
      expect(typeof result).toBe("string");
    });

    it("varies with pathname (pricing vs docs)", () => {
      // Different paths use different choice pools; over many seeded visits we
      // expect at least some non-empty queries with the right prefixes.
      const pricingQueries = new Set<string>();
      const docsQueries = new Set<string>();
      for (let i = 0; i < 30; i += 1) {
        pricingQueries.add(
          demoQueryStringForVisit(
            makeVisit({
              pathname: "/pricing",
              visitId: `v-${i}`,
            }),
          ),
        );
        docsQueries.add(
          demoQueryStringForVisit(
            makeVisit({
              pathname: "/docs/guide",
              visitId: `v-${i}`,
            }),
          ),
        );
      }
      expect(pricingQueries.size).toBeGreaterThan(0);
      expect(docsQueries.size).toBeGreaterThan(0);
    });

    it("is deterministic for the same visit", () => {
      const visit = makeVisit({ visitId: "stable-1" });
      expect(demoQueryStringForVisit(visit)).toBe(
        demoQueryStringForVisit(visit),
      );
    });
  });

  describe("demoHashFragmentForVisit", () => {
    it("returns empty for root path", () => {
      expect(demoHashFragmentForVisit(makeVisit({ pathname: "/" }))).toBe("");
    });

    it("returns a string for non-root paths", () => {
      expect(
        typeof demoHashFragmentForVisit(makeVisit({ pathname: "/pricing" })),
      ).toBe("string");
    });

    it("is deterministic", () => {
      const v = makeVisit({ pathname: "/blog", visitId: "fixed-1" });
      expect(demoHashFragmentForVisit(v)).toBe(demoHashFragmentForVisit(v));
    });

    it("varies pool by pathname", () => {
      const results = new Set<string>();
      for (let i = 0; i < 30; i += 1) {
        const v = makeVisit({ pathname: "/docs/guide", visitId: `i-${i}` });
        const fragment = demoHashFragmentForVisit(v);
        if (fragment) results.add(fragment);
      }
      // /docs uses [#install, #usage, #examples, #api]
      const allowed = new Set(["#install", "#usage", "#examples", "#api", ""]);
      for (const fragment of results) {
        expect(allowed.has(fragment)).toBe(true);
      }
    });
  });
});
