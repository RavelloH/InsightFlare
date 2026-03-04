import { notFound } from "next/navigation";
import { AdminUsersManagementClient } from "@/components/dashboard/admin-users-management-client";
import { getDashboardProfile } from "@/lib/dashboard/server";
import { resolveLocale } from "@/lib/i18n/config";
import { getMessages } from "@/lib/i18n/messages";

interface ManageUsersPageProps {
  params: Promise<{
    locale: string;
    teamSlug: string;
  }>;
}

export default async function ManageUsersPage({ params }: ManageUsersPageProps) {
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
    <AdminUsersManagementClient
      locale={resolvedLocale}
      messages={messages}
      currentUserId={profile.user.id}
    />
  );
}
