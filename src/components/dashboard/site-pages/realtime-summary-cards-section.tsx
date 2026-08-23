import { useMemo } from "react";

import {
  OverviewPagesSection,
  type OverviewPagesSectionCardData,
} from "@/components/dashboard/site-pages/overview-client-page";
import type { OverviewTabRows } from "@/lib/dashboard/client-data";
import { dashboardFilterPresentation } from "@/lib/dashboard/filter-state";
import {
  buildLocalityLocationValue,
  buildRegionLocationValue,
  parseGeoLocationValue,
} from "@/lib/dashboard/geo-location";
import { parseFilterDocumentFromSearchParams } from "@/lib/dashboard/query-state";
import type { FilterDocument } from "@/lib/filter-contract";
import type { Locale } from "@/lib/i18n/config";
import type { AppMessages } from "@/lib/i18n/messages";
import type { RealtimeVisit } from "@/lib/realtime/types";

const DIRECT_REFERRER_FILTER_VALUE = "__direct__";

interface RealtimeSummaryCardsSectionProps {
  locale: Locale;
  messages: AppMessages;
  siteId: string;
  siteDomain: string;
  visits: RealtimeVisit[];
  filters: FilterDocument;
}

interface SessionBoundary {
  entryPath: string;
  exitPath: string;
  visitorId: string;
}

function equalsTrimmed(left: string, right: string): boolean {
  return left.trim() === right.trim();
}

function equalsCaseInsensitive(left: string, right: string): boolean {
  return left.trim().toLowerCase() === right.trim().toLowerCase();
}

function sessionKeyOf(visit: RealtimeVisit): string {
  return (
    visit.sessionId.trim() || visit.visitId.trim() || visit.visitorId.trim()
  );
}

function compareVisitStart(left: RealtimeVisit, right: RealtimeVisit): number {
  if (left.startedAt !== right.startedAt) {
    return left.startedAt - right.startedAt;
  }
  return left.visitId.localeCompare(right.visitId);
}

function compareVisitEnd(left: RealtimeVisit, right: RealtimeVisit): number {
  if (left.lastActivityAt !== right.lastActivityAt) {
    return right.lastActivityAt - left.lastActivityAt;
  }
  return left.visitId.localeCompare(right.visitId);
}

function buildSessionBoundaries(
  visits: RealtimeVisit[],
): Map<string, SessionBoundary> {
  const boundaryBySession = new Map<
    string,
    {
      entryVisit: RealtimeVisit;
      exitVisit: RealtimeVisit;
    }
  >();

  for (const visit of visits) {
    const sessionKey = sessionKeyOf(visit);
    const existing = boundaryBySession.get(sessionKey);
    if (!existing) {
      boundaryBySession.set(sessionKey, {
        entryVisit: visit,
        exitVisit: visit,
      });
      continue;
    }

    if (compareVisitStart(visit, existing.entryVisit) < 0) {
      existing.entryVisit = visit;
    }
    if (compareVisitEnd(visit, existing.exitVisit) < 0) {
      existing.exitVisit = visit;
    }
  }

  return new Map(
    Array.from(boundaryBySession.entries()).map(([key, value]) => [
      key,
      {
        entryPath: value.entryVisit.pathname.trim() || "/",
        exitPath: value.exitVisit.pathname.trim() || "/",
        visitorId: value.entryVisit.visitorId.trim(),
      },
    ]),
  );
}

function resolveParsedRegionValue(value: string | null | undefined): string {
  const parsed = parseGeoLocationValue(value);
  if (!parsed?.regionCode && !parsed?.regionName) return "";
  return buildRegionLocationValue(
    parsed.countryCode,
    parsed.regionCode ?? parsed.regionName ?? "",
    parsed.regionName ?? parsed.regionCode ?? "",
  );
}

function resolveParsedLocalityValue(value: string | null | undefined): string {
  const parsed = parseGeoLocationValue(value);
  if (parsed?.level !== "locality" || !parsed.localityName) return "";
  return buildLocalityLocationValue(
    parsed.countryCode,
    parsed.regionCode ?? parsed.regionName ?? "",
    parsed.regionName ?? parsed.regionCode ?? "",
    parsed.localityName,
  );
}

function resolveVisitRegionValue(visit: RealtimeVisit): string {
  const encodedRegion = resolveParsedRegionValue(visit.region);
  if (encodedRegion) return encodedRegion;

  const encodedCityRegion = resolveParsedRegionValue(visit.city);
  if (encodedCityRegion) return encodedCityRegion;

  const country = visit.country.trim().toUpperCase();
  if (!country) return "";
  return buildRegionLocationValue(country, visit.regionCode, visit.region);
}

