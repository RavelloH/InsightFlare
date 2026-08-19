import { useEffect, useMemo, useRef, useState } from "react";
import {
  RiComputerLine,
  RiGlobalLine,
  RiLockPasswordLine,
  RiNotification3Line,
  RiSave3Line,
  RiUserSettingsLine,
} from "@remixicon/react";
import { useQuery } from "@tanstack/react-query";
import { toast } from "sonner";

import { PageHeading } from "@/components/dashboard/page-heading";
import { useReportingTimeZone } from "@/components/time-zone-provider";
import { AutoResizer } from "@/components/ui/auto-resizer";
import { AutoTransition } from "@/components/ui/auto-transition";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Field,
  FieldContent,
  FieldDescription,
  FieldLabel,
} from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Spinner } from "@/components/ui/spinner";
import { intlLocale } from "@/lib/dashboard/format";
import {
  buildTimeZoneOptions,
  FALLBACK_TIME_ZONE,
  formatTimeZoneOptionLabel,
  normalizeTimeZone,
  supportedTimeZones,
} from "@/lib/dashboard/time-zone";
import {
  type AccountUserData,
  fetchNotificationPreferences,
  normalizeNotificationPreferencesData,
  type NotificationPreferencesData,
  updateNotificationPreferences,
} from "@/lib/edge-client";
import type { Locale } from "@/lib/i18n/config";
import type { AppMessages } from "@/lib/i18n/messages";
import { extractErrorMessage } from "@/lib/response-envelope";
import { useRouter } from "@/lib/router";

interface AccountSettingsClientProps {
  locale: Locale;
  messages: AppMessages;
  user: AccountUserData;
}

type TimeZoneMode = "browser" | "custom";
type PreferredLocale = "" | "en" | "zh" | "ja";

interface ProfileResponse {
  ok?: boolean;
  data?: AccountUserData;
  error?: string;
  message?: string;
}

function sameNotificationPreferences(
  left: NotificationPreferencesData | null,
  right: NotificationPreferencesData | null,
): boolean {
  if (!left || !right) return false;
  const normalizedLeft = normalizeNotificationPreferencesData(left);
  const normalizedRight = normalizeNotificationPreferencesData(right);
  return (
    normalizedLeft.inApp === normalizedRight.inApp &&
    normalizedLeft.email === normalizedRight.email &&
    normalizedLeft.webPush === normalizedRight.webPush &&
    normalizedLeft.attention.reportsCreateUnread ===
      normalizedRight.attention.reportsCreateUnread &&
    normalizedLeft.attention.milestonesCreateUnread ===
      normalizedRight.attention.milestonesCreateUnread &&
    normalizedLeft.attention.alertsCreateUnread ===
      normalizedRight.attention.alertsCreateUnread
  );
}

