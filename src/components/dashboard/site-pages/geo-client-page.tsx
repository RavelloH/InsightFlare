"use client";

import { memo, useEffect, useMemo, useRef, useState } from "react";
import type { MapViewState } from "@deck.gl/core";
import { GeoJsonLayer, ScatterplotLayer } from "@deck.gl/layers";
import { MapboxOverlay, type MapboxOverlayProps } from "@deck.gl/mapbox";
import isoCountries from "i18n-iso-countries";
import type { Feature, GeoJSON, Geometry } from "geojson";
import { AnimatePresence, motion } from "motion/react";
import { useTheme } from "next-themes";
import type { StyleSpecification } from "maplibre-gl";
import Map, { type MapRef, useControl } from "react-map-gl/maplibre";
import { GeoCountryStatsPanel } from "@/components/dashboard/geo-country-stats-panel";
import { useDashboardQuery } from "@/components/dashboard/site-pages/use-dashboard-query";
import { AutoResizer } from "@/components/ui/auto-resizer";
import { AutoTransition } from "@/components/ui/auto-transition";
import { pushUrlWithoutNavigation, useLiveSearchParams } from "@/lib/client-history";
import {
  fetchOverviewGeoDimensionTab,
  fetchOverviewGeoPoints,
  type OverviewGeoTabRows,
} from "@/lib/dashboard/client-data";
import {
  buildLocalityLocationValue,
  buildRegionLocationValue,
  normalizeGeoNameToken,
  parseGeoLocationValue,
  parentGeoLocationValue,
  type GeoLocationLevel,
  type ParsedGeoLocation,
} from "@/lib/dashboard/geo-location";
import { numberFormat } from "@/lib/dashboard/format";
import type { DashboardFilters } from "@/lib/dashboard/query-state";
import type { OverviewGeoPointsData } from "@/lib/edge-client";
import type { Locale } from "@/lib/i18n/config";
import { resolveCountryLabel } from "@/lib/i18n/code-labels";
import type { AppMessages } from "@/lib/i18n/messages";

interface GeoClientPageProps {
  locale: Locale;
  messages: AppMessages;
  siteId: string;
}

interface GeoPoint {
  latitude: number;
  longitude: number;
  country: string;
  region?: string;
  regionCode?: string;
  city?: string;
}

interface ClusteredGeoPoint {
  id: string;
  latitude: number;
  longitude: number;
  count: number;
}

interface CountryCount {
  country: string;
  views: number;
  sessions: number;
  visitors: number;
}

interface GeoDimensionCount {
  value: string;
  label: string;
  views: number;
  sessions: number;
  visitors: number;
}

interface GeoStatsEntry {
  key: string;
  label: string;
  views: number;
  sessions: number;
  visitors: number;
}

interface GeoDirectoryEntry {
  key: string;
  label: string;
}

interface GeoLocationFocusResponse {
  ok: boolean;
  center?: {
    latitude: number;
    longitude: number;
  };
  country?: {
    code: string;
    label: string;
  } | null;
  region?: {
    code: string;
    label: string;
  } | null;
  locality?: {
    label: string;
  } | null;
}

interface LocaleCountryRecord {
  code?: string;
  name?: string;
  name_default?: string;
  native?: string;
  latitude?: string | number;
  longitude?: string | number;
}

interface LocaleStateRecord {
  code?: string;
  iso2?: string;
  name?: string;
  name_default?: string;
  native?: string;
  latitude?: string | number;
  longitude?: string | number;
}

interface LocaleCityRecord {
  name?: string;
  name_default?: string;
  native?: string;
  latitude?: string | number;
  longitude?: string | number;
}

interface LocaleCountryPayload {
  country?: LocaleCountryRecord;
  states?: string[];
}

interface LocaleStatePayload {
  country?: LocaleCountryRecord;
  state?: LocaleStateRecord;
  cities?: LocaleCityRecord[];
}

type EffectiveMapTheme = "light" | "dark";
type CountryFeature = Feature<Geometry, Record<string, unknown>>;

const DEFAULT_VIEW_STATE: MapViewState = {
  longitude: 0,
  latitude: 20,
  zoom: 1,
  minZoom: 0.3,
  maxZoom: 19,
  pitch: 0,
  bearing: 0,
};
const MAP_ACCENT_RGB: [number, number, number] = [34, 197, 154];
const MAP_POINT_ALPHA_VISIBLE = 112;
const CLUSTER_RADIUS_PX = 26;
const CLUSTER_ZOOM_STEP = 0.25;
const EMPTY_COUNTRY_FEATURES = {
  type: "FeatureCollection",
  features: [],
} as const satisfies GeoJSON;
const MAP_VIEWPORT_RENDER_ISOLATION_STYLE = {
  contain: "layout paint",
  transform: "translateZ(0)",
  willChange: "transform",
} as const;
const LOCALE_LOCATION_API_BASE = "https://locale.ravelloh.com/zh-CN";
const GEO_STATE_CODE_PATTERN = /^[A-Z0-9-]{1,16}$/;
const localeCountryPayloadCache = new globalThis.Map<
  string,
  Promise<LocaleCountryPayload | null>
>();
const localeStatePayloadCache = new globalThis.Map<
  string,
  Promise<LocaleStatePayload | null>
>();
let localeCountryCodesRequest: Promise<string[] | null> | null = null;

function emptyOverviewGeoPoints(): OverviewGeoPointsData {
  return {
    ok: true,
    data: [],
    countryCounts: [],
    regionCounts: [],
    cityCounts: [],
  };
}

