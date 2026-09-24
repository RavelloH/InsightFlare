import {
  buildLocalityLocationValue,
  buildRegionLocationValue,
  canonicalizeGeoLocationValue,
} from "@/lib/analytics/geo-location";
import { type DashboardFilterControlKey } from "@/lib/dashboard/filter-state";
import {
  isSameGeoLabel,
  normalizeGeoTranslationLookupValue,
} from "@/lib/dashboard/geo-translation";
import { normalizePagePath } from "@/lib/dashboard/page-detail";
import {
  attachFilterScopePreference,
  parseFilterScopePreference,
} from "@/lib/filter-contract/index";
import {
  analyticsFilterRegistry,
  type FilterDocument,
  parseFilterParams,
} from "@/lib/filter-contract/index";
import {
  resolveCountryFlagCode,
  resolveCountryLabel,
} from "@/lib/i18n/code-labels";
import type { Locale } from "@/lib/i18n/config";

import { normalizeDimensionLabel } from "./overview-labels";
import {
  type ClientDimensionCardTab,
  type GeoDimensionCardTab,
  type GeoLocationTab,
  type PageCardDetailTab,
  type PageCardNavigableTab,
  type PageCardRow,
  type PageCardTab,
  type SourceCardTab,
} from "./types";
export const PAGE_CARD_TABS: PageCardTab[] = [
  "path",
  "title",
  "hostname",
  "entry",
  "exit",
];
export const SOURCE_CARD_TABS: SourceCardTab[] = ["domain", "link", "channel"];
export const PAGE_CARD_NAVIGABLE_TAB_LIST: PageCardNavigableTab[] = [
  "path",
  "hostname",
  "entry",
  "exit",
];
export const PAGE_CARD_DETAIL_TAB_LIST: PageCardDetailTab[] = [
  "path",
  "entry",
  "exit",
];
export const ABSOLUTE_URL_PATTERN = /^[a-z][a-z\d+\-.]*:\/\//i;
export const PAGE_CARD_FILTER_CONTROL_BY_TAB: Record<
  PageCardTab,
  DashboardFilterControlKey
> = {
  path: "path",
  query: "query",
  title: "title",
  hostname: "hostname",
  entry: "entry",
  exit: "exit",
};
export const SOURCE_CARD_FILTER_CONTROL_BY_TAB: Record<
  SourceCardTab,
  DashboardFilterControlKey
> = {
  domain: "sourceDomain",
  link: "sourceLink",
  channel: "channel",
};
export const CLIENT_DIMENSION_CARD_TABS: ClientDimensionCardTab[] = [
  "browser",
  "osVersion",
  "deviceType",
  "language",
  "screenSize",
];
export const GEO_DIMENSION_CARD_TABS: GeoDimensionCardTab[] = [
  "country",
  "region",
  "city",
  "continent",
  "timezone",
  "organization",
];
export const CLIENT_DIMENSION_CARD_FILTER_CONTROL_BY_TAB: Record<
  ClientDimensionCardTab,
  DashboardFilterControlKey
> = {
  browser: "clientBrowser",
  osVersion: "clientOsVersion",
  deviceType: "clientDeviceType",
  language: "clientLanguage",
  screenSize: "clientScreenSize",
};
export const GEO_AUX_FILTER_CONTROL_BY_TAB: Record<
  Exclude<GeoDimensionCardTab, GeoLocationTab>,
  DashboardFilterControlKey
