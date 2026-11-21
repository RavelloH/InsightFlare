import { describe, expect, it } from "vitest";

import {
  decodeInvocationPhysicalPoint,
  INVOCATION_METRICS_SCHEMA_V2,
  INVOCATION_V2_BLOBS,
  INVOCATION_V2_DOUBLES,
  setV2BooleanFlag,
  setV2CoverageFlag,
  v2BooleanFlag,
  v2CoverageFlag,
} from "@/lib/edge/analytics-engine/invocation-schema-v2";

describe("Invocation AE physical schema compatibility", () => {
  it("has exactly 20 stable slots per v2 section", () => {
    expect(INVOCATION_V2_BLOBS).toHaveLength(20);
    expect(INVOCATION_V2_DOUBLES).toHaveLength(20);
    expect(new Set(INVOCATION_V2_BLOBS).size).toBe(20);
    expect(new Set(INVOCATION_V2_DOUBLES).size).toBe(20);
    expect(INVOCATION_METRICS_SCHEMA_V2).toBe(2);
  });
  it("decodes existing v1 independently from v2 and rejects ambiguous rows", () => {
    const blobs = Array.from({ length: 20 }, (_, i) => `value-${i}`);
    const doubles = Array.from({ length: 20 }, (_, i) => i);
    expect(decodeInvocationPhysicalPoint({ blobs, doubles })).toBeNull();
    const v1 = decodeInvocationPhysicalPoint({
      blobs,
      doubles: [...doubles.slice(0, 19), 1],
    });
    expect(v1?.schemaVersion).toBe(1);
    expect(v1?.blobs).toHaveProperty("primaryErrorLocation", "value-13");
    const v2 = decodeInvocationPhysicalPoint({
      blobs,
      doubles: [...doubles.slice(0, 19), 2],
    });
    expect(v2?.schemaVersion).toBe(2);
    expect(v2?.blobs).toHaveProperty("hotQueryId", "value-13");
    expect(v2?.doubles).toHaveProperty("doFetchWallSumMs", 11);
    expect(
      decodeInvocationPhysicalPoint({
        blobs,
        doubles: [...doubles.slice(0, 19), 3],
      }),
    ).toBeNull();
  });
  it("packs presence and coverage flags inside a safe non-negative integer", () => {
    let bits = 0;
    bits = setV2BooleanFlag(bits, "backgroundDrainPresent", true);
    bits = setV2BooleanFlag(bits, "queryAttributionComplete", true);
    bits = setV2CoverageFlag(bits, "d1RowsRead", "complete");
    bits = setV2CoverageFlag(bits, "hotQueryEngine", "partial");
    bits = setV2CoverageFlag(bits, "doFetchWall", "complete");
    expect(bits).toBeLessThan(2 ** 30);
    expect(v2BooleanFlag(bits, "backgroundDrainPresent")).toBe(true);
    expect(v2BooleanFlag(bits, "handlerPresent")).toBe(false);
    expect(v2CoverageFlag(bits, "d1RowsRead")).toBe("complete");
    expect(v2CoverageFlag(bits, "hotQueryEngine")).toBe("partial");
    expect(v2CoverageFlag(bits, "doFetchWall")).toBe("complete");
  });
});
