import { Activity } from "lucide-react";
import { Widget, WidgetHead, WidgetBody } from "@/components/widget/widget";
import { RealtimeFullView } from "@/components/dashboard/realtime-full-view";
import { getDictionary } from "@/lib/i18n/dictionaries";
import { isValidLocale, DEFAULT_LOCALE } from "@/lib/i18n/config";
import type { Locale } from "@/lib/i18n/config";
import { fetchAdminSites, fetchAdminTeams } from "@/lib/edge-client";
import { EmptyState } from "@/components/shared/empty-state";
import Link from "next/link";
import { Button } from "@/components/ui/button";

interface RealtimeSearchParams {
  teamId?: string;
  siteId?: string;
}

export default async function RealtimePage({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string }>;
  searchParams: Promise<RealtimeSearchParams>;
}) {
  const { locale: rawLocale } = await params;
  const locale: Locale = isValidLocale(rawLocale) ? rawLocale : DEFAULT_LOCALE;
  const dict = await getDictionary(locale);
  const t = (key: string) => dict[key] ?? key;
  const sp = await searchParams;

  const teams = await fetchAdminTeams();
  if (teams.length === 0) {
    return (
      <div className="mx-auto max-w-4xl">
        <EmptyState title={t("dashboard.noTeam")} description={t("dashboard.noTeamHint")}
          action={<Button asChild><Link href={`/${locale}/app/teams`}>{t("dashboard.goTeamSetup")}</Link></Button>}
        />
      </div>
    );
  }

  const selectedTeamId = (sp.teamId && teams.some((t) => t.id === sp.teamId) ? sp.teamId : undefined) || teams[0].id;
  const sites = await fetchAdminSites(selectedTeamId);
  if (sites.length === 0) {
    return (
      <div className="mx-auto max-w-4xl">
        <EmptyState title={t("dashboard.noSite")} description={t("dashboard.noSiteHint")}
          action={<Button asChild><Link href={`/${locale}/app/teams?teamId=${selectedTeamId}`}>{t("dashboard.createSite")}</Link></Button>}
        />
      </div>
    );
  }

  const selectedSiteId = (sp.siteId && sites.some((s) => s.id === sp.siteId) ? sp.siteId : undefined) || sites[0].id;
  const wsBaseUrl = process.env.NEXT_PUBLIC_INSIGHTFLARE_WS_URL || process.env.INSIGHTFLARE_EDGE_URL || "";
  const wsToken = process.env.NEXT_PUBLIC_INSIGHTFLARE_WS_TOKEN || "";

  return (
    <div className="mx-auto max-w-7xl space-y-4">
      <div>
        <h1 className="text-xl font-semibold">{t("realtime.title")}</h1>
        <p className="mt-1 text-sm text-muted-foreground">{t("realtime.description")}</p>
      </div>

      <RealtimeFullView
        siteId={selectedSiteId}
        wsBaseUrl={wsBaseUrl}
        wsToken={wsToken}
        labels={{
          title: t("dashboard.realtimeStream"),
          wsHint: t("dashboard.wsHint"),
          waitingLive: t("dashboard.waitingLive"),
          noEvents: t("realtime.noEvents"),
          live: t("dashboard.liveVisitors"),
        }}
      />
    </div>
  );
}
