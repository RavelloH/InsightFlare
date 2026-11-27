import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { toast } from "sonner";

import { useDashboardTimeQuery } from "@/components/dashboard/shell/dashboard-query-provider";
import { useHydrated } from "@/hooks/use-hydrated";
import { intlLocale } from "@/lib/dashboard/format";
import {
  type CreatedTeamInviteData,
  managementQueryOptions,
  type TeamInviteData,
  type TeamManagementInitialData,
} from "@/lib/dashboard/management-data";
import { canAdministerTeam, canManageTeam } from "@/lib/dashboard/permissions";
import {
  buildTeamAggregateTrend,
  buildTeamSiteTrends,
  sameTeamDashboardWindow,
  teamDashboardQueryOptions,
  type TeamDashboardSite,
  type TeamDashboardSnapshot,
} from "@/lib/dashboard/team-dashboard-query";
import {
  fetchMemberDepartureImpact,
  type MemberData,
  type SiteData,
  type TeamData,
} from "@/lib/dashboard-api/client/edge";
import { navigateWithTransition } from "@/lib/page-transition";
import { useRouter } from "@/lib/router";

import {
  buildSitePath,
  emptyOverviewMetrics,
  emptySiteMetricChangeRates,
  fetchTeamInvites,
  fetchTeamMembers,
  fetchTeamSites,
  getSiteSlug,
  postJson,
  sortSitesForInitialOrder,
  withSiteSlug,
} from "./model";
import type { TeamManagementClientProps } from "./types";
export function teamManagementQueryOptions(
  userId: string,
  teamId: string,
  canManage: boolean,
  deferred?: Promise<TeamManagementInitialData | null> | null,
  retainInFlight = false,
) {
  return managementQueryOptions(
    ["dashboard", "team-management-data", teamId, canManage, userId],
    async (signal) => {
      const [members, invites, sites] = await Promise.all([
        fetchTeamMembers(teamId, signal),
        canManage ? fetchTeamInvites(teamId, signal) : Promise.resolve([]),
        canManage ? fetchTeamSites(teamId, signal) : Promise.resolve([]),
      ]);
      return { members, invites, sites, fetchedAt: Date.now() };
    },
    (snapshot: TeamManagementInitialData) => snapshot,
    deferred,
    retainInFlight,
  );
}
export function useTeamManagement({
  locale,
  messages,
  activeTeam,
  activeTab,
  systemRole,
  currentUserId,
  teamDashboardSnapshot = null,
  authorizedSites,
  deferredDashboardSnapshot,
  teamManagementInitialData = null,
  deferredManagementData,
}: TeamManagementClientProps) {
  const router = useRouter();
  const hydrated = useHydrated();

  const { window: selectedWindow, queryReady } = useDashboardTimeQuery();
  const consumedDeferred = useRef<Promise<TeamDashboardSnapshot | null> | null>(
    null,
  );

  const canUseInitialSnapshotWindow =
    teamDashboardSnapshot &&
    selectedWindow.preset === teamDashboardSnapshot.range &&
    selectedWindow.interval === teamDashboardSnapshot.window.interval &&
    selectedWindow.timeZone === teamDashboardSnapshot.window.timeZone &&
    (selectedWindow.preset !== "custom" ||
      (selectedWindow.from === teamDashboardSnapshot.window.from &&
        selectedWindow.to === teamDashboardSnapshot.window.to));

  const window = canUseInitialSnapshotWindow
    ? {
        ...teamDashboardSnapshot.window,
        preset: selectedWindow.preset,
      }
    : selectedWindow;

  const copy = messages.teamManagement;

  const siteCreateCopy = messages.adminSites;

  const [sites, setSites] = useState<Array<SiteData & { slug: string }>>(() =>
    (teamManagementInitialData?.sites ?? authorizedSites ?? []).map(
      withSiteSlug,
    ),
  );

  const [members, setMembers] = useState<MemberData[]>(
    () => teamManagementInitialData?.members ?? [],
  );

  const [loading, setLoading] = useState(!teamManagementInitialData);

  const [createSiteDialogOpen, setCreateSiteDialogOpen] = useState(false);

  const [createSiteName, setCreateSiteName] = useState("");

  const [createSiteDomain, setCreateSiteDomain] = useState("");

  const [createSitePublicSlug, setCreateSitePublicSlug] = useState("");

  const [createSiteError, setCreateSiteError] = useState("");

  const [creatingSite, setCreatingSite] = useState(false);

  const [currentTeamName, setCurrentTeamName] = useState(activeTeam.name);

  const [teamName, setTeamName] = useState(activeTeam.name);

  const [teamSlug, setTeamSlug] = useState(activeTeam.slug);

  const [invites, setInvites] = useState<TeamInviteData[]>(
    () => teamManagementInitialData?.invites ?? [],
  );

  const [inviteEmail, setInviteEmail] = useState("");

  const [inviteRole, setInviteRole] = useState<"admin" | "member">("member");

  const [inviteSiteIds, setInviteSiteIds] = useState<string[]>([]);

  const [inviteSiteAccessDialogOpen, setInviteSiteAccessDialogOpen] =
    useState(false);

  const [inviteExpiresInHours, setInviteExpiresInHours] = useState("72");

  const [latestInviteUrl, setLatestInviteUrl] = useState("");

  const [savingTeam, setSavingTeam] = useState(false);

  const [deletingTeam, setDeletingTeam] = useState(false);

  const [deleteTeamDialogOpen, setDeleteTeamDialogOpen] = useState(false);

  const [creatingInvite, setCreatingInvite] = useState(false);

  const [revokingInviteId, setRevokingInviteId] = useState<string | null>(null);

  const [revokeInviteTarget, setRevokeInviteTarget] =
    useState<TeamInviteData | null>(null);

  const [removingMemberId, setRemovingMemberId] = useState<string | null>(null);

  const [removeMemberTarget, setRemoveMemberTarget] =
    useState<MemberData | null>(null);
  const removeMemberImpactQuery = useQuery({
    queryKey: [
      "team-member-departure-impact",
      activeTeam.id,
      removeMemberTarget?.userId ?? null,
    ],
    queryFn: ({ signal }) =>
      fetchMemberDepartureImpact(
        activeTeam.id,
        removeMemberTarget?.userId ?? "",
        { signal },
      ),
    enabled: Boolean(removeMemberTarget),
    staleTime: 0,
    gcTime: 0,
  });
  const removeMemberImpact = removeMemberTarget
    ? (removeMemberImpactQuery.data ?? null)
    : null;

  const [changingRoleId, setChangingRoleId] = useState<string | null>(null);

  const [savingSiteAccessId, setSavingSiteAccessId] = useState<string | null>(
    null,
  );

  const [siteAccessDialogMember, setSiteAccessDialogMember] =
    useState<MemberData | null>(null);

  const [editingSiteIds, setEditingSiteIds] = useState<string[]>([]);

  const [transferTargetId, setTransferTargetId] = useState<string>("");

  const [transferring, setTransferring] = useState(false);

  const [transferDialogOpen, setTransferDialogOpen] = useState(false);

  const canManage = canManageTeam(activeTeam.membershipRole, systemRole);

  const canAdminister = canAdministerTeam(
    activeTeam.membershipRole,
    systemRole,
  );

  const canManageSites = canManage;

  const isRealOwner = activeTeam.ownerUserId === currentUserId;

  const previousTeamIdRef = useRef<string | null>(null);

  const managementDataQuery = useQuery({
    ...teamManagementQueryOptions(
      currentUserId,
      activeTeam.id,
      canManage,
      deferredManagementData,
    ),
    enabled: hydrated && (activeTab === "settings" || activeTab === "members"),
    initialData: teamManagementInitialData ?? undefined,
    initialDataUpdatedAt: teamManagementInitialData?.fetchedAt,
  });

  const managementUnavailable = Boolean(
    managementDataQuery.isError && !managementDataQuery.data,
  );

  const dashboardQuery = useQuery(
    teamDashboardQueryOptions({
      teamId: activeTeam.id,
      window,
      range: selectedWindow.preset,
      snapshot: teamDashboardSnapshot,
      enabled: hydrated && queryReady && activeTab === "sites",
      readDeferredSnapshot: () => {
        const deferred = deferredDashboardSnapshot;
        if (
          !deferred ||
          consumedDeferred.current === deferred.promise ||
          !sameTeamDashboardWindow(deferred.window, window)
        )
          return undefined;
        consumedDeferred.current = deferred.promise;
        return deferred.promise;
      },
    }),
  );

  const dashboardSnapshot = dashboardQuery.data;

  const dashboardData = dashboardSnapshot?.data;

  const dashboardWindow = dashboardSnapshot?.window ?? window;

  const dashboardSites = useMemo(() => {
    const sites: readonly TeamDashboardSite[] =
      dashboardData?.sites ??
      (authorizedSites ?? []).map((site) => ({
        ...site,
        overview: emptyOverviewMetrics(),
        changeRates: emptySiteMetricChangeRates(),
      }));
    return sortSitesForInitialOrder(sites.map((site) => withSiteSlug(site)));
  }, [dashboardData?.sites, authorizedSites]);
  const dashboardMetricsPending = !dashboardData && dashboardQuery.isPending;
  const dashboardMetricsUnavailable =
    !dashboardData && !dashboardQuery.isPending;

  const transferableMembers = useMemo(
    () => members.filter((m) => m.userId !== activeTeam.ownerUserId),
    [members, activeTeam.ownerUserId],
  );

  useEffect(() => {
    if (activeTab !== "settings" && activeTab !== "members") return;
    setLoading(managementDataQuery.isPending);
    if (managementDataQuery.isPending || !managementDataQuery.data) return;
    const data = managementDataQuery.data;
    setMembers(data?.members ?? []);
    setInvites(data?.invites ?? []);
    setSites((data?.sites ?? []).map(withSiteSlug));
  }, [activeTab, managementDataQuery.data, managementDataQuery.isPending]);

  useEffect(() => {
    const previousTeamId = previousTeamIdRef.current;
    previousTeamIdRef.current = activeTeam.id;
    if (!previousTeamId || previousTeamId === activeTeam.id) return;
    setCreateSiteDialogOpen(false);
    setCreateSiteName("");
    setCreateSiteDomain("");
    setCreateSitePublicSlug("");
    setCreateSiteError("");
    setCurrentTeamName(activeTeam.name);
    setTeamName(activeTeam.name);
    setTeamSlug(activeTeam.slug);
    setInviteEmail("");
    setInviteRole("member");
    setInviteSiteIds([]);
    setInviteSiteAccessDialogOpen(false);
    setInviteExpiresInHours("72");
    setLatestInviteUrl("");
    setSites([]);
    setMembers([]);
    setInvites([]);
    setTransferTargetId("");
    setTransferDialogOpen(false);
    setSiteAccessDialogMember(null);
    setEditingSiteIds([]);
  }, [activeTeam.id, activeTeam.name, activeTeam.slug]);

  useEffect(() => {
    if (activeTab === "sites" || activeTab === "settings") return;
    setLoading(false);
  }, [activeTab]);

  async function refreshMembers() {
    await managementDataQuery.refetch();
  }

  async function refreshInvites() {
    await managementDataQuery.refetch();
  }

  function toggleInviteSite(siteId: string, checked: boolean) {
    setInviteSiteIds((current) => {
      if (checked) {
        return current.includes(siteId) ? current : [...current, siteId];
      }
      return current.filter((id) => id !== siteId);
    });
  }

  function toggleEditingSite(siteId: string, checked: boolean) {
    setEditingSiteIds((current) => {
      if (checked) {
        return current.includes(siteId) ? current : [...current, siteId];
      }
      return current.filter((id) => id !== siteId);
    });
  }

  async function handleCreateSite() {
    const team = activeTeam;
    const name = createSiteName.trim();
    const domain = createSiteDomain.trim();
    const publicSlug = createSitePublicSlug.trim();

    if (!team?.id) return;
    if (name.length < 2 || domain.length < 3) {
      setCreateSiteError(siteCreateCopy.invalidInput);
      toast.error(siteCreateCopy.invalidInput);
      return;
    }

    setCreatingSite(true);
    setCreateSiteError("");
    try {
      const created = await postJson<SiteData>("sites", {
        teamId: team.id,
        name,
        domain,
        publicSlug: publicSlug || undefined,
      });
      setCreateSiteDialogOpen(false);
      setCreateSiteName("");
      setCreateSiteDomain("");
      setCreateSitePublicSlug("");
      toast.success(siteCreateCopy.createSuccess);
      navigateWithTransition(
        router,
        `${buildSitePath(locale, team.slug, getSiteSlug(created))}/settings`,
      );
      router.refresh();
    } catch (error) {
      const message =
        error instanceof Error ? error.message : siteCreateCopy.createFailed;
      setCreateSiteError(message || siteCreateCopy.createFailed);
      toast.error(message || siteCreateCopy.createFailed);
    } finally {
      setCreatingSite(false);
    }
  }

  async function handleSaveTeamSettings() {
    const name = teamName.trim();
    const slug = teamSlug.trim();
    if (name.length < 2) {
      toast.error(copy.toasts.invalidTeamName);
      return;
    }

    setSavingTeam(true);
    try {
      const updated = await postJson<TeamData>(
        "teams",
        {
          teamId: activeTeam.id,
          name,
          slug: slug || undefined,
        },
        "PATCH",
      );
      setCurrentTeamName(updated.name);
      setTeamName(updated.name);
      setTeamSlug(updated.slug);
      toast.success(copy.toasts.teamSaved);

      if (updated.slug !== activeTeam.slug) {
        navigateWithTransition(router, `/${locale}/app/${updated.slug}`);
      } else {
        router.refresh();
      }
    } catch (error) {
      const message =
        error instanceof Error ? error.message : copy.toasts.teamSaveFailed;
      toast.error(message || copy.toasts.teamSaveFailed);
    } finally {
      setSavingTeam(false);
    }
  }

  async function handleCreateInvite() {
    if (loading || managementUnavailable) return;
    const email = inviteEmail.trim();
    const expiresInHours = Number(inviteExpiresInHours);
    if (email.length > 0 && !email.includes("@")) {
      toast.error(copy.toasts.invalidInviteEmail);
      return;
    }
    if (!Number.isFinite(expiresInHours) || expiresInHours < 1) {
      toast.error(copy.toasts.invalidInviteExpiry);
      return;
    }

    setCreatingInvite(true);
    try {
      const created = await postJson<CreatedTeamInviteData>("team-invites", {
        teamId: activeTeam.id,
        email: email || undefined,
        role: inviteRole,
        siteIds: inviteRole === "member" ? inviteSiteIds : [],
        expiresInHours,
      });
      setInviteEmail("");
      setInviteRole("member");
      setInviteSiteIds([]);
      setInviteSiteAccessDialogOpen(false);
      setInviteExpiresInHours("72");
      setLatestInviteUrl(created.url);
      await refreshInvites();
      toast.success(copy.toasts.inviteCreated);
    } catch (error) {
      const message =
        error instanceof Error ? error.message : copy.toasts.inviteCreateFailed;
      toast.error(message || copy.toasts.inviteCreateFailed);
    } finally {
      setCreatingInvite(false);
    }
  }

  async function handleRevokeInvite(inviteId: string) {
    setRevokingInviteId(inviteId);
    try {
      await postJson<TeamInviteData>(
        "team-invites",
        {
          intent: "revoke",
          inviteId,
          teamId: activeTeam.id,
        },
        "PATCH",
      );
      await refreshInvites();
      setRevokeInviteTarget(null);
      toast.success(copy.toasts.inviteRevoked);
    } catch (error) {
      const message =
        error instanceof Error ? error.message : copy.toasts.inviteRevokeFailed;
      toast.error(message || copy.toasts.inviteRevokeFailed);
    } finally {
      setRevokingInviteId(null);
    }
  }

  async function handleCopyLatestInviteUrl() {
    if (!latestInviteUrl) return;
    try {
      await navigator.clipboard.writeText(latestInviteUrl);
      toast.success(copy.toasts.inviteCopied);
    } catch {
      toast.error(copy.toasts.inviteCopyFailed);
    }
  }

  async function handleCopyInviteUrl(invite: TeamInviteData) {
    if (!invite.url) return;
    try {
      await navigator.clipboard.writeText(invite.url);
      toast.success(copy.toasts.inviteCopied);
    } catch {
      toast.error(copy.toasts.inviteCopyFailed);
    }
  }

  async function handleDeleteTeam() {
    setDeletingTeam(true);
    try {
      await postJson(
        "teams",
        {
          intent: "remove",
          teamId: activeTeam.id,
        },
        "PATCH",
      );
      toast.success(copy.toasts.teamDeleted);
      setDeleteTeamDialogOpen(false);
      navigateWithTransition(router, `/${locale}/app`);
      router.refresh();
    } catch (error) {
      const message =
        error instanceof Error ? error.message : copy.toasts.teamDeleteFailed;
      toast.error(message || copy.toasts.teamDeleteFailed);
    } finally {
      setDeletingTeam(false);
    }
  }

  async function handleTransferOwner() {
    if (loading || managementUnavailable) return;
    if (!transferTargetId) {
      toast.error(copy.toasts.invalidTransferTarget);
      return;
    }
    setTransferring(true);
    try {
      await postJson<TeamData>(
        "teams",
        {
          intent: "transfer_owner",
          teamId: activeTeam.id,
          newOwnerUserId: transferTargetId,
        },
        "PATCH",
      );
      toast.success(copy.toasts.ownerTransferred);
      setTransferDialogOpen(false);
      setTransferTargetId("");
      await refreshMembers();
      router.refresh();
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : copy.toasts.ownerTransferFailed;
      toast.error(message || copy.toasts.ownerTransferFailed);
    } finally {
      setTransferring(false);
    }
  }

  async function handleChangeMemberRole(
    userId: string,
    nextRole: "admin" | "member",
  ) {
    setChangingRoleId(userId);
    try {
      await postJson(
        "members",
        {
          intent: "update_role",
          teamId: activeTeam.id,
          userId,
          role: nextRole,
        },
        "PATCH",
      );
      await refreshMembers();
      toast.success(copy.toasts.roleChanged);
    } catch (error) {
      const message =
        error instanceof Error ? error.message : copy.toasts.roleChangeFailed;
      toast.error(message || copy.toasts.roleChangeFailed);
    } finally {
      setChangingRoleId(null);
    }
  }

  async function handleSaveMemberSiteAccess() {
    if (!siteAccessDialogMember) return;
    const userId = siteAccessDialogMember.userId;
    setSavingSiteAccessId(userId);
    try {
      await postJson(
        "members",
        {
          intent: "update_site_access",
          teamId: activeTeam.id,
          userId,
          siteIds: editingSiteIds,
        },
        "PATCH",
      );
      await refreshMembers();
      setSiteAccessDialogMember(null);
      setEditingSiteIds([]);
      toast.success(copy.toasts.siteAccessChanged);
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : copy.toasts.siteAccessChangeFailed;
      toast.error(message || copy.toasts.siteAccessChangeFailed);
    } finally {
      setSavingSiteAccessId(null);
    }
  }

  async function handleRemoveMember(userId: string) {
    setRemovingMemberId(userId);
    try {
      await postJson(
        "members",
        {
          intent: "remove",
          teamId: activeTeam.id,
          userId,
        },
        "PATCH",
      );
      await refreshMembers();
      setRemoveMemberTarget(null);
      toast.success(copy.toasts.memberRemoved);
    } catch (error) {
      const message =
        error instanceof Error ? error.message : copy.toasts.memberRemoveFailed;
      toast.error(message || copy.toasts.memberRemoveFailed);
    } finally {
      setRemovingMemberId(null);
    }
  }

  const aggregateChartRenderData = useMemo(() => {
    if (!dashboardData) return undefined;
    return buildTeamAggregateTrend(dashboardData.trend, dashboardWindow);
  }, [dashboardData, dashboardWindow]);

  const siteTrendById = useMemo(
    () =>
      dashboardData
        ? buildTeamSiteTrends(
            dashboardSites.map((site) => site.id),
            dashboardData?.trend ?? [],
            dashboardWindow,
          )
        : {},
    [dashboardData, dashboardSites, dashboardWindow],
  );

  const siteDashboardCards = useMemo(
    () =>
      dashboardSites.map((site) => {
        const overview = site.overview ?? emptyOverviewMetrics();
        return {
          site,
          overview,
          pagesPerSession:
            overview.sessions > 0 ? overview.views / overview.sessions : 0,
          changeRates: site.changeRates ?? emptySiteMetricChangeRates(),
          trend: siteTrendById[site.id] ?? [],
        };
      }),
    [dashboardSites, siteTrendById],
  );

  const aggregateChartSites = useMemo(
    () =>
      dashboardSites.map((site) => ({
        id: site.id,
        name: site.name,
      })),
    [dashboardSites],
  );

  const pagesPerSessionFormatter = useMemo(
    () =>
      new Intl.NumberFormat(intlLocale(locale), {
        maximumFractionDigits: 2,
      }),
    [locale],
  );

  const siteCount = useMemo(
    () =>
      activeTab === "sites" ? dashboardSites.length : activeTeam.siteCount,
    [activeTab, dashboardSites.length, activeTeam.siteCount],
  );

  const memberCount = useMemo(
    () =>
      activeTab === "settings" || activeTab === "members"
        ? members.length
        : activeTeam.memberCount,
    [activeTab, members.length, activeTeam.memberCount],
  );

  const panelTitle =
    activeTab === "sites"
      ? copy.sites.title
      : activeTab === "settings"
        ? copy.settings.title
        : copy.members.title;

  const panelSubtitle =
    activeTab === "sites"
      ? copy.sites.subtitle
      : activeTab === "settings"
        ? copy.settings.subtitle
        : copy.members.subtitle;

  const isPageDataLoading =
    activeTab === "sites"
      ? dashboardQuery.isPending && !dashboardData
      : loading;

  return {
    aggregateChartRenderData,
    aggregateChartSites,
    canAdminister,
    canManage,
    canManageSites,
    changingRoleId,
    copy,
    createSiteDialogOpen,
    createSiteDomain,
    createSiteError,
    createSiteName,
    createSitePublicSlug,
    creatingInvite,
    creatingSite,
    currentTeamName,
    dashboardQuery,
    dashboardMetricsPending,
    dashboardMetricsUnavailable,
    dashboardSites,
    dashboardWindow,
    deleteTeamDialogOpen,
    deletingTeam,
    editingSiteIds,
    handleChangeMemberRole,
    handleCopyInviteUrl,
    handleCopyLatestInviteUrl,
    handleCreateInvite,
    handleCreateSite,
    handleDeleteTeam,
    handleRemoveMember,
    handleRevokeInvite,
    handleSaveMemberSiteAccess,
    handleSaveTeamSettings,
    handleTransferOwner,
    isPageDataLoading,
    isRealOwner,
    inviteEmail,
    inviteExpiresInHours,
    inviteRole,
    invites,
    inviteSiteAccessDialogOpen,
    inviteSiteIds,
    latestInviteUrl,
    loading,
    managementUnavailable,
    memberCount,
    members,
    pagesPerSessionFormatter,
    panelSubtitle,
    panelTitle,
    removingMemberId,
    removeMemberImpact,
    removeMemberTarget,
    revokingInviteId,
    revokeInviteTarget,
    savingSiteAccessId,
    savingTeam,
    setCreateSiteDialogOpen,
    setCreateSiteDomain,
    setCreateSiteError,
    setCreateSiteName,
    setCreateSitePublicSlug,
    setDeleteTeamDialogOpen,
    setEditingSiteIds,
    setInviteEmail,
    setInviteExpiresInHours,
    setInviteRole,
    setInviteSiteAccessDialogOpen,
    setInviteSiteIds,
    setRemoveMemberTarget,
    setRevokeInviteTarget,
    setSiteAccessDialogMember,
    setTeamName,
    setTeamSlug,
    setTransferDialogOpen,
    setTransferTargetId,
    siteAccessDialogMember,
    siteCount,
    siteCreateCopy,
    siteDashboardCards,
    sites,
    teamName,
    teamSlug,
    toggleEditingSite,
    toggleInviteSite,
    transferableMembers,
    transferDialogOpen,
    transferTargetId,
    transferring,
    window,
  };
}
