import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { RiArrowLeftLine } from "@remixicon/react";
import { OverlayScrollbars } from "overlayscrollbars";

import { TeamSelect } from "@/components/dashboard/admin/team-select";
import { AnalyticsTabs } from "@/components/dashboard/common/analytics-tabs";
import { DashboardHeaderControls } from "@/components/dashboard/shell/dashboard-header-controls";
import { DashboardQueryProvider } from "@/components/dashboard/shell/dashboard-query-provider";
import { SidebarFooterMenus } from "@/components/dashboard/shell/sidebar-footer-menus";
import { SidebarMenuStage } from "@/components/dashboard/shell/sidebar-menu-stage";
import { SidebarSiteDetails } from "@/components/dashboard/shell/sidebar-site-details";
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
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { VerticalScrollMask } from "@/components/ui/vertical-scroll-mask";
import { canManageTeam } from "@/lib/dashboard/permissions";
import {
  parseFilterDocumentFromSearchParams,
  type TimeWindow,
} from "@/lib/dashboard/query-state";
import { buildTeamSections } from "@/lib/dashboard/team-sections";
import { requestAdminService } from "@/lib/dashboard-api/client/admin-service";
import {
  type SessionTeamGroups,
  type SiteData,
  type TeamData,
} from "@/lib/dashboard-api/client/edge";
import {
  type FilterScope,
  parseFilterScopePreference,
} from "@/lib/filter-contract/index";
import type { Locale } from "@/lib/i18n/config";
import type { AppMessages } from "@/lib/i18n/messages";
import Image from "@/lib/image";
import Link from "@/lib/router";
import { usePathname, useSearchParams } from "@/lib/router";

