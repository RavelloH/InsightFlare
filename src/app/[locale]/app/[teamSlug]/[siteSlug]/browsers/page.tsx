import { notFound } from "next/navigation";
import { BrowsersClientPage } from "@/components/dashboard/site-pages/browsers-client-page";
import { buildSitePath, getTeamSiteContext } from "@/lib/dashboard/server";
import { resolveLocale } from "@/lib/i18n/config";
import { getMessages } from "@/lib/i18n/messages";

interface BrowsersPageProps {
  params: Promise<{
    locale: string;
    teamSlug: string;
    siteSlug: string;
  }>;
}

export default async function BrowsersPage({ params }: BrowsersPageProps) {
  const { locale, teamSlug, siteSlug } = await params;
  const resolvedLocale = resolveLocale(locale);
  const messages = getMessages(resolvedLocale);

  const context = await getTeamSiteContext(teamSlug, siteSlug);
  if (!context) notFound();

  const pathname = buildSitePath(
    resolvedLocale,
    context.activeTeam.slug,
    context.activeSite.slug,
    "browsers",
  );

  return (
    <BrowsersClientPage
      locale={resolvedLocale}
      messages={messages}
      siteId={context.activeSite.id}
      pathname={pathname}
    />
  );
}
