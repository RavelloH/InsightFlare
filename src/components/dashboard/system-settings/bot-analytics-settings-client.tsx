import { useEffect, useMemo, useRef, useState } from "react";
import {
  RiCloseLine,
  RiDeleteBinLine,
  RiExternalLinkLine,
  RiLineChartLine,
  RiSave3Line,
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
import { AutoResizer } from "@/components/ui/auto-resizer";
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
import { Spinner } from "@/components/ui/spinner";
import { requestAdminService } from "@/lib/admin-service-client";
import type { PublicBotAnalyticsConfig } from "@/lib/bot-analytics-config";
import type { AppMessages } from "@/lib/i18n/messages";
import { cn } from "@/lib/utils";

import { SystemSettingsGuideDialog } from "./system-settings-guide-dialog";

interface BotAnalyticsSettingsClientProps {
  messages: AppMessages;
}

type FormState = Pick<PublicBotAnalyticsConfig, "accountId">;

function defaultConfig(): PublicBotAnalyticsConfig {
  return {
    accountId: "",
    analyticsEngineDisabled: false,
    analyticsEngineEnableUrl: "",
    dataset: "insightflare_bot_events",
    normalDataset: "insightflare_normal_events",
    apiTokenConfigured: false,
    apiTokenHint: "",
    updatedAt: 0,
  };
}

function toFormState(config: PublicBotAnalyticsConfig): FormState {
  return {
    accountId: config.accountId,
  };
}

async function fetchConfig(
  signal?: AbortSignal,
): Promise<PublicBotAnalyticsConfig> {
  return requestAdminService<PublicBotAnalyticsConfig>("bot-analytics-config", {
    signal,
  });
}

async function saveConfig(
  body: Record<string, unknown>,
): Promise<PublicBotAnalyticsConfig> {
  return requestAdminService<PublicBotAnalyticsConfig>("bot-analytics-config", {
    method: "PATCH",
    body,
  });
}

async function deleteConfig(): Promise<PublicBotAnalyticsConfig> {
  return requestAdminService<PublicBotAnalyticsConfig>("bot-analytics-config", {
    method: "DELETE",
  });
}

export function BotAnalyticsSettingsClient({
  messages,
}: BotAnalyticsSettingsClientProps) {
  const copy = messages.systemSettings;
  const [config, setConfig] = useState<PublicBotAnalyticsConfig>(defaultConfig);
  const [form, setForm] = useState<FormState>(() => toFormState(config));
  const [apiToken, setApiToken] = useState("");
  const [apiTokenDirty, setApiTokenDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const configAppliedRef = useRef(false);
  const configQuery = useQuery({
    queryKey: ["dashboard", "bot-analytics-config"],
    queryFn: ({ signal }) => fetchConfig(signal),
    enabled: typeof window !== "undefined",
  });
  const loading = configQuery.isPending;
  const analyticsEngineDisabled = config.analyticsEngineDisabled;
  const showSavedApiToken =
    !apiTokenDirty && config.apiTokenConfigured && Boolean(config.apiTokenHint);
  const apiTokenDisplayValue = showSavedApiToken
    ? config.apiTokenHint
    : apiToken;
  const apiTokenPlaceholder = analyticsEngineDisabled
    ? copy.botAnalyticsEngineDisabledHint
    : copy.botAnalyticsApiTokenPlaceholder;

  useEffect(() => {
    if (configQuery.isPending || configAppliedRef.current) return;
    if (configQuery.isError) {
      toast.error(
        configQuery.error instanceof Error
          ? configQuery.error.message
          : copy.loadFailed,
      );
    }
    const next = configQuery.data ?? defaultConfig();
    setConfig(next);
    setForm(toFormState(next));
    configAppliedRef.current = true;
  }, [
    copy.loadFailed,
    configQuery.data,
    configQuery.error,
    configQuery.isError,
    configQuery.isPending,
  ]);

  const hasChanges = useMemo(
    () =>
      !analyticsEngineDisabled &&
      (form.accountId !== config.accountId || apiToken.trim().length > 0),
    [analyticsEngineDisabled, apiToken, config, form],
  );

  async function handleSave() {
    if (analyticsEngineDisabled) return;
    setSaving(true);
    try {
      const next = await saveConfig({
        accountId: form.accountId.trim(),
        apiToken: apiToken.trim() || undefined,
      });
      setConfig(next);
      setForm(toFormState(next));
      setApiToken("");
      setApiTokenDirty(false);
      toast.success(copy.botAnalyticsSaved);
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : copy.botAnalyticsSaveFailed,
      );
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete() {
    if (analyticsEngineDisabled) return;
    setDeleting(true);
    try {
      const next = await deleteConfig();
      setConfig(next);
      setForm(toFormState(next));
      setApiToken("");
      setApiTokenDirty(false);
      setDeleteDialogOpen(false);
      toast.success(copy.botAnalyticsDeleted);
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : copy.botAnalyticsDeleteFailed,
      );
    } finally {
      setDeleting(false);
    }
  }

  return (
    <Card
      className={cn("overflow-hidden", analyticsEngineDisabled && "opacity-75")}
    >
      <CardHeader>
        <div className="flex min-w-0 items-start justify-between gap-3">
          <div className="min-w-0">
            <CardTitle className="flex min-w-0 items-center gap-2">
              <RiLineChartLine className="size-4 shrink-0" />
              <span className="truncate">{copy.botAnalyticsTitle}</span>
            </CardTitle>
            <CardDescription>{copy.botAnalyticsDescription}</CardDescription>
          </div>
        </div>
      </CardHeader>
      <CardContent>
        <AutoResizer initial duration={0.24}>
          <AutoTransition
            transitionKey={loading ? "loading" : "ready"}
            type="fade"
            duration={0.2}
          >
            {loading ? (
              <div className="flex h-28 items-center justify-center">
                <Spinner className="size-6" />
              </div>
            ) : (
              <div className="grid gap-5 lg:grid-cols-[1fr_1fr]">
                {analyticsEngineDisabled ? (
                  <div className="border border-dashed bg-muted/40 p-4 text-sm text-muted-foreground lg:col-span-2">
                    <p className="font-medium text-foreground">
                      {copy.botAnalyticsEngineDisabledTitle}
                    </p>
                    <p className="mt-1">
                      {copy.botAnalyticsEngineDisabledDescription}
                    </p>
                    <Button asChild className="mt-3" variant="outline">
                      <a
                        href={config.analyticsEngineEnableUrl}
                        target="_blank"
                        rel="noreferrer"
                      >
                        <RiExternalLinkLine className="size-4" />
                        {copy.botAnalyticsOpenCloudflare}
                      </a>
                    </Button>
                  </div>
                ) : null}
                <div className="space-y-2">
                  <Label htmlFor="bot-analytics-account-id">
                    {copy.botAnalyticsAccountIdLabel}
                  </Label>
                  <Input
                    id="bot-analytics-account-id"
                    value={form.accountId}
                    disabled={analyticsEngineDisabled}
                    onChange={(event) =>
                      setForm((current) => ({
                        ...current,
                        accountId: event.target.value,
                      }))
                    }
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="bot-analytics-api-token">
                    {copy.botAnalyticsApiTokenLabel}
                  </Label>
                  <Input
                    id="bot-analytics-api-token"
                    type={showSavedApiToken ? "text" : "password"}
                    value={apiTokenDisplayValue}
                    disabled={analyticsEngineDisabled}
                    placeholder={apiTokenPlaceholder}
                    onFocus={() => {
                      if (!showSavedApiToken) return;
                      setApiTokenDirty(true);
                      setApiToken("");
                    }}
                    onBlur={() => {
                      if (!apiToken.trim()) setApiTokenDirty(false);
                    }}
                    onChange={(event) => {
                      setApiTokenDirty(true);
                      setApiToken(event.target.value);
                    }}
                  />
                </div>
                <div className="flex flex-wrap items-center gap-2 lg:col-span-2">
                  <Button
                    type="button"
                    onClick={handleSave}
                    disabled={
                      analyticsEngineDisabled ||
                      saving ||
                      deleting ||
                      !hasChanges
                    }
                  >
                    {saving ? (
                      <Spinner className="size-4" />
                    ) : (
                      <RiSave3Line className="size-4" />
                    )}
                    {saving ? copy.saving : copy.save}
                  </Button>
                  <AlertDialog
                    open={deleteDialogOpen}
                    onOpenChange={(open) => {
                      if (deleting) return;
                      setDeleteDialogOpen(open);
                    }}
                  >
                    <AlertDialogTrigger asChild>
                      <Button
                        type="button"
                        variant="destructive"
                        disabled={
                          analyticsEngineDisabled ||
                          loading ||
                          saving ||
                          deleting ||
                          config.updatedAt === 0
                        }
                      >
                        {deleting ? (
                          <Spinner className="size-4" />
                        ) : (
                          <RiDeleteBinLine className="size-4" />
                        )}
                        {deleting ? copy.deleting : copy.delete}
                      </Button>
                    </AlertDialogTrigger>
                    <AlertDialogContent size="sm">
                      <AlertDialogHeader>
                        <AlertDialogTitle icon={RiDeleteBinLine}>
                          {copy.botAnalyticsTitle}
                        </AlertDialogTitle>
                        <AlertDialogDescription>
                          {copy.botAnalyticsDeleteConfirm}
                        </AlertDialogDescription>
                      </AlertDialogHeader>
                      <AlertDialogFooter>
                        <AlertDialogCancel disabled={deleting}>
                          <RiCloseLine className="size-4" />
                          <span>{copy.cancel}</span>
                        </AlertDialogCancel>
                        <AlertDialogAction
                          variant="destructive"
                          disabled={deleting}
                          onClick={(event) => {
                            event.preventDefault();
                            void handleDelete();
                          }}
                        >
                          {deleting ? (
                            <Spinner className="size-4" />
                          ) : (
                            <RiDeleteBinLine className="size-4" />
                          )}
                          {deleting ? copy.deleting : copy.delete}
                        </AlertDialogAction>
                      </AlertDialogFooter>
                    </AlertDialogContent>
                  </AlertDialog>
                  <SystemSettingsGuideDialog
                    triggerLabel={copy.guide}
                    title={copy.botAnalyticsGuideTitle}
                    description={copy.botAnalyticsGuideDescription}
                    steps={copy.botAnalyticsGuideSteps}
                  />
                </div>
              </div>
            )}
          </AutoTransition>
        </AutoResizer>
      </CardContent>
    </Card>
  );
}