> = {
  continent: "geoContinent",
  timezone: "geoTimezone",
  organization: "geoOrganization",
};
export const DIRECT_REFERRER_FILTER_VALUE = "__direct__";
const GEO_REGION_VALUE_SEPARATOR = "::";
export function extractGeoCountryCodeFromFilterValue(
  value: string | null | undefined,
): string | null {
  const normalized = String(value ?? "").trim();
  if (!normalized) return null;
  const country = normalized
    .split(GEO_REGION_VALUE_SEPARATOR)
    .map((segment) => segment.trim())[0]
    ?.toUpperCase();
  if (!country) return null;
  return /^[A-Z]{2}$/.test(country) ? country : null;
}
export function parseOverviewCardFilters(
  searchParams: URLSearchParams,
): FilterDocument {
  return attachFilterScopePreference(
    parseFilterParams(searchParams, analyticsFilterRegistry),
    parseFilterScopePreference(searchParams),
  );
}
export function isGeoLocationTab(
  tab: GeoDimensionCardTab,
): tab is GeoLocationTab {
  return tab === "country" || tab === "region" || tab === "city";
}
export function canonicalizeGeoFilterValue(
  raw: string | null | undefined,
): string | null {
  return canonicalizeGeoLocationValue(raw);
}
export function resolveGeoLocationHighlightValue(
  tab: GeoLocationTab,
  geoFilterValue: string | null,
): string | null {
  if (!geoFilterValue) return null;
  const normalized = canonicalizeGeoFilterValue(geoFilterValue);
  if (!normalized) return null;
  const segments = normalized
    .split(GEO_REGION_VALUE_SEPARATOR)
    .map((segment) => segment.trim());
  if (tab === "country") {
    return segments[0] || null;
  }
  if (tab === "region") {
    if (segments.length < 3) return null;
    return `${segments[0]}${GEO_REGION_VALUE_SEPARATOR}${segments[1]}${GEO_REGION_VALUE_SEPARATOR}${segments[2]}`;
  }
  if (segments.length < 4) return null;
  return `${segments[0]}${GEO_REGION_VALUE_SEPARATOR}${segments[1]}${GEO_REGION_VALUE_SEPARATOR}${segments[2]}${GEO_REGION_VALUE_SEPARATOR}${segments.slice(3).join(GEO_REGION_VALUE_SEPARATOR)}`;
}
export function resolveGeoRegionBreadcrumbData(
  value: string,
  locale: Locale,
  unknownLabel: string,
): {
  displayLabel: string;
  filterValue: string;
  breadcrumb: {
    countryLabel: string;
    countryIconName: string | null;
    regionLabel: string;
    countryCode: string;
    stateCode: string;
    hideRegion: boolean;
  };
} {
  const normalized = value.trim();
  const segments = normalized
    .split(GEO_REGION_VALUE_SEPARATOR)
    .map((segment) => segment.trim());
  const rawCountry = segments[0] || "";
  const rawStateCode = segments.length >= 3 ? segments[1] || "" : "";
  const rawStateName =
    segments.length >= 3
      ? segments.slice(2).join(GEO_REGION_VALUE_SEPARATOR).trim()
      : segments.length >= 2
        ? segments[1] || ""
        : "";
  const hasRegion = Boolean(rawStateCode.trim() || rawStateName.trim());
  const countryCode = rawCountry.toUpperCase();
  const effectiveStateCode = rawStateCode.trim() || rawStateName.trim();
  const effectiveStateName = rawStateName.trim() || effectiveStateCode;

  const regionLabel = normalizeDimensionLabel(rawStateName, unknownLabel);
  const { label: countryLabel, code } = resolveCountryLabel(
    rawCountry,
    locale,
    unknownLabel,
  );
  const flagCode = resolveCountryFlagCode(code, locale);
  const countryIconName = flagCode
    ? `flagpack:${flagCode.toLowerCase()}`
    : null;

  return {
    displayLabel: hasRegion ? `${countryLabel} > ${regionLabel}` : countryLabel,
    filterValue: hasRegion
      ? buildRegionLocationValue(
          countryCode,
          effectiveStateCode,
          effectiveStateName,
        )
      : countryCode || countryLabel,
    breadcrumb: {
      countryLabel,
      countryIconName,
      regionLabel,
      countryCode,
      stateCode: rawStateCode,
      hideRegion: !hasRegion,
    },
  };
}
export function resolveGeoCityBreadcrumbData(
  value: string,
  locale: Locale,
  unknownLabel: string,
): {
  displayLabel: string;
  filterValue: string;
  breadcrumb: {
    countryLabel: string;
    countryIconName: string | null;
    regionLabel: string;
    cityLabel: string;
    countryCode: string;
    stateCode: string;
    cityNameDefault: string;
    hideRegion: boolean;
    hideCity: boolean;
  } | null;
} {
  const normalized = value.trim();
  const segments = normalized
    .split(GEO_REGION_VALUE_SEPARATOR)
    .map((segment) => segment.trim());

  if (segments.length < 2) {
    const cityLabel = normalizeDimensionLabel(normalized, unknownLabel);
    return {
      displayLabel: cityLabel,
      filterValue: cityLabel,
      breadcrumb: null,
    };
  }

  if (segments.length === 2) {
    const rawCountry = segments[0] || "";
    const rawCity = segments[1] || "";
    const countryCode = rawCountry.toUpperCase();
    if (!/^[A-Z]{2}$/.test(countryCode) || !rawCity) {
      const cityLabel = normalizeDimensionLabel(normalized, unknownLabel);
      return {
        displayLabel: cityLabel,
        filterValue: cityLabel,
        breadcrumb: null,
      };
    }

    const cityLabel = normalizeDimensionLabel(rawCity, unknownLabel);
    const { label: countryLabel, code } = resolveCountryLabel(
      rawCountry,
      locale,
      unknownLabel,
    );
    const flagCode = resolveCountryFlagCode(code, locale);
    const countryIconName = flagCode
      ? `flagpack:${flagCode.toLowerCase()}`
      : null;
    const englishCountryLabel = resolveCountryLabel(
      rawCountry,
      "en",
      unknownLabel,
    ).label;
    const hideCity =
      isSameGeoLabel(countryLabel, cityLabel) ||
      isSameGeoLabel(englishCountryLabel, cityLabel);

    return {
      displayLabel: hideCity ? countryLabel : `${countryLabel} > ${cityLabel}`,
      filterValue: buildLocalityLocationValue(countryCode, "", "", rawCity),
      breadcrumb: {
        countryLabel,
        countryIconName,
        regionLabel: "",
        cityLabel,
        countryCode,
        stateCode: "",
        cityNameDefault: rawCity,
        hideRegion: true,
        hideCity,
      },
    };
  }

  const rawCountry = segments[0] || "";
  const rawStateCode = segments.length >= 4 ? segments[1] || "" : "";
  const rawStateName =
    segments.length >= 4 ? segments[2] || "" : segments[1] || "";
  const rawCity =
    segments.length >= 4
      ? segments.slice(3).join(GEO_REGION_VALUE_SEPARATOR).trim()
      : segments.slice(2).join(GEO_REGION_VALUE_SEPARATOR).trim();
  const hasRegion = Boolean(rawStateCode.trim() || rawStateName.trim());
  const hideRegion = !hasRegion;
  const regionLabel = normalizeDimensionLabel(rawStateName, unknownLabel);
  const cityLabel = normalizeDimensionLabel(rawCity, unknownLabel);
  const countryCode = rawCountry.toUpperCase();
  const effectiveStateCode = rawStateCode.trim() || rawStateName.trim();
  const effectiveStateName = rawStateName.trim() || effectiveStateCode;
  const effectiveCity = rawCity.trim() || cityLabel;
  const { label: countryLabel, code } = resolveCountryLabel(
    rawCountry,
    locale,
    unknownLabel,
  );
  const flagCode = resolveCountryFlagCode(code, locale);
  const countryIconName = flagCode
    ? `flagpack:${flagCode.toLowerCase()}`
    : null;
  const englishCountryLabel = resolveCountryLabel(
    rawCountry,
    "en",
    unknownLabel,
  ).label;
  const hideCity =
    isSameGeoLabel(rawStateName, rawCity) ||
    (hideRegion &&
      (isSameGeoLabel(countryLabel, cityLabel) ||
        isSameGeoLabel(englishCountryLabel, cityLabel)));

  return {
    displayLabel: hideRegion
      ? hideCity
        ? countryLabel
        : `${countryLabel} > ${cityLabel}`
      : hideCity
        ? `${countryLabel} > ${regionLabel}`
        : `${countryLabel} > ${regionLabel} > ${cityLabel}`,
    filterValue:
      countryCode && effectiveCity
        ? buildLocalityLocationValue(
            countryCode,
            effectiveStateCode,
            effectiveStateName,
            effectiveCity,
          )
        : effectiveCity,
    breadcrumb: {
      countryLabel,
      countryIconName,
      regionLabel,
      cityLabel,
      countryCode,
      stateCode: rawStateCode,
      cityNameDefault: effectiveCity,
      hideRegion,
      hideCity,
    },
  };
}
export function buildGeoPagePath(pathname: string): string {
  const normalized = pathname.trim().replace(/\/+$/, "");
  if (!normalized) return "/geo";
  if (normalized.endsWith("/geo")) return normalized;
  return `${normalized}/geo`;
}
export function buildPagesPagePath(pathname: string): string {
  const normalized = pathname.trim().replace(/\/+$/, "");
  if (!normalized) return "/pages";
  if (normalized.endsWith("/pages")) return normalized;
  if (normalized.endsWith("/pages/detail")) {
    return normalized.replace(/\/detail$/, "");
  }
  return `${normalized}/pages`;
}
export function isPageCardDetailTab(
  tab: PageCardTab,
): tab is PageCardDetailTab {
  return tab === "path" || tab === "entry" || tab === "exit";
}
export function resolvePageCardDetailPath(params: {
  tab?: PageCardDetailTab;
  basePath: string;
  value: string;
  unknownLabel: string;
}): string | null {
  const raw = params.value.trim();
  if (raw.length === 0 || raw === params.unknownLabel) return null;

  const normalizedPath = normalizePagePath(raw);
  if (!normalizedPath) return null;

  return normalizedPath;
}
export function resolveGeoLocationQueryValue(
  tab: GeoDimensionCardTab,
  row: PageCardRow,
  unknownLabel: string,
): string | null {
  if (tab !== "country" && tab !== "region" && tab !== "city") return null;

  const unknown = normalizeGeoTranslationLookupValue(unknownLabel);
  const raw = String(row.rawLabel || row.label || "").trim();
  if (!raw) return null;

  const normalizedRaw = normalizeGeoTranslationLookupValue(raw);
  if (normalizedRaw === unknown) return null;

  const segments = raw
    .split(GEO_REGION_VALUE_SEPARATOR)
    .map((segment) => segment.trim())
    .filter((segment) => segment.length > 0);

  if (tab === "country") {
    const country = (segments[0] || raw).trim().toUpperCase();
    if (!country) return null;
    if (normalizeGeoTranslationLookupValue(country) === unknown) return null;
    return country;
  }

  if (tab === "region") {
    if (segments.length >= 3) {
      const regionName = segments
        .slice(2)
        .join(GEO_REGION_VALUE_SEPARATOR)
        .trim();
      return (
        buildRegionLocationValue(
          segments[0] || "",
          segments[1] || regionName,
          regionName || segments[1] || "",
        ) || null
      );
    }
    const breadcrumb = row.regionBreadcrumb;
    if (!breadcrumb) return null;
    if (breadcrumb.hideRegion) {
      const country = breadcrumb.countryCode.trim().toUpperCase();
      return country || null;
    }
    if (
      normalizeGeoTranslationLookupValue(breadcrumb.regionLabel) === unknown ||
      normalizeGeoTranslationLookupValue(breadcrumb.countryCode) === unknown
    ) {
      return null;
    }
    return (
      buildRegionLocationValue(
        breadcrumb.countryCode,
        breadcrumb.stateCode,
        breadcrumb.regionLabel,
      ) || null
    );
  }

  if (segments.length >= 4) {
    const cityName = segments.slice(3).join(GEO_REGION_VALUE_SEPARATOR).trim();
    return (
      buildLocalityLocationValue(
        segments[0] || "",
        segments[1] || segments[2] || "",
        segments[2] || segments[1] || "",
        cityName,
      ) || null
    );
  }

  const breadcrumb = row.cityBreadcrumb;
  if (!breadcrumb) return null;
  if (breadcrumb.hideRegion) {
    const country = breadcrumb.countryCode.trim().toUpperCase();
    if (!country) return null;
    if (
      normalizeGeoTranslationLookupValue(breadcrumb.cityNameDefault) === unknown
    ) {
      return country;
    }
    if (breadcrumb.hideCity) return country;
    return (
      buildLocalityLocationValue(country, "", "", breadcrumb.cityNameDefault) ||
      country
    );
  }
  if (
    normalizeGeoTranslationLookupValue(breadcrumb.cityNameDefault) ===
      unknown ||
    normalizeGeoTranslationLookupValue(breadcrumb.regionLabel) === unknown ||
    normalizeGeoTranslationLookupValue(breadcrumb.countryCode) === unknown
  ) {
    return null;
  }
  return (
    buildLocalityLocationValue(
      breadcrumb.countryCode,
      breadcrumb.stateCode,
      breadcrumb.regionLabel,
      breadcrumb.cityNameDefault,
    ) || null
  );
}
export function resolveGeoDimensionRowRawValue(item: {
  label?: string;
  value?: string;
}): string {
  const rawValue = typeof item.value === "string" ? item.value.trim() : "";
  if (rawValue) return rawValue;
  return String(item.label || "").trim();
}
