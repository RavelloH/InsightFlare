import {
  generateDemoDimension,
  generateDemoOverview,
  generateDemoPages,
  generateDemoPerformance,
  generateDemoReferrers,
  generateDemoReferrerSummary,
  generateDemoTrend,
} from "@/lib/demo/analytics";
import { findSiteProfileByPublicSlug } from "@/lib/demo/data/site-profiles";
import {
  generateDemoBrowserCrossBreakdown,
  generateDemoBrowserRadar,
  generateDemoBrowserVersionBreakdown,
  generateDemoClientCrossBreakdown,
  generateDemoReferrerRadar,
} from "@/lib/demo/realtime/browser-client";
import { parseDemoInterval } from "@/lib/demo/realtime/filters";
import {
  generateDemoBrowserEngineTrend,
  generateDemoBrowserTrend,
  generateDemoChannelTrend,
  generateDemoClientDimensionTrend,
  generateDemoReferrerTrend,
} from "@/lib/demo/realtime/share-trends";
import {
  generateDemoFilterValues,
  generateDemoGeoPoints,
  generateDemoOverviewClientTab,
  generateDemoOverviewGeoTab,
} from "@/lib/demo/realtime/utm-overview";

import type { DemoRuntimeContext } from "./context";
import {
  demoNotFoundResponse,
  demoShareTrendDimension,
  paginateDemoEnvelope,
} from "./shared";
export function handleDemoPublicSiteRoute(
  context: DemoRuntimeContext,
): unknown | undefined {
  const { path, publicSiteProfile } = context;
  const publicSiteMatch = path.match(/\/api\/public\/share\/([^/]+)\/site$/);
  if (publicSiteMatch) {
    const slug = decodeURIComponent(publicSiteMatch[1] || "demo-site");
    const profile = publicSiteProfile ?? findSiteProfileByPublicSlug(slug);
    if (!profile) return demoNotFoundResponse();
    return {
      ok: true,
      data: {
        id: profile.id,
        slug,
        name: profile.name,
        domain: profile.domain,
      },
    };
  }
  return undefined;
}
export function handleDemoPublicRoutes(
  context: DemoRuntimeContext,
): unknown | undefined {
  const { path, params, siteId, publicSiteProfile } = context;
  // Public routes — delegate to same generators
  const publicMatch = path.match(/\/api\/public\/share\/[^/]+\/(.*)/);
  if (publicMatch) {
    if (!publicSiteProfile) return demoNotFoundResponse();
    const subPath = publicMatch[1];
    if (subPath === "overview") return generateDemoOverview(siteId, params);
    if (subPath === "trend") return generateDemoTrend(siteId, params);
    if (subPath === "pages")
      return generateDemoPages(siteId, params, {
        includeTabs: false,
        defaultLimit: 20,
      });
    if (subPath === "referrers")
      return generateDemoReferrers(siteId, params, {
        allowFullUrl: false,
        defaultLimit: 8,
      });
    if (subPath === "referrer-summary")
      return generateDemoReferrerSummary(siteId, params);
    if (subPath === "performance")
      return generateDemoPerformance(siteId, params);
    if (subPath === "countries")
      return generateDemoDimension(siteId, "countries", params);
    if (subPath === "filter-values")
      return generateDemoFilterValues(siteId, params, "public-share");
    if (subPath === "overview-geo-points")
      return generateDemoGeoPoints(siteId, params);
    if (subPath.startsWith("overview-client-")) {
      if (subPath === "overview-client-browser") {
        return generateDemoOverviewClientTab(siteId, params, "browser");
      }
      if (subPath === "overview-client-os-version") {
        return generateDemoOverviewClientTab(siteId, params, "osVersion");
      }
      if (subPath === "overview-client-device-type") {
        return generateDemoOverviewClientTab(siteId, params, "deviceType");
      }
      if (subPath === "overview-client-language") {
        return generateDemoOverviewClientTab(siteId, params, "language");
      }
      if (subPath === "overview-client-screen-size") {
        return generateDemoOverviewClientTab(siteId, params, "screenSize");
      }
    }
    if (subPath.startsWith("overview-geo-")) {
      const tab = subPath.replace("overview-geo-", "");
      if (
        tab === "country" ||
        tab === "region" ||
        tab === "city" ||
        tab === "continent" ||
        tab === "timezone" ||
        tab === "organization"
      ) {
        return paginateDemoEnvelope(
          generateDemoOverviewGeoTab(siteId, params, tab),
          params,
          100,
          `overview-geo-${tab}`,
        );
      }
    }
    if (subPath === "browser-trend")
      return generateDemoBrowserTrend(siteId, params);
    if (subPath === "browser-engine-trend")
      return generateDemoBrowserEngineTrend(siteId, params);
    if (subPath === "browser-version-breakdown")
      return generateDemoBrowserVersionBreakdown(siteId, params);
    if (subPath === "browser-cross-breakdown")
      return generateDemoBrowserCrossBreakdown(siteId, params);
    if (subPath === "browser-radar")
      return generateDemoBrowserRadar(siteId, params);
    if (subPath === "referrer-radar")
      return generateDemoReferrerRadar(siteId, params);
    if (subPath === "referrer-channel-dimension-trend")
      return {
        ok: true,
        interval: parseDemoInterval(params.interval),
        source: demoShareTrendDimension(
          generateDemoReferrerTrend(siteId, params, { maxLimit: 12 }),
        ),
        channel: demoShareTrendDimension(
          generateDemoChannelTrend(siteId, params, { maxLimit: 12 }),
        ),
      };
    if (subPath === "referrer-dimension-trend")
      return generateDemoReferrerTrend(siteId, params);
    if (subPath === "client-dimension-trend")
      return generateDemoClientDimensionTrend(siteId, params);
    if (subPath === "client-cross-breakdown")
      return generateDemoClientCrossBreakdown(siteId, params);
    return demoNotFoundResponse();
  }
  return undefined;
}
