import { Suspense } from "react";
import { DashboardClient } from "@/components/dashboard/dashboard-client";
import { StickyDashboardHeader } from "@/components/dashboard/sticky-dashboard-header";
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
    <div className="mx-auto max-w-7xl">
      <StickyDashboardHeader
        teams={teams}
        sites={sites}
        currentTeamId={selectedTeamId}
        currentSiteId={selectedSiteId}
        locale={locale}
        from={range.from}
        to={range.to}
        wsBaseUrl={wsBaseUrl}
        wsToken={wsToken}
      />

      <DashboardClient
        overview={overview.data}
        trend={trend.data}
        pages={pages.data}
        referrers={referrers.data}
        sessions={sessions.data}
        siteId={selectedSiteId}
        wsBaseUrl={wsBaseUrl}
        wsToken={wsToken}
        locale={locale}
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
          topPages: t("dashboard.topPages"),
          topReferrers: t("dashboard.topReferrers"),
          sessionSnapshot: t("dashboard.sessionSnapshot"),
          noSessions: t("dashboard.noSessions"),
          realtimeStream: t("dashboard.realtimeStream"),
          wsHint: t("dashboard.wsHint"),
          waitingLive: t("dashboard.waitingLive"),
          direct: t("dashboard.direct"),
          viewAllPages: t("dashboard.viewAllPages"),
          viewAllSessions: t("dashboard.viewAllSessions"),
          fullRealtimeView: t("dashboard.fullRealtimeView"),
        }}
      />
    </div>
  );
}
