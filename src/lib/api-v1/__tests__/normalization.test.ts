import { describe, expect, it } from "vitest";

import {
  epochSecondsToIso,
  normalizeUnknownDirect,
} from "@/lib/api-v1/normalization";

describe("API v1 normalization helpers", () => {
  it("normalizes missing epoch seconds to null", () => {
    expect(epochSecondsToIso(null)).toBeNull();
    expect(epochSecondsToIso(undefined)).toBeNull();
  });

  it("normalizes empty, direct, and ordinary dimensions", () => {
    expect(normalizeUnknownDirect(null)).toEqual({
      key: "__unknown__",
      label: "Unknown",
    });
    expect(normalizeUnknownDirect(undefined)).toEqual({
      key: "__unknown__",
      label: "Unknown",
    });
    expect(normalizeUnknownDirect("  ")).toEqual({
      key: "__unknown__",
      label: "Unknown",
    });
    expect(normalizeUnknownDirect("DIRECT")).toEqual({
      key: "__direct__",
      label: "Direct",
    });
    expect(normalizeUnknownDirect("  newsletter  ")).toEqual({
      key: "newsletter",
      label: "newsletter",
    });
  });

  it("converts epoch seconds to an ISO timestamp", () => {
    expect(epochSecondsToIso(1_755_576_300)).toBe("2025-08-19T04:05:00.000Z");
  });
});