function resolveVisitCityValue(visit: RealtimeVisit): string {
  const encodedCity = resolveParsedLocalityValue(visit.city);
  if (encodedCity) return encodedCity;

  const country = visit.country.trim().toUpperCase();
  if (!country) return "";
  return buildLocalityLocationValue(
    country,
    visit.regionCode,
    visit.region,
    visit.city,
  );
}

function matchesSourceLink(
  referrerUrl: string,
  referrerHost: string,
  filterValue: string,
): boolean {
  if (filterValue === DIRECT_REFERRER_FILTER_VALUE) {
    return !referrerUrl.trim() && !referrerHost.trim();
  }

  if (
    equalsCaseInsensitive(referrerUrl, filterValue) ||
    equalsCaseInsensitive(referrerHost, filterValue)
  ) {
    return true;
  }

  try {
    const hostname = new URL(filterValue).hostname;
    return equalsCaseInsensitive(referrerHost, hostname);
  } catch {
    return false;
  }
}

function matchesGeoFilter(visit: RealtimeVisit, filterValue: string): boolean {
  const parsedFilter = parseGeoLocationValue(filterValue);
  if (!parsedFilter) return false;

  if (parsedFilter.level === "country") {
    return equalsCaseInsensitive(visit.country, parsedFilter.countryCode);
  }

  if (parsedFilter.level === "region") {
    return equalsCaseInsensitive(
      resolveVisitRegionValue(visit),
      parsedFilter.canonical,
    );
  }

  if (!parsedFilter.regionCode && !parsedFilter.regionName) {
    return (
      equalsCaseInsensitive(visit.country, parsedFilter.countryCode) &&
      equalsCaseInsensitive(visit.city, parsedFilter.localityName ?? "")
    );
  }

  return equalsCaseInsensitive(
    resolveVisitCityValue(visit),
    parsedFilter.canonical,
  );
}

function filterRealtimeVisits(
  visits: RealtimeVisit[],
  document: FilterDocument,
  sessionBoundaries: Map<string, SessionBoundary>,
): RealtimeVisit[] {
  const filters = dashboardFilterPresentation(document);
  return visits.filter((visit) => {
    const sessionBoundary = sessionBoundaries.get(sessionKeyOf(visit));

    if (filters.country && !equalsTrimmed(visit.country, filters.country)) {
      return false;
    }
    if (filters.device && !equalsTrimmed(visit.deviceType, filters.device)) {
      return false;
    }
    if (filters.browser && !equalsTrimmed(visit.browser, filters.browser)) {
      return false;
    }
    if (filters.path && !equalsTrimmed(visit.pathname, filters.path)) {
      return false;
    }
    if (filters.title && !equalsTrimmed(visit.title, filters.title)) {
      return false;
    }
    if (filters.hostname && !equalsTrimmed(visit.hostname, filters.hostname)) {
      return false;
    }
    if (
      filters.entry &&
      !equalsTrimmed(sessionBoundary?.entryPath ?? "", filters.entry)
    ) {
      return false;
    }
    if (
      filters.exit &&
      !equalsTrimmed(sessionBoundary?.exitPath ?? "", filters.exit)
    ) {
      return false;
    }
    if (filters.sourceDomain) {
      if (filters.sourceDomain === DIRECT_REFERRER_FILTER_VALUE) {
        if (visit.referrerHost.trim()) {
          return false;
        }
      } else if (
        !equalsCaseInsensitive(visit.referrerHost, filters.sourceDomain)
      ) {
        return false;
      }
    }
    if (
      filters.sourceLink &&
      !matchesSourceLink(
        visit.referrerUrl,
        visit.referrerHost,
        filters.sourceLink,
      )
    ) {
      return false;
    }
    if (
      filters.clientBrowser &&
      !equalsTrimmed(visit.browser, filters.clientBrowser)
    ) {
      return false;
    }
    if (
      filters.clientOsVersion &&
      !equalsTrimmed(visit.osVersion, filters.clientOsVersion)
    ) {
      return false;
    }
    if (
      filters.clientDeviceType &&
      !equalsTrimmed(visit.deviceType, filters.clientDeviceType)
    ) {
      return false;
    }
    if (
      filters.clientLanguage &&
      !equalsTrimmed(visit.language, filters.clientLanguage)
    ) {
      return false;
    }
    if (
      filters.clientScreenSize &&
      !equalsTrimmed(visit.screenSize, filters.clientScreenSize)
    ) {
      return false;
    }
    if (filters.geo && !matchesGeoFilter(visit, filters.geo)) {
      return false;
    }
    if (
      filters.geoContinent &&
      !equalsTrimmed(visit.continent, filters.geoContinent)
    ) {
      return false;
    }
    if (
      filters.geoTimezone &&
      !equalsTrimmed(visit.timezone, filters.geoTimezone)
    ) {
      return false;
    }
    if (
      filters.geoOrganization &&
      !equalsTrimmed(visit.organization, filters.geoOrganization)
    ) {
      return false;
    }
    return true;
  });
}

