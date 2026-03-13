"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";
import {
  RiArrowLeftLine,
  RiFolderLine,
  RiGlobalLine,
  RiSettings3Line,
  RiTeamLine,
  RiUser3Line,
} from "@remixicon/react";
import type { TeamData } from "@/lib/edge-client";
import type { Locale } from "@/lib/i18n/config";
import type { AppMessages } from "@/lib/i18n/messages";
import { PageTransition } from "@/components/page-transition";
import { AnalyticsTabs } from "@/components/dashboard/analytics-tabs";
import { SidebarMenuStage } from "@/components/dashboard/sidebar-menu-stage";
import { SidebarFooterMenus } from "@/components/dashboard/sidebar-footer-menus";
import { TeamSelect } from "@/components/dashboard/team-select";
import { DashboardQueryProvider } from "@/components/dashboard/dashboard-query-provider";
import { DashboardHeaderControls } from "@/components/dashboard/dashboard-header-controls";
import { SidebarSiteDetails } from "@/components/dashboard/sidebar-site-details";
import { AutoTransition } from "@/components/ui/auto-transition";
import { AutoResizer } from "@/components/ui/auto-resizer";
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
}

type AnalyticsNavKey =
  | "overview"
  | "realtime"
  | "pages"
  | "referrers"
  | "sessions"
  | "events"
  | "visitors"
  | "geo"
  | "devices"
  | "browsers"
  | "settings";

interface SidebarRouteState {
  mode: "team" | "site";
  activeTeamSectionKey?: string;
  activeManagementSectionKey?: string;
  activeSiteSlug?: string;
}

function getTeamSectionIcon(key: string) {
  if (key === "sites") return RiGlobalLine;
  if (key === "settings") return RiSettings3Line;
  if (key === "members") return RiTeamLine;
  return RiFolderLine;
}

function getManagementSectionIcon(key: string) {
  if (key === "manage-users") return RiUser3Line;
  if (key === "manage-sites") return RiGlobalLine;
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
    | "settings",
): string {
  const base = `/${locale}/app/${teamSlug}/${siteSlug}`;
  if (!section) return base;
  return `${base}/${section}`;
}

function parseSidebarRouteState(pathname: string, activeTeamSlug: string): SidebarRouteState {
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

  if (localPath[0] === "members") {
    return {
      mode: "team",
      activeTeamSectionKey: "members",
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
        activeManagementSectionKey: "manage-sites",
      };
    }
    if (localPath[1] === "teams") {
      return {
        mode: "team",
        activeManagementSectionKey: "manage-teams",
      };
    }
    return {
      mode: "team",
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
  const livePathname = usePathname() || pathname;
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
          { key: "sessions", href: `${activeSiteBase}/sessions` },
          { key: "events", href: `${activeSiteBase}/events` },
          { key: "visitors", href: `${activeSiteBase}/visitors` },
          { key: "geo", href: `${activeSiteBase}/geo` },
          { key: "devices", href: `${activeSiteBase}/devices` },
          { key: "browsers", href: `${activeSiteBase}/browsers` },
          { key: "settings", href: `${activeSiteBase}/settings` },
        ]
      : [];

  const localeSuffix = normalizeLocalePath(livePathname);
  const switchToEn = `/en${localeSuffix}`;
  const switchToZh = `/zh${localeSuffix}`;
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
  const mobileCurrentLevelName = hasActiveSite ? activeSiteName : activeTeamName;
  const teamOptions = teams.map((team) => ({
    slug: team.slug,
    name: team.name,
    href: `/${locale}/app/${team.slug}`,
  }));

  return (
    <SidebarProvider>
      <DashboardQueryProvider>
        <Sidebar variant="inset" collapsible="icon">
          <SidebarHeader className="group-data-[collapsible=icon]:hidden">
            <div className="py-2">
              <p className="text-xl text-primary flex gap-2 items-center justify-center md:justify-start">
                <span className="group-data-[collapsible=icon]:hidden">
                  {messages.appName}
                </span>
                <span className="text-muted-foreground group-data-[collapsible=icon]:hidden">
                  v1
                </span>
              </p>
            </div>
          </SidebarHeader>

          <SidebarContent>
            <SidebarGroup className="group-data-[collapsible=icon]:hidden">
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
                    <SidebarGroupLabel>{messages.common.team}</SidebarGroupLabel>
                    <SidebarGroupContent>
                      <SidebarMenu>
                        {teamSections?.map((item) => {
                          const isActive = routeState.activeTeamSectionKey === item.key;
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
                      <SidebarSeparator className="group-data-[collapsible=icon]:hidden" />
                      <SidebarGroup>
                        <SidebarGroupLabel>
                          {messages.common.management}
                        </SidebarGroupLabel>
                        <SidebarGroupContent>
                          <SidebarMenu>
                            {managementSections?.map((item) => {
                              const isActive =
                                routeState.activeManagementSectionKey === item.key;
                              const SectionIcon = getManagementSectionIcon(item.key);
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
                    </>
                  ) : null}
                </>
              ) : (
                <>
                  <SidebarGroup>
                    <SidebarGroupContent>
                      <SidebarMenu className="mb-2 group-data-[collapsible=icon]:mb-0">
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

                  <SidebarSeparator className="group-data-[collapsible=icon]:hidden" />

                  <SidebarGroup>
                    <SidebarGroupLabel>{messages.common.site}</SidebarGroupLabel>
                    <SidebarGroupContent>
                      <SidebarSiteDetails
                        locale={locale}
                        teamId={activeTeamId}
                        teamSlug={activeTeamSlug}
                        activeSiteSlug={resolvedActiveSiteSlug}
                        sites={sites.map((site) => ({
                          id: site.id,
                          slug: site.slug,
                          name: site.name,
                          domain: site.domain,
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
          </SidebarContent>

          <SidebarFooter className="!m-0 !gap-0 !p-0">
            <SidebarFooterMenus
              locale={locale}
              user={user}
              switchToEn={switchToEn}
              switchToZh={switchToZh}
              messages={messages}
            />
          </SidebarFooter>
        </Sidebar>

        <SidebarInset>
          <div className="sticky top-0 z-20 border-b bg-background/90 backdrop-blur">
            <div className="p-3">
              <div className="flex min-w-0 flex-wrap items-center gap-2">
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
                <div className="ml-auto w-full min-w-0 lg:w-auto">
                  <DashboardHeaderControls
                    locale={locale}
                    messages={messages}
                    siteId={activeSiteId}
                    showControls={
                      hasActiveSite || routeState.activeTeamSectionKey === "sites"
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
          <div className="mx-auto min-w-0 w-full max-w-[1400px] p-4 md:p-6">
            <PageTransition>{children}</PageTransition>
          </div>
        </SidebarInset>
      </DashboardQueryProvider>
    </SidebarProvider>
  );
}
