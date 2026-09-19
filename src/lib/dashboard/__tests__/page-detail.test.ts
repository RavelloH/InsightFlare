import { describe, expect, it } from "vitest";

import {
  normalizePagePath,
  slugifyPagePath,
} from "@/lib/dashboard/page-detail";

describe("dashboard page detail helpers", () => {
  describe("normalizePagePath", () => {
    it("normalizes rooted page paths", () => {
      expect(normalizePagePath("/docs//guide/")).toBe("/docs/guide");
      expect(normalizePagePath(" /pricing/ ")).toBe("/pricing");
      expect(normalizePagePath("/")).toBe("/");
    });

    it("rejects missing and non-rooted values", () => {
      expect(normalizePagePath(null)).toBeNull();
      expect(normalizePagePath("")).toBeNull();
      expect(normalizePagePath("docs")).toBeNull();
    });
  });

  describe("slugifyPagePath", () => {
    it("creates stable slugs for root, normal, and symbolic paths", () => {
      expect(slugifyPagePath("/")).toBe("home");
      expect(slugifyPagePath("/Docs/Getting Started")).toBe(
        "docs-getting-started",
      );
      expect(slugifyPagePath("/---")).toBe("page");
      expect(slugifyPagePath("not-rooted")).toBe("page");
    });
  });
});