interface VisitDimensionSpec {
  key: string;
  getValue: (visit: RealtimeVisit) => string;
  emptyLabel: string;
  emptyKey?: string;
  resolveLabel?: (value: string) => string;
}

interface VisitDimensionBucket {
  label: string;
  views: number;
  sessionIds: Set<string>;
  visitorIds: Set<string>;
}

function finalizeVisitDimensionBuckets(
  buckets: Map<string, VisitDimensionBucket>,
): OverviewTabRows {
  return Array.from(buckets.entries())
    .map(([key, bucket]) => ({
      label: bucket.label || key,
      views: bucket.views,
      sessions: bucket.sessionIds.size,
      visitors: bucket.visitorIds.size,
    }))
    .sort((left, right) => {
      if (right.views !== left.views) return right.views - left.views;
      if (right.sessions !== left.sessions)
        return right.sessions - left.sessions;
      return left.label.localeCompare(right.label);
    });
}

function aggregateVisitDimensions(
  visits: RealtimeVisit[],
  specs: readonly VisitDimensionSpec[],
): Record<string, OverviewTabRows> {
  const bucketsByDimension = new Map<
    string,
    Map<string, VisitDimensionBucket>
  >();
  for (const spec of specs) {
    bucketsByDimension.set(spec.key, new Map());
  }

  for (const visit of visits) {
    const sessionKey = sessionKeyOf(visit);
    const visitorId = visit.visitorId.trim();

    for (const spec of specs) {
      const value = spec.getValue(visit).trim();
      const key = value || spec.emptyKey || "__empty__";
      const buckets = bucketsByDimension.get(spec.key);
      if (!buckets) continue;

      const bucket = buckets.get(key) ?? {
        label: value,
        views: 0,
        sessionIds: new Set<string>(),
        visitorIds: new Set<string>(),
      };
      bucket.label = spec.resolveLabel
        ? spec.resolveLabel(value)
        : value || spec.emptyLabel;
      bucket.views += 1;
      bucket.sessionIds.add(sessionKey);
      if (visitorId) bucket.visitorIds.add(visitorId);
      buckets.set(key, bucket);
    }
  }

  return Object.fromEntries(
    specs.map((spec) => [
      spec.key,
      finalizeVisitDimensionBuckets(
        bucketsByDimension.get(spec.key) ?? new Map(),
      ),
    ]),
  );
}

function aggregateSessionBoundaryRows(
  sessionKeys: Iterable<string>,
  sessionBoundaries: Map<string, SessionBoundary>,
  getValue: (boundary: SessionBoundary) => string,
  options: {
    emptyLabel: string;
    emptyKey?: string;
    resolveLabel?: (value: string) => string;
  },
): OverviewTabRows {
  const buckets = new Map<
    string,
    {
      label: string;
      views: number;
      sessionIds: Set<string>;
      visitorIds: Set<string>;
    }
  >();

  for (const sessionKey of sessionKeys) {
    const boundary = sessionBoundaries.get(sessionKey);
    if (!boundary) continue;

    const value = getValue(boundary).trim();
    const key = value || options.emptyKey || "__empty__";
    const bucket = buckets.get(key) ?? {
      label: value,
      views: 0,
      sessionIds: new Set<string>(),
      visitorIds: new Set<string>(),
    };

    bucket.label = options.resolveLabel
      ? options.resolveLabel(value)
      : value || options.emptyLabel;
    bucket.views += 1;
    bucket.sessionIds.add(sessionKey);
    const visitorId = boundary.visitorId;
    if (visitorId) bucket.visitorIds.add(visitorId);
    buckets.set(key, bucket);
  }

  return Array.from(buckets.values())
    .map((bucket) => ({
      label: bucket.label,
      views: bucket.views,
      sessions: bucket.sessionIds.size,
      visitors: bucket.visitorIds.size,
    }))
    .sort((left, right) => {
      if (right.views !== left.views) return right.views - left.views;
      if (right.sessions !== left.sessions)
        return right.sessions - left.sessions;
      return left.label.localeCompare(right.label);
    });
}

