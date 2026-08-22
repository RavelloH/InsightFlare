import { useEffect, useMemo, useRef, useState } from "react";
import {
  RiAddLine,
  RiArrowDownLine,
  RiArrowRightLine,
  RiArrowRightSLine,
  RiArrowUpLine,
  RiBarChartBoxLine,
  RiCheckboxBlankCircleLine,
  RiCheckLine,
  RiCloseLine,
  RiDeleteBinLine,
  RiFileCopyLine,
  RiGlobalLine,
  RiGroupLine,
  RiLinksLine,
  RiLockLine,
  RiMailSendLine,
  RiSave3Line,
  RiSettings3Line,
} from "@remixicon/react";
import { useQuery } from "@tanstack/react-query";
import { toast } from "sonner";

import { SiteTrafficStackChart } from "@/components/dashboard/charts/site-traffic-stack-chart";
import { TrafficPairBarChart } from "@/components/dashboard/charts/traffic-pair-bar-chart";
import { useDashboardQuery } from "@/components/dashboard/dashboard-query-provider";
import { DataTableSwitch } from "@/components/dashboard/data-table-switch";
import { PageHeading } from "@/components/dashboard/page-heading";
import { SiteBrandIcon } from "@/components/dashboard/site-brand-icon";
import { TableActionButton } from "@/components/dashboard/table-action-button";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { AutoResizer } from "@/components/ui/auto-resizer";
import { AutoTransition } from "@/components/ui/auto-transition";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  ResponsiveDialog,
  ResponsiveDialogBody,
  ResponsiveDialogContent,
  ResponsiveDialogDescription,
  ResponsiveDialogFooter,
  ResponsiveDialogHeader,
  ResponsiveDialogTitle,
} from "@/components/ui/responsive-dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Spinner } from "@/components/ui/spinner";
import { TableCell, TableHead, TableRow } from "@/components/ui/table";
import {
  type AdminServiceHttpMethod,
  requestAdminService,
} from "@/lib/admin-service-client";
import type { AdminServiceRoute } from "@/lib/admin-service-contract";
import {
  durationFormat,
  intlLocale,
  numberFormat,
  percentFormat,
  shortDateTime,
} from "@/lib/dashboard/format";
import type {
  CreatedTeamInviteData,
  TeamInviteData,
  TeamManagementInitialData,
} from "@/lib/dashboard/management-data";
import { canAdministerTeam, canManageTeam } from "@/lib/dashboard/permissions";
import {
  buildTeamAggregateTrend,
  buildTeamSiteTrends,
  teamDashboardQueryOptions,
  type TeamDashboardSnapshot,
} from "@/lib/dashboard/team-dashboard-query";
import type { MemberData, SiteData, TeamData } from "@/lib/edge-client";
import type { Locale } from "@/lib/i18n/config";
import type { AppMessages } from "@/lib/i18n/messages";
import { navigateWithTransition } from "@/lib/page-transition";
import Link from "@/lib/router";
import { useRouter } from "@/lib/router";

type TeamTab = "sites" | "settings" | "members";

type SiteMetricChangeRates = {
  views: number | null;
  visitors: number | null;
  sessions: number | null;
  bounceRate: number | null;
  avgDurationMs: number | null;
  pagesPerSession: number | null;
};

function emptyOverviewMetrics() {
  return {
    views: 0,
    sessions: 0,
    visitors: 0,
    bounces: 0,
    totalDurationMs: 0,
    avgDurationMs: 0,
    bounceRate: 0,
    approximateVisitors: false,
  };
}

function emptySiteMetricChangeRates(): SiteMetricChangeRates {
  return {
    views: null,
    visitors: null,
    sessions: null,
    bounceRate: null,
    avgDurationMs: null,
    pagesPerSession: null,
  };
}

function formatChangeRate(value: number | null): string | null {
  if (value === null) return null;
  return `${value >= 0 ? "+" : ""}${value.toFixed(1)}%`;
}

function changeRateClass(value: number | null, lowerIsBetter = false): string {
  if (value === null) return "text-muted-foreground";
  const isImprovement = lowerIsBetter ? value <= 0 : value >= 0;
  return isImprovement ? "text-emerald-600" : "text-rose-600";
}

function ChangeRateInline({
  value,
  lowerIsBetter = false,
}: {
  value: number | null;
  lowerIsBetter?: boolean;
}) {
  if (value === null) return null;
  const Icon = value >= 0 ? RiArrowUpLine : RiArrowDownLine;
  return (
    <span
      className={`inline-flex items-end gap-0.5 font-mono text-xs leading-none ${changeRateClass(value, lowerIsBetter)}`}
    >
      <Icon className="size-3.5" />
      {formatChangeRate(value)}
    </span>
  );
}

function epochSecondsToMs(value: number): number {
  return value > 0 && value < 100_000_000_000 ? value * 1000 : value;
}

interface TeamManagementClientProps {
  locale: Locale;
  messages: AppMessages;
  activeTeam: TeamData;
  activeTab: TeamTab;
  systemRole: "admin" | "user";
  currentUserId: string;
  teamDashboardSnapshot?: TeamDashboardSnapshot | null;
  teamManagementInitialData?: TeamManagementInitialData | null;
}

