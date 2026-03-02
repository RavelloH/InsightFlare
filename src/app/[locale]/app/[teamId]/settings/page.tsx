import { redirect } from "next/navigation";
import { Shield } from "lucide-react";
import { TeamConfigForm } from "@/components/settings/team-config-form";
import { AddMemberDialog } from "@/components/teams/add-member-dialog";
import { MemberTable } from "@/components/teams/member-table";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { getDictionary } from "@/lib/i18n/dictionaries";
import { isValidLocale, DEFAULT_LOCALE } from "@/lib/i18n/config";
import type { Locale } from "@/lib/i18n/config";
import { fetchAdminMembers, fetchAdminTeams } from "@/lib/edge-client";

export default async function TeamSettingsPage({
  params,
}: {
  params: Promise<{ locale: string; teamId: string }>;
}) {
  const { locale: rawLocale, teamId } = await params;
  const locale: Locale = isValidLocale(rawLocale) ? rawLocale : DEFAULT_LOCALE;
  const dict = await getDictionary(locale);
  const t = (key: string) => dict[key] ?? key;

  const teams = await fetchAdminTeams();
  const team = teams.find((tm) => tm.id === teamId);

  if (!team) {
    redirect(`/${locale}/app`);
  }

  const members = await fetchAdminMembers(teamId);

  const teamSettingsTitle =
    locale === "zh" ? "团队设置" : "Team Settings";
  const teamSettingsDescription =
    locale === "zh"
      ? "修改当前团队的名称和 slug。"
      : "Update the current team's name and slug.";

  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">
          {team.name} - {teamSettingsTitle}
        </h1>
        <p className="mt-1 text-sm text-muted-foreground">
          {teamSettingsDescription}
        </p>
      </div>
      <TeamConfigForm
        team={team}
        labels={{
          teamConfiguration: teamSettingsTitle,
          teamName: t("teams.teamName"),
          slug: t("teams.slug"),
          saveConfig: t("common.save"),
        }}
      />

      <div className="space-y-4">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <h2 className="text-xl font-semibold">{t("teams.teamMembers")}</h2>
          <AddMemberDialog
            teamId={teamId}
            labels={{
              addMember: t("teams.addMember"),
              userIdentifier: t("teams.userIdentifier"),
              identifierPlaceholder: t("teams.identifierPlaceholder"),
              create: t("common.create"),
            }}
          />
        </div>
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <span className="bg-def-200 rounded-lg p-1 inline-flex">
                <Shield className="h-4 w-4" />
              </span>
              {t("teams.teamMembers")}
            </CardTitle>
          </CardHeader>
          <CardContent>
            {members.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                {t("teams.noMembers")}
              </p>
            ) : (
              <MemberTable
                members={members}
                teamId={teamId}
                labels={{
                  username: t("teams.username"),
                  email: t("teams.email"),
                  name: t("teams.name"),
                  role: t("teams.role"),
                  action: t("teams.action"),
                  owner: t("teams.owner"),
                  remove: t("common.remove"),
                }}
              />
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
