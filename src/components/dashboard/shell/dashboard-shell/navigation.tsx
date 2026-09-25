import {
  RiApps2Line,
  RiBarChartBoxLine,
  RiCalendarScheduleLine,
  RiFileInfoLine,
  RiGlobalLine,
  RiGroupLine,
  RiKey2Line,
  RiLinksLine,
  RiNotification3Line,
  RiRobot2Line,
  RiSettings3Line,
  RiShieldUserLine,
  RiSpeedUpLine,
  RiTeamLine,
  RiUser3Line,
  RiUserSettingsLine,
  RiVipCrownLine,
  RiWindow2Line,
} from "@remixicon/react";
import type { PartialOptions } from "overlayscrollbars";

import { type SiteData, type TeamData } from "@/lib/dashboard-api/client/edge";
import type { Locale } from "@/lib/i18n/config";
import type { AppMessages } from "@/lib/i18n/messages";
export interface TeamSectionNavItem {
  key: string;
  label: string;
  href: string;
}
export interface SidebarSite {
  id: string;
  slug: string;
  name: string;
  domain: string;
  iconPath?: string;
}
export type AnalyticsNavKey =
  | "overview"
  | "realtime"
  | "pages"
  | "referrers"
  | "sessions"
  | "campaigns"
  | "events"
  | "funnels"
  | "goals"
  | "visitors"
  | "retention"
  | "geo"
  | "devices"
  | "browsers"
  | "performance"
  | "settings"
  | "request-overview"
  | "request-abnormal"
  | "request-normal";
export const VALID_ANALYTICS_SECTIONS = new Set([
  "realtime",
  "pages",
  "referrers",
  "sessions",
  "events",
  "visitors",
  "geo",
  "devices",
  "browsers",
  "performance",
  "settings",
  "campaigns",
  "funnels",
  "goals",
  "retention",
]);
export const DASHBOARD_SCROLLBAR_OPTIONS = {
  overflow: {
    x: "hidden",
    y: "scroll",
  },
  scrollbars: {
    theme: "os-theme-insightflare",
    autoHide: "move",
    autoHideDelay: 420,
    autoHideSuspend: false,
  },
} satisfies PartialOptions;
export const SIDEBAR_COLLAPSE_SECTION_CLASS =
  "max-h-20 overflow-hidden transition-[max-height,opacity,transform,padding,margin] duration-[380ms] ease-[cubic-bezier(0.4,0,0.2,1)] motion-reduce:transition-none group-data-[collapsible=icon]:pointer-events-none group-data-[collapsible=icon]:max-h-0 group-data-[collapsible=icon]:-translate-y-1 group-data-[collapsible=icon]:p-0 group-data-[collapsible=icon]:opacity-0";
export const SIDEBAR_COLLAPSE_SEPARATOR_CLASS =
  "transition-[opacity,margin] duration-[380ms] ease-[cubic-bezier(0.4,0,0.2,1)] motion-reduce:transition-none group-data-[collapsible=icon]:my-0 group-data-[collapsible=icon]:opacity-0";
export const SIDEBAR_COLLAPSE_MARGIN_CLASS =
  "transition-[margin] duration-[380ms] ease-[cubic-bezier(0.4,0,0.2,1)] motion-reduce:transition-none group-data-[collapsible=icon]:mb-0";
