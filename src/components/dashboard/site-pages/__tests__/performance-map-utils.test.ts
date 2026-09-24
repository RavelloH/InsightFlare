import { describe, expect, it } from "vitest";

import {
  type CountryFeature,
  countryFillOpacity,
  geometryToPath,
  normalizeCountryCode,
  resolveCountryCodeFromFeature,
  resolveCountryLabelFromFeature,
  WORLD_MAP_HEIGHT,
  WORLD_MAP_WIDTH,
} from "@/components/dashboard/site-pages/performance/performance-map-utils";
function feature(
  properties: Record<string, unknown>,
  id?: string,
): CountryFeature {
  return {
    type: "Feature",
    id,
    properties,
    geometry: null as any,
  };
}
describe("performance map utilities", () => {
  it("normalizes only two-letter country codes", () => {
    expect(normalizeCountryCode(" us ")).toBe("US");
    expect(normalizeCountryCode("usa")).toBeNull();
    expect(normalizeCountryCode("1A")).toBeNull();
    expect(normalizeCountryCode(null)).toBeNull();
  });

  it("resolves country codes from alpha-2, alpha-3, feature id, and names", () => {
    expect(resolveCountryCodeFromFeature(feature({ iso_a2: " gb " }))).toBe(
      "GB",
    );
    expect(resolveCountryCodeFromFeature(feature({ ISO_A3: "USA" }))).toBe(
      "US",
    );
    expect(resolveCountryCodeFromFeature(feature({}, "CAN"))).toBe("CA");
    expect(resolveCountryCodeFromFeature(feature({ ADMIN: "France" }))).toBe(
      "FR",
    );
    expect(resolveCountryCodeFromFeature(feature({ name: "Atlantis" }))).toBe(
      null,
    );
    expect(resolveCountryCodeFromFeature(null)).toBeNull();
  });

  it("resolves labels from country codes, feature properties, or fallback text", () => {
    expect(
      resolveCountryLabelFromFeature(
        feature({ name: "Fallbackland" }),
        "US",
        "en",
        "Unknown",
      ),
    ).toBe("United States");
    expect(
      resolveCountryLabelFromFeature(
        feature({ ADMIN: "Named country" }),
        null,
        "en",
        "Unknown",
      ),
    ).toBe("Named country");
    expect(
      resolveCountryLabelFromFeature(feature({}), null, "en", "Unknown"),
    ).toBe("Unknown");
  });

  it("projects polygons and multipolygons into clamped SVG paths", () => {
    expect(
      geometryToPath({
        type: "Polygon",
        coordinates: [
          [
            [-180, 90],
            [180, -90],
            [0, 0],
          ],
        ],
      }),
    ).toBe("M16.0 16.0 L944.0 484.0 L480.0 250.0 Z");

    expect(
      geometryToPath({
        type: "MultiPolygon",
        coordinates: [
          [
            [
              [-200, 100],
              [200, -100],
            ],
          ],
          [
            [
              [0, 0],
              [180, 90],
            ],
          ],
        ],
      }),
    ).toBe("M16.0 16.0 L944.0 484.0 Z M480.0 250.0 L944.0 16.0 Z");
    expect(geometryToPath({ type: "Point", coordinates: [0, 0] })).toBe("");
    expect(geometryToPath(null)).toBe("");
  });

  it("exports stable map dimensions", () => {
    expect(WORLD_MAP_WIDTH).toBe(960);
    expect(WORLD_MAP_HEIGHT).toBe(500);
  });

  it("maps performance status and samples to fill opacity", () => {
    expect(countryFillOpacity("none", 10)).toBe(0.07);
    expect(countryFillOpacity("great", 0)).toBe(0.07);
    expect(countryFillOpacity("great", 12)).toBe(0.48);
    expect(countryFillOpacity("needs-improvement", 12)).toBe(0.42);
    expect(countryFillOpacity("poor", 12)).toBe(0.46);
  });
});
