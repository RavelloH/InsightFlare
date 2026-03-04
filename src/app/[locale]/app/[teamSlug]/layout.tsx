import type { ReactNode } from "react";
import { notFound } from "next/navigation";
import { DashboardShell } from "@/components/dashboard/dashboard-shell";
import { getDashboardTeamContext } from "@/lib/dashboard/server";
import {
  buildManagementSections,
  buildTeamSections,
} from "@/lib/dashboard/team-sections";
import { resolveLocale } from "@/lib/i18n/config";
import { getMessages } from "@/lib/i18n/messages";

interface TeamLayoutProps {
  children: ReactNode;
  params: Promise<{
    locale: string;
    teamSlug: string;
  }>;
}

export default async function TeamLayout({ children, params }: TeamLayoutProps) {
  const { locale, teamSlug } = await params;
  const resolvedLocale = resolveLocale(locale);
  const messages = getMessages(resolvedLocale);
  const context = await getDashboardTeamContext(teamSlug);

  if (!context) {
    notFound();
  }
  const pathname = `/${resolvedLocale}/app/${context.activeTeam.slug}`;

  const managementSections =
    context.user.systemRole === "admin"
      ? buildManagementSections(resolvedLocale, context.activeTeam.slug, messages)
      : undefined;

  return (
    <DashboardShell
      locale={resolvedLocale}
      pathname={pathname}
      messages={messages}
      user={context.user}
      teams={context.teams}
      activeTeamSlug={context.activeTeam.slug}
      sites={context.sites}
      teamSections={buildTeamSections(resolvedLocale, context.activeTeam.slug, messages)}
      managementSections={managementSections}
    >
      {children}
    </DashboardShell>
  );
}
