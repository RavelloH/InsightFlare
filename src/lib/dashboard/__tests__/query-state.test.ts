import { describe, expect, it } from "vitest";

import type {
  DashboardFilters,
  RangePreset,
} from "@/lib/dashboard/query-state";
import {
  allowedIntervalsForRange,
  clampIntervalForRange,
  DEFAULT_RANGE_PRESET,
  finestIntervalForRange,
  normalizeCustomDateRange,
  parseDashboardFiltersFromSearchParams,
  resolveRangePreset,
  resolveTimeWindow,
  withRangeAndFilters,
} from "@/lib/dashboard/query-state";

const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

describe("dashboard query-state helpers", () => {
  describe("resolveRangePreset", () => {
    it("accepts known presets and falls back for missing or unknown values", () => {
      expect(resolveRangePreset("today")).toBe("today");
      expect(resolveRangePreset("custom")).toBe("custom");
      expect(resolveRangePreset(null)).toBe(DEFAULT_RANGE_PRESET);
      expect(resolveRangePreset("last-century")).toBe(DEFAULT_RANGE_PRESET);
    });
  });

  describe("interval selection", () => {
    it("allows progressively coarser intervals for larger ranges", () => {
      expect(allowedIntervalsForRange(0, HOUR_MS)).toEqual([
        "minute",
        "hour",
        "day",
        "week",
        "month",
      ]);
      expect(allowedIntervalsForRange(0, 8 * DAY_MS)).toEqual([
        "day",
        "week",
        "month",
      ]);
      expect(allowedIntervalsForRange(0, 400 * DAY_MS)).toEqual(["month"]);
    });

    it("chooses the finest safe interval when the requested interval is absent or too fine", () => {
      expect(finestIntervalForRange(0, 45 * MINUTE_MS)).toBe("minute");
      expect(finestIntervalForRange(0, 2 * HOUR_MS)).toBe("hour");
      expect(finestIntervalForRange(0, 30 * DAY_MS)).toBe("day");
      expect(finestIntervalForRange(0, 90 * DAY_MS + 12 * HOUR_MS)).toBe("day");
      expect(finestIntervalForRange(0, 91 * DAY_MS)).toBe("month");

      expect(clampIntervalForRange(undefined, 0, 45 * MINUTE_MS)).toBe(
        "minute",
      );
      expect(clampIntervalForRange(null, 0, 45 * MINUTE_MS)).toBe("minute");
      expect(clampIntervalForRange("minute", 0, 8 * DAY_MS)).toBe("day");
      expect(clampIntervalForRange("week", 0, 8 * DAY_MS)).toBe("week");
    });
  });

  describe("resolveTimeWindow", () => {
    const now = Date.UTC(2026, 4, 26, 15, 14, 56, 789);

    it.each([
      ["30m", now - 30 * MINUTE_MS, now, "minute"],
      ["1h", now - HOUR_MS, now, "minute"],
      ["24h", now - DAY_MS, now, "hour"],
      ["all", 0, now, "month"],
    ] satisfies Array<[RangePreset, number, number, string]>)(
      "resolves %s bounds",
      (preset, from, to, interval) => {
        expect(
          resolveTimeWindow(preset, now, { timeZone: "UTC" }),
        ).toMatchObject({
          preset,
          from,
          to,
          interval,
          timeZone: "UTC",
        });
      },
    );

    it("resolves calendar anchored ranges in the requested reporting timezone", () => {
      expect(
        resolveTimeWindow("today", now, { timeZone: "UTC" }),
      ).toMatchObject({
        from: Date.UTC(2026, 4, 26),
        to: now,
        interval: "hour",
      });
      expect(
        resolveTimeWindow("yesterday", now, { timeZone: "UTC" }),
      ).toMatchObject({
        from: Date.UTC(2026, 4, 25),
        to: Date.UTC(2026, 4, 26) - 1,
        interval: "hour",
      });
      expect(
        resolveTimeWindow("thisWeek", now, { timeZone: "UTC" }),
      ).toMatchObject({
        from: Date.UTC(2026, 4, 25),
        to: now,
        interval: "day",
      });
      expect(
        resolveTimeWindow("thisMonth", now, { timeZone: "UTC" }),
      ).toMatchObject({
        from: Date.UTC(2026, 4, 1),
        to: now,
        interval: "day",
      });
      expect(
        resolveTimeWindow("thisYear", now, { timeZone: "UTC" }),
      ).toMatchObject({
        from: Date.UTC(2026, 0, 1),
        to: now,
        interval: "month",
      });
    });

    it("resolves day and month lookback ranges from zoned boundaries", () => {
      expect(resolveTimeWindow("7d", now, { timeZone: "UTC" })).toMatchObject({
        from: Date.UTC(2026, 4, 26) - 7 * DAY_MS,
        to: now,
        interval: "day",
      });
      expect(resolveTimeWindow("30d", now, { timeZone: "UTC" })).toMatchObject({
        from: Date.UTC(2026, 4, 26) - 30 * DAY_MS,
        to: now,
        interval: "day",
      });
      expect(resolveTimeWindow("90d", now, { timeZone: "UTC" })).toMatchObject({
        from: Date.UTC(2026, 4, 26) - 90 * DAY_MS,
        to: now,
        interval: "day",
      });
      expect(resolveTimeWindow("6m", now, { timeZone: "UTC" })).toMatchObject({
        from: Date.UTC(2025, 10, 1),
        to: now,
        interval: "month",
      });
      expect(resolveTimeWindow("12m", now, { timeZone: "UTC" })).toMatchObject({
        from: Date.UTC(2025, 4, 1),
        to: now,
        interval: "month",
      });
    });

    it("uses valid custom ranges and falls back to the default preset for invalid custom ranges", () => {
      const customRange = { from: 1000, to: 2000 };
      expect(
        resolveTimeWindow("custom", now, {
          customRange,
          interval: "month",
          timeZone: "UTC",
        }),
      ).toMatchObject({
        preset: "custom",
        from: 1000,
        to: 2000,
        interval: "month",
      });

      const fallback = resolveTimeWindow("custom", now, {
        customRange: { from: 2000, to: 1000 },
        timeZone: "UTC",
      });
      expect(fallback.preset).toBe("custom");
      expect(fallback.from).toBe(Date.UTC(2026, 4, 26) - 30 * DAY_MS);
      expect(fallback.to).toBe(now);
    });

    it.each([
      [undefined],
      [null],
      [{ from: Number.NaN, to: 2000 }],
      [{ from: 1000, to: Number.POSITIVE_INFINITY }],
      [{ from: -1, to: 2000 }],
      [{ from: 1000, to: -1 }],
      [{ from: 1000, to: 1000 }],
    ])("falls back for invalid custom range %#", (customRange) => {
      expect(
        resolveTimeWindow("custom", now, {
          customRange: customRange as never,
          timeZone: "UTC",
        }),
      ).toMatchObject({
        preset: "custom",
        from: Date.UTC(2026, 4, 26) - 30 * DAY_MS,
        to: now,
        interval: "day",
      });
    });

    it("preserves allowed requested intervals", () => {
      const window = resolveTimeWindow("24h", now, {
        interval: "day",
        timeZone: "UTC",
      });
      expect(window.timeZone).toBe("UTC");
      expect(window.interval).toBe("day");
    });
  });

  describe("parseDashboardFiltersFromSearchParams", () => {
    it("normalizes supported scalar filters and drops blanks", () => {
      const longValue = "x".repeat(140);
      const params = new URLSearchParams({
        country: " US ",
        device: "  ",
        browser: longValue,
        geoTimezone: "Asia/Shanghai",
      });

      const filters = parseDashboardFiltersFromSearchParams(params);
      expect(filters.country).toBe("US");
      expect(filters.device).toBeUndefined();
      expect(filters.browser).toBe("x".repeat(120));
      expect(filters.geoTimezone).toBe("Asia/Shanghai");
    });

    it("parses, normalizes, truncates, and filters event payload rules", () => {
      const longString = "x".repeat(260);
      const rules = [
        { path: " $.user.role ", operator: "!=", value: "admin" },
        { path: "/items/0/name", operator: "eq", value: "x" },
        { path: "$.cart.items[0].sku", operator: "eq", value: longString },
        { path: "metrics.count", operator: "eq", value: 3 },
        { path: "flags.active", operator: "ne", value: true },
        { path: "optional.value", operator: "weird", value: null },
        { path: "empty.value", operator: "eq" },
        { path: "/", operator: "eq", value: "ignored" },
        { path: "bad.symbol", operator: "eq", value: Symbol("x") },
      ];
      const params = new URLSearchParams({
        eventPayloadFilters: JSON.stringify(rules),
      });

      expect(
        parseDashboardFiltersFromSearchParams(params).eventPayloadFilters,
      ).toEqual([
        { path: "/user/role", operator: "ne", value: "admin" },
        { path: "/items/0/name", operator: "eq", value: "x" },
        { path: "/cart/items/*/sku", operator: "eq", value: "x".repeat(240) },
        { path: "/metrics/count", operator: "eq", value: 3 },
        { path: "/flags/active", operator: "ne", value: true },
        { path: "/optional/value", operator: "eq", value: null },
      ]);
    });

    it("ignores malformed event payload filter params", () => {
      expect(
        parseDashboardFiltersFromSearchParams(
          new URLSearchParams({ eventPayloadFilters: "not json" }),
        ).eventPayloadFilters,
      ).toBeUndefined();
      expect(
        parseDashboardFiltersFromSearchParams(
          new URLSearchParams({ eventPayloadFilters: "{}" }),
        ).eventPayloadFilters,
      ).toBeUndefined();
      expect(
        parseDashboardFiltersFromSearchParams(
          new URLSearchParams({ eventPayloadFilters: "  " }),
        ).eventPayloadFilters,
      ).toBeUndefined();
      expect(
        parseDashboardFiltersFromSearchParams(
          new URLSearchParams({
            eventPayloadFilters: JSON.stringify([
              null,
              "bad",
              { path: "value", operator: "eq", value: { nested: true } },
            ]),
          }),
        ).eventPayloadFilters,
      ).toBeUndefined();
    });

    it("limits event payload filter parsing to the first twelve rules", () => {
      const params = new URLSearchParams({
        eventPayloadFilters: JSON.stringify(
          Array.from({ length: 14 }, (_, index) => ({
            path: `item.${index}`,
            operator: index % 2 === 0 ? "eq" : "ne",
            value: index,
          })),
        ),
      });

      const filters = parseDashboardFiltersFromSearchParams(params);
      expect(filters.eventPayloadFilters).toHaveLength(12);
      expect(filters.eventPayloadFilters?.at(0)).toEqual({
        path: "/item/0",
        operator: "eq",
        value: 0,
      });
      expect(filters.eventPayloadFilters?.at(11)).toEqual({
        path: "/item/11",
        operator: "ne",
        value: 11,
      });
    });
  });

  describe("withRangeAndFilters", () => {
    it("builds a range URL with every supported filter dimension", () => {
      const filters: DashboardFilters = {
        country: "US",
        device: "Desktop",
        browser: "Chrome",
        path: "/docs",
        query: "q=1",
        title: "Docs",
        hostname: "example.com",
        entry: "/",
        exit: "/pricing",
        sourceDomain: "google.com",
        sourceLink: "https://google.com/search",
        clientBrowser: "Chrome",
        clientOsVersion: "macOS 15",
        clientDeviceType: "Desktop",
        clientLanguage: "en-US",
        clientScreenSize: "1920x1080",
        geo: "US-CA",
        geoContinent: "NA",
        geoTimezone: "America/Los_Angeles",
        geoOrganization: "Example ISP",
        eventPayloadFilters: [
          { path: "/user/role", operator: "eq", value: "admin" },
        ],
      };

      const href = withRangeAndFilters("/dashboard", "7d", filters);
      const url = new URL(href, "https://example.test");
      expect(url.pathname).toBe("/dashboard");
      expect(url.searchParams.get("range")).toBe("7d");
      expect(url.searchParams.get("country")).toBe("US");
      expect(url.searchParams.get("clientScreenSize")).toBe("1920x1080");
      expect(url.searchParams.get("geoOrganization")).toBe("Example ISP");
      expect(
        JSON.parse(url.searchParams.get("eventPayloadFilters") || "[]"),
      ).toEqual(filters.eventPayloadFilters);
    });

    it("omits absent filters and still sets the range", () => {
      expect(withRangeAndFilters("/dashboard", "today")).toBe(
        "/dashboard?range=today",
      );
      expect(withRangeAndFilters("/dashboard", "today", {})).toBe(
        "/dashboard?range=today",
      );
    });

    it("omits empty scalar and event payload filters from the URL", () => {
      const href = withRangeAndFilters("/dashboard", "30d", {
        country: "",
        browser: "Chrome",
        eventPayloadFilters: [],
      });
      const url = new URL(href, "https://example.test");

      expect(url.searchParams.get("range")).toBe("30d");
      expect(url.searchParams.get("country")).toBeNull();
      expect(url.searchParams.get("browser")).toBe("Chrome");
      expect(url.searchParams.get("eventPayloadFilters")).toBeNull();
    });
  });

  describe("normalizeCustomDateRange", () => {
    it("normalizes selected dates to the full zoned date range", () => {
      expect(
        normalizeCustomDateRange(
          {
            from: new Date(2026, 4, 1),
            to: new Date(2026, 4, 3),
          },
          "UTC",
        ),
      ).toEqual({
        from: Date.UTC(2026, 4, 1),
        to: Date.UTC(2026, 4, 3, 23, 59, 59, 999),
      });
    });

    it("returns null for incomplete or inverted ranges", () => {
      expect(normalizeCustomDateRange(null, "UTC")).toBeNull();
      expect(normalizeCustomDateRange({ from: new Date() }, "UTC")).toBeNull();
      expect(
        normalizeCustomDateRange(
          {
            from: new Date(Date.UTC(2026, 4, 3)),
            to: new Date(Date.UTC(2026, 4, 1)),
          },
          "UTC",
        ),
      ).toBeNull();
    });
  });
});
