import { DashboardClient } from "@/components/dashboard/dashboard-client";
import { StickyDashboardHeader } from "@/components/dashboard/sticky-dashboard-header";
import { getDictionary } from "@/lib/i18n/dictionaries";
import { isValidLocale, DEFAULT_LOCALE } from "@/lib/i18n/config";
import type { Locale } from "@/lib/i18n/config";
import {
  fetchPrivateEvents,
  fetchPrivateOverview,
  fetchPrivatePages,
  fetchPrivateReferrers,
  fetchPrivateSessions,
  fetchPrivateTrend,
  fetchPrivateVisitors,
} from "@/lib/edge-client";

interface SearchParams {
  from?: string;
  to?: string;
  fromIso?: string;
  toIso?: string;
  interval?: string;
}

function parseDateInput(value: string | undefined): number | null {
  if (!value) return null;
  const parsed = Date.parse(value);
  if (Number.isFinite(parsed)) return parsed;
  const num = Number(value);
  if (Number.isFinite(num)) return Math.floor(num);
  return null;
}

function resolveRange(sp: SearchParams): { from: number; to: number } {
  const now = Date.now();
  const from =
    parseDateInput(sp.fromIso) ??
    parseDateInput(sp.from) ??
    now - 7 * 24 * 60 * 60 * 1000;
  const to = parseDateInput(sp.toIso) ?? parseDateInput(sp.to) ?? now;
  return { from: Math.min(from, to), to: Math.max(from, to) };
}

export default async function SiteDashboardPage({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string; teamId: string; siteId: string }>;
  searchParams: Promise<SearchParams>;
}) {
  const { locale: rawLocale, teamId, siteId } = await params;
  const locale: Locale = isValidLocale(rawLocale) ? rawLocale : DEFAULT_LOCALE;
  const dict = await getDictionary(locale);
  const t = (key: string) => dict[key] ?? key;

  const sp = await searchParams;
  const { from, to } = resolveRange(sp);
  const interval = sp.interval === "hour" ? "hour" : "day";

  const wsBaseUrl =
    process.env.NEXT_PUBLIC_INSIGHTFLARE_WS_URL ||
    process.env.INSIGHTFLARE_EDGE_URL ||
    "";
  const wsToken = process.env.NEXT_PUBLIC_INSIGHTFLARE_WS_TOKEN || "";

  const [overview, trend, pages, referrers, sessions, events, visitors] = await Promise.all([
    fetchPrivateOverview({ siteId, from, to }),
    fetchPrivateTrend({ siteId, from, to, interval }),
    fetchPrivatePages({ siteId, from, to }),
    fetchPrivateReferrers({ siteId, from, to }),
    fetchPrivateSessions({ siteId, from, to }),
    fetchPrivateEvents({ siteId, from, to, limit: 120 }),
    fetchPrivateVisitors({ siteId, from, to, limit: 120 }),
  ]);

  const labels = {
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
    topSources: t("dashboard.topSources"),
    topDevices: t("dashboard.topDevices"),
    topCountries: t("dashboard.topCountries"),
    topEventsBreakdown: t("dashboard.topEventsBreakdown"),
    sessionSnapshot: t("dashboard.sessionSnapshot"),
    noSessions: t("dashboard.noSessions"),
    realtimeStream: t("dashboard.realtimeStream"),
    wsHint: t("dashboard.wsHint"),
    waitingLive: t("dashboard.waitingLive"),
    direct: t("dashboard.direct"),
    recentEvents: t("dashboard.recentEvents"),
    profiles: t("dashboard.profiles"),
    noEvents: t("realtime.noEvents"),
    noVisitors: t("profiles.noVisitors"),
    viewAllPages: t("dashboard.viewAllPages"),
    viewAllSessions: t("dashboard.viewAllSessions"),
    viewAllEvents: t("dashboard.viewAllEvents"),
    viewAllProfiles: t("dashboard.viewAllProfiles"),
    fullRealtimeView: t("dashboard.fullRealtimeView"),
  };

  return (
    <div className="mx-auto max-w-7xl">
      <StickyDashboardHeader
        locale={locale}
        from={from}
        to={to}
        interval={interval}
        siteId={siteId}
        wsBaseUrl={wsBaseUrl}
        wsToken={wsToken}
      />

      <DashboardClient
        overview={overview.data}
        trend={trend.data}
        pages={pages.data}
        referrers={referrers.data}
        sessions={sessions.data}
        events={events.data}
        visitors={visitors.data}
        interval={interval}
        siteId={siteId}
        teamId={teamId}
        wsBaseUrl={wsBaseUrl}
        wsToken={wsToken}
        locale={locale}
        labels={labels}
      />
    </div>
  );
}
