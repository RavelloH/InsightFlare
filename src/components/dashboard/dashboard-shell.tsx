import Link from "next/link";
import { cookies } from "next/headers";
import type { ReactNode } from "react";
import {
  RiArrowLeftLine,
  RiComputerLine,
  RiDashboardLine,
  RiFileList3Line,
  RiFlashlightLine,
  RiFolderLine,
  RiGlobalLine,
  RiMapPin2Line,
  RiSettings3Line,
  RiShareForwardLine,
  RiTeamLine,
  RiTimeLine,
  RiUser3Line,
} from "@remixicon/react";
import type { TeamData } from "@/lib/edge-client";
import type { SiteWithSlug } from "@/lib/dashboard/server";
import { buildSitePath } from "@/lib/dashboard/server";
import type { Locale } from "@/lib/i18n/config";
import type { AppMessages } from "@/lib/i18n/messages";
import { PageTransition } from "@/components/page-transition";
import { SidebarFooterMenus } from "@/components/dashboard/sidebar-footer-menus";
import { TeamSelect } from "@/components/dashboard/team-select";
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

const SIDEBAR_COOKIE_NAME = "sidebar_state";

type AnalyticsNavKey =
  | "overview"
  | "pages"
  | "referrers"
  | "sessions"
  | "events"
  | "visitors"
  | "geo"
  | "devices"
  | "browsers";

function getTeamSectionIcon(key: string) {
  if (key === "sites") return RiGlobalLine;
  if (key === "settings") return RiSettings3Line;
  if (key === "members") return RiTeamLine;
  return RiFolderLine;
}

function getAnalyticsSectionIcon(key: AnalyticsNavKey) {
  if (key === "overview") return RiDashboardLine;
  if (key === "pages") return RiFileList3Line;
  if (key === "referrers") return RiShareForwardLine;
  if (key === "sessions") return RiTimeLine;
  if (key === "events") return RiFlashlightLine;
  if (key === "visitors") return RiUser3Line;
  if (key === "geo") return RiMapPin2Line;
  if (key === "devices") return RiComputerLine;
  return RiGlobalLine;
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
  sites: SiteWithSlug[];
  activeSiteSlug?: string;
  teamSections?: TeamSectionNavItem[];
  activeTeamSectionKey?: string;
  managementSections?: TeamSectionNavItem[];
  activeManagementSectionKey?: string;
  children: ReactNode;
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

export async function DashboardShell({
  locale,
  pathname,
  messages,
  user,
  teams,
  activeTeamSlug,
  sites,
  activeSiteSlug,
  teamSections,
  activeTeamSectionKey,
  managementSections,
  activeManagementSectionKey,
  children,
}: DashboardShellProps) {
  const cookieStore = await cookies();
  const defaultSidebarOpen =
    cookieStore.get(SIDEBAR_COOKIE_NAME)?.value !== "false";

  const hasTeamSections = Boolean(teamSections && teamSections.length > 0);
  const hasManagementSections = Boolean(
    managementSections && managementSections.length > 0,
  );
  const resolvedActiveSiteSlug = activeSiteSlug || "";
  const hasActiveSite = resolvedActiveSiteSlug.length > 0;
  const activeSiteBase = hasActiveSite
    ? buildSitePath(locale, activeTeamSlug, resolvedActiveSiteSlug)
    : null;
  const normalizedPathname = pathname.endsWith("/")
    ? pathname.slice(0, -1)
    : pathname;

  const sections: Array<{
    key: AnalyticsNavKey;
    href: string;
  }> =
    hasActiveSite && activeSiteBase
      ? [
          { key: "overview", href: activeSiteBase },
          { key: "pages", href: `${activeSiteBase}/pages` },
          { key: "referrers", href: `${activeSiteBase}/referrers` },
          { key: "sessions", href: `${activeSiteBase}/sessions` },
          { key: "events", href: `${activeSiteBase}/events` },
          { key: "visitors", href: `${activeSiteBase}/visitors` },
          { key: "geo", href: `${activeSiteBase}/geo` },
          { key: "devices", href: `${activeSiteBase}/devices` },
          { key: "browsers", href: `${activeSiteBase}/browsers` },
        ]
      : [];

  const localeSuffix = normalizeLocalePath(pathname);
  const switchToEn = `/en${localeSuffix}`;
  const switchToZh = `/zh${localeSuffix}`;
  const teamRootHref = `/${locale}/app/${activeTeamSlug}`;
  const backToTeamLabel = messages.common.backToTeam;
  const teamOptions = teams.map((team) => ({
    slug: team.slug,
    name: team.name,
    href: `/${locale}/app/${team.slug}`,
  }));

  return (
    <SidebarProvider defaultOpen={defaultSidebarOpen}>
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

          {hasTeamSections ? (
            <>
              <SidebarSeparator className="mb-2 group-data-[collapsible=icon]:hidden" />

              <SidebarGroup>
                <SidebarGroupLabel>{messages.common.team}</SidebarGroupLabel>
                <SidebarGroupContent>
                  <SidebarMenu>
                    {teamSections?.map((item) => {
                      const isActive = activeTeamSectionKey === item.key;
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
                          const isActive = activeManagementSectionKey === item.key;
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

              <SidebarGroup className="group-data-[collapsible=icon]:hidden">
                <SidebarGroupLabel>{messages.common.site}</SidebarGroupLabel>
                <SidebarGroupContent>
                  <SidebarMenu>
                    {sites.map((site) => (
                      <SidebarMenuItem key={site.id}>
                        <SidebarMenuButton
                          asChild
                          isActive={
                            hasActiveSite &&
                            site.slug === resolvedActiveSiteSlug
                          }
                          tooltip={site.name}
                        >
                          <Link
                            href={buildSitePath(
                              locale,
                              activeTeamSlug,
                              site.slug,
                            )}
                          >
                            <RiGlobalLine />
                            <span>{site.name}</span>
                          </Link>
                        </SidebarMenuButton>
                      </SidebarMenuItem>
                    ))}
                  </SidebarMenu>
                </SidebarGroupContent>
              </SidebarGroup>

              {sections.length > 0 ? (
                <>
                  <SidebarSeparator className="group-data-[collapsible=icon]:hidden" />

                  <SidebarGroup>
                    <SidebarGroupLabel>Analytics</SidebarGroupLabel>
                    <SidebarGroupContent>
                      <SidebarMenu>
                        {sections.map((item) => {
                          const isActive =
                            item.key === "overview"
                              ? normalizedPathname === item.href
                              : normalizedPathname.startsWith(item.href);
                          const AnalyticsIcon = getAnalyticsSectionIcon(
                            item.key,
                          );
                          return (
                            <SidebarMenuItem key={item.key}>
                              <SidebarMenuButton
                                asChild
                                isActive={isActive}
                                tooltip={messages.navigation[item.key]}
                              >
                                <Link href={item.href}>
                                  <AnalyticsIcon />
                                  <span>{messages.navigation[item.key]}</span>
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
          )}
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
        <div className="sticky top-0 z-20 border-b bg-background/90 p-3 backdrop-blur">
          <SidebarTrigger />
        </div>
        <div className="mx-auto w-full max-w-[1400px] p-4 md:p-6">
          <PageTransition>{children}</PageTransition>
        </div>
      </SidebarInset>
    </SidebarProvider>
  );
}
