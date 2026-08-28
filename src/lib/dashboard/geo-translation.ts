import type { Locale } from "@/lib/i18n/config";

export const GEO_TRANSLATION_API_BASE_URL = "https://locale.ravelloh.com";
export const GEO_TRANSLATION_DATA_LOCALE = "zh-CN";
export const GEO_STATE_CODE_PATTERN = /^[A-Z0-9-]{1,16}$/;

const GEO_TRANSLATION_API_LOCALE_BY_APP_LOCALE: Record<Locale, string | null> =
  {
    en: null,
    zh: GEO_TRANSLATION_DATA_LOCALE,
    ja: "ja",
  };

const GEO_COUNTRY_CODE_PATTERN = /^[A-Z]{2}$/;
const GEO_REGION_WORD_SUFFIX_PATTERN =
  /\b(?:special administrative region|administrative region|autonomous region|district|province|prefecture|municipality|county|state|region|city)\b$/;
const GEO_REGION_HAN_SUFFIX_PATTERN =
  /(特别行政区|特別行政區|自治区|自治區|地区|地區|省|市|州|府|县|縣|区|區)$/;

export interface LocaleGeoLabelRecord {
  name?: unknown;
  name_default?: unknown;
  native?: unknown;
}

export interface GeoTranslationTimezone {
  zoneName?: string;
  gmtOffset?: number;
  gmtOffsetName?: string;
  abbreviation?: string;
  tzName?: string;
}

export interface GeoTranslationCountryRecord extends LocaleGeoLabelRecord {
  id?: number | string;
  code?: string;
  iso3?: string;
  numeric_code?: string;
  capital?: string;
  phonecode?: string;
  currency?: string;
  currency_name?: string;
  currency_symbol?: string;
  tld?: string;
  population?: number | string | null;
  gdp?: number | string | null;
  region?: string;
  subregion?: string;
  nationality?: string;
  timezones?: GeoTranslationTimezone[];
  latitude?: string | number | null;
  longitude?: string | number | null;
  emoji?: string;
  emojiU?: string;
  [key: string]: unknown;
}

export interface GeoTranslationStateRecord extends LocaleGeoLabelRecord {
  id?: number | string;
  code?: string;
  iso2?: string;
  iso3166_2?: string;
  fips_code?: string | null;
  type?: string;
  level?: string | number | null;
  parent_id?: string | number | null;
  population?: number | string | null;
  latitude?: string | number | null;
  longitude?: string | number | null;
  timezone?: string;
  wikiDataId?: string | null;
  country_code?: string;
  [key: string]: unknown;
}

export interface GeoTranslationCityRecord extends LocaleGeoLabelRecord {
  id?: number | string;
  type?: string;
  level?: string | number | null;
  parent_id?: string | number | null;
  population?: number | string | null;
  latitude?: string | number | null;
  longitude?: string | number | null;
  timezone?: string;
  wikiDataId?: string | null;
  country_code?: string;
  state_code?: string;
  state_id?: number | string;
  country_id?: number | string;
  [key: string]: unknown;
}

export interface GeoTranslationCity {
  name: string;
  nameDefault: string;
  nativeName: string;
  record: GeoTranslationCityRecord;
}

export interface GeoCountryTranslationPayload {
  country?: GeoTranslationCountryRecord;
  states?: string[];
}

export interface GeoStateTranslationPayload {
  country?: GeoTranslationCountryRecord;
  state?: GeoTranslationStateRecord;
  cities?: GeoTranslationCityRecord[];
}

export interface GeoStateTranslationBundle {
  country: GeoTranslationCountryRecord | null;
  state: GeoTranslationStateRecord | null;
  stateCode: string;
  stateName: string;
  cities: GeoTranslationCity[];
  apiLocale?: string;
}

export interface GeoStateTranslationResolution {
  countryPayload: GeoCountryTranslationPayload | null;
  statePayload: GeoStateTranslationPayload | null;
  bundle: GeoStateTranslationBundle | null;
  stateCode: string;
  regionMatchesCountry: boolean;
  localityMatchesCountry: boolean;
}

