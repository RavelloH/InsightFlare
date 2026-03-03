import { redirect } from "next/navigation";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { resolveLocale } from "@/lib/i18n/config";
import { getMessages } from "@/lib/i18n/messages";
import { buildSitePath, getTeamDefaultSite } from "@/lib/dashboard/server";

interface TeamRootPageProps {
  params: Promise<{
    locale: string;
    teamSlug: string;
  }>;
}

export default async function TeamRootPage({ params }: TeamRootPageProps) {
  const { locale, teamSlug } = await params;
  const resolvedLocale = resolveLocale(locale);
  const t = getMessages(resolvedLocale);

  const selection = await getTeamDefaultSite(teamSlug);
  if (selection) {
    redirect(buildSitePath(resolvedLocale, selection.teamSlug, selection.siteSlug));
  }

  return (
    <main className="grid min-h-svh place-items-center p-4">
      <Card className="w-full max-w-lg">
        <CardHeader>
          <CardTitle>{t.appName}</CardTitle>
          <CardDescription>{t.empty.noSites}</CardDescription>
        </CardHeader>
        <CardContent />
      </Card>
    </main>
  );
}
