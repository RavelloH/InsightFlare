import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ProfileForm } from "@/components/settings/profile-form";
import { SiteConfigForm } from "@/components/settings/site-config-form";
import { UserManagement } from "@/components/settings/user-management";
import { EmptyState } from "@/components/shared/empty-state";
import { TeamSiteSelector } from "@/components/dashboard/team-site-selector";
import { getDictionary } from "@/lib/i18n/dictionaries";
import { isValidLocale, DEFAULT_LOCALE } from "@/lib/i18n/config";
import type { Locale } from "@/lib/i18n/config";
import {
  fetchAdminMe,
  fetchAdminSiteConfig,
  fetchAdminSites,
  fetchAdminTeams,
  fetchAdminUsers,
} from "@/lib/edge-client";

interface SettingsSearchParams {
  teamId?: string;
  siteId?: string;
  tab?: string;
}

export default async function SettingsPage({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string }>;
  searchParams: Promise<SettingsSearchParams>;
}) {
  const { locale: rawLocale } = await params;
  const locale: Locale = isValidLocale(rawLocale) ? rawLocale : DEFAULT_LOCALE;
  const dict = await getDictionary(locale);
  const t = (key: string) => dict[key] ?? key;
  const sp = await searchParams;

  const me = await fetchAdminMe();
  const teams = await fetchAdminTeams();
  const selectedTeamId =
    (sp.teamId && teams.some((team) => team.id === sp.teamId) ? sp.teamId : undefined) || teams[0]?.id || "";
  const sites = selectedTeamId ? await fetchAdminSites(selectedTeamId) : [];
  const selectedSiteId =
    (sp.siteId && sites.some((site) => site.id === sp.siteId) ? sp.siteId : undefined) || sites[0]?.id || "";
  const site = sites.find((s) => s.id === selectedSiteId) || null;
  const siteConfig = selectedSiteId ? await fetchAdminSiteConfig(selectedSiteId) : {};
  const users = me.user.systemRole === "admin" ? await fetchAdminUsers() : [];

  const defaultTab = sp.tab || "profile";

  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">{t("settings.title")}</h1>
        <p className="mt-1 text-sm text-muted-foreground">{t("settings.privacyDescription")}</p>
      </div>

      <Tabs defaultValue={defaultTab} className="space-y-4">
        <TabsList>
          <TabsTrigger value="profile">{t("settings.profile")}</TabsTrigger>
          <TabsTrigger value="site">{t("settings.siteConfig")}</TabsTrigger>
          <TabsTrigger value="privacy">{t("settings.privacy")}</TabsTrigger>
          {me.user.systemRole === "admin" && (
            <TabsTrigger value="users">{t("settings.users")}</TabsTrigger>
          )}
        </TabsList>

        <TabsContent value="profile">
          <ProfileForm
            user={me.user}
            labels={{
              myProfile: t("settings.myProfile"),
              username: t("teams.username"),
              email: t("teams.email"),
              displayName: t("settings.displayName"),
              newPassword: t("settings.newPassword"),
              passwordHint: t("settings.passwordHint"),
              updateProfile: t("settings.updateProfile"),
            }}
          />
        </TabsContent>

        <TabsContent value="site" className="space-y-4">
          {teams.length > 0 && sites.length > 0 && (
            <TeamSiteSelector
              teams={teams}
              sites={sites}
              currentTeamId={selectedTeamId}
              currentSiteId={selectedSiteId}
            />
          )}
          {site ? (
            <SiteConfigForm
              site={site}
              config={siteConfig}
              labels={{
                siteConfiguration: t("settings.siteConfiguration"),
                siteName: t("teams.siteName"),
                domain: t("teams.domain"),
                publicVisibility: t("settings.publicVisibility"),
                enablePublic: t("teams.enablePublic"),
                publicSlug: t("settings.publicSlug"),
                privacyDefaults: t("settings.privacyDefaults"),
                maskQuery: t("settings.maskQuery"),
                maskTrajectory: t("settings.maskTrajectory"),
                maskReferrer: t("settings.maskReferrer"),
                saveConfig: t("settings.saveConfig"),
              }}
            />
          ) : (
            <EmptyState title={t("settings.noSite")} />
          )}
        </TabsContent>

        <TabsContent value="privacy" className="space-y-4">
          {teams.length > 0 && sites.length > 0 && (
            <TeamSiteSelector
              teams={teams}
              sites={sites}
              currentTeamId={selectedTeamId}
              currentSiteId={selectedSiteId}
            />
          )}
          {site ? (
            <SiteConfigForm
              site={site}
              config={siteConfig}
              labels={{
                siteConfiguration: t("settings.privacyPublication"),
                siteName: t("teams.siteName"),
                domain: t("teams.domain"),
                publicVisibility: t("settings.publicVisibility"),
                enablePublic: t("teams.enablePublic"),
                publicSlug: t("settings.publicSlug"),
                privacyDefaults: t("settings.privacyDefaults"),
                maskQuery: t("settings.maskQuery"),
                maskTrajectory: t("settings.maskTrajectory"),
                maskReferrer: t("settings.maskReferrer"),
                saveConfig: t("settings.saveConfig"),
              }}
            />
          ) : (
            <EmptyState title={t("settings.noSite")} />
          )}
        </TabsContent>

        {me.user.systemRole === "admin" && (
          <TabsContent value="users">
            <UserManagement
              users={users}
              labels={{
                createUser: t("settings.createUser"),
                username: t("teams.username"),
                email: t("teams.email"),
                displayName: t("settings.displayName"),
                systemRole: t("settings.systemRole"),
                password: t("login.password"),
                create: t("common.create"),
                userDirectory: t("settings.userDirectory"),
                teams: t("nav.teams"),
                role: t("teams.role"),
              }}
            />
          </TabsContent>
        )}
      </Tabs>
    </div>
  );
}
