import {
  classifyTrafficChannel,
  type TrafficChannelId,
} from "@/lib/analytics/traffic-channel-rules";
import {
  DEMO_DIRECT_REFERRER_FILTER_VALUE,
  parseDemoGeoFilterValue,
} from "@/lib/realtime/mock/filters";
import type {
  DemoFactDataset,
  DemoFilteredFacts,
  DemoQueryFilters,
} from "@/lib/realtime/mock/types";
import { demoQueryStringForVisit } from "@/lib/realtime/mock/visit-helpers";

export function applyDemoFilters(
  dataset: DemoFactDataset,
  filters: DemoQueryFilters,
): DemoFilteredFacts {
  const result: DemoFilteredFacts = {
    visits: [],
    sessions: new Set<string>(),
    visitors: new Set<string>(),
    visitsBySession: new Map<string, number>(),
  };
  const parsedGeo = parseDemoGeoFilterValue(filters.geo);
  const regionTokens = new Set(
    [parsedGeo?.regionCode, parsedGeo?.regionName]
      .map((value) =>
        String(value ?? "")
          .trim()
          .toUpperCase(),
      )
      .filter(Boolean),
  );
  const equalsTrimmed = (left: string, right: string) => left.trim() === right;
  const equalsCaseInsensitive = (left: string, right: string) =>
    left.trim().toLowerCase() === right.toLowerCase();
  const channel = filters.channel?.trim().toLowerCase() as
    | TrafficChannelId
    | undefined;

  for (const visit of dataset.visits) {
    if (
      channel &&
      classifyTrafficChannel({
        referrerHost: visit.referrerHost,
        utmSource: visit.utmSource,
        utmMedium: visit.utmMedium,
        utmCampaign: visit.utmCampaign,
      }) !== channel
    )
      continue;
    if (
      filters.country &&
      !equalsCaseInsensitive(visit.country, filters.country)
    )
      continue;
    if (filters.device && !equalsTrimmed(visit.deviceType, filters.device))
      continue;
    if (filters.browser && !equalsTrimmed(visit.browser, filters.browser))
      continue;
    if (filters.path && !equalsTrimmed(visit.pathname, filters.path)) continue;
    if (
      filters.query &&
      !equalsTrimmed(demoQueryStringForVisit(visit), filters.query)
    )
      continue;
    if (filters.title && !equalsTrimmed(visit.title, filters.title)) continue;
    if (
      filters.hostname &&
      !equalsCaseInsensitive(visit.hostname, filters.hostname)
    )
      continue;

    if (filters.entry) {
      const session = dataset.sessions.get(visit.sessionId);
      if (!session || !equalsTrimmed(session.entryPath, filters.entry))
        continue;
    }
    if (filters.exit) {
      const session = dataset.sessions.get(visit.sessionId);
      if (!session || !equalsTrimmed(session.exitPath, filters.exit)) continue;
    }

    if (filters.sourceDomain) {
      if (filters.sourceDomain === DEMO_DIRECT_REFERRER_FILTER_VALUE) {
        if (visit.referrerHost.trim()) continue;
      } else if (
        !equalsCaseInsensitive(visit.referrerHost, filters.sourceDomain)
      ) {
        continue;
      }
    }
    if (filters.sourceLink) {
      if (filters.sourceLink === DEMO_DIRECT_REFERRER_FILTER_VALUE) {
        if (visit.referrerUrl.trim()) continue;
      } else {
        let sourceLinkMatch =
          equalsCaseInsensitive(visit.referrerUrl, filters.sourceLink) ||
          equalsCaseInsensitive(visit.referrerHost, filters.sourceLink);
        if (!sourceLinkMatch) {
          try {
            const hostname = new URL(filters.sourceLink).hostname;
            sourceLinkMatch = equalsCaseInsensitive(
              visit.referrerHost,
              hostname,
            );
          } catch {
            // ignore invalid URL parse and keep fallback matching result
          }
        }
        if (!sourceLinkMatch) continue;
      }
    }

    if (
      filters.clientBrowser &&
      !equalsTrimmed(visit.browser, filters.clientBrowser)
    )
      continue;
    if (
      filters.clientOsVersion &&
      !equalsTrimmed(visit.osVersion, filters.clientOsVersion)
    )
      continue;
    if (
      filters.clientDeviceType &&
      !equalsTrimmed(visit.deviceType, filters.clientDeviceType)
    )
      continue;
    if (
      filters.clientLanguage &&
      !equalsTrimmed(visit.language, filters.clientLanguage)
    )
      continue;
    if (
      filters.clientScreenSize &&
      !equalsTrimmed(visit.screenSize, filters.clientScreenSize)
    )
      continue;
    if (
      filters.geoContinent &&
      !equalsTrimmed(visit.continent, filters.geoContinent)
    )
      continue;
    if (
      filters.geoTimezone &&
      !equalsTrimmed(visit.timezone, filters.geoTimezone)
    )
      continue;
    if (
      filters.geoOrganization &&
      !equalsTrimmed(visit.organization, filters.geoOrganization)
    )
      continue;

    if (
      parsedGeo?.country &&
      !equalsCaseInsensitive(visit.country, parsedGeo.country)
    )
      continue;
    if (regionTokens.size > 0) {
      const visitRegionTokens = [visit.regionCode, visit.regionName]
        .map((value) => value.trim().toUpperCase())
        .filter(Boolean);
      if (!visitRegionTokens.some((token) => regionTokens.has(token))) continue;
    }
    if (
      parsedGeo?.city &&
      !equalsCaseInsensitive(visit.cityName, parsedGeo.city)
    )
      continue;

    result.visits.push(visit);
    result.sessions.add(visit.sessionId);
    result.visitors.add(visit.visitorId);
    result.visitsBySession.set(
      visit.sessionId,
      (result.visitsBySession.get(visit.sessionId) ?? 0) + 1,
    );
  }

  return result;
}
