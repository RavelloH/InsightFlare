import { describe, expect, it } from "vitest";

import {
  createChartAxisDateFormatter,
  createChartTooltipDateFormatter,
} from "@/lib/dashboard/chart-time";

describe("chart time formatters", () => {
  const timestampMs = Date.UTC(2026, 7, 19, 4, 5);

  function partTypes(formatter: Intl.DateTimeFormat): Set<string> {
    return new Set(
      formatter.formatToParts(new Date(timestampMs)).map((part) => part.type),
    );
  }

  it("formats intraday axis labels in the reporting timezone", () => {
    const formatter = createChartAxisDateFormatter(
      "en",
      "hour",
      "Asia/Shanghai",
    );

    expect(formatter.formatToParts(new Date(timestampMs))).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "month", value: "8" }),
        expect.objectContaining({ type: "day", value: "19" }),
        expect.objectContaining({ type: "hour", value: "12" }),
        expect.objectContaining({ type: "minute", value: "05" }),
      ]),
    );
  });

  it("uses a complete date for non-intraday tooltips", () => {
    const formatter = createChartTooltipDateFormatter("en", "day", "UTC");

    expect(formatter.formatToParts(new Date(timestampMs))).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "year", value: "2026" }),
        expect.objectContaining({ type: "month", value: "Aug" }),
        expect.objectContaining({ type: "day", value: "19" }),
      ]),
    );
  });

  it("formats time-only axis labels", () => {
    expect(
      partTypes(createChartAxisDateFormatter("en", "day", "UTC", "time")),
    ).toEqual(new Set(["hour", "minute", "dayPeriod", "literal"]));
  });

  it("uses regular formats for intraday, calendar, and monthly intervals", () => {
    expect(
      partTypes(createChartAxisDateFormatter("en", "minute", "UTC", "regular")),
    ).toEqual(
      new Set(["month", "day", "hour", "minute", "dayPeriod", "literal"]),
    );
    expect(
      partTypes(createChartAxisDateFormatter("en", "hour", "UTC", "regular")),
    ).toEqual(
      new Set(["month", "day", "hour", "minute", "dayPeriod", "literal"]),
    );
    expect(
      partTypes(createChartAxisDateFormatter("en", "day", "UTC", "regular")),
    ).toEqual(new Set(["month", "day", "literal"]));
    expect(
      partTypes(createChartAxisDateFormatter("en", "week", "UTC", "regular")),
    ).toEqual(new Set(["month", "day", "literal"]));
    expect(
      partTypes(createChartAxisDateFormatter("en", "month", "UTC", "regular")),
    ).toEqual(new Set(["year", "month", "literal"]));
  });

  it("uses compact formats for every dashboard interval", () => {
    for (const interval of ["minute", "hour"] as const) {
      expect(
        partTypes(createChartAxisDateFormatter("en", interval, "UTC")),
      ).toEqual(
        new Set(["month", "day", "hour", "minute", "dayPeriod", "literal"]),
      );
    }
    expect(partTypes(createChartAxisDateFormatter("en", "day", "UTC"))).toEqual(
      new Set(["month", "day", "literal"]),
    );
    expect(
      partTypes(createChartAxisDateFormatter("en", "week", "UTC")),
    ).toEqual(new Set(["year", "month", "day", "literal"]));
    expect(
      partTypes(createChartAxisDateFormatter("en", "month", "UTC")),
    ).toEqual(new Set(["year", "month", "literal"]));
  });

  it("includes time in intraday tooltip formats", () => {
    expect(
      partTypes(createChartTooltipDateFormatter("en", "minute", "UTC")),
    ).toEqual(
      new Set([
        "year",
        "month",
        "day",
        "hour",
        "minute",
        "dayPeriod",
        "literal",
      ]),
    );
    expect(
      partTypes(createChartTooltipDateFormatter("en", "hour", "UTC")),
    ).toEqual(
      new Set([
        "year",
        "month",
        "day",
        "hour",
        "minute",
        "dayPeriod",
        "literal",
      ]),
    );
    for (const interval of ["week", "month"] as const) {
      expect(
        partTypes(createChartTooltipDateFormatter("en", interval, "UTC")),
      ).toEqual(new Set(["year", "month", "day", "literal"]));
    }
  });
});