export function analyticsTabLabel(
  item: {
    key: AnalyticsNavKey;
    label?: string;
  },
  messages: AppMessages,
): string {
  if (item.label) return item.label;
  return messages.navigation[item.key as keyof typeof messages.navigation];
}
export interface SidebarRouteState {
  mode: "root" | "team" | "site";
  activeRootSectionKey?: string;
  activeTeamSectionKey?: string;
  activeManagementSectionKey?: string;
  activeSiteSlug?: string;
}
export function getTeamSectionIcon(key: string) {
  if (key === "sites") return RiBarChartBoxLine;
  if (key === "site-management") return RiWindow2Line;
  if (key === "widgets") return RiApps2Line;
  if (key === "notifications") return RiNotification3Line;
  if (key === "public-links") return RiLinksLine;
  if (key === "api-keys") return RiKey2Line;
  if (key === "settings") return RiUserSettingsLine;
  return RiGlobalLine;
}
export function getManagementSectionIcon(key: string) {
  if (key === "manage-users") return RiUser3Line;
  if (key === "version-updates") return RiFileInfoLine;
  if (key === "scheduled-tasks") return RiCalendarScheduleLine;
  if (key === "request-observation") return RiRobot2Line;
  if (key === "system-settings") return RiSettings3Line;
  if (key === "system-performance") return RiSpeedUpLine;
  return RiTeamLine;
}
export function getTeamRoleIcon(role: string | undefined) {
  if (role === "owner") return RiVipCrownLine;
  if (role === "admin") return RiShieldUserLine;
  return RiGroupLine;
}
export function getTeamRoleLabel(
  messages: AppMessages,
  role: string | undefined,
) {
  if (role === "owner") return messages.teamManagement.members.roleLabels.owner;
  if (role === "admin") return messages.teamManagement.members.roleLabels.admin;
  return messages.teamManagement.members.roleLabels.member;
}
export function normalizeLocalePath(pathname: string): string {
  const cleaned = pathname || "";
  if (cleaned.length === 0) return "/app";
  const withoutLocale = cleaned.replace(/^\/(en|zh|ja)(?=\/|$)/, "") || "/app";
  if (withoutLocale === "/") return "/app";
  return withoutLocale.endsWith("/")
    ? withoutLocale.slice(0, -1)
    : withoutLocale;
}
export function safeSlug(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}
export function getSidebarSiteSlug(
  site: Pick<SiteData, "id" | "domain">,
): string {
  const candidate = safeSlug(String(site.domain || ""));
  if (candidate.length > 0) return candidate;
  return site.id.slice(0, 8);
}
export function toSidebarSite(site: SiteData): SidebarSite {
  return {
    id: site.id,
    slug: getSidebarSiteSlug(site),
    name: site.name,
    domain: site.domain,
    iconPath: site.iconPath,
  };
}
export function parseActiveTeamSlugFromPath(
  pathname: string,
  teams: TeamData[],
): string {
  const segments = pathname.split("/").filter((segment) => segment.length > 0);
  const appIndex = segments.findIndex((segment) => segment === "app");
  const candidate = appIndex >= 0 ? segments[appIndex + 1] || "" : "";
  if (!candidate || ["account", "inbox", "manage"].includes(candidate)) {
    return "";
  }
  return teams.some((team) => team.slug === candidate) ? candidate : "";
}
export function buildSitePath(
  locale: Locale,
  teamSlug: string,
  siteSlug: string,
  section?:
    | "realtime"
    | "pages"
    | "referrers"
    | "sessions"
    | "events"
    | "visitors"
    | "geo"
    | "devices"
    | "browsers"
    | "performance"
    | "settings",
): string {
  const base = `/${locale}/app/${teamSlug}/${siteSlug}`;
  if (!section) return base;
  return `${base}/${section}`;
}
export function parseSidebarRouteState(
  pathname: string,
  activeTeamSlug?: string,
): SidebarRouteState {
  const segments = pathname.split("/").filter((segment) => segment.length > 0);
  const appIndex = segments.findIndex((segment) => segment === "app");
  const appLocalPath = appIndex >= 0 ? segments.slice(appIndex + 1) : [];

  if (!activeTeamSlug) {
    if (appLocalPath[0] === "inbox") {
      return {
        mode: "root",
        activeRootSectionKey: "inbox",
      };
    }
    if (appLocalPath[0] === "account") {
      return {
        mode: "root",
        activeRootSectionKey: "account",
      };
    }
    if (appLocalPath[0] === "manage") {
      const managementKeyByPath: Record<string, string> = {
        users: "manage-users",
        teams: "manage-teams",
        "version-updates": "version-updates",
        "scheduled-tasks": "scheduled-tasks",
        "request-observation": "request-observation",
        "system-performance": "system-performance",
        "system-settings": "system-settings",
      };
      return {
        mode: "root",
        activeManagementSectionKey: managementKeyByPath[appLocalPath[1] || ""],
      };
    }
    return {
      mode: "root",
    };
  }

  const teamIndex = segments.findIndex(
    (segment, index) =>
      segment === activeTeamSlug && index > 0 && segments[index - 1] === "app",
  );
  const localPath = teamIndex >= 0 ? segments.slice(teamIndex + 1) : [];

  if (localPath.length === 0) {
    return {
      mode: "team",
      activeTeamSectionKey: "sites",
    };
  }

  if (localPath[0] === "settings") {
    return {
      mode: "team",
      activeTeamSectionKey: "settings",
    };
  }

  if (localPath[0] === "public-links") {
    return {
      mode: "team",
      activeTeamSectionKey: "public-links",
    };
  }

  if (localPath[0] === "api-keys") {
    return {
      mode: "team",
      activeTeamSectionKey: "api-keys",
    };
  }

  if (localPath[0] === "notifications") {
    return {
      mode: "team",
      activeTeamSectionKey: "notifications",
    };
  }

  if (localPath[0] === "members") {
    return {
      mode: "team",
      activeTeamSectionKey: "settings",
    };
  }

  if (localPath[0] === "account") {
    return {
      mode: "team",
    };
  }

  if (localPath[0] === "manage") {
    if (localPath[1] === "users") {
      return {
        mode: "team",
        activeManagementSectionKey: "manage-users",
      };
    }
    if (localPath[1] === "sites") {
      return {
        mode: "team",
        activeTeamSectionKey: "site-management",
      };
    }
    if (localPath[1] === "teams") {
      return {
        mode: "team",
        activeManagementSectionKey: "manage-teams",
      };
    }
    if (localPath[1] === "system-performance") {
      return {
        mode: "team",
        activeManagementSectionKey: "system-performance",
      };
    }
    if (localPath[1] === "system-settings") {
      return {
        mode: "team",
        activeManagementSectionKey: "system-settings",
      };
    }
    if (localPath[1] === "version-updates") {
      return {
        mode: "team",
        activeManagementSectionKey: "version-updates",
      };
    }
    if (localPath[1] === "scheduled-tasks") {
      return {
        mode: "team",
        activeManagementSectionKey: "scheduled-tasks",
      };
    }
    return {
      mode: "team",
    };
  }

  if (localPath[0] === "widgets") {
    return {
      mode: "team",
      activeTeamSectionKey: "widgets",
    };
  }

  return {
    mode: "site",
    activeSiteSlug: localPath[0],
  };
}
