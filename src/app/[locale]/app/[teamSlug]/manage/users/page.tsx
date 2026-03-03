import { headers } from "next/headers";
import { notFound } from "next/navigation";
import { DashboardShell } from "@/components/dashboard/dashboard-shell";
import { AdminUsersManagementClient } from "@/components/dashboard/admin-users-management-client";
import { getDashboardProfile } from "@/lib/dashboard/server";
import { buildManagementSections, buildTeamSections } from "@/lib/dashboard/team-sections";
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

  const requestHeaders = await headers();
  const pathname = requestHeaders.get("x-pathname") || `/${resolvedLocale}/app/${activeTeam.slug}/manage/users`;

  return (
    <DashboardShell
      locale={resolvedLocale}
      pathname={pathname}
      messages={messages}
      user={profile.user}
      teams={profile.teams}
      activeTeamSlug={activeTeam.slug}
      sites={[]}
      teamSections={buildTeamSections(resolvedLocale, activeTeam.slug, messages)}
      managementSections={buildManagementSections(resolvedLocale, activeTeam.slug, messages)}
      activeManagementSectionKey="manage-users"
    >
      <AdminUsersManagementClient
        locale={resolvedLocale}
        messages={messages}
        currentUserId={profile.user.id}
      />
    </DashboardShell>
  );
}
