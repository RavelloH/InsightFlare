import { redirect } from "next/navigation";
import { EmptyState } from "@/components/shared/empty-state";
import { CreateTeamDialog } from "@/components/teams/create-team-dialog";
import { getDictionary } from "@/lib/i18n/dictionaries";
import { isValidLocale, DEFAULT_LOCALE } from "@/lib/i18n/config";
import type { Locale } from "@/lib/i18n/config";
import { fetchAdminTeams } from "@/lib/edge-client";

export default async function AppRootPage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale: rawLocale } = await params;
  const locale: Locale = isValidLocale(rawLocale) ? rawLocale : DEFAULT_LOCALE;
  const dict = await getDictionary(locale);
  const t = (key: string) => dict[key] ?? key;

  const teams = await fetchAdminTeams();

  if (teams.length === 0) {
    return (
      <div className="mx-auto max-w-4xl">
        <EmptyState
          title={t("dashboard.noTeam")}
          description={t("dashboard.noTeamHint")}
          action={
            <CreateTeamDialog
              locale={locale}
              labels={{
                createTeam: t("teams.createTeam"),
                teamName: t("teams.teamName"),
                slug: t("teams.slug"),
                create: t("common.create"),
                cancel: t("common.cancel"),
              }}
            />
          }
        />
      </div>
    );
  }

  redirect(`/${locale}/app/${teams[0].id}`);
}
