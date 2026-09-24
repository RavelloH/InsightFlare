import { describe, expect, it } from "vitest";

import type { BotEvent } from "@/components/dashboard/admin/request-observation/model";
import {
  BOT_EVENT_DETAIL_SKELETON_DATA,
  isInvalidRequestObservationCursorError,
  latencyFormat,
  nestedMessage,
  NORMAL_REQUEST_DETAIL_SKELETON_DATA,
  normalizeRequestObservationCategory,
  normalizeRequestObservationEvent,
  normalizeRequestObservationTab,
  type RequestObservationData,
  requestObservationDetailId,
  requestObservationUiLabels,
  shortId,
  withRequestObservabilityDefaults,
} from "@/components/dashboard/admin/request-observation/model";
import {
  changeRateClass,
  emptyOverviewMetrics,
  emptySiteMetricChangeRates,
  epochSecondsToMs,
  formatChangeRate,
  formatCountTemplate,
  getSiteSlug,
  normalizeSiteIds,
  safeSlug,
  siteAccessSummary,
  sortSitesForInitialOrder,
  withSiteSlug,
} from "@/components/dashboard/admin/team-management/model";
import {
  formatDateSpan,
  INTERVAL_ORDER,
  intervalDisabledReason,
  intervalLabel,
  RANGE_GROUPS,
  rangeGroupLabel,
  rangeLabel,
  ROLLING_RANGE_PRESETS,
  shiftTimeWindow,
  toCalendarDate,
  toDateRange,
} from "@/components/dashboard/shell/dashboard-header-controls/range";
import {
  eventFieldKey,
  eventFieldValueKey,
  formatFieldValueLabel,
  formatPayloadFilterRules,
  isPayloadFilterActive,
  normalizeEventFieldPath,
  parsePayloadFilterInput,
  payloadFilterValuesEqual,
  payloadFilterValueType,
} from "@/components/dashboard/site-pages/events/event-model";
import {
  buildGeoPagePath,
  buildPagesPagePath,
  canonicalizeGeoFilterValue,
  extractGeoCountryCodeFromFilterValue,
  isGeoLocationTab,
  isPageCardDetailTab,
  parseOverviewCardFilters,
  resolveGeoCityBreadcrumbData,
  resolveGeoDimensionRowRawValue,
  resolveGeoLocationHighlightValue,
  resolveGeoLocationQueryValue,
  resolveGeoRegionBreadcrumbData,
  resolvePageCardDetailPath,
} from "@/components/dashboard/site-pages/overview/overview-filter-model";
import {
  buildRetentionComparisonViewModel,
  buildRetentionViewModel,
  cohortMaxPeriodIndex,
  formatCohortDate,
  formatRetentionChange,
  normalizeGranularity,
  periodLabel,
  retentionActiveFilterCount,
  retentionAverageAt,
  retentionBucketCount,
  retentionCellAt,
  retentionCellStyle,
  retentionChangeClass,
  retentionCohortPosition,
  retentionCohortRowKey,
  retentionCohortRowSortKey,
  retentionComparisonChange,
  retentionIntervalFallbackMs,
  retentionLoadingShape,
} from "@/components/dashboard/site-pages/retention/model";
import {
  averageSessionPerformanceScore,
  createSessionDetailPlaceholder,
  EMPTY_SESSION_PERFORMANCE,
  eventChronologyRank,
  eventDisplayTitle,
  eventKindLabel,
  eventSubtitle,
  eventTitle,
  formatDetailedDateTime,
  formatSessionMetricRange,
  formatSessionMetricValue,
  hasSessionPerformanceSamples,
  pageviewSubtitle,
  SESSION_PERFORMANCE_METRICS,
  sessionMetricDetailRows,
  sessionMetricScore,
  sessionMetricStatus,
  sessionPerformancePanelValue,
  sessionPerformanceSamples,
  sessionPerformanceScore,
  sessionPerformanceStatusLabel,
  sessionScoreDetailRows,
  sessionScoreRange,
  sessionScoreStatus,
} from "@/components/dashboard/site-pages/sessions/session-detail/model";
import { EMPTY_DASHBOARD_FILTER_DOCUMENT } from "@/lib/dashboard/filter-state";
import type { TimeWindow } from "@/lib/dashboard/query-state";
import type {
  JourneyEvent,
  JourneyPerformanceSummary,
  PerformanceMetricKey,
  RetentionData,
  SiteData,
} from "@/lib/dashboard-api/client/edge";
import type { AppMessages } from "@/lib/i18n/messages";

const windowFor = (
  from: number,
  to: number,
  interval: TimeWindow["interval"] = "day",
): TimeWindow => ({
  preset: "custom",
  from,
  to,
  interval,
  timeZone: "UTC",
});

