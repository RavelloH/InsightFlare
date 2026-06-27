"use client";

import {
  type ReactNode,
  startTransition,
  useEffect,
  useMemo,
  useState,
} from "react";
import dynamic from "next/dynamic";

import { GeoCountryStatsPanel } from "@/components/dashboard/geo-country-stats-panel";
import type { GeoClientMapStageProps } from "@/components/dashboard/site-pages/geo-client-map-stage";
import { useDashboardQuery } from "@/components/dashboard/site-pages/use-dashboard-query";
import { useIsMobile } from "@/hooks/use-mobile";
import {
  pushUrlWithoutNavigation,
  useLiveSearchParams,
} from "@/lib/client-history";
import {
  fetchOverviewGeoDimensionTab,
  fetchOverviewGeoPoints,
  type OverviewGeoTabRows,
} from "@/lib/dashboard/client-data";
import { intlLocale, numberFormat } from "@/lib/dashboard/format";
import {
  buildLocalityLocationValue,
  buildRegionLocationValue,
  type GeoLocationLevel,
  normalizeGeoNameToken,
  parentGeoLocationValue,
  type ParsedGeoLocation,
  parseGeoLocationValue,
} from "@/lib/dashboard/geo-location";
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
} from "@/lib/dashboard/geo-translation";
import type { DashboardFilters } from "@/lib/dashboard/query-state";
import type { OverviewGeoPointsData } from "@/lib/edge-client";
import { resolveCountryLabel } from "@/lib/i18n/code-labels";
import type { Locale } from "@/lib/i18n/config";
import type { AppMessages } from "@/lib/i18n/messages";
import { formatI18nTemplate } from "@/lib/i18n/template";

const GeoClientMapStage = dynamic<GeoClientMapStageProps>(
  () =>
    import("@/components/dashboard/site-pages/geo-client-map-stage").then(
      (module) => module.GeoClientMapStage,
    ),
  {
    ssr: false,
    loading: () => <div className="absolute inset-0 bg-muted/20" />,
  },
);

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
  pointCount?: number;
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

interface GeoInvestigationRow {
  label: string;
  value: ReactNode;
  fullWidth?: boolean;
}

interface GeoInvestigationInfo {
  headline: string;
  context?: string | null;
  population?: number | null;
  wikidataId?: string | null;
  rows: GeoInvestigationRow[];
}

