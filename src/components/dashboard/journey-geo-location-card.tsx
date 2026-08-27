import { memo, type ReactNode, useEffect, useMemo, useState } from "react";
import {
  RiExternalLinkLine,
  RiInformationLine,
  RiMapPin2Line,
} from "@remixicon/react";
import { useQuery } from "@tanstack/react-query";

import { AutoResizer } from "@/components/ui/auto-resizer";
import { AutoTransition } from "@/components/ui/auto-transition";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Clickable } from "@/components/ui/clickable";
import { Skeleton } from "@/components/ui/skeleton";
import { numberFormat } from "@/lib/dashboard/format";
import {
  buildLocalityLocationValue,
  buildRegionLocationValue,
  normalizeGeoNameToken,
  type ParsedGeoLocation,
  parseGeoLocationValue,
} from "@/lib/dashboard/geo-location";
import {
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
import { resolveCountryLabel } from "@/lib/i18n/code-labels";
import type { Locale } from "@/lib/i18n/config";
import type { AppMessages } from "@/lib/i18n/messages";
import { formatI18nTemplate } from "@/lib/i18n/template";
import { cn } from "@/lib/utils";

export interface JourneyGeoLocationInput {
  country?: string | null;
  region?: string | null;
  regionCode?: string | null;
  city?: string | null;
  latitude?: number | null;
  longitude?: number | null;
}

interface JourneyGeoLocationCardProps {
  locale: Locale;
  messages: AppMessages;
  title: string;
  locations: JourneyGeoLocationInput[];
  loading?: boolean;
}

interface NormalizedJourneyGeoLocation {
  key: string;
  label: string;
  context: string | null;
  location: ParsedGeoLocation;
  latitude: number | null;
  longitude: number | null;
}

interface GeoInvestigationRow {
  label: string;
  value: ReactNode;
  fullWidth?: boolean;
}

interface GeoInvestigationInfo {
  headline: string;
  context: string | null;
  population: number | null;
  wikidataId?: string | null;
  rows: GeoInvestigationRow[];
}

interface GeoWikiSummary {
  title: string;
  description: string | null;
  extract: string | null;
  pageUrl: string | null;
}

type GeoMessages = AppMessages["geo"];
type GeoInvestigationMessages = GeoMessages["investigation"];
type LocaleCountryRecord = GeoTranslationCountryRecord;
type LocaleCityRecord = GeoTranslationCityRecord;
type LocaleCountryPayload = GeoCountryTranslationPayload;
type LocaleStatePayload = GeoStateTranslationPayload;

const GEO_COUNTRY_CODE_PATTERN = /^[A-Z]{2}$/;
// World Bank, World, GDP per capita (current US$), most recent value for 2024.
const WORLD_GDP_PER_CAPITA_USD_2024 = 13_631.2;
const geoWikiSummaryCache = new globalThis.Map<
  string,
  Promise<GeoWikiSummary | null>
>();

function cleanGeoSegment(value: string | null | undefined): string {
  return String(value ?? "").trim();
}

function normalizeGeoCountryCode(value: string | null | undefined): string {
  const normalized = cleanGeoSegment(value).toUpperCase();
  return GEO_COUNTRY_CODE_PATTERN.test(normalized) ? normalized : "";
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
  if (region && subregion && region !== subregion) {
    return `${region} / ${subregion}`;
  }
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

function countryScopedGeoLabel(messages: AppMessages, label: string): string {
  return formatI18nTemplate(messages.geo.investigation.countryScopedLabel, {
    label,
  });
}

function resolveCountryRecordLabel(
  country: LocaleCountryRecord,
  locale: Locale,
  fallback: string,
): string {
  return (
    pickLocaleGeoLabel(locale, country) ||
    resolveCountryLabel(String(country.code ?? "").trim(), locale, fallback)
      .label
  );
}

function buildCountryContextGeoRows(
  country: LocaleCountryRecord | null | undefined,
  locale: Locale,
  messages: AppMessages,
): GeoInvestigationRow[] {
  if (!country) return [];

  const geoMessages = messages.geo;
  const labels = geoMessages.investigation;
  const countryName = resolveCountryRecordLabel(
    country,
    locale,
    labels.unavailable,
  );

  return [
    buildGeoInvestigationRow(geoMessages.countryLabel, countryName),
    buildGeoInvestigationRow(
      countryScopedGeoLabel(messages, labels.capital),
      formatGeoDetailValue(country.capital, locale, labels),
    ),
    buildGeoInvestigationRow(
      countryScopedGeoLabel(messages, labels.currency),
      formatGeoCurrency(country, labels),
    ),
    buildGeoInvestigationRow(
      countryScopedGeoLabel(messages, labels.population),
      formatGeoPopulation(locale, country.population, labels),
    ),
    buildGeoInvestigationRow(
      countryScopedGeoLabel(messages, labels.gdp),
      formatGeoGdp(locale, country.gdp, labels),
    ),
    buildGeoInvestigationRow(
      countryScopedGeoLabel(messages, labels.gdpPerCapita),
      formatGeoGdpPerCapita(locale, country.gdp, country.population, labels),
    ),
    buildGeoInvestigationRow(
      countryScopedGeoLabel(messages, labels.region),
      formatGeoRegion(country, labels),
    ),
    buildGeoInvestigationRow(
      countryScopedGeoLabel(messages, labels.phonecode),
      formatGeoPhoneCode(country, labels),
    ),
  ];
}

function buildCountryGeoInvestigation(
  payload: LocaleCountryPayload | null,
  locale: Locale,
  messages: AppMessages,
): GeoInvestigationInfo | null {
  const country = payload?.country;
  if (!country) return null;
  const labels = messages.geo.investigation;
  const population = parseGeoMetricNumber(country.population);
  const headline = resolveCountryRecordLabel(
    country,
    locale,
    labels.unavailable,
  );

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
      ),
      buildGeoInvestigationRow(
        labels.phonecode,
        formatGeoPhoneCode(country, labels),
      ),
      buildGeoInvestigationRow(labels.region, formatGeoRegion(country, labels)),
    ],
  };
}

