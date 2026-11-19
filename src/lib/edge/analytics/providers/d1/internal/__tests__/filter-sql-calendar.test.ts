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
