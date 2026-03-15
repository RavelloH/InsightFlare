import { notFound } from "next/navigation";
import { RealtimeClientPage } from "@/components/dashboard/site-pages/realtime-client-page";
import { getTeamSiteContext } from "@/lib/dashboard/server";
import { resolveLocale } from "@/lib/i18n/config";
import { getMessages } from "@/lib/i18n/messages";

interface RealtimePageProps {
  params: Promise<{
    locale: string;
    teamSlug: string;
    siteSlug: string;
  }>;
}

export default async function RealtimePage({ params }: RealtimePageProps) {
  const { locale, teamSlug, siteSlug } = await params;
  const messages = getMessages(resolveLocale(locale));

  const context = await getTeamSiteContext(teamSlug, siteSlug);
  if (!context) notFound();

  return (
    <RealtimeClientPage
      messages={messages}
      siteId={context.activeSite.id}
    />
  );
}
