import { useEffect, useMemo, useRef, useState } from "react";
import {
  RiCloseLine,
  RiDeleteBinLine,
  RiMailSendLine,
  RiSave3Line,
  RiSendPlane2Line,
} from "@remixicon/react";
import { useQuery } from "@tanstack/react-query";
import { toast } from "sonner";

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { AutoTransition } from "@/components/ui/auto-transition";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Spinner } from "@/components/ui/spinner";
import { requestAdminService } from "@/lib/admin-service-client";
import type { Locale } from "@/lib/i18n/config";
import type { AppMessages } from "@/lib/i18n/messages";
import type {
  NotificationEmailProvider,
  PublicNotificationEmailConfig,
} from "@/lib/notifications/email-config";

import { SystemSettingsGuideDialog } from "./system-settings-guide-dialog";

interface NotificationEmailSettingsClientProps {
  locale: Locale;
  messages: AppMessages;
  currentUserEmail: string;
  showHeading?: boolean;
}

interface TestEmailResponse {
  provider: "resend";
  messageId: string;
  durationMs: number;
}

type FormState = Pick<
  PublicNotificationEmailConfig,
  "enabled" | "provider" | "fromName" | "fromEmail" | "replyTo"
>;

function defaultConfig(): PublicNotificationEmailConfig {
  return {
    enabled: false,
    provider: "resend",
    fromName: "InsightFlare",
    fromEmail: "",
    replyTo: "",
    resend: {
      configured: false,
      apiKeyHint: "",
    },
    updatedAt: 0,
  };
}

function toFormState(config: PublicNotificationEmailConfig): FormState {
  return {
    enabled: config.enabled,
    provider: config.provider,
    fromName: config.fromName,
    fromEmail: config.fromEmail,
    replyTo: config.replyTo,
  };
}

async function fetchEmailConfig(
  signal?: AbortSignal,
): Promise<PublicNotificationEmailConfig> {
  return requestAdminService<PublicNotificationEmailConfig>(
    "notification-email",
    { signal },
  );
}

async function saveEmailConfig(
  body: Record<string, unknown>,
): Promise<PublicNotificationEmailConfig> {
  return requestAdminService<PublicNotificationEmailConfig>(
    "notification-email",
    { method: "PATCH", body },
  );
}

async function deleteEmailConfig(): Promise<PublicNotificationEmailConfig> {
  return requestAdminService<PublicNotificationEmailConfig>(
    "notification-email",
    { method: "DELETE" },
  );
}

async function sendTestEmail(to: string): Promise<TestEmailResponse> {
  const body = { to };
  return requestAdminService<TestEmailResponse>("notification-email/test", {
    method: "POST",
    body,
  });
}