function safeSlug(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function getSiteSlug(site: SiteData): string {
  const domain = String(site.domain || "").trim();
  const candidate = safeSlug(domain);
  if (candidate.length > 0) return candidate;
  return site.id.slice(0, 8);
}

function withSiteSlug<T extends SiteData>(site: T): T & { slug: string } {
  return {
    ...site,
    slug: getSiteSlug(site),
  };
}

function sortSitesForInitialOrder<
  T extends {
    id: string;
    name: string;
    overview?: { views: number; visitors: number } | null;
  },
>(sites: T[]): T[] {
  return [...sites].sort((left, right) => {
    const leftViews = left.overview?.views ?? 0;
    const rightViews = right.overview?.views ?? 0;
    const byViews = rightViews - leftViews;
    if (byViews !== 0) return byViews;

    const leftVisitors = left.overview?.visitors ?? 0;
    const rightVisitors = right.overview?.visitors ?? 0;
    const byVisitors = rightVisitors - leftVisitors;
    if (byVisitors !== 0) return byVisitors;

    const byName = left.name.localeCompare(right.name, undefined, {
      sensitivity: "base",
      numeric: true,
    });
    if (byName !== 0) return byName;
    return left.id.localeCompare(right.id);
  });
}

function buildSitePath(
  locale: Locale,
  teamSlug: string,
  siteSlug: string,
): string {
  return `/${locale}/app/${teamSlug}/${siteSlug}`;
}

const SITE_CARD_MAX_TREND_POINTS = 120;

function normalizeSiteIds(input: unknown): string[] {
  const raw = Array.isArray(input) ? input : [];
  const out: string[] = [];
  for (const value of raw) {
    const siteId = String(value || "").trim();
    if (!siteId || out.includes(siteId)) continue;
    out.push(siteId);
  }
  return out;
}

function formatCountTemplate(template: string, count: number): string {
  return template.replace("{count}", String(count));
}

function siteAccessSummary(
  siteIds: string[],
  sites: Array<Pick<SiteData, "id" | "name" | "domain">>,
  copy: AppMessages["teamManagement"]["members"],
): string {
  if (siteIds.length === 0) return copy.siteAccessAll;
  const knownIds = new Set(sites.map((site) => site.id));
  const selectedCount =
    knownIds.size === 0
      ? siteIds.length
      : siteIds.filter((siteId) => knownIds.has(siteId)).length;
  return formatCountTemplate(
    copy.siteAccessSelected,
    Math.max(selectedCount, siteIds.length),
  );
}

function SiteAccessSelectorButtons({
  siteIds,
  sites,
  allSitesLabel,
  noSitesLabel,
  onAllSites,
  onToggleSite,
}: {
  siteIds: string[];
  sites: Array<Pick<SiteData, "id" | "name" | "domain">>;
  allSitesLabel: string;
  noSitesLabel: string;
  onAllSites: () => void;
  onToggleSite: (siteId: string) => void;
}) {
  return (
    <div className="flex flex-wrap gap-2">
      <Button
        type="button"
        variant={siteIds.length === 0 ? "default" : "outline"}
        size="sm"
        onClick={onAllSites}
      >
        {siteIds.length === 0 ? <RiCheckLine /> : <RiCheckboxBlankCircleLine />}
        <span>{allSitesLabel}</span>
      </Button>
      {sites.length > 0 ? (
        sites.map((site) => {
          const checked = siteIds.includes(site.id);
          return (
            <Button
              key={site.id}
              type="button"
              variant={checked ? "default" : "outline"}
              size="sm"
              onClick={() => onToggleSite(site.id)}
            >
              {checked ? <RiCheckLine /> : <RiCheckboxBlankCircleLine />}
              <span>{site.name || site.domain || site.id}</span>
            </Button>
          );
        })
      ) : (
        <p className="text-sm text-muted-foreground">{noSitesLabel}</p>
      )}
    </div>
  );
}

async function fetchTeamMembers(
  teamId: string,
  signal?: AbortSignal,
): Promise<MemberData[]> {
  return requestAdminService<MemberData[]>("members", {
    params: { teamId },
    signal,
  });
}

async function fetchTeamSites(
  teamId: string,
  signal?: AbortSignal,
): Promise<SiteData[]> {
  return requestAdminService<SiteData[]>("sites", {
    params: { teamId },
    signal,
  });
}

async function fetchTeamInvites(
  teamId: string,
  signal?: AbortSignal,
): Promise<TeamInviteData[]> {
  return requestAdminService<TeamInviteData[]>("team-invites", {
    params: { teamId },
    signal,
  });
}

async function postJson<T>(
  route: AdminServiceRoute,
  body: Record<string, unknown>,
  method: AdminServiceHttpMethod = "POST",
): Promise<T> {
  return requestAdminService<T>(route, { method, body });
}

export function TeamManagementClient({
  locale,
  messages,
  activeTeam,
  activeTab,
  systemRole,
  currentUserId,
  teamDashboardSnapshot = null,
  teamManagementInitialData = null,
}: TeamManagementClientProps) {
  const router = useRouter();
  const { window: selectedWindow } = useDashboardQuery();
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
    (teamManagementInitialData?.sites ?? []).map(withSiteSlug),
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
  const [removingMemberId, setRemovingMemberId] = useState<string | null>(null);
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
    queryKey: ["dashboard", "team-management-data", activeTeam.id, canManage],
    queryFn: async ({ signal }) => {
      const [members, invites, sites] = await Promise.all([
        fetchTeamMembers(activeTeam.id, signal),
        canManage
          ? fetchTeamInvites(activeTeam.id, signal)
          : Promise.resolve([]),
        canManage ? fetchTeamSites(activeTeam.id, signal) : Promise.resolve([]),
      ]);
      return { members, invites, sites, fetchedAt: Date.now() };
    },
    enabled:
      typeof window !== "undefined" &&
      (activeTab === "settings" || activeTab === "members"),
    initialData: teamManagementInitialData ?? undefined,
    initialDataUpdatedAt: teamManagementInitialData?.fetchedAt,
  });
  const dashboardQuery = useQuery(
    teamDashboardQueryOptions({
      teamId: activeTeam.id,
      window,
      range: selectedWindow.preset,
      snapshot: teamDashboardSnapshot,
      enabled: activeTab === "sites",
    }),
  );
  const dashboardSnapshot = dashboardQuery.data;
  const dashboardData = dashboardSnapshot?.data;
  const dashboardWindow = dashboardSnapshot?.window ?? window;
  const dashboardSites = useMemo(
    () =>
      sortSitesForInitialOrder((dashboardData?.sites ?? []).map(withSiteSlug)),
    [dashboardData?.sites],
  );
  const transferableMembers = useMemo(
    () => members.filter((m) => m.userId !== activeTeam.ownerUserId),
    [members, activeTeam.ownerUserId],
  );

  useEffect(() => {
    if (activeTab !== "settings" && activeTab !== "members") return;
    setLoading(managementDataQuery.isPending);
    if (managementDataQuery.isPending) return;
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
      buildTeamSiteTrends(
        dashboardSites.map((site) => site.id),
        dashboardData?.trend ?? [],
        dashboardWindow,
      ),
    [dashboardData?.trend, dashboardSites, dashboardWindow],
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
  const inviteCreateCard = (
    <Card className="h-full">
      <CardHeader>
        <CardTitle className="inline-flex items-center gap-2">
          <RiMailSendLine className="size-4" />
          {copy.members.invitesTitle}
        </CardTitle>
        <CardDescription>{copy.members.invitesSubtitle}</CardDescription>
      </CardHeader>
      <CardContent className="flex h-full flex-col gap-4">
        <form
          className="flex h-full flex-col gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            void handleCreateInvite();
          }}
        >
          <div className="space-y-2">
            <Label htmlFor="invite-email">
              {copy.members.inviteEmailLabel}
            </Label>
            <Input
              id="invite-email"
              value={inviteEmail}
              onChange={(event) => setInviteEmail(event.target.value)}
              placeholder={copy.members.inviteEmailPlaceholder}
              disabled={!canManage}
            />
          </div>
          <div className="grid gap-4 md:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="invite-role">{copy.members.columns.role}</Label>
              <Select
                value={inviteRole}
                onValueChange={(value) => {
                  const nextRole = value === "admin" ? "admin" : "member";
                  setInviteRole(nextRole);
                  if (nextRole === "admin") setInviteSiteIds([]);
                }}
                disabled={!canManage}
              >
                <SelectTrigger id="invite-role" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="member">
                    {copy.members.roleLabels.member}
                  </SelectItem>
                  <SelectItem value="admin">
                    {copy.members.roleLabels.admin}
                  </SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label htmlFor="invite-expires">
                {copy.members.inviteExpiresLabel}
              </Label>
              <Input
                id="invite-expires"
                value={inviteExpiresInHours}
                onChange={(event) =>
                  setInviteExpiresInHours(event.target.value)
                }
                inputMode="numeric"
                disabled={!canManage}
              />
            </div>
          </div>
          {inviteRole === "member" ? (
            <div className="space-y-2">
              <Label>{copy.members.siteAccessLabel}</Label>
              <Button
                type="button"
                variant="outline"
                disabled={!canManage}
                className="w-full justify-between"
                onClick={() => setInviteSiteAccessDialogOpen(true)}
              >
                <span className="inline-flex min-w-0 items-center gap-2">
                  <RiGlobalLine className="size-4 shrink-0" />
                  <span className="truncate">
                    {siteAccessSummary(inviteSiteIds, sites, copy.members)}
                  </span>
                </span>
                <RiSettings3Line className="size-4 shrink-0 text-muted-foreground" />
              </Button>
            </div>
          ) : (
            <div className="rounded-md border bg-muted/30 px-3 py-2 text-sm text-muted-foreground">
              {copy.members.siteAccessAdmins}
            </div>
          )}
          <Button
            type="submit"
            className="mt-auto self-start"
            disabled={creatingInvite || !canManage}
          >
            <AutoTransition className="inline-flex items-center gap-2">
              {creatingInvite ? (
                <span key="creating" className="inline-flex items-center gap-2">
                  <Spinner className="size-4" />
                  {copy.members.creatingInvite}
                </span>
              ) : (
                <span key="create" className="inline-flex items-center gap-2">
                  <RiAddLine className="size-4" />
                  {copy.members.createInvite}
                </span>
              )}
            </AutoTransition>
          </Button>
        </form>

        {latestInviteUrl ? (
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
            <Input value={latestInviteUrl} readOnly className="font-mono" />
            <Button
              type="button"
              variant="outline"
              onClick={() => {
                void handleCopyLatestInviteUrl();
              }}
            >
              <RiFileCopyLine className="size-4" />
              <span>{copy.members.copyInvite}</span>
            </Button>
          </div>
        ) : null}
      </CardContent>
    </Card>
  );

  const inviteLinksCard = (
    <Card>
      <CardHeader>
        <CardTitle className="inline-flex items-center gap-2">
          <RiLinksLine className="size-4" />
          {copy.members.inviteLinksTitle}
        </CardTitle>
        <CardDescription>{copy.members.inviteLinksSubtitle}</CardDescription>
      </CardHeader>
      <CardContent>
        <DataTableSwitch
          loading={loading}
          hasContent={invites.length > 0}
          loadingLabel={messages.common.loading}
          emptyLabel={copy.members.noInvites}
          colSpan={9}
          header={
            <TableRow>
              <TableHead>{copy.members.columns.email}</TableHead>
              <TableHead>{copy.members.columns.inviteCode}</TableHead>
              <TableHead>{copy.members.columns.role}</TableHead>
              <TableHead>{copy.members.columns.siteAccess}</TableHead>
              <TableHead>{copy.members.columns.status}</TableHead>
              <TableHead>{copy.members.columns.createdAt}</TableHead>
              <TableHead>{copy.members.columns.expiresAt}</TableHead>
              <TableHead>{copy.members.columns.usedAt}</TableHead>
              <TableHead className="text-right">
                {copy.members.columns.action}
              </TableHead>
            </TableRow>
          }
          rows={invites.map((invite) => (
            <TableRow key={invite.id}>
              <TableCell>{invite.email || copy.members.anyEmail}</TableCell>
              <TableCell>
                {invite.code ? (
                  <button
                    type="button"
                    className="font-mono text-xs text-primary underline-offset-4 hover:underline disabled:pointer-events-none disabled:text-muted-foreground"
                    disabled={!invite.url}
                    onClick={() => {
                      void handleCopyInviteUrl(invite);
                    }}
                  >
                    {invite.code}
                  </button>
                ) : (
                  "-"
                )}
              </TableCell>
              <TableCell>
                {invite.payload.teamRole === "admin"
                  ? copy.members.roleLabels.admin
                  : copy.members.roleLabels.member}
              </TableCell>
              <TableCell>
                {invite.payload.teamRole === "admin"
                  ? copy.members.siteAccessAll
                  : siteAccessSummary(
                      normalizeSiteIds(invite.payload.siteIds),
                      sites,
                      copy.members,
                    )}
              </TableCell>
              <TableCell>
                {copy.members.inviteStatuses[invite.status]}
              </TableCell>
              <TableCell>
                {shortDateTime(
                  locale,
                  epochSecondsToMs(invite.createdAt),
                  window.timeZone,
                )}
              </TableCell>
              <TableCell>
                {shortDateTime(
                  locale,
                  epochSecondsToMs(invite.expiresAt),
                  window.timeZone,
                )}
              </TableCell>
              <TableCell>
                {invite.usedAt
                  ? shortDateTime(
                      locale,
                      epochSecondsToMs(invite.usedAt),
                      window.timeZone,
                    )
                  : "-"}
              </TableCell>
              <TableCell className="text-right">
                <TableActionButton
                  onClick={() => {
                    void handleRevokeInvite(invite.id);
                  }}
                  disabled={
                    !canManage ||
                    invite.status !== "active" ||
                    revokingInviteId === invite.id
                  }
                  label={copy.members.revokeInvite}
                  tone="destructive"
                  transitionKey={
                    revokingInviteId === invite.id ? "revoking" : "revoke"
                  }
                >
                  {revokingInviteId === invite.id ? (
                    <Spinner className="size-3.5" />
                  ) : (
                    <RiDeleteBinLine className="size-4" />
                  )}
                </TableActionButton>
              </TableCell>
            </TableRow>
          ))}
        />
      </CardContent>
    </Card>
  );

  const membersTableCard = (
    <Card>
      <CardContent className="pt-4">
        <DataTableSwitch
          loading={loading}
          hasContent={members.length > 0}
          loadingLabel={messages.common.loading}
          emptyLabel={copy.members.noMembers}
          colSpan={7}
          header={
            <TableRow>
              <TableHead>{copy.members.columns.name}</TableHead>
              <TableHead>{copy.members.columns.username}</TableHead>
              <TableHead>{copy.members.columns.email}</TableHead>
              <TableHead>{copy.members.columns.role}</TableHead>
              <TableHead>{copy.members.columns.siteAccess}</TableHead>
              <TableHead>{copy.members.columns.joinedAt}</TableHead>
              <TableHead className="text-right">
                {copy.members.columns.action}
              </TableHead>
            </TableRow>
          }
          rows={members.map((member) => (
            <TableRow key={member.userId}>
              <TableCell className="font-medium">
                {member.name || member.username}
              </TableCell>
              <TableCell>{member.username}</TableCell>
              <TableCell>{member.email}</TableCell>
              <TableCell>
                {member.role === "owner" ? (
                  <span className="inline-flex items-center gap-1.5 text-muted-foreground">
                    <RiLockLine className="size-3.5" />
                    {copy.members.roleLabels.owner}
                  </span>
                ) : (
                  <Select
                    value={member.role === "admin" ? "admin" : "member"}
                    disabled={!canManage || changingRoleId === member.userId}
                    onValueChange={(value) => {
                      const next: "admin" | "member" =
                        value === "admin" ? "admin" : "member";
                      const current: "admin" | "member" =
                        member.role === "admin" ? "admin" : "member";
                      if (next === current) return;
                      const isSelfDemote =
                        member.userId === currentUserId &&
                        systemRole !== "admin" &&
                        activeTeam.ownerUserId !== currentUserId &&
                        next === "member";
                      if (isSelfDemote) {
                        toast.error(copy.toasts.roleChangeFailed);
                        return;
                      }
                      void handleChangeMemberRole(member.userId, next);
                    }}
                  >
                    <SelectTrigger className="h-8 w-28 text-xs">
                      <AutoTransition className="inline-flex items-center gap-1.5">
                        {changingRoleId === member.userId ? (
                          <span
                            key="role-changing"
                            className="inline-flex items-center gap-1.5"
                          >
                            <Spinner className="size-3" />
                          </span>
                        ) : (
                          <span key="role-value">
                            <SelectValue />
                          </span>
                        )}
                      </AutoTransition>
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="member">
                        {copy.members.roleLabels.member}
                      </SelectItem>
                      <SelectItem value="admin">
                        {copy.members.roleLabels.admin}
                      </SelectItem>
                    </SelectContent>
                  </Select>
                )}
              </TableCell>
              <TableCell>
                {member.role === "member" ? (
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    disabled={
                      !canManage || savingSiteAccessId === member.userId
                    }
                    className="justify-between"
                    onClick={() => {
                      setSiteAccessDialogMember(member);
                      setEditingSiteIds(normalizeSiteIds(member.siteIds));
                    }}
                  >
                    <span className="inline-flex min-w-0 items-center gap-2">
                      <RiGlobalLine className="size-3.5 shrink-0" />
                      <span className="min-w-0 truncate">
                        {siteAccessSummary(
                          normalizeSiteIds(member.siteIds),
                          sites,
                          copy.members,
                        )}
                      </span>
                    </span>
                    {savingSiteAccessId === member.userId ? (
                      <Spinner className="size-3.5 shrink-0" />
                    ) : (
                      <RiSettings3Line className="size-3.5 shrink-0 text-muted-foreground" />
                    )}
                  </Button>
                ) : (
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    disabled
                    className="justify-start"
                  >
                    <RiGlobalLine className="size-3.5" />
                    <span className="truncate">
                      {copy.members.siteAccessAll}
                    </span>
                  </Button>
                )}
              </TableCell>
              <TableCell>
                {shortDateTime(
                  locale,
                  epochSecondsToMs(member.joinedAt),
                  window.timeZone,
                )}
              </TableCell>
              <TableCell className="text-right">
                {member.role === "owner" ? null : (
                  <TableActionButton
                    onClick={() => {
                      void handleRemoveMember(member.userId);
                    }}
                    disabled={!canManage || removingMemberId === member.userId}
                    label={copy.members.remove}
                    tone="destructive"
                    transitionKey={
                      removingMemberId === member.userId ? "removing" : "remove"
                    }
                  >
                    {removingMemberId === member.userId ? (
                      <Spinner className="size-3.5" />
                    ) : (
                      <RiDeleteBinLine className="size-4" />
                    )}
                  </TableActionButton>
                )}
              </TableCell>
            </TableRow>
          ))}
        />
      </CardContent>
    </Card>
  );

  const memberManagementSection = (
    <div className="space-y-4">
      {inviteCreateCard}
      {inviteLinksCard}
      {membersTableCard}
    </div>
  );

  const inviteSiteAccessDialog = (
    <ResponsiveDialog
      open={inviteSiteAccessDialogOpen}
      onOpenChange={setInviteSiteAccessDialogOpen}
    >
      <ResponsiveDialogContent desktopClassName="max-w-2xl">
        <ResponsiveDialogHeader>
          <ResponsiveDialogTitle>
            {copy.members.siteAccessDialogTitle}
          </ResponsiveDialogTitle>
          <ResponsiveDialogDescription>
            {copy.members.invitesTitle}
          </ResponsiveDialogDescription>
        </ResponsiveDialogHeader>
        <ResponsiveDialogBody>
          <Field>
            <FieldLabel>{copy.members.siteAccessLabel}</FieldLabel>
            <FieldDescription>
              {copy.members.siteAccessDescription}
            </FieldDescription>
            <SiteAccessSelectorButtons
              siteIds={inviteSiteIds}
              sites={sites}
              allSitesLabel={copy.members.siteAccessAll}
              noSitesLabel={copy.members.noSitesForAccess}
              onAllSites={() => setInviteSiteIds([])}
              onToggleSite={(siteId) =>
                toggleInviteSite(siteId, !inviteSiteIds.includes(siteId))
              }
            />
          </Field>
        </ResponsiveDialogBody>
        <ResponsiveDialogFooter>
          <Button
            type="button"
            onClick={() => setInviteSiteAccessDialogOpen(false)}
          >
            <RiSave3Line className="size-4" />
            <span>{copy.members.saveSiteAccess}</span>
          </Button>
        </ResponsiveDialogFooter>
      </ResponsiveDialogContent>
    </ResponsiveDialog>
  );

  const siteAccessDialog = (
    <ResponsiveDialog
      open={Boolean(siteAccessDialogMember)}
      onOpenChange={(open) => {
        if (open) return;
        setSiteAccessDialogMember(null);
        setEditingSiteIds([]);
      }}
    >
      <ResponsiveDialogContent desktopClassName="max-w-2xl">
        <ResponsiveDialogHeader>
          <ResponsiveDialogTitle>
            {copy.members.siteAccessDialogTitle}
          </ResponsiveDialogTitle>
          <ResponsiveDialogDescription>
            {siteAccessDialogMember
              ? siteAccessDialogMember.name || siteAccessDialogMember.username
              : copy.members.roleLabels.member}
          </ResponsiveDialogDescription>
        </ResponsiveDialogHeader>
        <ResponsiveDialogBody>
          <Field>
            <FieldLabel>{copy.members.siteAccessLabel}</FieldLabel>
            <FieldDescription>
              {copy.members.siteAccessDescription}
            </FieldDescription>
            <SiteAccessSelectorButtons
              siteIds={editingSiteIds}
              sites={sites}
              allSitesLabel={copy.members.siteAccessAll}
              noSitesLabel={copy.members.noSitesForAccess}
              onAllSites={() => setEditingSiteIds([])}
              onToggleSite={(siteId) =>
                toggleEditingSite(siteId, !editingSiteIds.includes(siteId))
              }
            />
          </Field>
        </ResponsiveDialogBody>
        <ResponsiveDialogFooter>
          <Button
            type="button"
            variant="outline"
            onClick={() => {
              setSiteAccessDialogMember(null);
              setEditingSiteIds([]);
            }}
          >
            {copy.members.cancelSiteAccess}
          </Button>
          <Button
            type="button"
            disabled={
              !siteAccessDialogMember ||
              savingSiteAccessId === siteAccessDialogMember.userId
            }
            onClick={() => {
              void handleSaveMemberSiteAccess();
            }}
          >
            {siteAccessDialogMember &&
            savingSiteAccessId === siteAccessDialogMember.userId ? (
              <Spinner className="size-4" />
            ) : (
              <RiSave3Line className="size-4" />
            )}
            <span>{copy.members.saveSiteAccess}</span>
          </Button>
        </ResponsiveDialogFooter>
      </ResponsiveDialogContent>
    </ResponsiveDialog>
  );

  return (
    <div className="space-y-6">
      {inviteSiteAccessDialog}
      {siteAccessDialog}
      <PageHeading
        title={`${panelTitle} · ${currentTeamName}`}
        subtitle={panelSubtitle}
        actions={
          canManage ? (
            <>
              <Button variant="outline" asChild>
                <Link href={`/${locale}/app/${activeTeam.slug}/manage/sites`}>
                  <RiGlobalLine />
                  <span className="inline-flex items-center gap-1.5">
                    {copy.stats.sites}:
                    <AutoResizer
                      initial
                      animateWidth
                      animateHeight={false}
                      className="inline-flex items-center"
                    >
                      <AutoTransition
                        initial
                        className="inline-flex items-center"
                      >
                        {isPageDataLoading ? (
                          <span
                            key="sites-loading"
                            className="inline-flex items-center"
                          >
                            <Spinner className="size-3.5" />
                          </span>
                        ) : (
                          <span key="sites-value">{siteCount}</span>
                        )}
                      </AutoTransition>
                    </AutoResizer>
                  </span>
                </Link>
              </Button>
              <Button variant="outline" asChild>
                <Link href={`/${locale}/app/${activeTeam.slug}/members`}>
                  <RiGroupLine />
                  <span className="inline-flex items-center gap-1.5">
                    {copy.stats.members}:
                    <AutoResizer
                      initial
                      animateWidth
                      animateHeight={false}
                      className="inline-flex items-center"
                    >
                      <AutoTransition
                        initial
                        className="inline-flex items-center"
                      >
                        {isPageDataLoading ? (
                          <span
                            key="members-loading"
                            className="inline-flex items-center"
                          >
                            <Spinner className="size-3.5" />
                          </span>
                        ) : (
                          <span key="members-value">{memberCount}</span>
                        )}
                      </AutoTransition>
                    </AutoResizer>
                  </span>
                </Link>
              </Button>
              {activeTab === "sites" && canManageSites ? (
                <Button
                  type="button"
                  onClick={() => {
                    setCreateSiteName("");
                    setCreateSiteDomain("");
                    setCreateSitePublicSlug("");
                    setCreateSiteError("");
                    setCreateSiteDialogOpen(true);
                  }}
                >
                  <RiAddLine />
                  <span>{siteCreateCopy.create}</span>
                </Button>
              ) : null}
            </>
          ) : null
        }
      />

      <Dialog
        open={createSiteDialogOpen}
        onOpenChange={(next) => {
          if (!next && creatingSite) return;
          setCreateSiteDialogOpen(next);
          if (!next) {
            setCreateSiteError("");
          }
        }}
      >
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle icon={RiGlobalLine}>
              {siteCreateCopy.createTitle}
            </DialogTitle>
            <DialogDescription>
              {siteCreateCopy.createSubtitle}
            </DialogDescription>
          </DialogHeader>
          <form
            className="space-y-3"
            onSubmit={(event) => {
              event.preventDefault();
              void handleCreateSite();
            }}
          >
            <div className="space-y-1.5">
              <Label htmlFor="team-dashboard-create-site-name">
                {siteCreateCopy.name}
              </Label>
              <Input
                id="team-dashboard-create-site-name"
                value={createSiteName}
                onChange={(event) => setCreateSiteName(event.target.value)}
                minLength={2}
                required
              />
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="team-dashboard-create-site-domain">
                {siteCreateCopy.domain}
              </Label>
              <Input
                id="team-dashboard-create-site-domain"
                value={createSiteDomain}
                onChange={(event) => setCreateSiteDomain(event.target.value)}
                minLength={3}
                required
              />
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="team-dashboard-create-site-public-slug">
                {siteCreateCopy.publicSlug}
              </Label>
              <Input
                id="team-dashboard-create-site-public-slug"
                value={createSitePublicSlug}
                onChange={(event) =>
                  setCreateSitePublicSlug(event.target.value)
                }
              />
            </div>

            {createSiteError ? (
              <p className="text-xs text-destructive">{createSiteError}</p>
            ) : null}

            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                onClick={() => setCreateSiteDialogOpen(false)}
                disabled={creatingSite}
              >
                <RiCloseLine className="size-4" />
                <span>{messages.teamSelect.cancel}</span>
              </Button>
              <Button type="submit" disabled={creatingSite}>
                <AutoTransition className="inline-flex items-center gap-2">
                  {creatingSite ? (
                    <span
                      key="creating-site"
                      className="inline-flex items-center gap-2"
                    >
                      <Spinner className="size-4" />
                      {siteCreateCopy.creating}
                    </span>
                  ) : (
                    <span
                      key="create-site"
                      className="inline-flex items-center gap-2"
                    >
                      <RiAddLine className="size-4" />
                      {siteCreateCopy.create}
                    </span>
                  )}
                </AutoTransition>
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <div className="space-y-4">
        {activeTab === "sites" ? (
          <div className="space-y-4">
            <Card className="overflow-visible">
              <CardHeader>
                <CardTitle className="inline-flex items-center gap-2">
                  <RiBarChartBoxLine className="size-4" />
                  {copy.sites.aggregateTitle}
                </CardTitle>
              </CardHeader>

              <CardContent className="space-y-3">
                <div>
                  <SiteTrafficStackChart
                    data={aggregateChartRenderData}
                    sites={aggregateChartSites}
                    from={dashboardWindow.from}
                    to={dashboardWindow.to}
                    locale={locale}
                    timeZone={dashboardWindow.timeZone}
                    interval={dashboardWindow.interval}
                    viewsLabel={messages.common.views}
                    visitorsLabel={messages.common.visitors}
                    messages={messages}
                    axisDateFormat="regular"
                    loading={dashboardQuery.isFetching}
                  />
                </div>

                {!dashboardQuery.isPending && dashboardSites.length === 0 ? (
                  <p className="text-sm text-muted-foreground">
                    {copy.sites.noSites}
                  </p>
                ) : null}
              </CardContent>
            </Card>

            {siteDashboardCards.length > 0 ? (
              <div className="grid gap-4 lg:grid-cols-2">
                {siteDashboardCards.map(
                  ({ site, overview, pagesPerSession, changeRates, trend }) => (
                    <Link
                      key={site.id}
                      href={buildSitePath(locale, activeTeam.slug, site.slug)}
                      className="group block h-full cursor-pointer outline-none transition-transform hover:-translate-y-0.5 active:translate-y-0 focus-visible:ring-1 focus-visible:ring-ring/60"
                      aria-label={`${copy.sites.openAnalytics}: ${site.name}`}
                      title={copy.sites.openAnalytics}
                    >
                      <Card className="h-full transition-colors group-hover:bg-accent/20">
                        <CardHeader className="space-y-2">
                          <div className="flex items-start justify-between gap-3">
                            <div className="flex min-w-0 items-start gap-2.5">
                              <div className="min-w-0 space-y-1">
                                <CardTitle className="flex items-center gap-2 truncate text-base">
                                  <SiteBrandIcon
                                    siteId={site.id}
                                    siteName={site.name}
                                    domain={site.domain}
                                    iconSrc={site.iconPath}
                                    size="md"
                                  />
                                  {site.name}
                                </CardTitle>
                                <CardDescription className="truncate font-mono text-xs">
                                  {site.domain}
                                </CardDescription>
                              </div>
                            </div>
                            <span className="inline-flex size-6 shrink-0 items-center justify-center text-muted-foreground">
                              <RiArrowRightSLine className="size-4" />
                            </span>
                          </div>
                        </CardHeader>

                        <CardContent className="space-y-4">
                          <TrafficPairBarChart
                            data={trend}
                            locale={locale}
                            timeZone={dashboardWindow.timeZone}
                            interval={dashboardWindow.interval}
                            viewsLabel={messages.common.views}
                            visitorsLabel={messages.common.visitors}
                            axisDateFormat="compact"
                            maxPoints={SITE_CARD_MAX_TREND_POINTS}
                            loading={dashboardQuery.isFetching}
                            range={dashboardWindow}
                          />

                          <div className="grid grid-cols-2 gap-x-4 gap-y-4 text-[11px] sm:grid-cols-3">
                            <div className="space-y-1">
                              <p className="text-muted-foreground">
                                {messages.common.views}
                              </p>
                              <p className="inline-flex items-end gap-1.5 font-mono text-base leading-none">
                                {numberFormat(locale, overview.views)}
                                <ChangeRateInline value={changeRates.views} />
                              </p>
                            </div>
                            <div className="space-y-1">
                              <p className="text-muted-foreground">
                                {messages.common.visitors}
                              </p>
                              <p className="inline-flex items-end gap-1.5 font-mono text-base leading-none">
                                {numberFormat(locale, overview.visitors)}
                                <ChangeRateInline
                                  value={changeRates.visitors}
                                />
                              </p>
                            </div>
                            <div className="space-y-1">
                              <p className="text-muted-foreground">
                                {messages.common.sessions}
                              </p>
                              <p className="inline-flex items-end gap-1.5 font-mono text-base leading-none">
                                {numberFormat(locale, overview.sessions)}
                                <ChangeRateInline
                                  value={changeRates.sessions}
                                />
                              </p>
                            </div>
                            <div className="space-y-1">
                              <p className="text-muted-foreground">
                                {messages.common.bounceRate}
                              </p>
                              <p className="inline-flex items-end gap-1.5 font-mono text-base leading-none">
                                {percentFormat(locale, overview.bounceRate)}
                                <ChangeRateInline
                                  value={changeRates.bounceRate}
                                  lowerIsBetter
                                />
                              </p>
                            </div>
                            <div className="space-y-1">
                              <p className="text-muted-foreground">
                                {copy.sites.pagesPerSession}
                              </p>
                              <p className="inline-flex items-end gap-1.5 font-mono text-base leading-none">
                                {pagesPerSessionFormatter.format(
                                  pagesPerSession,
                                )}
                                <ChangeRateInline
                                  value={changeRates.pagesPerSession}
                                />
                              </p>
                            </div>
                            <div className="space-y-1">
                              <p className="text-muted-foreground">
                                {messages.common.avgDuration}
                              </p>
                              <p className="inline-flex items-end gap-1.5 font-mono text-base leading-none">
                                {durationFormat(locale, overview.avgDurationMs)}
                                <ChangeRateInline
                                  value={changeRates.avgDurationMs}
                                />
                              </p>
                            </div>
                          </div>
                        </CardContent>
                      </Card>
                    </Link>
                  ),
                )}
              </div>
            ) : null}
          </div>
        ) : null}

        {activeTab === "settings" ? (
          <div className="space-y-4">
            <div className="grid gap-4 lg:grid-cols-2">
              <Card className="h-full">
                <CardHeader>
                  <CardTitle className="inline-flex items-center gap-2">
                    <RiSettings3Line className="size-4" />
                    {copy.settings.title}
                  </CardTitle>
                  <CardDescription>{copy.settings.subtitle}</CardDescription>
                </CardHeader>
                <CardContent className="flex h-full flex-col">
                  <form
                    className="flex h-full flex-col gap-4"
                    onSubmit={(event) => {
                      event.preventDefault();
                      void handleSaveTeamSettings();
                    }}
                  >
                    <div className="space-y-2">
                      <Label htmlFor="team-name">
                        {copy.settings.nameLabel}
                      </Label>
                      <Input
                        id="team-name"
                        value={teamName}
                        onChange={(event) => setTeamName(event.target.value)}
                        minLength={2}
                        required
                      />
                    </div>

                    <div className="space-y-2">
                      <Label htmlFor="team-slug">
                        {copy.settings.slugLabel}
                      </Label>
                      <Input
                        id="team-slug"
                        value={teamSlug}
                        onChange={(event) => setTeamSlug(event.target.value)}
                      />
                    </div>

                    <Button
                      type="submit"
                      className="mt-auto self-start"
                      disabled={savingTeam || deletingTeam}
                    >
                      <AutoTransition className="inline-flex items-center gap-2">
                        {savingTeam ? (
                          <span
                            key="saving"
                            className="inline-flex items-center gap-2"
                          >
                            <Spinner className="size-4" />
                            {copy.settings.saving}
                          </span>
                        ) : (
                          <span
                            key="save"
                            className="inline-flex items-center gap-2"
                          >
                            <RiSave3Line className="size-4" />
                            {copy.settings.save}
                          </span>
                        )}
                      </AutoTransition>
                    </Button>
                  </form>
                </CardContent>
              </Card>
              {inviteCreateCard}
            </div>

            {inviteLinksCard}

            {membersTableCard}

            <div className="grid gap-4 lg:grid-cols-2">
              {isRealOwner ? (
                <AlertDialog
                  open={transferDialogOpen}
                  onOpenChange={(open) => {
                    if (transferring) return;
                    setTransferDialogOpen(open);
                  }}
                >
                  <Card className="h-full border-amber-500/40">
                    <CardHeader>
                      <CardTitle className="inline-flex items-center gap-2">
                        <RiArrowRightLine className="size-4" />
                        {copy.settings.transferTitle}
                      </CardTitle>
                      <CardDescription>
                        {copy.settings.transferSubtitle}
                      </CardDescription>
                    </CardHeader>
                    <CardContent className="flex h-full flex-col gap-3">
                      {transferableMembers.length === 0 ? (
                        <p className="text-xs text-muted-foreground">
                          {copy.settings.noTransferableMembers}
                        </p>
                      ) : (
                        <div className="space-y-2">
                          <Label htmlFor="transfer-target">
                            {copy.settings.transferTargetLabel}
                          </Label>
                          <Select
                            value={transferTargetId}
                            onValueChange={setTransferTargetId}
                            disabled={transferring}
                          >
                            <SelectTrigger
                              id="transfer-target"
                              className="w-full"
                            >
                              <SelectValue
                                placeholder={
                                  copy.settings.transferTargetPlaceholder
                                }
                              />
                            </SelectTrigger>
                            <SelectContent>
                              {transferableMembers.map((member) => (
                                <SelectItem
                                  key={member.userId}
                                  value={member.userId}
                                >
                                  {member.name || member.username} ·{" "}
                                  {member.email}
                                </SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                        </div>
                      )}
                      <div className="mt-auto flex pt-2">
                        <AlertDialogTrigger asChild>
                          <Button
                            type="button"
                            disabled={
                              transferring ||
                              !transferTargetId ||
                              transferableMembers.length === 0
                            }
                          >
                            <AutoTransition className="inline-flex items-center gap-2">
                              {transferring ? (
                                <span
                                  key="transferring"
                                  className="inline-flex items-center gap-2"
                                >
                                  <Spinner className="size-4" />
                                  {copy.settings.transferring}
                                </span>
                              ) : (
                                <span
                                  key="transfer"
                                  className="inline-flex items-center gap-2"
                                >
                                  <RiArrowRightLine className="size-4" />
                                  {copy.settings.transfer}
                                </span>
                              )}
                            </AutoTransition>
                          </Button>
                        </AlertDialogTrigger>
                      </div>
                    </CardContent>
                  </Card>
                  <AlertDialogContent size="sm">
                    <AlertDialogHeader>
                      <AlertDialogTitle icon={RiArrowRightLine}>
                        {copy.settings.transferTitle}
                      </AlertDialogTitle>
                      <AlertDialogDescription>
                        {copy.settings.transferConfirm}
                      </AlertDialogDescription>
                    </AlertDialogHeader>
                    <AlertDialogFooter>
                      <AlertDialogCancel disabled={transferring}>
                        <RiCloseLine className="size-4" />
                        <span>{messages.teamSelect.cancel}</span>
                      </AlertDialogCancel>
                      <AlertDialogAction
                        disabled={transferring}
                        onClick={(event) => {
                          event.preventDefault();
                          void handleTransferOwner();
                        }}
                      >
                        <AutoTransition className="inline-flex items-center gap-2">
                          {transferring ? (
                            <span
                              key="transferring-dialog"
                              className="inline-flex items-center gap-2"
                            >
                              <Spinner className="size-4" />
                              {copy.settings.transferring}
                            </span>
                          ) : (
                            <span
                              key="confirm-transfer-dialog"
                              className="inline-flex items-center gap-2"
                            >
                              <RiArrowRightLine className="size-4" />
                              {copy.settings.transfer}
                            </span>
                          )}
                        </AutoTransition>
                      </AlertDialogAction>
                    </AlertDialogFooter>
                  </AlertDialogContent>
                </AlertDialog>
              ) : null}

              {canAdminister ? (
                <AlertDialog
                  open={deleteTeamDialogOpen}
                  onOpenChange={(open) => {
                    if (deletingTeam) return;
                    setDeleteTeamDialogOpen(open);
                  }}
                >
                  <Card className="h-full border-destructive/40">
                    <CardHeader>
                      <CardTitle className="inline-flex items-center gap-2">
                        <RiDeleteBinLine className="size-4" />
                        {copy.settings.delete}
                      </CardTitle>
                      <CardDescription>
                        {copy.settings.deleteConfirm}
                      </CardDescription>
                    </CardHeader>
                    <CardContent className="flex h-full items-end">
                      <AlertDialogTrigger asChild>
                        <Button
                          type="button"
                          variant="destructive"
                          disabled={savingTeam || deletingTeam}
                        >
                          <AutoTransition className="inline-flex items-center gap-2">
                            {deletingTeam ? (
                              <span
                                key="deleting"
                                className="inline-flex items-center gap-2"
                              >
                                <Spinner className="size-4" />
                                {copy.settings.deleting}
                              </span>
                            ) : (
                              <span
                                key="delete"
                                className="inline-flex items-center gap-2"
                              >
                                <RiDeleteBinLine className="size-4" />
                                {copy.settings.delete}
                              </span>
                            )}
                          </AutoTransition>
                        </Button>
                      </AlertDialogTrigger>
                    </CardContent>
                  </Card>
                  <AlertDialogContent size="sm">
                    <AlertDialogHeader>
                      <AlertDialogTitle icon={RiDeleteBinLine}>
                        {copy.settings.delete}
                      </AlertDialogTitle>
                      <AlertDialogDescription>
                        {copy.settings.deleteConfirm}
                      </AlertDialogDescription>
                    </AlertDialogHeader>
                    <AlertDialogFooter>
                      <AlertDialogCancel disabled={deletingTeam}>
                        <RiCloseLine className="size-4" />
                        <span>{messages.teamSelect.cancel}</span>
                      </AlertDialogCancel>
                      <AlertDialogAction
                        variant="destructive"
                        disabled={deletingTeam}
                        onClick={(event) => {
                          event.preventDefault();
                          void handleDeleteTeam();
                        }}
                      >
                        <AutoTransition className="inline-flex items-center gap-2">
                          {deletingTeam ? (
                            <span
                              key="deleting-dialog"
                              className="inline-flex items-center gap-2"
                            >
                              <Spinner className="size-4" />
                              {copy.settings.deleting}
                            </span>
                          ) : (
                            <span
                              key="confirm-delete-dialog"
                              className="inline-flex items-center gap-2"
                            >
                              <RiDeleteBinLine className="size-4" />
                              {copy.settings.delete}
                            </span>
                          )}
                        </AutoTransition>
                      </AlertDialogAction>
                    </AlertDialogFooter>
                  </AlertDialogContent>
                </AlertDialog>
              ) : null}
            </div>
          </div>
        ) : null}

        {activeTab === "members" ? memberManagementSection : null}
      </div>
    </div>
  );
}
