import { headers } from "next/headers";
import { notFound } from "next/navigation";
import { DashboardShell } from "@/components/dashboard/dashboard-shell";
import { getTeamSiteContext } from "@/lib/dashboard/server";
import { resolveLocale } from "@/lib/i18n/config";
import { getMessages } from "@/lib/i18n/messages";

interface SiteLayoutProps {
  children: React.ReactNode;
  params: Promise<{
    locale: string;
    teamSlug: string;
    siteSlug: string;
  }>;
}

export default async function SiteLayout({ children, params }: SiteLayoutProps) {
  const { locale, teamSlug, siteSlug } = await params;
  const resolvedLocale = resolveLocale(locale);
  const t = getMessages(resolvedLocale);
  const context = await getTeamSiteContext(teamSlug, siteSlug);

  if (!context) {
    notFound();
  }

  const requestHeaders = await headers();
  const pathname =
    requestHeaders.get("x-pathname") ||
    `/${resolvedLocale}/app/${context.activeTeam.slug}/${context.activeSite.slug}`;

  return (
    <DashboardShell
      locale={resolvedLocale}
      pathname={pathname}
      messages={t}
      teams={context.teams}
      activeTeamSlug={context.activeTeam.slug}
      sites={context.sites}
      activeSiteSlug={context.activeSite.slug}
    >
      {children}
    </DashboardShell>
  );
}
