import { Suspense } from "react";
import { BarChart3, Globe, Route } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { OverviewGrid } from "@/components/dashboard/overview-grid";
import { TrendAreaChart } from "@/components/charts/trend-area-chart";
import { ReferrerBarChart } from "@/components/charts/referrer-bar-chart";
import { PagesBarChart } from "@/components/charts/pages-bar-chart";
import { SessionList } from "@/components/dashboard/session-list";
import { RealtimePanel } from "@/components/dashboard/realtime-panel";
import { TeamSiteSelector } from "@/components/dashboard/team-site-selector";
import { DateRangePicker } from "@/components/dashboard/date-range-picker";
import { EmptyState } from "@/components/shared/empty-state";
import { DashboardSkeleton } from "@/components/shared/loading-skeleton";
import { getDictionary } from "@/lib/i18n/dictionaries";
import { isValidLocale, DEFAULT_LOCALE } from "@/lib/i18n/config";
import type { Locale } from "@/lib/i18n/config";
import {
  fetchAdminSites,
  fetchAdminTeams,
  fetchPrivateOverview,
  fetchPrivatePages,
  fetchPrivateReferrers,
  fetchPrivateSessions,
  fetchPrivateTrend,
} from "@/lib/edge-client";
import { compactNumber, formatDateTime } from "@/lib/utils";
import Link from "next/link";
import { Button } from "@/components/ui/button";

interface DashboardSearchParams {
  teamId?: string;
  siteId?: string;
  from?: string;
  to?: string;
  fromIso?: string;
  toIso?: string;
}

function parseDateInput(value: string | undefined): number | null {
  if (!value) return null;
  const fromDate = Date.parse(value);
  if (Number.isFinite(fromDate)) return fromDate;
  const fromNum = Number(value);
  if (Number.isFinite(fromNum)) return Math.floor(fromNum);
  return null;
}

function resolveRange(searchParams: DashboardSearchParams): { siteId: string; from: number; to: number } {
  const now = Date.now();
  const defaultFrom = now - 7 * 24 * 60 * 60 * 1000;
  const fromIso = parseDateInput(searchParams.fromIso);
  const toIso = parseDateInput(searchParams.toIso);
  const fromRaw = parseDateInput(searchParams.from);
  const toRaw = parseDateInput(searchParams.to);
  const from = fromIso ?? fromRaw ?? defaultFrom;
  const to = toIso ?? toRaw ?? now;
  return {
    siteId: searchParams.siteId || process.env.INSIGHTFLARE_DEFAULT_SITE_ID || "default",
    from: Math.min(from, to),
    to: Math.max(from, to),
  };
}

