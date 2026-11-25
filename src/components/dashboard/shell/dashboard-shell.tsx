import { type ReactNode, useEffect, useLayoutEffect, useMemo } from "react";
import { AutoResizer } from "@insightflare/ui/auto-resizer";
import { AutoTransition } from "@insightflare/ui/auto-transition";
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "@insightflare/ui/breadcrumb";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarSeparator,
  SidebarTrigger,
} from "@insightflare/ui/sidebar";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@insightflare/ui/tooltip";
import { VerticalScrollMask } from "@insightflare/ui/vertical-scroll-mask";
import {
  RiAddLine,
  RiArrowLeftLine,
  RiArrowRightLine,
  RiArrowRightUpLine,
  RiBookOpenLine,
  RiCodeSSlashLine,
  RiDashboardLine,
  RiFeedbackLine,
  RiGithubLine,
  RiNotification3Line,
  RiSettings3Line,
} from "@remixicon/react";

import { AppShellLayout } from "@/components/app-shell-layout";
import { AppSidebarBrand } from "@/components/app-sidebar-brand";
import { TeamSelect } from "@/components/dashboard/admin/team-select";
import { AnalyticsTabs } from "@/components/dashboard/common/analytics-tabs";
import { GlobalPerceptionSearch } from "@/components/dashboard/search/global-search";
import { DashboardHeaderControls } from "@/components/dashboard/shell/dashboard-header-controls";
import { DashboardQueryProvider } from "@/components/dashboard/shell/dashboard-query-provider";
import { SidebarFooterMenus } from "@/components/dashboard/shell/sidebar-footer-menus";
import { SidebarMenuStage } from "@/components/dashboard/shell/sidebar-menu-stage";
import { SidebarSiteDetails } from "@/components/dashboard/shell/sidebar-site-details";
import { useAccountTimeZonePreference } from "@/components/time-zone-provider";
import { APP_WEBSITE_URL } from "@/lib/constants";
import { canManageTeam } from "@/lib/dashboard/permissions";
import {
  parseFilterDocumentFromSearchParams,
  type TimeWindow,
} from "@/lib/dashboard/query-state";
import { buildTeamSections } from "@/lib/dashboard/team-sections";
import {
  type SessionTeamGroups,
  type TeamData,
} from "@/lib/dashboard-api/client/edge";
import {
  type FilterScope,
  parseFilterScopePreference,
} from "@/lib/filter-contract/index";
import type { Locale } from "@/lib/i18n/config";
import type { AppMessages } from "@/lib/i18n/messages";
import {
  SITE_OVERVIEW_METRICS,
  type SiteOverviewMetric,
  type SiteSearchSection,
} from "@/lib/perception-search/core";
import {
  rememberCurrentPerceptionNavigation,
  setPerceptionAuthorization,
} from "@/lib/perception-search/runtime";
import { buildOverviewMetricsLabels } from "@/lib/product-ui-labels/overview";
import Link from "@/lib/router";
import { usePathname, useSearchParams } from "@/lib/router";

import type {
  AnalyticsNavKey,
  SidebarSite,
  TeamSectionNavItem,
} from "./dashboard-shell/navigation";

const sidebarTrailingIconClass =
  "absolute top-1/2 right-2 -translate-y-1/2 text-muted-foreground group-data-[collapsible=icon]:hidden";

