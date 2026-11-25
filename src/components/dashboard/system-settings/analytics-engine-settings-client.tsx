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
import { Spinner } from "@insightflare/ui/spinner";
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
  EVENT_ANALYTICS_DATASET,
  type PublicAnalyticsEngineConfig,
  REQUEST_ANALYTICS_DATASET,
  TRAFFIC_ANALYTICS_DATASET,
} from "@/lib/analytics-engine-config";
import {
  managementQueryOptions,
  type SystemSettingsInitialData,
} from "@/lib/dashboard/management-data";
import { requestAdminService } from "@/lib/dashboard-api/client/admin-service";
import type { AppMessages } from "@/lib/i18n/messages";
import { cn } from "@/lib/utils";

import { SystemSettingsGuideDialog } from "./system-settings-guide-dialog";
interface AnalyticsEngineSettingsClientProps {
  messages: AppMessages;
  initialData?: SystemSettingsInitialData | null;
  userId?: string;
  deferredData?: Promise<Pick<
    SystemSettingsInitialData,
    "analyticsEngine" | "fetchedAt"
  > | null> | null;
}
type FormState = Pick<PublicAnalyticsEngineConfig, "accountId">;
function defaultConfig(): PublicAnalyticsEngineConfig {
  return {
    accountId: "",
    analyticsEngineDisabled: false,
    managedByEnvironment: false,
    analyticsEngineEnableUrl: "",
    requestDataset: REQUEST_ANALYTICS_DATASET,
    trafficDataset: TRAFFIC_ANALYTICS_DATASET,
    eventDataset: EVENT_ANALYTICS_DATASET,
    apiTokenConfigured: false,
    apiTokenHint: "",
    updatedAt: 0,
  };
}
function toFormState(config: PublicAnalyticsEngineConfig): FormState {
  return {
    accountId: config.accountId,
  };
}
async function fetchConfig(
  signal?: AbortSignal,
): Promise<PublicAnalyticsEngineConfig> {
  return requestAdminService<PublicAnalyticsEngineConfig>(
    "analytics-engine-config",
    {
      signal,
    },
  );
}
async function saveConfig(
  body: Record<string, unknown>,
): Promise<PublicAnalyticsEngineConfig> {
  return requestAdminService<PublicAnalyticsEngineConfig>(
    "analytics-engine-config",
    {
      method: "PATCH",
      body,
    },
  );
}
async function deleteConfig(): Promise<PublicAnalyticsEngineConfig> {
  return requestAdminService<PublicAnalyticsEngineConfig>(
    "analytics-engine-config",
    {
      method: "DELETE",
    },
  );
}
export function analyticsEngineSettingsQueryOptions(
  userId: string,
  deferred?: Promise<Pick<
    SystemSettingsInitialData,
    "analyticsEngine" | "fetchedAt"
  > | null> | null,
  retainInFlight = false,
) {
  return managementQueryOptions(
    ["dashboard", "analytics-engine-config", userId],
    fetchConfig,
    (
      snapshot: Pick<
        SystemSettingsInitialData,
        "analyticsEngine" | "fetchedAt"
      >,
    ) => snapshot.analyticsEngine,
    deferred,
    retainInFlight,
  );
}
export function AnalyticsEngineSettingsClient({
  messages,
  initialData = null,
  userId = "",
  deferredData,
}: AnalyticsEngineSettingsClientProps) {
  const copy = messages.systemSettings;
  const [config, setConfig] = useState<PublicAnalyticsEngineConfig>(
    initialData?.analyticsEngine ?? defaultConfig(),
  );
  const [form, setForm] = useState<FormState>(() => toFormState(config));
  const [apiToken, setApiToken] = useState("");
  const [apiTokenDirty, setApiTokenDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);
  // The route already provides the SSR snapshot. Mark it as applied up front
  // so a background refetch cannot reset a user's input during hydration.
  const configAppliedRef = useRef(Boolean(initialData?.analyticsEngine));
  const configQuery = useQuery({
    ...analyticsEngineSettingsQueryOptions(userId, deferredData),
    initialData: initialData?.analyticsEngine,
    initialDataUpdatedAt: initialData?.fetchedAt,
    enabled: typeof window !== "undefined",
  });
  const [configApplied, setConfigApplied] = useState(
    Boolean(initialData?.analyticsEngine),
  );
  const loading = !configApplied && !configQuery.isError;
  const unavailable = !configApplied && configQuery.isError;
  const lockedUntilReady = !configApplied;
  const analyticsEngineDisabled = config.analyticsEngineDisabled;
  // Deployment-managed reader (INSIGHTFLARE_AE_* Worker variables): shown, not editable.
  const managedByEnvironment = config.managedByEnvironment;
  const locked =
    lockedUntilReady || analyticsEngineDisabled || managedByEnvironment;
  const showSavedApiToken =
    !apiTokenDirty && config.apiTokenConfigured && Boolean(config.apiTokenHint);
  const apiTokenDisplayValue = showSavedApiToken
    ? config.apiTokenHint
    : apiToken;
  const apiTokenPlaceholder = analyticsEngineDisabled
    ? copy.analyticsEngineDisabledHint
    : copy.analyticsEngineApiTokenPlaceholder;

  useEffect(() => {
    if (configQuery.isPending || configAppliedRef.current) return;
    if (configQuery.isError) {
      toast.error(
        configQuery.error instanceof Error
          ? configQuery.error.message
          : copy.loadFailed,
      );
    }
    if (!configQuery.data) return;
    const next = configQuery.data;
    setConfig(next);
    setForm(toFormState(next));
    configAppliedRef.current = true;
    setConfigApplied(true);
  }, [
    copy.loadFailed,
    configQuery.data,
    configQuery.error,
    configQuery.isError,
    configQuery.isPending,
  ]);

  const hasChanges = useMemo(
    () =>
      !locked &&
      (form.accountId !== config.accountId || apiToken.trim().length > 0),
    [locked, apiToken, config, form],
  );

  async function handleSave() {
    if (lockedUntilReady) return;
    if (locked) return;
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
      toast.success(copy.analyticsEngineSaved);
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : copy.analyticsEngineSaveFailed,
      );
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete() {
    if (lockedUntilReady) return;
    if (locked) return;
    setDeleting(true);
    try {
      const next = await deleteConfig();
      setConfig(next);
      setForm(toFormState(next));
      setApiToken("");
      setApiTokenDirty(false);
      setDeleteDialogOpen(false);
      toast.success(copy.analyticsEngineDeleted);
    } catch (error) {
      toast.error(
        error instanceof Error
          ? error.message
          : copy.analyticsEngineDeleteFailed,
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
              <span className="truncate">{copy.analyticsEngineTitle}</span>
            </CardTitle>
            <CardDescription>{copy.analyticsEngineDescription}</CardDescription>
          </div>
        </div>
      </CardHeader>
      <CardContent>
        <AutoResizer initial={false} duration={0.24}>
          <AutoTransition
            initial={false}
            transitionKey={
              loading ? "loading" : unavailable ? "error" : "ready"
            }
            type="fade"
            duration={0.2}
          >
            {loading ? (
              <div className="flex h-28 items-center justify-center">
                <Spinner className="size-6" />
              </div>
            ) : unavailable ? (
              <div
                role="alert"
                className="flex h-28 flex-col items-center justify-center gap-2 text-sm text-muted-foreground"
              >
                {copy.loadFailed}
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
              <div className="grid gap-5 lg:grid-cols-[1fr_1fr]">
                {analyticsEngineDisabled ? (
                  <div className="border border-dashed bg-muted/40 p-4 text-sm text-muted-foreground lg:col-span-2">
                    <p className="font-medium text-foreground">
                      {copy.analyticsEngineDisabledTitle}
                    </p>
                    <p className="mt-1">
                      {copy.analyticsEngineDisabledDescription}
                    </p>
                    <Button asChild className="mt-3" variant="outline">
                      <a
                        href={config.analyticsEngineEnableUrl}
                        target="_blank"
                        rel="noreferrer"
                      >
                        <RiExternalLinkLine data-icon="inline-start" />
                        {copy.analyticsEngineOpenCloudflare}
                      </a>
                    </Button>
                  </div>
                ) : null}
                {managedByEnvironment && !analyticsEngineDisabled ? (
                  <div className="border border-dashed bg-muted/40 p-4 text-sm text-muted-foreground lg:col-span-2">
                    <p className="font-medium text-foreground">
                      {copy.analyticsEngineManagedTitle}
                    </p>
                    <p className="mt-1">
                      {copy.analyticsEngineManagedDescription}
                    </p>
                  </div>
                ) : null}
                <div className="space-y-2">
                  <Label htmlFor="analytics-engine-account-id">
                    {copy.analyticsEngineAccountIdLabel}
                  </Label>
                  <Input
                    id="analytics-engine-account-id"
                    value={form.accountId}
                    disabled={locked}
                    onChange={(event) =>
                      setForm((current) => ({
                        ...current,
                        accountId: event.target.value,
                      }))
                    }
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="analytics-engine-api-token">
                    {copy.analyticsEngineApiTokenLabel}
                  </Label>
                  <Input
                    id="analytics-engine-api-token"
                    type={showSavedApiToken ? "text" : "password"}
                    value={apiTokenDisplayValue}
                    disabled={locked}
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
                    disabled={locked || saving || deleting || !hasChanges}
                  >
                    {saving ? <Spinner /> : <RiSave3Line />}
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
                          locked ||
                          loading ||
                          saving ||
                          deleting ||
                          config.updatedAt === 0
                        }
                      >
                        {deleting ? <Spinner /> : <RiDeleteBinLine />}
                        {deleting ? copy.deleting : copy.delete}
                      </Button>
                    </AlertDialogTrigger>
                    <AlertDialogContent size="sm">
                      <AlertDialogHeader>
                        <AlertDialogTitle icon={RiDeleteBinLine}>
                          {copy.analyticsEngineTitle}
                        </AlertDialogTitle>
                        <AlertDialogDescription>
                          {copy.analyticsEngineDeleteConfirm}
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
                    title={copy.analyticsEngineGuideTitle}
                    description={copy.analyticsEngineGuideDescription}
                    steps={copy.analyticsEngineGuideSteps}
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