const messages = {
  ranges: {
    last30m: "30m",
    last1h: "1h",
    today: "today",
    yesterday: "yesterday",
    thisWeek: "week",
    thisMonth: "month",
    thisYear: "year",
    last24h: "24h",
    last7d: "7d",
    last30d: "30d",
    last90d: "90d",
    last6m: "6m",
    last12m: "12m",
    custom: "custom",
  },
  intervals: {
    minute: "minute",
    hour: "hour",
    day: "day",
    week: "week",
    month: "month",
  },
  dashboardHeader: {
    rangeGroupQuick: "quick",
    rangeGroupCalendar: "calendar",
    rangeGroupRolling: "rolling",
    rangeGroupAdvanced: "advanced",
    intervalDisabledMinute: "minute disabled",
    intervalDisabledHour: "hour disabled",
    intervalDisabledDay: "day disabled",
    intervalDisabledWeek: "week disabled",
  },
  retention: { periodLabel: "Period {n}" },
  performance: {
    great: "great",
    needsImprovement: "needs improvement",
    poor: "poor",
    clsUnit: "score",
    msUnit: "ms",
    secondsUnit: "s",
    samplesLabel: "samples",
  },
  common: { noData: "no data" },
} as unknown as AppMessages;

const retentionLabels = {
  periodZero: "cohort",
} as AppMessages["retention"];

const sessionLabels = {
  sessionStarted: "started",
  pageview: "page",
  exitPage: "exit",
  customEvent: "custom",
  eventTitleSeparator: ": ",
  range: "range",
} as AppMessages["sessionDetail"];

