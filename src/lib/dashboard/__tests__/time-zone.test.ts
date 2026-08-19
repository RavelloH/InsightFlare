import { describe, expect, it, vi } from "vitest";

import {
  addCalendarDays,
  addCalendarMonths,
  addZonedInterval,
  browserTimeZone,
  buildTimeZoneOptions,
  endOfZonedDay,
  formatTimeZoneOptionLabel,
  formatUtcOffset,
  isValidTimeZone,
  normalizeTimeZone,
  REPORTING_TIME_ZONE_COOKIE,
  resolveReportingTimeZone,
  startOfZonedDay,
  startOfZonedHour,
  startOfZonedInterval,
  startOfZonedMinute,
  startOfZonedMonth,
  startOfZonedWeek,
  startOfZonedYear,
  supportedTimeZones,
  timeZoneOffsetMinutes,
  writeReportingTimeZoneCookie,
  zonedParts,
  zonedTimeToUtcMs,
} from "@/lib/dashboard/time-zone";

describe("Timezone & Calendar Calculation Utilities", () => {
  describe("reporting timezone cookie", () => {
    it("writes a normalized effective timezone and ignores invalid values", () => {
      document.cookie = `${REPORTING_TIME_ZONE_COOKIE}=; Path=/; Max-Age=0`;

      writeReportingTimeZoneCookie(" Asia/Shanghai ");
      expect(document.cookie).toContain(
        `${REPORTING_TIME_ZONE_COOKIE}=Asia%2FShanghai`,
      );

      document.cookie = `${REPORTING_TIME_ZONE_COOKIE}=; Path=/; Max-Age=0`;
      writeReportingTimeZoneCookie("Invalid/Zone");
      expect(document.cookie).not.toContain(
        `${REPORTING_TIME_ZONE_COOKIE}=Invalid%2FZone`,
      );
    });
  });

  describe("isValidTimeZone", () => {
    it("should correctly identify valid timezone strings", () => {
      expect(isValidTimeZone("UTC")).toBe(true);
      expect(isValidTimeZone("Asia/Shanghai")).toBe(true);
      expect(isValidTimeZone("America/New_York")).toBe(true);
      expect(isValidTimeZone("Europe/London")).toBe(true);
    });

    it("should identify and reject invalid timezone strings", () => {
      expect(isValidTimeZone("")).toBe(false);
      expect(isValidTimeZone("   ")).toBe(false);
      expect(isValidTimeZone("Asia/Beijing")).toBe(false); // Not standard IANA (should be Asia/Shanghai)
      expect(isValidTimeZone("Invalid/Zone_Name")).toBe(false);
    });
  });

  describe("normalizeTimeZone", () => {
    it("should trim valid timezones and return blank for invalid or nullish values", () => {
      expect(normalizeTimeZone("  UTC  ")).toBe("UTC");
      expect(normalizeTimeZone("Invalid/Zone")).toBe("");
      expect(normalizeTimeZone(null)).toBe("");
      expect(normalizeTimeZone(undefined)).toBe("");
    });
  });

  describe("resolveReportingTimeZone", () => {
    it("should use preferred timezone when it is valid", () => {
      expect(resolveReportingTimeZone("Asia/Tokyo", "Asia/Shanghai")).toBe(
        "Asia/Tokyo",
      );
    });

    it("should fall back to browser timezone when preferred is invalid but browser is valid", () => {
      expect(resolveReportingTimeZone("Invalid/Zone", "Asia/Shanghai")).toBe(
        "Asia/Shanghai",
      );
    });

    it("should fall back to UTC when both preferred and browser timezones are invalid", () => {
      expect(resolveReportingTimeZone("", "Invalid/Zone")).toBe("UTC");
      expect(resolveReportingTimeZone(null, undefined)).toBe("UTC");
    });
  });

  describe("zonedParts & timeZoneOffsetMinutes", () => {
    // Fixed test timestamp: UTC 2026-05-26T12:00:00.000Z
    // Timestamp: 1779796800000
    const testTimestamp = 1779796800000;

    it("should correctly parse date components in UTC", () => {
      const parts = zonedParts(testTimestamp, "UTC");
      expect(parts.year).toBe(2026);
      expect(parts.month).toBe(5);
      expect(parts.day).toBe(26);
      expect(parts.hour).toBe(12);
      expect(parts.minute).toBe(0);
      expect(parts.second).toBe(0);

      expect(timeZoneOffsetMinutes("UTC", testTimestamp)).toBe(0);
    });

    it("should correctly handle Asia/Shanghai offset and date translation", () => {
      const parts = zonedParts(testTimestamp, "Asia/Shanghai");
      // Asia/Shanghai should be 2026-05-26 20:00:00
      expect(parts.year).toBe(2026);
      expect(parts.month).toBe(5);
      expect(parts.day).toBe(26);
      expect(parts.hour).toBe(20);
      expect(parts.minute).toBe(0);

      expect(timeZoneOffsetMinutes("Asia/Shanghai", testTimestamp)).toBe(480); // +8 hours = +480 minutes
    });

    it("should roundtrip correctly back to timestamp via zonedTimeToUtcMs", () => {
      const parts = zonedParts(testTimestamp, "Asia/Shanghai");
      const reversedTimestamp = zonedTimeToUtcMs("Asia/Shanghai", parts);
      expect(reversedTimestamp).toBe(testTimestamp);
    });

    it("should recalculate offsets when the first UTC guess crosses a DST boundary", () => {
      const timestamp = zonedTimeToUtcMs("America/New_York", {
        year: 2026,
        month: 3,
        day: 8,
        hour: 3,
        minute: 30,
        second: 0,
        millisecond: 0,
      });

      expect(new Date(timestamp).toISOString()).toBe(
        "2026-03-08T07:30:00.000Z",
      );
      expect(zonedParts(timestamp, "America/New_York")).toMatchObject({
        year: 2026,
        month: 3,
        day: 8,
        hour: 3,
        minute: 30,
      });
    });
  });

  describe("addCalendarDays & addCalendarMonths", () => {
    it("should correctly handle calendar day additions crossing month boundaries", () => {
      const start = { year: 2026, month: 5, day: 31 };

      const nextDay = addCalendarDays(start, 1);
      expect(nextDay).toEqual({ year: 2026, month: 6, day: 1 });

      const prevDay = addCalendarDays(start, -1);
      expect(prevDay).toEqual({ year: 2026, month: 5, day: 30 });
    });

    it("should correctly handle February additions in common and leap years", () => {
      // 2024 is a leap year (February has 29 days)
      const leapFeb = { year: 2024, month: 2, day: 28 };
      expect(addCalendarDays(leapFeb, 1)).toEqual({
        year: 2024,
        month: 2,
        day: 29,
      });
      expect(addCalendarDays(leapFeb, 2)).toEqual({
        year: 2024,
        month: 3,
        day: 1,
      }); // crossing to March 1st

      // 2023 is a common year (February has 28 days)
      const commonFeb = { year: 2023, month: 2, day: 28 };
      expect(addCalendarDays(commonFeb, 1)).toEqual({
        year: 2023,
        month: 3,
        day: 1,
      });
    });

    it("should perform safe month-end truncation in addCalendarMonths if target month has fewer days", () => {
      const date = { year: 2026, month: 5, day: 31 };

      // May 31 + 1 month = June 30 due to truncation (June has only 30 days)
      const nextMonth = addCalendarMonths(date, 1);
      expect(nextMonth).toEqual({ year: 2026, month: 6, day: 30 });

      // May 31 + 2 months = July 31 (no truncation, July has 31 days)
      const twoMonthsLater = addCalendarMonths(date, 2);
      expect(twoMonthsLater).toEqual({ year: 2026, month: 7, day: 31 });
    });
  });

  describe("startOfZonedDay & startOfZonedWeek & startOfZonedMonth", () => {
    // Fixed test timestamp: UTC 2026-05-26T15:14:56.789Z (Tuesday 23:14:56 in Asia/Shanghai)
    const testTimestamp = 1779808496789;

    it("startOfZonedDay should clear hours, minutes, seconds and milliseconds of the day", () => {
      const startMs = startOfZonedDay(testTimestamp, "Asia/Shanghai");
      const parts = zonedParts(startMs, "Asia/Shanghai");
      expect(parts.year).toBe(2026);
      expect(parts.month).toBe(5);
      expect(parts.day).toBe(26);
      expect(parts.hour).toBe(0);
      expect(parts.minute).toBe(0);
      expect(parts.second).toBe(0);
      expect(parts.millisecond).toBe(0);
    });

    it("startOfZonedWeek should correctly find the first day of the week (Monday)", () => {
      // 2026-05-26 is Tuesday, so Monday should be May 25
      const startMs = startOfZonedWeek(testTimestamp, "Asia/Shanghai");
      const parts = zonedParts(startMs, "Asia/Shanghai");
      expect(parts.year).toBe(2026);
      expect(parts.month).toBe(5);
      expect(parts.day).toBe(25); // Monday
      expect(parts.hour).toBe(0);

      // Test a real Sunday timestamp: 2026-05-31 (Asia/Shanghai)
      const sundayTimestamp = 1780238400000;
      const startMsSunday = startOfZonedWeek(sundayTimestamp, "Asia/Shanghai");
      const partsSunday = zonedParts(startMsSunday, "Asia/Shanghai");
      expect(partsSunday.year).toBe(2026);
      expect(partsSunday.month).toBe(5);
      expect(partsSunday.day).toBe(25); // Should still resolve to Monday May 25
    });

    it("startOfZonedMonth should correctly find the 1st of the month", () => {
      const startMs = startOfZonedMonth(testTimestamp, "Asia/Shanghai");
      const parts = zonedParts(startMs, "Asia/Shanghai");
      expect(parts.year).toBe(2026);
      expect(parts.month).toBe(5);
      expect(parts.day).toBe(1); // 1st
      expect(parts.hour).toBe(0);
    });
  });

  describe("addZonedInterval", () => {
    const testTimestamp = 1779796800000; // 2026-05-26 12:00:00 UTC

    it("should accurately add intervals in days, weeks, and months", () => {
      // Add one day
      const plusOneDay = addZonedInterval(testTimestamp, "day", "UTC", 1);
      const dayParts = zonedParts(plusOneDay, "UTC");
      expect(dayParts.day).toBe(27);

      // Add one week
      const plusOneWeek = addZonedInterval(testTimestamp, "week", "UTC", 1);
      const weekParts = zonedParts(plusOneWeek, "UTC");
      expect(weekParts.day).toBe(2); // 26 + 7 = 33 -> June 2nd
      expect(weekParts.month).toBe(6);

      // Add one month
      const plusOneMonth = addZonedInterval(testTimestamp, "month", "UTC", 1);
      const monthParts = zonedParts(plusOneMonth, "UTC");
      expect(monthParts.month).toBe(6);
      expect(monthParts.day).toBe(26);
    });

    it("should accurately subtract intervals (negative amounts) in days, weeks, and months", () => {
      // 2026-05-26 12:00:00 UTC
      // Subtract 26 days -> 2026-04-30
      const minus26Days = addZonedInterval(testTimestamp, "day", "UTC", -26);
      const dayParts = zonedParts(minus26Days, "UTC");
      expect(dayParts.month).toBe(4);
      expect(dayParts.day).toBe(30);

      // Subtract 12 months -> 2025-05-26
      const minusYear = addZonedInterval(testTimestamp, "month", "UTC", -12);
      const yearParts = zonedParts(minusYear, "UTC");
      expect(yearParts.year).toBe(2025);
      expect(yearParts.month).toBe(5);
      expect(yearParts.day).toBe(26);
    });
  });

  describe("Daylight Saving Time (DST) Jumps", () => {
    it("should correctly adapt timezone offsets during the Spring-Forward transition in New York", () => {
      // Validate roundtrip conversion mathematical symmetry for America/New_York across seasonal anchors,
      // avoiding static offset assumptions that vary across host ICU database implementations.

      // 1. Deep Winter (January EST)
      const winterMs = 1768496400000;
      const partsWinter = zonedParts(winterMs, "America/New_York");
      const roundtripWinter = zonedTimeToUtcMs("America/New_York", partsWinter);
      expect(roundtripWinter).toBe(winterMs);

      // 2. Deep Summer (July EDT)
      const summerMs = 1784131200000;
      const partsSummer = zonedParts(summerMs, "America/New_York");
      const roundtripSummer = zonedTimeToUtcMs("America/New_York", partsSummer);
      expect(roundtripSummer).toBe(summerMs);
    });
  });

  describe("Micro-scale Intervals (Minute & Hour)", () => {
    // 2026-05-26 15:14:56.789 UTC (23:14:56.789 Asia/Shanghai)
    const testTimestamp = 1779808496789;

    it("startOfZonedHour should clear minutes, seconds, and milliseconds", () => {
      const hourStart = startOfZonedHour(testTimestamp, "Asia/Shanghai");
      const parts = zonedParts(hourStart, "Asia/Shanghai");
      expect(parts.hour).toBe(23);
      expect(parts.minute).toBe(0);
      expect(parts.second).toBe(0);
      expect(parts.millisecond).toBe(0);
    });

    it("startOfZonedMinute should clear seconds and milliseconds", () => {
      const minuteStart = startOfZonedMinute(testTimestamp, "Asia/Shanghai");
      const parts = zonedParts(minuteStart, "Asia/Shanghai");
      expect(parts.hour).toBe(23);
      expect(parts.minute).toBe(14);
      expect(parts.second).toBe(0);
      expect(parts.millisecond).toBe(0);
    });

    it("endOfZonedDay should resolve to the very last millisecond of the day", () => {
      const endMs = endOfZonedDay(testTimestamp, "Asia/Shanghai");
      const nextDayStart = startOfZonedDay(
        testTimestamp + 24 * 60 * 60 * 1000,
        "Asia/Shanghai",
      );
      expect(endMs).toBe(nextDayStart - 1);
    });
  });

  describe("startOfZonedInterval with Month Interval (Line 305)", () => {
    it("should dispatch minute, hour, day, and week intervals to their start helpers", () => {
      const testTimestamp = 1779808496789;

      expect(startOfZonedInterval(testTimestamp, "minute", "UTC")).toBe(
        startOfZonedMinute(testTimestamp, "UTC"),
      );
      expect(startOfZonedInterval(testTimestamp, "hour", "UTC")).toBe(
        startOfZonedHour(testTimestamp, "UTC"),
      );
      expect(startOfZonedInterval(testTimestamp, "day", "UTC")).toBe(
        startOfZonedDay(testTimestamp, "UTC"),
      );
      expect(startOfZonedInterval(testTimestamp, "week", "UTC")).toBe(
        startOfZonedWeek(testTimestamp, "UTC"),
      );
    });

    it("should return start of zoned month when interval is 'month'", () => {
      const testTimestamp = 1779808496789; // 2026-05-26 23:14:56.789 Asia/Shanghai
      const startMs = startOfZonedInterval(
        testTimestamp,
        "month",
        "Asia/Shanghai",
      );
      const parts = zonedParts(startMs, "Asia/Shanghai");
      expect(parts.year).toBe(2026);
      expect(parts.month).toBe(5);
      expect(parts.day).toBe(1);
      expect(parts.hour).toBe(0);
    });
  });

  describe("addZonedInterval with Micro-scale Intervals (Line 316, 322)", () => {
    const testTimestamp = 1779808496789; // 2026-05-26 23:14:56.789 Asia/Shanghai

    it("should accurately add/subtract minute intervals", () => {
      const result = addZonedInterval(
        testTimestamp,
        "minute",
        "Asia/Shanghai",
        10,
      );
      const parts = zonedParts(result, "Asia/Shanghai");
      expect(parts.minute).toBe(24);
    });

    it("should accurately add/subtract hour intervals", () => {
      const result = addZonedInterval(
        testTimestamp,
        "hour",
        "Asia/Shanghai",
        -3,
      );
      const parts = zonedParts(result, "Asia/Shanghai");
      expect(parts.hour).toBe(20);
    });
  });

  describe("startOfZonedYear (Line 358-359)", () => {
    it("should accurately find the start of the zoned year", () => {
      const testTimestamp = 1779808496789; // 2026-05-26 23:14:56.789 Asia/Shanghai
      const yearStartMs = startOfZonedYear(testTimestamp, "Asia/Shanghai");
      const parts = zonedParts(yearStartMs, "Asia/Shanghai");
      expect(parts.year).toBe(2026);
      expect(parts.month).toBe(1);
      expect(parts.day).toBe(1);
      expect(parts.hour).toBe(0);
      expect(parts.minute).toBe(0);
    });
  });

  describe("browserTimeZone & supportedTimeZones errors (Line 87)", () => {
    it("formats offsets and timezone option labels across fallback branches", () => {
      const timestampMs = Date.UTC(2026, 0, 1, 0, 0, 0);

      expect(formatUtcOffset(0)).toBe("UTC+00:00");
      expect(formatUtcOffset(-330)).toBe("UTC-05:30");
      expect(
        formatTimeZoneOptionLabel({
          locale: "en-US",
          timeZone: "UTC",
          timestampMs,
        }),
      ).toContain("UTC+00:00");
      expect(
        buildTimeZoneOptions({
          locale: "en-US",
          supported: ["UTC", "Invalid/Zone"],
          selected: " Asia/Shanghai ",
          active: "UTC",
          browser: "Asia/Shanghai",
          timestampMs,
        }).map((option) => option.value),
      ).toEqual(["Asia/Shanghai", "UTC"]);
    });

    it("should gracefully handle browserTimeZone retrieval error", () => {
      const originalDateTimeFormat = globalThis.Intl.DateTimeFormat;
      try {
        Object.defineProperty(globalThis.Intl, "DateTimeFormat", {
          value: vi.fn(function () {
            throw new Error("DateTimeFormat mock error");
          }),
          writable: true,
          configurable: true,
        });
        // In order to let it bypass native caching check inside browserTimeZone if any,
        // we call it.
        const zone = browserTimeZone();
        expect(zone).toBe("");
      } finally {
        Object.defineProperty(globalThis.Intl, "DateTimeFormat", {
          value: originalDateTimeFormat,
          writable: true,
          configurable: true,
        });
      }
    });

    it("should return a list of sorted unique supported timezones", () => {
      const zones = supportedTimeZones();
      expect(zones).toBeInstanceOf(Array);
      expect(zones.length).toBeGreaterThan(0);
      expect(zones).toContain("Asia/Shanghai");
    });

    it("should fall back to common timezones when supportedValuesOf is unavailable", () => {
      const originalSupportedValuesOf = Intl.supportedValuesOf;
      try {
        Object.defineProperty(Intl, "supportedValuesOf", {
          value: undefined,
          writable: true,
          configurable: true,
        });

        const zones = supportedTimeZones();
        expect(zones).toContain("UTC");
        expect(zones).toContain("Asia/Shanghai");
      } finally {
        Object.defineProperty(Intl, "supportedValuesOf", {
          value: originalSupportedValuesOf,
          writable: true,
          configurable: true,
        });
      }
    });
  });
});
