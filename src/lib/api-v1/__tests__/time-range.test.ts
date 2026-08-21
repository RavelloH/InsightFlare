import { describe, expect, it } from "vitest";

import {
  resolveApiV1ComparisonDatasetTimeRange,
  resolveApiV1PreviousPeriod,
  resolveApiV1TimeRange,
} from "@/lib/api-v1/time-range";

describe("API v1 typed time ranges", () => {
  const capturedAtMs = Date.parse("2026-08-19T12:34:56.000Z");

  it("resolves preset ranges from one captured clock", () => {
    const first = resolveApiV1TimeRange(
      { kind: "preset", preset: "today", timeZone: "UTC" },
      capturedAtMs,
    );
    const second = resolveApiV1TimeRange(
      { kind: "preset", preset: "today", timeZone: "UTC" },
      capturedAtMs,
    );
    expect(first).toEqual(second);
    expect(first).toEqual({
      from: "2026-08-19T00:00:00.000Z",
      to: "2026-08-19T12:34:56.000Z",
      timeZone: "UTC",
    });
  });

  it("uses calendar semantics across DST boundaries", () => {
    const range = resolveApiV1TimeRange(
      {
        kind: "preset",
        preset: "last_7_days",
        timeZone: "America/New_York",
      },
      Date.parse("2026-03-10T12:00:00.000Z"),
    );
    expect(range?.timeZone).toBe("America/New_York");
    expect(Date.parse(range!.to) - Date.parse(range!.from)).toBeGreaterThan(
      6 * 24 * 60 * 60 * 1000,
    );
  });

  it("rejects reversed absolute ranges", () => {
    expect(
      resolveApiV1TimeRange(
        {
          kind: "absolute",
          from: "2026-08-02T00:00:00Z",
          to: "2026-08-01T00:00:00Z",
        },
        capturedAtMs,
      ),
    ).toBeNull();
  });

  it.each([
    "yesterday",
    "last_30_days",
    "this_week",
    "last_week",
    "this_month",
    "last_month",
  ] as const)("resolves %s with a non-empty half-open range", (preset) => {
    const range = resolveApiV1TimeRange(
      { kind: "preset", preset, timeZone: "Asia/Shanghai" },
      capturedAtMs,
    );
    expect(range).not.toBeNull();
    expect(Date.parse(range!.to)).toBeGreaterThan(Date.parse(range!.from));
  });

  it("preserves absolute ranges in canonical UTC form and supports leap boundaries", () => {
    expect(
      resolveApiV1TimeRange(
        {
          kind: "absolute",
          from: "2024-02-29T00:00:00+08:00",
          to: "2024-03-01T00:00:00+08:00",
          timeZone: "Asia/Shanghai",
        },
        capturedAtMs,
      ),
    ).toEqual({
      from: "2024-02-28T16:00:00.000Z",
      to: "2024-02-29T16:00:00.000Z",
      timeZone: "Asia/Shanghai",
    });
  });

  it("resolves explicit comparison datasets under one captured timezone", () => {
    const range = resolveApiV1ComparisonDatasetTimeRange(
      { kind: "preset", preset: "today" },
      "Asia/Shanghai",
      capturedAtMs,
    );
    expect(range).toEqual({
      from: "2026-08-18T16:00:00.000Z",
      to: "2026-08-19T12:34:56.000Z",
      timeZone: "Asia/Shanghai",
    });
  });

  it("derives previous period from exact milliseconds, including DST windows", () => {
    const current = {
      from: "2026-03-08T05:00:00.000Z",
      to: "2026-03-10T04:00:00.000Z",
      timeZone: "America/New_York",
    };
    expect(resolveApiV1PreviousPeriod(current)).toEqual({
      a: current,
      b: {
        from: "2026-03-06T06:00:00.000Z",
        to: "2026-03-08T05:00:00.000Z",
        timeZone: "America/New_York",
      },
    });
  });
});
