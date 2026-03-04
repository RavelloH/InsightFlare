import { notFound } from "next/navigation";
import { AdminSitesManagementClient } from "@/components/dashboard/admin-sites-management-client";
import { getDashboardProfile } from "@/lib/dashboard/server";
import { resolveLocale } from "@/lib/i18n/config";
import { getMessages } from "@/lib/i18n/messages";

interface ManageSitesPageProps {
  params: Promise<{
    locale: string;
    teamSlug: string;
  }>;
}

export default async function ManageSitesPage({ params }: ManageSitesPageProps) {
  const { locale, teamSlug } = await params;
  const resolvedLocale = resolveLocale(locale);
  const messages = getMessages(resolvedLocale);
  const profile = await getDashboardProfile();

  if (!profile || profile.user.systemRole !== "admin") {
    notFound();
  }

  const activeTeam = profile.teams.find((team) => team.slug === teamSlug);
  if (!activeTeam) {
    notFound();
  }

  return (
    <AdminSitesManagementClient
      locale={resolvedLocale}
      messages={messages}
      teams={profile.teams}
      defaultTeamId={activeTeam.id}
    />
  );
}