export default async function DashboardPage({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string }>;
  searchParams: Promise<DashboardSearchParams>;
}) {
  const { locale: rawLocale } = await params;
  const locale: Locale = isValidLocale(rawLocale) ? rawLocale : DEFAULT_LOCALE;
  const dict = await getDictionary(locale);
  const t = (key: string) => dict[key] ?? key;
  const sp = await searchParams;
  const baseRange = resolveRange(sp);

  const teams = await fetchAdminTeams();
  if (teams.length === 0) {
    return (
      <div className="mx-auto max-w-4xl">
        <EmptyState
          title={t("dashboard.noTeam")}
          description={t("dashboard.noTeamHint")}
          action={
            <Button asChild>
              <Link href={`/${locale}/app/teams`}>{t("dashboard.goTeamSetup")}</Link>
            </Button>
          }
        />
      </div>
    );
  }

  const selectedTeamId =
    (sp.teamId && teams.some((team) => team.id === sp.teamId) ? sp.teamId : undefined) || teams[0].id;

  const sites = await fetchAdminSites(selectedTeamId);
  if (sites.length === 0) {
    return (
      <div className="mx-auto max-w-4xl">
        <EmptyState
          title={t("dashboard.noSite")}
          description={t("dashboard.noSiteHint")}
          action={
            <Button asChild>
              <Link href={`/${locale}/app/teams?teamId=${selectedTeamId}`}>{t("dashboard.createSite")}</Link>
            </Button>
          }
        />
      </div>
    );
  }

  const selectedSiteId =
    (sp.siteId && sites.some((site) => site.id === sp.siteId) ? sp.siteId : undefined) || sites[0].id;

  const range = { ...baseRange, siteId: selectedSiteId };

  const [overview, trend, pages, referrers, sessions] = await Promise.all([
    fetchPrivateOverview(range),
    fetchPrivateTrend({ ...range, interval: "day" }),
    fetchPrivatePages(range),
    fetchPrivateReferrers(range),
    fetchPrivateSessions(range),
  ]);

  const wsBaseUrl = process.env.NEXT_PUBLIC_INSIGHTFLARE_WS_URL || process.env.INSIGHTFLARE_EDGE_URL || "";
  const wsToken = process.env.NEXT_PUBLIC_INSIGHTFLARE_WS_TOKEN || "";

  return (
    <div className="mx-auto max-w-7xl space-y-6">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="font-[var(--font-display)] text-3xl font-semibold">{t("dashboard.title")}</h1>
          <p className="mt-1 text-sm text-muted-foreground">{t("dashboard.description")}</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <TeamSiteSelector
            teams={teams}
            sites={sites}
            currentTeamId={selectedTeamId}
            currentSiteId={selectedSiteId}
          />
          <DateRangePicker locale={locale} from={range.from} to={range.to} />
        </div>
      </div>

      <OverviewGrid
        views={overview.data.views}
        sessions={overview.data.sessions}
        visitors={overview.data.visitors}
        bounceRate={overview.data.bounceRate}
        avgDurationMs={overview.data.avgDurationMs}
        approximateVisitors={overview.data.approximateVisitors}
        labels={{
          views: t("dashboard.views"),
          sessions: t("dashboard.sessions"),
          visitors: t("dashboard.visitors"),
          bounceRate: t("dashboard.bounceRate"),
          avgDuration: t("dashboard.avgDuration"),
          hintViews: t("dashboard.hintViews"),
          hintSessions: t("dashboard.hintSessions"),
          hintVisitorsExact: t("dashboard.hintVisitorsExact"),
          hintVisitorsApprox: t("dashboard.hintVisitorsApprox"),
          hintBounce: t("dashboard.hintBounce"),
          hintDuration: t("dashboard.hintDuration"),
        }}
      />

      <div className="grid gap-4 lg:grid-cols-[1.35fr_1fr]">
        <Card>
          <CardHeader className="flex-row items-center justify-between">
            <CardTitle className="flex items-center gap-2">
              <BarChart3 className="h-5 w-5 text-primary" />
              {t("dashboard.trafficTrend")}
            </CardTitle>
            <Badge variant="secondary">{t("dashboard.daily")}</Badge>
          </CardHeader>
          <CardContent>
            <TrendAreaChart data={trend.data} />
          </CardContent>
        </Card>

        <SessionList
          sessions={sessions.data}
          labels={{
            title: t("dashboard.sessionSnapshot"),
            empty: t("dashboard.noSessions"),
          }}
        />
      </div>

      <RealtimePanel
        siteId={range.siteId}
        wsBaseUrl={wsBaseUrl}
        wsToken={wsToken}
        labels={{
          title: t("dashboard.realtimeStream"),
          wsHint: t("dashboard.wsHint"),
          waitingLive: t("dashboard.waitingLive"),
        }}
      />

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Route className="h-5 w-5 text-primary" />
              {t("dashboard.topPages")}
            </CardTitle>
          </CardHeader>
          <CardContent>
            {pages.data.length > 0 ? (
              <PagesBarChart data={pages.data} />
            ) : (
              <p className="text-sm text-muted-foreground">{t("common.noData")}</p>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Globe className="h-5 w-5 text-primary" />
              {t("dashboard.topReferrers")}
            </CardTitle>
          </CardHeader>
          <CardContent>
            {referrers.data.length > 0 ? (
              <ReferrerBarChart data={referrers.data} directLabel={t("dashboard.direct")} />
            ) : (
              <p className="text-sm text-muted-foreground">{t("common.noData")}</p>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
