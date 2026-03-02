import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ProfileForm } from "@/components/settings/profile-form";
import { UserManagement } from "@/components/settings/user-management";
import { getDictionary } from "@/lib/i18n/dictionaries";
import { isValidLocale, DEFAULT_LOCALE } from "@/lib/i18n/config";
import type { Locale } from "@/lib/i18n/config";
import { fetchAdminMe, fetchAdminUsers } from "@/lib/edge-client";

interface SettingsSearchParams {
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
  const users = me.user.systemRole === "admin" ? await fetchAdminUsers() : [];

  const defaultTab = sp.tab || "profile";

  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">{t("settings.title")}</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          {t("settings.privacyDescription")}
        </p>
      </div>

      <Tabs defaultValue={defaultTab} className="space-y-4">
        <TabsList>
          <TabsTrigger value="profile">{t("settings.profile")}</TabsTrigger>
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
