import { notFound } from "next/navigation";
import { TeamManagementClient } from "@/components/dashboard/team-management-client";
import { getDashboardProfile } from "@/lib/dashboard/server";
import { resolveLocale } from "@/lib/i18n/config";
import { getMessages } from "@/lib/i18n/messages";

interface TeamSettingsPageProps {
  params: Promise<{
    locale: string;
    teamSlug: string;
  }>;
}

export default async function TeamSettingsPage({ params }: TeamSettingsPageProps) {
  const { locale, teamSlug } = await params;
  const resolvedLocale = resolveLocale(locale);
  const messages = getMessages(resolvedLocale);
  const profile = await getDashboardProfile();

  if (!profile) {
    notFound();
  }

  const activeTeam = profile.teams.find((team) => team.slug === teamSlug);
  if (!activeTeam) {
    notFound();
  }

  return (
    <TeamManagementClient
      locale={resolvedLocale}
      messages={messages}
      activeTeam={activeTeam}
      activeTab="settings"
    />
  );
}
