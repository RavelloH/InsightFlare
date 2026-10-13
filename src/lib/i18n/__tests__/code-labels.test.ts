import { describe, expect, it, vi } from "vitest";

import {
  resolveContinentLabel,
  resolveCountryFlagCode,
  resolveCountryLabel,
  resolveLanguageLabel,
} from "@/lib/i18n/code-labels";

describe("Regional Code and Language Translation Resolvers", () => {
  describe("resolveCountryLabel", () => {
    it("should resolve standard region codes using Intl.DisplayNames where supported", () => {
      const usResult = resolveCountryLabel("US", "en", "Unknown Region");
      expect(usResult.code).toBe("US");
      expect(usResult.label).toMatch(/United States|US/);

      const cnResult = resolveCountryLabel("CN", "zh", "未知区域");
      expect(cnResult.code).toBe("CN");
      expect(cnResult.label).toMatch(/中国/);
    });

    it("should respect regional alias mapping rules (e.g. UK -> GB)", () => {
      const ukResult = resolveCountryLabel("UK", "en", "Unknown");
      expect(ukResult.code).toBe("GB");
      expect(ukResult.label).toMatch(/United Kingdom|GB/);
    });

    it("should apply political override rules for Chinese locale (e.g., TW -> 中国台湾)", () => {
      const zhTw = resolveCountryLabel("TW", "zh", "未知");
      expect(zhTw.code).toBe("TW");
      expect(zhTw.label).toBe("中国台湾");

      const zhTwTw = resolveCountryLabel("TW", "zh-tw", "未知");
      expect(zhTwTw.code).toBe("TW");
      expect(zhTwTw.label).toBe("台灣");

      const enTw = resolveCountryLabel("TW", "en", "Unknown");
      expect(enTw.code).toBe("TW");
      expect(enTw.label).not.toBe("中国台湾"); // Should format normally in English
    });

    it("should fall back to raw input as label for non-empty invalid region codes, and use unknownLabel for empty/whitespace", () => {
      // Non-empty invalid code retains the raw value as label
      const invalidCode = resolveCountryLabel("ZZ", "en", "Default Unknown");
      expect(invalidCode.code).toBeNull();
      expect(invalidCode.label).toBe("ZZ");

      // Empty/whitespace code uses unknownLabel
      const emptyCode = resolveCountryLabel("   ", "zh", "未知");
      expect(emptyCode.code).toBeNull();
      expect(emptyCode.label).toBe("未知");
    });
  });

  describe("resolveLanguageLabel", () => {
    it("should resolve defined languages from table", () => {
      expect(resolveLanguageLabel("en", "en", "Unknown")).toEqual({
        label: "English",
        code: "en",
      });

      expect(resolveLanguageLabel("zh", "zh", "未知")).toEqual({
        label: "中文",
        code: "zh",
      });
    });

    it("should normalize locale codes with underscores (e.g., zh_CN -> zh)", () => {
      const result = resolveLanguageLabel("zh_CN", "zh", "未知");
      expect(result.code).toBe("zh");
      expect(result.label).toBe("中文");
    });

    it("should normalize Traditional Chinese language codes (e.g., zh-TW, zh-HK, zh-Hant)", () => {
      const tw = resolveLanguageLabel("zh-TW", "zh-tw", "未知");
      expect(tw.code).toBe("zh-tw");
      expect(tw.label).toBe("繁體中文");

      const hk = resolveLanguageLabel("zh_HK", "zh-tw", "未知");
      expect(hk.code).toBe("zh-tw");
      expect(hk.label).toBe("繁體中文");

      const hant = resolveLanguageLabel("zh-Hant-TW", "zh", "未知");
      expect(hant.code).toBe("zh-tw");
      expect(hant.label).toBe("繁体中文");
    });

    it("should resolve other codes via Intl.DisplayNames if not in static table", () => {
      // "de" is not explicitly checked as override, but resolves to German/德语
      const resultZh = resolveLanguageLabel("de", "zh", "未知");
      expect(resultZh.code).toBe("de");
      expect(resultZh.label).toMatch(/德语|德文/);

      const resultEn = resolveLanguageLabel("de", "en", "Unknown");
      expect(resultEn.code).toBe("de");
      expect(resultEn.label).toMatch(/German/);
    });

    it("should fall back gracefully for unknown language formats", () => {
      const result = resolveLanguageLabel("12345", "en", "Unknown Lang");
      expect(result.code).toBeNull();
      expect(result.label).toBe("12345");

      const emptyResult = resolveLanguageLabel("", "en", "Fallback");
      expect(emptyResult.code).toBeNull();
      expect(emptyResult.label).toBe("Fallback");
    });
  });

  describe("resolveContinentLabel", () => {
    const labels = {
      "NORTH AMERICA": "北美洲",
      "SOUTH AMERICA": "南美洲",
      ASIA: "亚洲",
    };

    it("should normalize spacing, casing, and underscores to find exact label matches", () => {
      expect(
        resolveContinentLabel("  north_america  ", "Unknown", labels),
      ).toBe("北美洲");
      expect(resolveContinentLabel("south   america", "Unknown", labels)).toBe(
        "南美洲",
      );
      expect(resolveContinentLabel("ASIA", "Unknown", labels)).toBe("亚洲");
    });

    it("should return the trimmed raw value if no translation matches", () => {
      expect(resolveContinentLabel("EUROPE", "Unknown", labels)).toBe("EUROPE");
    });

    it("should return unknown label fallback for empty or whitespace inputs", () => {
      expect(resolveContinentLabel("", "Fallback Unknown", labels)).toBe(
        "Fallback Unknown",
      );
    });
  });

  describe("resolveCountryFlagCode", () => {
    it("should redirect Taiwan region flags to China (CN) flag code in Chinese locales", () => {
      expect(resolveCountryFlagCode("TW", "zh")).toBe("CN");
      expect(resolveCountryFlagCode("TW", "zh-tw")).toBe("TW"); // Preserved in Traditional Chinese
      expect(resolveCountryFlagCode("TW", "en")).toBe("TW"); // Remains untouched in English
    });

    it("should format United Kingdom (GB) flags to GB-UKM code", () => {
      expect(resolveCountryFlagCode("GB", "en")).toBe("GB-UKM");
      expect(resolveCountryFlagCode("GB", "zh")).toBe("GB-UKM");
    });

    it("should preserve other region flag codes as is", () => {
      expect(resolveCountryFlagCode("US", "en")).toBe("US");
      expect(resolveCountryFlagCode("FR", "zh")).toBe("FR");
    });

    it("should return null if country code is missing", () => {
      expect(resolveCountryFlagCode(null, "en")).toBeNull();
      expect(resolveCountryFlagCode(undefined as any, "zh")).toBeNull();
    });
  });

  describe("Caching and Exception Fallbacks (Intl DisplayNames)", () => {
    it("should successfully trigger cached formatter branches (Line 88, 100)", () => {
      // First call configures the formatter in the cache
      resolveCountryLabel("FR", "en", "Unknown");
      resolveLanguageLabel("fr", "en", "Unknown");

      // Second call hits the cache
      const cachedCountry = resolveCountryLabel("DE", "en", "Unknown");
      const cachedLang = resolveLanguageLabel("de", "en", "Unknown");

      expect(cachedCountry.label).toBe("Germany");
      expect(cachedLang.label).toBe("German");
    });

    it("should fall back to raw code if Intl does not recognize the language (Line 179)", () => {
      // "xyz" has no translation in static table or Intl
      const result = resolveLanguageLabel("xyz", "en", "Unknown");
      expect(result.code).toBe("xyz");
      expect(result.label).toBe("xyz");
    });

    it("should gracefully handle Intl constructor errors and return null formatter for both country and language resolvers (Line 94, 105)", () => {
      const originalDisplayNames = globalThis.Intl.DisplayNames;
      try {
        Object.defineProperty(globalThis.Intl, "DisplayNames", {
          value: vi.fn(function () {
            throw new Error("DisplayNames mock error");
          }),
          writable: true,
          configurable: true,
        });

        // 1. Test language formatter exception fallback
        // "sv" is not in LANGUAGE_LABELS['zh'] table, it goes to getLanguageFormatter, throws, and falls back to raw code
        const langResult = resolveLanguageLabel("sv", "zh", "Fallback");
        expect(langResult.label).toBe("sv");

        // 2. Test country formatter exception fallback
        // Use a new locale "de" to bypass cached "en"/"zh" country formatters, triggering creation, throwing, and falling back to raw code
        const countryResult = resolveCountryLabel(
          "FR",
          "de" as any,
          "Fallback",
        );
        expect(countryResult.label).toBe("FR");
      } finally {
        Object.defineProperty(globalThis.Intl, "DisplayNames", {
          value: originalDisplayNames,
          writable: true,
          configurable: true,
        });
      }
    });
  });
});
