import type { Map as MaplibreMap, SkySpecification } from "maplibre-gl";

import type { Locale } from "@/lib/i18n/config";

export type DashboardMapTheme = "light" | "dark";

const VECTOR_BASEMAP_STYLE_PATHS: Record<DashboardMapTheme, string> = {
  light: "/api/public/resources/map/v1/styles/light/style.json",
  dark: "/api/public/resources/map/v1/styles/dark/style.json",
};

export function getVectorBasemapStyleUrl(
  theme: DashboardMapTheme,
  locale: Locale = "en",
): string {
  const path = VECTOR_BASEMAP_STYLE_PATHS[theme];
  return locale === "en"
    ? path
    : `${path}?locale=${encodeURIComponent(locale)}`;
}

export function getVectorBasemapSky(
  theme: DashboardMapTheme,
): SkySpecification {
  const backgroundColor =
    theme === "dark" ? "rgb(10, 10, 10)" : "rgb(255, 255, 255)";

  return {
    "sky-color": backgroundColor,
    "horizon-color": backgroundColor,
    "fog-color": backgroundColor,
    "atmosphere-blend": 0.18,
  };
}

const DARK_VECTOR_BASEMAP_PAINT_OVERRIDES = [
  ["background", "background-color", "#090909"],
  ["landcover", "fill-color", "#090909"],
  ["park_national_park", "fill-color", "#090909"],
  ["park_nature_reserve", "fill-color", "#090909"],
  ["landuse_residential", "fill-color", "#090909"],
  ["landuse", "fill-color", "#090909"],
  ["water", "fill-color", "#262626"],
  ["waterway", "line-color", "#262626"],
  ["boundary_country_outline", "line-color", "#262626"],
  ["boundary_country_inner", "line-color", "#3b3b3b"],
  ["watername_ocean", "text-color", "#444444"],
  ["place_country_1", "text-color", "#4a4a4a"],
  ["place_country_2", "text-color", "#4a4a4a"],
  ["place_continent", "text-color", "#444444"],
] as const;

export function applyVectorBasemapColorOverrides(
  map: MaplibreMap,
  theme: DashboardMapTheme,
): void {
  if (theme !== "dark" || !map.isStyleLoaded()) return;

  for (const [
    layerId,
    property,
    color,
  ] of DARK_VECTOR_BASEMAP_PAINT_OVERRIDES) {
    if (!map.getLayer(layerId)) continue;
    if (map.getPaintProperty(layerId, property) === color) continue;
    map.setPaintProperty(layerId, property, color);
  }
}