function buildRasterStyle(theme: EffectiveMapTheme): StyleSpecification {
  const sourceId = `insightflare-geo-map-source-${theme}`;
  const layerId = `insightflare-geo-map-layer-${theme}`;
  const endpoint = `/api/map-tiles/{z}/{x}/{y}.png?theme=${theme}`;

  return {
    version: 8,
    name: `insightflare-geo-map-${theme}`,
    sources: {
      [sourceId]: {
        type: "raster",
        tiles: [endpoint],
        tileSize: 256,
        attribution: "© OpenStreetMap contributors © CARTO",
      },
    },
    layers: [
      {
        id: layerId,
        type: "raster",
        source: sourceId,
        minzoom: 0,
        maxzoom: 22,
      },
    ],
  };
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function withAlpha(
  rgb: [number, number, number],
  alpha: number,
): [number, number, number, number] {
  return [rgb[0], rgb[1], rgb[2], alpha];
}

function computeInitialViewState(points: GeoPoint[]): MapViewState {
  if (points.length === 0) return DEFAULT_VIEW_STATE;

  let minLat = 90;
  let maxLat = -90;
  let minLon = 180;
  let maxLon = -180;

  for (const point of points) {
    minLat = Math.min(minLat, point.latitude);
    maxLat = Math.max(maxLat, point.latitude);
    minLon = Math.min(minLon, point.longitude);
    maxLon = Math.max(maxLon, point.longitude);
  }

  const latSpan = Math.max(0.01, maxLat - minLat);
  const lonSpan = Math.max(0.01, maxLon - minLon);

  if (lonSpan >= 210 || latSpan >= 110) {
    return DEFAULT_VIEW_STATE;
  }

  const centerLat = (minLat + maxLat) / 2;
  const centerLon = (minLon + maxLon) / 2;
  const zoomFromLat = Math.log2(170 / Math.max(4, latSpan));
  const zoomFromLon = Math.log2(360 / Math.max(4, lonSpan));
  const zoom = clamp(Math.min(zoomFromLat, zoomFromLon) + 0.02, 0.95, 6.2);

  return {
    ...DEFAULT_VIEW_STATE,
    latitude: Number.isFinite(centerLat) ? centerLat : DEFAULT_VIEW_STATE.latitude,
    longitude: Number.isFinite(centerLon)
      ? centerLon
      : DEFAULT_VIEW_STATE.longitude,
    zoom: Number.isFinite(zoom) ? zoom : DEFAULT_VIEW_STATE.zoom,
  };
}

function focusZoomForLevel(level: GeoLocationLevel): number {
  if (level === "country") return 2.85;
  if (level === "region") return 5.15;
  return 8.35;
}

function focusZoomRangeForLevel(
  level: GeoLocationLevel,
): { min: number; max: number } {
  if (level === "country") {
    return { min: 2.4, max: 4.1 };
  }
  if (level === "region") {
    return { min: 4.4, max: 6.8 };
  }
  return { min: 7.4, max: 10.2 };
}

function resolveFocusedViewState(
  points: GeoPoint[],
  location: ParsedGeoLocation | null,
  focus: GeoLocationFocusResponse | null,
): MapViewState {
  const pointViewState = computeInitialViewState(points);
  if (!location) return pointViewState;

  const fallbackZoom = focusZoomForLevel(location.level);
  const { min, max } = focusZoomRangeForLevel(location.level);
  const constrainedPointZoom = clamp(
    Number(pointViewState.zoom ?? fallbackZoom),
    min,
    max,
  );

  if (focus?.center) {
    return {
      ...DEFAULT_VIEW_STATE,
      latitude: focus.center.latitude,
      longitude: focus.center.longitude,
      zoom: fallbackZoom,
    };
  }

  const latitude =
    pointViewState.latitude ??
    DEFAULT_VIEW_STATE.latitude;
  const longitude =
    pointViewState.longitude ??
    DEFAULT_VIEW_STATE.longitude;

  return {
    ...DEFAULT_VIEW_STATE,
    latitude,
    longitude,
    zoom: constrainedPointZoom,
  };
}

function resolveGeoPoints(
  data: OverviewGeoPointsData,
  location: ParsedGeoLocation | null,
): GeoPoint[] {
  return data.data
    .map((item) => ({
      latitude: Number(item.latitude),
      longitude: Number(item.longitude),
      country: String(item.country ?? "").trim().toUpperCase(),
      region: String((item as { region?: unknown }).region ?? "").trim(),
      regionCode: String((item as { regionCode?: unknown }).regionCode ?? "")
        .trim()
        .toUpperCase(),
      city: String((item as { city?: unknown }).city ?? "").trim(),
    }))
    .filter(
      (item) =>
        Number.isFinite(item.latitude) &&
        Number.isFinite(item.longitude) &&
        Math.abs(item.latitude) <= 90 &&
        Math.abs(item.longitude) <= 180 &&
        matchesLocationPoint(item, location),
    );
}

function animateMapTransition(
  map: MapRef,
  targetViewState: MapViewState,
  targetLocation: ParsedGeoLocation | null,
  animationKeyRef: { current: number },
) {
  const animationKey = ++animationKeyRef.current;
  const minimumZoom = 0.75;
  const targetZoom = Number(targetViewState.zoom ?? DEFAULT_VIEW_STATE.zoom);
  const targetCenter: [number, number] = [
    Number(targetViewState.longitude ?? DEFAULT_VIEW_STATE.longitude),
    Number(targetViewState.latitude ?? DEFAULT_VIEW_STATE.latitude),
  ];

  const runStep = (step: () => void) => {
    if (animationKeyRef.current !== animationKey) return;
    step();
  };

  if (!Number.isFinite(targetCenter[0]) || !Number.isFinite(targetCenter[1])) {
    return;
  }

  map.stop();
  if (targetLocation) {
    map.easeTo({
      center: targetCenter,
      zoom: targetZoom,
      duration: 950,
      essential: true,
    });
    return;
  }

  map.easeTo({
    zoom: minimumZoom,
    duration: 450,
    essential: true,
  });

  map.once("moveend", () =>
    runStep(() => {
      map.easeTo({
        center: targetCenter,
        zoom: minimumZoom,
        duration: 700,
        essential: true,
      });

      map.once("moveend", () =>
        runStep(() => {
          map.easeTo({
            center: targetCenter,
            zoom: targetZoom,
            duration: 850,
            essential: true,
          });
        }),
      );
    }),
  );
}

function resolveCountryFeatureKey(
  feature: CountryFeature | null | undefined,
): string {
  if (!feature) return "";
  if (typeof feature.id === "string" || typeof feature.id === "number") {
    return String(feature.id);
  }

  const props = feature.properties ?? {};
  const fallbackKeys = [
    "ISO_A3",
    "iso_a3",
    "ADM0_A3",
    "adm0_a3",
    "ISO_A2",
    "iso_a2",
    "NAME",
    "name",
    "ADMIN",
    "admin",
  ] as const;

  for (const key of fallbackKeys) {
    const value = props[key];
    if (typeof value === "string" && value.trim().length > 0) {
      return value.trim();
    }
  }

  return "";
}

function normalizeCountryCode(value: string | null | undefined): string | null {
  const normalized = String(value ?? "").trim().toUpperCase();
  if (!/^[A-Z]{2}$/.test(normalized)) return null;
  return normalized;
}

function resolveCountryCodeFromFeature(
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
    props.country,
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
    props.GU_A3,
    props.gu_a3,
    props.SU_A3,
    props.su_a3,
    props.BRK_A3,
    props.brk_a3,
    typeof feature.id === "string" ? feature.id : null,
    resolveCountryFeatureKey(feature),
  ];

  for (const candidate of alpha3Candidates) {
    const normalizedAlpha3 = String(candidate ?? "").trim().toUpperCase();
    if (!/^[A-Z]{3}$/.test(normalizedAlpha3)) continue;
    const alpha2 = isoCountries.alpha3ToAlpha2(normalizedAlpha3);
    const code = normalizeCountryCode(alpha2 ?? "");
    if (code) return code;
  }

  const nameCandidates = [
    props.name,
    props.NAME,
    props.NAME_LONG,
    props.ADMIN,
    props.admin,
    props.FORMAL_EN,
    resolveCountryDisplayNameFromFeature(feature),
  ];
  for (const candidate of nameCandidates) {
    const normalizedName = String(candidate ?? "").trim();
    if (!normalizedName) continue;
    const alpha2 = isoCountries.getAlpha2Code(normalizedName, "en");
    const code = normalizeCountryCode(alpha2 ?? "");
    if (code) return code;
  }

  return null;
}

