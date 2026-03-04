"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import {
  RiArrowDownLine,
  RiArrowDownSLine,
  RiArrowRightSLine,
  RiArrowUpLine,
  RiArrowUpSLine,
  RiDeleteBinLine,
} from "@remixicon/react";
import { Badge } from "@/components/ui/badge";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { AutoTransition } from "@/components/ui/auto-transition";
import { Clickable } from "@/components/ui/clickable";
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
import { TableCell, TableHead, TableRow } from "@/components/ui/table";
import { DataTableSwitch } from "@/components/dashboard/data-table-switch";
import {
  SiteTrafficStackChart,
  TrafficPairBarChart,
} from "@/components/dashboard/site-traffic-charts";
import { PageHeading } from "@/components/dashboard/page-heading";
import { useDashboardQuery } from "@/components/dashboard/dashboard-query-provider";
import {
  durationFormat,
  intlLocale,
  numberFormat,
  percentFormat,
  shortDateTime,
} from "@/lib/dashboard/format";
import type { TimeWindow } from "@/lib/dashboard/query-state";
import type {
  MemberData,
  OverviewData,
  SiteData,
  TeamData,
} from "@/lib/edge-client";
import type { Locale } from "@/lib/i18n/config";
import type { AppMessages } from "@/lib/i18n/messages";
import { navigateWithTransition } from "@/lib/page-transition";

type TeamTab = "sites" | "settings" | "members";

type SiteOverviewMetrics = OverviewData["data"];
type SiteMetricChangeRates = {
  views: number | null;
  visitors: number | null;
  sessions: number | null;
  bounceRate: number | null;
  avgDurationMs: number | null;
  pagesPerSession: number | null;
};

