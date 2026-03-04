import { notFound, redirect } from "next/navigation";
import { TeamManagementClient } from "@/components/dashboard/team-management-client";
import { getDashboardProfile } from "@/lib/dashboard/server";
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

export default async function TeamRootPage({ params, searchParams }: TeamRootPageProps) {
  const { locale, teamSlug } = await params;
  const query = await searchParams;
  const resolvedLocale = resolveLocale(locale);
  const messages = getMessages(resolvedLocale);
  const legacyTab = pickFirst(query.tab);

  if (legacyTab === "settings" || legacyTab === "members") {
    redirect(`/${resolvedLocale}/app/${teamSlug}/${legacyTab}`);
  }

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
      activeTab="sites"
    />
  );
}