function resolveCountryDisplayNameFromFeature(
  feature: CountryFeature | null | undefined,
): string {
  if (!feature) return "";
  const props = feature.properties ?? {};
  const nameCandidates = [props.name, props.NAME, props.admin, props.ADMIN];
  for (const candidate of nameCandidates) {
    if (typeof candidate === "string" && candidate.trim().length > 0) {
      return candidate.trim();
    }
  }
  return "";
}

function projectLongitudeToWorldX(longitude: number, zoom: number): number {
  const scale = 256 * 2 ** zoom;
  return ((longitude + 180) / 360) * scale;
}

function projectLatitudeToWorldY(latitude: number, zoom: number): number {
  const lat = Math.max(-85, Math.min(85, latitude));
  const rad = (lat * Math.PI) / 180;
  const scale = 256 * 2 ** zoom;
  return (
    (0.5 - Math.log((1 + Math.sin(rad)) / (1 - Math.sin(rad))) / (4 * Math.PI)) *
    scale
  );
}

function normalizeClusterZoom(zoom: number): number {
  const safeZoom = Number.isFinite(zoom) ? zoom : DEFAULT_VIEW_STATE.zoom;
  const snapped = Math.round(safeZoom / CLUSTER_ZOOM_STEP) * CLUSTER_ZOOM_STEP;
  return clamp(
    snapped,
    DEFAULT_VIEW_STATE.minZoom ?? 0,
    DEFAULT_VIEW_STATE.maxZoom ?? 22,
  );
}

function clusterGeoPoints(points: GeoPoint[], zoom: number): ClusteredGeoPoint[] {
  if (points.length === 0) return [];

  const buckets = new globalThis.Map<
    string,
    { count: number; sumLatitude: number; sumLongitude: number }
  >();

  for (const point of points) {
    const x = projectLongitudeToWorldX(point.longitude, zoom);
    const y = projectLatitudeToWorldY(point.latitude, zoom);
    const cellX = Math.floor(x / CLUSTER_RADIUS_PX);
    const cellY = Math.floor(y / CLUSTER_RADIUS_PX);
    const key = `${cellX}:${cellY}`;

    const bucket = buckets.get(key) ?? {
      count: 0,
      sumLatitude: 0,
      sumLongitude: 0,
    };
    bucket.count += 1;
    bucket.sumLatitude += point.latitude;
    bucket.sumLongitude += point.longitude;
    buckets.set(key, bucket);
  }

  const clusters: ClusteredGeoPoint[] = [];
  for (const [id, bucket] of buckets.entries()) {
    clusters.push({
      id,
      latitude: bucket.sumLatitude / bucket.count,
      longitude: bucket.sumLongitude / bucket.count,
      count: bucket.count,
    });
  }
  return clusters;
}

function computeClusterPointRadius(count: number, zoom: number): number {
  const safeCount = Number.isFinite(count) ? Math.max(1, count) : 1;
  const safeZoom = normalizeClusterZoom(zoom);
  const baseRadius = 2.8 + Math.log2(safeCount + 1) * 2.15;
  const zoomScale = clamp(0.62 + safeZoom * 0.18, 0.74, 1.28);
  return clamp(baseRadius * zoomScale, 2.2, 32);
}

function dashboardFilterSignature(filters: DashboardFilters): string {
  const entries = Object.entries(filters)
    .map(([key, value]) => [key, String(value ?? "").trim()] as const)
    .filter(([, value]) => value.length > 0)
    .sort(([left], [right]) => left.localeCompare(right));
  return JSON.stringify(entries);
}

function parseCoordinate(
  value: string | number | null | undefined,
): number | null {
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : null;
  }

  const normalized = String(value ?? "").trim();
  if (!normalized) return null;

  const numeric = Number(normalized);
  return Number.isFinite(numeric) ? numeric : null;
}

function pickLocaleGeoLabel(
  locale: Locale,
  record:
    | {
        name?: string;
        name_default?: string;
        native?: string;
      }
    | null
    | undefined,
): string {
  if (!record) return "";
  if (locale === "zh") {
    return (
      String(record.name ?? "").trim() ||
      String(record.name_default ?? "").trim() ||
      String(record.native ?? "").trim()
    );
  }

  return (
    String(record.name_default ?? "").trim() ||
    String(record.name ?? "").trim() ||
    String(record.native ?? "").trim()
  );
}

