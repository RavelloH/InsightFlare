import { redirect } from "next/navigation";
import { Shield } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { AddMemberDialog } from "@/components/teams/add-member-dialog";
import { MemberTable } from "@/components/teams/member-table";
import { getDictionary } from "@/lib/i18n/dictionaries";
import { isValidLocale, DEFAULT_LOCALE } from "@/lib/i18n/config";
import type { Locale } from "@/lib/i18n/config";
import { fetchAdminMembers, fetchAdminTeams } from "@/lib/edge-client";

export default async function TeamMembersPage({
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

  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-2xl font-semibold">
            {team.name} - {t("teams.teamMembers")}
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {t("teams.description")}
          </p>
        </div>
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
  );
}
