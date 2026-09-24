import { describe, expect, it } from "vitest";

import {
  buildLocalityLocationValue,
  buildRegionLocationValue,
  canonicalizeGeoLocationValue,
  normalizeGeoNameToken,
  parentGeoLocationValue,
  parseGeoLocationValue,
} from "@/lib/analytics/geo-location";
describe("Geographic Location Parsing and Canonicalization", () => {
  describe("normalizeGeoNameToken", () => {
    it("should remove diacritics, lowercase, and trim whitespace", () => {
      expect(normalizeGeoNameToken("  München  ")).toBe("munchen");
      expect(normalizeGeoNameToken("São Paulo")).toBe("sao paulo");
      expect(normalizeGeoNameToken("   ")).toBe("");
      expect(normalizeGeoNameToken(null)).toBe("");
    });
  });

  describe("buildRegionLocationValue & buildLocalityLocationValue", () => {
    it("should build correct region values from codes and names", () => {
      expect(buildRegionLocationValue("cn", "gd", "Guangdong")).toBe(
        "CN::GD::Guangdong",
      );
      // Fallback behavior when name or code is missing
      expect(buildRegionLocationValue("cn", "", "Guangdong")).toBe(
        "CN::GUANGDONG::Guangdong",
      );
      expect(buildRegionLocationValue("cn", "gd", "")).toBe("CN::GD::gd");
    });

    it("should build correct locality values", () => {
      expect(
        buildLocalityLocationValue("cn", "gd", "Guangdong", "Shenzhen"),
      ).toBe("CN::GD::Guangdong::Shenzhen");
      expect(
        buildLocalityLocationValue("cn", "", "Guangdong", "Shenzhen"),
      ).toBe("CN::GUANGDONG::Guangdong::Shenzhen");
      expect(buildLocalityLocationValue("cn", "gd", "", "Shenzhen")).toBe(
        "CN::GD::gd::Shenzhen",
      );
      // Fallback behavior when region segments are missing
      expect(
        buildLocalityLocationValue("cn", null, undefined, "Shenzhen"),
      ).toBe("CN::Shenzhen");
    });
  });

  describe("canonicalizeGeoLocationValue", () => {
    it("should return null for empty or invalid raw values", () => {
      expect(canonicalizeGeoLocationValue(null)).toBeNull();
      expect(canonicalizeGeoLocationValue("   ")).toBeNull();
      expect(canonicalizeGeoLocationValue("invalid")).toBeNull(); // Country code must be 2 letters
      expect(canonicalizeGeoLocationValue("::")).toBeNull();
    });

    it("should correctly handle single country segment", () => {
      expect(canonicalizeGeoLocationValue("cn")).toBe("CN");
      expect(canonicalizeGeoLocationValue("  us  ")).toBe("US");
      expect(canonicalizeGeoLocationValue("cn::")).toBe("CN");
    });

    it("should correctly handle two segments (locality level)", () => {
      expect(canonicalizeGeoLocationValue("cn::Shenzhen")).toBe("CN::Shenzhen");
      expect(canonicalizeGeoLocationValue("cn::   ")).toBe("CN");
    });

    it("should correctly handle three segments (region level)", () => {
      expect(canonicalizeGeoLocationValue("cn::gd::Guangdong")).toBe(
        "CN::GD::Guangdong",
      );
    });

    it("should correctly handle four or more segments (locality with region)", () => {
      expect(
        canonicalizeGeoLocationValue("cn::gd::Guangdong::Shenzhen::Futian"),
      ).toBe("CN::GD::Guangdong::Shenzhen::Futian");
      expect(
        canonicalizeGeoLocationValue(" us :: ca ::  :: Los Angeles "),
      ).toBe("US::CA::Los Angeles");
    });
  });

  describe("parseGeoLocationValue", () => {
    it("should return null for invalid canonicals", () => {
      expect(parseGeoLocationValue("")).toBeNull();
      expect(parseGeoLocationValue("invalid_country_code")).toBeNull();
    });

    it("should parse country-level values", () => {
      expect(parseGeoLocationValue("us")).toEqual({
        canonical: "US",
        level: "country",
        countryCode: "US",
      });
    });

    it("should parse locality-level values with 2 segments", () => {
      expect(parseGeoLocationValue("us::Boston")).toEqual({
        canonical: "US::Boston",
        level: "locality",
        countryCode: "US",
        localityName: "Boston",
      });
    });

    it("should parse region-level values with 3 segments", () => {
      expect(parseGeoLocationValue("cn::gd::Guangdong")).toEqual({
        canonical: "CN::GD::Guangdong",
        level: "region",
        countryCode: "CN",
        regionCode: "GD",
        regionName: "Guangdong",
      });
    });

    it("should parse locality-level values with 4+ segments", () => {
      expect(parseGeoLocationValue("cn::gd::Guangdong::Shenzhen")).toEqual({
        canonical: "CN::GD::Guangdong::Shenzhen",
        level: "locality",
        countryCode: "CN",
        regionCode: "GD",
        regionName: "Guangdong",
        localityName: "Shenzhen",
      });
    });
  });

  describe("parentGeoLocationValue", () => {
    it("should return null for empty/invalid locations or country levels", () => {
      expect(parentGeoLocationValue(null)).toBeNull();
      expect(
        parentGeoLocationValue({
          level: "country",
          countryCode: "CN",
          canonical: "CN",
        }),
      ).toBeNull();
    });

    it("should return country for region level", () => {
      expect(
        parentGeoLocationValue({
          canonical: "CN::GD::Guangdong",
          level: "region",
          countryCode: "CN",
          regionCode: "GD",
          regionName: "Guangdong",
        }),
      ).toBe("CN");
    });

    it("should resolve region as parent for locality level if region is present", () => {
      expect(
        parentGeoLocationValue({
          canonical: "CN::GD::Guangdong::Shenzhen",
          level: "locality",
          countryCode: "CN",
          regionCode: "GD",
          regionName: "Guangdong",
          localityName: "Shenzhen",
        }),
      ).toBe("CN::GD::Guangdong");
      expect(
        parentGeoLocationValue({
          canonical: "CN::GD::Shenzhen",
          level: "locality",
          countryCode: "CN",
          regionCode: "GD",
          localityName: "Shenzhen",
        }),
      ).toBe("CN::GD::GD");
      expect(
        parentGeoLocationValue({
          canonical: "CN::Guangdong::Shenzhen",
          level: "locality",
          countryCode: "CN",
          regionName: "Guangdong",
          localityName: "Shenzhen",
        }),
      ).toBe("CN::GUANGDONG::Guangdong");
    });

    it("should resolve country as parent for locality level if region is completely absent", () => {
      expect(
        parentGeoLocationValue({
          canonical: "CN::Shenzhen",
          level: "locality",
          countryCode: "CN",
          localityName: "Shenzhen",
        }),
      ).toBe("CN");
    });
  });
});