export function NotificationEmailSettingsClient({
  messages,
  currentUserEmail,
  showHeading = true,
}: NotificationEmailSettingsClientProps) {
  const copy = messages.systemSettings;
  const [config, setConfig] =
    useState<PublicNotificationEmailConfig>(defaultConfig);
  const [form, setForm] = useState<FormState>(() =>
    toFormState(defaultConfig()),
  );
  const [apiKey, setApiKey] = useState("");
  const [apiKeyDirty, setApiKeyDirty] = useState(false);
  const [testRecipient, setTestRecipient] = useState(currentUserEmail);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [deletingConfig, setDeletingConfig] = useState(false);
  const configAppliedRef = useRef(false);
  const configQuery = useQuery({
    queryKey: ["dashboard", "notification-email-config"],
    queryFn: ({ signal }) => fetchEmailConfig(signal),
    enabled: typeof window !== "undefined",
  });
  const loading = configQuery.isPending;

  const hasChanges = useMemo(() => {
    const persisted = toFormState(config);
    return (
      form.enabled !== persisted.enabled ||
      form.provider !== persisted.provider ||
      form.fromName !== persisted.fromName ||
      form.fromEmail !== persisted.fromEmail ||
      form.replyTo !== persisted.replyTo ||
      apiKey.trim().length > 0
    );
  }, [apiKey, config, form]);

  const showSavedApiKey =
    !apiKeyDirty &&
    config.resend.configured &&
    Boolean(config.resend.apiKeyHint);
  const apiKeyDisplayValue = showSavedApiKey
    ? config.resend.apiKeyHint
    : apiKey;

  useEffect(() => {
    if (configQuery.isPending || configAppliedRef.current) return;
    if (configQuery.isError) toast.error(copy.loadFailed);
    const nextConfig = configQuery.data ?? defaultConfig();
    setConfig(nextConfig);
    setForm(toFormState(nextConfig));
    configAppliedRef.current = true;
  }, [
    copy.loadFailed,
    configQuery.data,
    configQuery.isError,
    configQuery.isPending,
  ]);

  function updateForm<K extends keyof FormState>(key: K, value: FormState[K]) {
    setForm((current) => ({ ...current, [key]: value }));
  }

  async function handleSave() {
    const nextApiKey = apiKey.trim();
    const body: Record<string, unknown> = {
      enabled: form.enabled,
      provider: form.provider,
      fromName: form.fromName,
      fromEmail: form.fromEmail,
      replyTo: form.replyTo,
    };
    if (nextApiKey) body.resendApiKey = nextApiKey;

    setSaving(true);
    try {
      const saved = await saveEmailConfig(body);
      setConfig(saved);
      setForm(toFormState(saved));
      setApiKey("");
      setApiKeyDirty(false);
      toast.success(copy.saved);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : copy.saveFailed);
    } finally {
      setSaving(false);
    }
  }

  async function handleDeleteConfig() {
    setDeletingConfig(true);
    try {
      const reset = await deleteEmailConfig();
      setConfig(reset);
      setForm(toFormState(reset));
      setApiKey("");
      setApiKeyDirty(false);
      setDeleteDialogOpen(false);
      toast.success(copy.deleted);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : copy.deleteFailed);
    } finally {
      setDeletingConfig(false);
    }
  }

  async function handleSendTest() {
    setTesting(true);
    try {
      const result = await sendTestEmail(testRecipient.trim());
      const suffix = result.messageId ? ` (${result.messageId})` : "";
      toast.success(`${copy.testSent}${suffix}`);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : copy.testFailed);
    } finally {
      setTesting(false);
    }
  }

  return (
    <div className="space-y-4">
      {showHeading ? (
        <div className="space-y-1">
          <h1 className="text-xl font-semibold tracking-normal">
            {copy.title}
          </h1>
          <p className="text-sm text-muted-foreground">{copy.subtitle}</p>
        </div>
      ) : null}

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <RiMailSendLine className="size-4" />
            {copy.notificationEmailTitle}
          </CardTitle>
          <CardDescription>{copy.notificationEmailDescription}</CardDescription>
        </CardHeader>
        <CardContent>
          <form
            className="grid gap-5"
            onSubmit={(event) => {
              event.preventDefault();
              void handleSave();
            }}
          >
            <div className="grid gap-4 md:grid-cols-2">
              <div className="space-y-2">
                <Label htmlFor="system-email-enabled">
                  {copy.enabledLabel}
                </Label>
                <Select
                  value={form.enabled ? "true" : "false"}
                  onValueChange={(value) =>
                    updateForm("enabled", value === "true")
                  }
                  disabled={loading || saving}
                >
                  <SelectTrigger id="system-email-enabled" className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="true">{copy.enabledOn}</SelectItem>
                    <SelectItem value="false">{copy.enabledOff}</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              <div className="space-y-2">
                <Label htmlFor="system-email-provider">
                  {copy.providerLabel}
                </Label>
                <Select
                  value={form.provider}
                  onValueChange={(value) =>
                    updateForm("provider", value as NotificationEmailProvider)
                  }
                  disabled={loading || saving}
                >
                  <SelectTrigger id="system-email-provider" className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="resend">
                      {copy.providerResend}
                    </SelectItem>
                  </SelectContent>
                </Select>
              </div>

              <div className="space-y-2">
                <Label htmlFor="system-email-from-name">
                  {copy.fromNameLabel}
                </Label>
                <Input
                  id="system-email-from-name"
                  value={form.fromName}
                  maxLength={120}
                  disabled={loading || saving}
                  onChange={(event) =>
                    updateForm("fromName", event.target.value)
                  }
                />
              </div>

              <div className="space-y-2">
                <Label htmlFor="system-email-from-email">
                  {copy.fromEmailLabel}
                </Label>
                <Input
                  id="system-email-from-email"
                  type="email"
                  value={form.fromEmail}
                  disabled={loading || saving}
                  onChange={(event) =>
                    updateForm("fromEmail", event.target.value)
                  }
                />
              </div>

              <div className="space-y-2">
                <Label htmlFor="system-email-reply-to">
                  {copy.replyToLabel}
                </Label>
                <Input
                  id="system-email-reply-to"
                  type="email"
                  value={form.replyTo}
                  placeholder={copy.replyToPlaceholder}
                  disabled={loading || saving}
                  onChange={(event) =>
                    updateForm("replyTo", event.target.value)
                  }
                />
              </div>

              <div className="space-y-2">
                <Label htmlFor="system-email-resend-api-key">
                  {copy.resendApiKeyLabel}
                </Label>
                <Input
                  id="system-email-resend-api-key"
                  type={showSavedApiKey ? "text" : "password"}
                  value={apiKeyDisplayValue}
                  placeholder={copy.resendApiKeyPlaceholder}
                  disabled={loading || saving || deletingConfig}
                  onFocus={() => {
                    if (!showSavedApiKey) return;
                    setApiKeyDirty(true);
                    setApiKey("");
                  }}
                  onBlur={() => {
                    if (!apiKey.trim()) setApiKeyDirty(false);
                  }}
                  onChange={(event) => {
                    setApiKeyDirty(true);
                    setApiKey(event.target.value);
                  }}
                />
              </div>
            </div>

            <div className="grid gap-3 border-t pt-4 md:grid-cols-[minmax(0,1fr)_auto] md:items-end">
              <div className="space-y-2">
                <Label htmlFor="system-email-test-recipient">
                  {copy.testRecipientLabel}
                </Label>
                <Input
                  id="system-email-test-recipient"
                  type="email"
                  value={testRecipient}
                  disabled={loading || testing}
                  onChange={(event) => setTestRecipient(event.target.value)}
                />
              </div>
              <Button
                type="button"
                variant="outline"
                disabled={loading || saving || testing}
                onClick={() => {
                  void handleSendTest();
                }}
              >
                <AutoTransition className="inline-flex items-center gap-2">
                  {testing ? (
                    <span
                      key="testing"
                      className="inline-flex items-center gap-2"
                    >
                      <Spinner className="size-4" />
                      {copy.testing}
                    </span>
                  ) : (
                    <span key="test" className="inline-flex items-center gap-2">
                      <RiSendPlane2Line className="size-4" />
                      {copy.test}
                    </span>
                  )}
                </AutoTransition>
              </Button>
            </div>

            <div className="flex flex-wrap gap-2">
              <Button type="submit" disabled={loading || saving || !hasChanges}>
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
                    <span key="save" className="inline-flex items-center gap-2">
                      <RiSave3Line className="size-4" />
                      {copy.save}
                    </span>
                  )}
                </AutoTransition>
              </Button>

              <AlertDialog
                open={deleteDialogOpen}
                onOpenChange={(open) => {
                  if (deletingConfig) return;
                  setDeleteDialogOpen(open);
                }}
              >
                <AlertDialogTrigger asChild>
                  <Button
                    type="button"
                    variant="destructive"
                    disabled={
                      loading ||
                      saving ||
                      deletingConfig ||
                      config.updatedAt === 0
                    }
                  >
                    <AutoTransition className="inline-flex items-center gap-2">
                      {deletingConfig ? (
                        <span
                          key="deleting-config"
                          className="inline-flex items-center gap-2"
                        >
                          <Spinner className="size-4" />
                          {copy.deleting}
                        </span>
                      ) : (
                        <span
                          key="delete-config"
                          className="inline-flex items-center gap-2"
                        >
                          <RiDeleteBinLine className="size-4" />
                          {copy.delete}
                        </span>
                      )}
                    </AutoTransition>
                  </Button>
                </AlertDialogTrigger>
                <AlertDialogContent size="sm">
                  <AlertDialogHeader>
                    <AlertDialogTitle icon={RiDeleteBinLine}>
                      {copy.delete}
                    </AlertDialogTitle>
                    <AlertDialogDescription>
                      {copy.deleteConfirm}
                    </AlertDialogDescription>
                  </AlertDialogHeader>
                  <AlertDialogFooter>
                    <AlertDialogCancel disabled={deletingConfig}>
                      <RiCloseLine className="size-4" />
                      <span>{messages.teamSelect.cancel}</span>
                    </AlertDialogCancel>
                    <AlertDialogAction
                      variant="destructive"
                      disabled={deletingConfig}
                      onClick={(event) => {
                        event.preventDefault();
                        void handleDeleteConfig();
                      }}
                    >
                      <AutoTransition className="inline-flex items-center gap-2">
                        {deletingConfig ? (
                          <span
                            key="deleting-config-dialog"
                            className="inline-flex items-center gap-2"
                          >
                            <Spinner className="size-4" />
                            {copy.deleting}
                          </span>
                        ) : (
                          <span
                            key="confirm-delete-config"
                            className="inline-flex items-center gap-2"
                          >
                            <RiDeleteBinLine className="size-4" />
                            {copy.delete}
                          </span>
                        )}
                      </AutoTransition>
                    </AlertDialogAction>
                  </AlertDialogFooter>
                </AlertDialogContent>
              </AlertDialog>
              <SystemSettingsGuideDialog
                triggerLabel={copy.guide}
                title={copy.notificationEmailGuideTitle}
                description={copy.notificationEmailGuideDescription}
                steps={copy.notificationEmailGuideSteps}
              />
            </div>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
