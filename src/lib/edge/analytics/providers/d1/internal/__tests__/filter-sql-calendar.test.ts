// @vitest-environment node
import { describe, expect, it } from "vitest";

import { sqlCalendarPeriods } from "@/lib/edge/analytics/providers/d1/internal/filter-sql-calendar";
const duration = (unit: "d" | "w" | "mo" | "h", amount = 1) => ({
  kind: "duration" as const,
  unit,
  amount,
});

describe("P4 IANA calendar boundaries", () => {
  it("uses a real 23-hour spring-forward day rather than 24h chunks", () => {
    const start = Date.parse("2026-03-08T08:00:00.000Z");
    const end = Date.parse("2026-03-09T07:00:00.000Z");
    expect(
      sqlCalendarPeriods(duration("d"), {
        nowMs: end,
        rangeStartMs: start,
        rangeEndExclusiveMs: end,
        timeZone: "America/Los_Angeles",
      }),
    ).toEqual([{ start, end }]);
    expect(end - start).toBe(23 * 3600000);
  });
  it("uses a real 25-hour fall-back day", () => {
    const start = Date.parse("2026-11-01T07:00:00.000Z");
    const end = Date.parse("2026-11-02T08:00:00.000Z");
    expect(
      sqlCalendarPeriods(duration("d"), {
        nowMs: end,
        rangeStartMs: start,
        rangeEndExclusiveMs: end,
        timeZone: "America/Los_Angeles",
      }),
    ).toEqual([{ start, end }]);
    expect(end - start).toBe(25 * 3600000);
  });
  it("honors natural months and ISO Monday weeks", () => {
    const start = Date.parse("2026-02-20T10:00:00.000Z");
    const end = Date.parse("2026-03-03T10:00:00.000Z");
    const clock = {
      nowMs: end,
      rangeStartMs: start,
      rangeEndExclusiveMs: end,
      timeZone: "UTC",
    };
    expect(sqlCalendarPeriods(duration("mo"), clock)).toEqual([
      {
        start: Date.parse("2026-02-01T00:00:00.000Z"),
        end: Date.parse("2026-03-01T00:00:00.000Z"),
      },
      {
        start: Date.parse("2026-03-01T00:00:00.000Z"),
        end: Date.parse("2026-04-01T00:00:00.000Z"),
      },
    ]);
    expect(sqlCalendarPeriods(duration("w"), clock)[0]?.start).toBe(
      Date.parse("2026-02-16T00:00:00.000Z"),
    );
  });
});

describe("calendar-based SQL range precision for short intervals", () => {
  const clock = (from: string, to: string) => ({
    nowMs: Date.parse(to),
    rangeStartMs: Date.parse(from),
    rangeEndExclusiveMs: Date.parse(to),
    timeZone: "UTC",
  });
  it("honors distinct one-hour and multi-hour calendar boundaries", () => {
    const c = clock("2026-01-02T05:30:00Z", "2026-01-02T07:30:00Z");
    expect(sqlCalendarPeriods(duration("h", 2), c)).toEqual([
      {
        start: Date.parse("2026-01-02T04:00:00Z"),
        end: Date.parse("2026-01-02T06:00:00Z"),
      },
      {
        start: Date.parse("2026-01-02T06:00:00Z"),
        end: Date.parse("2026-01-02T08:00:00Z"),
      },
    ]);
    expect(sqlCalendarPeriods(duration("h", 1), c)[0]?.start).toBe(
      Date.parse("2026-01-02T05:00:00Z"),
    );
  });
  it("aligns milliseconds, seconds and minutes as genuine elapsed-time buckets", () => {
    const variants = [
      {
        unit: "ms",
        amount: 500,
        from: "2026-01-01T00:00:00.250Z",
        to: "2026-01-01T00:00:01.250Z",
        first: "2026-01-01T00:00:00Z",
        end: "2026-01-01T00:00:00.500Z",
      },
      {
        unit: "s",
        amount: 5,
        from: "2026-01-01T00:00:12.500Z",
        to: "2026-01-01T00:00:17Z",
        first: "2026-01-01T00:00:10Z",
        end: "2026-01-01T00:00:15Z",
      },
      {
        unit: "m",
        amount: 2,
        from: "2026-01-01T00:03:15Z",
        to: "2026-01-01T00:05:15Z",
        first: "2026-01-01T00:02:00Z",
        end: "2026-01-01T00:04:00Z",
      },
    ] as const;
    for (const v of variants) {
      const periods = sqlCalendarPeriods(
        { kind: "duration", unit: v.unit, amount: v.amount },
        clock(v.from, v.to),
      );
      expect(periods[0]).toEqual({
        start: Date.parse(v.first),
        end: Date.parse(v.end),
      });
      expect(periods.at(-1)!.end).toBeGreaterThanOrEqual(Date.parse(v.to));
    }
  });
  it("rejects nonpositive calendar widths and returns no buckets for an empty window", () => {
    const c = clock("2026-01-01T00:00:00Z", "2026-01-01T01:00:00Z");
    expect(() => sqlCalendarPeriods(duration("h", 0), c)).toThrow(
      "Calendar interval amount",
    );
    expect(() =>
      sqlCalendarPeriods(
        { kind: "duration", unit: "unknown" as never, amount: 1 },
        c,
      ),
    ).toThrow("Unrecognized Calendar unit.");
    expect(
      sqlCalendarPeriods(duration("h", 1), {
        ...c,
        rangeEndExclusiveMs: c.rangeStartMs,
      }),
    ).toEqual([]);
  });
});