import {
  analyticsTabLabel,
  buildSitePath,
  getManagementSectionIcon,
  getTeamRoleIcon,
  getTeamRoleLabel,
  getTeamSectionIcon,
  isWorkspaceSiteSection,
  normalizeLocalePath,
  parseActiveTeamSlugFromPath,
  parseSidebarRouteState,
  rememberWorkspaceSite,
  SIDEBAR_COLLAPSE_SECTION_CLASS,
  SIDEBAR_COLLAPSE_SEPARATOR_CLASS,
  VALID_ANALYTICS_SECTIONS,
} from "./dashboard-shell/navigation";
interface DashboardShellProps {
  locale: Locale;
  pathname: string;
  messages: AppMessages;
  user: {
    id: string;
    username: string;
    name: string;
    email: string;
    systemRole: "admin" | "user";
    timeZone?: string;
  };
  teams: TeamData[];
  teamGroups?: SessionTeamGroups;
  activeTeamSlug?: string;
  authorizedActiveSite?: { id: string; slug: string; name: string };
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
  authorizedActiveSite,
  sites,
  unreadAttentionCount = 0,
  teamSections,
  managementSections,
  initialQueryWindow,
  children,
}: DashboardShellProps) {
  useAccountTimeZonePreference(user.timeZone);
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
  // The matched team route is the authority for its site list. During a
  // navigation the URL may advance before its context, so never issue a second
  // request using a pathname-derived team or reuse another team's sites.
  const resolvedSites =
    activeTeamSlug && activeTeamSlug === liveActiveTeamSlug
      ? (sites ?? [])
      : [];
  const isSidebarSitesLoading = Boolean(activeTeamId && sites === undefined);
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
  const switchToZhTw = `/zh-tw${localeSuffix}`;
  const switchToJa = `/ja${localeSuffix}`;
  const accountHref = `/${locale}/app/account`;
  const notificationsHref = `/${locale}/app/inbox`;
  const appRootHref = `/${locale}/app`;
  const teamRootHref = liveActiveTeamSlug
    ? `/${locale}/app/${liveActiveTeamSlug}`
    : appRootHref;
  const workspace = messages.workspace;
  const helpLinks = [
    {
      label: workspace.documentation,
      href: "https://insightflare.net/docs",
      Icon: RiBookOpenLine,
    },
    {
      label: workspace.apiReference,
      href: "https://insightflare.net/docs/api",
      Icon: RiCodeSSlashLine,
    },
    {
      label: workspace.github,
      href: "https://github.com/RavelloH/InsightFlare",
      Icon: RiGithubLine,
    },
    {
      label: workspace.feedback,
      href: "https://github.com/RavelloH/InsightFlare/issues/new/choose",
      Icon: RiFeedbackLine,
    },
  ];
  const helpMenu = (
    <>
      <hr className="mx-2 border-sidebar-border" />
      <SidebarGroup>
        <SidebarGroupLabel>{workspace.help}</SidebarGroupLabel>
        <SidebarGroupContent>
          <SidebarMenu>
            {helpLinks.map(({ label, href, Icon }) => (
              <SidebarMenuItem key={href}>
                <SidebarMenuButton
                  asChild
                  tooltip={label}
                  className="relative pr-8"
                >
                  <a href={href} target="_blank" rel="noopener noreferrer">
                    <Icon />
                    <RiArrowRightUpLine
                      aria-hidden="true"
                      className={sidebarTrailingIconClass}
                    />
                    <span>{label}</span>
                  </a>
                </SidebarMenuButton>
              </SidebarMenuItem>
            ))}
          </SidebarMenu>
        </SidebarGroupContent>
      </SidebarGroup>
    </>
  );
  const isWorkspace = livePathname.replace(/\/$/, "") === appRootHref;
  const backLabel =
    routeState.mode === "site"
      ? messages.common.backToTeam
      : workspace.backToWorkspace;
  const activeTeamName = liveActiveTeamSlug
    ? activeTeam?.name || liveActiveTeamSlug
    : "";
  const activeSiteName = hasActiveSite
    ? resolvedSites.find((site) => site.slug === resolvedActiveSiteSlug)
        ?.name ||
      (authorizedActiveSite?.slug === resolvedActiveSiteSlug
        ? authorizedActiveSite.name
        : "") ||
      resolvedActiveSiteSlug
    : "";
  const activeSiteId = hasActiveSite
    ? resolvedSites.find((site) => site.slug === resolvedActiveSiteSlug)?.id ||
      (authorizedActiveSite?.slug === resolvedActiveSiteSlug
        ? authorizedActiveSite.id
        : "")
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
  const isSystemPerformanceRoute = Boolean(
    !liveActiveTeamSlug &&
    normalizeLocalePath(livePathname) === "/app/manage/system-performance",
  );
  const systemPerformanceBase = `/${locale}/app/manage/system-performance`;
  const systemPerformanceTabs = messages.systemPerformance.tabs;
  const systemPerformanceSections = useMemo<
    Array<{
      key: AnalyticsNavKey;
      href: string;
      label: string;
      queryKey: string;
      queryValue: string;
      queryDefault?: boolean;
    }>
  >(() => {
    if (!isSystemPerformanceRoute) return [];
    const tab = (
      key: AnalyticsNavKey,
      value: string,
      label: string,
      queryDefault = false,
    ) => ({
      key,
      href: queryDefault
        ? systemPerformanceBase
        : `${systemPerformanceBase}?perfTab=${value}`,
      label,
      queryKey: "perfTab",
      queryValue: value,
      queryDefault,
    });
    return [
      tab("perf-overview", "overview", systemPerformanceTabs.overview, true),
      tab("perf-hotspots", "hotspots", systemPerformanceTabs.hotspots),
      tab("perf-errors", "errors", systemPerformanceTabs.errors),
      tab("perf-samples", "samples", systemPerformanceTabs.samples),
      tab("perf-do", "do", systemPerformanceTabs.durableObjects),
    ];
  }, [isSystemPerformanceRoute, systemPerformanceBase, systemPerformanceTabs]);
  const topbarSections =
    analyticsSections.length > 0
      ? analyticsSections
      : requestObservationSections.length > 0
        ? requestObservationSections
        : systemPerformanceSections;
  const isAdminObservabilityRoute =
    isRequestObservationRoute || isSystemPerformanceRoute;
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

  // The server-authorized dashboard tree is the only authority for local suggestions.
  // On account, team or site changes the runtime immediately rejects stale scopes.
  useLayoutEffect(() => {
    const allowedTeamIds = new Set(teams.map((team) => team.id));
    const allowedSiteIds = new Set(sidebarSites.map((site) => site.id));
    if (authorizedActiveSite?.slug === resolvedActiveSiteSlug) {
      allowedSiteIds.add(authorizedActiveSite.id);
    }
    const teamRoutes = new Map(
      teams.map(
        (team) => [team.id, "/" + locale + "/app/" + team.slug] as const,
      ),
    );
    const siteRoutes = new Map(
      sidebarSites.map(
        (site) =>
          [
            site.id,
            {
              teamId: activeTeamId,
              baseHref: buildSitePath(
                locale,
                liveActiveTeamSlug || "",
                site.slug,
              ),
              sections: new Set<SiteSearchSection>(
                site.id === activeSiteId
                  ? analyticsSections.map((tab) => tab.key as SiteSearchSection)
                  : ["overview"],
              ),
            },
          ] as const,
      ),
    );
    if (
      activeTeamId &&
      activeSiteId &&
      activeSiteBase &&
      !siteRoutes.has(activeSiteId)
    ) {
      siteRoutes.set(activeSiteId, {
        teamId: activeTeamId,
        baseHref: activeSiteBase,
        sections: new Set<SiteSearchSection>(
          analyticsSections.map((tab) => tab.key as SiteSearchSection),
        ),
      });
    }
    const metricLabels = buildOverviewMetricsLabels(messages);
    const metricKeywords: Record<SiteOverviewMetric, string[]> = {
      views: ["views", "pageviews", "pv"],
      visitors: ["visitors", "unique visitors", "uv"],
      sessions: ["sessions", "visits"],
      bounceRate: ["bounceRate", "bounce rate"],
      pagesPerSession: ["pagesPerSession", "pages per session"],
      avgDuration: ["avgDuration", "average duration", "session duration"],
    };
    const navigation = [
      {
        key: "dashboard",
        label: messages.appName,
        target: { kind: "app" as const },
        scope: { userId: user.id },
        group: "workspace" as const,
      },
      ...teams.map((team) => ({
        key: "team:" + team.id,
        label: team.name,
        target: { kind: "team" as const, teamId: team.id },
        scope: { userId: user.id, teamId: team.id },
        group: "team" as const,
        keywords: [team.slug],
      })),
      ...(activeTeamId
        ? sidebarSites.map((site) => ({
            key: "site:" + site.id,
            label: site.name,
            target: {
              kind: "site" as const,
              teamId: activeTeamId,
              siteId: site.id,
              section: "overview" as const,
            },
            scope: { userId: user.id, teamId: activeTeamId, siteId: site.id },
            subtitle: site.domain,
            group: "site" as const,
            keywords: [site.domain, site.slug],
          }))
        : []),
      ...(activeTeamId && activeSiteId && activeSiteBase
        ? [
            ...SITE_OVERVIEW_METRICS.map((metric) => ({
              key: "metric:" + activeSiteId + ":" + metric,
              label: metricLabels[metric],
              target: {
                kind: "site" as const,
                teamId: activeTeamId,
                siteId: activeSiteId,
                section: "overview" as const,
                metric,
              },
              scope: {
                userId: user.id,
                teamId: activeTeamId,
                siteId: activeSiteId,
              },
              subtitle: activeSiteName,
              group: "metric" as const,
              keywords: metricKeywords[metric],
            })),
            ...analyticsSections.map((tab) => ({
              key: "section:" + activeSiteId + ":" + tab.key,
              label: analyticsTabLabel(tab, messages),
              target: {
                kind: "site" as const,
                teamId: activeTeamId,
                siteId: activeSiteId,
                section: tab.key as SiteSearchSection,
              },
              scope: {
                userId: user.id,
                teamId: activeTeamId,
                siteId: activeSiteId,
              },
              subtitle: activeSiteName,
              group: "section" as const,
              keywords: [tab.key],
            })),
          ]
        : []),
    ];
    setPerceptionAuthorization(
      {
        userId: user.id,
        locale,
        allowedTeamIds,
        allowedSiteIds,
        teamRoutes,
        siteRoutes,
        activeTeamId,
        activeSiteId,
        activeSiteBase: activeSiteBase ?? undefined,
      },
      navigation,
    );
  }, [
    user.id,
    locale,
    teams,
    sidebarSites,
    analyticsSections,
    activeTeamId,
    activeSiteId,
    activeSiteBase,
    activeSiteName,
    authorizedActiveSite,
    resolvedActiveSiteSlug,
    appRootHref,
    messages,
  ]);

  useLayoutEffect(() => {
    rememberCurrentPerceptionNavigation(mainSiteSection || "overview");
  }, [user.id, activeTeamId, activeSiteId, mainSiteSection]);

  const recentSiteId = authorizedActiveSite?.id;
  const recentSiteSlug = authorizedActiveSite?.slug;
  const recentSiteName = authorizedActiveSite?.name;
  useEffect(() => {
    if (
      !hasActiveSite ||
      !activeTeamId ||
      !recentSiteId ||
      !recentSiteSlug ||
      !recentSiteName
    )
      return;
    if (!isWorkspaceSiteSection(mainSiteSection)) return;
    rememberWorkspaceSite(user.id, {
      teamId: activeTeamId,
      siteId: recentSiteId,
      siteSlug: recentSiteSlug,
      name: recentSiteName,
      section: mainSiteSection,
    });
  }, [
    hasActiveSite,
    activeTeamId,
    recentSiteId,
    recentSiteSlug,
    recentSiteName,
    mainSiteSection,
    user.id,
  ]);

  const teamSelector = (
    <SidebarGroup className={SIDEBAR_COLLAPSE_SECTION_CLASS}>
      <SidebarGroupContent className="flex flex-col gap-2">
        {liveActiveTeamSlug ? (
          <TeamSelect
            locale={locale}
            messages={messages}
            options={teamOptions}
            groups={teamOptionGroups}
            activeTeamSlug={liveActiveTeamSlug}
          />
        ) : null}
        <GlobalPerceptionSearch
          locale={locale}
          messages={messages}
          section={mainSiteSection || "overview"}
          siteDomain={
            resolvedSites.find((site) => site.id === activeSiteId)?.domain
          }
          siteName={activeSiteName ?? undefined}
        />
      </SidebarGroupContent>
    </SidebarGroup>
  );

  return (
    <DashboardQueryProvider
      scopeKey={activeSiteId}
      maxRangeDays={isAdminObservabilityRoute ? 90 : undefined}
      initialWindow={initialQueryWindow}
      initialFilters={initialFilters}
      initialScopePreference={initialScopePreference}
    >
      <AppShellLayout
        sidebar={
          <Sidebar variant="inset" collapsible="icon">
            <SidebarHeader>
              <AppSidebarBrand
                href={APP_WEBSITE_URL}
                target="_blank"
                rel="noopener noreferrer"
                appName={messages.appName}
                suffix={import.meta.env.VITE_DEMO_MODE === "1" ? "Demo" : "v1"}
              />
            </SidebarHeader>

            <div className="shrink-0">
              {teamSelector}

              {routeState.mode !== "root" ? (
                <>
                  <SidebarGroup>
                    <SidebarGroupContent>
                      <SidebarMenu>
                        <SidebarMenuItem>
                          <SidebarMenuButton asChild tooltip={backLabel}>
                            <Link
                              href={
                                routeState.mode === "site"
                                  ? teamRootHref
                                  : appRootHref
                              }
                            >
                              <RiArrowLeftLine />
                              <span>{backLabel}</span>
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
                        <SidebarGroupContent>
                          <SidebarMenu>
                            <SidebarMenuItem>
                              <SidebarMenuButton
                                asChild
                                isActive={isWorkspace}
                                tooltip={workspace.title}
                              >
                                <Link
                                  href={appRootHref}
                                  aria-current={
                                    isWorkspace ? "page" : undefined
                                  }
                                >
                                  <RiDashboardLine />
                                  <span>{workspace.title}</span>
                                </Link>
                              </SidebarMenuButton>
                            </SidebarMenuItem>
                          </SidebarMenu>
                        </SidebarGroupContent>
                      </SidebarGroup>
                      {teams.length > 0 ? (
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
                                    <SidebarMenuButton
                                      asChild
                                      tooltip={team.name}
                                      className="relative pr-8"
                                    >
                                      <Link
                                        href={`/${locale}/app/${team.slug}`}
                                      >
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
                                        <RiArrowRightLine
                                          aria-hidden="true"
                                          className={sidebarTrailingIconClass}
                                        />
                                        <span>{team.name}</span>
                                      </Link>
                                    </SidebarMenuButton>
                                  </SidebarMenuItem>
                                );
                              })}
                            </SidebarMenu>
                          </SidebarGroupContent>
                        </SidebarGroup>
                      ) : null}

                      <DashboardSidebarEntry
                        label={workspace.personalDashboards}
                        createLabel={workspace.newDashboard}
                      />
                      <SidebarGroup>
                        <SidebarGroupLabel>
                          {workspace.personal}
                        </SidebarGroupLabel>
                        <SidebarGroupContent>
                          <SidebarMenu>
                            <SidebarMenuItem>
                              <SidebarMenuButton
                                asChild
                                isActive={
                                  routeState.activeRootSectionKey === "inbox"
                                }
                                tooltip={messages.notificationCenter.title}
                              >
                                <Link href={notificationsHref}>
                                  <RiNotification3Line />
                                  <span>
                                    {messages.notificationCenter.title}
                                  </span>
                                  {unreadAttentionCount > 0 ? (
                                    <span className="ml-auto text-xs tabular-nums text-primary">
                                      {unreadAttentionCount > 99
                                        ? "99+"
                                        : unreadAttentionCount}
                                    </span>
                                  ) : null}
                                </Link>
                              </SidebarMenuButton>
                            </SidebarMenuItem>
                            <SidebarMenuItem>
                              <SidebarMenuButton
                                asChild
                                isActive={
                                  routeState.activeRootSectionKey === "account"
                                }
                                tooltip={messages.accountSettings.title}
                              >
                                <Link href={accountHref}>
                                  <RiSettings3Line />
                                  <span>{messages.accountSettings.title}</span>
                                </Link>
                              </SidebarMenuButton>
                            </SidebarMenuItem>
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
                              {workspace.systemManagement}
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
                      {helpMenu}
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
                                    const SectionIcon = getTeamSectionIcon(
                                      item.key,
                                    );
                                    return (
                                      <SidebarMenuItem key={item.key}>
                                        <SidebarMenuButton
                                          asChild
                                          isActive={
                                            routeState.activeTeamSectionKey ===
                                            item.key
                                          }
                                          tooltip={item.label}
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
                            <DashboardSidebarEntry
                              label={workspace.teamDashboards}
                              createLabel={workspace.newDashboard}
                            />
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
                        {routeState.mode === "team" ? helpMenu : null}
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
                switchToZhTw={switchToZhTw}
                switchToJa={switchToJa}
                accountHref={accountHref}
                notificationsHref={notificationsHref}
                unreadAttentionCount={unreadAttentionCount}
                messages={messages}
              />
            </SidebarFooter>
          </Sidebar>
        }
        header={
          <>
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
                <div className="ml-auto flex min-w-0 items-center gap-1">
                  <DashboardHeaderControls
                    locale={locale}
                    messages={messages}
                    siteId={activeSiteId}
                    resolvedScope={dashboardFilterResolvedScope}
                    showControls={
                      Boolean(liveActiveTeamSlug) ||
                      isAdminObservabilityRoute ||
                      isWorkspace
                    }
                    showFilterSheet={hasActiveSite}
                    comparisonDisabled={
                      hasActiveSite && isComparisonDisabledRoute
                    }
                    filterDisabled={isRealtimeRoute}
                    showRealtimeBadge={!isAdminObservabilityRoute}
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
          </>
        }
        contentClassName={contentContainerClassName}
        contentDataAttributes={{ "data-dashboard-content": "" }}
      >
        {children}
      </AppShellLayout>
    </DashboardQueryProvider>
  );
}

function DashboardSidebarEntry({
  label,
  createLabel,
}: {
  label: string;
  createLabel: string;
}) {
  return (
    <SidebarGroup>
      <SidebarGroupLabel>{label}</SidebarGroupLabel>
      <SidebarGroupContent>
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton
              type="button"
              aria-disabled="true"
              tooltip={createLabel}
              className="aria-disabled:pointer-events-auto aria-disabled:opacity-100"
            >
              <RiAddLine />
              <span>{createLabel}</span>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarGroupContent>
    </SidebarGroup>
  );
}
