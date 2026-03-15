"use client";

import { useMemo } from "react";
import {
  OverviewPagesSection,
  type OverviewPagesSectionCardData,
} from "@/components/dashboard/site-pages/overview-client-page";
import type { OverviewTabRows } from "@/lib/dashboard/client-data";
import type { DashboardFilters } from "@/lib/dashboard/query-state";
import type { Locale } from "@/lib/i18n/config";
import type { AppMessages } from "@/lib/i18n/messages";
import type { RealtimeVisit } from "@/lib/realtime/types";

const DIRECT_REFERRER_FILTER_VALUE = "__direct__";
const GEO_VALUE_SEPARATOR = "::";

interface RealtimeSummaryCardsSectionProps {
  locale: Locale;
  messages: AppMessages;
  siteId: string;
  visits: RealtimeVisit[];
  filters: DashboardFilters;
}

interface SessionBoundary {
  entryPath: string;
  exitPath: string;
}

function normalizeRealtimeFilterValue(
  value: string | null | undefined,
): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim().slice(0, 160);
  return normalized.length > 0 ? normalized : undefined;
}

function equalsTrimmed(left: string, right: string): boolean {
  return left.trim() === right.trim();
}

function equalsCaseInsensitive(left: string, right: string): boolean {
  return left.trim().toLowerCase() === right.trim().toLowerCase();
}

function sessionKeyOf(visit: RealtimeVisit): string {
  return visit.sessionId.trim() || visit.visitId.trim() || visit.visitorId.trim();
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
  const boundaryBySession = new Map<string, {
    entryVisit: RealtimeVisit;
    exitVisit: RealtimeVisit;
  }>();

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
      },
    ]),
  );
}

function normalizeGeoFilterValue(value: string | null | undefined): string | null {
  const normalized = String(value ?? "").trim();
  if (!normalized) return null;
  const segments = normalized
    .split(GEO_VALUE_SEPARATOR)
    .map((segment) => segment.trim())
    .filter((segment) => segment.length > 0);
  if (segments.length === 0) return null;
  const country = segments[0]?.toUpperCase();
  if (!country) return null;
  return [country, ...segments.slice(1)].join(GEO_VALUE_SEPARATOR);
}

function resolveVisitRegionValue(visit: RealtimeVisit): string {
  const encoded = normalizeGeoFilterValue(visit.region);
  if (encoded) {
    const segments = encoded.split(GEO_VALUE_SEPARATOR);
    if (segments.length >= 3) {
      return [
        segments[0] || "",
        segments[1] || "",
        segments.slice(2).join(GEO_VALUE_SEPARATOR).trim(),
      ].join(GEO_VALUE_SEPARATOR);
    }
  }

  const country = visit.country.trim().toUpperCase();
  const regionCode = visit.regionCode.trim();
  const region = visit.region.trim();
  if (!country && !regionCode && !region) return "";
  return [
    country,
    regionCode || region,
    region,
  ].join(GEO_VALUE_SEPARATOR);
}

function resolveVisitCityValue(visit: RealtimeVisit): string {
  const encoded = normalizeGeoFilterValue(visit.city);
  if (encoded) {
    const segments = encoded.split(GEO_VALUE_SEPARATOR);
    if (segments.length >= 4) {
      return [
        segments[0] || "",
        segments[1] || "",
        segments[2] || "",
        segments.slice(3).join(GEO_VALUE_SEPARATOR).trim(),
      ].join(GEO_VALUE_SEPARATOR);
    }
  }

  const country = visit.country.trim().toUpperCase();
  const regionCode = visit.regionCode.trim();
  const region = visit.region.trim();
  const city = visit.city.trim();
  if (!country && !regionCode && !region && !city) return "";
  return [
    country,
    regionCode || region,
    region,
    city,
  ].join(GEO_VALUE_SEPARATOR);
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
    equalsCaseInsensitive(referrerUrl, filterValue)
    || equalsCaseInsensitive(referrerHost, filterValue)
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
  const normalized = normalizeGeoFilterValue(filterValue);
  if (!normalized) return false;

  const segments = normalized.split(GEO_VALUE_SEPARATOR);
  if (segments.length === 1) {
    return equalsCaseInsensitive(visit.country, segments[0] || "");
  }
  if (segments.length === 2 || segments.length === 3) {
    return equalsCaseInsensitive(resolveVisitRegionValue(visit), normalized);
  }
  if (segments.length >= 4) {
    return equalsCaseInsensitive(resolveVisitCityValue(visit), normalized);
  }

  return (
    equalsTrimmed(visit.country, filterValue)
    || equalsTrimmed(visit.region, filterValue)
    || equalsTrimmed(visit.city, filterValue)
  );
}

