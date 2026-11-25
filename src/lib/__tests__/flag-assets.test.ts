import { describe, expect, it } from "vitest";

import { createFlagAssetResolver } from "@/lib/flag-assets";

describe("flag assets", () => {
  it("resolves only known same-origin flags", () => {
    const resolve = createFlagAssetResolver({
      base: "/images/flagpack/revision",
      names: ["us", "gb-sct"],
    });
    expect(resolve("flagpack:US")).toBe("/images/flagpack/revision/us.svg");
    expect(resolve("flagpack:gb-sct")).toBe(
      "/images/flagpack/revision/gb-sct.svg",
    );
    expect(resolve("flagpack:unknown")).toBeUndefined();
    expect(resolve("flagpack:../us")).toBeUndefined();
    expect(resolve("other:us")).toBeUndefined();
  });
});
