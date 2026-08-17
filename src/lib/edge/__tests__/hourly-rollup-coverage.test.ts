import { describe, expect, it } from "vitest";

import {
  ROLLUP_LAG_HOURS,
  ROLLUP_SCHEMA_VERSION,
} from "@/lib/edge/hourly-rollup";
import { EMPTY_FILTER_DOCUMENT, hasFilters } from "@/lib/edge/query-contract";

describe("hourly-rollup constants", () => {
  it("exports expected constants", () => {
    expect(ROLLUP_LAG_HOURS).toBe(12);
    expect(ROLLUP_SCHEMA_VERSION).toBe(1);
  });
});

describe("typed empty filters", () => {
  it("does not select rollups as filtered", () => {
    expect(hasFilters(EMPTY_FILTER_DOCUMENT)).toBe(false);
  });
});