function filterRealtimeVisits(
  visits: RealtimeVisit[],
  filters: DashboardFilters,
  sessionBoundaries: Map<string, SessionBoundary>,
): RealtimeVisit[] {
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
    if (filters.entry && !equalsTrimmed(sessionBoundary?.entryPath ?? "", filters.entry)) {
      return false;
    }
    if (filters.exit && !equalsTrimmed(sessionBoundary?.exitPath ?? "", filters.exit)) {
      return false;
    }
    if (filters.sourceDomain) {
      if (filters.sourceDomain === DIRECT_REFERRER_FILTER_VALUE) {
        if (visit.referrerHost.trim()) {
          return false;
        }
      } else if (!equalsCaseInsensitive(visit.referrerHost, filters.sourceDomain)) {
        return false;
      }
    }
    if (filters.sourceLink && !matchesSourceLink(
      visit.referrerUrl,
      visit.referrerHost,
      filters.sourceLink,
    )) {
      return false;
    }
    if (
      filters.clientBrowser
      && !equalsTrimmed(visit.browser, filters.clientBrowser)
    ) {
      return false;
    }
    if (
      filters.clientOsVersion
      && !equalsTrimmed(visit.osVersion, filters.clientOsVersion)
    ) {
      return false;
    }
    if (
      filters.clientDeviceType
      && !equalsTrimmed(visit.deviceType, filters.clientDeviceType)
    ) {
      return false;
    }
    if (
      filters.clientLanguage
      && !equalsTrimmed(visit.language, filters.clientLanguage)
    ) {
      return false;
    }
    if (
      filters.clientScreenSize
      && !equalsTrimmed(visit.screenSize, filters.clientScreenSize)
    ) {
      return false;
    }
    if (filters.geo && !matchesGeoFilter(visit, filters.geo)) {
      return false;
    }
    if (
      filters.geoContinent
      && !equalsTrimmed(visit.continent, filters.geoContinent)
    ) {
      return false;
    }
    if (
      filters.geoTimezone
      && !equalsTrimmed(visit.timezone, filters.geoTimezone)
    ) {
      return false;
    }
    if (
      filters.geoOrganization
      && !equalsTrimmed(visit.organization, filters.geoOrganization)
    ) {
      return false;
    }
    return true;
  });
}

function aggregateVisitRows(
  visits: RealtimeVisit[],
  getValue: (visit: RealtimeVisit) => string,
  options: {
    emptyLabel: string;
    emptyKey?: string;
    resolveLabel?: (value: string) => string;
  },
): OverviewTabRows {
  const buckets = new Map<string, {
    label: string;
    views: number;
    sessionIds: Set<string>;
  }>();

  for (const visit of visits) {
    const value = getValue(visit).trim();
    const key = value || options.emptyKey || "__empty__";
    const bucket = buckets.get(key) ?? {
      label: value,
      views: 0,
      sessionIds: new Set<string>(),
    };

    bucket.label = options.resolveLabel
      ? options.resolveLabel(value)
      : (value || options.emptyLabel);
    bucket.views += 1;
    bucket.sessionIds.add(sessionKeyOf(visit));
    buckets.set(key, bucket);
  }

  return Array.from(buckets.entries())
    .map(([key, bucket]) => ({
      label: bucket.label || key,
      views: bucket.views,
      sessions: bucket.sessionIds.size,
    }))
    .sort((left, right) => {
      if (right.views !== left.views) return right.views - left.views;
      if (right.sessions !== left.sessions) return right.sessions - left.sessions;
      return left.label.localeCompare(right.label);
    });
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
  const buckets = new Map<string, {
    label: string;
    views: number;
    sessionIds: Set<string>;
  }>();

  for (const sessionKey of sessionKeys) {
    const boundary = sessionBoundaries.get(sessionKey);
    if (!boundary) continue;

    const value = getValue(boundary).trim();
    const key = value || options.emptyKey || "__empty__";
    const bucket = buckets.get(key) ?? {
      label: value,
      views: 0,
      sessionIds: new Set<string>(),
    };

    bucket.label = options.resolveLabel
      ? options.resolveLabel(value)
      : (value || options.emptyLabel);
    bucket.views += 1;
    bucket.sessionIds.add(sessionKey);
    buckets.set(key, bucket);
  }

  return Array.from(buckets.values())
    .map((bucket) => ({
      label: bucket.label,
      views: bucket.views,
      sessions: bucket.sessionIds.size,
    }))
    .sort((left, right) => {
      if (right.views !== left.views) return right.views - left.views;
      if (right.sessions !== left.sessions) return right.sessions - left.sessions;
      return left.label.localeCompare(right.label);
    });
}