interface GeoWikiSummary {
  title: string;
  description: string | null;
  extract: string | null;
  pageUrl: string | null;
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

type GeoMessages = AppMessages["geo"];
type GeoInvestigationMessages = GeoMessages["investigation"];

type LocaleCountryRecord = GeoTranslationCountryRecord;
type LocaleCityRecord = GeoTranslationCityRecord;
type LocaleCountryPayload = GeoCountryTranslationPayload;
type LocaleStatePayload = GeoStateTranslationPayload;

interface GeoMapViewState {
  longitude: number;
  latitude: number;
  zoom: number;
  minZoom?: number;
  maxZoom?: number;
  pitch?: number;
  bearing?: number;
}

const DEFAULT_VIEW_STATE: GeoMapViewState = {
  longitude: 0,
  latitude: 20,
  zoom: 1,
  minZoom: 0.3,
  maxZoom: 19,
  pitch: 0,
  bearing: 0,
};
const MAP_VIEWPORT_RENDER_ISOLATION_STYLE = {
  contain: "layout paint",
  transform: "translateZ(0)",
  willChange: "transform",
} as const;
const DAY_IN_MS = 24 * 60 * 60 * 1000;
// World Bank, World, GDP per capita (current US$), most recent value for 2024.
const WORLD_GDP_PER_CAPITA_USD_2024 = 13_631.2;
const geoWikiSummaryCache = new globalThis.Map<
  string,
  Promise<GeoWikiSummary | null>
>();

function emptyOverviewGeoPoints(): OverviewGeoPointsData {
  return {
    ok: true,
    data: [],
    countryCounts: [],
    regionCounts: [],
    cityCounts: [],
  };
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function computeInitialViewState(points: GeoPoint[]): GeoMapViewState {
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

function focusZoomForLevel(level: GeoLocationLevel, childCount = 0): number {
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

function focusZoomRangeForLevel(level: GeoLocationLevel): {
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

function resolveAdaptiveFocusZoom(
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

function resolveFocusedViewState(
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

function resolveGeoPoints(
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

function normalizeCountryCode(value: string | null | undefined): string | null {
  const normalized = String(value ?? "")
    .trim()
    .toUpperCase();
  if (!/^[A-Z]{2}$/.test(normalized)) return null;
  return normalized;
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

function parseGeoMetricNumber(
  value: string | number | null | undefined,
): number | null {
  const numeric =
    typeof value === "number" ? value : Number(String(value ?? "").trim());
  return Number.isFinite(numeric) && numeric > 0 ? numeric : null;
}

function formatGeoDetailValue(
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

function formatGeoPopulation(
  locale: Locale,
  value: string | number | null | undefined,
  labels: GeoInvestigationMessages,
): string {
  const numeric = parseGeoMetricNumber(value);
  if (numeric === null) return labels.unavailable;
  return numberFormat(locale, numeric);
}

function formatGeoGdp(
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

function formatGeoGdpPerCapita(
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

function resolveWindowDayCount(from: number, to: number): number {
  if (!Number.isFinite(from) || !Number.isFinite(to) || to <= from) {
    return 1;
  }
  return Math.max(1, Math.ceil((to - from) / DAY_IN_MS));
}

function formatGeoMarketPenetration(
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

function buildGeoMarketPenetrationLabel(
  labels: GeoInvestigationMessages,
  dayCount: number,
): string {
  return formatI18nTemplate(labels.marketPenetrationWindow, {
    label: labels.marketPenetration,
    days: dayCount,
  });
}

function formatGeoCoordinates(
  latitude: string | number | null | undefined,
  longitude: string | number | null | undefined,
  labels: GeoInvestigationMessages,
): string {
  const lat = parseCoordinate(latitude);
  const lon = parseCoordinate(longitude);
  if (lat === null || lon === null) return labels.unavailable;
  return `${lat.toFixed(4)}, ${lon.toFixed(4)}`;
}

function formatGeoCurrency(
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

function formatGeoPhoneCode(
  country: LocaleCountryRecord,
  labels: GeoInvestigationMessages,
): string {
  const code = String(country.phonecode ?? "").trim();
  if (!code) return labels.unavailable;
  return code.startsWith("+") ? code : `+${code}`;
}

function formatGeoRegion(
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

function formatGeoType(
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

function formatGeoTimezoneSummary(
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

function buildGeoInvestigationRow(
  label: string,
  value: ReactNode,
  fullWidth = false,
): GeoInvestigationRow {
  return { label, value, fullWidth };
}

function buildCountryGeoInvestigation(
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

function buildStateGeoInvestigation(
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

function buildLocalityGeoInvestigation(
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

async function fetchLocaleCountryCodes(): Promise<string[] | null> {
  return fetchGeoCountryCodes(GEO_TRANSLATION_DATA_LOCALE);
}

async function fetchLocaleCountryPayload(
  countryCode: string,
): Promise<LocaleCountryPayload | null> {
  return fetchGeoCountryTranslationPayload(
    GEO_TRANSLATION_DATA_LOCALE,
    countryCode,
  );
}

async function fetchLocaleStatePayload(
  countryCode: string,
  stateCode: string,
): Promise<LocaleStatePayload | null> {
  return fetchGeoStateTranslationPayload(
    GEO_TRANSLATION_DATA_LOCALE,
    countryCode,
    stateCode,
  );
}

async function fetchGeoWikiSummary(
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
    `/api/wiki-summary?wikidataId=${encodeURIComponent(normalizedId)}&locale=${encodeURIComponent(locale)}`,
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
      code: String(payload.country.code ?? "")
        .trim()
        .toUpperCase(),
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

async function fetchGeoLocaleBundle(
  location: ParsedGeoLocation | null,
  locale: Locale,
  unknownLabel: string,
  geoMessages: GeoMessages,
): Promise<{
  focus: GeoLocationFocusResponse | null;
  directoryEntries: GeoDirectoryEntry[];
  investigation: GeoInvestigationInfo | null;
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
      investigation: null,
    };
  }

  if (location.level === "country") {
    const countryPayload = await fetchLocaleCountryPayload(
      location.countryCode,
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
    GEO_TRANSLATION_DATA_LOCALE,
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
    (location.regionCode
      ? await fetchLocaleStatePayload(location.countryCode, location.regionCode)
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

function matchesLocalityRecord(
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

function matchesRegionPoint(
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

function matchesLocationPoint(
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

export function GeoClientPage({
  locale,
  messages,
  siteId,
}: GeoClientPageProps) {
  const isMobile = useIsMobile();
  const { window, filters } = useDashboardQuery();
  const searchParams = useLiveSearchParams();
  const geoMessages = messages.geo;
  const geoInvestigationMessages = geoMessages.investigation;
  const requestedLocation = useMemo(
    () => parseGeoLocationValue(searchParams.get("location")),
    [searchParams],
  );
  const requestFilters = useMemo<DashboardFilters>(
    () => ({
      ...filters,
      ...(requestedLocation?.canonical
        ? { geo: requestedLocation.canonical }
        : {}),
    }),
    [filters, requestedLocation?.canonical],
  );
  const requestFiltersKey = useMemo(
    () => dashboardFilterSignature(requestFilters),
    [requestFilters],
  );
  const [loading, setLoading] = useState(true);
  const [geoPointsData, setGeoPointsData] = useState<OverviewGeoPointsData>(
    emptyOverviewGeoPoints(),
  );
  const [geoTabRows, setGeoTabRows] = useState<OverviewGeoTabRows>([]);
  const [activeLocation, setActiveLocation] =
    useState<ParsedGeoLocation | null>(null);
  const [locationFocus, setLocationFocus] =
    useState<GeoLocationFocusResponse | null>(null);
  const [geoInvestigation, setGeoInvestigation] =
    useState<GeoInvestigationInfo | null>(null);
  const [geoWikiSummary, setGeoWikiSummary] = useState<GeoWikiSummary | null>(
    null,
  );
  const [geoDirectoryEntries, setGeoDirectoryEntries] = useState<
    GeoDirectoryEntry[] | null
  >(null);

  useEffect(() => {
    let active = true;
    const wikidataId = geoInvestigation?.wikidataId ?? null;

    if (!wikidataId || !activeLocation || activeLocation.level === "country") {
      setGeoWikiSummary(null);
      return () => {
        active = false;
      };
    }

    setGeoWikiSummary(null);

    fetchGeoWikiSummary(wikidataId, locale).then((summary) => {
      if (!active) return;
      setGeoWikiSummary(summary);
    });

    return () => {
      active = false;
    };
  }, [
    activeLocation?.canonical,
    activeLocation?.level,
    geoInvestigation?.wikidataId,
    locale,
  ]);

  useEffect(() => {
    let active = true;
    setLoading(true);

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
        ? fetchOverviewGeoDimensionTab(
            siteId,
            window,
            dimensionTab,
            requestFilters,
            {
              limit: dimensionTab === "city" ? 600 : 400,
            },
          )
        : Promise.resolve([] as OverviewGeoTabRows),
      fetchGeoLocaleBundle(
        requestedLocation,
        locale,
        messages.common.unknown,
        geoMessages,
      ),
    ])
      .then(([nextGeoPoints, nextGeoTabRows, nextGeoLocaleBundle]) => {
        if (!active) return;
        startTransition(() => {
          setGeoPointsData(nextGeoPoints);
          setGeoTabRows(nextGeoTabRows);
          setLocationFocus(nextGeoLocaleBundle.focus);
          setGeoInvestigation(nextGeoLocaleBundle.investigation);
          setGeoDirectoryEntries(nextGeoLocaleBundle.directoryEntries);
          setActiveLocation(requestedLocation);
          setLoading(false);
        });
      })
      .catch(() => {
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
    geoMessages,
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
    () =>
      resolveFocusedViewState(
        points,
        activeLocation,
        locationFocus,
        geoDirectoryEntries?.length ?? 0,
      ),
    [activeLocation, geoDirectoryEntries?.length, locationFocus, points],
  );

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
        label: resolveCountryLabel(country, locale, messages.common.unknown)
          .label,
        views: Number(row.views ?? 0),
        sessions: Number(row.sessions ?? 0),
        visitors: Number(row.visitors ?? 0),
      });
    }

    const dimensionSourceRows =
      geoTabRows.length > 0 ? geoTabRows : fallbackRows;
    for (const row of dimensionSourceRows) {
      const key = String(row.value ?? "").trim();
      if (!key) continue;
      const fallback = fallbackMap.get(key);
      sourceMap.set(key, {
        key,
        label: String(row.label ?? "").trim() || messages.common.unknown,
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
          label: entry.label || messages.common.unknown,
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
  const investigationRows = useMemo(() => {
    if (!geoInvestigation) return null;

    const derivedRows = [...geoInvestigation.rows];
    const marketPenetrationVisitors =
      activeLocation?.level === "locality"
        ? Math.max(
            0,
            Number(
              statsEntries.find(
                (entry) => entry.key === activeLocation.canonical,
              )?.visitors ?? 0,
            ),
          )
        : statsEntries.reduce(
            (sum, entry) => sum + Math.max(0, Number(entry.visitors ?? 0)),
            0,
          );

    derivedRows.push(
      buildGeoInvestigationRow(
        buildGeoMarketPenetrationLabel(
          geoInvestigationMessages,
          resolveWindowDayCount(window.from, window.to),
        ),
        formatGeoMarketPenetration(
          locale,
          marketPenetrationVisitors,
          geoInvestigation.population,
          geoInvestigationMessages,
        ),
        true,
      ),
    );

    return derivedRows;
  }, [
    geoInvestigation,
    locale,
    activeLocation?.canonical,
    activeLocation?.level,
    statsEntries,
    window.from,
    window.to,
    geoInvestigationMessages,
  ]);
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
        ? locationFocus?.region?.label || messages.common.unknown
        : null,
      activeLocation.level === "locality"
        ? locationFocus?.locality?.label || messages.common.unknown
        : null,
    ].filter((value, index, array): value is string => {
      const normalized = String(value ?? "").trim();
      if (!normalized) return false;
      return (
        array.findIndex((item) => String(item ?? "").trim() === normalized) ===
        index
      );
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
      ? geoMessages.regionLabel
      : geoMessages.cityLabel
    : geoMessages.countryLabel;

  function updateLocation(nextLocation: string | null) {
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
  }

  const handleBack = activeLocation
    ? () => updateLocation(parentGeoLocationValue(activeLocation))
    : undefined;
  const handleSelectEntry =
    statsEntries.length > 0 ? (key: string) => updateLocation(key) : undefined;

  const statsPanel = (
    <GeoCountryStatsPanel
      locale={locale}
      messages={messages}
      loading={loading}
      stacked={isMobile}
      columnLabel={statsColumnLabel}
      currentLocationInfo={currentLocationInfo}
      investigationRows={investigationRows}
      wikiSummary={geoWikiSummary}
      entries={statsEntries}
      selectedEntryKey={selectedEntryKey}
      onSelectEntry={handleSelectEntry}
      onBack={handleBack}
    />
  );
  const mapViewport = (
    <>
      <GeoClientMapStage
        locale={locale}
        isMobile={isMobile}
        points={points}
        countryCounts={geoPointsData.countryCounts}
        activeLocation={activeLocation}
        viewState={initialViewState}
        unknownLabel={messages.common.unknown}
        viewsLabel={messages.common.views}
        visitorsLabel={messages.common.visitors}
        sessionsLabel={messages.common.sessions}
        onSelectLocation={updateLocation}
      />

      <div className="pointer-events-none absolute inset-x-0 top-0 h-40 bg-gradient-to-b from-background via-background/60 to-transparent" />
      <div className="pointer-events-none absolute inset-x-0 bottom-0 h-28 bg-gradient-to-t from-background via-background/70 to-transparent sm:h-40" />

      <div className="pointer-events-none absolute left-4 top-4 z-10 max-w-[min(26rem,calc(100%-2rem))] sm:max-w-[calc(100%-25.5rem)] md:left-6 md:top-6">
        <div className="space-y-1">
          <h1 className="text-2xl font-semibold tracking-tight text-foreground">
            {messages.geo.title}
          </h1>
          <p className="text-sm text-foreground/75">{messages.geo.subtitle}</p>
        </div>
      </div>
    </>
  );

  if (isMobile) {
    return (
      <div className="space-y-6 pb-6">
        <div className="relative h-[min(68svh,calc(100svh-10.5rem))] min-h-[19rem] overflow-hidden">
          {mapViewport}
        </div>

        <div className="mx-auto w-full max-w-[1400px] px-4 md:px-6">
          {statsPanel}
        </div>
      </div>
    );
  }

  return (
    <div
      className="relative h-full min-h-0 overflow-hidden"
      style={MAP_VIEWPORT_RENDER_ISOLATION_STYLE}
    >
      {mapViewport}
      {statsPanel}
    </div>
  );
}
