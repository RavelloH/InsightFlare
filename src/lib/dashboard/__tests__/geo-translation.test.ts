import { afterEach, describe, expect, it, vi } from "vitest";

import {
  buildGeoTranslationApiUrl,
  fetchGeoCountryCodes,
  fetchGeoCountryTranslationPayload,
  fetchGeoStateTranslationBundle,
  fetchGeoStateTranslationPayload,
  formatLocalizedGeoValue,
  isGeoLabelCountryMatch,
  isGeoRegionCountryMatch,
  isSameGeoLabel,
  matchesGeoLabelRecord,
  normalizeGeoDisplayLabel,
  normalizeGeoTranslationLookupValue,
  parseGeoCountryTranslationPayload,
  parseGeoStateTranslationBundle,
  parseGeoStateTranslationPayload,
  pickLocaleGeoLabel,
  resolveGeoStateTranslation,
  resolveGeoTranslationApiLocale,
  resolveLocalizedCityName,
} from "@/lib/dashboard/geo-translation";

describe("Geographic Translation Utilities", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  describe("resolveGeoTranslationApiLocale & buildGeoTranslationApiUrl", () => {
    it("should resolve API locale correctly", () => {
      expect(resolveGeoTranslationApiLocale("zh")).toBe("zh-CN");
      expect(resolveGeoTranslationApiLocale("en")).toBeNull();
      expect(resolveGeoTranslationApiLocale("ja")).toBe("ja");
    });

    it("should build translation API URL correctly", () => {
      expect(buildGeoTranslationApiUrl("zh-CN", "CN", "GD")).toBe(
        "https://locale.ravelloh.com/zh-CN/CN/GD/",
      );
      expect(buildGeoTranslationApiUrl("zh-CN")).toBe(
        "https://locale.ravelloh.com/zh-CN",
      );
    });
  });

  describe("Geo Translation Lookups and Matching", () => {
    it("should normalize geo lookup strings", () => {
      expect(
        normalizeGeoTranslationLookupValue("  Guangdong & Shenzhen  "),
      ).toBe("guangdong and shenzhen");
      expect(normalizeGeoTranslationLookupValue("St. John's")).toBe("st johns");
    });

    it("should match geo label records with aliases and spacing", () => {
      const record = {
        name: "Guangdong Province",
        name_default: "Guangdong",
        native: "广东省",
        iso2: "GD",
      };

      // Match raw name alias (stripping "Province")
      expect(matchesGeoLabelRecord(record, "guangdong")).toBe(true);
      // Match native
      expect(matchesGeoLabelRecord(record, "广东省")).toBe(true);
      // Match iso2
      expect(matchesGeoLabelRecord(record, "gd")).toBe(true);
      // Fails for unrelated string
      expect(matchesGeoLabelRecord(record, "unrelated")).toBe(false);
      // Fails gracefully for empty record
      expect(matchesGeoLabelRecord(null, "gd")).toBe(false);
    });

    it("should match iso3166 short codes, suffix aliases, and extra values", () => {
      const record = {
        name: "Hong Kong Special Administrative Region",
        name_default: "Hong Kong",
        native: "香港特别行政区",
        iso3166_2: "CN-HK",
      };

      expect(matchesGeoLabelRecord(record, "hk")).toBe(true);
      expect(matchesGeoLabelRecord(record, "hong kong sar")).toBe(true);
      expect(matchesGeoLabelRecord(record, "香港")).toBe(true);
      expect(matchesGeoLabelRecord({}, "custom alias", ["Custom Alias"])).toBe(
        true,
      );
      expect(matchesGeoLabelRecord(record, "   ")).toBe(false);
    });

    it("should ignore labels that normalize to empty aliases", () => {
      expect(matchesGeoLabelRecord({ name: "." }, ".")).toBe(false);
    });

    it("should compare geographic labels for equivalence", () => {
      expect(isSameGeoLabel("Guangdong Province", "guangdong province")).toBe(
        true,
      );
      expect(isSameGeoLabel("  ", "   ")).toBe(false);
    });

    it("should match country labels and regions in payloads", () => {
      const countryPayload = {
        country: {
          name: "China",
          name_default: "China",
          native: "中国",
          code: "CN",
        },
      };

      expect(
        isGeoLabelCountryMatch({
          countryLabel: "CN",
          countryPayload,
          label: "China",
        }),
      ).toBe(true);
      expect(
        isGeoLabelCountryMatch({
          countryLabel: "US",
          countryPayload,
          label: "Beijing",
        }),
      ).toBe(false);

      expect(
        isGeoRegionCountryMatch({
          countryLabel: "CN",
          countryPayload,
          regionLabel: "中国",
        }),
      ).toBe(true);
    });

    it("should reject blank country label lookups", () => {
      expect(
        isGeoLabelCountryMatch({
          countryLabel: "CN",
          countryPayload: { country: { name: "China", code: "CN" } },
          label: "  ",
        }),
      ).toBe(false);
    });
  });

  describe("pickLocaleGeoLabel", () => {
    const record = {
      name: "广东",
      name_default: "Guangdong Default",
      native: "广东省",
    };

    it("should return correct label based on locale choice", () => {
      expect(pickLocaleGeoLabel("zh", record)).toBe("广东省");
      expect(pickLocaleGeoLabel("en", record)).toBe("Guangdong Default");
      expect(pickLocaleGeoLabel("zh", null)).toBe("");
    });

    it("should fall back through available label fields", () => {
      expect(
        pickLocaleGeoLabel("zh", {
          name: "",
          name_default: "Fallback Default",
          native: "Native Fallback",
        }),
      ).toBe("Native Fallback");
      expect(
        pickLocaleGeoLabel("en", {
          name: "English Name",
          name_default: "",
          native: "Native Name",
        }),
      ).toBe("English Name");
      expect(
        pickLocaleGeoLabel("en", {
          name: "",
          name_default: "",
          native: "Native Name",
        }),
      ).toBe("Native Name");
    });

    it("should keep shorter zh labels when native names are not readable expansions", () => {
      expect(
        pickLocaleGeoLabel("zh", {
          name: "广",
          native: "广东",
        }),
      ).toBe("广东");
      expect(
        pickLocaleGeoLabel("zh", {
          name: "A",
          native: "Alpha",
        }),
      ).toBe("A");
      expect(
        pickLocaleGeoLabel("zh", {
          name: "广",
          native: "深",
        }),
      ).toBe("广");
    });
  });

  describe("Payload Parsers", () => {
    it("should return null for malformed payloads", () => {
      expect(parseGeoCountryTranslationPayload(null)).toBeNull();
      expect(parseGeoStateTranslationPayload("not_object")).toBeNull();
    });

    it("should parse country payload correctly", () => {
      const payload = {
        country: { name: "China" },
        states: ["GD", "JS", null],
      };
      const parsed = parseGeoCountryTranslationPayload(payload);
      expect(parsed?.country).toEqual({ name: "China" });
      expect(parsed?.states).toEqual(["GD", "JS"]);
    });

    it("should default invalid country payload fields", () => {
      const parsed = parseGeoCountryTranslationPayload({
        country: "China",
        states: "GD",
      });

      expect(parsed).toEqual({ country: undefined, states: [] });
    });

    it("should parse state payload correctly", () => {
      const payload = {
        country: { name: "China" },
        state: { name: "Guangdong" },
        cities: [{ name: "Shenzhen" }, null],
      };
      const parsed = parseGeoStateTranslationPayload(payload);
      expect(parsed?.state).toEqual({ name: "Guangdong" });
      expect(parsed?.cities).toEqual([{ name: "Shenzhen" }]);
    });

    it("should default invalid state payload fields", () => {
      const parsed = parseGeoStateTranslationPayload({
        country: "China",
        state: "Guangdong",
        cities: "Shenzhen",
      });

      expect(parsed).toEqual({
        country: undefined,
        state: undefined,
        cities: [],
      });
    });

    it("should parse state translation bundle correctly", () => {
      const payload = {
        country: { name: "China" },
        state: { name: "Guangdong", code: "GD" },
        cities: [
          { name: "Shenzhen", name_default: "Shenzhen", native: "深圳" },
          { name: "", name_default: "", native: "" }, // invalid city
        ],
      };
      const bundle = parseGeoStateTranslationBundle(payload);
      expect(bundle?.stateCode).toBe("GD");
      expect(bundle?.stateName).toBe("Guangdong");
      expect(bundle?.cities).toHaveLength(1);
      expect(bundle?.cities[0].name).toBe("Shenzhen");
    });

    it("should use the requested API locale for state and city labels", () => {
      const bundle = parseGeoStateTranslationBundle(
        {
          state: {
            name: "東京都",
            name_default: "Tokyo",
            code: "13",
          },
          cities: [
            {
              name: "新宿区",
              name_default: "Shinjuku",
              native: "新宿区",
            },
          ],
        },
        "ja",
      );

      expect(bundle?.stateName).toBe("東京都");
      expect(resolveLocalizedCityName(bundle, "Shinjuku")).toBe("新宿区");
    });

    it("should parse bundles with missing state and city fallback labels", () => {
      const bundle = parseGeoStateTranslationBundle({
        cities: [
          { name: "", name_default: "Fallback City", native: "" },
          { native: "本地城市" },
        ],
      });

      expect(bundle).toMatchObject({
        country: null,
        state: null,
        stateCode: "",
        stateName: "",
      });
      expect(bundle?.cities).toEqual([
        {
          name: "",
          nameDefault: "Fallback City",
          nativeName: "",
          record: { name: "", name_default: "Fallback City", native: "" },
        },
        {
          name: "",
          nameDefault: "",
          nativeName: "本地城市",
          record: { native: "本地城市" },
        },
      ]);
    });

    it("should parse bundles with missing city arrays", () => {
      expect(
        parseGeoStateTranslationBundle({
          state: { name: "No Cities State", code: "NC" },
        }),
      ).toMatchObject({
        stateCode: "NC",
        stateName: "No Cities State",
        cities: [],
      });
    });

    it("should return null for malformed state bundle payloads", () => {
      expect(parseGeoStateTranslationBundle(null)).toBeNull();
    });
  });

  describe("Geographic Display Formatters", () => {
    it("should format display labels with fallbacks", () => {
      expect(normalizeGeoDisplayLabel("   ", "Unknown")).toBe("Unknown");
      expect(normalizeGeoDisplayLabel("Guangdong", "Unknown")).toBe(
        "Guangdong",
      );

      // Same label -> does not repeat
      expect(formatLocalizedGeoValue("Guangdong", "guangdong", "Unknown")).toBe(
        "Guangdong",
      );
      // Different labels -> formats combined
      expect(formatLocalizedGeoValue("广东省", "Guangdong", "Unknown")).toBe(
        "广东省 (Guangdong)",
      );
    });
  });

  describe("resolveLocalizedCityName", () => {
    it("should translate raw city names based on bundle cities records", () => {
      const bundle = {
        country: null,
        state: null,
        stateCode: "GD",
        stateName: "广东省",
        cities: [
          {
            name: "深圳",
            nameDefault: "Shenzhen",
            nativeName: "深圳",
            record: { name: "深圳", name_default: "Shenzhen", native: "深圳" },
          },
        ],
      };

      expect(resolveLocalizedCityName(bundle, "Shenzhen")).toBe("深圳");
      expect(resolveLocalizedCityName(bundle, "Beijing")).toBeNull();
      expect(resolveLocalizedCityName(bundle, "")).toBeNull();
      expect(resolveLocalizedCityName(null, "Shenzhen")).toBeNull();
    });

    it("should fall back through city labels after matching record aliases", () => {
      const bundle = {
        country: null,
        state: null,
        stateCode: "FB",
        stateName: "Fallback State",
        cities: [
          {
            name: "Primary Fallback",
            nameDefault: "Default Fallback",
            nativeName: "Native Fallback",
            record: { iso2: "PC" },
          },
          {
            name: "",
            nameDefault: "Default Only",
            nativeName: "Native Only",
            record: { iso2: "DC" },
          },
          {
            name: "",
            nameDefault: "",
            nativeName: "Native Only",
            record: { iso2: "NC" },
          },
          {
            name: "",
            nameDefault: "",
            nativeName: "",
            record: { iso2: "NL" },
          },
        ],
      };

      expect(resolveLocalizedCityName(bundle, "PC")).toBe("Primary Fallback");
      expect(resolveLocalizedCityName(bundle, "DC")).toBe("Default Only");
      expect(resolveLocalizedCityName(bundle, "NC")).toBe("Native Only");
      expect(resolveLocalizedCityName(bundle, "NL")).toBeNull();
    });
  });

  describe("API Fetchers and Cache Layer", () => {
    it("should fetch and cache geo country codes successfully", async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ["CN", "US", null],
      });
      vi.stubGlobal("fetch", mockFetch);

      const codes1 = await fetchGeoCountryCodes("zh-CN");
      expect(codes1).toEqual(["CN", "US"]);
      expect(mockFetch).toHaveBeenCalledTimes(1);

      // Subsequent call hits cache
      const codes2 = await fetchGeoCountryCodes("zh-CN");
      expect(codes2).toEqual(["CN", "US"]);
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    it("should keep country code caches separate for each API locale", async () => {
      const mockFetch = vi.fn().mockImplementation((url: string) =>
        Promise.resolve({
          ok: true,
          json: async () => (url.includes("codes-ja") ? ["JP"] : ["CN"]),
        }),
      );
      vi.stubGlobal("fetch", mockFetch);

      await expect(fetchGeoCountryCodes("codes-zh")).resolves.toEqual(["CN"]);
      await expect(fetchGeoCountryCodes("codes-ja")).resolves.toEqual(["JP"]);
      await expect(fetchGeoCountryCodes("codes-zh")).resolves.toEqual(["CN"]);

      expect(mockFetch).toHaveBeenCalledTimes(2);
    });

    it("should return null when country code fetch rejects", async () => {
      vi.resetModules();
      const { fetchGeoCountryCodes: freshFetchGeoCountryCodes } =
        await import("@/lib/dashboard/geo-translation");
      const mockFetch = vi.fn().mockRejectedValue(new Error("Network Error"));
      vi.stubGlobal("fetch", mockFetch);

      await expect(
        freshFetchGeoCountryCodes("codes-error"),
      ).resolves.toBeNull();
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    it("should return null for non-ok and malformed country code responses", async () => {
      vi.resetModules();
      const { fetchGeoCountryCodes: fetchNonOkCountryCodes } =
        await import("@/lib/dashboard/geo-translation");
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false }));
      await expect(fetchNonOkCountryCodes("codes-non-ok")).resolves.toBeNull();

      vi.resetModules();
      const { fetchGeoCountryCodes: fetchMalformedCountryCodes } =
        await import("@/lib/dashboard/geo-translation");
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue({
          ok: true,
          json: async () => ({ codes: ["CN"] }),
        }),
      );
      await expect(
        fetchMalformedCountryCodes("codes-malformed"),
      ).resolves.toBeNull();
    });

    it("should handle failed country codes fetch gracefully", async () => {
      // Re-trigger by clear cached promise if possible, but cache is a module variable.
      // So we can mock fetch rejection or non-ok
      const mockFetch = vi.fn().mockResolvedValue({ ok: false });
      vi.stubGlobal("fetch", mockFetch);

      // If we use a different API locale or mock error paths, we can test error catch blocks
      const mockFetchError = vi
        .fn()
        .mockRejectedValue(new Error("Network Error"));
      vi.stubGlobal("fetch", mockFetchError);

      const payload = await fetchGeoCountryTranslationPayload(
        "zh-CN",
        "INVALID_CODE",
      );
      expect(payload).toBeNull();
    });

    it("should return null when country payload fetch rejects", async () => {
      const mockFetch = vi.fn().mockRejectedValue(new Error("Network Error"));
      vi.stubGlobal("fetch", mockFetch);

      await expect(
        fetchGeoCountryTranslationPayload("country-error", "ER"),
      ).resolves.toBeNull();
    });

    it("should return null for non-ok country payload responses", async () => {
      const mockFetch = vi.fn().mockResolvedValue({ ok: false });
      vi.stubGlobal("fetch", mockFetch);

      await expect(
        fetchGeoCountryTranslationPayload("country-non-ok", "NO"),
      ).resolves.toBeNull();
    });

    it("should fetch country and state translation payloads and bundle", async () => {
      const mockFetch = vi.fn().mockImplementation((url: string) => {
        if (url.includes("GD")) {
          // State payload
          return Promise.resolve({
            ok: true,
            json: () =>
              Promise.resolve({
                country: { name: "China" },
                state: { name: "Guangdong", code: "GD" },
                cities: [{ name: "Shenzhen", native: "深圳" }],
              }),
          });
        }
        // Country payload
        return Promise.resolve({
          ok: true,
          json: () =>
            Promise.resolve({
              country: { name: "China" },
              states: ["GD"],
            }),
        });
      });
      vi.stubGlobal("fetch", mockFetch);

      const countryPayload = await fetchGeoCountryTranslationPayload(
        "zh-CN",
        "CN",
      );
      expect(countryPayload?.states).toEqual(["GD"]);

      const statePayload = await fetchGeoStateTranslationPayload(
        "zh-CN",
        "CN",
        "GD",
      );
      expect(statePayload?.state?.name).toBe("Guangdong");

      const bundle = await fetchGeoStateTranslationBundle("zh-CN", "CN", "GD");
      expect(bundle?.stateName).toBe("Guangdong");
      expect(bundle?.cities[0].nativeName).toBe("深圳");
    });

    it("should skip fetches for invalid state payload lookups", async () => {
      const mockFetch = vi.fn();
      vi.stubGlobal("fetch", mockFetch);

      await expect(
        fetchGeoStateTranslationPayload("invalid-state", "CN", "bad state"),
      ).resolves.toBeNull();
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it("should return null when state payload fetch rejects", async () => {
      const mockFetch = vi.fn().mockRejectedValue(new Error("Network Error"));
      vi.stubGlobal("fetch", mockFetch);

      await expect(
        fetchGeoStateTranslationPayload("state-error", "SE", "AA"),
      ).resolves.toBeNull();
    });

    it("should return null for non-ok state payload responses", async () => {
      const mockFetch = vi.fn().mockResolvedValue({ ok: false });
      vi.stubGlobal("fetch", mockFetch);

      await expect(
        fetchGeoStateTranslationPayload("state-non-ok", "SN", "AA"),
      ).resolves.toBeNull();
    });

    it("should skip fetches for invalid state bundle lookups", async () => {
      const mockFetch = vi.fn();
      vi.stubGlobal("fetch", mockFetch);

      await expect(
        fetchGeoStateTranslationBundle("invalid-bundle", "CN", "bad state"),
      ).resolves.toBeNull();
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it("should return null when state bundle parsing fails", async () => {
      const state = { name: "Broken State" };
      Object.defineProperty(state, "code", {
        get: () => {
          throw new Error("Broken code");
        },
      });
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ state, cities: [] }),
      });
      vi.stubGlobal("fetch", mockFetch);

      await expect(
        fetchGeoStateTranslationBundle("throwing-bundle", "TB", "ER"),
      ).resolves.toBeNull();
    });

    it("should cache state bundles and return null when payloads are missing", async () => {
      const cachedFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          state: { name: "Cached Bundle", code: "CB" },
          cities: [],
        }),
      });
      vi.stubGlobal("fetch", cachedFetch);

      await expect(
        fetchGeoStateTranslationBundle("cached-bundle", "CB", "AA"),
      ).resolves.toMatchObject({ stateName: "Cached Bundle" });
      await expect(
        fetchGeoStateTranslationBundle("cached-bundle", "CB", "AA"),
      ).resolves.toMatchObject({ stateName: "Cached Bundle" });
      expect(cachedFetch).toHaveBeenCalledTimes(1);

      const missingFetch = vi.fn().mockResolvedValue({ ok: false });
      vi.stubGlobal("fetch", missingFetch);
      await expect(
        fetchGeoStateTranslationBundle("missing-bundle", "MB", "AA"),
      ).resolves.toBeNull();
    });
  });

  describe("resolveGeoStateTranslation Integration Flows", () => {
    it("should resolve state translations cleanly", async () => {
      const mockFetch = vi.fn().mockImplementation((url: string) => {
        if (url.includes("GD")) {
          return Promise.resolve({
            ok: true,
            json: () =>
              Promise.resolve({
                country: { name: "China", native: "中国" },
                state: { name: "Guangdong", code: "GD" },
                cities: [{ name: "Shenzhen", native: "深圳" }],
              }),
          });
        }
        return Promise.resolve({
          ok: true,
          json: () =>
            Promise.resolve({
              country: { name: "China", native: "中国" },
              states: ["GD"],
            }),
        });
      });
      vi.stubGlobal("fetch", mockFetch);

      // 1. Direct State Resolution Flow (with state code)
      const res1 = await resolveGeoStateTranslation("zh-CN", "CN", "GD");
      expect(res1?.stateCode).toBe("GD");
      expect(res1?.bundle?.stateName).toBe("Guangdong");

      // 2. Region / Locality Fallback Resolution Flow (without valid state code)
      const res2 = await resolveGeoStateTranslation("zh-CN", "CN", "", {
        regionLabel: "Guangdong",
        localityLabel: "Shenzhen",
      });
      expect(res2?.stateCode).toBe("GD");
      expect(res2?.regionMatchesCountry).toBe(false);

      // Edge case: null country
      expect(await resolveGeoStateTranslation("zh-CN", "", "")).toBeNull();
    });

    it("should resolve by locality when region mapping is missing", async () => {
      const mockFetch = vi.fn().mockImplementation((url: string) => {
        if (url.endsWith("/LC/AA/")) {
          return Promise.resolve({
            ok: true,
            json: () =>
              Promise.resolve({
                state: { name: "Alpha Province", code: "AA" },
                cities: [{ name: "Capital City", native: "首府" }],
              }),
          });
        }
        if (url.endsWith("/LC/BB/")) {
          return Promise.resolve({
            ok: true,
            json: () =>
              Promise.resolve({
                state: { name: "Beta Province", code: "BB" },
                cities: [{ name: "Coastal City", native: "海城" }],
              }),
          });
        }
        return Promise.resolve({
          ok: true,
          json: () =>
            Promise.resolve({
              country: { name: "Locality Country", code: "LC" },
              states: ["AA", "AA", "BB"],
            }),
        });
      });
      vi.stubGlobal("fetch", mockFetch);

      const resolution = await resolveGeoStateTranslation(
        "locality-fallback",
        "LC",
        "",
        { localityLabel: "Coastal City" },
      );

      expect(resolution?.stateCode).toBe("BB");
      expect(resolution?.bundle?.stateName).toBe("Beta Province");
      expect(resolution?.regionMatchesCountry).toBe(false);
      expect(resolution?.localityMatchesCountry).toBe(false);
      expect(mockFetch).toHaveBeenCalledTimes(3);
    });

    it("should avoid state lookups when locality already matches the country", async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () =>
          Promise.resolve({
            country: { name: "Country Only", code: "CO" },
            states: ["AA"],
          }),
      });
      vi.stubGlobal("fetch", mockFetch);

      const resolution = await resolveGeoStateTranslation(
        "country-locality",
        "CO",
        "",
        {
          countryLabel: "CO",
          localityLabel: "Country Only",
        },
      );

      expect(resolution).toMatchObject({
        statePayload: null,
        bundle: null,
        stateCode: "",
        regionMatchesCountry: false,
        localityMatchesCountry: true,
      });
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    it("should use requested state code when direct payload omits state codes", async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () =>
          Promise.resolve({
            state: { name: "Direct Fallback State" },
            cities: [],
          }),
      });
      vi.stubGlobal("fetch", mockFetch);

      const resolution = await resolveGeoStateTranslation(
        "direct-code-fallback",
        "DF",
        "ZZ",
      );

      expect(resolution).toMatchObject({
        countryPayload: null,
        stateCode: "ZZ",
        bundle: {
          stateCode: "",
          stateName: "Direct Fallback State",
        },
      });
    });

    it("should revalidate a direct state code against the raw region label", async () => {
      const mockFetch = vi.fn().mockImplementation((url: string) => {
        if (url.endsWith("/VN/26/")) {
          return Promise.resolve({
            ok: true,
            json: async () => ({
              country: { name: "Vietnam", code: "VN" },
              state: { name: "Thua Thien-Hue", code: "26" },
              cities: [],
            }),
          });
        }
        if (url.endsWith("/VN/33/")) {
          return Promise.resolve({
            ok: true,
            json: async () => ({
              country: { name: "Vietnam", code: "VN" },
              state: { name: "Dak Lak", code: "33" },
              cities: [],
            }),
          });
        }
        return Promise.resolve({
          ok: true,
          json: async () => ({
            country: { name: "Vietnam", code: "VN" },
            states: ["26", "33"],
          }),
        });
      });
      vi.stubGlobal("fetch", mockFetch);

      const resolution = await resolveGeoStateTranslation(
        "direct-region-validation",
        "VN",
        "26",
        { regionLabel: "Dak Lak" },
      );

      expect(resolution).toMatchObject({
        stateCode: "33",
        bundle: { stateName: "Dak Lak" },
      });
      expect(mockFetch).toHaveBeenCalledTimes(3);
    });

    it("should ignore a direct state when the raw region is the country label", async () => {
      const mockFetch = vi.fn().mockImplementation((url: string) => {
        if (url.endsWith("/TW/04/")) {
          return Promise.resolve({
            ok: true,
            json: async () => ({
              country: { name: "Taiwan", code: "TW" },
              state: { name: "Taiwan", code: "04" },
              cities: [],
            }),
          });
        }
        if (url.endsWith("/TW/TPE/")) {
          return Promise.resolve({
            ok: true,
            json: async () => ({
              country: { name: "Taiwan", code: "TW" },
              state: { name: "Taipei", code: "TPE" },
              cities: [{ name: "Taipei", name_default: "Taipei" }],
            }),
          });
        }
        return Promise.resolve({
          ok: true,
          json: async () => ({
            country: { name: "Taiwan", code: "TW" },
            states: ["04", "TPE"],
          }),
        });
      });
      vi.stubGlobal("fetch", mockFetch);

      const resolution = await resolveGeoStateTranslation(
        "country-region-validation",
        "TW",
        "04",
        {
          countryLabel: "Taiwan",
          regionLabel: "Taiwan",
          localityLabel: "Taipei",
        },
      );

      expect(resolution).toMatchObject({
        stateCode: "TPE",
        bundle: { stateName: "Taipei" },
        regionMatchesCountry: true,
      });
      expect(mockFetch).toHaveBeenCalledTimes(3);
    });

    it("should resolve missing mapping with default options", async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () =>
          Promise.resolve({
            country: { name: "Missing Options", code: "MO" },
            states: [],
          }),
      });
      vi.stubGlobal("fetch", mockFetch);

      const resolution = await resolveGeoStateTranslation(
        "default-options",
        "MO",
        "",
      );

      expect(resolution).toMatchObject({
        statePayload: null,
        bundle: null,
        stateCode: "",
        regionMatchesCountry: false,
        localityMatchesCountry: false,
      });
    });

    it("should dedupe fallback region matches by usable state codes", async () => {
      const mockFetch = vi.fn().mockImplementation((url: string) => {
        if (url.endsWith("/DD/AA/")) {
          return Promise.resolve({
            ok: true,
            json: () =>
              Promise.resolve({
                state: { name: "Shared Region" },
                cities: [],
              }),
          });
        }
        if (url.endsWith("/DD/BB/")) {
          return Promise.resolve({
            ok: true,
            json: () =>
              Promise.resolve({
                state: { name: "Shared Region", code: "DU" },
                cities: [],
              }),
          });
        }
        if (url.endsWith("/DD/CC/")) {
          return Promise.resolve({
            ok: true,
            json: () =>
              Promise.resolve({
                state: { name: "Shared Region", code: "DU" },
                cities: [],
              }),
          });
        }
        return Promise.resolve({
          ok: true,
          json: () =>
            Promise.resolve({
              country: { name: "Dedupe Country", code: "DD" },
              states: ["AA", "BB", "CC"],
            }),
        });
      });
      vi.stubGlobal("fetch", mockFetch);

      const resolution = await resolveGeoStateTranslation(
        "dedupe-region",
        "DD",
        "",
        { regionLabel: "Shared Region" },
      );

      expect(resolution?.stateCode).toBe("DU");
      expect(resolution?.bundle?.stateName).toBe("Shared Region");
    });

    it("should leave ambiguous locality fallback unresolved", async () => {
      const mockFetch = vi.fn().mockImplementation((url: string) => {
        if (url.endsWith("/AM/AA/")) {
          return Promise.resolve({
            ok: true,
            json: () =>
              Promise.resolve({
                state: { name: "No City State", code: "AA" },
              }),
          });
        }
        if (url.endsWith("/AM/BB/")) {
          return Promise.resolve({
            ok: true,
            json: () =>
              Promise.resolve({
                state: { name: "First City State", code: "BB" },
                cities: [{ name: "Shared City" }],
              }),
          });
        }
        if (url.endsWith("/AM/CC/")) {
          return Promise.resolve({
            ok: true,
            json: () =>
              Promise.resolve({
                state: { name: "Second City State", code: "CC" },
                cities: [{ name: "Shared City" }],
              }),
          });
        }
        return Promise.resolve({
          ok: true,
          json: () =>
            Promise.resolve({
              country: { name: "Ambiguous Country", code: "AM" },
              states: ["AA", "BB", "CC"],
            }),
        });
      });
      vi.stubGlobal("fetch", mockFetch);

      const resolution = await resolveGeoStateTranslation(
        "ambiguous-locality",
        "AM",
        "",
        { localityLabel: "Shared City" },
      );

      expect(resolution).toMatchObject({
        statePayload: null,
        bundle: null,
        stateCode: "",
        regionMatchesCountry: false,
        localityMatchesCountry: false,
      });
    });

    it("should ignore locality fallback states with missing city arrays", async () => {
      const mockFetch = vi.fn().mockImplementation((url: string) => {
        if (url.endsWith("/MC/AA/")) {
          return Promise.resolve({
            ok: true,
            json: () =>
              Promise.resolve({
                state: { name: "Missing Cities State", code: "AA" },
              }),
          });
        }
        return Promise.resolve({
          ok: true,
          json: () =>
            Promise.resolve({
              country: { name: "Missing Cities Country", code: "MC" },
              states: ["AA"],
            }),
        });
      });
      vi.stubGlobal("fetch", mockFetch);

      const resolution = await resolveGeoStateTranslation(
        "missing-city-array",
        "MC",
        "",
        { localityLabel: "Nowhere" },
      );

      expect(resolution).toMatchObject({
        statePayload: null,
        bundle: null,
        stateCode: "",
      });
    });

    it("should fall back when direct state lookup has no state", async () => {
      const mockFetch = vi.fn().mockImplementation((url: string) => {
        if (url.endsWith("/NS/AA/")) {
          return Promise.resolve({
            ok: true,
            json: () =>
              Promise.resolve({
                country: { name: "No State Country", code: "NS" },
                cities: [],
              }),
          });
        }
        return Promise.resolve({
          ok: true,
          json: () =>
            Promise.resolve({
              country: { name: "No State Country", code: "NS" },
              states: [],
            }),
        });
      });
      vi.stubGlobal("fetch", mockFetch);

      const resolution = await resolveGeoStateTranslation(
        "missing-direct-state",
        "NS",
        "AA",
      );

      expect(resolution).toMatchObject({
        statePayload: null,
        bundle: null,
        stateCode: "",
      });
    });

    it("should reuse cached country state payloads during fallback resolution", async () => {
      const mockFetch = vi.fn().mockImplementation((url: string) => {
        if (url.endsWith("/CS/AA/")) {
          return Promise.resolve({
            ok: true,
            json: () =>
              Promise.resolve({
                state: { name: "Cached State", code: "AA" },
                cities: [],
              }),
          });
        }
        return Promise.resolve({
          ok: true,
          json: () =>
            Promise.resolve({
              country: { name: "Cached States Country", code: "CS" },
              states: ["AA"],
            }),
        });
      });
      vi.stubGlobal("fetch", mockFetch);

      await expect(
        resolveGeoStateTranslation("country-state-cache", "CS", "", {
          regionLabel: "Cached State",
        }),
      ).resolves.toMatchObject({ stateCode: "AA" });
      await expect(
        resolveGeoStateTranslation("country-state-cache", "CS", "", {
          regionLabel: "Cached State",
        }),
      ).resolves.toMatchObject({ stateCode: "AA" });
      expect(mockFetch).toHaveBeenCalledTimes(2);
    });
  });
});