const geoCountryCodesCache = new Map<string, Promise<string[] | null>>();
const geoCountryTranslationCache = new Map<
  string,
  Promise<GeoCountryTranslationPayload | null>
>();
const geoStatePayloadCache = new Map<
  string,
  Promise<GeoStateTranslationPayload | null>
>();
const geoStateTranslationCache = new Map<
  string,
  Promise<GeoStateTranslationBundle | null>
>();
const geoCountryStatePayloadsCache = new Map<
  string,
  Promise<GeoStateTranslationPayload[]>
>();

export function resolveGeoTranslationApiLocale(locale: Locale): string | null {
  return GEO_TRANSLATION_API_LOCALE_BY_APP_LOCALE[locale] ?? null;
}

export function buildGeoTranslationApiUrl(
  apiLocale: string,
  ...segments: string[]
): string {
  const path = [apiLocale, ...segments]
    .map((segment) => encodeURIComponent(segment.trim()))
    .filter((segment) => segment.length > 0)
    .join("/");
  const suffix = segments.length > 0 ? "/" : "";
  return `${GEO_TRANSLATION_API_BASE_URL}/${path}${suffix}`;
}

function asTrimmedString(value: unknown): string {
  return typeof value === "string" || typeof value === "number"
    ? String(value).trim()
    : "";
}

function normalizeCountryCode(value: string): string {
  const normalized = value.trim().toUpperCase();
  return GEO_COUNTRY_CODE_PATTERN.test(normalized) ? normalized : "";
}

function normalizeStateCode(value: string): string {
  return value.trim().toUpperCase();
}

function containsHan(value: string): boolean {
  return /[\u3400-\u9fff]/.test(value);
}

function shouldPreferNativeGeoLabel(name: string, nativeName: string): boolean {
  if (!name || !nativeName || name === nativeName) return false;
  if (!containsHan(name) || !containsHan(nativeName)) return false;
  if (name.length <= 1 && nativeName.length > name.length) return true;
  return nativeName.length > name.length && nativeName.startsWith(name);
}

function pickReadableZhGeoLabel(record: LocaleGeoLabelRecord): string {
  const name = asTrimmedString(record.name);
  const nativeName = asTrimmedString(record.native);
  if (shouldPreferNativeGeoLabel(name, nativeName)) return nativeName;
  return name || nativeName || asTrimmedString(record.name_default);
}

function pickApiLocaleGeoLabel(
  record: LocaleGeoLabelRecord | null | undefined,
  apiLocale: string,
): string {
  if (!record) return "";
  if (apiLocale === GEO_TRANSLATION_DATA_LOCALE) {
    return pickReadableZhGeoLabel(record);
  }

  return (
    asTrimmedString(record.name) ||
    asTrimmedString(record.native) ||
    asTrimmedString(record.name_default)
  );
}

