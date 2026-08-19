import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import {
  RiApps2Line,
  RiArrowLeftLine,
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
import { OverlayScrollbars } from "overlayscrollbars";

import { AnalyticsTabs } from "@/components/dashboard/analytics-tabs";
import { DashboardHeaderControls } from "@/components/dashboard/dashboard-header-controls";
import { DashboardQueryProvider } from "@/components/dashboard/dashboard-query-provider";
import { SidebarFooterMenus } from "@/components/dashboard/sidebar-footer-menus";
import { SidebarMenuStage } from "@/components/dashboard/sidebar-menu-stage";
import { SidebarSiteDetails } from "@/components/dashboard/sidebar-site-details";
import { TeamSelect } from "@/components/dashboard/team-select";
import { PageTransition } from "@/components/page-transition";
import { useAccountTimeZonePreference } from "@/components/time-zone-provider";
import { AutoResizer } from "@/components/ui/auto-resizer";
import { AutoTransition } from "@/components/ui/auto-transition";
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "@/components/ui/breadcrumb";
import {
  prepareNativeScrollbarHost,
  useNativeScrollbars,
} from "@/components/ui/overlay-scrollbar";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarInset,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
  SidebarSeparator,
  SidebarTrigger,
} from "@/components/ui/sidebar";
import { canManageTeam } from "@/lib/dashboard/permissions";
import { buildTeamSections } from "@/lib/dashboard/team-sections";
import {
  fetchAdminSites,
  type SessionTeamGroups,
  type SiteData,
  type TeamData,
} from "@/lib/edge-client";
import type { Locale } from "@/lib/i18n/config";
import type { AppMessages } from "@/lib/i18n/messages";
import Link from "@/lib/router";
import { usePathname } from "@/lib/router";

interface TeamSectionNavItem {
  key: string;
  label: string;
  href: string;
}

interface SidebarSite {
  id: string;
  slug: string;
  name: string;
  domain: string;
  iconPath?: string;
}

type AnalyticsNavKey =
  | "overview"
  | "realtime"
  | "pages"
  | "referrers"
  | "sessions"
  | "campaigns"
  | "events"
  | "funnels"
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

