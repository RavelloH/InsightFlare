import { Clock } from "lucide-react";
import { Widget, WidgetHead, WidgetBody } from "@/components/widget/widget";
import { SessionCompactList } from "@/components/dashboard/session-compact-list";
import { StickyDashboardHeader } from "@/components/dashboard/sticky-dashboard-header";
import { EmptyState } from "@/components/shared/empty-state";
import { getDictionary } from "@/lib/i18n/dictionaries";
import { isValidLocale, DEFAULT_LOCALE } from "@/lib/i18n/config";
import type { Locale } from "@/lib/i18n/config";
import {
  fetchAdminSites,
  fetchAdminTeams,
  fetchPrivateSessions,
} from "@/lib/edge-client";
import Link from "next/link";
import { Button } from "@/components/ui/button";

interface SessionsSearchParams {
  teamId?: string;
  siteId?: string;
  from?: string;
  to?: string;
  fromIso?: string;
  toIso?: string;
}

function parseDateInput(value: string | undefined): number | null {
  if (!value) return null;
  const parsed = Date.parse(value);
  if (Number.isFinite(parsed)) return parsed;
  const num = Number(value);
  if (Number.isFinite(num)) return Math.floor(num);
  return null;
}

function resolveRange(sp: SessionsSearchParams): { siteId: string; from: number; to: number } {
  const now = Date.now();
  const from = parseDateInput(sp.fromIso) ?? parseDateInput(sp.from) ?? now - 7 * 24 * 60 * 60 * 1000;
  const to = parseDateInput(sp.toIso) ?? parseDateInput(sp.to) ?? now;
  return {
    siteId: sp.siteId || process.env.INSIGHTFLARE_DEFAULT_SITE_ID || "default",
    from: Math.min(from, to),
    to: Math.max(from, to),
  };
}

export default async function SessionsPage({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string }>;
  searchParams: Promise<SessionsSearchParams>;
}) {
  const { locale: rawLocale } = await params;
  const locale: Locale = isValidLocale(rawLocale) ? rawLocale : DEFAULT_LOCALE;
  const dict = await getDictionary(locale);
  const t = (key: string) => dict[key] ?? key;
  const sp = await searchParams;
  const range = resolveRange(sp);

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
  const finalRange = { ...range, siteId: selectedSiteId };
  const sessions = await fetchPrivateSessions(finalRange);

  return (
    <div className="mx-auto max-w-7xl">
      <StickyDashboardHeader
        teams={teams}
        sites={sites}
        currentTeamId={selectedTeamId}
        currentSiteId={selectedSiteId}
        locale={locale}
        from={finalRange.from}
        to={finalRange.to}
      />

      <div className="space-y-4">
        <div>
          <h1 className="text-xl font-semibold">{t("sessions.title")}</h1>
          <p className="mt-1 text-sm text-muted-foreground">{t("sessions.description")}</p>
        </div>

        <Widget>
          <WidgetHead>
            <div className="flex items-center gap-2">
              <Clock className="h-4 w-4 text-muted-foreground" />
              {t("dashboard.sessionSnapshot")}
            </div>
          </WidgetHead>
          <WidgetBody>
            {sessions.data.length > 0 ? (
              <SessionCompactList sessions={sessions.data} emptyLabel={t("dashboard.noSessions")} />
            ) : (
              <p className="px-4 py-6 text-sm text-muted-foreground">{t("common.noData")}</p>
            )}
          </WidgetBody>
        </Widget>
      </div>
    </div>
  );
}
