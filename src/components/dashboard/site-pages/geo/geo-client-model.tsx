import { type ReactNode } from "react";

import {
  buildLocalityLocationValue,
  buildRegionLocationValue,
  type GeoLocationLevel,
  normalizeGeoNameToken,
  type ParsedGeoLocation,
} from "@/lib/analytics/geo-location";
import { type OverviewGeoTabRows } from "@/lib/dashboard/client/data/index";
import { intlLocale, numberFormat } from "@/lib/dashboard/format";
import {
  fetchGeoCountryCodes,
  fetchGeoCountryTranslationPayload,
  fetchGeoStateTranslationPayload,
  GEO_TRANSLATION_DATA_LOCALE,
  type GeoCountryTranslationPayload,
  type GeoStateTranslationPayload,
  type GeoTranslationCityRecord,
  type GeoTranslationCountryRecord,
  matchesGeoLabelRecord,
  pickLocaleGeoLabel,
  resolveGeoStateTranslation,
  resolveGeoTranslationApiLocale,
} from "@/lib/dashboard/geo-translation";
import type { OverviewGeoPointsData } from "@/lib/dashboard-api/client/edge";
import { resolveCountryLabel } from "@/lib/i18n/code-labels";
import type { Locale } from "@/lib/i18n/config";
import type { AppMessages } from "@/lib/i18n/messages";
import { formatI18nTemplate } from "@/lib/i18n/template";
export interface GeoPoint {
  latitude: number;
  longitude: number;
  country: string;
  region?: string;
  regionCode?: string;
  city?: string;
  pointCount?: number;
}
export interface GeoDimensionCount {
  value: string;
  label: string;
  views: number;
  sessions: number;
  visitors: number;
}
export interface GeoStatsEntry {
  key: string;
  label: string;
  views: number;
  sessions: number;
  visitors: number;
  reference?: OverviewGeoTabRows[number]["reference"];
  change?: OverviewGeoTabRows[number]["change"];
}
export interface GeoDirectoryEntry {
  key: string;
  label: string;
}
export interface GeoInvestigationRow {
  label: string;
  value: ReactNode;
  fullWidth?: boolean;
}
export interface GeoInvestigationInfo {
  headline: string;
  context?: string | null;
  population?: number | null;
  wikidataId?: string | null;
  rows: GeoInvestigationRow[];
}
export interface GeoWikiSummary {
  title: string;
  description: string | null;
  extract: string | null;
  pageUrl: string | null;
}
export interface GeoLocationFocusResponse {
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
export type GeoMessages = AppMessages["geo"];
export type GeoInvestigationMessages = GeoMessages["investigation"];
export type LocaleCountryRecord = GeoTranslationCountryRecord;
export type LocaleCityRecord = GeoTranslationCityRecord;
export type LocaleCountryPayload = GeoCountryTranslationPayload;
export type LocaleStatePayload = GeoStateTranslationPayload;
export interface GeoMapViewState {
  longitude: number;
  latitude: number;
  zoom: number;
  minZoom?: number;
  maxZoom?: number;
  pitch?: number;
  bearing?: number;
}
export const DEFAULT_VIEW_STATE: GeoMapViewState = {
  longitude: 0,
  latitude: 20,
  zoom: 1,
  minZoom: 0.3,
  maxZoom: 19,
  pitch: 0,
  bearing: 0,
};
export const MAP_VIEWPORT_RENDER_ISOLATION_STYLE = {
  contain: "layout paint",
  transform: "translateZ(0)",
  willChange: "transform",
} as const;
export const DAY_IN_MS = 24 * 60 * 60 * 1000;
export const WORLD_GDP_PER_CAPITA_USD_2024 = 13_631.2;
export const geoWikiSummaryCache = new globalThis.Map<
  string,
  Promise<GeoWikiSummary | null>
>();
export function emptyOverviewGeoPoints(): OverviewGeoPointsData {
  return {
    ok: true,
    data: [],
    countryCounts: [],
    regionCounts: [],
    cityCounts: [],
  };
}
export function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}
export function computeInitialViewState(points: GeoPoint[]): GeoMapViewState {
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
    latitude: Number.isFinite(centerLat)
      ? centerLat
      : DEFAULT_VIEW_STATE.latitude,
    longitude: Number.isFinite(centerLon)
      ? centerLon
      : DEFAULT_VIEW_STATE.longitude,
    zoom: Number.isFinite(zoom) ? zoom : DEFAULT_VIEW_STATE.zoom,
  };
}
export function focusZoomForLevel(
  level: GeoLocationLevel,
  childCount = 0,
): number {
  if (level === "country") {
    if (childCount <= 8) return 4.6;
    if (childCount <= 20) return 4.05;
    if (childCount <= 40) return 3.45;
    return 2.95;
  }
  if (level === "region") {
    if (childCount <= 12) return 7.55;
    if (childCount <= 40) return 6.85;
    if (childCount <= 120) return 6.1;
    return 5.45;
  }
  return 9.7;
}
export function focusZoomRangeForLevel(level: GeoLocationLevel): {
  min: number;
  max: number;
} {
  if (level === "country") {
    return { min: 2.45, max: 5.15 };
  }
  if (level === "region") {
    return { min: 4.8, max: 8.25 };
  }
  return { min: 8.3, max: 11.4 };
}
export function resolveAdaptiveFocusZoom(
  points: GeoPoint[],
  level: GeoLocationLevel,
  childCount: number,
): number {
  const pointViewState = computeInitialViewState(points);
  const fallbackZoom = focusZoomForLevel(level, childCount);
  const { min, max } = focusZoomRangeForLevel(level);
  const pointZoom = clamp(
    Number(pointViewState.zoom ?? fallbackZoom),
    min,
    max,
  );

  if (points.length === 0) return fallbackZoom;
  if (points.length === 1) {
    return clamp(fallbackZoom * 0.82 + pointZoom * 0.18, min, max);
  }

  const weight = clamp(Math.log2(points.length + 1) / 3.6, 0.22, 1);
  return clamp(fallbackZoom * (1 - weight) + pointZoom * weight, min, max);
}
export function resolveFocusedViewState(
  points: GeoPoint[],
  location: ParsedGeoLocation | null,
  focus: GeoLocationFocusResponse | null,
  childCount = 0,
): GeoMapViewState {
  const pointViewState = computeInitialViewState(points);
  if (!location) return pointViewState;

  const adaptiveZoom = resolveAdaptiveFocusZoom(
    points,
    location.level,
    childCount,
  );

  if (focus?.center) {
    return {
      ...DEFAULT_VIEW_STATE,
      latitude: focus.center.latitude,
      longitude: focus.center.longitude,
      zoom: adaptiveZoom,
    };
  }

  const latitude = pointViewState.latitude ?? DEFAULT_VIEW_STATE.latitude;
  const longitude = pointViewState.longitude ?? DEFAULT_VIEW_STATE.longitude;

  return {
    ...DEFAULT_VIEW_STATE,
    latitude,
    longitude,
    zoom: adaptiveZoom,
  };
}
export function resolveGeoPoints(
  data: OverviewGeoPointsData,
  location: ParsedGeoLocation | null,
): GeoPoint[] {
  return data.data
    .map((item) => ({
      latitude: Number(item.latitude),
      longitude: Number(item.longitude),
      country: String(item.country ?? "")
        .trim()
        .toUpperCase(),
      region: String((item as { region?: unknown }).region ?? "").trim(),
      regionCode: String((item as { regionCode?: unknown }).regionCode ?? "")
        .trim()
        .toUpperCase(),
      city: String((item as { city?: unknown }).city ?? "").trim(),
      pointCount: Math.max(
        1,
        Number((item as { pointCount?: unknown }).pointCount ?? 1),
      ),
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
export function normalizeCountryCode(
  value: string | null | undefined,
): string | null {
  const normalized = String(value ?? "")
    .trim()
    .toUpperCase();
  if (!/^[A-Z]{2}$/.test(normalized)) return null;
  return normalized;
}
export function parseCoordinate(
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
export function parseGeoMetricNumber(
  value: string | number | null | undefined,
): number | null {
  const numeric =
    typeof value === "number" ? value : Number(String(value ?? "").trim());
  return Number.isFinite(numeric) && numeric > 0 ? numeric : null;
}
export function formatGeoDetailValue(
  value: string | number | null | undefined,
  locale: Locale,
  labels: GeoInvestigationMessages,
): string {
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return labels.unavailable;
    return numberFormat(locale, value);
  }
  const normalized = String(value ?? "").trim();
  return normalized || labels.unavailable;
}
export function formatGeoPopulation(
  locale: Locale,
  value: string | number | null | undefined,
  labels: GeoInvestigationMessages,
): string {
  const numeric = parseGeoMetricNumber(value);
  if (numeric === null) return labels.unavailable;
  return numberFormat(locale, numeric);
}
export function formatGeoGdp(
  locale: Locale,
  value: string | number | null | undefined,
  labels: GeoInvestigationMessages,
): string {
  const numeric = parseGeoMetricNumber(value);
  if (numeric === null) return labels.unavailable;
  return formatI18nTemplate(labels.gdpValue, {
    value: numberFormat(locale, numeric),
  });
}
export function formatGeoGdpPerCapita(
  locale: Locale,
  gdpMillionUsd: string | number | null | undefined,
  population: string | number | null | undefined,
  labels: GeoInvestigationMessages,
): string {
  const gdp = parseGeoMetricNumber(gdpMillionUsd);
  const residents = parseGeoMetricNumber(population);
  if (gdp === null || residents === null) return labels.unavailable;
  const value = (gdp * 1_000_000) / residents;
  const formatted = numberFormat(locale, Math.round(value));
  const ratio = value / WORLD_GDP_PER_CAPITA_USD_2024;
  if (!Number.isFinite(ratio) || ratio <= 0) {
    return formatI18nTemplate(labels.gdpPerCapitaValue, { value: formatted });
  }

  const deltaPercent =
    ((value - WORLD_GDP_PER_CAPITA_USD_2024) / WORLD_GDP_PER_CAPITA_USD_2024) *
    100;
  if (Math.abs(deltaPercent) < 0.5) {
    return formatI18nTemplate(labels.gdpPerCapitaNearAverage, {
      value: formatted,
    });
  }

  const percentText = numberFormat(locale, Math.round(Math.abs(deltaPercent)));
  return formatI18nTemplate(
    deltaPercent > 0
      ? labels.gdpPerCapitaAboveAverage
      : labels.gdpPerCapitaBelowAverage,
    { value: formatted, percent: percentText },
  );
}
export function resolveWindowDayCount(from: number, to: number): number {
  if (!Number.isFinite(from) || !Number.isFinite(to) || to <= from) {
    return 1;
  }
  return Math.max(1, Math.ceil((to - from) / DAY_IN_MS));
}
export function formatGeoMarketPenetration(
  locale: Locale,
  visitors: number,
  population: number | null | undefined,
  labels: GeoInvestigationMessages,
): ReactNode {
  if (!Number.isFinite(population) || !population || population <= 0)
    return labels.unavailable;

  const perMille = (Math.max(0, visitors) / population) * 1000;
  const formatted = new Intl.NumberFormat(intlLocale(locale), {
    minimumFractionDigits: perMille > 0 && perMille < 1 ? 2 : 0,
    maximumFractionDigits: 2,
  }).format(perMille);

  return (
    <span>
      {formatted}
      <span className="text-[0.72em] align-[0.08em]">‰</span>
    </span>
  );
}
export function buildGeoMarketPenetrationLabel(
  labels: GeoInvestigationMessages,
  dayCount: number,
): string {
  return formatI18nTemplate(labels.marketPenetrationWindow, {
    label: labels.marketPenetration,
    days: dayCount,
  });
}
export function formatGeoCoordinates(
  latitude: string | number | null | undefined,
  longitude: string | number | null | undefined,
  labels: GeoInvestigationMessages,
): string {
  const lat = parseCoordinate(latitude);
  const lon = parseCoordinate(longitude);
  if (lat === null || lon === null) return labels.unavailable;
  return `${lat.toFixed(4)}, ${lon.toFixed(4)}`;
}
export function formatGeoCurrency(
  country: LocaleCountryRecord,
  labels: GeoInvestigationMessages,
): string {
  const code = String(country.currency ?? "").trim();
  const symbol = String(country.currency_symbol ?? "").trim();
  const name = String(country.currency_name ?? "").trim();
  if (symbol && code) return `${symbol} ${code}`;
  if (code) return code;
  if (name) return name;
  return labels.unavailable;
}
export function formatGeoPhoneCode(
  country: LocaleCountryRecord,
  labels: GeoInvestigationMessages,
): string {
  const code = String(country.phonecode ?? "").trim();
  if (!code) return labels.unavailable;
  return code.startsWith("+") ? code : `+${code}`;
}
export function formatGeoRegion(
  country: LocaleCountryRecord,
  labels: GeoInvestigationMessages,
): string {
  const region = String(country.region ?? "").trim();
  const subregion = String(country.subregion ?? "").trim();
  if (region && subregion && region !== subregion)
    return `${region} / ${subregion}`;
  if (region) return region;
  if (subregion) return subregion;
  return labels.unavailable;
}
export function formatGeoType(
  value: string | null | undefined,
  labels: GeoInvestigationMessages,
): string {
  const normalized = String(value ?? "")
    .trim()
    .toLowerCase();
  if (!normalized) return labels.unavailable;

  const fromTable = labels.typeLabels[normalized];
  if (fromTable) return fromTable;

  const fallback = normalized
    .split(/[\s_-]+/)
    .filter((token) => token.length > 0)
    .map((token) => token.charAt(0).toUpperCase() + token.slice(1))
    .join(" ");

  return fallback || labels.unavailable;
}
export function formatGeoTimezoneSummary(
  value:
    | string
    | null
    | undefined
    | Array<{
        zoneName?: string;
        gmtOffsetName?: string;
        abbreviation?: string;
      }>,
  labels: GeoInvestigationMessages,
): string {
  if (typeof value === "string") {
    return value.trim() || labels.unavailable;
  }
  if (!Array.isArray(value) || value.length === 0) {
    return labels.unavailable;
  }
  return formatI18nTemplate(labels.timezoneCount, { count: value.length });
}
export function buildGeoInvestigationRow(
  label: string,
  value: ReactNode,
  fullWidth = false,
): GeoInvestigationRow {
  return { label, value, fullWidth };
}
export function buildCountryGeoInvestigation(
  payload: LocaleCountryPayload | null,
  locale: Locale,
  geoMessages: GeoMessages,
): GeoInvestigationInfo | null {
  const country = payload?.country;
  if (!country) return null;
  const labels = geoMessages.investigation;
  const population = parseGeoMetricNumber(country.population);
  const headline =
    pickLocaleGeoLabel(locale, country) ||
    resolveCountryLabel(
      String(country.code ?? "").trim(),
      locale,
      labels.unavailable,
    ).label;

  return {
    headline,
    context: null,
    population,
    wikidataId: null,
    rows: [
      buildGeoInvestigationRow(
        labels.capital,
        formatGeoDetailValue(country.capital, locale, labels),
      ),
      buildGeoInvestigationRow(
        labels.currency,
        formatGeoCurrency(country, labels),
      ),
      buildGeoInvestigationRow(
        labels.population,
        formatGeoPopulation(locale, country.population, labels),
      ),
      buildGeoInvestigationRow(
        labels.gdp,
        formatGeoGdp(locale, country.gdp, labels),
      ),
      buildGeoInvestigationRow(
        labels.gdpPerCapita,
        formatGeoGdpPerCapita(locale, country.gdp, country.population, labels),
        true,
      ),
      buildGeoInvestigationRow(
        labels.phonecode,
        formatGeoPhoneCode(country, labels),
      ),
      buildGeoInvestigationRow(
        labels.region,
        formatGeoRegion(country, labels),
        true,
      ),
    ],
  };
}
export function buildStateGeoInvestigation(
  payload: LocaleStatePayload | null,
  locale: Locale,
  geoMessages: GeoMessages,
): GeoInvestigationInfo | null {
  const state = payload?.state;
  if (!state) return null;
  const labels = geoMessages.investigation;
  return {
    headline: pickLocaleGeoLabel(locale, state) || labels.unavailable,
    context: payload?.country
      ? pickLocaleGeoLabel(locale, payload.country)
      : null,
    population: parseGeoMetricNumber(state.population),
    wikidataId: String(state.wikiDataId ?? "").trim() || null,
    rows: [
      buildGeoInvestigationRow(labels.type, formatGeoType(state.type, labels)),
      buildGeoInvestigationRow(
        labels.population,
        formatGeoPopulation(locale, state.population, labels),
      ),
      buildGeoInvestigationRow(
        labels.timezone,
        formatGeoTimezoneSummary(state.timezone, labels),
        true,
      ),
      buildGeoInvestigationRow(
        labels.iso,
        formatGeoDetailValue(state.iso3166_2, locale, labels),
      ),
    ],
  };
}
export function buildLocalityGeoInvestigation(
  payload: LocaleStatePayload | null,
  location: ParsedGeoLocation,
  locale: Locale,
  geoMessages: GeoMessages,
): GeoInvestigationInfo | null {
  if (location.level !== "locality" || !location.localityName) return null;
  const locality =
    payload?.cities?.find((record) =>
      matchesLocalityRecord(record, location.localityName ?? ""),
    ) ?? null;
  if (!locality) return null;

  const labels = geoMessages.investigation;
  const contextParts = [
    payload?.country ? pickLocaleGeoLabel(locale, payload.country) : "",
    payload?.state ? pickLocaleGeoLabel(locale, payload.state) : "",
  ].filter((value) => value.length > 0);

  return {
    headline: pickLocaleGeoLabel(locale, locality) || labels.unavailable,
    context: contextParts.length > 0 ? contextParts.join(" / ") : null,
    population: parseGeoMetricNumber(locality.population),
    wikidataId: String(locality.wikiDataId ?? "").trim() || null,
    rows: [
      buildGeoInvestigationRow(
        labels.type,
        formatGeoType(locality.type, labels),
      ),
      buildGeoInvestigationRow(
        labels.population,
        formatGeoPopulation(locale, locality.population, labels),
      ),
      buildGeoInvestigationRow(
        labels.timezone,
        formatGeoTimezoneSummary(locality.timezone, labels),
        true,
      ),
      buildGeoInvestigationRow(
        labels.coordinates,
        formatGeoCoordinates(locality.latitude, locality.longitude, labels),
        true,
      ),
    ],
  };
}
export function resolveGeoDataLocale(locale: Locale): string {
  return resolveGeoTranslationApiLocale(locale) ?? GEO_TRANSLATION_DATA_LOCALE;
}
async function fetchLocaleCountryCodes(
  locale: Locale,
): Promise<string[] | null> {
  return fetchGeoCountryCodes(resolveGeoDataLocale(locale));
}
async function fetchLocaleCountryPayload(
  countryCode: string,
  locale: Locale,
): Promise<LocaleCountryPayload | null> {
  return fetchGeoCountryTranslationPayload(
    resolveGeoDataLocale(locale),
    countryCode,
  );
}
async function fetchLocaleStatePayload(
  countryCode: string,
  stateCode: string,
  locale: Locale,
): Promise<LocaleStatePayload | null> {
  return fetchGeoStateTranslationPayload(
    resolveGeoDataLocale(locale),
    countryCode,
    stateCode,
  );
}
export async function fetchGeoWikiSummary(
  wikidataId: string,
  locale: Locale,
): Promise<GeoWikiSummary | null> {
  const normalizedId = String(wikidataId ?? "")
    .trim()
    .toUpperCase();
  if (!/^Q\d+$/.test(normalizedId)) return null;

  const cacheKey = `${locale}:${normalizedId}`;
  const cached = geoWikiSummaryCache.get(cacheKey);
  if (cached) return cached;

  const request = fetch(
    `/api/public/resources/wiki-summary?wikidataId=${encodeURIComponent(normalizedId)}&locale=${encodeURIComponent(locale)}`,
    {
      method: "GET",
      cache: "force-cache",
    },
  )
    .then(async (response) => {
      if (!response.ok) return null;
      const payload = (await response.json()) as {
        ok?: boolean;
        wikipedia?: {
          title?: string;
          description?: string | null;
          extract?: string | null;
          pageUrl?: string | null;
        } | null;
      };
      if (!payload?.ok || !payload.wikipedia) return null;

      const title = String(payload.wikipedia.title ?? "").trim();
      const description = String(payload.wikipedia.description ?? "").trim();
      const extract = String(payload.wikipedia.extract ?? "").trim();
      const pageUrl = String(payload.wikipedia.pageUrl ?? "").trim();

      return {
        title,
        description: description || null,
        extract: extract || null,
        pageUrl: pageUrl || null,
      } satisfies GeoWikiSummary;
    })
    .catch(() => null);

  geoWikiSummaryCache.set(cacheKey, request);
  return request;
}
export function dedupeGeoDirectoryEntries(
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
export function resolveCountryLocationFocus(
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
      code: String(payload.country.code ?? "")
        .trim()
        .toUpperCase(),
      label: pickLocaleGeoLabel(locale, payload.country),
    },
    region: null,
    locality: null,
  };
}
export function resolveStateLocationFocus(
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
            code: String(payload.country.code ?? "")
              .trim()
              .toUpperCase(),
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
          code: String(payload.country.code ?? "")
            .trim()
            .toUpperCase(),
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
export async function fetchGeoLocaleBundle(
  location: ParsedGeoLocation | null,
  locale: Locale,
  unknownLabel: string,
  geoMessages: GeoMessages,
): Promise<{
  focus: GeoLocationFocusResponse | null;
  directoryEntries: GeoDirectoryEntry[];
  investigation: GeoInvestigationInfo | null;
}> {
  const apiLocale = resolveGeoDataLocale(locale);

  if (!location) {
    const countryCodes = await fetchLocaleCountryCodes(locale);
    return {
      focus: null,
      directoryEntries: dedupeGeoDirectoryEntries(
        (countryCodes ?? []).map((countryCode) => ({
          key: countryCode,
          label: resolveCountryLabel(countryCode, locale, unknownLabel).label,
        })),
      ),
      investigation: null,
    };
  }

  if (location.level === "country") {
    const countryPayload = await fetchLocaleCountryPayload(
      location.countryCode,
      locale,
    );
    const stateCodes = Array.isArray(countryPayload?.states)
      ? countryPayload.states
          .map((value) =>
            String(value ?? "")
              .trim()
              .toUpperCase(),
          )
          .filter((value) => value.length > 0)
      : [];
    const statePayloads = await Promise.all(
      stateCodes.map((stateCode) =>
        fetchLocaleStatePayload(location.countryCode, stateCode, locale),
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
            label: pickLocaleGeoLabel(locale, stateRecord) || unknownLabel,
          };
        }),
      ),
      investigation: buildCountryGeoInvestigation(
        countryPayload,
        locale,
        geoMessages,
      ),
    };
  }

  const stateResolution = await resolveGeoStateTranslation(
    apiLocale,
    location.countryCode,
    location.regionCode ?? "",
    {
      countryLabel: resolveCountryLabel(
        location.countryCode,
        locale,
        unknownLabel,
      ).label,
      regionLabel: location.regionName ?? "",
      localityLabel: location.localityName ?? "",
    },
  );
  const statePayload =
    stateResolution?.statePayload ??
    (!stateResolution && location.regionCode
      ? await fetchLocaleStatePayload(
          location.countryCode,
          location.regionCode,
          locale,
        )
      : null);

  if (!statePayload) {
    return { focus: null, directoryEntries: [], investigation: null };
  }

  const stateRecord = statePayload?.state;
  const effectiveRegionCode =
    stateResolution?.stateCode ||
    String(stateRecord?.code ?? stateRecord?.iso2 ?? location.regionCode ?? "")
      .trim()
      .toUpperCase();
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
              String(
                city.name_default ?? city.name ?? city.native ?? "",
              ).trim() || unknownLabel;

            return {
              key: buildLocalityLocationValue(
                location.countryCode,
                effectiveRegionCode,
                canonicalRegionName,
                canonicalLocalityName,
              ),
              label: pickLocaleGeoLabel(locale, city) || unknownLabel,
            };
          })
        : [],
    ),
    investigation:
      location.level === "locality"
        ? buildLocalityGeoInvestigation(
            statePayload,
            location,
            locale,
            geoMessages,
          )
        : buildStateGeoInvestigation(statePayload, locale, geoMessages),
  };
}
export function matchesLocalityRecord(
  record: LocaleCityRecord,
  localityName: string,
): boolean {
  if (matchesGeoLabelRecord(record, localityName)) return true;

  const expected = normalizeGeoNameToken(localityName);
  if (!expected) return false;

  return [record.name, record.name_default, record.native]
    .map((value) => normalizeGeoNameToken(String(value ?? "")))
    .filter((value) => value.length > 0)
    .some((candidate) => {
      if (candidate === expected) return true;
      return candidate.includes(expected) || expected.includes(candidate);
    });
}
export function matchesRegionPoint(
  point: Pick<GeoPoint, "region" | "regionCode">,
  location: ParsedGeoLocation,
): boolean {
  const expectedTokens = new Set(
    [location.regionCode, location.regionName]
      .map((value) =>
        String(value ?? "")
          .trim()
          .toUpperCase(),
      )
      .filter((value) => value.length > 0),
  );
  if (expectedTokens.size === 0) return true;

  const actualTokens = new Set(
    [point.regionCode, point.region]
      .map((value) =>
        String(value ?? "")
          .trim()
          .toUpperCase(),
      )
      .filter((value) => value.length > 0),
  );
  if (actualTokens.size === 0) return false;

  for (const token of actualTokens) {
    if (expectedTokens.has(token)) return true;
  }
  return false;
}
export function matchesLocationPoint(
  point: GeoPoint,
  location: ParsedGeoLocation | null,
): boolean {
  if (!location) return true;

  const pointCountry = String(point.country ?? "")
    .trim()
    .toUpperCase();
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
