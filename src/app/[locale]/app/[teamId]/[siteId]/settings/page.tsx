import { redirect } from "next/navigation";
import { SiteConfigForm } from "@/components/settings/site-config-form";
import { getDictionary } from "@/lib/i18n/dictionaries";
import { isValidLocale, DEFAULT_LOCALE } from "@/lib/i18n/config";
import type { Locale } from "@/lib/i18n/config";
import {
  fetchAdminSiteConfig,
  fetchAdminSites,
  fetchAdminTeams,
} from "@/lib/edge-client";

export default async function SiteSettingsPage({
  params,
}: {
  params: Promise<{ locale: string; teamId: string; siteId: string }>;
}) {
  const { locale: rawLocale, teamId, siteId } = await params;
  const locale: Locale = isValidLocale(rawLocale) ? rawLocale : DEFAULT_LOCALE;
  const dict = await getDictionary(locale);
  const t = (key: string) => dict[key] ?? key;

  const teams = await fetchAdminTeams();
  const team = teams.find((tm) => tm.id === teamId);
  if (!team) {
    redirect(`/${locale}/app`);
  }

  const sites = await fetchAdminSites(teamId);
  const site = sites.find((s) => s.id === siteId);
  if (!site) {
    redirect(`/${locale}/app/${teamId}`);
  }

  const siteConfig = await fetchAdminSiteConfig(siteId);
  const pageTitle = locale === "zh" ? "站点设置" : "Site Settings";
  const pageDescription =
    locale === "zh"
      ? "修改当前站点的域名、公开可见性与隐私脱敏策略。"
      : "Update domain, public visibility, and privacy masking defaults for this site.";

  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">
          {site.name} - {pageTitle}
        </h1>
        <p className="mt-1 text-sm text-muted-foreground">{pageDescription}</p>
      </div>

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
    </div>
  );
}