function emptyOverviewMetrics(): SiteOverviewMetrics {
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

function normalizeChangeRate(value: number | null | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function formatChangeRate(value: number | null): string | null {
  if (value === null) return null;
  return `${value >= 0 ? "+" : ""}${value.toFixed(1)}%`;
}

function changeRateClass(value: number | null): string {
  if (value === null) return "text-muted-foreground";
  return value >= 0 ? "text-emerald-600" : "text-rose-600";
}

function ChangeRateInline({ value }: { value: number | null }) {
  if (value === null) return null;
  const Icon = value >= 0 ? RiArrowUpLine : RiArrowDownLine;
  return (
    <span
      className={`inline-flex items-end gap-0.5 font-mono text-xs leading-none ${changeRateClass(value)}`}
    >
      <Icon className="size-3.5" />
      {formatChangeRate(value)}
    </span>
  );
}

interface TeamManagementClientProps {
  locale: Locale;
  messages: AppMessages;
  activeTeam: TeamData;
  activeTab: TeamTab;
}

function safeSlug(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function getSiteSlug(site: SiteData): string {
  const primary = String(site.publicSlug || "").trim();
  const domain = String(site.domain || "").trim();
  const name = String(site.name || "").trim();
  const candidate = safeSlug(primary || domain || name);
  if (candidate.length > 0) return candidate;
  return site.id.slice(0, 8);
}

function withSiteSlug(site: SiteData): SiteData & { slug: string } {
  return {
    ...site,
    slug: getSiteSlug(site),
  };
}

function buildSitePath(
  locale: Locale,
  teamSlug: string,
  siteSlug: string,
): string {
  return `/${locale}/app/${teamSlug}/${siteSlug}`;
}

function resolveFaviconUrl(domain: string): string | null {
  const trimmed = domain.trim();
  if (!trimmed) return null;
  try {
    const parsed = new URL(
      trimmed.includes("://") ? trimmed : `https://${trimmed}`,
    );
    return `${parsed.origin}/favicon.ico`;
  } catch {
    return null;
  }
}

function leadingLetter(name: string): string {
  const normalized = name.trim();
  if (!normalized) return "?";
  return normalized.slice(0, 1).toUpperCase();
}

function SiteCardIcon({
  siteName,
  domain,
}: {
  siteName: string;
  domain: string;
}) {
  const src = useMemo(() => resolveFaviconUrl(domain), [domain]);
  const [iconLoaded, setIconLoaded] = useState(false);
  const [iconFailed, setIconFailed] = useState(false);

  useEffect(() => {
    setIconLoaded(false);
    setIconFailed(false);
    if (!src) return;

    let active = true;
    const image = new Image();
    image.onload = () => {
      if (!active) return;
      setIconLoaded(true);
    };
    image.onerror = () => {
      if (!active) return;
      setIconFailed(true);
    };
    image.src = src;

    return () => {
      active = false;
    };
  }, [src]);

  const showFavicon = Boolean(src) && iconLoaded && !iconFailed;

  return (
    <AutoTransition
      type="fade"
      duration={0.18}
      initial={false}
      className="inline-flex size-5 shrink-0 items-center justify-center"
    >
      {showFavicon ? (
        <img key="favicon" src={src!} alt="" className="size-5 shrink-0" />
      ) : (
        <span
          key="fallback"
          className="inline-flex size-5 shrink-0 items-center justify-center bg-muted text-[10px] font-medium text-muted-foreground"
        >
          {leadingLetter(siteName)}
        </span>
      )}
    </AutoTransition>
  );
}

function intervalStepMs(interval: TimeWindow["interval"]): number {
  if (interval === "minute") return 60 * 1000;
  if (interval === "hour") return 60 * 60 * 1000;
  if (interval === "day") return 24 * 60 * 60 * 1000;
  if (interval === "week") return 7 * 24 * 60 * 60 * 1000;
  return 30 * 24 * 60 * 60 * 1000;
}

interface TeamDashboardTrendPoint {
  bucket: number;
  timestampMs: number;
  sites: Array<{
    siteId: string;
    views: number;
    visitors: number;
  }>;
}

interface TeamDashboardSite extends SiteData {
  overview: SiteOverviewMetrics;
  changeRates?: SiteMetricChangeRates;
}

interface TeamDashboardData {
  sites: TeamDashboardSite[];
  trend: TeamDashboardTrendPoint[];
}

async function fetchTeamDashboard(
  teamId: string,
  window: Pick<TimeWindow, "from" | "to" | "interval">,
): Promise<TeamDashboardData> {
  const params = new URLSearchParams({
    teamId,
    from: String(window.from),
    to: String(window.to),
    interval: window.interval,
  });
  const response = await fetch(
    `/api/private/team-dashboard?${params.toString()}`,
    {
      method: "GET",
      credentials: "include",
    },
  );
  if (!response.ok) throw new Error("fetch_team_dashboard_failed");
  const payload = (await response.json()) as {
    ok: boolean;
    data?: {
      sites?: TeamDashboardSite[];
      trend?: TeamDashboardTrendPoint[];
    };
  };
  if (!payload.ok || !payload.data) {
    throw new Error("fetch_team_dashboard_failed");
  }
  return {
    sites: Array.isArray(payload.data.sites) ? payload.data.sites : [],
    trend: Array.isArray(payload.data.trend) ? payload.data.trend : [],
  };
}

async function fetchTeamMembers(teamId: string): Promise<MemberData[]> {
  const url = `/api/private/admin/members?teamId=${encodeURIComponent(teamId)}`;
  const response = await fetch(url, {
    method: "GET",
    credentials: "include",
    cache: "no-store",
  });
  if (!response.ok) throw new Error("fetch_team_members_failed");
  const payload = (await response.json()) as {
    ok: boolean;
    data?: MemberData[];
  };
  return Array.isArray(payload.data) ? payload.data : [];
}

interface ActionResponse<T> {
  ok: boolean;
  data?: T;
  error?: string;
  message?: string;
}

async function postJson<T>(
  url: string,
  body: Record<string, unknown>,
): Promise<T> {
  const response = await fetch(url, {
    method: "POST",
    credentials: "include",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
  const payload = (await response.json()) as ActionResponse<T>;
  if (!response.ok || !payload.ok || payload.data === undefined) {
    throw new Error(payload.message || payload.error || "request_failed");
  }
  return payload.data;
}

export function TeamManagementClient({
  locale,
  messages,
  activeTeam,
  activeTab,
}: TeamManagementClientProps) {
  const router = useRouter();
  const { window } = useDashboardQuery();
  const copy = messages.teamManagement;
  const [sites, setSites] = useState<Array<SiteData & { slug: string }>>([]);
  const [members, setMembers] = useState<MemberData[]>([]);
  const [loading, setLoading] = useState(true);
  const [currentTeamName, setCurrentTeamName] = useState(activeTeam.name);
  const [teamName, setTeamName] = useState(activeTeam.name);
  const [teamSlug, setTeamSlug] = useState(activeTeam.slug);
  const [memberIdentifier, setMemberIdentifier] = useState("");
  const [savingTeam, setSavingTeam] = useState(false);
  const [deletingTeam, setDeletingTeam] = useState(false);
  const [deleteTeamDialogOpen, setDeleteTeamDialogOpen] = useState(false);
  const [addingMember, setAddingMember] = useState(false);
  const [removingMemberId, setRemovingMemberId] = useState<string | null>(null);
  const [analyticsLoading, setAnalyticsLoading] = useState(false);
  const [siteOverviewById, setSiteOverviewById] = useState<
    Record<string, SiteOverviewMetrics>
  >({});
  const [siteChangeRatesById, setSiteChangeRatesById] = useState<
    Record<string, SiteMetricChangeRates>
  >({});
  const [teamTrend, setTeamTrend] = useState<TeamDashboardTrendPoint[]>([]);

  useEffect(() => {
    if (activeTab !== "members") return;
    let active = true;
    setLoading(true);

    fetchTeamMembers(activeTeam.id)
      .then((nextMembers) => {
        if (!active) return;
        setMembers(nextMembers);
      })
      .catch(() => {
        if (!active) return;
        setMembers([]);
      })
      .finally(() => {
        if (!active) return;
        setLoading(false);
      });

    return () => {
      active = false;
    };
  }, [activeTeam.id, activeTab]);

  useEffect(() => {
    setCurrentTeamName(activeTeam.name);
    setTeamName(activeTeam.name);
    setTeamSlug(activeTeam.slug);
    setMemberIdentifier("");
    setSites([]);
    setMembers([]);
    setSiteOverviewById({});
    setSiteChangeRatesById({});
    setTeamTrend([]);
  }, [activeTeam.id, activeTeam.name, activeTeam.slug]);

  useEffect(() => {
    if (activeTab !== "sites") return;

    let active = true;
    setLoading(true);
    setAnalyticsLoading(true);

    fetchTeamDashboard(activeTeam.id, window)
      .then((dashboard) => {
        if (!active) return;
        setSites(dashboard.sites.map(withSiteSlug));
        setSiteOverviewById(
          Object.fromEntries(
            dashboard.sites.map((site) => [
              site.id,
              site.overview ?? emptyOverviewMetrics(),
            ]),
          ),
        );
        setSiteChangeRatesById(
          Object.fromEntries(
            dashboard.sites.map((site) => [
              site.id,
              {
                views: normalizeChangeRate(site.changeRates?.views),
                visitors: normalizeChangeRate(site.changeRates?.visitors),
                sessions: normalizeChangeRate(site.changeRates?.sessions),
                bounceRate: normalizeChangeRate(site.changeRates?.bounceRate),
                avgDurationMs: normalizeChangeRate(site.changeRates?.avgDurationMs),
                pagesPerSession: normalizeChangeRate(site.changeRates?.pagesPerSession),
              },
            ]),
          ),
        );
        setTeamTrend(dashboard.trend);
      })
      .catch(() => {
        if (!active) return;
        setSites([]);
        setSiteOverviewById({});
        setSiteChangeRatesById({});
        setTeamTrend([]);
      })
      .finally(() => {
        if (!active) return;
        setLoading(false);
        setAnalyticsLoading(false);
      });

    return () => {
      active = false;
    };
  }, [activeTeam.id, activeTab, window.from, window.to, window.interval]);

  useEffect(() => {
    if (activeTab === "sites" || activeTab === "members") return;
    setLoading(false);
    setAnalyticsLoading(false);
  }, [activeTab]);

  async function refreshMembers() {
    const nextMembers = await fetchTeamMembers(activeTeam.id);
    setMembers(nextMembers);
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
      const updated = await postJson<TeamData>("/api/admin/team", {
        teamId: activeTeam.id,
        name,
        slug: slug || undefined,
      });
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

  async function handleAddMember() {
    const identifier = memberIdentifier.trim();
    if (identifier.length < 2) {
      toast.error(copy.toasts.invalidMemberIdentifier);
      return;
    }

    setAddingMember(true);
    try {
      await postJson("/api/admin/member", {
        teamId: activeTeam.id,
        identifier,
      });
      setMemberIdentifier("");
      await refreshMembers();
      toast.success(copy.toasts.memberAdded);
    } catch (error) {
      const message =
        error instanceof Error ? error.message : copy.toasts.memberAddFailed;
      toast.error(message || copy.toasts.memberAddFailed);
    } finally {
      setAddingMember(false);
    }
  }

  async function handleDeleteTeam() {
    setDeletingTeam(true);
    try {
      await postJson("/api/admin/team", {
        intent: "remove",
        teamId: activeTeam.id,
      });
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

  async function handleRemoveMember(userId: string) {
    setRemovingMemberId(userId);
    try {
      await postJson("/api/admin/member", {
        intent: "remove",
        teamId: activeTeam.id,
        userId,
      });
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
    const stepMs = intervalStepMs(window.interval);
    if (!Number.isFinite(stepMs) || stepMs <= 0) return [];

    const fromBucket = Math.floor(window.from / stepMs);
    const toBucket = Math.max(fromBucket, Math.floor(window.to / stepMs));
    const timeline = new Map<
      number,
      {
        timestampMs: number;
        sites: Map<string, { views: number; visitors: number }>;
      }
    >();

    for (let bucket = fromBucket; bucket <= toBucket; bucket += 1) {
      timeline.set(bucket, {
        timestampMs: bucket * stepMs,
        sites: new Map(),
      });
    }

    for (const point of teamTrend) {
      const bucket =
        Number.isFinite(point.bucket) && point.bucket >= 0
          ? point.bucket
          : Math.floor(point.timestampMs / stepMs);
      const current = timeline.get(bucket) ?? {
        timestampMs: point.timestampMs || bucket * stepMs,
        sites: new Map<string, { views: number; visitors: number }>(),
      };

      for (const sitePoint of point.sites) {
        const previous = current.sites.get(sitePoint.siteId) ?? {
          views: 0,
          visitors: 0,
        };
        current.sites.set(sitePoint.siteId, {
          views: previous.views + (sitePoint.views ?? 0),
          visitors: previous.visitors + (sitePoint.visitors ?? 0),
        });
      }
      timeline.set(bucket, current);
    }

    return Array.from(timeline.entries())
      .sort((left, right) => left[0] - right[0])
      .map(([, value]) => ({
        timestampMs: value.timestampMs,
        sites: Array.from(value.sites.entries()).map(([siteId, siteValue]) => ({
          siteId,
          views: siteValue.views,
          visitors: siteValue.visitors,
        })),
      }));
  }, [teamTrend, window.from, window.to, window.interval]);

  const siteTrendById = useMemo(() => {
    const stepMs = intervalStepMs(window.interval);
    if (!Number.isFinite(stepMs) || stepMs <= 0) {
      return {} as Record<
        string,
        Array<{ timestampMs: number; views: number; visitors: number }>
      >;
    }

    const fromBucket = Math.floor(window.from / stepMs);
    const toBucket = Math.max(fromBucket, Math.floor(window.to / stepMs));
    const siteBuckets = new Map<
      string,
      Map<number, { timestampMs: number; views: number; visitors: number }>
    >();

    for (const site of sites) {
      const bucketMap = new Map<
        number,
        { timestampMs: number; views: number; visitors: number }
      >();
      for (let bucket = fromBucket; bucket <= toBucket; bucket += 1) {
        bucketMap.set(bucket, {
          timestampMs: bucket * stepMs,
          views: 0,
          visitors: 0,
        });
      }
      siteBuckets.set(site.id, bucketMap);
    }

    for (const point of teamTrend) {
      const bucket =
        Number.isFinite(point.bucket) && point.bucket >= 0
          ? point.bucket
          : Math.floor(point.timestampMs / stepMs);

      for (const sitePoint of point.sites) {
        const bucketMap = siteBuckets.get(sitePoint.siteId);
        if (!bucketMap) continue;
        const existing = bucketMap.get(bucket) ?? {
          timestampMs: point.timestampMs || bucket * stepMs,
          views: 0,
          visitors: 0,
        };
        existing.views += sitePoint.views ?? 0;
        existing.visitors += sitePoint.visitors ?? 0;
        bucketMap.set(bucket, existing);
      }
    }

    return Object.fromEntries(
      Array.from(siteBuckets.entries()).map(([siteId, bucketMap]) => [
        siteId,
        Array.from(bucketMap.entries())
          .sort((left, right) => left[0] - right[0])
          .map(([, value]) => value),
      ]),
    );
  }, [sites, teamTrend, window.from, window.to, window.interval]);

  const siteDashboardCards = useMemo(
    () =>
      sites
        .map((site) => {
          const overview = siteOverviewById[site.id] ?? emptyOverviewMetrics();
          const pagesPerSession =
            overview.sessions > 0 ? overview.views / overview.sessions : 0;
          return {
            site,
            overview,
            pagesPerSession,
            changeRates:
              siteChangeRatesById[site.id] ?? emptySiteMetricChangeRates(),
            trend: siteTrendById[site.id] ?? [],
          };
        })
        .sort((left, right) => {
          const byViews = right.overview.views - left.overview.views;
          if (byViews !== 0) return byViews;
          const byVisitors = right.overview.visitors - left.overview.visitors;
          if (byVisitors !== 0) return byVisitors;
          return left.site.name.localeCompare(right.site.name);
        }),
    [sites, siteOverviewById, siteChangeRatesById, siteTrendById],
  );

  const pagesPerSessionFormatter = useMemo(
    () =>
      new Intl.NumberFormat(intlLocale(locale), {
        maximumFractionDigits: 2,
      }),
    [locale],
  );

  const siteCount = useMemo(
    () => (activeTab === "sites" ? sites.length : activeTeam.siteCount),
    [activeTab, sites.length, activeTeam.siteCount],
  );

  const memberCount = useMemo(
    () => (activeTab === "members" ? members.length : activeTeam.memberCount),
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
  const isSitesChartsLoading =
    activeTab === "sites" && (loading || analyticsLoading);

  return (
    <div className="space-y-6">
      <PageHeading
        title={`${panelTitle} · ${currentTeamName}`}
        subtitle={panelSubtitle}
        actions={
          <>
            <Badge variant="outline">
              <span className="inline-flex items-center gap-1.5">
                {copy.stats.sites}:
                <AutoTransition initial className="inline-flex items-center">
                  {loading ? (
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
              </span>
            </Badge>
            <Badge variant="outline">
              <span className="inline-flex items-center gap-1.5">
                {copy.stats.members}:
                <AutoTransition initial className="inline-flex items-center">
                  {loading ? (
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
              </span>
            </Badge>
          </>
        }
      />

      <div className="space-y-4">
        {activeTab === "sites" ? (
          <div className="space-y-4">
            <Card className="overflow-visible">
              <CardHeader>
                <CardTitle>{copy.sites.aggregateTitle}</CardTitle>
              </CardHeader>

              <CardContent className="space-y-3">
                <div className="relative">
                  <SiteTrafficStackChart
                    data={aggregateChartRenderData}
                    sites={sites.map((site) => ({
                      id: site.id,
                      name: site.name,
                    }))}
                    locale={locale}
                    interval={window.interval}
                    viewsLabel={messages.common.views}
                    visitorsLabel={messages.common.visitors}
                    className={isSitesChartsLoading ? "opacity-40" : undefined}
                  />
                  <AutoTransition
                    type="fade"
                    duration={0.22}
                    className="pointer-events-none absolute inset-0"
                  >
                    {isSitesChartsLoading ? (
                      <div
                        key="aggregate-overlay-loading"
                        className="flex h-full w-full items-center justify-center bg-background/50 text-sm text-muted-foreground"
                      >
                        <span className="inline-flex items-center gap-2">
                          <Spinner className="size-4" />
                          {messages.common.loading}
                        </span>
                      </div>
                    ) : (
                      <div
                        key="aggregate-overlay-idle"
                        className="h-full w-full bg-transparent"
                      />
                    )}
                  </AutoTransition>
                </div>

                {!loading && !analyticsLoading && sites.length === 0 ? (
                  <p className="text-sm text-muted-foreground">
                    {copy.sites.noSites}
                  </p>
                ) : null}
              </CardContent>
            </Card>

            {sites.length > 0 ? (
              <div className="grid gap-4 lg:grid-cols-2">
                {siteDashboardCards.map(
                  ({ site, overview, pagesPerSession, changeRates, trend }) => (
                    <Clickable
                      key={site.id}
                      onClick={() => {
                        navigateWithTransition(
                          router,
                          buildSitePath(locale, activeTeam.slug, site.slug),
                        );
                      }}
                      className="block w-full"
                      enableHoverScale={false}
                      aria-label={`${copy.sites.openAnalytics}: ${site.name}`}
                      title={copy.sites.openAnalytics}
                    >
                      <Card className="h-full transition-colors hover:bg-accent/20">
                        <CardHeader className="space-y-2">
                          <div className="flex items-start justify-between gap-3">
                            <div className="flex min-w-0 items-start gap-2.5">
                              <div className="min-w-0 space-y-1">
                                <CardTitle className="truncate text-base flex items-center gap-2">
                                  <SiteCardIcon
                                    siteName={site.name}
                                    domain={site.domain}
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
                          <AutoTransition
                            type="fade"
                            duration={0.24}
                            className="w-full"
                          >
                            <div key={`site-chart-${site.id}`}>
                              <TrafficPairBarChart
                                data={trend}
                                locale={locale}
                                interval={window.interval}
                                viewsLabel={messages.common.views}
                                visitorsLabel={messages.common.visitors}
                              />
                            </div>
                          </AutoTransition>

                          <div className="grid grid-cols-3 gap-x-4 gap-y-4 text-[11px]">
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
                                <ChangeRateInline value={changeRates.visitors} />
                              </p>
                            </div>
                            <div className="space-y-1">
                              <p className="text-muted-foreground">
                                {messages.common.sessions}
                              </p>
                              <p className="inline-flex items-end gap-1.5 font-mono text-base leading-none">
                                {numberFormat(locale, overview.sessions)}
                                <ChangeRateInline value={changeRates.sessions} />
                              </p>
                            </div>
                            <div className="space-y-1">
                              <p className="text-muted-foreground">
                                {messages.common.bounceRate}
                              </p>
                              <p className="inline-flex items-end gap-1.5 font-mono text-base leading-none">
                                {percentFormat(locale, overview.bounceRate)}
                                <ChangeRateInline value={changeRates.bounceRate} />
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
                                <ChangeRateInline value={changeRates.pagesPerSession} />
                              </p>
                            </div>
                            <div className="space-y-1">
                              <p className="text-muted-foreground">
                                {messages.common.avgDuration}
                              </p>
                              <p className="inline-flex items-end gap-1.5 font-mono text-base leading-none">
                                {durationFormat(locale, overview.avgDurationMs)}
                                <ChangeRateInline value={changeRates.avgDurationMs} />
                              </p>
                            </div>
                          </div>
                        </CardContent>
                      </Card>
                    </Clickable>
                  ),
                )}
              </div>
            ) : null}
          </div>
        ) : null}

        {activeTab === "settings" ? (
          <div className="grid gap-4 lg:grid-cols-2">
            <Card className="h-full">
              <CardHeader>
                <CardTitle>{copy.settings.title}</CardTitle>
                <CardDescription>{copy.settings.subtitle}</CardDescription>
              </CardHeader>
              <CardContent>
                <form
                  className="space-y-4"
                  onSubmit={(event) => {
                    event.preventDefault();
                    void handleSaveTeamSettings();
                  }}
                >
                  <div className="space-y-2">
                    <Label htmlFor="team-name">{copy.settings.nameLabel}</Label>
                    <Input
                      id="team-name"
                      value={teamName}
                      onChange={(event) => setTeamName(event.target.value)}
                      minLength={2}
                      required
                    />
                  </div>

                  <div className="space-y-2">
                    <Label htmlFor="team-slug">{copy.settings.slugLabel}</Label>
                    <Input
                      id="team-slug"
                      value={teamSlug}
                      onChange={(event) => setTeamSlug(event.target.value)}
                    />
                  </div>

                  <Button type="submit" disabled={savingTeam || deletingTeam}>
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
                        <span key="save">{copy.settings.save}</span>
                      )}
                    </AutoTransition>
                  </Button>
                </form>
              </CardContent>
            </Card>

            <AlertDialog
              open={deleteTeamDialogOpen}
              onOpenChange={(open) => {
                if (deletingTeam) return;
                setDeleteTeamDialogOpen(open);
              }}
            >
              <Card className="h-full border-destructive/40">
                <CardHeader>
                  <CardTitle>{copy.settings.delete}</CardTitle>
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
                          <span key="delete">{copy.settings.delete}</span>
                        )}
                      </AutoTransition>
                    </Button>
                  </AlertDialogTrigger>
                </CardContent>
              </Card>
              <AlertDialogContent size="sm">
                <AlertDialogHeader>
                  <AlertDialogTitle>{copy.settings.delete}</AlertDialogTitle>
                  <AlertDialogDescription>
                    {copy.settings.deleteConfirm}
                  </AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel disabled={deletingTeam}>
                    {messages.teamSelect.cancel}
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
                        <span key="confirm-delete-dialog">
                          {copy.settings.delete}
                        </span>
                      )}
                    </AutoTransition>
                  </AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
          </div>
        ) : null}

        {activeTab === "members" ? (
          <div className="space-y-4">
            <Card className="max-w-2xl">
              <CardHeader>
                <CardTitle>{copy.members.title}</CardTitle>
                <CardDescription>{copy.members.subtitle}</CardDescription>
              </CardHeader>
              <CardContent>
                <form
                  className="grid gap-3 sm:grid-cols-[1fr_auto] sm:items-end"
                  onSubmit={(event) => {
                    event.preventDefault();
                    void handleAddMember();
                  }}
                >
                  <div className="space-y-2">
                    <Label htmlFor="member-identifier">
                      {copy.members.identifierLabel}
                    </Label>
                    <Input
                      id="member-identifier"
                      value={memberIdentifier}
                      onChange={(event) =>
                        setMemberIdentifier(event.target.value)
                      }
                      placeholder={copy.members.identifierPlaceholder}
                      minLength={2}
                      required
                    />
                  </div>
                  <Button type="submit" disabled={addingMember}>
                    <AutoTransition className="inline-flex items-center gap-2">
                      {addingMember ? (
                        <span
                          key="adding"
                          className="inline-flex items-center gap-2"
                        >
                          <Spinner className="size-4" />
                          {copy.members.adding}
                        </span>
                      ) : (
                        <span key="add">{copy.members.add}</span>
                      )}
                    </AutoTransition>
                  </Button>
                </form>
              </CardContent>
            </Card>

            <Card>
              <CardContent className="pt-4">
                <DataTableSwitch
                  loading={loading}
                  hasContent={members.length > 0}
                  loadingLabel={messages.common.loading}
                  emptyLabel={copy.members.noMembers}
                  colSpan={6}
                  header={
                    <TableRow>
                      <TableHead>{copy.members.columns.name}</TableHead>
                      <TableHead>{copy.members.columns.username}</TableHead>
                      <TableHead>{copy.members.columns.email}</TableHead>
                      <TableHead>{copy.members.columns.role}</TableHead>
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
                      <TableCell>{member.role}</TableCell>
                      <TableCell>
                        {shortDateTime(locale, member.joinedAt)}
                      </TableCell>
                      <TableCell className="text-right">
                        <Clickable
                          onClick={() => {
                            void handleRemoveMember(member.userId);
                          }}
                          disabled={removingMemberId === member.userId}
                          className="size-6 text-destructive/80 hover:text-destructive"
                          aria-label={copy.members.remove}
                          title={copy.members.remove}
                        >
                          <AutoTransition className="inline-flex items-center justify-center">
                            {removingMemberId === member.userId ? (
                              <span
                                key="removing"
                                className="inline-flex items-center justify-center"
                              >
                                <Spinner className="size-3.5" />
                              </span>
                            ) : (
                              <span
                                key="remove"
                                className="inline-flex items-center justify-center"
                              >
                                <RiDeleteBinLine className="size-4" />
                              </span>
                            )}
                          </AutoTransition>
                        </Clickable>
                      </TableCell>
                    </TableRow>
                  ))}
                />
              </CardContent>
            </Card>
          </div>
        ) : null}
      </div>
    </div>
  );
}
