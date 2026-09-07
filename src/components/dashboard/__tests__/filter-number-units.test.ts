import { describe, expect, it } from "vitest";

import {
  convertCanonicalNumberToDisplay,
  convertCanonicalTextToDisplay,
  convertDisplayNumberToCanonical,
  convertDisplayTextToCanonical,
  convertFilterNumberValue,
  FILTER_NUMBER_DISPLAY_UNITS,
  FILTER_NUMBER_UNIT_DEFINITIONS,
  formatFilterNumber,
  getFilterNumberDisplayUnits,
  getFilterNumberUnitDefinition,
  splitFilterNumberRange,
  toDisplayNumberMetadata,
} from "@/components/dashboard/filter-number-units";

describe("filter number units", () => {
  it("converts time units in both directions", () => {
    expect(convertCanonicalNumberToDisplay(3_600_000, "ms", "hours")).toBe(1);
    expect(convertCanonicalNumberToDisplay(90_000, "ms", "minutes")).toBe(1.5);
    expect(convertCanonicalNumberToDisplay(2_500, "ms", "seconds")).toBe(2.5);
    expect(convertCanonicalNumberToDisplay(12, "ms", "milliseconds")).toBe(12);
    expect(convertDisplayNumberToCanonical(1.5, "minutes", "ms")).toBe(90_000);
    expect(convertDisplayNumberToCanonical(2.5, "seconds", "ms")).toBe(2_500);
  });

  it("converts ratio units in both directions", () => {
    expect(convertCanonicalNumberToDisplay(0.125, "ratio", "percent")).toBe(
      12.5,
    );
    expect(convertCanonicalNumberToDisplay(0.125, "ratio", "per-mille")).toBe(
      125,
    );
    expect(convertDisplayNumberToCanonical(12.5, "percent", "ratio")).toBe(
      0.125,
    );
    expect(convertDisplayNumberToCanonical(125, "per-mille", "ratio")).toBe(
      0.125,
    );
  });

  it("keeps fixed px values unchanged and exposes display metadata", () => {
    expect(convertCanonicalNumberToDisplay(640, "px", "px")).toBe(640);
    expect(convertDisplayNumberToCanonical(640, "px", "px")).toBe(640);
    expect(FILTER_NUMBER_DISPLAY_UNITS).toEqual({
      ms: ["hours", "minutes", "seconds", "milliseconds"],
      ratio: ["percent", "per-mille"],
      px: ["px"],
    });
    expect(FILTER_NUMBER_UNIT_DEFINITIONS.seconds.multiplier).toBe(1000);
    expect(getFilterNumberDisplayUnits("px")).toEqual(["px"]);
  });

  it("leaves values alone when no unit is available", () => {
    expect(getFilterNumberDisplayUnits(undefined)).toEqual([]);
    expect(convertCanonicalNumberToDisplay(42, undefined, undefined)).toBe(42);
    expect(convertCanonicalTextToDisplay(" 42 ", undefined, undefined)).toBe(
      " 42 ",
    );
    expect(convertDisplayTextToCanonical("42", undefined, "ms")).toBe("42");
  });

  it("converts complete ranges and restores canonical ranges", () => {
    expect(convertCanonicalTextToDisplay("1000, 2500", "ms", "seconds")).toBe(
      "1, 2.5",
    );
    expect(convertDisplayTextToCanonical("1, 2.5", "seconds", "ms")).toBe(
      "1000, 2500",
    );
  });

  it("preserves empty, partial, invalid, and incompatible input", () => {
    expect(convertCanonicalTextToDisplay("", "ms", "seconds")).toBe("");
    expect(convertCanonicalTextToDisplay("  ", "ms", "seconds")).toBe("  ");
    expect(convertCanonicalTextToDisplay("1,", "ms", "seconds")).toBe("1,");
    expect(convertCanonicalTextToDisplay(", 2", "ms", "seconds")).toBe(", 2");
    expect(convertCanonicalTextToDisplay("oops", "ms", "seconds")).toBe("oops");
    expect(convertCanonicalTextToDisplay("1, nope", "ms", "seconds")).toBe(
      "1, nope",
    );
    expect(convertCanonicalTextToDisplay("1.", "ms", "seconds")).toBe("1.");
    expect(convertCanonicalTextToDisplay("1", "ms", "percent")).toBe("1");
    expect(formatFilterNumber("oops")).toBe("oops");
    expect(formatFilterNumber("")).toBe("");
    expect(formatFilterNumber(Number.NaN)).toBe("");
  });

  it("formats valid values and converts canonical number metadata", () => {
    expect(formatFilterNumber("12.34567", { maximumFractionDigits: 2 })).toBe(
      "12.35",
    );
    expect(formatFilterNumber("1000, 2500", { maximumFractionDigits: 1 })).toBe(
      "1000, 2500",
    );

    const canonical = { min: 0, max: 3_600_000, step: 1000 } as const;
    expect(toDisplayNumberMetadata(canonical, "ms", "seconds")).toEqual({
      min: 0,
      max: 3600,
      step: 1,
    });
    expect(canonical).toEqual({ min: 0, max: 3_600_000, step: 1000 });
    expect(toDisplayNumberMetadata(canonical, undefined, undefined)).toEqual(
      canonical,
    );
  });

  it("guards invalid values, ranges, and metadata", () => {
    expect(getFilterNumberUnitDefinition(undefined)).toBeUndefined();
    expect(convertFilterNumberValue(Number.POSITIVE_INFINITY, "ms", "ms")).toBe(
      undefined,
    );
    expect(splitFilterNumberRange("1, 2, 3")).toBeUndefined();
    expect(toDisplayNumberMetadata(undefined, "ms", "seconds")).toBeUndefined();
    expect(
      toDisplayNumberMetadata(
        { min: Number.NaN, max: Number.POSITIVE_INFINITY },
        "ms",
        "seconds",
      ),
    ).toEqual({});
  });
});
