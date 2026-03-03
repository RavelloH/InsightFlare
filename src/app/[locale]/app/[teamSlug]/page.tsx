import { headers } from "next/headers";
import { notFound } from "next/navigation";
import { DashboardShell } from "@/components/dashboard/dashboard-shell";
import { TeamManagementClient } from "@/components/dashboard/team-management-client";
import { getDashboardProfile } from "@/lib/dashboard/server";
import { resolveLocale, type Locale } from "@/lib/i18n/config";
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

type TeamTab = "sites" | "settings" | "members";

const TEAM_TABS: readonly TeamTab[] = ["sites", "settings", "members"] as const;

function pickFirst(value: string | string[] | undefined): string | undefined {
  if (typeof value === "string") return value;
  if (Array.isArray(value) && value.length > 0) return value[0];
  return undefined;
}

function resolveTeamTab(value: string | string[] | undefined): TeamTab {
  const first = pickFirst(value);
  if (!first) return "sites";
  if (TEAM_TABS.includes(first as TeamTab)) return first as TeamTab;
  return "sites";
}

function buildTeamTabPath(locale: Locale, teamSlug: string, tab: TeamTab): string {
  const base = `/${locale}/app/${teamSlug}`;
  if (tab === "sites") return base;
  return `${base}?tab=${tab}`;
}
function teamTabLabel(locale: Locale, tab: TeamTab): string {
  if (locale === "zh") {
    if (tab === "sites") return "站点";
    if (tab === "settings") return "设置";
    return "成员";
  }

  if (tab === "sites") return "Sites";
  if (tab === "settings") return "Settings";
  return "Members";
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

  const teamSections = TEAM_TABS.map((tab) => ({
    key: tab,
    label: teamTabLabel(resolvedLocale, tab),
    href: buildTeamTabPath(resolvedLocale, activeTeam.slug, tab),
  }));

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
    >
      <TeamManagementClient
        locale={resolvedLocale}
        activeTeam={activeTeam}
        activeTab={activeTab}
      />
    </DashboardShell>
  );
}