export function normalizeGeoTranslationLookupValue(value: string): string {
  return value
    .trim()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLocaleLowerCase()
    .replace(/&/g, " and ")
    .replace(/[.'’`]/g, "")
    .replace(/[()[\]{},/\\_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeGeoTranslationAliasValue(value: string): string {
  const normalized = normalizeGeoTranslationLookupValue(value)
    .replace(/\b(?:s a r|sar)\b/g, "")
    .replace(/\s+/g, " ")
    .trim();
  const withoutWordSuffix = normalized
    .replace(GEO_REGION_WORD_SUFFIX_PATTERN, "")
    .replace(/\s+/g, " ")
    .trim();

  return withoutWordSuffix.replace(GEO_REGION_HAN_SUFFIX_PATTERN, "").trim();
}

function addGeoLookupCandidate(candidates: Set<string>, value: unknown) {
  const rawValue = asTrimmedString(value);
  if (!rawValue) return;

  const normalized = normalizeGeoTranslationLookupValue(rawValue);
  if (normalized) candidates.add(normalized);

  const alias = normalizeGeoTranslationAliasValue(rawValue);
  if (alias) candidates.add(alias);
}

function collectGeoLookupCandidates(
  record: LocaleGeoLabelRecord | null | undefined,
  extraValues: unknown[] = [],
): Set<string> {
  const candidates = new Set<string>();
  if (record) {
    addGeoLookupCandidate(candidates, record.name);
    addGeoLookupCandidate(candidates, record.name_default);
    addGeoLookupCandidate(candidates, record.native);

    const keyedRecord = record as Record<string, unknown>;
    addGeoLookupCandidate(candidates, keyedRecord.code);
    addGeoLookupCandidate(candidates, keyedRecord.iso2);
    addGeoLookupCandidate(candidates, keyedRecord.iso3);
    addGeoLookupCandidate(candidates, keyedRecord.iso3166_2);

    const iso3166 = asTrimmedString(keyedRecord.iso3166_2);
    const [, shortCode] = iso3166.split("-");
    addGeoLookupCandidate(candidates, shortCode);
  }

  for (const value of extraValues) {
    addGeoLookupCandidate(candidates, value);
  }

  return candidates;
}

export function matchesGeoLabelRecord(
  record: LocaleGeoLabelRecord | null | undefined,
  lookupValue: string,
  extraValues: unknown[] = [],
): boolean {
  const lookupCandidates = collectGeoLookupCandidates(null, [lookupValue]);
  if (lookupCandidates.size === 0) return false;

  const recordCandidates = collectGeoLookupCandidates(record, extraValues);
  for (const lookup of lookupCandidates) {
    if (recordCandidates.has(lookup)) return true;
  }
  return false;
}

export function isSameGeoLabel(left: string, right: string): boolean {
  const normalizedLeft = normalizeGeoTranslationLookupValue(left);
  const normalizedRight = normalizeGeoTranslationLookupValue(right);
  return Boolean(
    normalizedLeft && normalizedRight && normalizedLeft === normalizedRight,
  );
}

export function isGeoLabelCountryMatch({
  countryLabel,
  countryPayload,
  label,
}: {
  countryLabel: string;
  countryPayload: GeoCountryTranslationPayload | null | undefined;
  label: string;
}): boolean {
  const labelCandidates = collectGeoLookupCandidates(null, [label]);
  if (labelCandidates.size === 0) return false;

  const countryCandidates = collectGeoLookupCandidates(
    countryPayload?.country,
    [countryLabel],
  );
  for (const candidate of labelCandidates) {
    if (countryCandidates.has(candidate)) return true;
  }
  return false;
}

export function isGeoRegionCountryMatch({
  countryLabel,
  countryPayload,
  regionLabel,
}: {
  countryLabel: string;
  countryPayload: GeoCountryTranslationPayload | null | undefined;
  regionLabel: string;
}): boolean {
  return isGeoLabelCountryMatch({
    countryLabel,
    countryPayload,
    label: regionLabel,
  });
}

export function pickLocaleGeoLabel(
  locale: Locale,
  record: LocaleGeoLabelRecord | null | undefined,
): string {
  if (!record) return "";
  if (locale === "zh") {
    return pickReadableZhGeoLabel(record);
  }

  return (
    asTrimmedString(record.name_default) ||
    asTrimmedString(record.name) ||
    asTrimmedString(record.native)
  );
}

export function parseGeoCountryTranslationPayload(
  payload: unknown,
): GeoCountryTranslationPayload | null {
  if (!payload || typeof payload !== "object") return null;
  const record = payload as GeoCountryTranslationPayload;
  return {
    country:
      record.country && typeof record.country === "object"
        ? record.country
        : undefined,
    states: Array.isArray(record.states)
      ? record.states
          .map((value) => normalizeStateCode(String(value ?? "")))
          .filter((value) => value.length > 0)
      : [],
  };
}

export function parseGeoStateTranslationPayload(
  payload: unknown,
): GeoStateTranslationPayload | null {
  if (!payload || typeof payload !== "object") return null;
  const record = payload as GeoStateTranslationPayload;
  return {
    country:
      record.country && typeof record.country === "object"
        ? record.country
        : undefined,
    state:
      record.state && typeof record.state === "object"
        ? record.state
        : undefined,
    cities: Array.isArray(record.cities)
      ? record.cities.filter((city): city is GeoTranslationCityRecord =>
          Boolean(city && typeof city === "object"),
        )
      : [],
  };
}

export function parseGeoStateTranslationBundle(
  payload: unknown,
  apiLocale = GEO_TRANSLATION_DATA_LOCALE,
): GeoStateTranslationBundle | null {
  const record = parseGeoStateTranslationPayload(payload);
  if (!record) return null;

  const stateName = pickApiLocaleGeoLabel(record.state, apiLocale);
  const stateCode = normalizeStateCode(
    asTrimmedString(record.state?.code) || asTrimmedString(record.state?.iso2),
  );
  const cities = (record.cities ?? []).flatMap((city) => {
    const name = asTrimmedString(city.name);
    const nameDefault = asTrimmedString(city.name_default);
    const nativeName = asTrimmedString(city.native);
    if (!name && !nameDefault && !nativeName) return [];
    return [{ name, nameDefault, nativeName, record: city }];
  });

  return {
    country: record.country ?? null,
    state: record.state ?? null,
    stateCode,
    stateName,
    cities,
    apiLocale,
  };
}

export async function fetchGeoCountryCodes(
  apiLocale: string,
): Promise<string[] | null> {
  const cacheKey = apiLocale.trim();
  const cached = geoCountryCodesCache.get(cacheKey);
  if (cached) return cached;

  const request = fetch(buildGeoTranslationApiUrl(apiLocale), {
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

  geoCountryCodesCache.set(cacheKey, request);
  return request;
}

export async function fetchGeoCountryTranslationPayload(
  apiLocale: string,
  countryCode: string,
): Promise<GeoCountryTranslationPayload | null> {
  const normalizedCountry = normalizeCountryCode(countryCode);
  if (!normalizedCountry) return null;

  const cacheKey = `${apiLocale}::${normalizedCountry}`;
  const cached = geoCountryTranslationCache.get(cacheKey);
  if (cached) return cached;

  const request = fetch(
    buildGeoTranslationApiUrl(apiLocale, normalizedCountry),
    {
      method: "GET",
      cache: "force-cache",
    },
  )
    .then(async (response) => {
      if (!response.ok) return null;
      const payload = (await response.json()) as unknown;
      return parseGeoCountryTranslationPayload(payload);
    })
    .catch(() => null);

  geoCountryTranslationCache.set(cacheKey, request);
  return request;
}

export async function fetchGeoStateTranslationPayload(
  apiLocale: string,
  countryCode: string,
  stateCode: string,
): Promise<GeoStateTranslationPayload | null> {
  const normalizedCountry = normalizeCountryCode(countryCode);
  const normalizedState = normalizeStateCode(stateCode);
  if (
    !normalizedCountry ||
    !normalizedState ||
    !GEO_STATE_CODE_PATTERN.test(normalizedState)
  ) {
    return null;
  }

  const cacheKey = `${apiLocale}::${normalizedCountry}::${normalizedState}`;
  const cached = geoStatePayloadCache.get(cacheKey);
  if (cached) return cached;

  const request = fetch(
    buildGeoTranslationApiUrl(apiLocale, normalizedCountry, normalizedState),
    {
      method: "GET",
      cache: "force-cache",
    },
  )
    .then(async (response) => {
      if (!response.ok) return null;
      const payload = (await response.json()) as unknown;
      return parseGeoStateTranslationPayload(payload);
    })
    .catch(() => null);

  geoStatePayloadCache.set(cacheKey, request);
  return request;
}

export async function fetchGeoStateTranslationBundle(
  apiLocale: string,
  countryCode: string,
  stateCode: string,
): Promise<GeoStateTranslationBundle | null> {
  const normalizedCountry = normalizeCountryCode(countryCode);
  const normalizedState = normalizeStateCode(stateCode);
  if (
    !normalizedCountry ||
    !normalizedState ||
    !GEO_STATE_CODE_PATTERN.test(normalizedState)
  ) {
    return null;
  }

  const cacheKey = `${apiLocale}::${normalizedCountry}::${normalizedState}`;
  const cached = geoStateTranslationCache.get(cacheKey);
  if (cached) return cached;

  const request = fetchGeoStateTranslationPayload(
    apiLocale,
    normalizedCountry,
    normalizedState,
  )
    .then((payload) =>
      payload ? parseGeoStateTranslationBundle(payload, apiLocale) : null,
    )
    .catch(() => null);

  geoStateTranslationCache.set(cacheKey, request);
  return request;
}

async function fetchGeoCountryStatePayloads(
  apiLocale: string,
  countryCode: string,
  countryPayload: GeoCountryTranslationPayload | null,
): Promise<GeoStateTranslationPayload[]> {
  const normalizedCountry = normalizeCountryCode(countryCode);
  if (!normalizedCountry || !countryPayload?.states?.length) return [];

  const cacheKey = `${apiLocale}::${normalizedCountry}`;
  const cached = geoCountryStatePayloadsCache.get(cacheKey);
  if (cached) return cached;

  const stateCodes = Array.from(new Set(countryPayload.states));
  const request = Promise.all(
    stateCodes.map((stateCode) =>
      fetchGeoStateTranslationPayload(apiLocale, normalizedCountry, stateCode),
    ),
  ).then((payloads) =>
    payloads.filter((payload): payload is GeoStateTranslationPayload =>
      Boolean(payload?.state),
    ),
  );

  geoCountryStatePayloadsCache.set(cacheKey, request);
  return request;
}

function getStatePayloadCode(payload: GeoStateTranslationPayload): string {
  return normalizeStateCode(
    asTrimmedString(payload.state?.code) ||
      asTrimmedString(payload.state?.iso2),
  );
}

function dedupeStatePayloads(
  payloads: GeoStateTranslationPayload[],
): GeoStateTranslationPayload[] {
  const deduped = new Map<string, GeoStateTranslationPayload>();
  for (const payload of payloads) {
    const code = getStatePayloadCode(payload);
    if (!code || deduped.has(code)) continue;
    deduped.set(code, payload);
  }
  return [...deduped.values()];
}

function findStatePayloadByRegionLabel(
  payloads: GeoStateTranslationPayload[],
  lookupValues: string[],
): GeoStateTranslationPayload | null {
  const matches = dedupeStatePayloads(
    payloads.filter((payload) =>
      lookupValues.some((lookupValue) =>
        matchesGeoLabelRecord(payload.state, lookupValue),
      ),
    ),
  );
  return matches.length === 1 ? matches[0] : null;
}

function findStatePayloadByLocalityLabel(
  payloads: GeoStateTranslationPayload[],
  localityLabel: string,
): GeoStateTranslationPayload | null {
  const matches = dedupeStatePayloads(
    payloads.filter((payload) =>
      (payload.cities ?? []).some((city) =>
        matchesGeoLabelRecord(city, localityLabel),
      ),
    ),
  );
  return matches.length === 1 ? matches[0] : null;
}

export async function resolveGeoStateTranslation(
  apiLocale: string,
  countryCode: string,
  stateCode: string,
  options: {
    countryLabel?: string;
    regionLabel?: string;
    localityLabel?: string;
  } = {},
): Promise<GeoStateTranslationResolution | null> {
  const normalizedCountry = normalizeCountryCode(countryCode);
  const normalizedState = normalizeStateCode(stateCode);
  if (!normalizedCountry) return null;

  let directStatePayload: GeoStateTranslationPayload | null = null;
  if (normalizedState && GEO_STATE_CODE_PATTERN.test(normalizedState)) {
    directStatePayload = await fetchGeoStateTranslationPayload(
      apiLocale,
      normalizedCountry,
      normalizedState,
    );

    if (directStatePayload?.state && !(options.regionLabel ?? "").trim()) {
      const bundle = parseGeoStateTranslationBundle(
        directStatePayload,
        apiLocale,
      );
      return {
        countryPayload: directStatePayload.country
          ? { country: directStatePayload.country }
          : null,
        statePayload: directStatePayload,
        bundle,
        stateCode: getStatePayloadCode(directStatePayload) || normalizedState,
        regionMatchesCountry: false,
        localityMatchesCountry: false,
      };
    }
  }

  const regionLabel = (options.regionLabel ?? "").trim();
  const directCountryPayload = directStatePayload?.country
    ? { country: directStatePayload.country }
    : null;
  const fetchedCountryPayload =
    regionLabel || !directStatePayload?.state || !directCountryPayload
      ? await fetchGeoCountryTranslationPayload(apiLocale, normalizedCountry)
      : null;
  const countryPayload = fetchedCountryPayload ?? directCountryPayload;
  const regionLookupValues = [regionLabel || normalizedState].filter(
    (value) => value.length > 0,
  );
  const regionMatchesCountry = regionLabel
    ? isGeoRegionCountryMatch({
        countryLabel: options.countryLabel ?? "",
        countryPayload,
        regionLabel,
      })
    : regionLookupValues.some((lookupValue) =>
        isGeoRegionCountryMatch({
          countryLabel: options.countryLabel ?? "",
          countryPayload,
          regionLabel: lookupValue,
        }),
      );
  const localityMatchesCountry = isGeoLabelCountryMatch({
    countryLabel: options.countryLabel ?? "",
    countryPayload,
    label: options.localityLabel ?? "",
  });

  if (
    directStatePayload?.state &&
    regionLabel &&
    !regionMatchesCountry &&
    matchesGeoLabelRecord(directStatePayload.state, regionLabel)
  ) {
    const bundle = parseGeoStateTranslationBundle(
      directStatePayload,
      apiLocale,
    );
    return {
      countryPayload,
      statePayload: directStatePayload,
      bundle,
      stateCode: getStatePayloadCode(directStatePayload) || normalizedState,
      regionMatchesCountry: false,
      localityMatchesCountry,
    };
  }

  const statePayloads =
    localityMatchesCountry && regionLookupValues.length === 0
      ? []
      : await fetchGeoCountryStatePayloads(
          apiLocale,
          normalizedCountry,
          countryPayload,
        );
  const matchedStatePayload =
    (!regionMatchesCountry
      ? findStatePayloadByRegionLabel(statePayloads, regionLookupValues)
      : null) ??
    (!localityMatchesCountry && options.localityLabel
      ? findStatePayloadByLocalityLabel(statePayloads, options.localityLabel)
      : null);
  const bundle = matchedStatePayload
    ? parseGeoStateTranslationBundle(matchedStatePayload, apiLocale)
    : null;

  return {
    countryPayload,
    statePayload: matchedStatePayload,
    bundle,
    stateCode: matchedStatePayload
      ? getStatePayloadCode(matchedStatePayload)
      : "",
    regionMatchesCountry,
    localityMatchesCountry,
  };
}

function pickLocalizedCityRecordLabel(
  city: GeoTranslationCity,
  apiLocale = GEO_TRANSLATION_DATA_LOCALE,
): string {
  return (
    pickApiLocaleGeoLabel(city.record, apiLocale) ||
    city.name ||
    city.nameDefault ||
    city.nativeName
  );
}

export function resolveLocalizedCityName(
  bundle: GeoStateTranslationBundle | null,
  cityNameDefault: string,
): string | null {
  if (!bundle) return null;
  const target = cityNameDefault.trim();
  if (!target) return null;

  for (const city of bundle.cities) {
    if (matchesGeoLabelRecord(city.record, target)) {
      return pickLocalizedCityRecordLabel(city, bundle.apiLocale) || null;
    }
  }

  return null;
}

export function normalizeGeoDisplayLabel(
  value: string,
  unknownLabel: string,
): string {
  const normalized = value.trim();
  return normalized || unknownLabel;
}

export function formatLocalizedGeoValue(
  localizedValue: string,
  rawValue: string,
  unknownLabel: string,
): string {
  const normalizedLocalized = normalizeGeoDisplayLabel(
    localizedValue,
    unknownLabel,
  );
  const normalizedRaw = normalizeGeoDisplayLabel(rawValue, unknownLabel);
  if (
    normalizedRaw === unknownLabel ||
    isSameGeoLabel(normalizedLocalized, normalizedRaw)
  ) {
    return normalizedLocalized;
  }
  return `${normalizedLocalized} (${normalizedRaw})`;
}
