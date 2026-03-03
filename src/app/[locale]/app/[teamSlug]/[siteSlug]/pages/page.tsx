import { notFound } from "next/navigation";
import { PagesClientPage } from "@/components/dashboard/site-pages/pages-client-page";
import { buildSitePath, getTeamSiteContext } from "@/lib/dashboard/server";
import { resolveLocale } from "@/lib/i18n/config";
import { getMessages } from "@/lib/i18n/messages";

interface PagesPageProps {
  params: Promise<{
    locale: string;
    teamSlug: string;
    siteSlug: string;
  }>;
}

export default async function PagesPage({ params }: PagesPageProps) {
  const { locale, teamSlug, siteSlug } = await params;
  const resolvedLocale = resolveLocale(locale);
  const messages = getMessages(resolvedLocale);

  const context = await getTeamSiteContext(teamSlug, siteSlug);
  if (!context) notFound();

  const pathname = buildSitePath(
    resolvedLocale,
    context.activeTeam.slug,
    context.activeSite.slug,
    "pages",
  );

  return (
    <PagesClientPage
      locale={resolvedLocale}
      messages={messages}
      siteId={context.activeSite.id}
      pathname={pathname}
    />
  );
}