function buildCardData(
  visits: RealtimeVisit[],
  messages: AppMessages,
): OverviewPagesSectionCardData {
  const sessionBoundaries = buildSessionBoundaries(visits);
  const filteredSessionKeys = new Set(visits.map((visit) => sessionKeyOf(visit)));

  return {
    page: {
      path: aggregateVisitRows(visits, (visit) => visit.pathname, {
        emptyLabel: "/",
        resolveLabel: (value) => value || "/",
      }),
      title: aggregateVisitRows(visits, (visit) => visit.title, {
        emptyLabel: messages.common.unknown,
      }),
      hostname: aggregateVisitRows(visits, (visit) => visit.hostname, {
        emptyLabel: messages.common.unknown,
      }),
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
      domain: aggregateVisitRows(visits, (visit) => visit.referrerHost, {
        emptyLabel: messages.overview.direct,
        emptyKey: DIRECT_REFERRER_FILTER_VALUE,
        resolveLabel: (value) => value || messages.overview.direct,
      }),
      link: aggregateVisitRows(visits, (visit) => visit.referrerUrl, {
        emptyLabel: messages.overview.direct,
        emptyKey: DIRECT_REFERRER_FILTER_VALUE,
        resolveLabel: (value) => value || messages.overview.direct,
      }),
    },
    client: {
      browser: aggregateVisitRows(visits, (visit) => visit.browser, {
        emptyLabel: messages.common.unknown,
      }),
      osVersion: aggregateVisitRows(visits, (visit) => visit.osVersion, {
        emptyLabel: messages.common.unknown,
      }),
      deviceType: aggregateVisitRows(visits, (visit) => visit.deviceType, {
        emptyLabel: messages.common.unknown,
      }),
      language: aggregateVisitRows(visits, (visit) => visit.language, {
        emptyLabel: messages.common.unknown,
      }),
      screenSize: aggregateVisitRows(visits, (visit) => visit.screenSize, {
        emptyLabel: messages.common.unknown,
      }),
    },
    geo: {
      country: aggregateVisitRows(visits, (visit) => visit.country, {
        emptyLabel: messages.common.unknown,
      }),
      region: aggregateVisitRows(visits, (visit) => resolveVisitRegionValue(visit), {
        emptyLabel: messages.common.unknown,
      }),
      city: aggregateVisitRows(visits, (visit) => resolveVisitCityValue(visit), {
        emptyLabel: messages.common.unknown,
      }),
      continent: aggregateVisitRows(visits, (visit) => visit.continent, {
        emptyLabel: messages.common.unknown,
      }),
      timezone: aggregateVisitRows(visits, (visit) => visit.timezone, {
        emptyLabel: messages.common.unknown,
      }),
      organization: aggregateVisitRows(visits, (visit) => visit.organization, {
        emptyLabel: messages.common.unknown,
      }),
    },
  };
}

export function RealtimeSummaryCardsSection({
  locale,
  messages,
  siteId,
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
      pathname=""
      filters={filters}
      cardDataOverride={cardDataOverride}
    />
  );
}

export function parseRealtimeCardFilters(
  searchParams: URLSearchParams,
): DashboardFilters {
  return {
    country: normalizeRealtimeFilterValue(searchParams.get("country")),
    device: normalizeRealtimeFilterValue(searchParams.get("device")),
    browser: normalizeRealtimeFilterValue(searchParams.get("browser")),
    path: normalizeRealtimeFilterValue(searchParams.get("path")),
    title: normalizeRealtimeFilterValue(searchParams.get("title")),
    hostname: normalizeRealtimeFilterValue(searchParams.get("hostname")),
    entry: normalizeRealtimeFilterValue(searchParams.get("entry")),
    exit: normalizeRealtimeFilterValue(searchParams.get("exit")),
    sourceDomain: normalizeRealtimeFilterValue(searchParams.get("sourceDomain")),
    sourceLink: normalizeRealtimeFilterValue(searchParams.get("sourceLink")),
    clientBrowser: normalizeRealtimeFilterValue(searchParams.get("clientBrowser")),
    clientOsVersion: normalizeRealtimeFilterValue(
      searchParams.get("clientOsVersion"),
    ),
    clientDeviceType: normalizeRealtimeFilterValue(
      searchParams.get("clientDeviceType"),
    ),
    clientLanguage: normalizeRealtimeFilterValue(searchParams.get("clientLanguage")),
    clientScreenSize: normalizeRealtimeFilterValue(
      searchParams.get("clientScreenSize"),
    ),
    geo: normalizeRealtimeFilterValue(searchParams.get("geo")),
    geoContinent: normalizeRealtimeFilterValue(searchParams.get("geoContinent")),
    geoTimezone: normalizeRealtimeFilterValue(searchParams.get("geoTimezone")),
    geoOrganization: normalizeRealtimeFilterValue(
      searchParams.get("geoOrganization"),
    ),
  };
}