function buildCardData(
  visits: RealtimeVisit[],
  messages: AppMessages,
): OverviewPagesSectionCardData {
  const sessionBoundaries = buildSessionBoundaries(visits);
  const filteredSessionKeys = new Set(
    visits.map((visit) => sessionKeyOf(visit)),
  );
  const aggregated = aggregateVisitDimensions(visits, [
    {
      key: "path",
      getValue: (visit) => visit.pathname,
      emptyLabel: "/",
      resolveLabel: (value) => value || "/",
    },
    {
      key: "title",
      getValue: (visit) => visit.title,
      emptyLabel: messages.common.unknown,
    },
    {
      key: "hostname",
      getValue: (visit) => visit.hostname,
      emptyLabel: messages.common.unknown,
    },
    {
      key: "domain",
      getValue: (visit) => visit.referrerHost,
      emptyLabel: messages.overview.direct,
      emptyKey: DIRECT_REFERRER_FILTER_VALUE,
      resolveLabel: (value) => value || messages.overview.direct,
    },
    {
      key: "link",
      getValue: (visit) => visit.referrerUrl,
      emptyLabel: messages.overview.direct,
      emptyKey: DIRECT_REFERRER_FILTER_VALUE,
      resolveLabel: (value) => value || messages.overview.direct,
    },
    {
      key: "browser",
      getValue: (visit) => visit.browser,
      emptyLabel: messages.common.unknown,
    },
    {
      key: "osVersion",
      getValue: (visit) => visit.osVersion,
      emptyLabel: messages.common.unknown,
    },
    {
      key: "deviceType",
      getValue: (visit) => visit.deviceType,
      emptyLabel: messages.common.unknown,
    },
    {
      key: "language",
      getValue: (visit) => visit.language,
      emptyLabel: messages.common.unknown,
    },
    {
      key: "screenSize",
      getValue: (visit) => visit.screenSize,
      emptyLabel: messages.common.unknown,
    },
    {
      key: "country",
      getValue: (visit) => visit.country,
      emptyLabel: messages.common.unknown,
    },
    {
      key: "region",
      getValue: resolveVisitRegionValue,
      emptyLabel: messages.common.unknown,
    },
    {
      key: "city",
      getValue: resolveVisitCityValue,
      emptyLabel: messages.common.unknown,
    },
    {
      key: "continent",
      getValue: (visit) => visit.continent,
      emptyLabel: messages.common.unknown,
    },
    {
      key: "timezone",
      getValue: (visit) => visit.timezone,
      emptyLabel: messages.common.unknown,
    },
    {
      key: "organization",
      getValue: (visit) => visit.organization,
      emptyLabel: messages.common.unknown,
    },
  ]);

  return {
    page: {
      path: aggregated.path,
      query: [],
      title: aggregated.title,
      hostname: aggregated.hostname,
      entry: aggregateSessionBoundaryRows(
        filteredSessionKeys,
        sessionBoundaries,
        (boundary) => boundary.entryPath,
        {
          emptyLabel: "/",
          resolveLabel: (value) => value || "/",
        },
      ),
      exit: aggregateSessionBoundaryRows(
        filteredSessionKeys,
        sessionBoundaries,
        (boundary) => boundary.exitPath,
        {
          emptyLabel: "/",
          resolveLabel: (value) => value || "/",
        },
      ),
    },
    source: {
      domain: aggregated.domain,
      link: aggregated.link,
    },
    client: {
      browser: aggregated.browser,
      osVersion: aggregated.osVersion,
      deviceType: aggregated.deviceType,
      language: aggregated.language,
      screenSize: aggregated.screenSize,
    },
    geo: {
      country: aggregated.country,
      region: aggregated.region,
      city: aggregated.city,
      continent: aggregated.continent,
      timezone: aggregated.timezone,
      organization: aggregated.organization,
    },
  };
}

export function RealtimeSummaryCardsSection({
  locale,
  messages,
  siteId,
  siteDomain,
  visits,
  filters,
}: RealtimeSummaryCardsSectionProps) {
  const sessionBoundaries = useMemo(
    () => buildSessionBoundaries(visits),
    [visits],
  );
  const filteredVisits = useMemo(
    () => filterRealtimeVisits(visits, filters, sessionBoundaries),
    [filters, sessionBoundaries, visits],
  );
  const cardDataOverride = useMemo(
    () => buildCardData(filteredVisits, messages),
    [filteredVisits, messages],
  );

  return (
    <OverviewPagesSection
      locale={locale}
      messages={messages}
      siteId={siteId}
      siteDomain={siteDomain}
      pathname=""
      filters={filters}
      cardDataOverride={cardDataOverride}
    />
  );
}

export function parseRealtimeCardFilters(
  searchParams: URLSearchParams,
): FilterDocument {
  return parseFilterDocumentFromSearchParams(searchParams);
}
