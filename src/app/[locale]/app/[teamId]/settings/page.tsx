import { redirect } from "next/navigation";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { SiteConfigForm } from "@/components/settings/site-config-form";
import { SiteSelector } from "@/components/dashboard/site-selector";
import { EmptyState } from "@/components/shared/empty-state";
import { getDictionary } from "@/lib/i18n/dictionaries";
import { isValidLocale, DEFAULT_LOCALE } from "@/lib/i18n/config";
import type { Locale } from "@/lib/i18n/config";
import {
  fetchAdminSites,
  fetchAdminSiteConfig,
  fetchAdminTeams,
} from "@/lib/edge-client";

interface TeamSettingsSearchParams {
  siteId?: string;
  tab?: string;
}

export default async function TeamSettingsPage({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string; teamId: string }>;
  searchParams: Promise<TeamSettingsSearchParams>;
}) {
  const { locale: rawLocale, teamId } = await params;
  const locale: Locale = isValidLocale(rawLocale) ? rawLocale : DEFAULT_LOCALE;
  const dict = await getDictionary(locale);
  const t = (key: string) => dict[key] ?? key;
  const sp = await searchParams;

  const teams = await fetchAdminTeams();
  const team = teams.find((tm) => tm.id === teamId);

  if (!team) {
    redirect(`/${locale}/app`);
  }

  const sites = await fetchAdminSites(teamId);
  const selectedSiteId =
    (sp.siteId && sites.some((s) => s.id === sp.siteId)
      ? sp.siteId
      : undefined) || sites[0]?.id || "";
  const site = sites.find((s) => s.id === selectedSiteId) || null;
  const siteConfig = selectedSiteId
    ? await fetchAdminSiteConfig(selectedSiteId)
    : {};

  const defaultTab = sp.tab || "site";

  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">
          {team.name} - {t("settings.title")}
        </h1>
        <p className="mt-1 text-sm text-muted-foreground">
          {t("settings.privacyDescription")}
        </p>
      </div>

      {sites.length > 0 && (
        <SiteSelector sites={sites} currentSiteId={selectedSiteId} />
      )}

      <Tabs defaultValue={defaultTab} className="space-y-4">
        <TabsList>
          <TabsTrigger value="site">{t("settings.siteConfig")}</TabsTrigger>
          <TabsTrigger value="privacy">{t("settings.privacy")}</TabsTrigger>
        </TabsList>

        <TabsContent value="site" className="space-y-4">
          {site ? (
            <SiteConfigForm
              site={site}
              config={siteConfig}
              labels={{
                siteConfiguration: t("settings.siteConfiguration"),
                siteName: t("teams.siteName"),
                domain: t("teams.domain"),
                publicVisibility: t("settings.publicVisibility"),
                enablePublic: t("teams.enablePublic"),
                publicSlug: t("settings.publicSlug"),
                privacyDefaults: t("settings.privacyDefaults"),
                maskQuery: t("settings.maskQuery"),
                maskTrajectory: t("settings.maskTrajectory"),
                maskReferrer: t("settings.maskReferrer"),
                saveConfig: t("settings.saveConfig"),
              }}
            />
          ) : (
            <EmptyState title={t("settings.noSite")} />
          )}
        </TabsContent>

        <TabsContent value="privacy" className="space-y-4">
          {site ? (
            <SiteConfigForm
              site={site}
              config={siteConfig}
              labels={{
                siteConfiguration: t("settings.privacyPublication"),
                siteName: t("teams.siteName"),
                domain: t("teams.domain"),
                publicVisibility: t("settings.publicVisibility"),
                enablePublic: t("teams.enablePublic"),
                publicSlug: t("settings.publicSlug"),
                privacyDefaults: t("settings.privacyDefaults"),
                maskQuery: t("settings.maskQuery"),
                maskTrajectory: t("settings.maskTrajectory"),
                maskReferrer: t("settings.maskReferrer"),
                saveConfig: t("settings.saveConfig"),
              }}
            />
          ) : (
            <EmptyState title={t("settings.noSite")} />
          )}
        </TabsContent>
      </Tabs>
    </div>
  );
}