function buildStateGeoInvestigation(
  payload: LocaleStatePayload | null,
  locale: Locale,
  messages: AppMessages,
): GeoInvestigationInfo | null {
  const state = payload?.state;
  if (!state) return null;
  const labels = messages.geo.investigation;
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
      ),
      buildGeoInvestigationRow(
        labels.iso,
        formatGeoDetailValue(state.iso3166_2, locale, labels),
      ),
      buildGeoInvestigationRow(
        labels.coordinates,
        formatGeoCoordinates(state.latitude, state.longitude, labels),
      ),
      ...buildCountryContextGeoRows(payload?.country, locale, messages),
    ],
  };
}

function buildLocalityGeoInvestigation(
  payload: LocaleStatePayload | null,
  location: ParsedGeoLocation,
  locale: Locale,
  messages: AppMessages,
): GeoInvestigationInfo | null {
  if (location.level !== "locality" || !location.localityName) return null;
  const locality =
    payload?.cities?.find((record) =>
      matchesLocalityRecord(record, location.localityName ?? ""),
    ) ?? null;
  if (!locality) return null;

  const labels = messages.geo.investigation;
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
      ),
      buildGeoInvestigationRow(
        labels.coordinates,
        formatGeoCoordinates(locality.latitude, locality.longitude, labels),
      ),
      ...buildCountryContextGeoRows(payload?.country, locale, messages),
    ],
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

