import { useEffect, useMemo, useRef, useState } from "react";
import {
  RiCloseLine,
  RiDeleteBinLine,
  RiSave3Line,
  RiShieldCheckLine,
  RiTestTubeLine,
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
import { Badge } from "@/components/ui/badge";
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
import type { SystemSettingsInitialData } from "@/lib/dashboard/management-data";
import type { AppMessages } from "@/lib/i18n/messages";

import { SystemSettingsGuideDialog } from "./system-settings-guide-dialog";

interface LoginTurnstileSettingsClientProps {
  messages: AppMessages;
  initialData?: SystemSettingsInitialData | null;
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

interface TurnstileApi {
  render: (
    container: HTMLElement,
    options: {
      sitekey: string;
      size: "invisible";
      callback: (token: string) => void;
      "error-callback": () => void;
      "expired-callback": () => void;
    },
  ) => string;
  execute: (widgetId: string) => void;
  reset: (widgetId: string) => void;
  remove?: (widgetId: string) => void;
}

declare global {
  interface Window {
    turnstile?: TurnstileApi;
  }
}

const TURNSTILE_SCRIPT_ID = "cloudflare-turnstile-script";
let turnstileScriptPromise: Promise<void> | null = null;

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

function loadTurnstileScript(): Promise<void> {
  if (window.turnstile) return Promise.resolve();
  if (turnstileScriptPromise) return turnstileScriptPromise;

  turnstileScriptPromise = new Promise((resolve, reject) => {
    const existing = document.getElementById(
      TURNSTILE_SCRIPT_ID,
    ) as HTMLScriptElement | null;
    if (existing) {
      existing.addEventListener("load", () => resolve(), { once: true });
      existing.addEventListener("error", () => reject(new Error("load")), {
        once: true,
      });
      return;
    }

    const script = document.createElement("script");
    script.id = TURNSTILE_SCRIPT_ID;
    script.src =
      "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";
    script.async = true;
    script.defer = true;
    script.addEventListener("load", () => resolve(), { once: true });
    script.addEventListener("error", () => reject(new Error("load")), {
      once: true,
    });
    document.head.appendChild(script);
  });

  return turnstileScriptPromise;
}

export function LoginTurnstileSettingsClient({
  messages,
  initialData = null,
}: LoginTurnstileSettingsClientProps) {
  const copy = messages.systemSettings;
  const turnstileRef = useRef<HTMLDivElement | null>(null);
  const widgetIdRef = useRef<string | null>(null);
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
  const configAppliedRef = useRef(false);
  const configQuery = useQuery({
    queryKey: ["dashboard", "login-turnstile-config"],
    queryFn: ({ signal }) => fetchConfig(signal),
    initialData: initialData?.loginTurnstile,
    initialDataUpdatedAt: initialData?.fetchedAt,
    enabled: typeof window !== "undefined",
  });
  const loading = configQuery.isPending;

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
    const nextConfig = configQuery.data ?? defaultConfig();
    setConfig(nextConfig);
    setForm(toFormState(nextConfig));
    configAppliedRef.current = true;
  }, [
    configQuery.data,
    configQuery.isError,
    configQuery.isPending,
    copy.loginTurnstileLoadFailed,
  ]);

  useEffect(() => {
    return () => {
      const widgetId = widgetIdRef.current;
      if (widgetId && window.turnstile?.remove) {
        window.turnstile.remove(widgetId);
      }
    };
  }, []);

  function updateForm<K extends keyof FormState>(key: K, value: FormState[K]) {
    setForm((current) => ({ ...current, [key]: value }));
    setTestedFingerprint("");
  }

  async function executeTestTurnstile(siteKey: string): Promise<string> {
    await loadTurnstileScript();
    return new Promise((resolve, reject) => {
      const container = turnstileRef.current;
      const turnstile = window.turnstile;
      if (!container || !turnstile) {
        reject(new Error("turnstile_unavailable"));
        return;
      }
      if (widgetIdRef.current) {
        turnstile.remove?.(widgetIdRef.current);
        widgetIdRef.current = null;
      }
      widgetIdRef.current = turnstile.render(container, {
        sitekey: siteKey,
        size: "invisible",
        callback: (token) => resolve(token),
        "error-callback": () => reject(new Error("turnstile_error")),
        "expired-callback": () => reject(new Error("turnstile_expired")),
      });
      turnstile.execute(widgetIdRef.current);
    });
  }

  async function handleTest() {
    const siteKey = form.siteKey.trim();
    const nextSecretKey = secretKey.trim();
    if (!siteKey || !nextSecretKey) {
      toast.error(copy.loginTurnstileTestMissing);
      return;
    }
    setTesting(true);
    try {
      const turnstileToken = await executeTestTurnstile(siteKey);
      await testConfig({ siteKey, secretKey: nextSecretKey, turnstileToken });
      setTestedFingerprint(`${siteKey}::${nextSecretKey}`);
      toast.success(copy.loginTurnstileTestPassed);
    } catch {
      setTestedFingerprint("");
      toast.error(copy.loginTurnstileTestFailed);
    } finally {
      setTesting(false);
    }
  }

  async function handleSave() {
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
                onChange={(event) => updateForm("siteKey", event.target.value)}
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
                  <Badge variant={newSecretTested ? "default" : "secondary"}>
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
              <AutoTransition className="inline-flex items-center gap-2">
                {testing ? (
                  <span
                    key="testing"
                    className="inline-flex items-center gap-2"
                  >
                    <Spinner className="size-4" />
                    {copy.loginTurnstileTesting}
                  </span>
                ) : (
                  <span key="test" className="inline-flex items-center gap-2">
                    <RiTestTubeLine className="size-4" />
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
              disabled={loading || saving || !hasChanges || !canSaveEnabled}
            >
              <AutoTransition className="inline-flex items-center gap-2">
                {saving ? (
                  <span key="saving" className="inline-flex items-center gap-2">
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
      </CardContent>
    </Card>
  );
}
