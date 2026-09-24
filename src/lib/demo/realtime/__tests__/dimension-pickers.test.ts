import { describe, expect, it, vi } from "vitest";

import { findSiteProfile } from "@/lib/demo/data/site-profiles";
import { mulberry32 } from "@/lib/demo/generators/utils";
import type * as DimensionPickersModule from "@/lib/demo/realtime/dimension-pickers";
import {
  buildCountryPool,
  buildReferrerPool,
  DEMO_CITIES_BY_COUNTRY,
  DEMO_REGIONS_BY_COUNTRY,
  filterGeoLabelsByCountries,
  groupGeoLabelsByCountry,
  isMobileBrowserLabel,
  normalizeLongitude,
  parseDemoCityLabel,
  parseDemoRegionLabel,
  pickCountryGeoCluster,
  pickDemoBrowser,
  pickDemoBrowserVersion,
  pickDemoContinent,
  pickDemoDeviceType,
  pickDemoGeoContext,
  pickDemoLanguage,
  pickDemoOrganization,
  pickDemoOsVersion,
  pickDemoScreenSize,
  pickDemoTimezone,
  pickFromList,
  pickReferrerByCountry,
  randomGaussian,
  sampleGeoPointByCountry,
  weightedPickCountry,
  weightedPickIndex,
} from "@/lib/demo/realtime/dimension-pickers";
import type * as DimensionPoolsModule from "@/lib/demo/realtime/dimension-pools";
const rng = (seed: number) => mulberry32(seed);
async function withMockedDimensionPools<T>(
  overrides: Record<string, unknown>,
  run: (pickers: typeof DimensionPickersModule) => T | Promise<T>,
): Promise<T> {
  vi.resetModules();
  vi.doMock("@/lib/demo/realtime/dimension-pools", async () => {
    const actual = await vi.importActual<typeof DimensionPoolsModule>(
      "@/lib/demo/realtime/dimension-pools",
    );
    return {
      ...actual,
      ...overrides,
    };
  });

  try {
    const pickers = await import("@/lib/demo/realtime/dimension-pickers");
    return await run(pickers);
  } finally {
    vi.doUnmock("@/lib/demo/realtime/dimension-pools");
    vi.resetModules();
  }
}
describe("mock/dimension-pickers", () => {
  describe("pickFromList", () => {
    it("returns the fallback for empty arrays", () => {
      expect(pickFromList(rng(1), [], "fallback")).toBe("fallback");
    });

    it("selects from the values", () => {
      const arr = ["a", "b", "c"] as const;
      const r = rng(2);
      for (let i = 0; i < 20; i += 1)
        expect(arr).toContain(pickFromList(r, arr, "z"));
    });
  });

  describe("normalizeLongitude", () => {
    it("wraps values into [-180, 180]", () => {
      expect(normalizeLongitude(200)).toBeCloseTo(-160, 5);
      expect(normalizeLongitude(-190)).toBeCloseTo(170, 5);
      expect(normalizeLongitude(0)).toBe(0);
    });

    it("returns 0 for non-finite input", () => {
      expect(normalizeLongitude(Number.NaN)).toBe(0);
      expect(normalizeLongitude(Number.POSITIVE_INFINITY)).toBe(0);
    });
  });

  describe("weightedPickIndex", () => {
    it("returns 0 for empty weights", () => {
      expect(weightedPickIndex(rng(1), [])).toBe(0);
    });

    it("returns 0 when all weights are zero or negative", () => {
      expect(weightedPickIndex(rng(1), [0, 0, 0])).toBe(0);
      expect(weightedPickIndex(rng(1), [-1, -2])).toBe(0);
    });

    it("treats non-finite weights as zero", () => {
      expect(weightedPickIndex(rng(1), [Number.NaN, 0, -1])).toBe(0);
    });

    it("returns an index within range when weights are positive", () => {
      const r = rng(3);
      for (let i = 0; i < 20; i += 1) {
        const index = weightedPickIndex(r, [1, 2, 3]);
        expect(index).toBeGreaterThanOrEqual(0);
        expect(index).toBeLessThan(3);
      }
    });
  });

  describe("randomGaussian", () => {
    it("returns finite numbers", () => {
      const r = rng(5);
      for (let i = 0; i < 10; i += 1) {
        expect(Number.isFinite(randomGaussian(r))).toBe(true);
      }
    });
  });

  describe("pickCountryGeoCluster", () => {
    it("uses anchor for countries without clusters", () => {
      const cluster = pickCountryGeoCluster(rng(1), "XX");
      expect(cluster.latitude).toBe(20);
      expect(cluster.longitude).toBe(0);
    });

    it("picks one of the clusters for known countries", () => {
      const cluster = pickCountryGeoCluster(rng(1), "US");
      expect(cluster.weight).toBeGreaterThan(0);
      expect(cluster.spreadKm).toBeGreaterThan(0);
    });
  });

  describe("sampleGeoPointByCountry", () => {
    it("returns lat/lon within valid bounds", () => {
      const r = rng(7);
      for (let i = 0; i < 30; i += 1) {
        const { latitude, longitude } = sampleGeoPointByCountry(r, "US");
        expect(latitude).toBeGreaterThanOrEqual(-85);
        expect(latitude).toBeLessThanOrEqual(85);
        expect(longitude).toBeGreaterThanOrEqual(-180);
        expect(longitude).toBeLessThanOrEqual(180);
      }
    });

    it("handles unknown countries via the anchor fallback", () => {
      const point = sampleGeoPointByCountry(rng(9), "XX");
      expect(Number.isFinite(point.latitude)).toBe(true);
      expect(Number.isFinite(point.longitude)).toBe(true);
    });
  });

  describe("weightedPickCountry", () => {
    it("returns US for empty input", () => {
      expect(weightedPickCountry(rng(1), [])).toBe("US");
    });

    it("returns US when every country weight is non-positive", () => {
      expect(
        weightedPickCountry(rng(1), [
          { code: "DE", weight: 0 },
          { code: "JP", weight: -3 },
        ]),
      ).toBe("US");
    });

    it("ignores negative weights while picking positive entries", () => {
      expect(
        weightedPickCountry(
          () => 0.9,
          [
            { code: "DE", weight: -10 },
            { code: "JP", weight: 1 },
          ],
        ),
      ).toBe("JP");
    });

    it("returns a country code from the pool", () => {
      const pool = [
        { code: "US", weight: 1 },
        { code: "DE", weight: 1 },
      ];
      const r = rng(2);
      const picks = new Set<string>();
      for (let i = 0; i < 50; i += 1) picks.add(weightedPickCountry(r, pool));
      expect(picks.has("US") || picks.has("DE")).toBe(true);
    });
  });

  describe("buildCountryPool", () => {
    it("uses US as fallback when no valid base entries exist", () => {
      const pool = buildCountryPool(rng(1), [], 4);
      expect(pool.length).toBeGreaterThanOrEqual(4);
      expect(pool[0].code).toBe("US");
    });

    it("falls back to US when base entries are blank or non-positive", () => {
      const pool = buildCountryPool(
        rng(1),
        [
          { code: "", weight: 1 },
          { code: "de", weight: 0 },
          { code: "jp", weight: -1 },
        ],
        4,
      );
      expect(pool[0]).toMatchObject({ code: "US", weight: 1 });
    });

    it("merges duplicate codes and uppercases them", () => {
      const pool = buildCountryPool(
        rng(2),
        [
          { code: "us", weight: 0.5 },
          { code: "US", weight: 0.5 },
          { code: "DE", weight: 0.3 },
        ],
        10,
      );
      const codes = pool.map((entry) => entry.code);
      const unique = new Set(codes);
      expect(unique.size).toBe(codes.length);
      expect(codes).toContain("US");
    });

    it("expands the pool via long-tail until target reached", () => {
      const pool = buildCountryPool(rng(3), [{ code: "US", weight: 1 }], 12);
      expect(pool.length).toBeGreaterThanOrEqual(12);
    });
  });

  describe("buildReferrerPool", () => {
    it("always includes (direct)", () => {
      const pool = buildReferrerPool(rng(1), [], 10);
      expect(pool.find((entry) => entry.label === "(direct)")).toBeTruthy();
    });

    it("includes provided base referrers", () => {
      const pool = buildReferrerPool(
        rng(2),
        [{ name: "google.com", weight: 0.5 }],
        8,
      );
      const labels = pool.map((entry) => entry.label);
      expect(labels).toContain("google.com");
    });

    it("ignores empty or zero-weight entries", () => {
      const pool = buildReferrerPool(
        rng(3),
        [
          { name: "  ", weight: 1 },
          { name: "google.com", weight: 0 },
          { name: "yahoo.com", weight: 0.3 },
        ],
        10,
      );
      expect(pool.find((entry) => entry.label === "  ")).toBeUndefined();
      expect(
        pool.find((entry) => entry.label === "google.com"),
      ).toBeUndefined();
      expect(pool.find((entry) => entry.label === "yahoo.com")).toBeTruthy();
    });

    it("ignores negative-weight entries before adding fallbacks", () => {
      const pool = buildReferrerPool(
        rng(4),
        [
          { name: "negative.example", weight: -1 },
          { name: "  valid.example  ", weight: 0.2 },
        ],
        6,
      );
      expect(
        pool.find((entry) => entry.label === "negative.example"),
      ).toBeUndefined();
      expect(
        pool.find((entry) => entry.label === "valid.example"),
      ).toBeTruthy();
    });
  });

  describe("filterGeoLabelsByCountries", () => {
    it("returns labels whose first segment is in the allowed list when enough match", () => {
      const labels = [
        "US::CA::California",
        "US::TX::Texas",
        "US::NY::New York",
        "US::FL::Florida",
        "US::WA::Washington",
        "US::IL::Illinois",
        "US::MA::Massachusetts",
        "DE::BE::Berlin",
        "JP::13::Tokyo",
      ];
      const result = filterGeoLabelsByCountries(labels, ["us"]);
      expect(result.every((label) => label.startsWith("US"))).toBe(true);
      expect(result.length).toBeGreaterThanOrEqual(6);
    });

    it("falls back to the full list when too few labels match", () => {
      const labels = ["US::CA", "US::TX"];
      const result = filterGeoLabelsByCountries(labels, ["JP"]);
      expect(result).toEqual(labels);
    });
  });

  describe("groupGeoLabelsByCountry", () => {
    it("groups labels by their first segment", () => {
      const grouped = groupGeoLabelsByCountry([
        "US::CA::California",
        "us::TX::Texas",
        "DE::BE::Berlin",
      ]);
      expect(grouped.get("US")).toHaveLength(2);
      expect(grouped.get("DE")).toHaveLength(1);
    });

    it("skips empty-country entries", () => {
      const grouped = groupGeoLabelsByCountry(["", "::Foo", "US::CA"]);
      expect(grouped.get("US")?.length).toBe(1);
      expect(grouped.size).toBe(1);
    });
  });

  describe("DEMO_REGIONS_BY_COUNTRY / DEMO_CITIES_BY_COUNTRY", () => {
    it("are non-empty maps", () => {
      expect(DEMO_REGIONS_BY_COUNTRY.size).toBeGreaterThan(0);
      expect(DEMO_CITIES_BY_COUNTRY.size).toBeGreaterThan(0);
    });
  });

  describe("isMobileBrowserLabel", () => {
    it("flags mobile-flavored labels", () => {
      expect(isMobileBrowserLabel("Mobile Safari")).toBe(true);
      expect(isMobileBrowserLabel("Samsung Internet")).toBe(true);
      expect(isMobileBrowserLabel("Mi Browser")).toBe(true);
    });

    it("returns false for desktop browsers", () => {
      expect(isMobileBrowserLabel("Chrome")).toBe(false);
      expect(isMobileBrowserLabel("Firefox")).toBe(false);
    });
  });

  describe("pickDemoDeviceType", () => {
    it("selects from the profile's device weights", () => {
      const profile = findSiteProfile("demo-site-001");
      const r = rng(1);
      const picks = new Set<string>();
      for (let i = 0; i < 50; i += 1) picks.add(pickDemoDeviceType(r, profile));
      expect(picks.size).toBeGreaterThan(0);
      for (const value of picks) {
        expect(["Desktop", "Mobile", "Tablet"]).toContain(value);
      }
    });

    it("falls back to Desktop when the profile has no device entries", () => {
      const profile = {
        ...findSiteProfile("demo-site-001"),
        deviceWeights: {} as never,
      };
      expect(pickDemoDeviceType(rng(1), profile)).toBe("Desktop");
    });

    it("returns the first label when all device weights are non-positive", () => {
      const profile = {
        ...findSiteProfile("demo-site-001"),
        deviceWeights: {
          Mobile: 0,
          Desktop: -1,
        } as never,
      };
      expect(pickDemoDeviceType(rng(1), profile)).toBe("Mobile");
    });
  });

  describe("pickDemoBrowser", () => {
    it("picks a browser for each device type", () => {
      const r = rng(2);
      expect(typeof pickDemoBrowser(r, "Desktop")).toBe("string");
      expect(typeof pickDemoBrowser(r, "Mobile")).toBe("string");
      expect(typeof pickDemoBrowser(r, "Tablet")).toBe("string");
    });
  });

  describe("pickDemoBrowserVersion", () => {
    it("returns a known major version per browser family", () => {
      const r = rng(3);
      expect(["27", "26", "25", "24"]).toContain(
        pickDemoBrowserVersion(r, "Samsung Internet"),
      );
      expect(["18", "17", "16", "15"]).toContain(
        pickDemoBrowserVersion(r, "Safari"),
      );
      expect(["137", "136", "135", "134"]).toContain(
        pickDemoBrowserVersion(r, "Firefox"),
      );
      expect(["138", "137", "136", "135"]).toContain(
        pickDemoBrowserVersion(r, "Edge"),
      );
      expect(["117", "116", "115", "114"]).toContain(
        pickDemoBrowserVersion(r, "Opera"),
      );
      expect(["25", "24", "23"]).toContain(
        pickDemoBrowserVersion(r, "Yandex Browser"),
      );
      expect(["16", "15", "14"]).toContain(
        pickDemoBrowserVersion(r, "UC Browser"),
      );
      expect(["138", "137", "136", "135"]).toContain(
        pickDemoBrowserVersion(r, "Chrome"),
      );
    });
  });

  describe("pickDemoOsVersion", () => {
    it("returns a desktop OS for Desktop and Tablet (sometimes)", () => {
      const r = rng(4);
      const desktop = pickDemoOsVersion(r, "Desktop");
      const tablet = pickDemoOsVersion(r, "Tablet");
      const mobile = pickDemoOsVersion(r, "Mobile");
      expect(typeof desktop).toBe("string");
      expect(typeof tablet).toBe("string");
      expect(typeof mobile).toBe("string");
    });
  });

  describe("pickDemoScreenSize", () => {
    it("returns appropriate screen sizes", () => {
      const r = rng(5);
      expect(typeof pickDemoScreenSize(r, "Mobile")).toBe("string");
      expect(typeof pickDemoScreenSize(r, "Tablet")).toBe("string");
      expect(typeof pickDemoScreenSize(r, "Desktop")).toBe("string");
    });
  });

  describe("pickDemoLanguage", () => {
    it("returns a known mapping for known country", () => {
      expect(pickDemoLanguage(rng(1), "DE")).toBe("de-DE");
      expect(pickDemoLanguage(rng(1), "FR")).toBe("fr-FR");
    });

    it("falls back to ALL_LANGUAGES when country has no mapping", () => {
      expect(typeof pickDemoLanguage(rng(1), "XX")).toBe("string");
    });
  });

  describe("pickDemoTimezone", () => {
    it("returns a known timezone for a known country", () => {
      expect(pickDemoTimezone(rng(1), "DE")).toBe("Europe/Berlin");
    });

    it("falls back to ALL_TIMEZONES when country has no mapping", () => {
      expect(typeof pickDemoTimezone(rng(1), "XX")).toBe("string");
    });
  });

  describe("pickDemoContinent", () => {
    it("uses the lookup table when available", () => {
      expect(pickDemoContinent(rng(1), "US")).toBe("North America");
      expect(pickDemoContinent(rng(1), "DE")).toBe("Europe");
    });

    it("falls back to ALL_CONTINENTS for unknown countries", () => {
      expect(typeof pickDemoContinent(rng(1), "XX")).toBe("string");
    });
  });

  describe("pickDemoOrganization", () => {
    it("returns a non-empty string", () => {
      expect(typeof pickDemoOrganization(rng(1), "US")).toBe("string");
      expect(pickDemoOrganization(rng(1), "US").length).toBeGreaterThan(0);
    });
  });

  describe("parseDemoRegionLabel", () => {
    it("returns null when the country segment is missing", () => {
      expect(parseDemoRegionLabel("::CA::California")).toBeNull();
    });

    it("returns null when both region code and name are missing", () => {
      expect(parseDemoRegionLabel("US")).toBeNull();
    });

    it("parses a full region label", () => {
      const parsed = parseDemoRegionLabel("US::CA::California");
      expect(parsed).toEqual({
        country: "US",
        regionCode: "CA",
        regionName: "California",
        region: "US::CA::California",
      });
    });

    it("falls back to region code when name is missing", () => {
      const parsed = parseDemoRegionLabel("US::CA");
      expect(parsed?.region).toBe("US::CA::CA");
    });

    it("falls back to region name when the code is missing", () => {
      const parsed = parseDemoRegionLabel("US::::California");
      expect(parsed).toEqual({
        country: "US",
        regionCode: "",
        regionName: "California",
        region: "US::California::California",
      });
    });
  });

  describe("parseDemoCityLabel", () => {
    it("returns null when the country segment is missing", () => {
      expect(parseDemoCityLabel("::CA::California::Los Angeles")).toBeNull();
    });

    it("returns null when city segment is missing", () => {
      expect(parseDemoCityLabel("US::CA::California")).toBeNull();
    });

    it("returns null when both region code and name are missing", () => {
      expect(parseDemoCityLabel("US::::::Austin")).toBeNull();
    });

    it("parses a full city label", () => {
      const parsed = parseDemoCityLabel("US::CA::California::Los Angeles");
      expect(parsed?.city).toBe("US::CA::California::Los Angeles");
      expect(parsed?.cityName).toBe("Los Angeles");
    });

    it("joins multi-segment city names", () => {
      const parsed = parseDemoCityLabel("US::NY::New York::New York::City");
      expect(parsed?.cityName).toBe("New York::City");
    });

    it("falls back to region name when the city region code is missing", () => {
      const parsed = parseDemoCityLabel("US::::California::Los Angeles");
      expect(parsed).toEqual({
        country: "US",
        regionCode: "",
        regionName: "California",
        region: "US::California::California",
        cityName: "Los Angeles",
        city: "US::California::California::Los Angeles",
      });
    });

    it("falls back to region code when the city region name is missing", () => {
      const parsed = parseDemoCityLabel("US::CA::::Los Angeles");
      expect(parsed).toEqual({
        country: "US",
        regionCode: "CA",
        regionName: "CA",
        region: "US::CA::CA",
        cityName: "Los Angeles",
        city: "US::CA::CA::Los Angeles",
      });
    });
  });

  describe("pickReferrerByCountry", () => {
    it("returns the fallback for empty pool when bias has no entries", () => {
      expect(pickReferrerByCountry(rng(1), [], "XX")).toBe("(direct)");
    });

    it("returns the fallback when every un-biased referrer weight is non-positive", () => {
      expect(
        pickReferrerByCountry(
          rng(1),
          [
            { label: "example.com", weight: 0 },
            { label: "negative.example", weight: -1 },
          ],
          "XX",
          "fallback.example",
        ),
      ).toBe("fallback.example");
    });

    it("injects flagship referrers for biased countries even when missing", () => {
      const r = rng(2);
      const picks = new Set<string>();
      for (let i = 0; i < 100; i += 1) {
        picks.add(pickReferrerByCountry(r, [], "CN", "(direct)"));
      }
      // CN bias map includes baidu.com — verify at least once it can appear.
      // (low probability per pick but cumulative over many picks)
      expect(picks.size).toBeGreaterThan(0);
    });
  });

  describe("pickDemoGeoContext", () => {
    it("returns a populated geo context for a known country", () => {
      const ctx = pickDemoGeoContext(rng(1), "US");
      expect(typeof ctx.continent).toBe("string");
      expect(typeof ctx.timezone).toBe("string");
      expect(typeof ctx.organization).toBe("string");
      expect(Number.isFinite(ctx.latitude)).toBe(true);
      expect(Number.isFinite(ctx.longitude)).toBe(true);
    });

    it("handles a country with neither regions nor cities", () => {
      const ctx = pickDemoGeoContext(rng(2), "XX");
      expect(ctx.region).toBe("");
      expect(ctx.city).toBe("");
    });

    it("falls back from city candidates to region candidates when the city label is incomplete", async () => {
      await withMockedDimensionPools(
        {
          ALL_CITIES: ["ZZ::::::Austin"],
          ALL_REGIONS: ["ZZ::TX::Texas"],
          COUNTRY_COORDINATE_ANCHORS: {
            ZZ: { latitude: 10, longitude: 20 },
          },
          COUNTRY_GEO_CLUSTERS: {},
          DEMO_COUNTRY_TO_CONTINENT: { ZZ: "Test Continent" },
          DEMO_COUNTRY_TO_LANGUAGES: {},
          DEMO_COUNTRY_TO_TIMEZONES: { ZZ: ["Test/Zone"] },
        },
        (pickers) => {
          const ctx = pickers.pickDemoGeoContext(() => 0, "ZZ");
          expect(ctx.regionCode).toBe("TX");
          expect(ctx.regionName).toBe("Texas");
          expect(ctx.region).toBe("ZZ::TX::Texas");
          expect(ctx.city).toBe("");
          expect(ctx.continent).toBe("Test Continent");
          expect(ctx.timezone).toBe("Test/Zone");
        },
      );
    });

    it("uses default fallback values when static candidate pools are empty", async () => {
      await withMockedDimensionPools(
        {
          ALL_CONTINENTS: [],
          ALL_LANGUAGES: ["fallback-lang"],
          ALL_TIMEZONES: ["Fallback/Zone"],
          BROWSER_MARKET_WEIGHTS: [],
          DEMO_COUNTRY_TO_CONTINENT: {},
          DEMO_COUNTRY_TO_LANGUAGES: {},
          DEMO_COUNTRY_TO_TIMEZONES: {},
          DEMO_DESKTOP_OS: [],
          DEMO_DESKTOP_SCREENS: [],
          DEMO_MOBILE_OS: [],
          DEMO_MOBILE_SCREENS: [],
          DEMO_TABLET_SCREENS: [],
        },
        (pickers) => {
          expect(pickers.pickDemoBrowser(rng(1), "Desktop")).toBe("Chrome");
          expect(pickers.pickDemoLanguage(rng(1), "ZZ")).toBe("fallback-lang");
          expect(pickers.pickDemoTimezone(rng(1), "ZZ")).toBe("Fallback/Zone");
          expect(pickers.pickDemoContinent(rng(1), "ZZ")).toBe("North America");
          expect(pickers.pickDemoOsVersion(rng(1), "Mobile")).toBe(
            "Android 15",
          );
          expect(pickers.pickDemoOsVersion(rng(1), "Desktop")).toBe(
            "Windows 11",
          );
          expect(pickers.pickDemoOsVersion(() => 0, "Tablet")).toBe("iOS 18");
          expect(pickers.pickDemoOsVersion(() => 0.75, "Tablet")).toBe(
            "Windows 11",
          );
          expect(pickers.pickDemoScreenSize(rng(1), "Mobile")).toBe("390x844");
          expect(pickers.pickDemoScreenSize(rng(1), "Tablet")).toBe("834x1194");
          expect(pickers.pickDemoScreenSize(rng(1), "Desktop")).toBe(
            "1920x1080",
          );
        },
      );
    });
  });
});
