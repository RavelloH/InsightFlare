import { Beaker, Clock4 } from "lucide-react";
import { PrecisionQuery } from "@/components/precision-query";
import { TeamSiteSelector } from "@/components/dashboard/team-site-selector";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { EmptyState } from "@/components/shared/empty-state";
import { getDictionary } from "@/lib/i18n/dictionaries";
import { isValidLocale, DEFAULT_LOCALE } from "@/lib/i18n/config";
import type { Locale } from "@/lib/i18n/config";
import { fetchAdminSites, fetchAdminTeams } from "@/lib/edge-client";

interface PrecisionSearchParams {
  teamId?: string;
  siteId?: string;
  from?: string;
  to?: string;
}

function parseNumber(input: string | undefined, fallback: number): number {
  if (!input) return fallback;
  const n = Number(input);
  if (!Number.isFinite(n)) return fallback;
  return Math.floor(n);
}

export default async function PrecisionPage({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string }>;
  searchParams: Promise<PrecisionSearchParams>;
}) {
  const { locale: rawLocale } = await params;
  const locale: Locale = isValidLocale(rawLocale) ? rawLocale : DEFAULT_LOCALE;
  const dict = await getDictionary(locale);
  const t = (key: string) => dict[key] ?? key;
  const sp = await searchParams;

  const now = Date.now();
  const defaultFrom = now - 3 * 365 * 24 * 60 * 60 * 1000;
  const from = parseNumber(sp.from, defaultFrom);
  const to = parseNumber(sp.to, now);

  const teams = await fetchAdminTeams();
  const selectedTeamId =
    (sp.teamId && teams.some((team) => team.id === sp.teamId) ? sp.teamId : undefined) || teams[0]?.id || "";
  const sites = selectedTeamId ? await fetchAdminSites(selectedTeamId) : [];
  const selectedSiteId =
    (sp.siteId && sites.some((site) => site.id === sp.siteId) ? sp.siteId : undefined) || sites[0]?.id || "";

  return (
    <div className="mx-auto max-w-7xl space-y-6">
      <div>
        <h1 className="font-[var(--font-display)] text-3xl font-semibold">{t("precision.title")}</h1>
        <p className="mt-1 text-sm text-muted-foreground">{t("precision.description")}</p>
      </div>

      {teams.length > 0 && sites.length > 0 && (
        <TeamSiteSelector
          teams={teams}
          sites={sites}
          currentTeamId={selectedTeamId}
          currentSiteId={selectedSiteId}
        />
      )}

      <div className="grid gap-4 md:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Clock4 className="h-5 w-5 text-primary" />
              {t("precision.timeRange")}
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-2 text-sm text-muted-foreground">
            <p>From: {new Date(from).toLocaleString()}</p>
            <p>To: {new Date(to).toLocaleString()}</p>
            <p>{t("precision.timeTip")}</p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Beaker className="h-5 w-5 text-chart-3" />
              {t("precision.inputDataset")}
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-2 text-sm text-muted-foreground">
            <p>Site: {selectedSiteId || "N/A"}</p>
            <p>{t("precision.archiveSource")}</p>
            <p>{t("precision.archiveFormat")}</p>
          </CardContent>
        </Card>
      </div>

      {selectedSiteId ? (
        <PrecisionQuery siteId={selectedSiteId} from={from} to={to} />
      ) : (
        <EmptyState title={t("precision.noSite")} />
      )}
    </div>
  );
}