const DASHBOARD_SCROLLBAR_OPTIONS = {
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

const SIDEBAR_COLLAPSE_SECTION_CLASS =
  "max-h-20 overflow-hidden transition-[max-height,opacity,transform,padding,margin] duration-300 ease-[cubic-bezier(0.22,1,0.36,1)] motion-reduce:transition-none group-data-[collapsible=icon]:pointer-events-none group-data-[collapsible=icon]:max-h-0 group-data-[collapsible=icon]:-translate-y-1 group-data-[collapsible=icon]:p-0 group-data-[collapsible=icon]:opacity-0";
const SIDEBAR_COLLAPSE_SEPARATOR_CLASS =
  "transition-[opacity,margin] duration-300 ease-[cubic-bezier(0.22,1,0.36,1)] motion-reduce:transition-none group-data-[collapsible=icon]:my-0 group-data-[collapsible=icon]:opacity-0";
const SIDEBAR_COLLAPSE_MARGIN_CLASS =
  "transition-[margin] duration-300 ease-[cubic-bezier(0.22,1,0.36,1)] motion-reduce:transition-none group-data-[collapsible=icon]:mb-0";

function analyticsTabLabel(
  item: {
    key: AnalyticsNavKey;
    label?: string;
  },
  messages: AppMessages,
): string {
  if (item.label) return item.label;
  return messages.navigation[item.key as keyof typeof messages.navigation];
}

interface SidebarRouteState {
  mode: "root" | "team" | "site";
  activeRootSectionKey?: string;
  activeTeamSectionKey?: string;
  activeManagementSectionKey?: string;
  activeSiteSlug?: string;
}

function getTeamSectionIcon(key: string) {
  if (key === "sites") return RiBarChartBoxLine;
  if (key === "site-management") return RiWindow2Line;
  if (key === "widgets") return RiApps2Line;
  if (key === "notifications") return RiNotification3Line;
  if (key === "public-links") return RiLinksLine;
  if (key === "api-keys") return RiKey2Line;
  if (key === "settings") return RiUserSettingsLine;
  return RiGlobalLine;
}

function getManagementSectionIcon(key: string) {
  if (key === "manage-users") return RiUser3Line;
  if (key === "version-updates") return RiFileInfoLine;
  if (key === "scheduled-tasks") return RiCalendarScheduleLine;
  if (key === "request-observation") return RiRobot2Line;
  if (key === "system-settings") return RiSettings3Line;
  if (key === "system-performance") return RiSpeedUpLine;
  return RiTeamLine;
}

function getTeamRoleIcon(role: string | undefined) {
  if (role === "owner") return RiVipCrownLine;
  if (role === "admin") return RiShieldUserLine;
  return RiGroupLine;
}

function getTeamRoleLabel(messages: AppMessages, role: string | undefined) {
  if (role === "owner") return messages.teamManagement.members.roleLabels.owner;
  if (role === "admin") return messages.teamManagement.members.roleLabels.admin;
  return messages.teamManagement.members.roleLabels.member;
}

function normalizeLocalePath(pathname: string): string {
  const cleaned = pathname || "";
  if (cleaned.length === 0) return "/app";
  const withoutLocale = cleaned.replace(/^\/(en|zh|ja)(?=\/|$)/, "") || "/app";
  if (withoutLocale === "/") return "/app";
  return withoutLocale.endsWith("/")
    ? withoutLocale.slice(0, -1)
    : withoutLocale;
}

function safeSlug(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function getSidebarSiteSlug(site: Pick<SiteData, "id" | "domain">): string {
  const candidate = safeSlug(String(site.domain || ""));
  if (candidate.length > 0) return candidate;
  return site.id.slice(0, 8);
}

function toSidebarSite(site: SiteData): SidebarSite {
  return {
    id: site.id,
    slug: getSidebarSiteSlug(site),
    name: site.name,
    domain: site.domain,
    iconPath: site.iconPath,
  };
}

function parseActiveTeamSlugFromPath(
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

function buildSitePath(
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

function parseSidebarRouteState(
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

interface DashboardShellProps {
  locale: Locale;
  pathname: string;
  messages: AppMessages;
  user: {
    username: string;
    name: string;
    email: string;
    systemRole: "admin" | "user";
    timeZone?: string;
  };
  teams: TeamData[];
  teamGroups?: SessionTeamGroups;
  activeTeamSlug?: string;
  sites?: SidebarSite[];
  unreadAttentionCount?: number;
  teamSections?: TeamSectionNavItem[];
  managementSections?: TeamSectionNavItem[];
  children: ReactNode;
}

export function DashboardShell({
  locale,
  pathname,
  messages,
  user,
  teams,
  teamGroups,
  activeTeamSlug,
  sites = [],
  unreadAttentionCount = 0,
  teamSections,
  managementSections,
  children,
}: DashboardShellProps) {
  useAccountTimeZonePreference(user.timeZone);
  const scrollContainerRef = useRef<HTMLElement | null>(null);
  const scrollbarRef = useRef<ReturnType<typeof OverlayScrollbars> | null>(
    null,
  );
  const nativeScrollbars = useNativeScrollbars();
  const [clientSitesByTeam, setClientSitesByTeam] = useState<
    Record<string, SidebarSite[]>
  >({});
  const livePathname = usePathname() || pathname;
  const liveActiveTeamSlug =
    activeTeamSlug || parseActiveTeamSlugFromPath(livePathname, teams);
  const activeTeam = liveActiveTeamSlug
    ? teams.find((team) => team.slug === liveActiveTeamSlug)
    : undefined;
  const activeTeamId = activeTeam?.id || "";
  const resolvedSites =
    sites.length > 0
      ? sites
      : activeTeamId
        ? (clientSitesByTeam[activeTeamId] ?? [])
        : [];
  const resolvedTeamSections = useMemo(() => {
    if (teamSections) return teamSections;
    if (!liveActiveTeamSlug || !activeTeam) return undefined;
    return buildTeamSections(
      locale,
      liveActiveTeamSlug,
      messages,
      canManageTeam(activeTeam.membershipRole, user.systemRole),
    );
  }, [
    activeTeam,
    liveActiveTeamSlug,
    locale,
    messages,
    teamSections,
    user.systemRole,
  ]);
  const routeState = parseSidebarRouteState(livePathname, liveActiveTeamSlug);
  const activeTeamLocalPath = (() => {
    if (!liveActiveTeamSlug) return [];
    const segments = livePathname.split("/").filter((s) => s.length > 0);
    const teamIndex = segments.findIndex(
      (segment, index) =>
        segment === liveActiveTeamSlug &&
        index > 0 &&
        segments[index - 1] === "app",
    );
    return teamIndex >= 0 ? segments.slice(teamIndex + 1) : [];
  })();
  const mainSiteSection = activeTeamLocalPath[1] || "";
  const mainSiteSubSection = activeTeamLocalPath[2] || "";

  // Derive current analytics section from the live pathname directly.
  const VALID_ANALYTICS_SECTIONS = new Set([
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
    "retention",
  ]);
  const currentAnalyticsSection = (() => {
    if (routeState.mode !== "site" || !routeState.activeSiteSlug)
      return undefined;
    const section = activeTeamLocalPath[1] || "";
    return VALID_ANALYTICS_SECTIONS.has(section) ? section : undefined;
  })();
  const hasManagementSections = Boolean(
    managementSections && managementSections.length > 0,
  );
  const resolvedActiveSiteSlug = routeState.activeSiteSlug || "";
  const hasActiveSite =
    Boolean(liveActiveTeamSlug) &&
    routeState.mode === "site" &&
    resolvedActiveSiteSlug.length > 0;
  const activeSiteBase =
    hasActiveSite && liveActiveTeamSlug
      ? buildSitePath(locale, liveActiveTeamSlug, resolvedActiveSiteSlug)
      : null;

  const analyticsSections: Array<{
    key: AnalyticsNavKey;
    href: string;
    label?: string;
    queryKey?: string;
    queryValue?: string;
    queryDefault?: boolean;
  }> =
    hasActiveSite && activeSiteBase
      ? [
          { key: "overview", href: activeSiteBase },
          { key: "realtime", href: `${activeSiteBase}/realtime` },
          { key: "pages", href: `${activeSiteBase}/pages` },
          { key: "referrers", href: `${activeSiteBase}/referrers` },
          { key: "campaigns", href: `${activeSiteBase}/campaigns` },
          { key: "sessions", href: `${activeSiteBase}/sessions` },
          { key: "visitors", href: `${activeSiteBase}/visitors` },
          { key: "events", href: `${activeSiteBase}/events` },
          { key: "funnels", href: `${activeSiteBase}/funnels` },
          { key: "retention", href: `${activeSiteBase}/retention` },
          { key: "geo", href: `${activeSiteBase}/geo` },
          { key: "devices", href: `${activeSiteBase}/devices` },
          { key: "browsers", href: `${activeSiteBase}/browsers` },
          { key: "performance", href: `${activeSiteBase}/performance` },
          { key: "settings", href: `${activeSiteBase}/settings` },
        ]
      : [];
  const localeSuffix = normalizeLocalePath(livePathname);
  const switchToEn = `/en${localeSuffix}`;
  const switchToZh = `/zh${localeSuffix}`;
  const switchToJa = `/ja${localeSuffix}`;
  const accountHref = `/${locale}/app/account`;
  const notificationsHref = `/${locale}/app/inbox`;
  const appRootHref = `/${locale}/app`;
  const teamRootHref = liveActiveTeamSlug
    ? `/${locale}/app/${liveActiveTeamSlug}`
    : appRootHref;
  const backToTeamLabel = messages.common.backToTeam;
  const activeTeamName = liveActiveTeamSlug
    ? activeTeam?.name || liveActiveTeamSlug
    : "";
  const activeSiteName = hasActiveSite
    ? resolvedSites.find((site) => site.slug === resolvedActiveSiteSlug)
        ?.name || resolvedActiveSiteSlug
    : "";
  const activeSiteId = hasActiveSite
    ? resolvedSites.find((site) => site.slug === resolvedActiveSiteSlug)?.id ||
      ""
    : "";
  const isRealtimeRoute = Boolean(
    hasActiveSite && activeSiteBase && mainSiteSection === "realtime",
  );
  const isRequestObservationRoute = Boolean(
    !liveActiveTeamSlug &&
    normalizeLocalePath(livePathname) === "/app/manage/request-observation",
  );
  const requestObservationBase = `/${locale}/app/manage/request-observation`;
  const requestObservationSections: Array<{
    key: AnalyticsNavKey;
    href: string;
    label: string;
    queryKey: string;
    queryValue: string;
    queryDefault?: boolean;
  }> = isRequestObservationRoute
    ? [
        {
          key: "request-overview",
          href: requestObservationBase,
          label: messages.requestObservation.tabs.overview,
          queryKey: "requestTab",
          queryValue: "overview",
          queryDefault: true,
        },
        {
          key: "request-abnormal",
          href: `${requestObservationBase}?requestTab=abnormal`,
          label: messages.requestObservation.tabs.abnormal,
          queryKey: "requestTab",
          queryValue: "abnormal",
        },
        {
          key: "request-normal",
          href: `${requestObservationBase}?requestTab=normal`,
          label: messages.requestObservation.tabs.normal,
          queryKey: "requestTab",
          queryValue: "normal",
        },
      ]
    : [];
  const topbarSections =
    analyticsSections.length > 0
      ? analyticsSections
      : requestObservationSections;
  const isGeoRoute = Boolean(
    hasActiveSite && activeSiteBase && mainSiteSection === "geo",
  );
  const isSessionDetailRoute = Boolean(
    hasActiveSite &&
    activeSiteBase &&
    mainSiteSection === "sessions" &&
    mainSiteSubSection === "detail",
  );
  const isVisitorDetailRoute = Boolean(
    hasActiveSite &&
    activeSiteBase &&
    mainSiteSection === "visitors" &&
    mainSiteSubSection === "detail",
  );
  const contentContainerClassName = isGeoRoute
    ? "flex min-h-0 flex-1 min-w-0 w-full flex-col md:overflow-hidden [&>[data-page-transition]]:flex [&>[data-page-transition]]:h-full [&>[data-page-transition]]:min-h-0 [&>[data-page-transition]]:flex-1 [&>[data-page-transition]]:flex-col"
    : isRealtimeRoute ||
        isRequestObservationRoute ||
        isSessionDetailRoute ||
        isVisitorDetailRoute
      ? "min-w-0 w-full"
      : "mx-auto min-w-0 w-full max-w-[1400px] p-4 md:p-6";
  const sidebarInsetClassName = isGeoRoute
    ? "h-svh min-h-0 overflow-y-auto overscroll-contain [&>[data-overlayscrollbars-viewport]]:flex [&>[data-overlayscrollbars-viewport]]:h-full [&>[data-overlayscrollbars-viewport]]:min-h-0 [&>[data-overlayscrollbars-viewport]]:flex-col"
    : "h-svh min-h-0 overflow-y-auto overscroll-contain";
  const mobileCurrentLevelName = hasActiveSite
    ? activeSiteName
    : activeTeamName || messages.appName;
  const teamOptions = teams.map((team) => ({
    slug: team.slug,
    name: team.name,
    href: `/${locale}/app/${team.slug}`,
  }));
  const teamOptionGroups = teamGroups
    ? {
        created: teamGroups.created.map((team) => ({
          slug: team.slug,
          name: team.name,
          href: `/${locale}/app/${team.slug}`,
        })),
        managed: teamGroups.managed.map((team) => ({
          slug: team.slug,
          name: team.name,
          href: `/${locale}/app/${team.slug}`,
        })),
        member: teamGroups.member.map((team) => ({
          slug: team.slug,
          name: team.name,
          href: `/${locale}/app/${team.slug}`,
        })),
        system: teamGroups.system.map((team) => ({
          slug: team.slug,
          name: team.name,
          href: `/${locale}/app/${team.slug}`,
        })),
      }
    : undefined;
  const sidebarContextMode = routeState.mode === "root" ? "root" : "team";
  const teamSelector = liveActiveTeamSlug ? (
    <SidebarGroup className={SIDEBAR_COLLAPSE_SECTION_CLASS}>
      <SidebarGroupContent>
        <TeamSelect
          locale={locale}
          messages={messages}
          options={teamOptions}
          groups={teamOptionGroups}
          activeTeamSlug={liveActiveTeamSlug}
        />
      </SidebarGroupContent>
    </SidebarGroup>
  ) : null;

  useEffect(() => {
    if (!activeTeamId || sites.length > 0 || clientSitesByTeam[activeTeamId]) {
      return;
    }

    let active = true;
    fetchAdminSites(activeTeamId)
      .then((nextSites) => {
        if (!active) return;
        setClientSitesByTeam((current) => ({
          ...current,
          [activeTeamId]: nextSites.map(toSidebarSite),
        }));
      })
      .catch(() => {
        if (!active) return;
        setClientSitesByTeam((current) => ({
          ...current,
          [activeTeamId]: [],
        }));
      });

    return () => {
      active = false;
    };
  }, [activeTeamId, clientSitesByTeam, sites.length]);

  useEffect(() => {
    const host = scrollContainerRef.current;
    if (!host) return;
    if (prepareNativeScrollbarHost(host)) return;

    const existing = OverlayScrollbars(host);
    const instance =
      existing ?? OverlayScrollbars(host, DASHBOARD_SCROLLBAR_OPTIONS);

    if (existing) {
      existing.options(DASHBOARD_SCROLLBAR_OPTIONS);
    }
    scrollbarRef.current = instance;

    const frame = requestAnimationFrame(() => {
      instance.update();
    });

    return () => {
      cancelAnimationFrame(frame);
      if (!existing) {
        instance.destroy();
      }
      if (scrollbarRef.current === instance) {
        scrollbarRef.current = null;
      }
    };
  }, []);

  return (
    <SidebarProvider>
      <DashboardQueryProvider
        scopeKey={activeSiteId}
        maxRangeDays={isRequestObservationRoute ? 90 : undefined}
      >
        <Sidebar variant="inset" collapsible="icon">
          <SidebarHeader className={SIDEBAR_COLLAPSE_SECTION_CLASS}>
            <Link
              href="https://github.com/RavelloH/InsightFlare"
              target="_black"
            >
              <div className="py-2">
                <p className="text-xl text-primary flex gap-2 items-center justify-center md:justify-start">
                  <span>{messages.appName}</span>
                  <span className="text-muted-foreground">
                    {import.meta.env.VITE_DEMO_MODE === "1" ? "Demo" : "v1"}
                  </span>
                </p>
              </div>
            </Link>
          </SidebarHeader>

          <SidebarContent className="min-h-0 overflow-y-auto">
            <SidebarMenuStage mode={sidebarContextMode}>
              {routeState.mode === "root" ? (
                <>
                  <SidebarGroup>
                    <SidebarGroupLabel>
                      {messages.common.team}
                    </SidebarGroupLabel>
                    <SidebarGroupContent>
                      <SidebarMenu>
                        {teams.map((team) => {
                          const RoleIcon = getTeamRoleIcon(team.membershipRole);
                          const roleLabel = getTeamRoleLabel(
                            messages,
                            team.membershipRole,
                          );
                          return (
                            <SidebarMenuItem key={team.id}>
                              <SidebarMenuButton asChild>
                                <Link href={`/${locale}/app/${team.slug}`}>
                                  <span
                                    aria-label={roleLabel}
                                    title={roleLabel}
                                    className={
                                      team.membershipRole === "owner"
                                        ? "text-primary"
                                        : undefined
                                    }
                                  >
                                    <RoleIcon aria-hidden="true" />
                                  </span>
                                  <span>{team.name}</span>
                                </Link>
                              </SidebarMenuButton>
                            </SidebarMenuItem>
                          );
                        })}
                      </SidebarMenu>
                    </SidebarGroupContent>
                  </SidebarGroup>

                  {hasManagementSections ? (
                    <>
                      <SidebarSeparator
                        className={SIDEBAR_COLLAPSE_SEPARATOR_CLASS}
                      />
                      <SidebarGroup>
                        <SidebarGroupLabel>
                          {messages.common.management}
                        </SidebarGroupLabel>
                        <SidebarGroupContent>
                          <SidebarMenu>
                            {managementSections?.map((item) => {
                              const isActive =
                                routeState.activeManagementSectionKey ===
                                item.key;
                              const SectionIcon = getManagementSectionIcon(
                                item.key,
                              );
                              return (
                                <SidebarMenuItem key={item.key}>
                                  <SidebarMenuButton
                                    asChild
                                    isActive={isActive}
                                  >
                                    <Link href={item.href}>
                                      <SectionIcon />
                                      <span>{item.label}</span>
                                    </Link>
                                  </SidebarMenuButton>
                                </SidebarMenuItem>
                              );
                            })}
                          </SidebarMenu>
                        </SidebarGroupContent>
                      </SidebarGroup>
                    </>
                  ) : null}
                </>
              ) : (
                <>
                  {teamSelector}
                  <SidebarMenuStage
                    mode={routeState.mode}
                    storageKey="insightflare-sidebar-team-mode"
                  >
                    {routeState.mode === "team" ? (
                      <>
                        <SidebarGroup>
                          <SidebarGroupLabel>
                            {messages.common.team}
                          </SidebarGroupLabel>
                          <SidebarGroupContent>
                            <SidebarMenu>
                              {resolvedTeamSections?.map((item) => {
                                const isActive =
                                  routeState.activeTeamSectionKey === item.key;
                                const SectionIcon = getTeamSectionIcon(
                                  item.key,
                                );
                                return (
                                  <SidebarMenuItem key={item.key}>
                                    <SidebarMenuButton
                                      asChild
                                      isActive={isActive}
                                    >
                                      <Link href={item.href}>
                                        <SectionIcon />
                                        <span>{item.label}</span>
                                      </Link>
                                    </SidebarMenuButton>
                                  </SidebarMenuItem>
                                );
                              })}
                            </SidebarMenu>
                          </SidebarGroupContent>
                        </SidebarGroup>

                        {hasManagementSections ? (
                          <>
                            <SidebarSeparator
                              className={SIDEBAR_COLLAPSE_SEPARATOR_CLASS}
                            />
                            <SidebarGroup>
                              <SidebarGroupLabel>
                                {messages.common.management}
                              </SidebarGroupLabel>
                              <SidebarGroupContent>
                                <SidebarMenu>
                                  {managementSections?.map((item) => {
                                    const isActive =
                                      routeState.activeManagementSectionKey ===
                                      item.key;
                                    const SectionIcon =
                                      getManagementSectionIcon(item.key);
                                    return (
                                      <SidebarMenuItem key={item.key}>
                                        <SidebarMenuButton
                                          asChild
                                          isActive={isActive}
                                        >
                                          <Link href={item.href}>
                                            <SectionIcon />
                                            <span>{item.label}</span>
                                          </Link>
                                        </SidebarMenuButton>
                                      </SidebarMenuItem>
                                    );
                                  })}
                                </SidebarMenu>
                              </SidebarGroupContent>
                            </SidebarGroup>
                          </>
                        ) : null}
                      </>
                    ) : (
                      <>
                        <SidebarGroup>
                          <SidebarGroupContent>
                            <SidebarMenu
                              className={`mb-2 ${SIDEBAR_COLLAPSE_MARGIN_CLASS}`}
                            >
                              <SidebarMenuItem>
                                <SidebarMenuButton asChild>
                                  <Link href={teamRootHref}>
                                    <RiArrowLeftLine />
                                    <span>{backToTeamLabel}</span>
                                  </Link>
                                </SidebarMenuButton>
                              </SidebarMenuItem>
                            </SidebarMenu>
                          </SidebarGroupContent>
                        </SidebarGroup>

                        <SidebarSeparator
                          className={SIDEBAR_COLLAPSE_SEPARATOR_CLASS}
                        />

                        <SidebarGroup>
                          <SidebarGroupLabel>
                            {messages.common.site}
                          </SidebarGroupLabel>
                          <SidebarGroupContent>
                            <SidebarSiteDetails
                              locale={locale}
                              teamId={activeTeamId}
                              teamSlug={liveActiveTeamSlug || ""}
                              activeSiteSlug={resolvedActiveSiteSlug}
                              currentSection={currentAnalyticsSection}
                              sites={resolvedSites.map((site) => ({
                                id: site.id,
                                slug: site.slug,
                                name: site.name,
                                domain: site.domain,
                                iconPath: site.iconPath,
                              }))}
                              labels={{
                                views: messages.common.views,
                                visitors: messages.common.visitors,
                              }}
                            />
                          </SidebarGroupContent>
                        </SidebarGroup>
                      </>
                    )}
                  </SidebarMenuStage>
                </>
              )}
            </SidebarMenuStage>
          </SidebarContent>

          <SidebarFooter className="!m-0 !gap-0 !p-0">
            <SidebarFooterMenus
              locale={locale}
              user={user}
              switchToEn={switchToEn}
              switchToZh={switchToZh}
              switchToJa={switchToJa}
              accountHref={accountHref}
              notificationsHref={notificationsHref}
              unreadAttentionCount={unreadAttentionCount}
              messages={messages}
            />
          </SidebarFooter>
        </Sidebar>

        <SidebarInset
          ref={scrollContainerRef}
          data-dashboard-scroll-container=""
          data-overlayscrollbars-initialize={nativeScrollbars ? undefined : ""}
          className={sidebarInsetClassName}
        >
          <div className="sticky top-0 z-20 border-b bg-background/90 backdrop-blur">
            <div className="p-3">
              <div className="flex min-w-0 items-center gap-2">
                <SidebarTrigger />
                <div className="min-w-0 flex-1">
                  <Breadcrumb className="md:hidden">
                    <BreadcrumbList className="flex-nowrap">
                      <BreadcrumbItem className="min-w-0">
                        <BreadcrumbPage className="block truncate">
                          {mobileCurrentLevelName}
                        </BreadcrumbPage>
                      </BreadcrumbItem>
                    </BreadcrumbList>
                  </Breadcrumb>

                  <Breadcrumb className="hidden md:block">
                    <BreadcrumbList className="flex-nowrap">
                      <BreadcrumbItem className="min-w-0">
                        {hasActiveSite ? (
                          <BreadcrumbLink asChild>
                            <Link
                              href={teamRootHref}
                              className="block max-w-[28vw] truncate"
                            >
                              {activeTeamName}
                            </Link>
                          </BreadcrumbLink>
                        ) : activeTeamName ? (
                          <BreadcrumbPage className="block max-w-[28vw] truncate">
                            {activeTeamName}
                          </BreadcrumbPage>
                        ) : (
                          <BreadcrumbPage className="block max-w-[28vw] truncate">
                            {messages.appName}
                          </BreadcrumbPage>
                        )}
                      </BreadcrumbItem>

                      {hasActiveSite ? (
                        <>
                          <BreadcrumbSeparator />
                          <BreadcrumbItem className="min-w-0">
                            <BreadcrumbPage className="block max-w-[28vw] truncate">
                              {activeSiteName}
                            </BreadcrumbPage>
                          </BreadcrumbItem>
                        </>
                      ) : null}
                    </BreadcrumbList>
                  </Breadcrumb>
                </div>
                <div className="ml-auto min-w-0">
                  <DashboardHeaderControls
                    locale={locale}
                    messages={messages}
                    siteId={activeSiteId}
                    showControls={
                      Boolean(liveActiveTeamSlug) || isRequestObservationRoute
                    }
                    showFilterSheet={hasActiveSite}
                    showRealtimeBadge={!isRequestObservationRoute}
                  />
                </div>
              </div>
            </div>

            <AutoResizer className="px-3" duration={0.24}>
              <AutoTransition
                type="slideDown"
                duration={0.2}
                initial={false}
                presenceMode="sync"
              >
                {topbarSections.length > 0 ? (
                  <div key="analytics-tabs">
                    <AnalyticsTabs
                      items={topbarSections.map((item) => ({
                        key: item.key,
                        href: item.href,
                        label: analyticsTabLabel(item, messages),
                        queryKey: item.queryKey,
                        queryValue: item.queryValue,
                        queryDefault: item.queryDefault,
                      }))}
                    />
                  </div>
                ) : (
                  <div key="analytics-tabs-empty" className="h-0" aria-hidden />
                )}
              </AutoTransition>
            </AutoResizer>
          </div>
          <div data-dashboard-content="" className={contentContainerClassName}>
            <PageTransition>{children}</PageTransition>
          </div>
        </SidebarInset>
      </DashboardQueryProvider>
    </SidebarProvider>
  );
}
