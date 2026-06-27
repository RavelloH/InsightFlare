"use client";

import { type ReactNode, useEffect, useRef } from "react";
import Link from "next/link";
import { usePathname, useSelectedLayoutSegments } from "next/navigation";
import {
  RiApps2Line,
  RiArrowLeftLine,
  RiBarChartBoxLine,
  RiCalendarScheduleLine,
  RiFileInfoLine,
  RiGlobalLine,
  RiKey2Line,
  RiLinksLine,
  RiNotification3Line,
  RiSettings3Line,
  RiSpeedUpLine,
  RiTeamLine,
  RiUser3Line,
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
import type { TeamData } from "@/lib/edge-client";
import type { Locale } from "@/lib/i18n/config";
import type { AppMessages } from "@/lib/i18n/messages";

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
  | "settings";

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

interface SidebarRouteState {
  mode: "team" | "site";
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
  if (key === "settings") return RiSettings3Line;
  return RiGlobalLine;
}

function getManagementSectionIcon(key: string) {
  if (key === "manage-users") return RiUser3Line;
  if (key === "version-updates") return RiFileInfoLine;
  if (key === "scheduled-tasks") return RiCalendarScheduleLine;
  if (key === "system-performance") return RiSpeedUpLine;
  return RiTeamLine;
}

function normalizeLocalePath(pathname: string): string {
  const cleaned = pathname || "";
  if (cleaned.length === 0) return "/app";
  const withoutLocale = cleaned.replace(/^\/(en|zh)(?=\/|$)/, "") || "/app";
  if (withoutLocale === "/") return "/app";
  return withoutLocale.endsWith("/")
    ? withoutLocale.slice(0, -1)
    : withoutLocale;
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
  activeTeamSlug: string,
): SidebarRouteState {
  const segments = pathname.split("/").filter((segment) => segment.length > 0);
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

function visibleLayoutSegments(segments: string[]): string[] {
  return segments.filter((segment) => !segment.startsWith("("));
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
  activeTeamSlug: string;
  sites: SidebarSite[];
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
  activeTeamSlug,
  sites,
  teamSections,
  managementSections,
  children,
}: DashboardShellProps) {
  const scrollContainerRef = useRef<HTMLElement | null>(null);
  const scrollbarRef = useRef<ReturnType<typeof OverlayScrollbars> | null>(
    null,
  );
  const livePathname = usePathname() || pathname;
  const mainLayoutSegments = visibleLayoutSegments(useSelectedLayoutSegments());
  const mainSiteSection = mainLayoutSegments[1] || "";
  const mainSiteSubSection = mainLayoutSegments[2] || "";
  const validAnalyticsSections = [
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
  ] as const;
  const currentAnalyticsSection = validAnalyticsSections.includes(
    mainSiteSection as (typeof validAnalyticsSections)[number],
  )
    ? (mainSiteSection as (typeof validAnalyticsSections)[number])
    : undefined;
  const routeState = parseSidebarRouteState(livePathname, activeTeamSlug);
  const hasManagementSections = Boolean(
    managementSections && managementSections.length > 0,
  );
  const resolvedActiveSiteSlug = routeState.activeSiteSlug || "";
  const hasActiveSite =
    routeState.mode === "site" && resolvedActiveSiteSlug.length > 0;
  const activeSiteBase = hasActiveSite
    ? buildSitePath(locale, activeTeamSlug, resolvedActiveSiteSlug)
    : null;
  const activeTeamId =
    teams.find((team) => team.slug === activeTeamSlug)?.id || "";

  const analyticsSections: Array<{
    key: AnalyticsNavKey;
    href: string;
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
  const accountHref = `/${locale}/app/${activeTeamSlug}/account`;
  const teamRootHref = `/${locale}/app/${activeTeamSlug}`;
  const backToTeamLabel = messages.common.backToTeam;
  const activeTeamName =
    teams.find((team) => team.slug === activeTeamSlug)?.name || activeTeamSlug;
  const activeSiteName = hasActiveSite
    ? sites.find((site) => site.slug === resolvedActiveSiteSlug)?.name ||
      resolvedActiveSiteSlug
    : "";
  const activeSiteId = hasActiveSite
    ? sites.find((site) => site.slug === resolvedActiveSiteSlug)?.id || ""
    : "";
  const isRealtimeRoute = Boolean(
    hasActiveSite && activeSiteBase && mainSiteSection === "realtime",
  );
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
    : isRealtimeRoute || isSessionDetailRoute || isVisitorDetailRoute
      ? "min-w-0 w-full"
      : "mx-auto min-w-0 w-full max-w-[1400px] p-4 md:p-6";
  const sidebarInsetClassName = isGeoRoute
    ? "h-svh min-h-0 overflow-y-auto overscroll-contain [&>[data-overlayscrollbars-viewport]]:flex [&>[data-overlayscrollbars-viewport]]:h-full [&>[data-overlayscrollbars-viewport]]:min-h-0 [&>[data-overlayscrollbars-viewport]]:flex-col"
    : "h-svh min-h-0 overflow-y-auto overscroll-contain";
  const mobileCurrentLevelName = hasActiveSite
    ? activeSiteName
    : activeTeamName;
  const teamOptions = teams.map((team) => ({
    slug: team.slug,
    name: team.name,
    href: `/${locale}/app/${team.slug}`,
  }));

  useEffect(() => {
    const host = scrollContainerRef.current;
    if (!host) return;

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
        initialTimeZonePreference={user.timeZone || ""}
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
                    {process.env.NEXT_PUBLIC_DEMO_MODE ? "Demo" : "v1"}
                  </span>
                </p>
              </div>
            </Link>
          </SidebarHeader>

          <SidebarContent>
            <SidebarGroup className={SIDEBAR_COLLAPSE_SECTION_CLASS}>
              <SidebarGroupContent>
                <TeamSelect
                  locale={locale}
                  messages={messages}
                  options={teamOptions}
                  activeTeamSlug={activeTeamSlug}
                />
              </SidebarGroupContent>
            </SidebarGroup>

            <SidebarMenuStage mode={routeState.mode}>
              {routeState.mode === "team" ? (
                <>
                  <SidebarGroup>
                    <SidebarGroupLabel>
                      {messages.common.team}
                    </SidebarGroupLabel>
                    <SidebarGroupContent>
                      <SidebarMenu>
                        {teamSections?.map((item) => {
                          const isActive =
                            routeState.activeTeamSectionKey === item.key;
                          const SectionIcon = getTeamSectionIcon(item.key);
                          return (
                            <SidebarMenuItem key={item.key}>
                              <SidebarMenuButton asChild isActive={isActive}>
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
                        teamSlug={activeTeamSlug}
                        activeSiteSlug={resolvedActiveSiteSlug}
                        currentSection={currentAnalyticsSection}
                        sites={sites.map((site) => ({
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
                        messages={messages}
                      />
                    </SidebarGroupContent>
                  </SidebarGroup>
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
              accountHref={accountHref}
              messages={messages}
            />
          </SidebarFooter>
        </Sidebar>

        <SidebarInset
          ref={scrollContainerRef}
          data-dashboard-scroll-container=""
          data-overlayscrollbars-initialize
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
                        ) : (
                          <BreadcrumbPage className="block max-w-[28vw] truncate">
                            {activeTeamName}
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
                      hasActiveSite ||
                      routeState.activeTeamSectionKey === "sites"
                    }
                    showFilterSheet={hasActiveSite}
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
                {analyticsSections.length > 0 ? (
                  <div key="analytics-tabs">
                    <AnalyticsTabs
                      items={analyticsSections.map((item) => ({
                        key: item.key,
                        href: item.href,
                        label: messages.navigation[item.key],
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
