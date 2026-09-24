import type * as ReactModule from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  useQuery: vi.fn(),
  searchParams: vi.fn(),
  fetchOverview: vi.fn(),
  fetchTrend: vi.fn(),
}));

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof ReactModule>();
  return { ...actual, useMemo: (factory: () => unknown) => factory() };
});
vi.mock("@tanstack/react-query", () => ({
  keepPreviousData: "keep-previous-data",
  useQuery: mocks.useQuery,
}));
vi.mock("@/lib/dashboard/client/data/index", () => ({
  fetchOverview: mocks.fetchOverview,
  fetchTrend: mocks.fetchTrend,
}));
vi.mock("@/lib/dashboard/client/history", () => ({
  useLiveSearchParams: mocks.searchParams,
}));

import { EMPTY_DASHBOARD_FILTER_DOCUMENT } from "@/lib/dashboard/filter-state";
import type { TimeWindow } from "@/lib/dashboard/query-state";

import {
  useOverviewComparisonQuery,
  useOverviewSummaryQuery,
} from "./metrics-data";

const timeWindow: TimeWindow = {
  preset: "custom",
  from: 0,
  to: 1_000,
  interval: "day",
  timeZone: "UTC",
};
const filters = EMPTY_DASHBOARD_FILTER_DOCUMENT;
const detail = { interval: "day", data: [{ timestampMs: 10, views: 4 }] };

function summaryQuery(comparisonQuery: unknown = null) {
  mocks.useQuery.mockImplementation((options: unknown) => options);
  // useMemo is mocked above so the hook query function can be called directly.
  // eslint-disable-next-line react-hooks/rules-of-hooks
  return useOverviewSummaryQuery({
    siteId: "site-1",
    window: timeWindow,
    filters,
    comparisonQuery: comparisonQuery as never,
  }) as unknown as {
    queryFn: (context: {
      signal: AbortSignal;
    }) => Promise<Record<string, unknown>>;
    queryKey: unknown[];
    enabled: boolean;
    placeholderData: unknown;
  };
}

const queryContext = { signal: new AbortController().signal };

beforeEach(() => {
  mocks.useQuery.mockReset();
  mocks.searchParams.mockReset();
  mocks.fetchOverview.mockReset();
  mocks.fetchTrend.mockReset();
});

describe("overview query hooks", () => {
  it("resolves comparison state from live search params and respects disabled queries", () => {
    const comparableWindow = { ...timeWindow, from: 1_000, to: 2_000 };
    mocks.searchParams.mockReturnValue(new URLSearchParams("compare=previous"));
    expect(
      useOverviewComparisonQuery(comparableWindow, filters, false),
    ).toBeNull();
    expect(useOverviewComparisonQuery(comparableWindow, filters)).toMatchObject(
      {
        mode: "previous",
        window: { from: 0, to: 999 },
        filters,
      },
    );

    mocks.searchParams.mockReturnValue(new URLSearchParams("compare=same"));
    expect(useOverviewComparisonQuery(comparableWindow, filters)).toBeNull();
  });

  it("uses embedded previous and detail data without issuing follow-up requests", async () => {
    const current = {
      ok: true,
      data: { views: 10 },
      previousData: { views: 5 },
      detail,
    };
    mocks.fetchOverview.mockResolvedValue(current);
    const options = summaryQuery();
    const result = await options.queryFn(queryContext);

    expect(options.enabled).toBe(true);
    expect(options.placeholderData).toBe("keep-previous-data");
    expect(options.queryKey).toContain("site-1");
    expect(result).toMatchObject({
      overview: current,
      previousOverview: { ok: true, data: { views: 5 } },
      trendData: { interval: "day", data: detail.data },
      dataWindow: { from: 0, to: 1_000, interval: "day", timeZone: "UTC" },
    });
    expect(mocks.fetchOverview).toHaveBeenCalledTimes(1);
    expect(mocks.fetchTrend).not.toHaveBeenCalled();
  });

  it("fetches previous metrics and trend when the overview omits embedded data", async () => {
    mocks.fetchOverview
      .mockResolvedValueOnce({ ok: false, data: { views: 8 } })
      .mockResolvedValueOnce({ ok: true, data: { views: 3 } });
    mocks.fetchTrend.mockResolvedValue({ ok: true, interval: "day", data: [] });
    const options = summaryQuery();
    const result = await options.queryFn(queryContext);

    expect(mocks.fetchOverview).toHaveBeenCalledTimes(2);
    expect(mocks.fetchOverview.mock.calls[1]?.[1]).toMatchObject({
      from: 0,
      to: 0,
    });
    expect(mocks.fetchTrend).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({
      overview: { ok: false },
      previousOverview: { ok: true, data: { views: 3 } },
      trendData: { interval: "day", data: [] },
    });
  });

  it("loads comparison trends independently and returns comparison payloads", async () => {
    const comparisonQuery = {
      mode: "previous",
      window: { ...timeWindow, from: 0, to: 500 },
      filters,
    };
    mocks.fetchOverview
      .mockResolvedValueOnce({ ok: true, data: { views: 10 }, detail })
      .mockResolvedValueOnce({ ok: true, data: { views: 6 } });
    mocks.fetchTrend.mockResolvedValue({
      ok: true,
      interval: "day",
      data: [{ timestampMs: 20 }],
    });
    const options = summaryQuery(comparisonQuery);
    const result = await options.queryFn(queryContext);

    expect(options.queryKey).toContain("previous");
    expect(mocks.fetchOverview).toHaveBeenCalledTimes(2);
    expect(mocks.fetchTrend).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({
      overview: { data: { views: 10 } },
      previousOverview: { ok: true },
      comparisonOverview: { data: { views: 6 } },
      trendData: { data: detail.data },
      comparisonTrendData: { data: [{ timestampMs: 20 }] },
    });
  });

  it("falls back on ordinary request errors and rethrows abort errors", async () => {
    mocks.fetchOverview.mockRejectedValue(new Error("offline"));
    mocks.fetchTrend.mockRejectedValue(new Error("offline"));
    const options = summaryQuery();
    const result = await options.queryFn(queryContext);
    expect(result).toMatchObject({
      overview: { ok: true, data: { views: 0 } },
      previousOverview: { ok: true, data: { views: 0 } },
      trendData: { ok: true, interval: "day", data: [] },
    });

    const abort = new Error("aborted");
    abort.name = "AbortError";
    mocks.fetchOverview.mockRejectedValueOnce(abort);
    await expect(summaryQuery().queryFn(queryContext)).rejects.toBe(abort);
  });
});