async function fetchLocaleCountryCodes(): Promise<string[] | null> {
  if (localeCountryCodesRequest) return localeCountryCodesRequest;

  localeCountryCodesRequest = fetch(`${LOCALE_LOCATION_API_BASE}`, {
    method: "GET",
    cache: "force-cache",
  })
    .then(async (response) => {
      if (!response.ok) return null;
      const payload = (await response.json()) as unknown;
      if (!Array.isArray(payload)) return null;
      return payload
        .map((value) => normalizeCountryCode(String(value ?? "")))
        .filter((value): value is string => Boolean(value));
    })
    .catch(() => null);

  return localeCountryCodesRequest;
}

async function fetchLocaleCountryPayload(
  countryCode: string,
): Promise<LocaleCountryPayload | null> {
  const normalizedCountry = countryCode.trim().toUpperCase();
  if (!normalizedCountry) return null;

  const cached = localeCountryPayloadCache.get(normalizedCountry);
  if (cached) return cached;

  const request = fetch(
    `${LOCALE_LOCATION_API_BASE}/${encodeURIComponent(normalizedCountry)}/`,
    {
      method: "GET",
      cache: "force-cache",
    },
  )
    .then(async (response) => {
      if (!response.ok) return null;
      return (await response.json()) as LocaleCountryPayload;
    })
    .catch(() => null);

  localeCountryPayloadCache.set(normalizedCountry, request);
  return request;
}

async function fetchLocaleStatePayload(
  countryCode: string,
  stateCode: string,
): Promise<LocaleStatePayload | null> {
  const normalizedCountry = countryCode.trim().toUpperCase();
  const normalizedState = stateCode.trim().toUpperCase();
  if (
    !normalizedCountry ||
    !normalizedState ||
    !GEO_STATE_CODE_PATTERN.test(normalizedState)
  ) {
    return null;
  }

  const cacheKey = `${normalizedCountry}::${normalizedState}`;
  const cached = localeStatePayloadCache.get(cacheKey);
  if (cached) return cached;

  const request = fetch(
    `${LOCALE_LOCATION_API_BASE}/${encodeURIComponent(normalizedCountry)}/${encodeURIComponent(normalizedState)}/`,
    {
      method: "GET",
      cache: "force-cache",
    },
  )
    .then(async (response) => {
      if (!response.ok) return null;
      return (await response.json()) as LocaleStatePayload;
    })
    .catch(() => null);

  localeStatePayloadCache.set(cacheKey, request);
  return request;
}

function dedupeGeoDirectoryEntries(
  entries: GeoDirectoryEntry[] | null | undefined,
): GeoDirectoryEntry[] {
  const deduped = new globalThis.Map<string, GeoDirectoryEntry>();
  for (const entry of entries ?? []) {
    const key = String(entry.key ?? "").trim();
    const label = String(entry.label ?? "").trim();
    if (!key || !label || deduped.has(key)) continue;
    deduped.set(key, { key, label });
  }
  return [...deduped.values()];
}

function resolveCountryLocationFocus(
  payload: LocaleCountryPayload | null,
  locale: Locale,
): GeoLocationFocusResponse | null {
  const latitude = parseCoordinate(payload?.country?.latitude);
  const longitude = parseCoordinate(payload?.country?.longitude);
  if (!payload?.country || latitude === null || longitude === null) {
    return null;
  }

  return {
    ok: true,
    center: { latitude, longitude },
    country: {
      code: String(payload.country.code ?? "").trim().toUpperCase(),
      label: pickLocaleGeoLabel(locale, payload.country),
    },
    region: null,
    locality: null,
  };
}

function resolveStateLocationFocus(
  payload: LocaleStatePayload | null,
  locale: Locale,
  location: ParsedGeoLocation,
): GeoLocationFocusResponse | null {
  if (!payload?.state) return null;

  if (location.level === "locality" && location.localityName) {
    const locality =
      payload.cities?.find((record) =>
        matchesLocalityRecord(record, location.localityName ?? ""),
      ) ?? null;
    if (!locality) return null;

    const latitude =
      parseCoordinate(locality.latitude) ??
      parseCoordinate(payload.state.latitude) ??
      parseCoordinate(payload.country?.latitude);
    const longitude =
      parseCoordinate(locality.longitude) ??
      parseCoordinate(payload.state.longitude) ??
      parseCoordinate(payload.country?.longitude);
    if (latitude === null || longitude === null) return null;

    return {
      ok: true,
      center: { latitude, longitude },
      country: payload.country
        ? {
            code: String(payload.country.code ?? "").trim().toUpperCase(),
            label: pickLocaleGeoLabel(locale, payload.country),
          }
        : null,
      region: {
        code: String(payload.state.code ?? payload.state.iso2 ?? "")
          .trim()
          .toUpperCase(),
        label: pickLocaleGeoLabel(locale, payload.state),
      },
      locality: {
        label: pickLocaleGeoLabel(locale, locality),
      },
    };
  }

  const latitude =
    parseCoordinate(payload.state.latitude) ??
    parseCoordinate(payload.country?.latitude);
  const longitude =
    parseCoordinate(payload.state.longitude) ??
    parseCoordinate(payload.country?.longitude);
  if (latitude === null || longitude === null) return null;

  return {
    ok: true,
    center: { latitude, longitude },
    country: payload.country
      ? {
          code: String(payload.country.code ?? "").trim().toUpperCase(),
          label: pickLocaleGeoLabel(locale, payload.country),
        }
      : null,
    region: {
      code: String(payload.state.code ?? payload.state.iso2 ?? "")
        .trim()
        .toUpperCase(),
      label: pickLocaleGeoLabel(locale, payload.state),
    },
    locality: null,
  };
}

