import { beforeEach, describe, expect, it, vi } from "vitest";

import type * as FactBuilder from "@/lib/realtime/mock/fact-builder";
import {
  generateDemoFilterOptions,
  generateDemoFilterValues,
} from "@/lib/realtime/mock/filter-options";

const {
  mockAggregateDimensionRowsFromVisits,
  mockApplyDemoFilters,
  mockBuildDemoFactDataset,
  mockCollectClientTabs,
  mockCollectGeoTabs,
  mockCollectPageDataAndTabs,
  mockCollectReferrerRows,
} = vi.hoisted(() => ({
  mockAggregateDimensionRowsFromVisits: vi.fn(),
  mockApplyDemoFilters: vi.fn(),
  mockBuildDemoFactDataset: vi.fn(),
  mockCollectClientTabs: vi.fn(),
  mockCollectGeoTabs: vi.fn(),
  mockCollectPageDataAndTabs: vi.fn(),
  mockCollectReferrerRows: vi.fn(),
}));

vi.mock("@/lib/realtime/mock/fact-builder", async () => {
  const actual = await vi.importActual<typeof FactBuilder>(
    "@/lib/realtime/mock/fact-builder",
  );
  return {
    ...actual,
    aggregateDimensionRowsFromVisits: mockAggregateDimensionRowsFromVisits,
    applyDemoFilters: mockApplyDemoFilters,
    buildDemoFactDataset: mockBuildDemoFactDataset,
    collectClientTabs: mockCollectClientTabs,
    collectGeoTabs: mockCollectGeoTabs,
    collectPageDataAndTabs: mockCollectPageDataAndTabs,
    collectReferrerRows: mockCollectReferrerRows,
  };
});

const SITE_ID = "site-1";

describe("generateDemoFilterOptions branch coverage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockBuildDemoFactDataset.mockReturnValue({ visits: [] });
    mockApplyDemoFilters.mockReturnValue({
      visits: [
        {
          referrerHost: "news.example",
          referrerUrl: "https://news.example/post",
        },
      ],
      sessions: new Set(),
      visitors: new Set(),
      visitsBySession: new Map(),
    });
    mockAggregateDimensionRowsFromVisits.mockReturnValue([]);
    mockCollectPageDataAndTabs.mockReturnValue({ tabs: {} });
    mockCollectReferrerRows.mockReturnValue([]);
    mockCollectClientTabs.mockReturnValue({});
    mockCollectGeoTabs.mockReturnValue({});
  });

  it("dedupes sparse page tab labels and falls back when a selected tab is absent", () => {
    mockCollectPageDataAndTabs.mockReturnValue({
      tabs: {
        path: [
          { label: " /docs " },
          { label: null },
          { label: "/docs" },
          { label: "   " },
          { label: "/pricing" },
        ],
      },
    });

    expect(
      generateDemoFilterOptions(SITE_ID, { filterKey: "path" }).data,
    ).toEqual([
      { value: "/docs", label: "/docs" },
      { value: "/pricing", label: "/pricing" },
    ]);
    expect(
      generateDemoFilterOptions(SITE_ID, { filterKey: "title" }).data,
    ).toEqual([]);
  });

  it("normalizes blank referrer rows to the direct sentinel", () => {
    mockCollectReferrerRows.mockReturnValue([
      { referrer: "" },
      { referrer: null },
      { referrer: " news.example " },
      { referrer: "news.example" },
    ]);

    expect(
      generateDemoFilterOptions(SITE_ID, { filterKey: "sourceDomain" }).data,
    ).toEqual([
      { value: "__direct__", label: "Direct" },
      { value: "news.example", label: "news.example" },
    ]);
    expect(mockCollectReferrerRows).toHaveBeenLastCalledWith(
      expect.any(Object),
      expect.any(Object),
      200,
      { includeFullUrl: false, directValue: "" },
    );

    generateDemoFilterOptions(SITE_ID, { filterKey: "sourceLink" });
    expect(mockCollectReferrerRows).toHaveBeenLastCalledWith(
      expect.any(Object),
      expect.any(Object),
      200,
      { includeFullUrl: true, directValue: "" },
    );
  });

  it("searches demo values for the derived traffic channel field", () => {
    mockApplyDemoFilters.mockReturnValue({
      visits: [
        { referrerHost: "www.google.com", referrerUrl: "" },
        { referrerHost: "", referrerUrl: "", utmMedium: "cpc" },
      ],
      sessions: new Set(),
      visitors: new Set(),
      visitsBySession: new Map(),
    });

    expect(
      generateDemoFilterValues(SITE_ID, {
        filterKey: "traffic.channel",
        search: "organic",
      }).data,
    ).toEqual([
      { value: "organic_search", label: "organic_search", occurrences: 1 },
    ]);
  });

  it("handles missing client tabs and sparse client labels", () => {
    mockCollectClientTabs.mockReturnValue({
      browser: [
        { label: null },
        { label: " Chrome " },
        { label: "Chrome" },
        { label: "Firefox" },
      ],
    });

    expect(
      generateDemoFilterOptions(SITE_ID, { filterKey: "clientBrowser" }).data,
    ).toEqual([
      { value: "Chrome", label: "Chrome" },
      { value: "Firefox", label: "Firefox" },
    ]);
    expect(
      generateDemoFilterOptions(SITE_ID, { filterKey: "clientLanguage" }).data,
    ).toEqual([]);
  });

  it("labels sparse geo rows with segment and value fallbacks", () => {
    mockCollectGeoTabs.mockReturnValue({
      country: [{ label: null }, { label: " US " }, { label: "US" }],
      region: [{ label: "::::" }, { label: "DE::BE" }],
      city: [{ label: "::::" }, { label: "DE::::Berlin" }],
      timezone: [{ label: null }, { label: " Europe/Berlin " }],
    });

    expect(
      generateDemoFilterOptions(SITE_ID, { filterKey: "geo" }).data,
    ).toEqual([
      { value: "US", label: "US", group: "country" },
      { value: "::::", label: "::::", group: "region" },
      { value: "DE::BE", label: "BE", group: "region" },
      { value: "DE::::Berlin", label: "Berlin", group: "city" },
    ]);
    expect(
      generateDemoFilterOptions(SITE_ID, { filterKey: "geoTimezone" }).data,
    ).toEqual([{ value: "Europe/Berlin", label: "Europe/Berlin" }]);
    expect(
      generateDemoFilterOptions(SITE_ID, { filterKey: "geoContinent" }).data,
    ).toEqual([]);
  });
});
