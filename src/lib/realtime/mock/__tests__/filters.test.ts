import { describe, expect, it } from "vitest";

import {
  appendEventPayloadFilter,
  dashboardFilterFieldId,
  dashboardFilterFieldsForControl,
  dashboardFilterFingerprint,
  dashboardFilterPresentation,
  setDashboardFilterValue,
  withoutDashboardFilter,
} from "@/lib/dashboard/filter-state";
import { dashboardFilterDocumentFromPresentation } from "@/lib/dashboard/filter-state";
import type { FilterDocument, FilterFieldId } from "@/lib/filter-contract";
import {
  DEMO_DIRECT_REFERRER_FILTER_VALUE,
  DEMO_INTERVALS,
  demoValuesIncludeSearch,
  normalizeDemoFilterValue,
  normalizeDemoSearch,
  parseDemoBoolean,
  parseDemoFilters,
  parseDemoGeoFilterValue,
  parseDemoInterval,
  parseDemoLimit,
  parseDemoNumber,
  withoutDemoGeoFilter,
} from "@/lib/realtime/mock/filters";

describe("mock/filters", () => {
  it("exposes canonical dashboard filter helpers", () => {
    const document = dashboardFilterDocumentFromPresentation({
      country: "US",
      browser: "Chrome",
    });
    expect(dashboardFilterFieldId("country")).toBe("geo.country");
    expect(dashboardFilterFieldsForControl("geo")).toEqual([
      "geo.country",
      "geo.region",
      "geo.city",
    ]);
    expect(dashboardFilterFingerprint(document)).toContain("filter-v1:");
    const withPayload = appendEventPayloadFilter(document, "plan", "eq", "pro");
    expect(withPayload.root).toBeTruthy();
  });

  it("normalizes dashboard filter edits across invalid, nested, and geo values", () => {
    const empty = dashboardFilterDocumentFromPresentation({});
    expect(setDashboardFilterValue(empty, "country", "   ").root).toBeNull();
    expect(setDashboardFilterValue(empty, "country", null).root).toBeNull();
    expect(setDashboardFilterValue(empty, "geo", "invalid").root).toBeNull();
    const region = setDashboardFilterValue(empty, "geo", "US::CA");
    expect(region.root).toBeTruthy();
    expect(parseDemoFilters({}).filterDocument).toBeDefined();
    expect(
      dashboardFilterDocumentFromPresentation({ geo: "US::CA" }).root,
    ).toBeTruthy();
    expect(dashboardFilterPresentation(region).geo).toBe("us::us::ca");
    const locality = setDashboardFilterValue(
      empty,
      "geo",
      "US::CA::California::Berkeley",
    );
    expect(locality.root).toBeTruthy();
    expect(dashboardFilterPresentation(locality).geo).toContain("berkeley");

    const combined = dashboardFilterDocumentFromPresentation({
      country: "US",
      browser: "Chrome",
    });
    expect(withoutDashboardFilter(combined, "country").root).toBeTruthy();
    expect(withoutDashboardFilter(combined, "browser").root).toBeTruthy();
    expect(withoutDashboardFilter(combined, "geo").root).toBeTruthy();
    const notDocument = {
      version: 1,
      root: {
        kind: "not",
        child: {
          kind: "condition",
          target: { kind: "field", field: "geo.country" },
          operator: "eq",
          value: "us",
        },
      },
    } as FilterDocument;
    expect(withoutDashboardFilter(notDocument, "country").root).toBeNull();
    const preservedNotDocument: FilterDocument = {
      version: 1,
      root: {
        kind: "not",
        child: {
          kind: "condition",
          target: {
            kind: "field",
            field: "client.browser" as FilterFieldId,
          },
          operator: "eq",
          value: "Chrome",
        },
      },
    };
    expect(
      withoutDashboardFilter(preservedNotDocument, "country").root,
    ).toBeTruthy();
    expect(
      appendEventPayloadFilter(empty, "/plan", "eq", "pro").root,
    ).toBeTruthy();
  });

  describe("constants", () => {
    it("exposes the direct referrer sentinel", () => {
      expect(DEMO_DIRECT_REFERRER_FILTER_VALUE).toBe("__direct__");
    });

    it("declares the valid set of intervals", () => {
      expect(DEMO_INTERVALS.has("minute")).toBe(true);
      expect(DEMO_INTERVALS.has("hour")).toBe(true);
      expect(DEMO_INTERVALS.has("day")).toBe(true);
      expect(DEMO_INTERVALS.has("week")).toBe(true);
      expect(DEMO_INTERVALS.has("month")).toBe(true);
      expect(DEMO_INTERVALS.has("year")).toBe(false);
    });
  });

  describe("normalizeDemoFilterValue", () => {
    it("returns undefined for nullish or sentinel values", () => {
      expect(normalizeDemoFilterValue(undefined)).toBeUndefined();
      expect(normalizeDemoFilterValue("")).toBeUndefined();
      expect(normalizeDemoFilterValue("   ")).toBeUndefined();
      expect(normalizeDemoFilterValue("all")).toBeUndefined();
      expect(normalizeDemoFilterValue("ALL")).toBeUndefined();
      expect(normalizeDemoFilterValue("null")).toBeUndefined();
      expect(normalizeDemoFilterValue("undefined")).toBeUndefined();
    });

    it("trims and clips strings to 120 characters", () => {
      expect(normalizeDemoFilterValue("  US ")).toBe("US");
      const long = "a".repeat(200);
      expect(normalizeDemoFilterValue(long)).toHaveLength(120);
    });

    it("coerces numeric inputs to strings", () => {
      expect(normalizeDemoFilterValue(42)).toBe("42");
    });
  });

  describe("parseDemoFilters", () => {
    it("returns undefined for absent dimensions", () => {
      const filters = parseDemoFilters({});
      expect(filters.country).toBeUndefined();
      expect(filters.geo).toBeUndefined();
      expect(filters.filterDocument?.root).toBeNull();
    });

    it("captures every supported dimension key", () => {
      const filters = parseDemoFilters({
        "filter[geo.country]": "US",
        "filter[client.deviceType]": "Mobile",
        "filter[client.browser]": "Chrome",
        "filter[page.path]": "/pricing",
        "filter[page.query]": "?utm_source=newsletter",
        "filter[page.title]": "Home",
        "filter[page.hostname]": "example.com",
        "filter[session.entryPath]": "/",
        "filter[session.exitPath]": "/checkout",
        "filter[referrer.domain]": "google.com",
        "filter[referrer.url]": "https://google.com/search",
        "filter[client.osVersion]": "iOS 18",
        "filter[client.language]": "en-US",
        "filter[client.screenSize]": "390x844",
        "filter[geo.continent]": "North America",
        "filter[geo.timeZone]": "America/New_York",
        "filter[geo.organization]": "Cloudflare Inc.",
      });
      expect(filters.country).toBe("us");
      expect(filters.device).toBe("mobile");
      expect(filters.browser).toBe("Chrome");
      expect(filters.path).toBe("/pricing");
      expect(filters.title).toBe("Home");
      expect(filters.entry).toBe("/");
      expect(filters.exit).toBe("/checkout");
      expect(filters.sourceDomain).toBe("google.com");
      expect(filters.clientScreenSize).toBe("390x844");
      expect(filters.geoContinent).toBe("north america");
      expect(filters.geoOrganization).toBe("Cloudflare Inc.");
    });

    it("maps canonical geo paths to the existing geo presentation", () => {
      expect(
        parseDemoFilters({
          "filter[geo.country]": "US",
          "filter[geo.region]": "CA",
          "filter[geo.city]": "Los Angeles",
        }).geo,
      ).toBe("us::ca::los angeles");
    });

    it("parses event payload conditions into the shared AST", () => {
      const filters = parseDemoFilters({
        "filter[event.payload][/foo]": "bar",
        "filter[event.payload][/amount/*]": "neq:json:100",
      });
      expect(filters.filterDocument?.root).toBeTruthy();
    });
  });

  describe("normalizeDemoSearch", () => {
    it("prefers `search`, falls back to `q`, default empty", () => {
      expect(normalizeDemoSearch({ search: " Foo " })).toBe("foo");
      expect(normalizeDemoSearch({ q: "BAR" })).toBe("bar");
      expect(normalizeDemoSearch({})).toBe("");
    });
  });

  describe("demoValuesIncludeSearch", () => {
    it("returns true when search is empty", () => {
      expect(demoValuesIncludeSearch("", ["foo"])).toBe(true);
    });

    it("returns true when any value contains the search substring (case-insensitive)", () => {
      expect(demoValuesIncludeSearch("oo", ["FoO", "bar"])).toBe(true);
      expect(demoValuesIncludeSearch("zzz", ["bar", null])).toBe(false);
    });
  });

  describe("withoutDemoGeoFilter", () => {
    it("clears the `geo` field but preserves other filters", () => {
      const filters = parseDemoFilters({
        "filter[geo.country]": "US",
        "filter[geo.region]": "CA",
        "filter[geo.city]": "California",
      });
      const stripped = withoutDemoGeoFilter(filters);
      expect(stripped.geo).toBeUndefined();
      expect(stripped.country).toBeUndefined();
    });
  });

  describe("parseDemoGeoFilterValue", () => {
    it("returns null for empty input", () => {
      expect(parseDemoGeoFilterValue(undefined)).toBeNull();
      expect(parseDemoGeoFilterValue("")).toBeNull();
      expect(parseDemoGeoFilterValue("   ")).toBeNull();
    });

    it("returns null when the country segment is empty", () => {
      expect(parseDemoGeoFilterValue("::CA::California")).toBeNull();
    });

    it("parses a country-only value (uppercased)", () => {
      expect(parseDemoGeoFilterValue("us")).toEqual({ country: "US" });
    });

    it("parses a country+city two-segment value", () => {
      expect(parseDemoGeoFilterValue("US::Boston")).toEqual({
        country: "US",
        city: "Boston",
      });
    });

    it("treats trailing empty city segment as country-only", () => {
      expect(parseDemoGeoFilterValue("US::")).toEqual({ country: "US" });
    });

    it("parses a full region+city value", () => {
      expect(
        parseDemoGeoFilterValue("US::CA::California::Los Angeles"),
      ).toEqual({
        country: "US",
        regionCode: "CA",
        regionName: "California",
        city: "Los Angeles",
      });
    });

    it("re-joins multi-segment city names", () => {
      expect(
        parseDemoGeoFilterValue("US::NY::New York::New York::City"),
      ).toEqual({
        country: "US",
        regionCode: "NY",
        regionName: "New York",
        city: "New York::City",
      });
    });

    it("omits empty optional segments", () => {
      expect(parseDemoGeoFilterValue("US::CA::California")).toEqual({
        country: "US",
        regionCode: "CA",
        regionName: "California",
      });
    });
  });

  describe("parseDemoNumber", () => {
    it("returns numeric input as-is when finite", () => {
      expect(parseDemoNumber(42, 0)).toBe(42);
      expect(parseDemoNumber(-3.14, 0)).toBe(-3.14);
    });

    it("parses string numbers, falls back otherwise", () => {
      expect(parseDemoNumber("17", 0)).toBe(17);
      expect(parseDemoNumber("abc", 99)).toBe(99);
      expect(parseDemoNumber(undefined, 5)).toBe(5);
    });

    it("rejects infinite/NaN numeric inputs", () => {
      expect(parseDemoNumber(Number.POSITIVE_INFINITY, 12)).toBe(12);
      expect(parseDemoNumber(Number.NaN, 7)).toBe(7);
    });
  });

  describe("parseDemoLimit", () => {
    it("clamps within [min, max] and floors to integer", () => {
      expect(parseDemoLimit("20.7", 10, 5, 50)).toBe(20);
      expect(parseDemoLimit(3, 10, 5, 50)).toBe(5);
      expect(parseDemoLimit(99, 10, 5, 50)).toBe(50);
    });

    it("uses fallback when the value is not parseable", () => {
      expect(parseDemoLimit(undefined, 8, 1, 30)).toBe(8);
      expect(parseDemoLimit("bad", 8, 1, 30)).toBe(8);
    });
  });

  describe("parseDemoBoolean", () => {
    it("treats common truthy forms as true", () => {
      expect(parseDemoBoolean(1)).toBe(true);
      expect(parseDemoBoolean("1")).toBe(true);
      expect(parseDemoBoolean("true")).toBe(true);
      expect(parseDemoBoolean("YES")).toBe(true);
      expect(parseDemoBoolean(" True ")).toBe(true);
    });

    it("treats everything else as false", () => {
      expect(parseDemoBoolean(0)).toBe(false);
      expect(parseDemoBoolean("0")).toBe(false);
      expect(parseDemoBoolean("false")).toBe(false);
      expect(parseDemoBoolean(undefined)).toBe(false);
      expect(parseDemoBoolean("maybe")).toBe(false);
    });
  });

  describe("parseDemoInterval", () => {
    it("returns the parsed interval when valid", () => {
      expect(parseDemoInterval("minute")).toBe("minute");
      expect(parseDemoInterval(" HOUR ")).toBe("hour");
      expect(parseDemoInterval("week")).toBe("week");
      expect(parseDemoInterval("month")).toBe("month");
    });

    it("falls back to `day` for unknown values", () => {
      expect(parseDemoInterval(undefined)).toBe("day");
      expect(parseDemoInterval("year")).toBe("day");
    });
  });
});
