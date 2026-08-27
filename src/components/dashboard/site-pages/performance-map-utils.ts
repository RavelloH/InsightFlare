import type { Feature, FeatureCollection, Geometry, Position } from "geojson";
import isoCountries from "i18n-iso-countries/index.js";
import englishCountryNames from "i18n-iso-countries/langs/en.json";

import { resolveCountryLabel } from "@/lib/i18n/code-labels";
import type { Locale } from "@/lib/i18n/config";

export type CountryFeature = Feature<Geometry, Record<string, unknown>>;
export type CountriesFeatureCollection = FeatureCollection<
  Geometry,
  Record<string, unknown>
>;

export const WORLD_MAP_WIDTH = 960;
export const WORLD_MAP_HEIGHT = 500;

isoCountries.registerLocale(englishCountryNames);

const WORLD_MAP_PADDING = 16;

type MapPerformanceStatus = "great" | "needs-improvement" | "poor" | "none";

export function normalizeCountryCode(
  value: string | null | undefined,
): string | null {
  const normalized = String(value ?? "")
    .trim()
    .toUpperCase();
  return /^[A-Z]{2}$/.test(normalized) ? normalized : null;
}

export function resolveCountryCodeFromFeature(
  feature: CountryFeature | null | undefined,
): string | null {
  if (!feature) return null;
  const props = feature.properties ?? {};
  const alpha2Candidates = [
    props.ISO_A2,
    props.iso_a2,
    props.ADM0_A2,
    props.adm0_a2,
    props.WB_A2,
    props.wb_a2,
  ];

  for (const candidate of alpha2Candidates) {
    const code = normalizeCountryCode(String(candidate ?? ""));
    if (code) return code;
  }

  const alpha3Candidates = [
    props.ISO_A3,
    props.iso_a3,
    props.ADM0_A3,
    props.adm0_a3,
    props.WB_A3,
    props.wb_a3,
    props.SOV_A3,
    props.sov_a3,
    typeof feature.id === "string" ? feature.id : null,
  ];
  for (const candidate of alpha3Candidates) {
    const alpha3 = String(candidate ?? "")
      .trim()
      .toUpperCase();
    if (!/^[A-Z]{3}$/.test(alpha3)) continue;
    const code = normalizeCountryCode(
      isoCountries.alpha3ToAlpha2(alpha3) ?? "",
    );
    if (code) return code;
  }

  const nameCandidates = [props.name, props.NAME, props.admin, props.ADMIN];
  for (const candidate of nameCandidates) {
    const name = String(candidate ?? "").trim();
    if (!name) continue;
    const code = normalizeCountryCode(
      isoCountries.getAlpha2Code(name, "en") ?? "",
    );
    if (code) return code;
  }

  return null;
}

export function resolveCountryLabelFromFeature(
  feature: CountryFeature,
  code: string | null,
  locale: Locale,
  unknownLabel: string,
): string {
  if (code) return resolveCountryLabel(code, locale, unknownLabel).label;
  const props = feature.properties ?? {};
  const labelCandidates = [props.name, props.NAME, props.admin, props.ADMIN];
  for (const candidate of labelCandidates) {
    const label = String(candidate ?? "").trim();
    if (label) return label;
  }
  return unknownLabel;
}

function clampMapCoordinate(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function projectWorldPosition(position: Position): [number, number] {
  const longitude = clampMapCoordinate(Number(position[0] ?? 0), -180, 180);
  const latitude = clampMapCoordinate(Number(position[1] ?? 0), -90, 90);
  const mapWidth = WORLD_MAP_WIDTH - WORLD_MAP_PADDING * 2;
  const mapHeight = WORLD_MAP_HEIGHT - WORLD_MAP_PADDING * 2;
  return [
    WORLD_MAP_PADDING + ((longitude + 180) / 360) * mapWidth,
    WORLD_MAP_PADDING + ((90 - latitude) / 180) * mapHeight,
  ];
}

function ringToPath(ring: Position[]): string {
  return ring
    .map((position, index) => {
      const [x, y] = projectWorldPosition(position);
      return `${index === 0 ? "M" : "L"}${x.toFixed(1)} ${y.toFixed(1)}`;
    })
    .join(" ");
}

export function geometryToPath(geometry: Geometry | null | undefined): string {
  if (!geometry) return "";
  if (geometry.type === "Polygon") {
    return geometry.coordinates
      .map((ring) => `${ringToPath(ring)} Z`)
      .join(" ");
  }
  if (geometry.type === "MultiPolygon") {
    return geometry.coordinates
      .flatMap((polygon) => polygon.map((ring) => `${ringToPath(ring)} Z`))
      .join(" ");
  }
  return "";
}

export function countryFillOpacity(
  status: MapPerformanceStatus,
  samples: number,
): number {
  if (samples <= 0 || status === "none") return 0.07;
  if (status === "great") return 0.48;
  if (status === "needs-improvement") return 0.42;
  return 0.46;
}
