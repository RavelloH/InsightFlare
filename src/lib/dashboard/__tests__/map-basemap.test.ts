import type { Map as MaplibreMap } from "maplibre-gl";
import { describe, expect, it, vi } from "vitest";

import {
  applyVectorBasemapColorOverrides,
  getVectorBasemapSky,
  getVectorBasemapStyleUrl,
} from "@/lib/dashboard/map-basemap";

function mapStub(
  overrides: Partial<{
    getLayer: (layerId: string) => unknown;
    getPaintProperty: (layerId: string, property: string) => unknown;
    isStyleLoaded: () => boolean;
  }> = {},
): MaplibreMap {
  return {
    getLayer: vi.fn(overrides.getLayer ?? (() => ({}))),
    getPaintProperty: vi.fn(overrides.getPaintProperty ?? (() => undefined)),
    isStyleLoaded: vi.fn(overrides.isStyleLoaded ?? (() => true)),
    setPaintProperty: vi.fn(),
  } as unknown as MaplibreMap;
}

describe("vector basemap helpers", () => {
  it("returns the theme style path and appends non-English locales", () => {
    expect(getVectorBasemapStyleUrl("light")).toBe(
      "/api/public/resources/map/v1/styles/light/style.json",
    );
    expect(getVectorBasemapStyleUrl("dark", "zh")).toBe(
      "/api/public/resources/map/v1/styles/dark/style.json?locale=zh",
    );
    expect(getVectorBasemapStyleUrl("light", "ja")).toBe(
      "/api/public/resources/map/v1/styles/light/style.json?locale=ja",
    );
  });

  it("returns a matching sky for each theme", () => {
    expect(getVectorBasemapSky("light")).toEqual({
      "sky-color": "rgb(255, 255, 255)",
      "horizon-color": "rgb(255, 255, 255)",
      "fog-color": "rgb(255, 255, 255)",
      "atmosphere-blend": 0.18,
    });
    expect(getVectorBasemapSky("dark")).toEqual({
      "sky-color": "rgb(10, 10, 10)",
      "horizon-color": "rgb(10, 10, 10)",
      "fog-color": "rgb(10, 10, 10)",
      "atmosphere-blend": 0.18,
    });
  });

  it("applies every dark color override when the style is ready", () => {
    const map = mapStub();

    applyVectorBasemapColorOverrides(map, "dark");

    expect(map.setPaintProperty).toHaveBeenCalledTimes(14);
    expect(map.setPaintProperty).toHaveBeenCalledWith(
      "background",
      "background-color",
      "#090909",
    );
    expect(map.setPaintProperty).toHaveBeenCalledWith(
      "water",
      "fill-color",
      "#262626",
    );
  });

  it("skips overrides when the style is not dark, not loaded, or already matches", () => {
    const lightMap = mapStub();
    applyVectorBasemapColorOverrides(lightMap, "light");
    expect(lightMap.setPaintProperty).not.toHaveBeenCalled();

    const unloadedMap = mapStub({ isStyleLoaded: () => false });
    applyVectorBasemapColorOverrides(unloadedMap, "dark");
    expect(unloadedMap.setPaintProperty).not.toHaveBeenCalled();

    const matchingMap = mapStub({
      getLayer: (layerId) => (layerId === "water" ? {} : null),
      getPaintProperty: () => "#262626",
    });
    applyVectorBasemapColorOverrides(matchingMap, "dark");
    expect(matchingMap.setPaintProperty).not.toHaveBeenCalled();
  });
});
