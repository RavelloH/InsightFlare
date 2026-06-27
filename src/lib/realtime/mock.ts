import { normalizeTimeZone } from "@/lib/dashboard/time-zone";
import { findSiteProfileByPublicSlug } from "@/lib/realtime/demo-site-profiles";
import {
  generateDemoDoDiagnostic,
  generateDemoScheduledTasks,
  generateDemoSystemPerformance,
  getDemoMembers,
  getDemoScriptSnippet,
  getDemoSiteConfig,
  getDemoSites,
  getDemoTeams,
  getDemoUser,
} from "@/lib/realtime/mock/admin";
import {
  generateDemoDimension,
  generateDemoOverview,
  generateDemoPages,
  generateDemoPagesDashboard,
  generateDemoPerformance,
  generateDemoReferrers,
  generateDemoRetention,
  generateDemoTrend,
} from "@/lib/realtime/mock/analytics";
import {
  generateDemoBrowserCrossBreakdown,
  generateDemoBrowserRadar,
  generateDemoBrowserVersionBreakdown,
  generateDemoClientCrossBreakdown,
  generateDemoReferrerRadar,
} from "@/lib/realtime/mock/browser-client";
import {
  generateDemoEventRecordDetail,
  generateDemoEventsRecords,
  generateDemoEventsSummary,
  generateDemoEventsTrend,
  generateDemoEventTypeDetail,
  generateDemoEventTypeFieldValues,
} from "@/lib/realtime/mock/events";
import {
  createDemoFunnel,
  deleteDemoFunnel,
  generateDemoFunnels,
} from "@/lib/realtime/mock/funnels";
import {
  generateDemoSessionDetail,
  generateDemoSessions,
  generateDemoVisitorDetail,
  generateDemoVisitors,
} from "@/lib/realtime/mock/journeys";
import {
  generateDemoBrowserEngineTrend,
  generateDemoBrowserTrend,
  generateDemoClientDimensionTrend,
  generateDemoReferrerTrend,
} from "@/lib/realtime/mock/share-trends";
import { generateDemoTeamDashboard } from "@/lib/realtime/mock/team-dashboard";
import {
  generateDemoFilterOptions,
  generateDemoGeoPoints,
  generateDemoOverviewClientTab,
  generateDemoOverviewGeoTab,
  generateDemoOverviewPageTab,
  generateDemoOverviewSourceTab,
  generateDemoUtmDimension,
  generateDemoUtmTrend,
} from "@/lib/realtime/mock/utm-overview";

// ---------------------------------------------------------------------------
//  Realtime mock socket
// ---------------------------------------------------------------------------

export type { RealtimeSocketLike } from "@/lib/realtime/mock/socket";
export { createMockRealtimeSocket } from "@/lib/realtime/mock/socket";

const DEMO_NOT_FOUND_RESPONSE = { ok: false, data: { error: "Not Found" } };

// ---------------------------------------------------------------------------
//  Route dispatcher — the single entry point for demo mode
// ---------------------------------------------------------------------------

