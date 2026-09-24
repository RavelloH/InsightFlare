import { describe, expect, it } from "vitest";

import {
  mergeUaClientHintsIntoHeaders,
  normalizeTrackerUaClientHints,
} from "@/lib/edge/collector/client-hints";
describe("tracker UA client hints normalization", () => {
  it("returns undefined for empty, non-object, and empty-normalized inputs", () => {
    expect(normalizeTrackerUaClientHints(null)).toBeUndefined();
    expect(normalizeTrackerUaClientHints([])).toBeUndefined();
    expect(
      normalizeTrackerUaClientHints({ brands: [{ brand: "", version: "" }] }),
    ).toBeUndefined();
  });

  it("trims, filters, and caps client hint fields", () => {
    const normalized = normalizeTrackerUaClientHints({
      brands: [
        { brand: " Chromium ", version: " 124 " },
        { brand: "", version: "1" },
        null,
      ],
      fullVersionList: Array.from({ length: 10 }, (_, index) => ({
        brand: `Brand ${index}`,
        version: `${index}`,
      })),
      mobile: false,
      platform: " macOS ",
      platformVersion: " 15.1 ",
      model: " MacBook Pro ".repeat(20),
      formFactors: [" Desktop ", "", " XR "],
    });

    expect(normalized?.brands).toEqual([{ brand: "Chromium", version: "124" }]);
    expect(normalized?.fullVersionList).toHaveLength(8);
    expect(normalized?.mobile).toBe(false);
    expect(normalized?.platform).toBe("macOS");
    expect(normalized?.platformVersion).toBe("15.1");
    expect(normalized?.model).toHaveLength(120);
    expect(normalized?.formFactors).toEqual(["Desktop", "XR"]);
  });

  it("applies item caps before filtering invalid list entries", () => {
    const normalized = normalizeTrackerUaClientHints({
      brands: [
        null,
        { brand: "", version: "1" },
        { brand: "A", version: "1" },
        { brand: "B", version: "2" },
        { brand: "C", version: "3" },
        { brand: "D", version: "4" },
        { brand: "E", version: "5" },
        { brand: "F", version: "6" },
        { brand: "G", version: "7" },
      ],
      formFactors: [
        "",
        " Phone ",
        " Tablet ",
        " XR ",
        " TV ",
        " Auto ",
        " PC ",
        " Watch ",
        " Late ",
      ],
    });

    expect(normalized?.brands).toEqual([
      { brand: "A", version: "1" },
      { brand: "B", version: "2" },
      { brand: "C", version: "3" },
      { brand: "D", version: "4" },
      { brand: "E", version: "5" },
      { brand: "F", version: "6" },
    ]);
    expect(normalized?.formFactors).toEqual([
      "Phone",
      "Tablet",
      "XR",
      "TV",
      "Auto",
      "PC",
      "Watch",
    ]);
  });

  it("ignores arrays, scalar brand fields, and non-boolean mobile flags", () => {
    expect(
      normalizeTrackerUaClientHints({
        brands: [{ brand: ["Chrome"], version: "124" }],
        fullVersionList: [{ brand: "Chrome", version: 124 }],
        mobile: "true",
      }),
    ).toBeUndefined();
  });

  it("normalizes sparse client hint objects without optional list fields", () => {
    expect(
      normalizeTrackerUaClientHints({
        brands: "Chrome",
        fullVersionList: null,
        mobile: true,
        platform: " Android ",
        platformVersion: 15,
        model: "",
        formFactors: "Mobile",
      }),
    ).toEqual({
      mobile: true,
      platform: "Android",
    });
  });

  it("serializes normalized hints into structured headers without mutating the input headers", () => {
    const headers = { "content-type": "application/json" };
    const merged = mergeUaClientHintsIntoHeaders(headers, {
      brands: [{ brand: 'Chrom"ium', version: "124\\1" }],
      mobile: true,
      platform: "Windows",
      platformVersion: "15.0",
      model: "Surface",
      fullVersionList: [{ brand: "Chromium", version: "124.0.1" }],
      formFactors: ["Desktop", "Foldable"],
    });

    expect(headers).toEqual({ "content-type": "application/json" });
    expect(merged["content-type"]).toBe("application/json");
    expect(merged["sec-ch-ua"]).toBe('"Chrom\\"ium";v="124\\\\1"');
    expect(merged["sec-ch-ua-mobile"]).toBe("?1");
    expect(merged["sec-ch-ua-platform"]).toBe('"Windows"');
    expect(merged["sec-ch-ua-platform-version"]).toBe('"15.0"');
    expect(merged["sec-ch-ua-model"]).toBe('"Surface"');
    expect(merged["sec-ch-ua-full-version-list"]).toBe(
      '"Chromium";v="124.0.1"',
    );
    expect(merged["sec-ch-ua-form-factors"]).toBe('"Desktop", "Foldable"');
  });

  it("serializes only present client hint headers", () => {
    expect(
      mergeUaClientHintsIntoHeaders(
        { existing: "1" },
        {
          mobile: false,
        },
      ),
    ).toEqual({
      existing: "1",
      "sec-ch-ua-mobile": "?0",
    });

    expect(
      mergeUaClientHintsIntoHeaders(
        {},
        {
          platformVersion: " 13.5 ",
        },
      ),
    ).toEqual({
      "sec-ch-ua-platform-version": '"13.5"',
    });

    expect(
      mergeUaClientHintsIntoHeaders(
        {},
        {
          model: "Pixel",
        },
      ),
    ).toEqual({
      "sec-ch-ua-model": '"Pixel"',
    });

    expect(
      mergeUaClientHintsIntoHeaders(
        {},
        {
          formFactors: ["Phone"],
        },
      ),
    ).toEqual({
      "sec-ch-ua-form-factors": '"Phone"',
    });
  });

  it("returns the same headers object when hints normalize to nothing", () => {
    const headers = { existing: "1" };
    expect(mergeUaClientHintsIntoHeaders(headers, {})).toBe(headers);
  });
});