async function fetchJourneyGeoInvestigation(
  location: ParsedGeoLocation,
  locale: Locale,
  messages: AppMessages,
): Promise<GeoInvestigationInfo | null> {
  const unknownLabel = messages.common.unknown;

  if (location.level === "country") {
    const countryPayload = await fetchLocaleCountryPayload(
      location.countryCode,
    );
    return buildCountryGeoInvestigation(countryPayload, locale, messages);
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

  if (!statePayload) return null;

  return location.level === "locality"
    ? buildLocalityGeoInvestigation(statePayload, location, locale, messages)
    : buildStateGeoInvestigation(statePayload, locale, messages);
}

function buildJourneyGeoLocationValue(
  input: JourneyGeoLocationInput,
): string | null {
  const country = normalizeGeoCountryCode(input.country);
  if (!country) return null;

  const regionCode = cleanGeoSegment(input.regionCode);
  const regionName = cleanGeoSegment(input.region);
  const city = cleanGeoSegment(input.city);

  if (city) {
    return buildLocalityLocationValue(country, regionCode, regionName, city);
  }

  if (regionCode || regionName) {
    return buildRegionLocationValue(
      country,
      regionCode || regionName,
      regionName || regionCode,
    );
  }

  return country;
}

function uniqueLocationContext(parts: string[]): string | null {
  const seen = new Set<string>();
  const normalizedParts = parts
    .map((part) => part.trim())
    .filter((part) => {
      if (!part) return false;
      const key = normalizeGeoNameToken(part);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

  return normalizedParts.length > 0 ? normalizedParts.join(" / ") : null;
}

function buildJourneyGeoLocationLabel(
  input: JourneyGeoLocationInput,
  location: ParsedGeoLocation,
  locale: Locale,
  unknownLabel: string,
): { label: string; context: string | null } {
  const countryLabel = resolveCountryLabel(
    location.countryCode,
    locale,
    unknownLabel,
  ).label;
  const regionLabel =
    cleanGeoSegment(input.region) ||
    cleanGeoSegment(location.regionName) ||
    cleanGeoSegment(input.regionCode) ||
    cleanGeoSegment(location.regionCode);
  const localityLabel =
    cleanGeoSegment(input.city) || cleanGeoSegment(location.localityName);
  const label = localityLabel || regionLabel || countryLabel;
  const context =
    location.level === "country"
      ? null
      : uniqueLocationContext(
          location.level === "locality"
            ? [countryLabel, regionLabel]
            : [countryLabel],
        );

  return { label, context };
}

function normalizeJourneyGeoLocations(
  inputs: JourneyGeoLocationInput[],
  locale: Locale,
  messages: AppMessages,
): NormalizedJourneyGeoLocation[] {
  const byKey = new globalThis.Map<string, NormalizedJourneyGeoLocation>();
  for (const input of inputs) {
    const rawValue = buildJourneyGeoLocationValue(input);
    const location = parseGeoLocationValue(rawValue);
    if (!location) continue;

    const existing = byKey.get(location.canonical);
    if (existing) {
      existing.latitude ??= parseCoordinate(input.latitude);
      existing.longitude ??= parseCoordinate(input.longitude);
      continue;
    }

    const { label, context } = buildJourneyGeoLocationLabel(
      input,
      location,
      locale,
      messages.common.unknown,
    );

    byKey.set(location.canonical, {
      key: location.canonical,
      label,
      context,
      location,
      latitude: parseCoordinate(input.latitude),
      longitude: parseCoordinate(input.longitude),
    });
  }

  return [...byKey.values()];
}

function buildVisitorCoordinateRow(
  location: NormalizedJourneyGeoLocation,
  visitorCoordinatesLabel: string,
  labels: GeoInvestigationMessages,
): GeoInvestigationRow | null {
  if (location.latitude === null || location.longitude === null) return null;
  return buildGeoInvestigationRow(
    visitorCoordinatesLabel,
    formatGeoCoordinates(location.latitude, location.longitude, labels),
  );
}

function JourneyGeoSelector({
  entries,
  selectedKey,
  onSelect,
}: {
  entries: NormalizedJourneyGeoLocation[];
  selectedKey: string;
  onSelect: (key: string) => void;
}) {
  if (entries.length <= 1) return null;

  return (
    <div className="border-t border-border/70 px-4 py-3">
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-4">
        {entries.map((entry) => {
          const selected = entry.key === selectedKey;
          return (
            <Clickable
              key={entry.key}
              onClick={() => onSelect(entry.key)}
              enableHoverScale={false}
              tapScale={0.98}
              className={cn(
                "min-w-0 items-start justify-start border border-border/70 px-3 py-2 text-left transition-colors",
                "hover:bg-muted/70",
                selected && "border-foreground/20 bg-muted text-foreground",
              )}
            >
              <span className="min-w-0 space-y-0.5">
                <span className="block truncate text-sm leading-5 font-medium">
                  {entry.label}
                </span>
                {entry.context ? (
                  <span className="block truncate text-[11px] leading-4 text-muted-foreground">
                    {entry.context}
                  </span>
                ) : null}
              </span>
            </Clickable>
          );
        })}
      </div>
    </div>
  );
}

export const JourneyGeoLocationCard = memo(function JourneyGeoLocationCard({
  locale,
  messages,
  title,
  locations,
  loading = false,
}: JourneyGeoLocationCardProps) {
  const entries = useMemo(
    () => normalizeJourneyGeoLocations(locations, locale, messages),
    [locale, locations, messages],
  );
  const entriesKey = entries.map((entry) => entry.key).join("|");
  const firstEntryKey = entries[0]?.key ?? "";
  const [selectedKey, setSelectedKey] = useState(firstEntryKey);

  useEffect(() => {
    setSelectedKey((current) =>
      entries.some((entry) => entry.key === current) ? current : firstEntryKey,
    );
  }, [entries, entriesKey, firstEntryKey]);

  const selectedEntry =
    entries.find((entry) => entry.key === selectedKey) ?? entries[0] ?? null;
  const investigationQuery = useQuery({
    queryKey: [
      "dashboard",
      "journey-geo-investigation",
      locale,
      selectedEntry?.key ?? "",
    ],
    queryFn: async () => {
      if (!selectedEntry) return null;
      const investigation = await fetchJourneyGeoInvestigation(
        selectedEntry.location,
        locale,
        messages,
      );
      const wikiSummary = investigation?.wikidataId
        ? await fetchGeoWikiSummary(investigation.wikidataId, locale)
        : null;
      return { investigation, wikiSummary };
    },
    enabled: typeof window !== "undefined" && Boolean(selectedEntry),
    retry: false,
    staleTime: Infinity,
  });
  const investigationLoading = investigationQuery.isPending;
  const investigation = investigationQuery.data?.investigation ?? null;
  const wikiSummary = investigationQuery.data?.wikiSummary ?? null;

  if (!selectedEntry && !loading) return null;

  const headline = investigation?.headline || selectedEntry?.label || "";
  const context = investigation?.context ?? selectedEntry?.context;
  const baseRows =
    investigation?.rows && investigation.rows.length > 0
      ? investigation.rows
      : [];
  const visitorCoordinateRow = selectedEntry
    ? buildVisitorCoordinateRow(
        selectedEntry,
        messages.geo.visitorCoordinates,
        messages.geo.investigation,
      )
    : null;
  const rows = visitorCoordinateRow
    ? [...baseRows, visitorCoordinateRow]
    : baseRows;
  const transitionKey = [
    selectedEntry?.key ?? "initial-loading",
    investigationLoading ? "loading" : "ready",
    headline,
    context ?? "",
    wikiSummary?.title ?? "",
    wikiSummary?.extract ?? "",
  ].join("::");

  return (
    <Card aria-busy={loading || investigationLoading ? "true" : undefined}>
      <CardHeader>
        <CardTitle className="inline-flex items-center gap-2">
          <RiMapPin2Line className="size-4" />
          {title}
        </CardTitle>
      </CardHeader>
      <CardContent className="px-0 pb-0">
        <AutoResizer duration={0.24}>
          <AutoTransition
            initial={false}
            transitionKey={selectedEntry ? "ready" : "loading"}
            duration={0.18}
            type="fade"
            presenceMode="wait"
          >
            {selectedEntry ? (
              <div key="ready">
                <JourneyGeoSelector
                  entries={entries}
                  selectedKey={selectedEntry.key}
                  onSelect={setSelectedKey}
                />
                <AutoResizer initial>
                  <AutoTransition initial type="fade">
                    <div
                      key={transitionKey}
                      className="border-t border-border/70 px-4 py-3"
                    >
                      {investigationLoading ? (
                        <div className="space-y-3" aria-busy="true">
                          <Skeleton className="h-7 w-44" />
                          <Skeleton className="h-4 w-[min(30rem,82%)]" />
                          <div className="grid grid-cols-1 gap-x-5 gap-y-2.5 sm:grid-cols-2 lg:grid-cols-4">
                            {Array.from({ length: 4 }, (_, index) => (
                              <div
                                key={`geo-investigation-skeleton-${index}`}
                                className="space-y-1"
                              >
                                <Skeleton className="h-3 w-20" />
                                <Skeleton className="h-4 w-28" />
                              </div>
                            ))}
                          </div>
                        </div>
                      ) : (
                        <div className="space-y-3">
                          <div>
                            <div className="text-2xl leading-tight font-semibold tracking-tight text-foreground sm:text-[1.9rem]">
                              {headline}
                            </div>
                            {context ? (
                              <p className="mt-1 text-sm leading-6 text-muted-foreground">
                                {context}
                              </p>
                            ) : null}
                            {wikiSummary?.description ? (
                              <p className="mt-2 text-sm leading-6 text-muted-foreground">
                                {wikiSummary.description}
                              </p>
                            ) : null}
                          </div>

                          {rows.length > 0 ? (
                            <dl className="grid grid-cols-1 gap-x-5 gap-y-2.5 sm:grid-cols-2 lg:grid-cols-4">
                              {rows.map((row, index) => (
                                <div
                                  key={`${row.label}-${index}`}
                                  className={cn(
                                    "min-w-0",
                                    row.fullWidth &&
                                      "sm:col-span-2 lg:col-span-2",
                                  )}
                                >
                                  <dt className="text-[11px] leading-4 text-muted-foreground">
                                    {row.label}
                                  </dt>
                                  <dd className="mt-0.5 break-words text-sm leading-5 font-medium whitespace-pre-line text-foreground">
                                    {row.value}
                                  </dd>
                                </div>
                              ))}
                            </dl>
                          ) : null}

                          {wikiSummary?.extract ? (
                            <p className="text-sm leading-6 text-foreground/80">
                              {wikiSummary.extract}
                            </p>
                          ) : null}

                          {wikiSummary?.pageUrl ? (
                            <a
                              href={wikiSummary.pageUrl}
                              target="_blank"
                              rel="noreferrer"
                              className="inline-flex items-center gap-1.5 text-sm font-medium text-foreground transition-colors hover:text-primary"
                            >
                              {messages.geo.viewOnWikipedia}
                              <RiExternalLinkLine className="size-3.5 shrink-0" />
                            </a>
                          ) : null}

                          <div className="space-y-1.5 text-[11px] leading-4 text-muted-foreground">
                            <p>
                              <span className="mr-1.5 inline-flex h-4 align-top items-center">
                                <RiInformationLine className="size-3.5" />
                              </span>
                              {messages.geo.ipNotice}
                            </p>
                            {entries.length > 1 ? (
                              <p className="pl-5">
                                {messages.geo.multipleNotice}
                              </p>
                            ) : null}
                            <p className="pl-5">
                              {messages.geo.investigationNotice}
                            </p>
                          </div>
                        </div>
                      )}
                    </div>
                  </AutoTransition>
                </AutoResizer>
              </div>
            ) : (
              <div
                key="loading"
                className="space-y-3 border-t border-border/70 px-4 py-3"
                aria-busy="true"
              >
                <Skeleton className="h-7 w-44" />
                <Skeleton className="h-4 w-[min(30rem,82%)]" />
                <div className="grid grid-cols-1 gap-x-5 gap-y-2.5 sm:grid-cols-2 lg:grid-cols-4">
                  {Array.from({ length: 4 }, (_, index) => (
                    <div key={`geo-skeleton-${index}`} className="space-y-1">
                      <Skeleton className="h-3 w-20" />
                      <Skeleton className="h-4 w-28" />
                    </div>
                  ))}
                </div>
              </div>
            )}
          </AutoTransition>
        </AutoResizer>
      </CardContent>
    </Card>
  );
});
