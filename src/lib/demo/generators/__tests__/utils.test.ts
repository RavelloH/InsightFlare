import { describe, expect, it } from "vitest";

import {
  createDemoRng,
  expandPathLabels,
  fnv1a,
  humanizeSlug,
  mulberry32,
  normalizePath,
  sFloat,
  sInt,
  sPick,
  sShuffle,
  titleFromPath,
  todayKey,
  uniqueNonEmptyStrings,
  weightedDistribution,
  weightedDistributionFromWeights,
  weightedPickLabel,
  windowBucket,
} from "@/lib/demo/generators/utils";
const seededRng = (seed = 42) => mulberry32(seed);
describe("demo-utils", () => {
  describe("fnv1a", () => {
    it("returns a stable 32-bit unsigned hash", () => {
      const a = fnv1a("hello");
      const b = fnv1a("hello");
      expect(a).toBe(b);
      expect(a).toBeGreaterThanOrEqual(0);
      expect(a).toBeLessThan(2 ** 32);
    });

    it("differs for different inputs", () => {
      expect(fnv1a("a")).not.toBe(fnv1a("b"));
    });

    it("handles empty string with the FNV-1a offset basis", () => {
      expect(fnv1a("")).toBe(0x811c9dc5);
    });
  });

  describe("mulberry32", () => {
    it("yields values in [0, 1) and is deterministic for the same seed", () => {
      const a = mulberry32(123);
      const b = mulberry32(123);
      for (let i = 0; i < 5; i += 1) {
        const x = a();
        const y = b();
        expect(x).toBe(y);
        expect(x).toBeGreaterThanOrEqual(0);
        expect(x).toBeLessThan(1);
      }
    });
  });

  describe("todayKey", () => {
    it("returns YYYY-MM-DD format", () => {
      expect(todayKey()).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    });
  });

  describe("createDemoRng", () => {
    it("produces deterministic streams for the same site+endpoint", () => {
      const a = createDemoRng("site-1", "facts:0:0");
      const b = createDemoRng("site-1", "facts:0:0");
      expect(a()).toBe(b());
    });
  });

  describe("windowBucket", () => {
    it("rounds to minute boundaries", () => {
      const minute = 60_000;
      expect(windowBucket(minute, minute * 5)).toBe("1:5");
      expect(windowBucket(minute + 1000, minute * 5 - 999)).toBe("1:4");
    });
  });

  describe("sInt / sFloat / sPick", () => {
    it("sInt returns an integer in [min, max]", () => {
      const rng = seededRng(1);
      for (let i = 0; i < 20; i += 1) {
        const v = sInt(rng, 3, 7);
        expect(Number.isInteger(v)).toBe(true);
        expect(v).toBeGreaterThanOrEqual(3);
        expect(v).toBeLessThanOrEqual(7);
      }
    });

    it("sFloat returns a number in [min, max)", () => {
      const rng = seededRng(2);
      for (let i = 0; i < 20; i += 1) {
        const v = sFloat(rng, 1, 2);
        expect(v).toBeGreaterThanOrEqual(1);
        expect(v).toBeLessThan(2);
      }
    });

    it("sPick selects from the array", () => {
      const rng = seededRng(3);
      const arr = ["a", "b", "c"] as const;
      for (let i = 0; i < 10; i += 1) {
        expect(arr).toContain(sPick(rng, arr));
      }
    });
  });

  describe("sShuffle", () => {
    it("returns a permutation of the input without mutating it", () => {
      const rng = seededRng(4);
      const original = [1, 2, 3, 4, 5];
      const copy = [...original];
      const shuffled = sShuffle(rng, copy);
      expect(copy).toEqual(original);
      expect(shuffled.sort()).toEqual(original);
    });
  });

  describe("weightedDistribution", () => {
    it("returns at most `count` distinct labels", () => {
      const rng = seededRng(5);
      const result = weightedDistribution(rng, ["a", "b", "c"], 100, 5);
      expect(result.length).toBeLessThanOrEqual(3);
      const labels = new Set(result.map((r) => r.label));
      expect(labels.size).toBe(result.length);
      for (const row of result) {
        expect(row.views).toBeGreaterThan(0);
        expect(row.sessions).toBeGreaterThan(0);
      }
    });
  });

  describe("weightedPickLabel", () => {
    it("falls back when there are no positive weights", () => {
      const rng = seededRng(6);
      expect(
        weightedPickLabel(
          rng,
          [
            { label: "", weight: 1 },
            { label: "x", weight: 0 },
          ],
          "fallback",
        ),
      ).toBe("fallback");
      expect(weightedPickLabel(rng, [], "fallback")).toBe("fallback");
    });

    it("returns one of the entries when weights are present", () => {
      const rng = seededRng(7);
      const picks = new Set<string>();
      for (let i = 0; i < 25; i += 1) {
        picks.add(
          weightedPickLabel(
            rng,
            [
              { label: "a", weight: 1 },
              { label: "b", weight: 1 },
            ],
            "z",
          ),
        );
      }
      expect(picks.has("a") || picks.has("b")).toBe(true);
      expect(picks.has("z")).toBe(false);
    });

    it("coerces non-numeric weights to zero", () => {
      const rng = seededRng(8);
      expect(
        weightedPickLabel(
          rng,
          [
            { label: "x", weight: Number.NaN },
            { label: "y", weight: 1 },
          ],
          "fallback",
        ),
      ).toBe("y");
    });

    it("falls back to the final normalized entry if rng overshoots", () => {
      expect(
        weightedPickLabel(
          () => 2,
          [
            { label: "first", weight: 1 },
            { label: "last", weight: 1 },
          ],
          "fallback",
        ),
      ).toBe("last");
    });
  });

  describe("weightedDistributionFromWeights", () => {
    it("returns an empty array when no valid entries exist", () => {
      const rng = seededRng(9);
      expect(
        weightedDistributionFromWeights(
          rng,
          [{ label: "", weight: 0 }],
          100,
          5,
        ),
      ).toEqual([]);
    });

    it("merges duplicate labels and respects the count cap", () => {
      const rng = seededRng(10);
      const result = weightedDistributionFromWeights(
        rng,
        [
          { label: "a", weight: 5 },
          { label: "a", weight: 5 },
          { label: "b", weight: 1 },
        ],
        100,
        5,
      );
      expect(result.length).toBe(2);
      expect(result[0].label).toBe("a");
    });

    it("clamps sessions to never exceed views and at least 1", () => {
      const rng = seededRng(11);
      const result = weightedDistributionFromWeights(
        rng,
        [
          { label: "x", weight: 1 },
          { label: "y", weight: 1 },
        ],
        50,
        2,
      );
      for (const row of result) {
        expect(row.sessions).toBeGreaterThan(0);
        expect(row.sessions).toBeLessThanOrEqual(row.views);
      }
    });
  });

  describe("uniqueNonEmptyStrings", () => {
    it("dedupes, trims, and drops empties", () => {
      expect(
        uniqueNonEmptyStrings(["a", " a ", "", "b", "b", "  ", "c"]),
      ).toEqual(["a", "b", "c"]);
    });
  });

  describe("normalizePath", () => {
    it("collapses repeated slashes and removes trailing slashes", () => {
      expect(normalizePath("/foo//bar/")).toBe("/foo/bar");
      expect(normalizePath("/foo")).toBe("/foo");
      expect(normalizePath("/")).toBe("/");
    });

    it("returns empty string for non-rooted paths", () => {
      expect(normalizePath("foo")).toBe("");
      expect(normalizePath("")).toBe("");
    });
  });

  describe("humanizeSlug", () => {
    it("capitalizes words and removes version markers", () => {
      expect(humanizeSlug("getting-started")).toBe("Getting Started");
      expect(humanizeSlug("api_v2_reference")).toBe("Api Reference");
      expect(humanizeSlug("")).toBe("Page");
    });
  });

  describe("titleFromPath", () => {
    it("returns Home for `/`", () => {
      expect(titleFromPath("/")).toBe("Home");
    });

    it("derives a title from the final segment", () => {
      expect(titleFromPath("/blog/release-notes")).toBe("Release Notes");
      expect(titleFromPath("/pricing")).toBe("Pricing");
    });
  });

  describe("expandPathLabels", () => {
    it("returns at least `desiredCount` paths when feasible", () => {
      const rng = seededRng(12);
      const result = expandPathLabels(rng, ["/blog", "/pricing", "/docs"], 30);
      expect(result.length).toBeGreaterThanOrEqual(30);
      expect(new Set(result).size).toBe(result.length);
    });

    it("uses /home when no base paths are provided", () => {
      const rng = seededRng(13);
      const result = expandPathLabels(rng, ["/"], 10);
      expect(result.length).toBeGreaterThanOrEqual(1);
    });

    it("normalizes input paths", () => {
      const rng = seededRng(14);
      const result = expandPathLabels(rng, ["/foo//bar/"], 5);
      expect(result).toContain("/foo/bar");
    });

    it("generates dynamic variants when the curated pools are not enough", () => {
      const rng = seededRng(15);
      const result = expandPathLabels(
        rng,
        ["/products/widget", "/courses/analytics"],
        80,
      );

      expect(result).toHaveLength(80);
      expect(new Set(result).size).toBe(result.length);
      expect(result).toEqual(
        expect.arrayContaining([
          "/products/widget/reviews",
          "/products/widget/specs",
          "/products/widget/compatibility",
        ]),
      );
    });
  });
});