export function AccountSettingsClient({
  locale,
  messages,
  user,
}: AccountSettingsClientProps) {
  const copy = messages.accountSettings;
  const notificationCopy = messages.notificationCenter;
  const router = useRouter();
  const {
    timeZone,
    timeZonePreference,
    browserTimeZone,
    setTimeZonePreference,
  } = useReportingTimeZone();
  const [profileUser, setProfileUser] = useState(user);
  const [profileName, setProfileName] = useState(user.name || "");
  const [profileUsername, setProfileUsername] = useState(user.username || "");
  const [profileEmail, setProfileEmail] = useState(user.email || "");
  const [preferredLocale, setPreferredLocale] = useState<PreferredLocale>(
    user.preferredLocale || "",
  );
  const [preferredLocaleSaving, setPreferredLocaleSaving] = useState(false);
  const [profileSaving, setProfileSaving] = useState(false);
  const [currentPassword, setCurrentPassword] = useState("");
  const [nextPassword, setNextPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [passwordSaving, setPasswordSaving] = useState(false);
  const [notificationPreferences, setNotificationPreferences] =
    useState<NotificationPreferencesData | null>(null);
  const [draftNotificationPreferences, setDraftNotificationPreferences] =
    useState<NotificationPreferencesData | null>(null);
  const [notificationPreferencesSaving, setNotificationPreferencesSaving] =
    useState(false);
  const appliedNotificationPreferencesUserIdRef = useRef<string | null>(null);
  const notificationPreferencesQuery = useQuery({
    queryKey: ["dashboard", "notification-preferences", user.id],
    queryFn: ({ signal }) => fetchNotificationPreferences({ signal }),
    enabled: typeof window !== "undefined",
  });
  const notificationPreferencesLoading = notificationPreferencesQuery.isPending;
  const timeZones = useMemo(() => supportedTimeZones(), []);
  const [mode, setMode] = useState<TimeZoneMode>(
    timeZonePreference ? "custom" : "browser",
  );
  const [customTimeZone, setCustomTimeZone] = useState(
    timeZonePreference || timeZone,
  );
  const [saving, setSaving] = useState(false);
  const timeZoneOptionTimestamp = useMemo(() => Date.now(), []);
  const normalizedProfileName = profileName.trim();
  const normalizedProfileUsername = profileUsername.trim();
  const normalizedProfileEmail = profileEmail.trim();
  const profileChanged =
    normalizedProfileName !== (profileUser.name || "") ||
    normalizedProfileUsername !== profileUser.username ||
    normalizedProfileEmail !== profileUser.email;
  const canSaveProfile =
    !profileSaving &&
    profileChanged &&
    normalizedProfileUsername.length >= 3 &&
    normalizedProfileEmail.length >= 3 &&
    normalizedProfileEmail.includes("@");
  const canSavePassword =
    !passwordSaving &&
    currentPassword.length > 0 &&
    nextPassword.length >= 8 &&
    confirmPassword.length > 0;
  const canSaveNotificationPreferences =
    !notificationPreferencesLoading &&
    !notificationPreferencesSaving &&
    Boolean(draftNotificationPreferences) &&
    !sameNotificationPreferences(
      notificationPreferences,
      draftNotificationPreferences,
    );
  const selectedCustomTimeZone =
    normalizeTimeZone(customTimeZone) ||
    normalizeTimeZone(timeZone) ||
    normalizeTimeZone(browserTimeZone) ||
    FALLBACK_TIME_ZONE;
  const timeZoneOptions = useMemo(
    () =>
      buildTimeZoneOptions({
        locale: intlLocale(locale),
        supported: timeZones,
        selected: selectedCustomTimeZone,
        active: timeZone,
        browser: browserTimeZone,
        timestampMs: timeZoneOptionTimestamp,
      }),
    [
      browserTimeZone,
      locale,
      selectedCustomTimeZone,
      timeZone,
      timeZoneOptionTimestamp,
      timeZones,
    ],
  );

  useEffect(() => {
    setProfileUser(user);
    setProfileName(user.name || "");
    setProfileUsername(user.username || "");
    setProfileEmail(user.email || "");
    setPreferredLocale(user.preferredLocale || "");
  }, [user]);

  useEffect(() => {
    setMode(timeZonePreference ? "custom" : "browser");
    if (timeZonePreference) {
      setCustomTimeZone(timeZonePreference);
    } else {
      setCustomTimeZone(timeZone);
    }
  }, [timeZone, timeZonePreference]);

  useEffect(() => {
    if (
      notificationPreferencesQuery.isPending ||
      appliedNotificationPreferencesUserIdRef.current === user.id
    ) {
      return;
    }
    if (notificationPreferencesQuery.isError) {
      toast.error(notificationCopy.preferencesSaveFailed);
      appliedNotificationPreferencesUserIdRef.current = user.id;
      return;
    }
    const normalized = normalizeNotificationPreferencesData(
      notificationPreferencesQuery.data,
    );
    setNotificationPreferences(normalized);
    setDraftNotificationPreferences(normalized);
    appliedNotificationPreferencesUserIdRef.current = user.id;
  }, [
    notificationCopy.preferencesSaveFailed,
    notificationPreferencesQuery.data,
    notificationPreferencesQuery.isError,
    notificationPreferencesQuery.isPending,
    user.id,
  ]);

  const nextPreference = mode === "browser" ? "" : selectedCustomTimeZone;
  const canSavePreferredLocale =
    !preferredLocaleSaving &&
    preferredLocale !== (profileUser.preferredLocale || "");
  const canSave =
    !saving &&
    (mode === "browser" || Boolean(nextPreference)) &&
    nextPreference !== timeZonePreference;
  const sourceLabel =
    timeZonePreference.length > 0 ? copy.manualSource : copy.browserSource;
  const activeTimeZoneLabel = formatTimeZoneOptionLabel({
    locale: intlLocale(locale),
    timeZone,
    timestampMs: timeZoneOptionTimestamp,
  });
  const browserTimeZoneLabel = browserTimeZone
    ? formatTimeZoneOptionLabel({
        locale: intlLocale(locale),
        timeZone: browserTimeZone,
        timestampMs: timeZoneOptionTimestamp,
      })
    : copy.browserUnavailable;

  function applySavedUser(savedUser: AccountUserData) {
    setProfileUser(savedUser);
    setProfileName(savedUser.name || "");
    setProfileUsername(savedUser.username || "");
    setProfileEmail(savedUser.email || "");
    setPreferredLocale(savedUser.preferredLocale || "");
  }

  function updateDraftNotificationPreferences(
    patch: Omit<Partial<NotificationPreferencesData>, "attention"> & {
      attention?: Partial<NotificationPreferencesData["attention"]>;
    },
  ) {
    setDraftNotificationPreferences((current) => {
      if (!current) return current;
      const normalized = normalizeNotificationPreferencesData(current);
      return {
        ...normalized,
        ...patch,
        attention: {
          ...normalized.attention,
          ...(patch.attention ?? {}),
        },
      };
    });
  }

  async function handleProfileSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (profileSaving) return;
    if (
      normalizedProfileUsername.length < 3 ||
      !/^[a-z0-9._@-]+$/i.test(normalizedProfileUsername) ||
      normalizedProfileEmail.length < 3 ||
      !normalizedProfileEmail.includes("@")
    ) {
      toast.error(copy.invalidProfile);
      return;
    }

    setProfileSaving(true);
    try {
      const response = await fetch("/api/private/admin/profile", {
        method: "POST",
        credentials: "include",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          username: normalizedProfileUsername,
          email: normalizedProfileEmail,
          name: normalizedProfileName,
        }),
      });
      const payload = (await response
        .json()
        .catch(() => ({}))) as ProfileResponse;
      if (!response.ok || payload.ok === false || !payload.data) {
        throw new Error(extractErrorMessage(payload, copy.profileSaveFailed));
      }
      applySavedUser(payload.data);
      toast.success(copy.profileSaved);
      router.refresh();
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : copy.profileSaveFailed,
      );
    } finally {
      setProfileSaving(false);
    }
  }

  async function handlePasswordSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (passwordSaving) return;
    if (!currentPassword) {
      toast.error(copy.currentPasswordRequired);
      return;
    }
    if (nextPassword.length < 8) {
      toast.error(copy.passwordTooShort);
      return;
    }
    if (nextPassword !== confirmPassword) {
      toast.error(copy.passwordMismatch);
      return;
    }

    setPasswordSaving(true);
    try {
      const response = await fetch("/api/private/admin/profile", {
        method: "POST",
        credentials: "include",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          currentPassword,
          password: nextPassword,
        }),
      });
      const payload = (await response
        .json()
        .catch(() => ({}))) as ProfileResponse;
      if (!response.ok || payload.ok === false || !payload.data) {
        throw new Error(extractErrorMessage(payload, copy.passwordSaveFailed));
      }
      applySavedUser(payload.data);
      setCurrentPassword("");
      setNextPassword("");
      setConfirmPassword("");
      toast.success(copy.passwordSaved);
      router.refresh();
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : copy.passwordSaveFailed,
      );
    } finally {
      setPasswordSaving(false);
    }
  }

  async function handleNotificationPreferencesSubmit(
    event: React.FormEvent<HTMLFormElement>,
  ) {
    event.preventDefault();
    if (!draftNotificationPreferences || notificationPreferencesSaving) return;

    setNotificationPreferencesSaving(true);
    try {
      const saved = await updateNotificationPreferences(
        draftNotificationPreferences,
      );
      const normalized = normalizeNotificationPreferencesData(saved);
      setNotificationPreferences(normalized);
      setDraftNotificationPreferences(normalized);
      toast.success(notificationCopy.preferencesSaved);
      router.refresh();
    } catch {
      toast.error(notificationCopy.preferencesSaveFailed);
    } finally {
      setNotificationPreferencesSaving(false);
    }
  }

  async function handlePreferredLocaleSubmit(
    event: React.FormEvent<HTMLFormElement>,
  ) {
    event.preventDefault();
    if (preferredLocaleSaving) return;
    if (
      preferredLocale !== "" &&
      preferredLocale !== "en" &&
      preferredLocale !== "zh"
    ) {
      toast.error(copy.preferredLanguageSaveFailed);
      return;
    }

    setPreferredLocaleSaving(true);
    try {
      const response = await fetch("/api/private/admin/profile", {
        method: "POST",
        credentials: "include",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({ preferredLocale }),
      });
      const payload = (await response
        .json()
        .catch(() => ({}))) as ProfileResponse;
      if (!response.ok || payload.ok === false || !payload.data) {
        throw new Error(
          extractErrorMessage(payload, copy.preferredLanguageSaveFailed),
        );
      }
      applySavedUser(payload.data);
      toast.success(copy.preferredLanguageSaved);
      router.refresh();
    } catch (error) {
      toast.error(
        error instanceof Error
          ? error.message
          : copy.preferredLanguageSaveFailed,
      );
    } finally {
      setPreferredLocaleSaving(false);
    }
  }

  async function handleTimeZoneSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (saving) return;
    if (mode === "custom" && !nextPreference) {
      toast.error(copy.invalidTimeZone);
      return;
    }

    setSaving(true);
    try {
      const response = await fetch("/api/private/admin/profile", {
        method: "POST",
        credentials: "include",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({ timeZone: nextPreference }),
      });
      const payload = (await response
        .json()
        .catch(() => ({}))) as ProfileResponse;
      if (!response.ok || payload.ok === false) {
        throw new Error(extractErrorMessage(payload, copy.saveFailed));
      }
      const savedTimeZone = normalizeTimeZone(payload.data?.timeZone) || "";
      setTimeZonePreference(savedTimeZone);
      setMode(savedTimeZone ? "custom" : "browser");
      if (savedTimeZone) {
        setCustomTimeZone(savedTimeZone);
      }
      toast.success(copy.saved);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : copy.saveFailed);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="space-y-5">
      <PageHeading title={copy.title} subtitle={copy.subtitle} />

      <div className="grid gap-4 lg:grid-cols-2">
        <Card className="h-full">
          <CardHeader>
            <CardTitle className="inline-flex items-center gap-2">
              <RiUserSettingsLine className="size-4" />
              {copy.profileTitle}
            </CardTitle>
            <CardDescription>{copy.profileDescription}</CardDescription>
          </CardHeader>
          <CardContent className="flex h-full flex-col">
            <form
              className="flex h-full flex-col gap-5"
              onSubmit={handleProfileSubmit}
            >
              <div className="grid gap-4 sm:grid-cols-2">
                <Field>
                  <FieldLabel htmlFor="account-profile-name">
                    {copy.nicknameLabel}
                  </FieldLabel>
                  <Input
                    id="account-profile-name"
                    value={profileName}
                    maxLength={120}
                    autoComplete="name"
                    placeholder={copy.nicknamePlaceholder}
                    onChange={(event) => setProfileName(event.target.value)}
                    disabled={profileSaving}
                  />
                </Field>
                <Field>
                  <FieldLabel htmlFor="account-profile-username">
                    {copy.usernameLabel}
                  </FieldLabel>
                  <Input
                    id="account-profile-username"
                    value={profileUsername}
                    minLength={3}
                    maxLength={80}
                    autoComplete="username"
                    placeholder={copy.usernamePlaceholder}
                    onChange={(event) => setProfileUsername(event.target.value)}
                    disabled={profileSaving}
                    required
                  />
                </Field>
                <Field className="sm:col-span-2">
                  <FieldLabel htmlFor="account-profile-email">
                    {copy.emailLabel}
                  </FieldLabel>
                  <Input
                    id="account-profile-email"
                    type="email"
                    value={profileEmail}
                    maxLength={200}
                    autoComplete="email"
                    placeholder={copy.emailPlaceholder}
                    onChange={(event) => setProfileEmail(event.target.value)}
                    disabled={profileSaving}
                    required
                  />
                </Field>
              </div>
              <FieldDescription>{copy.usernameDescription}</FieldDescription>

              <div className="mt-auto flex justify-start">
                <Button type="submit" disabled={!canSaveProfile}>
                  <AutoTransition className="inline-flex items-center gap-2">
                    {profileSaving ? (
                      <span
                        key="profile-saving"
                        className="inline-flex items-center gap-2"
                      >
                        <Spinner className="size-4" />
                        {copy.profileSaving}
                      </span>
                    ) : (
                      <span
                        key="profile-save"
                        className="inline-flex items-center gap-2"
                      >
                        <RiSave3Line className="size-4" />
                        {copy.profileSave}
                      </span>
                    )}
                  </AutoTransition>
                </Button>
              </div>
            </form>
          </CardContent>
        </Card>

        <Card className="h-full">
          <CardHeader>
            <CardTitle className="inline-flex items-center gap-2">
              <RiLockPasswordLine className="size-4" />
              {copy.passwordTitle}
            </CardTitle>
            <CardDescription>{copy.passwordDescription}</CardDescription>
          </CardHeader>
          <CardContent className="flex h-full flex-col">
            <form
              className="flex h-full flex-col gap-5"
              onSubmit={handlePasswordSubmit}
            >
              <div className="grid gap-4 sm:grid-cols-2">
                <Field className="sm:col-span-2">
                  <FieldLabel htmlFor="account-current-password">
                    {copy.currentPasswordLabel}
                  </FieldLabel>
                  <Input
                    id="account-current-password"
                    type="password"
                    value={currentPassword}
                    autoComplete="current-password"
                    onChange={(event) => setCurrentPassword(event.target.value)}
                    disabled={passwordSaving}
                    required
                  />
                </Field>
                <Field>
                  <FieldLabel htmlFor="account-new-password">
                    {copy.newPasswordLabel}
                  </FieldLabel>
                  <Input
                    id="account-new-password"
                    type="password"
                    value={nextPassword}
                    minLength={8}
                    autoComplete="new-password"
                    onChange={(event) => setNextPassword(event.target.value)}
                    disabled={passwordSaving}
                    required
                  />
                </Field>
                <Field>
                  <FieldLabel htmlFor="account-confirm-password">
                    {copy.confirmPasswordLabel}
                  </FieldLabel>
                  <Input
                    id="account-confirm-password"
                    type="password"
                    value={confirmPassword}
                    minLength={8}
                    autoComplete="new-password"
                    onChange={(event) => setConfirmPassword(event.target.value)}
                    disabled={passwordSaving}
                    required
                  />
                </Field>
              </div>

              <div className="mt-auto flex justify-start">
                <Button type="submit" disabled={!canSavePassword}>
                  <AutoTransition className="inline-flex items-center gap-2">
                    {passwordSaving ? (
                      <span
                        key="password-saving"
                        className="inline-flex items-center gap-2"
                      >
                        <Spinner className="size-4" />
                        {copy.passwordSaving}
                      </span>
                    ) : (
                      <span
                        key="password-save"
                        className="inline-flex items-center gap-2"
                      >
                        <RiSave3Line className="size-4" />
                        {copy.passwordSave}
                      </span>
                    )}
                  </AutoTransition>
                </Button>
              </div>
            </form>
          </CardContent>
        </Card>

        <Card className="h-full lg:col-span-2">
          <CardHeader>
            <CardTitle className="inline-flex items-center gap-2">
              <RiNotification3Line className="size-4" />
              {notificationCopy.preferencesTitle}
            </CardTitle>
            <CardDescription>
              {notificationCopy.preferencesDescription}
            </CardDescription>
          </CardHeader>
          <CardContent className="flex h-full flex-col">
            <AutoResizer initial duration={0.28} ease={[0.22, 1, 0.36, 1]}>
              <AutoTransition
                initial={false}
                duration={0.2}
                type="fade"
                presenceMode="wait"
                transitionKey={
                  notificationPreferencesLoading ||
                  !draftNotificationPreferences
                    ? "loading"
                    : "preferences"
                }
              >
                {notificationPreferencesLoading ||
                !draftNotificationPreferences ? (
                  <div
                    key="loading"
                    className="flex h-32 items-center justify-center text-sm text-muted-foreground"
                    aria-busy="true"
                  >
                    <Spinner className="mr-2 size-4" />
                    {messages.common.loading}
                  </div>
                ) : (
                  <form
                    key="preferences"
                    className="flex h-full flex-col gap-5"
                    onSubmit={handleNotificationPreferencesSubmit}
                  >
                    <div className="grid gap-4 md:grid-cols-2">
                      <Field>
                        <FieldLabel>
                          {notificationCopy.emailNotificationsLabel}
                        </FieldLabel>
                        <div className="flex items-start gap-3">
                          <Checkbox
                            checked={draftNotificationPreferences.email}
                            disabled={notificationPreferencesSaving}
                            onCheckedChange={(checked) =>
                              updateDraftNotificationPreferences({
                                email: !!checked,
                              })
                            }
                          />
                          <FieldDescription>
                            {notificationCopy.emailNotificationsDescription}
                          </FieldDescription>
                        </div>
                      </Field>
                      <Field>
                        <FieldLabel>
                          {notificationCopy.reportsUnreadLabel}
                        </FieldLabel>
                        <div className="flex items-start gap-3">
                          <Checkbox
                            checked={
                              draftNotificationPreferences.attention
                                .reportsCreateUnread
                            }
                            disabled={notificationPreferencesSaving}
                            onCheckedChange={(checked) =>
                              updateDraftNotificationPreferences({
                                attention: { reportsCreateUnread: !!checked },
                              })
                            }
                          />
                          <FieldDescription>
                            {notificationCopy.reportsUnreadDescription}
                          </FieldDescription>
                        </div>
                      </Field>
                      <Field>
                        <FieldLabel>
                          {notificationCopy.milestonesUnreadLabel}
                        </FieldLabel>
                        <div className="flex items-start gap-3">
                          <Checkbox
                            checked={
                              draftNotificationPreferences.attention
                                .milestonesCreateUnread
                            }
                            disabled={notificationPreferencesSaving}
                            onCheckedChange={(checked) =>
                              updateDraftNotificationPreferences({
                                attention: {
                                  milestonesCreateUnread: !!checked,
                                },
                              })
                            }
                          />
                          <FieldDescription>
                            {notificationCopy.milestonesUnreadDescription}
                          </FieldDescription>
                        </div>
                      </Field>
                      <Field>
                        <FieldLabel>
                          {notificationCopy.alertsUnreadLabel}
                        </FieldLabel>
                        <div className="flex items-start gap-3">
                          <Checkbox
                            checked={
                              draftNotificationPreferences.attention
                                .alertsCreateUnread
                            }
                            disabled={notificationPreferencesSaving}
                            onCheckedChange={(checked) =>
                              updateDraftNotificationPreferences({
                                attention: { alertsCreateUnread: !!checked },
                              })
                            }
                          />
                          <FieldDescription>
                            {notificationCopy.alertsUnreadDescription}
                          </FieldDescription>
                        </div>
                      </Field>
                    </div>

                    <div className="mt-auto flex justify-start">
                      <Button
                        type="submit"
                        disabled={!canSaveNotificationPreferences}
                      >
                        <AutoTransition className="inline-flex items-center gap-2">
                          {notificationPreferencesSaving ? (
                            <span
                              key="notification-preferences-saving"
                              className="inline-flex items-center gap-2"
                            >
                              <Spinner className="size-4" />
                              {copy.saving}
                            </span>
                          ) : (
                            <span
                              key="notification-preferences-save"
                              className="inline-flex items-center gap-2"
                            >
                              <RiSave3Line className="size-4" />
                              {copy.save}
                            </span>
                          )}
                        </AutoTransition>
                      </Button>
                    </div>
                  </form>
                )}
              </AutoTransition>
            </AutoResizer>
          </CardContent>
        </Card>

        <Card className="h-full overflow-visible lg:col-span-2">
          <CardHeader>
            <CardTitle className="inline-flex items-center gap-2">
              <RiGlobalLine className="size-4" />
              {copy.preferredLanguageTitle}
            </CardTitle>
            <CardDescription>
              {copy.preferredLanguageDescription}
            </CardDescription>
          </CardHeader>
          <CardContent className="flex h-full flex-col">
            <form
              className="flex h-full flex-col gap-5"
              onSubmit={handlePreferredLocaleSubmit}
            >
              <Field>
                <FieldLabel htmlFor="account-preferred-language">
                  {copy.preferredLanguageLabel}
                </FieldLabel>
                <Select
                  value={preferredLocale || "default"}
                  disabled={preferredLocaleSaving}
                  onValueChange={(value) => {
                    if (value === "default") setPreferredLocale("");
                    if (value === "en" || value === "zh" || value === "ja") {
                      setPreferredLocale(value);
                    }
                  }}
                >
                  <SelectTrigger
                    id="account-preferred-language"
                    className="w-full"
                  >
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="default">
                      {copy.preferredLanguageDefault}
                    </SelectItem>
                    <SelectItem value="en">
                      {copy.preferredLanguageEnglish}
                    </SelectItem>
                    <SelectItem value="zh">
                      {copy.preferredLanguageChinese}
                    </SelectItem>
                    <SelectItem value="ja">
                      {copy.preferredLanguageJapanese}
                    </SelectItem>
                  </SelectContent>
                </Select>
              </Field>

              <div className="mt-auto flex justify-start">
                <Button type="submit" disabled={!canSavePreferredLocale}>
                  <AutoTransition className="inline-flex items-center gap-2">
                    {preferredLocaleSaving ? (
                      <span
                        key="preferred-locale-saving"
                        className="inline-flex items-center gap-2"
                      >
                        <Spinner className="size-4" />
                        {copy.saving}
                      </span>
                    ) : (
                      <span
                        key="preferred-locale-save"
                        className="inline-flex items-center gap-2"
                      >
                        <RiSave3Line className="size-4" />
                        {copy.save}
                      </span>
                    )}
                  </AutoTransition>
                </Button>
              </div>
            </form>
          </CardContent>
        </Card>

        <Card className="h-full overflow-visible lg:col-span-2">
          <CardHeader>
            <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
              <div className="space-y-1">
                <CardTitle className="inline-flex items-center gap-2">
                  <RiGlobalLine className="size-4" />
                  {copy.timeZoneTitle}
                </CardTitle>
                <CardDescription>{copy.timeZoneDescription}</CardDescription>
              </div>
              <Badge variant="outline">{sourceLabel}</Badge>
            </div>
          </CardHeader>
          <CardContent className="flex h-full flex-col">
            <form
              className="flex h-full flex-col gap-5"
              onSubmit={handleTimeZoneSubmit}
            >
              <div className="grid gap-3 sm:grid-cols-2">
                <div className="rounded-none border border-border p-3">
                  <div className="mb-1 flex items-center gap-2 text-xs font-medium">
                    <RiGlobalLine className="size-4 text-muted-foreground" />
                    {copy.activeTimeZone}
                  </div>
                  <div className="text-sm">{activeTimeZoneLabel}</div>
                </div>
                <div className="rounded-none border border-border p-3">
                  <div className="mb-1 flex items-center gap-2 text-xs font-medium">
                    <RiComputerLine className="size-4 text-muted-foreground" />
                    {copy.browserTimeZone}
                  </div>
                  <div className="text-sm">{browserTimeZoneLabel}</div>
                </div>
              </div>

              <Field>
                <FieldLabel htmlFor="account-timezone-mode">
                  {copy.preferenceLabel}
                </FieldLabel>
                <Select
                  value={mode}
                  onValueChange={(value) => {
                    if (value === "browser" || value === "custom") {
                      setMode(value);
                    }
                  }}
                >
                  <SelectTrigger id="account-timezone-mode" className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="browser">{copy.useBrowser}</SelectItem>
                    <SelectItem value="custom">{copy.useCustom}</SelectItem>
                  </SelectContent>
                </Select>
                <FieldDescription>
                  {copy.preferenceDescription}
                </FieldDescription>
              </Field>

              <Field>
                <FieldLabel htmlFor="account-timezone-select">
                  {copy.customTimeZoneLabel}
                </FieldLabel>
                <AutoResizer initial duration={0.24} ease={[0.22, 1, 0.36, 1]}>
                  <AutoTransition
                    initial={false}
                    duration={0.18}
                    type="fade"
                    presenceMode="wait"
                    transitionKey={mode}
                  >
                    <FieldContent key={mode}>
                      <Select
                        value={selectedCustomTimeZone}
                        disabled={mode === "browser"}
                        onValueChange={(value) => {
                          setCustomTimeZone(value);
                          if (mode !== "custom") setMode("custom");
                        }}
                      >
                        <SelectTrigger
                          id="account-timezone-select"
                          className="w-full"
                        >
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent className="max-h-80">
                          {timeZoneOptions.map((option) => (
                            <SelectItem key={option.value} value={option.value}>
                              {option.label}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      <FieldDescription>
                        {copy.customTimeZoneDescription}
                      </FieldDescription>
                    </FieldContent>
                  </AutoTransition>
                </AutoResizer>
              </Field>

              <div className="mt-auto flex justify-start">
                <Button type="submit" disabled={!canSave}>
                  <AutoTransition className="inline-flex items-center gap-2">
                    {saving ? (
                      <span
                        key="saving"
                        className="inline-flex items-center gap-2"
                      >
                        <Spinner className="size-4" />
                        {copy.saving}
                      </span>
                    ) : (
                      <span
                        key="save"
                        className="inline-flex items-center gap-2"
                      >
                        <RiSave3Line className="size-4" />
                        {copy.save}
                      </span>
                    )}
                  </AutoTransition>
                </Button>
              </div>
            </form>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
