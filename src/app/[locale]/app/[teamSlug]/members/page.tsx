import { headers } from "next/headers";
import { notFound } from "next/navigation";
import { DashboardShell } from "@/components/dashboard/dashboard-shell";
import { TeamManagementClient } from "@/components/dashboard/team-management-client";
import { getDashboardProfile } from "@/lib/dashboard/server";
import {
  buildManagementSections,
  buildTeamSections,
} from "@/lib/dashboard/team-sections";
import { resolveLocale } from "@/lib/i18n/config";
import { getMessages } from "@/lib/i18n/messages";

interface TeamMembersPageProps {
  params: Promise<{
    locale: string;
    teamSlug: string;
  }>;
}

export default async function TeamMembersPage({ params }: TeamMembersPageProps) {
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

  const teamSections = buildTeamSections(resolvedLocale, activeTeam.slug, messages);
  const managementSections =
    profile.user.systemRole === "admin"
      ? buildManagementSections(resolvedLocale, activeTeam.slug, messages)
      : undefined;

  const requestHeaders = await headers();
  const pathname =
    requestHeaders.get("x-pathname") ||
    `/${resolvedLocale}/app/${activeTeam.slug}/members`;

  return (
    <DashboardShell
      locale={resolvedLocale}
      pathname={pathname}
      messages={messages}
      user={profile.user}
      teams={profile.teams}
      activeTeamSlug={activeTeam.slug}
      sites={[]}
      teamSections={teamSections}
      activeTeamSectionKey="members"
      managementSections={managementSections}
    >
      <TeamManagementClient
        locale={resolvedLocale}
        messages={messages}
        activeTeam={activeTeam}
        activeTab="members"
      />
    </DashboardShell>
  );
}