async function fetchGeoLocaleBundle(
  location: ParsedGeoLocation | null,
  locale: Locale,
  unknownLabel: string,
): Promise<{
  focus: GeoLocationFocusResponse | null;
  directoryEntries: GeoDirectoryEntry[];
}> {
  if (!location) {
    const countryCodes = await fetchLocaleCountryCodes();
    return {
      focus: null,
      directoryEntries: dedupeGeoDirectoryEntries(
        (countryCodes ?? []).map((countryCode) => ({
          key: countryCode,
          label: resolveCountryLabel(countryCode, locale, unknownLabel).label,
        })),
      ),
    };
  }

  if (location.level === "country") {
    const countryPayload = await fetchLocaleCountryPayload(location.countryCode);
    const stateCodes = Array.isArray(countryPayload?.states)
      ? countryPayload.states
          .map((value) => String(value ?? "").trim().toUpperCase())
          .filter((value) => value.length > 0)
      : [];
    const statePayloads = await Promise.all(
      stateCodes.map((stateCode) =>
        fetchLocaleStatePayload(location.countryCode, stateCode),
      ),
    );

    return {
      focus: resolveCountryLocationFocus(countryPayload, locale),
      directoryEntries: dedupeGeoDirectoryEntries(
        stateCodes.map((stateCode, index) => {
          const stateRecord = statePayloads[index]?.state;
          const canonicalRegionName =
            String(
              stateRecord?.name_default ??
                stateRecord?.name ??
                stateRecord?.native ??
                stateCode,
            ).trim() || stateCode;

          return {
            key: buildRegionLocationValue(
              location.countryCode,
              stateCode,
              canonicalRegionName,
            ),
            label: pickLocaleGeoLabel(locale, stateRecord) || canonicalRegionName,
          };
        }),
      ),
    };
  }

  if (!location.regionCode) {
    return { focus: null, directoryEntries: [] };
  }

  const statePayload = await fetchLocaleStatePayload(
    location.countryCode,
    location.regionCode,
  );
  const stateRecord = statePayload?.state;
  const canonicalRegionName =
    String(
      stateRecord?.name_default ??
        stateRecord?.name ??
        stateRecord?.native ??
        location.regionName ??
        location.regionCode,
    ).trim() ||
    location.regionName ||
    location.regionCode ||
    "";

  return {
    focus: resolveStateLocationFocus(statePayload, locale, location),
    directoryEntries: dedupeGeoDirectoryEntries(
      Array.isArray(statePayload?.cities)
        ? statePayload.cities.map((city) => {
            const canonicalLocalityName =
              String(city.name_default ?? city.name ?? city.native ?? "").trim() ||
              unknownLabel;

            return {
              key: buildLocalityLocationValue(
                location.countryCode,
                location.regionCode,
                canonicalRegionName,
                canonicalLocalityName,
              ),
              label: pickLocaleGeoLabel(locale, city) || canonicalLocalityName,
            };
          })
        : [],
    ),
  };
}

function matchesLocalityRecord(
  record: LocaleCityRecord,
  localityName: string,
): boolean {
  const expected = normalizeGeoNameToken(localityName);
  if (!expected) return false;

  return [record.name, record.name_default, record.native]
    .map((value) => normalizeGeoNameToken(value))
    .filter((value) => value.length > 0)
    .some((candidate) => {
      if (candidate === expected) return true;
      return candidate.includes(expected) || expected.includes(candidate);
    });
}

function matchesRegionPoint(
  point: Pick<GeoPoint, "region" | "regionCode">,
  location: ParsedGeoLocation,
): boolean {
  const expectedTokens = new Set(
    [location.regionCode, location.regionName]
      .map((value) => String(value ?? "").trim().toUpperCase())
      .filter((value) => value.length > 0),
  );
  if (expectedTokens.size === 0) return true;

  const actualTokens = new Set(
    [point.regionCode, point.region]
      .map((value) => String(value ?? "").trim().toUpperCase())
      .filter((value) => value.length > 0),
  );
  if (actualTokens.size === 0) return false;

  for (const token of actualTokens) {
    if (expectedTokens.has(token)) return true;
  }
  return false;
}

function matchesLocationPoint(
  point: GeoPoint,
  location: ParsedGeoLocation | null,
): boolean {
  if (!location) return true;

  const pointCountry = String(point.country ?? "").trim().toUpperCase();
  if (pointCountry !== location.countryCode) {
    return false;
  }

  if (location.level === "country") {
    return true;
  }

  if (!matchesRegionPoint(point, location)) {
    return false;
  }

  if (location.level === "region") {
    return true;
  }

  const expectedLocality = normalizeGeoNameToken(location.localityName);
  const actualLocality = normalizeGeoNameToken(point.city);
  if (!expectedLocality) return true;
  if (!actualLocality) return false;
  return (
    actualLocality === expectedLocality ||
    actualLocality.includes(expectedLocality) ||
    expectedLocality.includes(actualLocality)
  );
}

const DeckOverlay = memo(function DeckOverlay(props: MapboxOverlayProps) {
  const overlay = useControl<MapboxOverlay>(() => new MapboxOverlay(props));
  overlay.setProps(props);
  return null;
});

