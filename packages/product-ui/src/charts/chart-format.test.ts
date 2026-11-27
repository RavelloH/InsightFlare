import { describe, expect, it } from "vitest";

import { durationFormat } from "./chart-format";
import {
  createChartAxisDateFormatter,
  createChartTooltipDateFormatter,
} from "./chart-time";

describe("chart durationFormat", () => {
  it("uses the locale's Chinese hour unit", () => {
    expect(durationFormat("zh", 3_600_000)).toBe("1小时");
    expect(durationFormat("zh-tw", 3_600_000)).toBe("1小時");
    expect(durationFormat("ja", 3_600_000)).toBe("1時間");
  });
});

describe("bounded chart date formatter reuse", () => {
  it("shares equivalent options and preserves locale, interval, zone and output", () => {
    const timestamp = Date.UTC(2026, 10, 1, 5, 30);
    const utc = createChartAxisDateFormatter("en", "hour", "UTC");
    expect(createChartAxisDateFormatter("en-US", "minute", "UTC")).toBe(utc);
    expect(createChartAxisDateFormatter("en", "hour", "Asia/Tokyo")).not.toBe(
      utc,
    );
    expect(createChartAxisDateFormatter("ja", "hour", "UTC")).not.toBe(utc);
    expect(createChartAxisDateFormatter("en", "day", "UTC")).not.toBe(utc);
    expect(
      createChartAxisDateFormatter("en", "hour", "UTC", "regular"),
    ).not.toBe(utc);
    expect(utc.format(timestamp)).toBe(
      new Intl.DateTimeFormat("en-US", {
        timeZone: "UTC",
        month: "numeric",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
      }).format(timestamp),
    );
    for (const locale of ["en", "ja", "zh", "zh-tw"]) {
      const tooltip = createChartTooltipDateFormatter(
        locale,
        "day",
        "America/New_York",
      );
      expect(
        createChartTooltipDateFormatter(locale, "week", "America/New_York"),
      ).toBe(tooltip);
      expect(tooltip.resolvedOptions().timeZone).toBe("America/New_York");
      expect(
        tooltip.formatToParts(timestamp).some((part) => part.type === "year"),
      ).toBe(true);
      expect(
        tooltip.formatToParts(timestamp).some((part) => part.type === "hour"),
      ).toBe(false);
    }
  });

  it("evicts old formatters rather than retaining every reporting zone", () => {
    const first = createChartTooltipDateFormatter("en", "hour", "UTC");
    // BCP 47 private-use subtags are valid distinct cache keys. Exercise
    // eviction without relying on a particular ICU timezone database.
    for (let i = 0; i < 64; i++) {
      createChartTooltipDateFormatter("en-US-x-test-" + i, "hour", "UTC");
    }
    const next = createChartTooltipDateFormatter("en", "hour", "UTC");
    expect(next).not.toBe(first);
    expect(next.format(0)).toBe(first.format(0));
  });
});
