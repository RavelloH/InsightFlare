import { notFound } from "next/navigation";
import { SettingsClientPage } from "@/components/dashboard/site-pages/settings-client-page";
import { getTeamSiteContext } from "@/lib/dashboard/server";
import { resolveLocale } from "@/lib/i18n/config";
import { getMessages } from "@/lib/i18n/messages";

interface SiteSettingsPageProps {
  params: Promise<{
    locale: string;
    teamSlug: string;
    siteSlug: string;
  }>;
}

export default async function SiteSettingsPage({ params }: SiteSettingsPageProps) {
  const { locale, teamSlug, siteSlug } = await params;
  const resolvedLocale = resolveLocale(locale);
  const messages = getMessages(resolvedLocale);

  const context = await getTeamSiteContext(teamSlug, siteSlug);
  if (!context) notFound();

  return (
    <SettingsClientPage
      locale={resolvedLocale}
      messages={messages}
      teamSlug={context.activeTeam.slug}
      activeTeamId={context.activeTeam.id}
      siteSlug={context.activeSite.slug}
      teams={context.teams.map((team) => ({
        id: team.id,
        slug: team.slug,
        name: team.name,
      }))}
      site={{
        id: context.activeSite.id,
        name: context.activeSite.name,
        domain: context.activeSite.domain,
        publicSlug: context.activeSite.publicSlug,
      }}
    />
  );
}
