export const GEO_LOCATION_SEPARATOR = "::";
const GEO_COUNTRY_CODE_PATTERN = /^[A-Z]{2}$/;

export type GeoLocationLevel = "country" | "region" | "locality";

export interface ParsedGeoLocation {
  canonical: string;
  level: GeoLocationLevel;
  countryCode: string;
  regionCode?: string;
  regionName?: string;
  localityName?: string;
}

function cleanSegment(value: string | null | undefined): string {
  return String(value ?? "").trim();
}

function upperSegment(value: string | null | undefined): string {
  return cleanSegment(value).toUpperCase();
}

export function normalizeGeoNameToken(value: string | null | undefined): string {
  return cleanSegment(value)
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\s+/g, " ")
    .toLowerCase();
}

export function buildRegionLocationValue(
  countryCode: string,
  regionCode: string,
  regionName: string,
): string {
  const country = upperSegment(countryCode);
  const code = upperSegment(regionCode) || upperSegment(regionName);
  const name = cleanSegment(regionName) || cleanSegment(regionCode);
  return [country, code, name].filter((segment) => segment.length > 0).join(
    GEO_LOCATION_SEPARATOR,
  );
}

export function buildLocalityLocationValue(
  countryCode: string,
  regionCode: string | null | undefined,
  regionName: string | null | undefined,
  localityName: string,
): string {
  const country = upperSegment(countryCode);
  const code = upperSegment(regionCode) || upperSegment(regionName);
  const region = cleanSegment(regionName) || cleanSegment(regionCode);
  const locality = cleanSegment(localityName);

  if (code && region) {
    return [country, code, region, locality]
      .filter((segment) => segment.length > 0)
      .join(GEO_LOCATION_SEPARATOR);
  }

  return [country, locality]
    .filter((segment) => segment.length > 0)
    .join(GEO_LOCATION_SEPARATOR);
}

export function canonicalizeGeoLocationValue(
  rawValue: string | null | undefined,
): string | null {
  const normalized = cleanSegment(rawValue);
  if (!normalized) return null;

  const segments = normalized
    .split(GEO_LOCATION_SEPARATOR)
    .map((segment) => cleanSegment(segment))
    .filter((segment) => segment.length > 0);

  if (segments.length === 0) return null;

  const countryCode = upperSegment(segments[0]);
  if (!GEO_COUNTRY_CODE_PATTERN.test(countryCode)) return null;

  if (segments.length === 1) {
    return countryCode;
  }

  if (segments.length === 2) {
    const localityName = cleanSegment(segments[1]);
    return localityName
      ? `${countryCode}${GEO_LOCATION_SEPARATOR}${localityName}`
      : countryCode;
  }

  if (segments.length === 3) {
    return buildRegionLocationValue(countryCode, segments[1], segments[2]);
  }

  return buildLocalityLocationValue(
    countryCode,
    segments[1],
    segments[2],
    segments.slice(3).join(GEO_LOCATION_SEPARATOR),
  );
}

export function parseGeoLocationValue(
  rawValue: string | null | undefined,
): ParsedGeoLocation | null {
  const canonical = canonicalizeGeoLocationValue(rawValue);
  if (!canonical) return null;

  const segments = canonical.split(GEO_LOCATION_SEPARATOR);
  const countryCode = upperSegment(segments[0]);
  if (!countryCode) return null;

  if (segments.length === 1) {
    return {
      canonical,
      level: "country",
      countryCode,
    };
  }

  if (segments.length === 2) {
    return {
      canonical,
      level: "locality",
      countryCode,
      localityName: cleanSegment(segments[1]),
    };
  }

  if (segments.length === 3) {
    return {
      canonical,
      level: "region",
      countryCode,
      regionCode: upperSegment(segments[1]),
      regionName: cleanSegment(segments[2]),
    };
  }

  return {
    canonical,
    level: "locality",
    countryCode,
    regionCode: upperSegment(segments[1]),
    regionName: cleanSegment(segments[2]),
    localityName: cleanSegment(segments.slice(3).join(GEO_LOCATION_SEPARATOR)),
  };
}

export function parentGeoLocationValue(
  location: ParsedGeoLocation | null | undefined,
): string | null {
  if (!location) return null;
  if (location.level === "country") return null;
  if (location.level === "region") return location.countryCode;
  if (location.regionCode || location.regionName) {
    return buildRegionLocationValue(
      location.countryCode,
      location.regionCode ?? location.regionName ?? "",
      location.regionName ?? location.regionCode ?? "",
    );
  }
  return location.countryCode;
}
