import { describe, expect, it } from "vitest";

import type { AppMessages } from "@/lib/i18n/messages";

import {
  buildOverviewMetricSeries,
  comparisonLabelForQuery,
} from "./metrics-data";

const messages = {
  dashboardHeader: {
    previousPeriod: "Previous period",
    compareButton: "Compare",
  },
} as AppMessages;

describe("overview metric data helpers", () => {
  it("builds base metric series and only derives ratios for non-empty buckets", () => {
    expect(
      buildOverviewMetricSeries([
        {
          timestampMs: 10,
          views: 12,
          visitors: 8,
          sessions: 4,
          bounces: 1,
          avgDurationMs: 2_500,
        },
        {
          timestampMs: 20,
          views: 0,
          visitors: 0,
          sessions: 0,
          bounces: 0,
          avgDurationMs: 0,
        },
      ] as never),
    ).toEqual({
      views: [
        { timestampMs: 10, value: 12 },
        { timestampMs: 20, value: 0 },
      ],
      visitors: [
        { timestampMs: 10, value: 8 },
        { timestampMs: 20, value: 0 },
      ],
      sessions: [
        { timestampMs: 10, value: 4 },
        { timestampMs: 20, value: 0 },
      ],
      bounceRate: [{ timestampMs: 10, value: 0.25 }],
      pagesPerSession: [{ timestampMs: 10, value: 3 }],
      avgDuration: [{ timestampMs: 10, value: 2_500 }],
    });
  });

  it("uses the previous-period label only for unfiltered previous comparisons", () => {
    expect(comparisonLabelForQuery(messages, null)).toBe("Compare");
    expect(
      comparisonLabelForQuery(messages, {
        mode: "previous",
        filters: { root: null },
      } as never),
    ).toBe("Previous period");
    expect(
      comparisonLabelForQuery(messages, {
        mode: "previous",
        filters: { root: { kind: "condition" } },
      } as never),
    ).toBe("Compare");
    expect(
      comparisonLabelForQuery(messages, {
        mode: "same",
        filters: { root: null },
      } as never),
    ).toBe("Compare");
  });
});
