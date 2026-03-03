import { headers } from "next/headers";
import { notFound } from "next/navigation";
import { DashboardShell } from "@/components/dashboard/dashboard-shell";
import { TeamManagementClient } from "@/components/dashboard/team-management-client";
import { getDashboardProfile } from "@/lib/dashboard/server";
import { buildManagementSections, buildTeamSections } from "@/lib/dashboard/team-sections";
import { resolveLocale } from "@/lib/i18n/config";
import { getMessages } from "@/lib/i18n/messages";

interface TeamRootPageProps {
  params: Promise<{
    locale: string;
    teamSlug: string;
  }>;
  searchParams: Promise<{
    tab?: string | string[];
  }>;
}

function pickFirst(value: string | string[] | undefined): string | undefined {
  if (typeof value === "string") return value;
  if (Array.isArray(value) && value.length > 0) return value[0];
  return undefined;
}

function resolveTeamTab(value: string | string[] | undefined): "sites" | "settings" | "members" {
  const first = pickFirst(value);
  if (!first) return "sites";
  if (first === "sites" || first === "settings" || first === "members") return first;
  return "sites";
}

export default async function TeamRootPage({ params, searchParams }: TeamRootPageProps) {
  const { locale, teamSlug } = await params;
  const query = await searchParams;
  const resolvedLocale = resolveLocale(locale);
  const messages = getMessages(resolvedLocale);
  const activeTab = resolveTeamTab(query.tab);

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
  const pathname = requestHeaders.get("x-pathname") || `/${resolvedLocale}/app/${activeTeam.slug}`;

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
      activeTeamSectionKey={activeTab}
      managementSections={managementSections}
    >
      <TeamManagementClient
        locale={resolvedLocale}
        messages={messages}
        activeTeam={activeTeam}
        activeTab={activeTab}
      />
    </DashboardShell>
  );
}