export function GeoClientPage({
  locale,
  messages,
  siteId,
}: GeoClientPageProps) {
  const { window, filters } = useDashboardQuery();
  const searchParams = useLiveSearchParams();
  const requestedLocation = useMemo(
    () => parseGeoLocationValue(searchParams.get("location")),
    [searchParams],
  );
  const requestFilters = useMemo<DashboardFilters>(
    () => ({
      ...filters,
      ...(requestedLocation?.canonical ? { geo: requestedLocation.canonical } : {}),
    }),
    [filters, requestedLocation?.canonical],
  );
  const requestFiltersKey = useMemo(
    () => dashboardFilterSignature(requestFilters),
    [requestFilters],
  );
  const { resolvedTheme } = useTheme();
  const [loading, setLoading] = useState(true);
  const [mounted, setMounted] = useState(false);
  const [geoPointsData, setGeoPointsData] = useState<OverviewGeoPointsData>(
    emptyOverviewGeoPoints(),
  );
  const [geoTabRows, setGeoTabRows] = useState<OverviewGeoTabRows>([]);
  const [countryGeoJson, setCountryGeoJson] = useState<GeoJSON | null>(null);
  const [hoveredCountryKey, setHoveredCountryKey] = useState<string | null>(null);
  const [hoveredCountryCode, setHoveredCountryCode] = useState<string | null>(null);
  const [hoveredCountryName, setHoveredCountryName] = useState("");
  const [currentZoom, setCurrentZoom] = useState(
    normalizeClusterZoom(DEFAULT_VIEW_STATE.zoom),
  );
  const [activeLocation, setActiveLocation] = useState<ParsedGeoLocation | null>(null);
  const [locationFocus, setLocationFocus] = useState<GeoLocationFocusResponse | null>(
    null,
  );
  const [geoDirectoryEntries, setGeoDirectoryEntries] = useState<
    GeoDirectoryEntry[] | null
  >(null);
  const mapRef = useRef<MapRef | null>(null);
  const mapAnimationKeyRef = useRef(0);

  useEffect(() => {
    setMounted(true);
  }, []);

  useEffect(() => {
    if (activeLocation) {
      setHoveredCountryKey(null);
      setHoveredCountryCode(null);
      setHoveredCountryName("");
    }
  }, [activeLocation]);

  useEffect(() => {
    let active = true;

    fetch("/api/world-countries", { cache: "force-cache" })
      .then((response) => (response.ok ? response.json() : null))
      .then((payload) => {
        if (!active) return;
        const isFeatureCollection =
          payload &&
          typeof payload === "object" &&
          "type" in payload &&
          (payload as { type?: unknown }).type === "FeatureCollection";
        setCountryGeoJson(isFeatureCollection ? (payload as GeoJSON) : null);
      })
      .catch(() => {
        if (!active) return;
        setCountryGeoJson(null);
      });

    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    let active = true;
    setLoading(true);
    setLocationFocus(null);
    setGeoDirectoryEntries(null);

    const dimensionTab = !requestedLocation
      ? null
      : requestedLocation?.level === "country"
        ? "region"
        : "city";

    Promise.all([
      fetchOverviewGeoPoints(siteId, window, requestFilters, {
        limit: 5000,
        applyGeoFilter: Boolean(requestedLocation?.canonical),
      }),
      dimensionTab
        ? fetchOverviewGeoDimensionTab(siteId, window, dimensionTab, requestFilters, {
            limit: dimensionTab === "city" ? 600 : 400,
          })
        : Promise.resolve([] as OverviewGeoTabRows),
      fetchGeoLocaleBundle(requestedLocation, locale, messages.common.unknown),
    ])
      .then(([nextGeoPoints, nextGeoTabRows, nextGeoLocaleBundle]) => {
        if (!active) return;
        const nextPoints = resolveGeoPoints(nextGeoPoints, requestedLocation);
        const nextViewState = resolveFocusedViewState(
          nextPoints,
          requestedLocation,
          nextGeoLocaleBundle.focus,
        );
        setGeoPointsData(nextGeoPoints);
        setGeoTabRows(nextGeoTabRows);
        setLocationFocus(nextGeoLocaleBundle.focus);
        setGeoDirectoryEntries(nextGeoLocaleBundle.directoryEntries);
        setActiveLocation(requestedLocation);
        const map = mapRef.current;
        if (map) {
          animateMapTransition(
            map,
            nextViewState,
            requestedLocation,
            mapAnimationKeyRef,
          );
        }
      })
      .catch(() => {
        if (!active) return;
        setGeoPointsData(emptyOverviewGeoPoints());
        setGeoTabRows([]);
        setLocationFocus(null);
        setGeoDirectoryEntries([]);
      })
      .finally(() => {
        if (!active) return;
        setLoading(false);
      });

    return () => {
      active = false;
    };
  }, [
    locale,
    requestedLocation?.canonical,
    requestFilters,
    requestFiltersKey,
    messages.common.unknown,
    siteId,
    window.from,
    window.interval,
    window.to,
  ]);

  const points = useMemo(
    () => resolveGeoPoints(geoPointsData, activeLocation),
    [activeLocation, geoPointsData],
  );

  const initialViewState = useMemo(
    () => resolveFocusedViewState(points, activeLocation, locationFocus),
    [activeLocation, locationFocus, points],
  );
  const effectiveMapTheme: EffectiveMapTheme =
    mounted && resolvedTheme === "dark" ? "dark" : "light";
  const mapStyle = useMemo(
    () => buildRasterStyle(effectiveMapTheme),
    [effectiveMapTheme],
  );

  useEffect(() => {
    setCurrentZoom(
      normalizeClusterZoom(initialViewState.zoom ?? DEFAULT_VIEW_STATE.zoom),
    );
  }, [initialViewState.zoom]);

  const clusteredPoints = useMemo(
    () => clusterGeoPoints(points, currentZoom),
    [currentZoom, points],
  );
  const countryCountMap = useMemo(() => {
    const map = new globalThis.Map<string, CountryCount>();
    for (const row of geoPointsData.countryCounts) {
      const code = normalizeCountryCode(row.country);
      if (!code) continue;
      map.set(code, {
        country: code,
        views: Number(row.views ?? 0),
        sessions: Number(row.sessions ?? 0),
        visitors: Number(row.visitors ?? 0),
      });
    }
    return map;
  }, [geoPointsData.countryCounts]);

  const showCountryHover = !activeLocation;
  const layers = useMemo(() => {
    const nextLayers: MapboxOverlayProps["layers"] = [
      new ScatterplotLayer<ClusteredGeoPoint>({
        id: "geo-page-clustered-points",
        data: clusteredPoints,
        getFillColor: withAlpha(MAP_ACCENT_RGB, MAP_POINT_ALPHA_VISIBLE),
        getPosition: (item) => [item.longitude, item.latitude],
        getRadius: (item) => computeClusterPointRadius(item.count, currentZoom),
        radiusUnits: "pixels",
        radiusMinPixels: 2,
        radiusMaxPixels: 32,
        pickable: false,
      }),
    ];

    if (showCountryHover) {
      nextLayers.push(
        new GeoJsonLayer<Record<string, unknown>>({
          id: "geo-page-country-outline-hover",
          data: countryGeoJson ?? EMPTY_COUNTRY_FEATURES,
          filled: true,
          stroked: true,
          lineWidthUnits: "pixels",
          lineWidthMinPixels: 0,
          getFillColor: () => [0, 0, 0, 0],
          getLineColor: (feature) =>
            resolveCountryFeatureKey(feature) === hoveredCountryKey
              ? withAlpha(MAP_ACCENT_RGB, 240)
              : [0, 0, 0, 0],
          getLineWidth: (feature) =>
            resolveCountryFeatureKey(feature) === hoveredCountryKey ? 2.5 : 0,
          pickable: true,
          onHover: (info) => {
            const feature = (info.object as CountryFeature | undefined) ?? null;
            const nextKey = resolveCountryFeatureKey(feature);
            const nextCode = resolveCountryCodeFromFeature(feature);
            const nextName = resolveCountryDisplayNameFromFeature(feature);
            setHoveredCountryKey((previous) => {
              const normalized = nextKey.length > 0 ? nextKey : null;
              return previous === normalized ? previous : normalized;
            });
            setHoveredCountryCode((previous) =>
              previous === nextCode ? previous : nextCode,
            );
            setHoveredCountryName((previous) =>
              previous === nextName ? previous : nextName,
            );
          },
          updateTriggers: {
            getLineColor: hoveredCountryKey,
            getLineWidth: hoveredCountryKey,
          },
        }),
      );
    }

    return nextLayers;
  }, [
    clusteredPoints,
    countryGeoJson,
    currentZoom,
    hoveredCountryKey,
    showCountryHover,
  ]);

  const hoveredCountryLabel = useMemo(() => {
    if (hoveredCountryCode) {
      return resolveCountryLabel(
        hoveredCountryCode,
        locale,
        messages.common.unknown,
      ).label;
    }
    return hoveredCountryName.trim() || messages.common.unknown;
  }, [hoveredCountryCode, hoveredCountryName, locale, messages.common.unknown]);
  const hoveredCountryCounts =
    hoveredCountryCode ? countryCountMap.get(hoveredCountryCode) : null;
  const hoveredViewsText = numberFormat(
    locale,
    hoveredCountryCounts?.views ?? 0,
  );
  const hoveredVisitorsText = numberFormat(
    locale,
    hoveredCountryCounts?.visitors ?? 0,
  );
  const hoveredSessionsText = numberFormat(
    locale,
    hoveredCountryCounts?.sessions ?? 0,
  );
  const showCountryToolbar = Boolean(hoveredCountryKey) && !activeLocation;

  const statsEntries = useMemo<GeoStatsEntry[]>(() => {
    const fallbackRows: GeoDimensionCount[] =
      activeLocation?.level === "country"
        ? geoPointsData.regionCounts
        : geoPointsData.cityCounts;
    const fallbackMap = new globalThis.Map(
      fallbackRows.map((row) => [String(row.value ?? "").trim(), row] as const),
    );
    const sourceMap = new globalThis.Map<string, GeoStatsEntry>();

    for (const row of geoPointsData.countryCounts) {
      const country = normalizeCountryCode(row.country);
      if (!country) continue;
      sourceMap.set(country, {
        key: country,
        label: resolveCountryLabel(
          country,
          locale,
          messages.common.unknown,
        ).label,
        views: Number(row.views ?? 0),
        sessions: Number(row.sessions ?? 0),
        visitors: Number(row.visitors ?? 0),
      });
    }

    const dimensionSourceRows = geoTabRows.length > 0 ? geoTabRows : fallbackRows;
    for (const row of dimensionSourceRows) {
      const key = String(row.value ?? "").trim();
      if (!key) continue;
      const fallback = fallbackMap.get(key);
      sourceMap.set(key, {
        key,
        label:
          String(row.label ?? "").trim() ||
          messages.common.unknown,
        views: Number(row.views ?? 0) || Number(fallback?.views ?? 0),
        sessions: Number(row.sessions ?? 0) || Number(fallback?.sessions ?? 0),
        visitors:
          Number((row as { visitors?: unknown }).visitors ?? 0) ||
          Number(fallback?.visitors ?? 0),
      });
    }

    if (geoDirectoryEntries && geoDirectoryEntries.length > 0) {
      return geoDirectoryEntries.map((entry) => {
        const source = sourceMap.get(entry.key);
        const fallback = fallbackMap.get(entry.key);
        return {
          key: entry.key,
          label: entry.label || source?.label || messages.common.unknown,
          views: Number(source?.views ?? fallback?.views ?? 0),
          sessions: Number(source?.sessions ?? fallback?.sessions ?? 0),
          visitors: Number(source?.visitors ?? fallback?.visitors ?? 0),
        };
      });
    }

    if (!activeLocation) {
      return [...sourceMap.values()].filter(
        (row) => row.key.length > 0 && row.label.length > 0,
      );
    }

    return dimensionSourceRows
      .map((row) => sourceMap.get(String(row.value ?? "").trim()) ?? null)
      .filter((row): row is GeoStatsEntry => Boolean(row))
      .filter((row) => row.key.length > 0 && row.label.length > 0);
  }, [
    geoDirectoryEntries,
    geoPointsData.cityCounts,
    geoPointsData.countryCounts,
    geoPointsData.regionCounts,
    geoTabRows,
    locale,
    activeLocation,
    messages.common.unknown,
  ]);

  const selectedEntryKey =
    activeLocation?.level === "locality" ? activeLocation.canonical : null;
  const currentLocationInfo = useMemo(() => {
    if (!activeLocation) return null;

    const lines = [
      locationFocus?.country?.label ||
        resolveCountryLabel(
          activeLocation.countryCode,
          locale,
          messages.common.unknown,
        ).label,
      activeLocation.level !== "country"
        ? locationFocus?.region?.label ||
          activeLocation.regionName ||
          activeLocation.regionCode ||
          messages.common.unknown
        : null,
      activeLocation.level === "locality"
        ? locationFocus?.locality?.label ||
          activeLocation.localityName ||
          messages.common.unknown
        : null,
    ].filter((value, index, array): value is string => {
      const normalized = String(value ?? "").trim();
      if (!normalized) return false;
      return array.findIndex((item) => String(item ?? "").trim() === normalized) === index;
    });

    return {
      lines,
    };
  }, [
    locale,
    activeLocation,
    locationFocus?.country?.label,
    locationFocus?.locality?.label,
    locationFocus?.region?.label,
    messages.common.unknown,
  ]);
  const statsColumnLabel = activeLocation
    ? activeLocation.level === "country"
      ? locale === "zh"
        ? "州/省"
        : messages.common.region
      : locale === "zh"
        ? "市/县"
        : messages.common.city
    : locale === "zh"
      ? "国家/地区"
      : messages.common.country;

  const updateLocation = (nextLocation: string | null) => {
    if (typeof globalThis.window === "undefined") return;
    const nextParams = new URLSearchParams(searchParams.toString());
    if (nextLocation) {
      nextParams.set("location", nextLocation);
    } else {
      nextParams.delete("location");
    }
    const query = nextParams.toString();
    const nextTarget = `${globalThis.window.location.pathname}${query ? `?${query}` : ""}${globalThis.window.location.hash}`;
    pushUrlWithoutNavigation(nextTarget);
  };

  const handleBack = activeLocation
    ? () => updateLocation(parentGeoLocationValue(activeLocation))
    : undefined;
  const handleSelectEntry =
    statsEntries.length > 0 ? (key: string) => updateLocation(key) : undefined;

  const shouldRenderMap = mounted;

  return (
    <div
      className="relative h-full min-h-0 overflow-hidden"
      style={MAP_VIEWPORT_RENDER_ISOLATION_STYLE}
    >
      {shouldRenderMap ? (
        <Map
          ref={mapRef}
          initialViewState={initialViewState}
          mapStyle={mapStyle}
          attributionControl={false}
          scrollZoom
          maxPitch={0}
          dragRotate={false}
          pitchWithRotate={false}
          onMove={(event) => {
            const nextZoom = normalizeClusterZoom(event.viewState.zoom);
            setCurrentZoom((previous) =>
              Math.abs(previous - nextZoom) > 0.0001 ? nextZoom : previous,
            );
          }}
        >
          <DeckOverlay interleaved={false} layers={layers} />
        </Map>
      ) : (
        <div className="absolute inset-0 bg-muted/20" />
      )}

      <div className="pointer-events-none absolute inset-x-0 top-0 h-40 bg-gradient-to-b from-background via-background/60 to-transparent" />

      <div className="pointer-events-none absolute left-4 top-4 z-10 max-w-[min(26rem,calc(100%-2rem))] sm:max-w-[calc(100%-25.5rem)] md:left-6 md:top-6">
        <div className="space-y-1">
          <h1 className="text-2xl font-semibold tracking-tight text-foreground">
            {messages.geo.title}
          </h1>
          <p className="text-sm text-foreground/75">{messages.geo.subtitle}</p>
        </div>
      </div>

      <GeoCountryStatsPanel
        locale={locale}
        messages={messages}
        loading={loading}
        columnLabel={statsColumnLabel}
        currentLocationInfo={currentLocationInfo}
        entries={statsEntries}
        selectedEntryKey={selectedEntryKey}
        onSelectEntry={handleSelectEntry}
        onBack={handleBack}
      />

      <AnimatePresence>
        {showCountryToolbar ? (
          <motion.div
            key="geo-country-toolbar"
            className="pointer-events-none absolute inset-x-0 bottom-3 z-10 flex justify-center px-3 sm:pr-[25rem]"
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 12 }}
            transition={{ duration: 0.2, ease: "easeOut" }}
          >
            <div className="inline-flex items-center gap-4 rounded-md border border-border/70 bg-background/92 px-3 py-2 text-xs shadow-lg backdrop-blur-sm">
              <AutoResizer
                initial
                animateWidth
                animateHeight={false}
                className="inline-flex shrink-0 items-center"
              >
                <AutoTransition
                  className="inline-block"
                  duration={0.2}
                  type="fade"
                  initial={false}
                  presenceMode="wait"
                  customVariants={{
                    initial: { opacity: 0 },
                    animate: { opacity: 1 },
                    exit: { opacity: 0 },
                  }}
                >
                  <span
                    key={`country-${hoveredCountryCode ?? "unknown"}-${hoveredCountryLabel}`}
                    className="whitespace-nowrap font-medium"
                  >
                    {hoveredCountryLabel}
                  </span>
                </AutoTransition>
              </AutoResizer>
              <span className="inline-flex shrink-0 items-center gap-1 text-muted-foreground">
                <span>{messages.common.views}:</span>
                <AutoResizer
                  initial
                  animateWidth
                  animateHeight={false}
                  className="inline-flex shrink-0 items-center"
                >
                  <AutoTransition
                    className="inline-block"
                    duration={0.2}
                    type="fade"
                    initial={false}
                    presenceMode="wait"
                    customVariants={{
                      initial: { opacity: 0 },
                      animate: { opacity: 1 },
                      exit: { opacity: 0 },
                    }}
                  >
                    <span key={`views-${hoveredViewsText}`}>{hoveredViewsText}</span>
                  </AutoTransition>
                </AutoResizer>
              </span>
              <span className="inline-flex shrink-0 items-center gap-1 text-muted-foreground">
                <span>{messages.common.visitors}:</span>
                <AutoResizer
                  initial
                  animateWidth
                  animateHeight={false}
                  className="inline-flex shrink-0 items-center"
                >
                  <AutoTransition
                    className="inline-block"
                    duration={0.2}
                    type="fade"
                    initial={false}
                    presenceMode="wait"
                    customVariants={{
                      initial: { opacity: 0 },
                      animate: { opacity: 1 },
                      exit: { opacity: 0 },
                    }}
                  >
                    <span key={`visitors-${hoveredVisitorsText}`}>
                      {hoveredVisitorsText}
                    </span>
                  </AutoTransition>
                </AutoResizer>
              </span>
              <span className="inline-flex shrink-0 items-center gap-1 text-muted-foreground">
                <span>{messages.common.sessions}:</span>
                <AutoResizer
                  initial
                  animateWidth
                  animateHeight={false}
                  className="inline-flex shrink-0 items-center"
                >
                  <AutoTransition
                    className="inline-block"
                    duration={0.2}
                    type="fade"
                    initial={false}
                    presenceMode="wait"
                    customVariants={{
                      initial: { opacity: 0 },
                      animate: { opacity: 1 },
                      exit: { opacity: 0 },
                    }}
                  >
                    <span key={`sessions-${hoveredSessionsText}`}>
                      {hoveredSessionsText}
                    </span>
                  </AutoTransition>
                </AutoResizer>
              </span>
            </div>
          </motion.div>
        ) : null}
      </AnimatePresence>

    </div>
  );
}
