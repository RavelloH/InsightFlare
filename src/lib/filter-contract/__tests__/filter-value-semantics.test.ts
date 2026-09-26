import { describe, expect, it } from "vitest";

import {
  canonicalizeFilterValue,
  compareFilterValues,
  filterPresenceMatches,
  filterValueInSet,
  filterValuesEqual,
  matchFilterString,
} from "@/lib/filter-contract/filter-value-semantics";

describe("shared filter value semantics", () => {
  it("uses the field registry for canonical text and direct-referrer values", () => {
    expect(canonicalizeFilterValue("__direct__", "referrer.domain", "eq")).toBe(
      "",
    );
    expect(
      canonicalizeFilterValue("__direct__", "referrer.domain", "contains"),
    ).toBe("__direct__");
    expect(canonicalizeFilterValue(42, "client.screenWidth")).toBe(42);
    expect(
      filterValuesEqual("Google.COM", "google.com", "referrer.domain"),
    ).toBe(true);
    expect(filterValuesEqual("/Docs", "/docs", "page.path")).toBe(false);
    expect(
      filterValueInSet("google.com", ["GOOGLE.COM"], "referrer.domain", "in"),
    ).toBe(true);
    expect(
      matchFilterString("Docs/Guide", "docs", "startsWith", "page.path"),
    ).toBe(false);
    expect(
      matchFilterString("Docs/Guide", "Docs", "startsWith", "page.path"),
    ).toBe(true);
  });

  it("compares datetime encodings only for temporal fields and orders scalar values", () => {
    const iso = "1970-01-01T00:00:01.000Z";
    expect(filterValuesEqual(1_000, iso)).toBe(true);
    expect(filterValuesEqual(1_000, iso, "page.path")).toBe(false);
    expect(filterValuesEqual(iso, 1_000)).toBe(true);
    expect(filterValuesEqual(1_001, iso)).toBe(false);
    expect(filterValuesEqual(null, null)).toBe(false);
    expect(compareFilterValues(true, false)).toBe(1);
    expect(compareFilterValues(1, 2)).toBe(-1);
    expect(compareFilterValues(" A ", "a", "page.hostname")).toBe(0);
    expect(matchFilterString("x-guide-y", "guide", "contains")).toBe(true);
    expect(matchFilterString("x-guide-y", "guide", "endsWith")).toBe(false);
  });

  it("shares null, missing, and empty-value presence rules", () => {
    const state = (
      value: unknown,
      options: Partial<{
        missing: boolean;
        emptyCollection: boolean;
        legacyField: boolean;
      }> = {},
    ) => ({
      missing: options.missing ?? false,
      value,
      emptyCollection: options.emptyCollection ?? false,
      legacyField: options.legacyField ?? false,
    });

    expect(filterPresenceMatches("exists", state(null), "event.payload")).toBe(
      true,
    );
    expect(filterPresenceMatches("exists", state("x", { missing: true }))).toBe(
      false,
    );
    expect(
      filterPresenceMatches("notExists", state("x", { emptyCollection: true })),
    ).toBe(true);
    expect(filterPresenceMatches("notExists", state(null), "page.path")).toBe(
      true,
    );
    expect(
      filterPresenceMatches(
        "isNull",
        state(undefined, { missing: true }),
        "page.path",
      ),
    ).toBe(true);
    expect(
      filterPresenceMatches("isNull", state(undefined, { missing: true })),
    ).toBe(false);
    expect(filterPresenceMatches("notNull", state("value"))).toBe(true);
    expect(filterPresenceMatches("notNull", state(null))).toBe(false);
    expect(filterPresenceMatches("isEmpty", state(""), "event.payload")).toBe(
      true,
    );
    expect(
      filterPresenceMatches("notEmpty", state("value"), "event.payload"),
    ).toBe(true);
    expect(filterPresenceMatches("notEmpty", state(""), "event.payload")).toBe(
      false,
    );
    expect(filterPresenceMatches("exists", state("value"))).toBe(true);
  });
});
