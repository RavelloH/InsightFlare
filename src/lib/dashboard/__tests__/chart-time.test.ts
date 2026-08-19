import { describe, expect, it } from "vitest";

import {
  createChartAxisDateFormatter,
  createChartTooltipDateFormatter,
} from "@/lib/dashboard/chart-time";

describe("chart time formatters", () => {
  const timestampMs = Date.UTC(2026, 7, 19, 4, 5);

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
});
