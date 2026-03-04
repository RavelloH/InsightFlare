import { notFound } from "next/navigation";
import { AdminTeamsManagementClient } from "@/components/dashboard/admin-teams-management-client";
import { getDashboardProfile } from "@/lib/dashboard/server";
import { resolveLocale } from "@/lib/i18n/config";
import { getMessages } from "@/lib/i18n/messages";

interface ManageTeamsPageProps {
  params: Promise<{
    locale: string;
    teamSlug: string;
  }>;
}

export default async function ManageTeamsPage({ params }: ManageTeamsPageProps) {
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
    <AdminTeamsManagementClient locale={resolvedLocale} messages={messages} />
  );
}