import type {
  AnalyticsNavKey,
  SidebarSite,
  TeamSectionNavItem,
} from "./dashboard-shell/navigation";
import {
  analyticsTabLabel,
  buildSitePath,
  DASHBOARD_SCROLLBAR_OPTIONS,
  getManagementSectionIcon,
  getTeamRoleIcon,
  getTeamRoleLabel,
  getTeamSectionIcon,
  normalizeLocalePath,
  parseActiveTeamSlugFromPath,
  parseSidebarRouteState,
  SIDEBAR_COLLAPSE_MARGIN_CLASS,
  SIDEBAR_COLLAPSE_SECTION_CLASS,
  SIDEBAR_COLLAPSE_SEPARATOR_CLASS,
  toSidebarSite,
  VALID_ANALYTICS_SECTIONS,
} from "./dashboard-shell/navigation";
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
  initialQueryWindow?: TimeWindow;
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
  initialQueryWindow,
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
  const routeSearchParams = useSearchParams();
  const initialFilters = parseFilterDocumentFromSearchParams(routeSearchParams);
  const initialScopePreference = parseFilterScopePreference(routeSearchParams);
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
  const isSidebarSitesLoading = Boolean(
    activeTeamId &&
    sites.length === 0 &&
    !Object.prototype.hasOwnProperty.call(clientSitesByTeam, activeTeamId),
  );
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
  const routeState = useMemo(
    () => parseSidebarRouteState(livePathname, liveActiveTeamSlug),
    [liveActiveTeamSlug, livePathname],
  );
  const activeTeamLocalPath = useMemo(() => {
    if (!liveActiveTeamSlug) return [];
    const segments = livePathname.split("/").filter((s) => s.length > 0);
    const teamIndex = segments.findIndex(
      (segment, index) =>
        segment === liveActiveTeamSlug &&
        index > 0 &&
        segments[index - 1] === "app",
    );
    return teamIndex >= 0 ? segments.slice(teamIndex + 1) : [];
  }, [liveActiveTeamSlug, livePathname]);
  const mainSiteSection = activeTeamLocalPath[1] || "";
  const mainSiteSubSection = activeTeamLocalPath[2] || "";

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
  const dashboardFilterResolvedScope: FilterScope | undefined =
    currentAnalyticsSection === "sessions"
      ? "session"
      : currentAnalyticsSection === "visitors"
        ? "visitor"
        : currentAnalyticsSection === "realtime"
          ? undefined
          : hasActiveSite
            ? "event"
            : undefined;
  const activeSiteBase =
    hasActiveSite && liveActiveTeamSlug
      ? buildSitePath(locale, liveActiveTeamSlug, resolvedActiveSiteSlug)
      : null;
  const canManageActiveTeam = Boolean(
    activeTeam && canManageTeam(activeTeam.membershipRole, user.systemRole),
  );

  const analyticsSections = useMemo<
    Array<{
      key: AnalyticsNavKey;
      href: string;
      label?: string;
      queryKey?: string;
      queryValue?: string;
      queryDefault?: boolean;
    }>
  >(
    () =>
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
            { key: "goals", href: `${activeSiteBase}/goals` },
            { key: "retention", href: `${activeSiteBase}/retention` },
            { key: "geo", href: `${activeSiteBase}/geo` },
            { key: "devices", href: `${activeSiteBase}/devices` },
            { key: "browsers", href: `${activeSiteBase}/browsers` },
            { key: "performance", href: `${activeSiteBase}/performance` },
            ...(canManageActiveTeam
              ? [
                  {
                    key: "settings" as const,
                    href: `${activeSiteBase}/settings`,
                  },
                ]
              : []),
          ]
        : [],
    [activeSiteBase, canManageActiveTeam, hasActiveSite],
  );
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
  const isComparisonDisabledRoute = [
    "realtime",
    "sessions",
    "visitors",
  ].includes(mainSiteSection);
  const isRequestObservationRoute = Boolean(
    !liveActiveTeamSlug &&
    normalizeLocalePath(livePathname) === "/app/manage/request-observation",
  );
  const requestObservationBase = `/${locale}/app/manage/request-observation`;
  const requestObservationSections = useMemo<
    Array<{
      key: AnalyticsNavKey;
      href: string;
      label: string;
      queryKey: string;
      queryValue: string;
      queryDefault?: boolean;
    }>
  >(
    () =>
      isRequestObservationRoute
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
              href: `${requestObservationBase}?requestTab=blocked`,
              label: messages.requestObservation.tabs.blocked,
              queryKey: "requestTab",
              queryValue: "blocked",
            },
            {
              key: "request-normal",
              href: `${requestObservationBase}?requestTab=included`,
              label: messages.requestObservation.tabs.included,
              queryKey: "requestTab",
              queryValue: "included",
            },
          ]
        : [],
    [
      isRequestObservationRoute,
      messages.requestObservation.tabs.blocked,
      messages.requestObservation.tabs.included,
      messages.requestObservation.tabs.overview,
      requestObservationBase,
    ],
  );
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
  const teamOptions = useMemo(
    () =>
      teams.map((team) => ({
        slug: team.slug,
        name: team.name,
        href: `/${locale}/app/${team.slug}`,
      })),
    [locale, teams],
  );
  const teamOptionGroups = useMemo(
    () =>
      teamGroups
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
        : undefined,
    [locale, teamGroups],
  );
  const sidebarSites = useMemo(
    () =>
      resolvedSites.map((site) => ({
        id: site.id,
        slug: site.slug,
        name: site.name,
        domain: site.domain,
        iconPath: site.iconPath,
      })),
    [resolvedSites],
  );
  const sidebarLabels = useMemo(
    () => ({
      views: messages.common.views,
      visitors: messages.common.visitors,
    }),
    [messages.common.visitors, messages.common.views],
  );
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
    requestAdminService<SiteData[]>("sites", {
      params: { teamId: activeTeamId },
    })
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
        initialWindow={initialQueryWindow}
        initialFilters={initialFilters}
        initialScopePreference={initialScopePreference}
      >
        <Sidebar variant="inset" collapsible="icon">
          <SidebarHeader>
            <Link
              href="https://github.com/RavelloH/InsightFlare"
              target="_black"
              className="relative block h-10 overflow-hidden"
            >
              <div className="absolute inset-y-0 left-0 flex items-center whitespace-nowrap transition-[opacity,transform] duration-[380ms] ease-[cubic-bezier(0.4,0,0.2,1)] group-data-[collapsible=icon]:-translate-x-2 group-data-[collapsible=icon]:opacity-0 motion-reduce:transition-none">
                <p className="flex items-center justify-center gap-2 text-xl text-primary md:justify-start">
                  <span>{messages.appName}</span>
                  <span className="text-muted-foreground">
                    {import.meta.env.VITE_DEMO_MODE === "1" ? "Demo" : "v1"}
                  </span>
                </p>
              </div>
              <div className="absolute inset-y-0 left-0 flex w-8 items-center justify-center opacity-0 transition-[opacity,transform] duration-[380ms] ease-[cubic-bezier(0.4,0,0.2,1)] group-data-[collapsible=icon]:opacity-100 motion-reduce:transition-none">
                <Image
                  src="/android-chrome-192x192.png"
                  alt={messages.appName}
                  width={192}
                  height={192}
                  className="size-6"
                  priority
                />
              </div>
            </Link>
          </SidebarHeader>

          <div className="shrink-0">
            {teamSelector}

            {routeState.mode === "site" ? (
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
                  className={`!mx-2 !w-auto ${SIDEBAR_COLLAPSE_SEPARATOR_CLASS}`}
                />
              </>
            ) : null}
          </div>

          <VerticalScrollMask
            className="min-h-0 flex-1"
            contentClassName="flex min-h-0 flex-col"
            maskClassName="from-sidebar via-sidebar/80 to-transparent"
            syncKey={`${routeState.mode}:${liveActiveTeamSlug ?? "root"}:${resolvedSites.length}`}
          >
            <SidebarContent className="flex-none overflow-hidden">
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
                            const RoleIcon = getTeamRoleIcon(
                              team.membershipRole,
                            );
                            const roleLabel = getTeamRoleLabel(
                              messages,
                              team.membershipRole,
                            );
                            return (
                              <SidebarMenuItem key={team.id}>
                                <SidebarMenuButton asChild>
                                  <Link href={`/${locale}/app/${team.slug}`}>
                                    <Tooltip>
                                      <TooltipTrigger asChild>
                                        <span
                                          aria-label={roleLabel}
                                          className={
                                            team.membershipRole === "owner"
                                              ? "text-primary"
                                              : undefined
                                          }
                                        >
                                          <RoleIcon aria-hidden="true" />
                                        </span>
                                      </TooltipTrigger>
                                      <TooltipContent side="right">
                                        {roleLabel}
                                      </TooltipContent>
                                    </Tooltip>
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
                                    routeState.activeTeamSectionKey ===
                                    item.key;
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
                                sites={sidebarSites}
                                loading={isSidebarSitesLoading}
                                loadingLabel={messages.common.loading}
                                labels={sidebarLabels}
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
          </VerticalScrollMask>

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
                    resolvedScope={dashboardFilterResolvedScope}
                    showControls={
                      Boolean(liveActiveTeamSlug) || isRequestObservationRoute
                    }
                    showFilterSheet={hasActiveSite}
                    comparisonDisabled={
                      hasActiveSite && isComparisonDisabledRoute
                    }
                    filterDisabled={isRealtimeRoute}
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
