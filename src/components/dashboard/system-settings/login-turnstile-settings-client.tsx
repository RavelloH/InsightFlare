import { useEffect, useMemo, useRef, useState } from "react";
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
} from "@insightflare/ui/alert-dialog";
import { AutoResizer } from "@insightflare/ui/auto-resizer";
import { AutoTransition } from "@insightflare/ui/auto-transition";
import { Badge } from "@insightflare/ui/badge";
import { Button } from "@insightflare/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@insightflare/ui/card";
import { Input } from "@insightflare/ui/input";
import { Label } from "@insightflare/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@insightflare/ui/select";
import { Spinner } from "@insightflare/ui/spinner";
import {
  RiCloseLine,
  RiDeleteBinLine,
  RiSave3Line,
  RiShieldCheckLine,
  RiTestTubeLine,
} from "@remixicon/react";
import { useQuery } from "@tanstack/react-query";
import { toast } from "sonner";

import { verifyTurnstile } from "@/components/auth/turnstile-client";
import {
  managementQueryOptions,
  type SystemSettingsInitialData,
} from "@/lib/dashboard/management-data";
import { requestAdminService } from "@/lib/dashboard-api/client/admin-service";
import type { AppMessages } from "@/lib/i18n/messages";

import { SystemSettingsGuideDialog } from "./system-settings-guide-dialog";
interface LoginTurnstileSettingsClientProps {
  messages: AppMessages;
  initialData?: SystemSettingsInitialData | null;
  userId?: string;
  deferredData?: Promise<Pick<
    SystemSettingsInitialData,
    "loginTurnstile" | "fetchedAt"
  > | null> | null;
}
interface PublicLoginTurnstileAdminConfig {
  enabled: boolean;
  siteKey: string;
  mode: "invisible";
  secretKeyConfigured: boolean;
  secretKeyHint: string;
  updatedAt: number;
}
type FormState = Pick<PublicLoginTurnstileAdminConfig, "enabled" | "siteKey">;
function defaultConfig(): PublicLoginTurnstileAdminConfig {
  return {
    enabled: false,
    siteKey: "",
    mode: "invisible",
    secretKeyConfigured: false,
    secretKeyHint: "",
    updatedAt: 0,
  };
}
function toFormState(config: PublicLoginTurnstileAdminConfig): FormState {
  return {
    enabled: config.enabled,
    siteKey: config.siteKey,
  };
}
async function fetchConfig(
  signal?: AbortSignal,
): Promise<PublicLoginTurnstileAdminConfig> {
  return requestAdminService<PublicLoginTurnstileAdminConfig>(
    "login-turnstile",
    { signal },
  );
}
async function saveConfig(
  body: Record<string, unknown>,
): Promise<PublicLoginTurnstileAdminConfig> {
  return requestAdminService<PublicLoginTurnstileAdminConfig>(
    "login-turnstile",
    { method: "PATCH", body },
  );
}
async function deleteConfig(): Promise<PublicLoginTurnstileAdminConfig> {
  return requestAdminService<PublicLoginTurnstileAdminConfig>(
    "login-turnstile",
    { method: "DELETE" },
  );
}
async function testConfig(body: {
  siteKey: string;
  secretKey: string;
  turnstileToken: string;
}): Promise<void> {
  await requestAdminService<{ verified: boolean }>("login-turnstile/test", {
    method: "POST",
    body,
  });
}
export function turnstileSettingsQueryOptions(
  userId: string,
  deferred?: Promise<Pick<
    SystemSettingsInitialData,
    "loginTurnstile" | "fetchedAt"
  > | null> | null,
  retainInFlight = false,
) {
  return managementQueryOptions(
    ["dashboard", "login-turnstile-config", userId],
    fetchConfig,
    (
      snapshot: Pick<SystemSettingsInitialData, "loginTurnstile" | "fetchedAt">,
    ) => snapshot.loginTurnstile,
    deferred,
    retainInFlight,
  );
}
export function LoginTurnstileSettingsClient({
  messages,
  initialData = null,
  userId = "",
  deferredData,
}: LoginTurnstileSettingsClientProps) {
  const copy = messages.systemSettings;
  const turnstileRef = useRef<HTMLDivElement | null>(null);
  const verificationRef = useRef<AbortController | null>(null);
  const [config, setConfig] = useState<PublicLoginTurnstileAdminConfig>(
    initialData?.loginTurnstile ?? defaultConfig(),
  );
  const [form, setForm] = useState<FormState>(() =>
    toFormState(initialData?.loginTurnstile ?? defaultConfig()),
  );
  const [secretKey, setSecretKey] = useState("");
  const [secretKeyDirty, setSecretKeyDirty] = useState(false);
  const [testedFingerprint, setTestedFingerprint] = useState("");
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [deletingConfig, setDeletingConfig] = useState(false);
  const configAppliedRef = useRef(Boolean(initialData?.loginTurnstile));
  const configQuery = useQuery({
    ...turnstileSettingsQueryOptions(userId, deferredData),
    initialData: initialData?.loginTurnstile,
    initialDataUpdatedAt: initialData?.fetchedAt,
    enabled: typeof window !== "undefined",
  });
  const [configApplied, setConfigApplied] = useState(
    Boolean(initialData?.loginTurnstile),
  );
  const loading = !configApplied && !configQuery.isError;
  const unavailable = !configApplied && configQuery.isError;
  const lockedUntilReady = !configApplied;

  const currentFingerprint = `${form.siteKey.trim()}::${secretKey.trim()}`;
  const newSecretTested =
    secretKey.trim().length === 0 || testedFingerprint === currentFingerprint;
  const canSaveEnabled =
    !form.enabled ||
    (form.siteKey.trim().length > 0 &&
      (secretKey.trim().length > 0 || config.secretKeyConfigured) &&
      newSecretTested);
  const hasChanges = useMemo(() => {
    const persisted = toFormState(config);
    return (
      form.enabled !== persisted.enabled ||
      form.siteKey !== persisted.siteKey ||
      secretKey.trim().length > 0
    );
  }, [config, form, secretKey]);
  const showSavedSecretKey =
    !secretKeyDirty &&
    config.secretKeyConfigured &&
    Boolean(config.secretKeyHint);
  const secretKeyDisplayValue = showSavedSecretKey
    ? config.secretKeyHint
    : secretKey;

  useEffect(() => {
    if (configQuery.isPending || configAppliedRef.current) return;
    if (configQuery.isError) toast.error(copy.loginTurnstileLoadFailed);
    if (!configQuery.data) return;
    const nextConfig = configQuery.data;
    setConfig(nextConfig);
    setForm(toFormState(nextConfig));
    configAppliedRef.current = true;
    setConfigApplied(true);
  }, [
    configQuery.data,
    configQuery.isError,
    configQuery.isPending,
    copy.loginTurnstileLoadFailed,
  ]);

  useEffect(() => () => verificationRef.current?.abort(), []);

  function updateForm<K extends keyof FormState>(key: K, value: FormState[K]) {
    setForm((current) => ({ ...current, [key]: value }));
    setTestedFingerprint("");
  }

  async function handleTest() {
    if (lockedUntilReady || verificationRef.current) return;
    const siteKey = form.siteKey.trim();
    const nextSecretKey = secretKey.trim();
    if (!siteKey || !nextSecretKey) {
      toast.error(copy.loginTurnstileTestMissing);
      return;
    }
    const controller = new AbortController();
    verificationRef.current = controller;
    setTesting(true);
    try {
      const container = turnstileRef.current;
      if (!container) throw new Error("turnstile_unavailable");
      const turnstileToken = await verifyTurnstile(
        container,
        siteKey,
        controller.signal,
      );
      controller.signal.throwIfAborted();
      await testConfig({ siteKey, secretKey: nextSecretKey, turnstileToken });
      if (controller.signal.aborted) return;
      setTestedFingerprint(`${siteKey}::${nextSecretKey}`);
      toast.success(copy.loginTurnstileTestPassed);
    } catch {
      if (controller.signal.aborted) return;
      setTestedFingerprint("");
      toast.error(copy.loginTurnstileTestFailed);
    } finally {
      verificationRef.current = null;
      if (!controller.signal.aborted) setTesting(false);
    }
  }

  async function handleSave() {
    if (lockedUntilReady) return;
    const body: Record<string, unknown> = {
      enabled: form.enabled,
      siteKey: form.siteKey.trim(),
    };
    const nextSecretKey = secretKey.trim();
    if (nextSecretKey) body.secretKey = nextSecretKey;

    setSaving(true);
    try {
      const saved = await saveConfig(body);
      setConfig(saved);
      setForm(toFormState(saved));
      setSecretKey("");
      setSecretKeyDirty(false);
      setTestedFingerprint("");
      toast.success(copy.loginTurnstileSaved);
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : copy.loginTurnstileSaveFailed,
      );
    } finally {
      setSaving(false);
    }
  }

  async function handleDeleteConfig() {
    if (lockedUntilReady) return;
    setDeletingConfig(true);
    try {
      const reset = await deleteConfig();
      setConfig(reset);
      setForm(toFormState(reset));
      setSecretKey("");
      setSecretKeyDirty(false);
      setTestedFingerprint("");
      setDeleteDialogOpen(false);
      toast.success(copy.loginTurnstileDeleted);
    } catch (error) {
      toast.error(
        error instanceof Error
          ? error.message
          : copy.loginTurnstileDeleteFailed,
      );
    } finally {
      setDeletingConfig(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <RiShieldCheckLine className="size-4" />
          {copy.loginTurnstileTitle}
        </CardTitle>
        <CardDescription>{copy.loginTurnstileDescription}</CardDescription>
      </CardHeader>
      <CardContent>
        <AutoResizer initial={false}>
          <AutoTransition
            initial={false}
            duration={0.2}
            transitionKey={
              loading ? "loading" : unavailable ? "error" : "ready"
            }
          >
            {loading ? (
              <div className="flex h-28 items-center justify-center">
                <Spinner
                  className="size-6"
                  aria-label={messages.common.loading}
                />
              </div>
            ) : unavailable ? (
              <div
                role="alert"
                className="flex h-28 flex-col items-center justify-center gap-2 text-sm text-muted-foreground"
              >
                {copy.loginTurnstileLoadFailed}
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => void configQuery.refetch()}
                >
                  {messages.notificationCenter.refresh}
                </Button>
              </div>
            ) : (
              <form
                className="grid gap-5"
                onSubmit={(event) => {
                  event.preventDefault();
                  void handleSave();
                }}
              >
                <div className="grid gap-4 md:grid-cols-2">
                  <div className="space-y-2">
                    <Label htmlFor="system-login-turnstile-enabled">
                      {copy.loginTurnstileEnabledLabel}
                    </Label>
                    <Select
                      value={form.enabled ? "true" : "false"}
                      onValueChange={(value) =>
                        updateForm("enabled", value === "true")
                      }
                      disabled={loading || saving}
                    >
                      <SelectTrigger
                        id="system-login-turnstile-enabled"
                        className="w-full"
                      >
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="true">{copy.enabledOn}</SelectItem>
                        <SelectItem value="false">{copy.enabledOff}</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>

                  <div className="space-y-2">
                    <Label htmlFor="system-login-turnstile-mode">
                      {copy.loginTurnstileModeLabel}
                    </Label>
                    <Input
                      id="system-login-turnstile-mode"
                      value={copy.loginTurnstileModeInvisible}
                      disabled
                      readOnly
                    />
                  </div>

                  <div className="space-y-2">
                    <Label htmlFor="system-login-turnstile-site-key">
                      {copy.loginTurnstileSiteKeyLabel}
                    </Label>
                    <Input
                      id="system-login-turnstile-site-key"
                      value={form.siteKey}
                      maxLength={256}
                      disabled={loading || saving}
                      onChange={(event) =>
                        updateForm("siteKey", event.target.value)
                      }
                    />
                  </div>

                  <div className="space-y-2">
                    <Label htmlFor="system-login-turnstile-secret-key">
                      {copy.loginTurnstileSecretKeyLabel}
                    </Label>
                    <Input
                      id="system-login-turnstile-secret-key"
                      type={showSavedSecretKey ? "text" : "password"}
                      value={secretKeyDisplayValue}
                      placeholder={copy.loginTurnstileSecretKeyPlaceholder}
                      disabled={loading || saving || deletingConfig}
                      onFocus={() => {
                        if (!showSavedSecretKey) return;
                        setSecretKeyDirty(true);
                        setSecretKey("");
                      }}
                      onBlur={() => {
                        if (!secretKey.trim()) setSecretKeyDirty(false);
                      }}
                      onChange={(event) => {
                        setSecretKeyDirty(true);
                        setSecretKey(event.target.value);
                        setTestedFingerprint("");
                      }}
                    />
                  </div>
                </div>

                <div className="grid gap-3 border-t pt-4 md:grid-cols-[minmax(0,1fr)_auto] md:items-end">
                  <div className="space-y-2">
                    <div className="flex flex-wrap items-center gap-2">
                      {secretKey.trim() ? (
                        <Badge
                          variant={newSecretTested ? "default" : "secondary"}
                        >
                          {newSecretTested
                            ? copy.loginTurnstileTestPassed
                            : copy.loginTurnstileTestRequired}
                        </Badge>
                      ) : null}
                    </div>
                    <p className="text-xs/relaxed text-muted-foreground">
                      {copy.loginTurnstilePrivacyNotice}
                    </p>
                  </div>
                  <Button
                    type="button"
                    variant="outline"
                    disabled={loading || saving || testing || !secretKey.trim()}
                    onClick={() => {
                      void handleTest();
                    }}
                  >
                    <AutoTransition className="inline-flex items-center gap-[var(--button-content-gap)]">
                      {testing ? (
                        <span
                          key="testing"
                          className="inline-flex items-center gap-[var(--button-content-gap)]"
                        >
                          <Spinner data-icon="inline-start" />
                          {copy.loginTurnstileTesting}
                        </span>
                      ) : (
                        <span
                          key="test"
                          className="inline-flex items-center gap-[var(--button-content-gap)]"
                        >
                          <RiTestTubeLine data-icon="inline-start" />
                          {copy.loginTurnstileTest}
                        </span>
                      )}
                    </AutoTransition>
                  </Button>
                </div>

                <div ref={turnstileRef} className="hidden" aria-hidden="true" />

                <div className="flex flex-wrap gap-2">
                  <Button
                    type="submit"
                    disabled={
                      loading || saving || !hasChanges || !canSaveEnabled
                    }
                  >
                    <AutoTransition className="inline-flex items-center gap-[var(--button-content-gap)]">
                      {saving ? (
                        <span
                          key="saving"
                          className="inline-flex items-center gap-[var(--button-content-gap)]"
                        >
                          <Spinner data-icon="inline-start" />
                          {copy.saving}
                        </span>
                      ) : (
                        <span
                          key="save"
                          className="inline-flex items-center gap-[var(--button-content-gap)]"
                        >
                          <RiSave3Line data-icon="inline-start" />
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
                        <AutoTransition className="inline-flex items-center gap-[var(--button-content-gap)]">
                          {deletingConfig ? (
                            <span
                              key="deleting-config"
                              className="inline-flex items-center gap-[var(--button-content-gap)]"
                            >
                              <Spinner data-icon="inline-start" />
                              {copy.deleting}
                            </span>
                          ) : (
                            <span
                              key="delete-config"
                              className="inline-flex items-center gap-[var(--button-content-gap)]"
                            >
                              <RiDeleteBinLine data-icon="inline-start" />
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
                          {copy.loginTurnstileDeleteConfirm}
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
                    title={copy.loginTurnstileGuideTitle}
                    description={copy.loginTurnstileGuideDescription}
                    steps={copy.loginTurnstileGuideSteps}
                  />
                </div>
              </form>
            )}
          </AutoTransition>
        </AutoResizer>
      </CardContent>
    </Card>
  );
}
