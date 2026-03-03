import type { Locale } from "@/lib/i18n/config";
import type { AppMessages } from "@/lib/i18n/messages";

export type TeamTab = "sites" | "settings" | "members";

export type ManagementSectionKey =
  | "manage-users"
  | "manage-sites"
  | "manage-teams";

export interface DashboardSectionItem {
  key: string;
  label: string;
  href: string;
}

const TEAM_TABS: readonly TeamTab[] = ["sites", "settings", "members"] as const;

function teamTabLabel(messages: AppMessages, tab: TeamTab): string {
  if (tab === "sites") return messages.teamManagement.sites.title;
  if (tab === "settings") return messages.teamManagement.settings.title;
  return messages.teamManagement.members.title;
}

function managementLabel(messages: AppMessages, key: ManagementSectionKey): string {
  if (key === "manage-users") return messages.managementNav.users;
  if (key === "manage-sites") return messages.managementNav.sites;
  return messages.managementNav.teams;
}

function buildTeamTabPath(locale: Locale, teamSlug: string, tab: TeamTab): string {
  const base = `/${locale}/app/${teamSlug}`;
  if (tab === "sites") return base;
  return `${base}?tab=${tab}`;
}

function buildManagementPath(locale: Locale, teamSlug: string, key: ManagementSectionKey): string {
  if (key === "manage-users") return `/${locale}/app/${teamSlug}/manage/users`;
  if (key === "manage-sites") return `/${locale}/app/${teamSlug}/manage/sites`;
  return `/${locale}/app/${teamSlug}/manage/teams`;
}

export function buildTeamSections(
  locale: Locale,
  teamSlug: string,
  messages: AppMessages,
): DashboardSectionItem[] {
  return TEAM_TABS.map((tab) => ({
    key: tab,
    label: teamTabLabel(messages, tab),
    href: buildTeamTabPath(locale, teamSlug, tab),
  }));
}

export function buildManagementSections(
  locale: Locale,
  teamSlug: string,
  messages: AppMessages,
): DashboardSectionItem[] {
  const keys: readonly ManagementSectionKey[] = [
    "manage-users",
    "manage-sites",
    "manage-teams",
  ] as const;
  return keys.map((key) => ({
    key,
    label: managementLabel(messages, key),
    href: buildManagementPath(locale, teamSlug, key),
  }));
}