export function handleDemoRequest(options: {
  path: string;
  method?: string;
  params?: Record<string, string | number>;
  body?: unknown;
}): unknown {
  const { path, method = "GET", params = {} } = options;
  const publicRouteMatch = path.match(/\/api\/public\/([^/]+)\//);
  const publicSiteProfile = publicRouteMatch
    ? findSiteProfileByPublicSlug(publicRouteMatch[1] || "")
    : null;
  const siteId = String(
    params.siteId || publicSiteProfile?.id || "demo-site-001",
  );
  const teamId = String(params.teamId || "");

  // Write operations → read-only stub
  if (
    method === "POST" ||
    method === "PATCH" ||
    method === "PUT" ||
    method === "DELETE"
  ) {
    if (path.includes("/funnels")) {
      if (method === "DELETE") return deleteDemoFunnel(siteId, params);
      return createDemoFunnel(siteId, options.body);
    }
    // Special cases that need real-looking responses
    if (path.includes("/auth/login")) {
      const user = getDemoUser();
      return { ok: true, data: { user, teams: getDemoTeams() } };
    }
    if (path.includes("/auth/me")) {
      const user = getDemoUser();
      return { ok: true, data: { user, teams: getDemoTeams() } };
    }
    if (path.includes("/profile")) {
      const body =
        options.body && typeof options.body === "object" ? options.body : {};
      const profileBody = body as {
        email?: unknown;
        name?: unknown;
        timeZone?: unknown;
        username?: unknown;
      };
      const hasTimeZone = Object.prototype.hasOwnProperty.call(
        body,
        "timeZone",
      );
      const user = getDemoUser();
      return {
        ok: true,
        data: {
          ...user,
          username: String(profileBody.username ?? user.username),
          email: String(profileBody.email ?? user.email),
          name: String(profileBody.name ?? user.name),
          timeZone: hasTimeZone
            ? normalizeTimeZone(String(profileBody.timeZone ?? ""))
            : user.timeZone,
        },
      };
    }
    if (path.includes("/site-config")) {
      const config =
        options.body &&
        typeof options.body === "object" &&
        "config" in options.body &&
        options.body.config &&
        typeof options.body.config === "object"
          ? (options.body.config as Record<string, unknown>)
          : {};
      return {
        ok: true,
        data: {
          ...getDemoSiteConfig(),
          ...config,
        },
      };
    }
    if (path.includes("/admin/site")) {
      const body =
        options.body && typeof options.body === "object" ? options.body : {};
      const siteBody = body as {
        siteId?: unknown;
        teamId?: unknown;
        name?: unknown;
        domain?: unknown;
        publicEnabled?: unknown;
        publicSlug?: unknown;
      };
      const existing =
        getDemoSites(String(siteBody.teamId || getDemoTeams()[0].id))[0] ||
        getDemoSites(getDemoTeams()[0].id)[0];
      return {
        ok: true,
        data: {
          ...existing,
          id: String(siteBody.siteId || existing.id),
          name: String(siteBody.name ?? existing.name),
          domain: String(siteBody.domain ?? existing.domain),
          publicEnabled:
            typeof siteBody.publicEnabled === "boolean"
              ? siteBody.publicEnabled
              : existing.publicEnabled,
          publicSlug:
            typeof siteBody.publicSlug === "string"
              ? siteBody.publicSlug
              : existing.publicSlug,
        },
      };
    }
    // Generic write → return empty success
    return { ok: true, data: {} };
  }

  // GET routes
  if (path.includes("/admin/auth/me")) {
    return { ok: true, data: { user: getDemoUser(), teams: getDemoTeams() } };
  }
  if (path.includes("/admin/users")) {
    return { ok: true, data: [getDemoUser()] };
  }
  if (path.includes("/admin/teams")) {
    return { ok: true, data: getDemoTeams() };
  }
  if (path.includes("/admin/sites")) {
    const tid = teamId || getDemoTeams()[0].id;
    return { ok: true, data: getDemoSites(tid) };
  }
  if (path.includes("/admin/members")) {
    const tid = teamId || getDemoTeams()[0].id;
    return { ok: true, data: getDemoMembers(tid) };
  }
  if (path.includes("/admin/site-config")) {
    return { ok: true, data: getDemoSiteConfig() };
  }
  if (path.includes("/admin/script-snippet")) {
    return { ok: true, data: getDemoScriptSnippet(siteId) };
  }
  if (path.includes("/admin/scheduled-tasks")) {
    return generateDemoScheduledTasks(params);
  }
  if (path.includes("/admin/system-performance")) {
    return generateDemoSystemPerformance(params);
  }
  if (path.includes("/admin/do-diagnostic")) {
    return generateDemoDoDiagnostic();
  }

  const publicSiteMatch = path.match(/\/api\/public\/([^/]+)\/site$/);
  if (publicSiteMatch) {
    const slug = decodeURIComponent(publicSiteMatch[1] || "demo-site");
    const profile = publicSiteProfile ?? findSiteProfileByPublicSlug(slug);
    if (!profile) return DEMO_NOT_FOUND_RESPONSE;
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

  // Analytics query routes
  if (path.includes("/filter-options")) {
    return generateDemoFilterOptions(siteId, params);
  }
  if (path.includes("/overview-page-path")) {
    return generateDemoOverviewPageTab(siteId, params, "path");
  }
  if (path.includes("/overview-page-title")) {
    return generateDemoOverviewPageTab(siteId, params, "title");
  }
  if (path.includes("/overview-page-hostname")) {
    return generateDemoOverviewPageTab(siteId, params, "hostname");
  }
  if (path.includes("/overview-page-entry")) {
    return generateDemoOverviewPageTab(siteId, params, "entry");
  }
  if (path.includes("/overview-page-exit")) {
    return generateDemoOverviewPageTab(siteId, params, "exit");
  }
  if (path.includes("/overview-source-domain")) {
    return generateDemoOverviewSourceTab(siteId, params, "domain");
  }
  if (path.includes("/overview-source-link")) {
    return generateDemoOverviewSourceTab(siteId, params, "link");
  }
  if (path.includes("/overview-client-browser")) {
    return generateDemoOverviewClientTab(siteId, params, "browser");
  }
  if (path.includes("/overview-client-os-version")) {
    return generateDemoOverviewClientTab(siteId, params, "osVersion");
  }
  if (path.includes("/overview-client-device-type")) {
    return generateDemoOverviewClientTab(siteId, params, "deviceType");
  }
  if (path.includes("/overview-client-language")) {
    return generateDemoOverviewClientTab(siteId, params, "language");
  }
  if (path.includes("/overview-client-screen-size")) {
    return generateDemoOverviewClientTab(siteId, params, "screenSize");
  }
  if (path.includes("/overview-geo-country")) {
    return generateDemoOverviewGeoTab(siteId, params, "country");
  }
  if (path.includes("/overview-geo-region")) {
    return generateDemoOverviewGeoTab(siteId, params, "region");
  }
  if (path.includes("/overview-geo-city")) {
    return generateDemoOverviewGeoTab(siteId, params, "city");
  }
  if (path.includes("/overview-geo-continent")) {
    return generateDemoOverviewGeoTab(siteId, params, "continent");
  }
  if (path.includes("/overview-geo-timezone")) {
    return generateDemoOverviewGeoTab(siteId, params, "timezone");
  }
  if (path.includes("/overview-geo-organization")) {
    return generateDemoOverviewGeoTab(siteId, params, "organization");
  }
  if (path.includes("/overview-geo-points")) {
    return generateDemoGeoPoints(siteId, params);
  }
  if (path.includes("/event-record-detail")) {
    return generateDemoEventRecordDetail(siteId, params);
  }
  if (path.includes("/event-type-field-values")) {
    return generateDemoEventTypeFieldValues(siteId, params);
  }
  if (path.includes("/event-type-detail")) {
    return generateDemoEventTypeDetail(siteId, params);
  }
  if (path.includes("/events-summary")) {
    return generateDemoEventsSummary(siteId, params);
  }
  if (path.includes("/events-trend")) {
    return generateDemoEventsTrend(siteId, params);
  }
  if (path.includes("/events-records")) {
    return generateDemoEventsRecords(siteId, params);
  }
  if (path.includes("/team-dashboard")) {
    const tid = teamId || getDemoTeams()[0].id;
    return generateDemoTeamDashboard(tid, params);
  }
  if (path.includes("/pages-dashboard")) {
    return generateDemoPagesDashboard(siteId, params);
  }
  if (path.includes("/funnels")) {
    return generateDemoFunnels(siteId, params);
  }
  if (path.includes("/retention")) {
    return generateDemoRetention(siteId, params);
  }
  if (path.includes("/performance")) {
    return generateDemoPerformance(siteId, params);
  }
  if (path.includes("/overview")) {
    return generateDemoOverview(siteId, params);
  }
  if (path.includes("/browser-cross-breakdown")) {
    return generateDemoBrowserCrossBreakdown(siteId, params);
  }
  if (path.includes("/browser-version-breakdown")) {
    return generateDemoBrowserVersionBreakdown(siteId, params);
  }
  if (path.includes("/browser-radar")) {
    return generateDemoBrowserRadar(siteId, params);
  }
  if (path.includes("/referrer-radar")) {
    return generateDemoReferrerRadar(siteId, params);
  }
  if (path.includes("/referrer-dimension-trend")) {
    return generateDemoReferrerTrend(siteId, params);
  }
  if (path.includes("/browser-trend")) {
    return generateDemoBrowserTrend(siteId, params);
  }
  if (path.includes("/browser-engine-trend")) {
    return generateDemoBrowserEngineTrend(siteId, params);
  }
  if (path.includes("/client-dimension-trend")) {
    return generateDemoClientDimensionTrend(siteId, params);
  }
  if (path.includes("/utm-dimension-trend")) {
    return generateDemoUtmTrend(siteId, params);
  }
  if (path.includes("/client-cross-breakdown")) {
    return generateDemoClientCrossBreakdown(siteId, params);
  }
  if (path.includes("/trend")) {
    return generateDemoTrend(siteId, params);
  }
  if (path.includes("/session-detail")) {
    return generateDemoSessionDetail(siteId, params);
  }
  if (path.includes("/visitor-detail")) {
    return generateDemoVisitorDetail(siteId, params);
  }
  if (path.includes("/sessions")) {
    return generateDemoSessions(siteId, params);
  }
  if (path.includes("/pages")) {
    return generateDemoPages(siteId, params);
  }
  if (path.includes("/referrers")) {
    return generateDemoReferrers(siteId, params);
  }
  if (path.includes("/utm-source")) {
    return generateDemoUtmDimension(siteId, "source", params);
  }
  if (path.includes("/utm-medium")) {
    return generateDemoUtmDimension(siteId, "medium", params);
  }
  if (path.includes("/utm-campaign")) {
    return generateDemoUtmDimension(siteId, "campaign", params);
  }
  if (path.includes("/utm-term")) {
    return generateDemoUtmDimension(siteId, "term", params);
  }
  if (path.includes("/utm-content")) {
    return generateDemoUtmDimension(siteId, "content", params);
  }
  if (path.includes("/visitors")) {
    return generateDemoVisitors(siteId, params);
  }
  if (path.includes("/countries")) {
    return generateDemoDimension(siteId, "countries", params);
  }
  if (path.includes("/devices")) {
    return generateDemoDimension(siteId, "devices", params);
  }
  if (path.includes("/page-hash")) {
    return generateDemoDimension(siteId, "page-hash", params);
  }
  if (path.includes("/page-query")) {
    return generateDemoDimension(siteId, "page-query", params);
  }
  if (path.includes("/event-types")) {
    return generateDemoDimension(siteId, "event-types", params);
  }

  // Public routes — delegate to same generators
  const publicMatch = path.match(/\/api\/public\/[^/]+\/(.*)/);
  if (publicMatch) {
    if (!publicSiteProfile) return DEMO_NOT_FOUND_RESPONSE;
    const subPath = publicMatch[1];
    if (subPath === "overview") return generateDemoOverview(siteId, params);
    if (subPath === "trend") return generateDemoTrend(siteId, params);
    if (subPath === "pages") return generateDemoPages(siteId, params);
    if (subPath === "referrers") return generateDemoReferrers(siteId, params);
    if (subPath === "performance")
      return generateDemoPerformance(siteId, params);
    if (subPath === "countries")
      return generateDemoDimension(siteId, "countries", params);
    if (subPath === "filter-options")
      return generateDemoFilterOptions(siteId, params);
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
        return generateDemoOverviewGeoTab(siteId, params, tab);
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
    if (subPath === "referrer-dimension-trend")
      return generateDemoReferrerTrend(siteId, params);
    if (subPath === "client-dimension-trend")
      return generateDemoClientDimensionTrend(siteId, params);
    if (subPath === "client-cross-breakdown")
      return generateDemoClientCrossBreakdown(siteId, params);
    return DEMO_NOT_FOUND_RESPONSE;
  }

  // Fallback
  return DEMO_NOT_FOUND_RESPONSE;
}
