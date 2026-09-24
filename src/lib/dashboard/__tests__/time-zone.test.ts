import { describe, expect, it, vi } from "vitest";

import {
  browserTimeZone,
  REPORTING_TIME_ZONE_COOKIE,
  writeReportingTimeZoneCookie,
} from "@/lib/dashboard/time-zone";
describe("Dashboard time zone preferences", () => {
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

  it("gracefully handles browser time zone retrieval errors", () => {
    const originalDateTimeFormat = globalThis.Intl.DateTimeFormat;
    try {
      Object.defineProperty(globalThis.Intl, "DateTimeFormat", {
        value: vi.fn(function () {
          throw new Error("DateTimeFormat mock error");
        }),
        writable: true,
        configurable: true,
      });
      expect(browserTimeZone()).toBe("");
    } finally {
      Object.defineProperty(globalThis.Intl, "DateTimeFormat", {
        value: originalDateTimeFormat,
        writable: true,
        configurable: true,
      });
    }
  });
});