describe("dashboard domain model helpers", () => {
  it("normalizes and formats event field paths and values", () => {
    expect(normalizeEventFieldPath("  ")).toBe("");
    expect(normalizeEventFieldPath("/")).toBe("");
    expect(normalizeEventFieldPath("/a//b")).toBe("/a/b");
    expect(normalizeEventFieldPath("a/b")).toBe("/a/b");
    expect(eventFieldKey({ path: "a//b", valueType: "string" })).toBe(
      "string\u0000/a//b",
    );
    expect(eventFieldValueKey("value")).toBe('"value"');
    expect(formatFieldValueLabel(null)).toBe("null");
    expect(formatFieldValueLabel("")).toBe('""');
    expect(formatFieldValueLabel("hello")).toBe("hello");
    expect(formatFieldValueLabel(false)).toBe("false");
  });

  it("parses, formats, and matches payload filters across value types", () => {
    expect(payloadFilterValueType(null)).toBe("null");
    expect(payloadFilterValueType(2)).toBe("number");
    expect(payloadFilterValueType(true)).toBe("boolean");
    expect(payloadFilterValueType("2")).toBe("string");
    expect(payloadFilterValuesEqual(2, "2")).toBe(true);
    expect(payloadFilterValuesEqual("2", "2")).toBe(true);
    expect(payloadFilterValuesEqual("2", 2)).toBe(true);

    const parsed = parsePayloadFilterInput(
      '$.items[*].name == "Ada" && active != false\ncount == 2\nempty == null',
    );
    expect(parsed).toEqual({
      ok: true,
      rules: [
        { path: "/items/*/name", operator: "eq", value: "Ada" },
        { path: "/active", operator: "neq", value: false },
        { path: "/count", operator: "eq", value: 2 },
        { path: "/empty", operator: "eq", value: null },
      ],
    });
    expect(parsePayloadFilterInput("value == 'it\\'s' ").ok).toBe(true);
    expect(parsePayloadFilterInput("broken")).toEqual({ ok: false });
    expect(parsePayloadFilterInput("/ == 1")).toEqual({ ok: false });
    expect(parsePayloadFilterInput('value == "foo"bar"')).toEqual({
      ok: false,
    });
    if (parsed.ok) {
      expect(formatPayloadFilterRules(parsed.rules)).toContain(
        'items.*.name == "Ada"',
      );
      expect(isPayloadFilterActive(parsed.rules, "/count", 2)).toBe(true);
      expect(isPayloadFilterActive(parsed.rules, "/count", "2")).toBe(false);
    }
  });

  it("normalizes dashboard date ranges and shifts windows safely", () => {
    expect(ROLLING_RANGE_PRESETS.has("30d")).toBe(true);
    expect(ROLLING_RANGE_PRESETS.has("custom")).toBe(false);
    expect(INTERVAL_ORDER).toEqual(["minute", "hour", "day", "week", "month"]);
    expect(RANGE_GROUPS.map(({ key }) => key)).toEqual([
      "quick",
      "calendar",
      "rolling",
      "advanced",
    ]);
    expect(rangeLabel(messages, "30m")).toBe("30m");
    expect(rangeLabel(messages, "custom")).toBe("custom");
    expect(rangeLabel(messages, "6m")).toBe("6m");
    expect(rangeLabel(messages, "12m")).toBe("12m");
    expect(intervalLabel(messages, "minute")).toBe("minute");
    expect(intervalLabel(messages, "month")).toBe("month");
    expect(rangeGroupLabel(messages, "quick")).toBe("quick");
    expect(rangeGroupLabel(messages, "calendar")).toBe("calendar");
    expect(rangeGroupLabel(messages, "rolling")).toBe("rolling");
    expect(rangeGroupLabel(messages, "advanced")).toBe("advanced");
    expect(intervalDisabledReason(messages, "minute")).toBe("minute disabled");
    expect(intervalDisabledReason(messages, "hour")).toBe("hour disabled");
    expect(intervalDisabledReason(messages, "day")).toBe("day disabled");
    expect(intervalDisabledReason(messages, "week")).toBe("week disabled");
    expect(intervalDisabledReason(messages, "month")).toBe("");

    expect(toCalendarDate(Number.NaN, "UTC")).toBeNull();
    expect(toCalendarDate(Date.UTC(2024, 4, 6), "UTC")?.getDate()).toBe(6);
    expect(toDateRange(undefined, 1, "UTC")).toBeUndefined();
    expect(
      toDateRange(Date.UTC(2024, 4, 6), Date.UTC(2024, 4, 7), "UTC"),
    ).toMatchObject({ from: new Date(2024, 4, 6), to: new Date(2024, 4, 7) });
    expect(formatDateSpan("en", "UTC", undefined, 1)).toBe("");
    expect(
      formatDateSpan("en", "UTC", Date.UTC(2024, 4, 6), Date.UTC(2024, 4, 7)),
    ).toContain(" - ");
    expect(shiftTimeWindow(100, 200, "previous", 500)).toEqual({
      from: 0,
      to: 99,
    });
    expect(shiftTimeWindow(0, 1, "previous", 500)).toBeNull();
    expect(shiftTimeWindow(100, 200, "next", 500)).toEqual({
      from: 201,
      to: 301,
    });
    expect(shiftTimeWindow(100, 200, "next", 201)).toEqual({
      from: 101,
      to: 201,
    });
  });

  it("builds retention cohorts, comparisons, loading shapes, and cell styles", () => {
    const start = Date.UTC(2024, 0, 1);
    const window = windowFor(start, start + 2 * 86_400_000);
    const comparisonWindow = windowFor(
      start + 86_400_000,
      start + 3 * 86_400_000,
    );
    const cohort = {
      bucket: start,
      size: 4,
      periods: [
        { index: 0, visitors: 4, rate: 1 },
        { index: 1, visitors: 2, rate: 0.5 },
      ],
    };
    const payload = {
      ok: true,
      granularity: "day",
      cohorts: [cohort, { bucket: start, size: 0, periods: [] }],
    } as RetentionData;

    expect(normalizeGranularity("hour")).toBe("hour");
    expect(normalizeGranularity("invalid")).toBe("week");
    expect(formatCohortDate("en", "day", Number.NaN, "UTC")).toBe("--");
    expect(formatCohortDate("en", "month", start, "UTC")).toContain("2024");
    expect(formatCohortDate("en", "minute", start, "UTC")).toContain("1");
    expect(periodLabel(messages, retentionLabels, 0)).toBe("cohort");
    expect(periodLabel(messages, retentionLabels, 2)).toBe("Period 2");
    expect(retentionIntervalFallbackMs("minute")).toBe(60_000);
    expect(retentionIntervalFallbackMs("hour")).toBe(3_600_000);
    expect(retentionIntervalFallbackMs("day")).toBe(86_400_000);
    expect(retentionIntervalFallbackMs("week")).toBe(604_800_000);
    expect(retentionIntervalFallbackMs("month")).toBe(2_678_400_000);
    expect(retentionBucketCount(window, "day")).toBe(3);
    expect(
      retentionBucketCount(windowFor(Number.NaN, start, "day"), "day"),
    ).toBe(1);
    expect(retentionActiveFilterCount(EMPTY_DASHBOARD_FILTER_DOCUMENT)).toBe(0);
    expect(
      retentionLoadingShape(window, "day", EMPTY_DASHBOARD_FILTER_DOCUMENT),
    ).toEqual({ rows: 4, columns: 3 });
    expect(cohortMaxPeriodIndex(cohort, start + 86_400_000, "day", "UTC")).toBe(
      1,
    );
    expect(
      cohortMaxPeriodIndex(
        { ...cohort, bucket: Number.NaN },
        start,
        "day",
        "UTC",
      ),
    ).toBe(0);

    const current = buildRetentionViewModel(
      payload,
      "en",
      messages,
      retentionLabels,
      "day",
      window,
    );
    const empty = buildRetentionViewModel(
      null,
      "en",
      messages,
      retentionLabels,
      "day",
      window,
    );
    expect(current.summary).toMatchObject({
      cohortCount: 1,
      totalVisitors: 4,
      periodOneBase: 4,
      periodOneRate: 0.5,
      strongestCohort: { rate: 0.25 },
    });
    expect(empty.summary.strongestCohort).toBeNull();
    expect(current.cohorts[0]?.cells[2]?.available).toBe(true);
    expect(retentionCohortPosition(window, "day", start)).toBe(0);
    expect(retentionCohortPosition(window, "day", start - 1)).toBeNull();
    expect(retentionCohortPosition(window, "day", Number.NaN)).toBeNull();
    expect(retentionCohortRowKey(window, "day", current.cohorts[0]!)).toBe(
      "position:0",
    );
    expect(retentionCohortRowSortKey(window, "day", current.cohorts[0]!)).toBe(
      0,
    );
    expect(retentionCellAt(null, 2)).toMatchObject({
      available: false,
      index: 2,
    });
    expect(retentionCellAt(current.cohorts[0]!, 0)).toMatchObject({
      visitors: 4,
    });
    expect(retentionAverageAt(empty, 3)).toMatchObject({
      index: 3,
      rate: null,
    });
    expect(retentionAverageAt(current, 0).rate).toBe(1);
    expect(retentionComparisonChange(0.5, 0.25)).toBe(100);
    expect(retentionComparisonChange(1, 0)).toBeNull();
    expect(retentionComparisonChange(null, 1)).toBeNull();
    expect(formatRetentionChange(2)).toBe("+2.0%");
    expect(formatRetentionChange(-2)).toBe("-2.0%");
    expect(formatRetentionChange(Number.NaN)).toBeNull();
    expect(retentionChangeClass(null)).toBe("text-muted-foreground");
    expect(retentionChangeClass(1)).toContain("emerald");
    expect(retentionChangeClass(-1)).toContain("rose");
    expect(retentionCellStyle(0.5, false)).toEqual({});
    expect(retentionCellStyle(0, true).backgroundColor).toContain("color-mix");
    expect(retentionCellStyle(0.05, true).backgroundColor).toContain("chart-4");
    expect(retentionCellStyle(0.8, true).color).toBe("oklch(0.985 0 0)");

    const comparison = buildRetentionViewModel(
      { ...payload, cohorts: [{ ...cohort, bucket: start + 86_400_000 }] },
      "en",
      messages,
      retentionLabels,
      "day",
      comparisonWindow,
    );
    const combined = buildRetentionComparisonViewModel(
      current,
      comparison,
      window,
      comparisonWindow,
      "day",
    );
    expect(combined.columns).toEqual([0, 1, 2]);
    expect(combined.rows[0]).toMatchObject({
      current: current.cohorts[0],
      comparison: comparison.cohorts[0],
    });
  });

  it("formats session events and performance scores for every status", () => {
    const event = (kind: string, extra: Record<string, unknown> = {}) =>
      ({
        id: kind,
        kind,
        occurredAt: Date.UTC(2024, 0, 1),
        durationMs: 1000,
        pathname: "/page",
        hash: "part",
        title: " Page title ",
        hostname: "host.test",
        eventType: " purchase ",
        ...extra,
      }) as JourneyEvent;
    const start = event("session_start");
    const page = event("pageview");
    const leave = event("leave");
    const custom = event("custom");
    expect(eventKindLabel(sessionLabels, start)).toBe("started");
    expect(eventKindLabel(sessionLabels, page)).toBe("page");
    expect(eventKindLabel(sessionLabels, leave)).toBe("exit");
    expect(eventKindLabel(sessionLabels, custom)).toBe("custom");
    expect(eventTitle(sessionLabels, start)).toBe("started");
    expect(eventTitle(sessionLabels, page)).toContain("/page");
    expect(eventTitle(sessionLabels, custom)).toBe("purchase");
    expect(eventDisplayTitle(sessionLabels, start)).toBe("started");
    expect(eventDisplayTitle(sessionLabels, custom)).toBe("custom: purchase");
    expect(eventChronologyRank(start)).toBe(0);
    expect(eventChronologyRank(page)).toBe(1);
    expect(eventChronologyRank(custom)).toBe(2);
    expect(eventChronologyRank(leave)).toBe(3);
    expect(formatDetailedDateTime("en", 0, "UTC")).toBe("--");
    expect(formatDetailedDateTime("en", start.occurredAt, "UTC")).not.toBe(
      "--",
    );
    expect(pageviewSubtitle("en", page, "Unknown")).toContain("Page title");
    expect(
      pageviewSubtitle(
        "en",
        event("pageview", { title: "", hostname: "" }),
        "Unknown",
      ),
    ).toBe("Unknown · 1s");
    expect(eventSubtitle("en", start, "Unknown", "UTC")).not.toBe("--");
    expect(eventSubtitle("en", leave, "Unknown", "UTC")).not.toBe("--");
    expect(eventSubtitle("en", page, "Unknown", "UTC")).toContain("Page title");
    expect(eventSubtitle("en", custom, "Unknown", "UTC")).toBe("Page title");

    expect(createSessionDetailPlaceholder("s1").session.sessionId).toBe("s1");
    expect(EMPTY_SESSION_PERFORMANCE.ttfb.samples).toBe(0);
    expect(SESSION_PERFORMANCE_METRICS).toHaveLength(5);
    expect(sessionScoreStatus(null)).toBe("none");
    expect(sessionScoreStatus(90)).toBe("great");
    expect(sessionScoreStatus(50)).toBe("needs-improvement");
    expect(sessionScoreStatus(49)).toBe("poor");
    expect(sessionMetricStatus("ttfb", null)).toBe("none");
    expect(sessionMetricStatus("ttfb", 800)).toBe("great");
    expect(sessionMetricStatus("ttfb", 1800)).toBe("needs-improvement");
    expect(sessionMetricStatus("ttfb", 1801)).toBe("poor");
    expect(sessionMetricScore("ttfb", Number.NaN)).toBeNull();
    expect(sessionMetricScore("ttfb", 400)).toBe(95);
    expect(sessionMetricScore("ttfb", 1300)).toBe(70);
    expect(sessionMetricScore("ttfb", 2400)).toBeCloseTo(33.33, 2);
    expect(averageSessionPerformanceScore([null, Number.NaN])).toBeNull();
    expect(averageSessionPerformanceScore([50, 100])).toBe(75);
    const performance = {
      ttfb: { avg: 400, p75: 500, min: 100, max: 900, samples: 4 },
      fcp: { avg: 1000, p75: 1200, min: 800, max: 1500, samples: 2 },
    } as JourneyPerformanceSummary;
    expect(sessionPerformanceScore(performance)).not.toBeNull();
    expect(sessionPerformanceSamples(performance)).toBe(4);
    expect(hasSessionPerformanceSamples(performance)).toBe(true);
    expect(hasSessionPerformanceSamples(EMPTY_SESSION_PERFORMANCE)).toBe(false);
    expect(sessionPerformanceStatusLabel(messages, "great")).toBe("great");
    expect(sessionPerformanceStatusLabel(messages, "needs-improvement")).toBe(
      "needs improvement",
    );
    expect(sessionPerformanceStatusLabel(messages, "poor")).toBe("poor");
    expect(sessionPerformanceStatusLabel(messages, "none")).toBe("no data");
    expect(formatSessionMetricValue("en", messages, "cls", 0.1234)).toContain(
      "score",
    );
    expect(formatSessionMetricValue("en", messages, "inp", 250)).toContain(
      "ms",
    );
    expect(formatSessionMetricValue("en", messages, "ttfb", 1250)).toContain(
      "s",
    );
    expect(formatSessionMetricValue("en", messages, "ttfb", null)).toBe("--");
    expect(sessionPerformancePanelValue("en", messages, "score", 90.4)).toBe(
      "90",
    );
    expect(sessionPerformancePanelValue("en", messages, "score", null)).toBe(
      "--",
    );
    expect(
      formatSessionMetricRange("en", messages, "ttfb", performance.ttfb!),
    ).toContain(" - ");
    expect(
      formatSessionMetricRange(
        "en",
        messages,
        "ttfb",
        EMPTY_SESSION_PERFORMANCE.ttfb,
      ),
    ).toBe("--");
    expect(sessionScoreRange()).toBe("0 - 100");
    expect(
      sessionMetricDetailRows(
        "en",
        messages,
        sessionLabels,
        "ttfb",
        performance.ttfb!,
      ),
    ).toHaveLength(2);
    expect(
      sessionScoreDetailRows("en", messages, sessionLabels, 3),
    ).toHaveLength(2);
  });

  it("covers site-management metric, slug, sorting, and access helpers", () => {
    expect(emptyOverviewMetrics().views).toBe(0);
    expect(emptySiteMetricChangeRates().views).toBeNull();
    expect(formatChangeRate(null)).toBeNull();
    expect(formatChangeRate(1.25)).toBe("+1.3%");
    expect(formatChangeRate(-1.25)).toBe("-1.3%");
    expect(changeRateClass(null)).toContain("muted");
    expect(changeRateClass(2)).toContain("emerald");
    expect(changeRateClass(-2)).toContain("rose");
    expect(changeRateClass(-2, true)).toContain("emerald");
    expect(epochSecondsToMs(10)).toBe(10_000);
    expect(epochSecondsToMs(100_000_000_000)).toBe(100_000_000_000);
    expect(safeSlug(" My Site.EXAMPLE ")).toBe("my-site-example");
    const emptyDomain = { id: "abcdefgh-1", domain: "!!!" } as SiteData;
    expect(getSiteSlug(emptyDomain)).toBe("abcdefgh");
    const site = { id: "id1", domain: "example.com" } as SiteData;
    expect(withSiteSlug(site).slug).toBe("example-com");
    expect(
      sortSitesForInitialOrder([
        { id: "b", name: "Beta", overview: { views: 2, visitors: 1 } },
        { id: "a", name: "alpha", overview: { views: 2, visitors: 1 } },
        { id: "c", name: "Zed", overview: { views: 1, visitors: 5 } },
      ]).map((item) => item.id),
    ).toEqual(["a", "b", "c"]);
    expect(normalizeSiteIds(["a", " a ", null, "", 2, "b"])).toEqual([
      "a",
      "2",
      "b",
    ]);
    expect(normalizeSiteIds(null)).toEqual([]);
    expect(formatCountTemplate("{count} sites", 3)).toBe("3 sites");
    expect(siteAccessSummary([], [], { siteAccessAll: "all" } as never)).toBe(
      "all",
    );
    expect(
      siteAccessSummary(
        ["a", "missing"],
        [{ id: "a", name: "Alpha", domain: "a.test" }],
        { siteAccessSelected: "{count} selected" } as never,
      ),
    ).toBe("2 selected");
  });

  it("normalizes overview geo filters, breadcrumbs, and page paths", () => {
    expect(extractGeoCountryCodeFromFilterValue(null)).toBeNull();
    expect(extractGeoCountryCodeFromFilterValue("  us::ca::California ")).toBe(
      "US",
    );
    expect(extractGeoCountryCodeFromFilterValue("California")).toBeNull();
    expect(parseOverviewCardFilters(new URLSearchParams()).root).toBeNull();
    expect(isGeoLocationTab("country")).toBe(true);
    expect(isGeoLocationTab("organization")).toBe(false);
    expect(canonicalizeGeoFilterValue(null)).toBeNull();
    expect(canonicalizeGeoFilterValue(" us::ca::California ")).toBe(
      "US::CA::California",
    );
    expect(
      resolveGeoLocationHighlightValue(
        "country",
        "US::CA::California::San Francisco",
      ),
    ).toBe("US");
    expect(
      resolveGeoLocationHighlightValue(
        "region",
        "US::CA::California::San Francisco",
      ),
    ).toBe("US::CA::California");
    expect(resolveGeoLocationHighlightValue("region", "US::CA")).toBeNull();
    expect(resolveGeoLocationHighlightValue("country", null)).toBeNull();
    expect(resolveGeoLocationHighlightValue("city", "::")).toBeNull();
    expect(
      resolveGeoLocationHighlightValue(
        "city",
        "US::CA::California::San Francisco",
      ),
    ).toBe("US::CA::California::San Francisco");
    expect(resolveGeoLocationHighlightValue("city", "US::CA")).toBeNull();

    const region = resolveGeoRegionBreadcrumbData(
      "US::CA::California",
      "en",
      "Unknown",
    );
    expect(region.breadcrumb.hideRegion).toBe(false);
    expect(region.filterValue).toContain("US::CA");
    expect(
      resolveGeoRegionBreadcrumbData("US", "en", "Unknown").breadcrumb
        .hideRegion,
    ).toBe(true);
    expect(
      resolveGeoRegionBreadcrumbData("US::California", "en", "Unknown"),
    ).toMatchObject({
      breadcrumb: { hideRegion: false, stateCode: "" },
    });
    expect(
      resolveGeoRegionBreadcrumbData("::CA::California", "en", "Unknown")
        .breadcrumb.countryIconName,
    ).toBeNull();

    expect(
      resolveGeoCityBreadcrumbData("San Francisco", "en", "Unknown"),
    ).toMatchObject({ breadcrumb: null, displayLabel: "San Francisco" });
    expect(
      resolveGeoCityBreadcrumbData("bad::", "en", "Unknown").breadcrumb,
    ).toBeNull();
    expect(
      resolveGeoCityBreadcrumbData("US::San Francisco", "en", "Unknown")
        .breadcrumb,
    ).toMatchObject({ hideRegion: true, hideCity: false });
    expect(
      resolveGeoCityBreadcrumbData("US::United States", "en", "Unknown")
        .breadcrumb,
    ).toMatchObject({ hideCity: true });
    expect(
      resolveGeoCityBreadcrumbData("US::", "en", "Unknown").breadcrumb,
    ).toBeNull();
    expect(
      resolveGeoCityBreadcrumbData("USA::Los Angeles", "en", "Unknown")
        .breadcrumb,
    ).toBeNull();
    expect(
      resolveGeoCityBreadcrumbData(
        "US::CA::California::California",
        "en",
        "Unknown",
      ),
    ).toMatchObject({ breadcrumb: { hideCity: true, hideRegion: false } });
    expect(
      resolveGeoCityBreadcrumbData("US::::Unknown", "en", "Unknown"),
    ).toMatchObject({ breadcrumb: { hideRegion: true, cityLabel: "Unknown" } });
    expect(
      resolveGeoCityBreadcrumbData(
        "US::CA::California::San Francisco",
        "en",
        "Unknown",
      ).breadcrumb,
    ).toMatchObject({ hideRegion: false, hideCity: false });
    expect(
      resolveGeoCityBreadcrumbData(
        "::CA::California::Springfield",
        "en",
        "Unknown",
      ),
    ).toMatchObject({
      filterValue: "Springfield",
      breadcrumb: { countryCode: "" },
    });

    const row = (values: Record<string, unknown>) =>
      ({
        key: "k",
        label: "California",
        views: 1,
        visitors: 1,
        mono: false,
        ...values,
      }) as never;
    expect(
      resolveGeoLocationQueryValue(
        "country",
        row({ rawLabel: "us" }),
        "Unknown",
      ),
    ).toBe("US");
    expect(
      resolveGeoLocationQueryValue(
        "region",
        row({ rawLabel: "US::CA::California" }),
        "Unknown",
      ),
    ).toContain("US::CA");
    expect(
      resolveGeoLocationQueryValue(
        "region",
        row({ regionBreadcrumb: { hideRegion: true, countryCode: "us" } }),
        "Unknown",
      ),
    ).toBe("US");
    expect(resolveGeoLocationQueryValue("timezone", row({}), "Unknown")).toBe(
      null,
    );
    expect(
      resolveGeoLocationQueryValue(
        "country",
        row({ rawLabel: "Unknown" }),
        "Unknown",
      ),
    ).toBeNull();
    expect(
      resolveGeoLocationQueryValue(
        "region",
        row({
          regionBreadcrumb: {
            hideRegion: false,
            countryCode: "US",
            stateCode: "",
            regionLabel: "California",
          },
        }),
        "Unknown",
      ),
    ).toContain("US::CALIFORNIA");
    expect(
      resolveGeoLocationQueryValue(
        "country",
        row({ rawLabel: "", label: "US" }),
        "Unknown",
      ),
    ).toBe("US");
    expect(
      resolveGeoLocationQueryValue(
        "region",
        row({ rawLabel: "US" }),
        "Unknown",
      ),
    ).toBeNull();
    expect(
      resolveGeoLocationQueryValue(
        "region",
        row({ regionBreadcrumb: { hideRegion: true, countryCode: " " } }),
        "Unknown",
      ),
    ).toBeNull();
    expect(
      resolveGeoLocationQueryValue(
        "region",
        row({
          regionBreadcrumb: {
            hideRegion: false,
            countryCode: "US",
            stateCode: "CA",
            regionLabel: "Unknown",
          },
        }),
        "Unknown",
      ),
    ).toBeNull();
    expect(
      resolveGeoLocationQueryValue(
        "city",
        row({ label: "Unknown" }),
        "Unknown",
      ),
    ).toBeNull();
    expect(
      resolveGeoLocationQueryValue(
        "city",
        row({
          cityBreadcrumb: {
            hideRegion: true,
            hideCity: false,
            countryCode: "US",
            cityNameDefault: "",
          },
        }),
        "Unknown",
      ),
    ).toBe("US");
    expect(
      resolveGeoLocationQueryValue(
        "city",
        row({
          cityBreadcrumb: {
            hideRegion: false,
            hideCity: false,
            countryCode: "Unknown",
            stateCode: "CA",
            regionLabel: "California",
            cityNameDefault: "San Francisco",
          },
        }),
        "Unknown",
      ),
    ).toBeNull();
    expect(
      resolveGeoLocationQueryValue(
        "city",
        row({ rawLabel: "US::CA::California::San Francisco" }),
        "Unknown",
      ),
    ).toContain("San Francisco");
    expect(
      resolveGeoLocationQueryValue(
        "city",
        row({
          cityBreadcrumb: {
            hideRegion: true,
            hideCity: true,
            countryCode: "US",
            cityNameDefault: "United States",
          },
        }),
        "Unknown",
      ),
    ).toBe("US");
    expect(resolveGeoLocationQueryValue("city", row({}), "Unknown")).toBeNull();
    expect(
      resolveGeoLocationQueryValue(
        "city",
        row({ cityBreadcrumb: { hideRegion: true, countryCode: " " } }),
        "Unknown",
      ),
    ).toBeNull();
    expect(
      resolveGeoLocationQueryValue(
        "city",
        row({
          cityBreadcrumb: {
            hideRegion: false,
            countryCode: "US",
            regionLabel: "Unknown",
            cityNameDefault: "San Francisco",
          },
        }),
        "Unknown",
      ),
    ).toBeNull();
    expect(
      resolveGeoLocationQueryValue(
        "city",
        row({
          cityBreadcrumb: {
            hideRegion: true,
            hideCity: false,
            countryCode: "us",
            cityNameDefault: "Unknown",
          },
        }),
        "Unknown",
      ),
    ).toBe("US");
    expect(
      resolveGeoLocationQueryValue(
        "city",
        row({
          cityBreadcrumb: {
            hideRegion: true,
            hideCity: false,
            countryCode: "us",
            cityNameDefault: "San Francisco",
          },
        }),
        "Unknown",
      ),
    ).toContain("US::San Francisco");
    expect(
      resolveGeoLocationQueryValue(
        "city",
        row({
          cityBreadcrumb: {
            hideRegion: false,
            hideCity: false,
            countryCode: "us",
            stateCode: "CA",
            regionLabel: "California",
            cityNameDefault: "Unknown",
          },
        }),
        "Unknown",
      ),
    ).toBeNull();
    expect(
      resolveGeoLocationQueryValue(
        "city",
        row({
          cityBreadcrumb: {
            hideRegion: false,
            hideCity: false,
            countryCode: "us",
            stateCode: "CA",
            regionLabel: "California",
            cityNameDefault: "San Francisco",
          },
        }),
        "Unknown",
      ),
    ).toContain("US::CA::California::San Francisco");
    expect(resolveGeoDimensionRowRawValue({ label: " fallback " })).toBe(
      "fallback",
    );
    expect(resolveGeoDimensionRowRawValue({ value: " raw " })).toBe("raw");
    expect(buildGeoPagePath(" /team/site/ ")).toBe("/team/site/geo");
    expect(buildGeoPagePath("/geo")).toBe("/geo");
    expect(buildPagesPagePath("")).toBe("/pages");
    expect(buildPagesPagePath("/site/pages/detail")).toBe("/site/pages");
    expect(buildPagesPagePath("/site/pages")).toBe("/site/pages");
    expect(buildPagesPagePath("/site")).toBe("/site/pages");
    expect(isPageCardDetailTab("path")).toBe(true);
    expect(isPageCardDetailTab("entry")).toBe(true);
    expect(isPageCardDetailTab("exit")).toBe(true);
    expect(isPageCardDetailTab("hostname")).toBe(false);
    expect(
      resolvePageCardDetailPath({
        basePath: "/site/pages",
        value: " /pricing ",
        unknownLabel: "Unknown",
        tab: "path",
      }),
    ).toBe("/pricing");
    expect(
      resolvePageCardDetailPath({
        basePath: "/site/pages",
        value: "Unknown",
        unknownLabel: "Unknown",
      }),
    ).toBeNull();
  });

  it("normalizes request-observation legacy data and localizes its UI labels", () => {
    expect(normalizeRequestObservationTab("abnormal")).toBe("blocked");
    expect(normalizeRequestObservationTab("normal")).toBe("included");
    expect(normalizeRequestObservationTab("other")).toBe("overview");
    expect(normalizeRequestObservationCategory(" MEDIUM_THREAT ")).toBe(
      "suspected_bot",
    );
    expect(normalizeRequestObservationCategory("high_threat")).toBe("bot");
    expect(normalizeRequestObservationCategory("normal")).toBe("normal");
    expect(normalizeRequestObservationCategory("custom_block")).toBe(
      "custom_block",
    );
    expect(normalizeRequestObservationCategory("unknown")).toBe("");
    const event = normalizeRequestObservationEvent(
      {
        ...BOT_EVENT_DETAIL_SKELETON_DATA,
        category: "high_threat",
        disposition: "invalid",
        reasons: ["rule", 1],
        ip: null,
        userAgent: 2,
        verifiedBotCategory: false,
        botScore: "bad",
      } as unknown as BotEvent,
      "blocked",
    );
    expect(event).toMatchObject({
      category: "bot",
      disposition: "blocked",
      reasons: ["rule"],
      ip: "",
      userAgent: "",
      verifiedBotCategory: "",
      botScore: null,
    });
    expect(NORMAL_REQUEST_DETAIL_SKELETON_DATA.disposition).toBe("");
    expect(shortId("short-id")).toBe("short-id");
    expect(shortId("123456789012345")).toBe("123456789...");
    expect(requestObservationDetailId({ traceId: "trace", rayId: "ray" })).toBe(
      "trace",
    );
    expect(requestObservationDetailId({ traceId: "", rayId: "ray" })).toBe(
      "ray",
    );
    expect(requestObservationDetailId({ traceId: "", rayId: "" })).toBe("");
    const latencyCopy = {
      overviewLabels: { latencyMilliseconds: "{value} ms" },
    } as never;
    expect(latencyFormat("en", latencyCopy, null)).toBe("--");
    expect(latencyFormat("en", latencyCopy, 12.5)).toBe("12.5 ms");
    expect(latencyFormat("en", latencyCopy, 1250)).not.toBe("--");
    expect(nestedMessage({ a: { b: "value" } }, ["a", "b"], "fallback")).toBe(
      "value",
    );
    expect(nestedMessage({}, ["a"], "fallback")).toBe("fallback");
    expect(nestedMessage({ a: " " }, ["a"], "fallback")).toBe("fallback");
    expect(requestObservationUiLabels("en", {} as never).blocked).toBe(
      "Blocked requests",
    );
    expect(requestObservationUiLabels("zh", {} as never).blocked).toBe(
      "拦截请求",
    );
    expect(requestObservationUiLabels("ja", {} as never).blocked).toBe(
      "ブロック済みリクエスト",
    );
    expect(
      requestObservationUiLabels("en", {
        tabs: { blocked: "Custom blocked" },
      } as never).blocked,
    ).toBe("Custom blocked");
    expect(
      isInvalidRequestObservationCursorError(
        new Error("request_observation_invalid_cursor"),
      ),
    ).toBe(true);
    expect(
      isInvalidRequestObservationCursorError(
        new Error("Invalid request observation page cursor"),
      ),
    ).toBe(true);
    expect(isInvalidRequestObservationCursorError(new Error("other"))).toBe(
      false,
    );
    expect(isInvalidRequestObservationCursorError("other")).toBe(false);

    const normalized = withRequestObservabilityDefaults({
      trend: [
        {
          timestampMs: 10,
          abnormalCount: 8,
          normalCount: 4,
          botCount: 2,
          customBlockedCount: 1,
          avgLatencyMs: 25,
        },
      ],
      summary: { total: 0, baselineRequests: 0, affectedSites: 1 },
      events: [BOT_EVENT_DETAIL_SKELETON_DATA],
      normalEvents: [NORMAL_REQUEST_DETAIL_SKELETON_DATA],
      mapPoints: [{ latitude: 1, longitude: 2 }],
      reasons: [],
      countries: [],
      asns: [],
    } as unknown as RequestObservationData);
    expect(normalized.trend[0]).toMatchObject({
      totalCount: 12,
      includedCount: 4,
      blockedCount: 8,
      suspectedBotCount: 5,
      botCount: 2,
      customBlockedCount: 1,
      latencySampleWeight: 4,
      avgLatencyMs: 25,
    });
    expect(normalized.overview!.totalRequests).toBeGreaterThan(0);
    expect(normalized.blocked!.events[0]?.disposition).toBe("blocked");
    expect(normalized.included!.events[0]?.disposition).toBe("included");
    expect(normalized.mapPoints).toHaveLength(1);
    expect(normalized.included!.pagination!.limit).toBeGreaterThan(0);
  });
});
