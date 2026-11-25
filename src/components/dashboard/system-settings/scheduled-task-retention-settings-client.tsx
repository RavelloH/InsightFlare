import { useEffect, useMemo, useState } from "react";
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
import { RiDatabase2Line, RiSave3Line } from "@remixicon/react";
import { useQuery } from "@tanstack/react-query";
import { toast } from "sonner";

import {
  managementQueryOptions,
  type SystemSettingsInitialData,
} from "@/lib/dashboard/management-data";
import { requestAdminService } from "@/lib/dashboard-api/client/admin-service";
import type { AppMessages } from "@/lib/i18n/messages";
import type {
  ScheduledTaskRetentionConfig,
  ScheduledTasksData,
} from "@/lib/scheduled-tasks";
interface ScheduledTaskRetentionSettingsClientProps {
  messages: AppMessages;
  initialData?: SystemSettingsInitialData | null;
  userId?: string;
  deferredData?: Promise<Pick<
    SystemSettingsInitialData,
    "scheduledTaskRetention" | "fetchedAt"
  > | null> | null;
}
const FIELDS: Array<{
  key: keyof ScheduledTaskRetentionConfig;
  label: keyof AppMessages["systemSettings"];
}> = [
  { key: "scheduledTaskLogsDays", label: "scheduledTaskLogsDaysLabel" },
  { key: "notificationTestDays", label: "notificationTestDaysLabel" },
  {
    key: "notificationAttentionDays",
    label: "notificationAttentionDaysLabel",
  },
  {
    key: "notificationDefaultDays",
    label: "notificationDefaultDaysLabel",
  },
];
const DEFAULTS: ScheduledTaskRetentionConfig = {
  scheduledTaskLogsDays: 30,
  notificationTestDays: 30,
  notificationAttentionDays: 180,
  notificationDefaultDays: 120,
};
export function retentionSettingsQueryOptions(
  userId: string,
  deferred?: Promise<Pick<
    SystemSettingsInitialData,
    "scheduledTaskRetention" | "fetchedAt"
  > | null> | null,
  retainInFlight = false,
) {
  return managementQueryOptions(
    ["dashboard", "scheduled-task-retention", userId],
    async (signal) =>
      (
        await requestAdminService<ScheduledTasksData>("scheduled-tasks", {
          params: { limit: 1 },
          signal,
        })
      ).retention,
    (
      snapshot: Pick<
        SystemSettingsInitialData,
        "scheduledTaskRetention" | "fetchedAt"
      >,
    ) => snapshot.scheduledTaskRetention,
    deferred,
    retainInFlight,
  );
}
export function ScheduledTaskRetentionSettingsClient({
  messages,
  initialData = null,
  userId = "",
  deferredData,
}: ScheduledTaskRetentionSettingsClientProps) {
  const copy = messages.systemSettings;
  const [config, setConfig] = useState<ScheduledTaskRetentionConfig>(
    initialData?.scheduledTaskRetention ?? DEFAULTS,
  );
  const [saving, setSaving] = useState(false);
  const [configApplied, setConfigApplied] = useState(
    Boolean(initialData?.scheduledTaskRetention),
  );
  const configQuery = useQuery({
    ...retentionSettingsQueryOptions(userId, deferredData),
    initialData: initialData?.scheduledTaskRetention,
    initialDataUpdatedAt: initialData?.fetchedAt,
    enabled: typeof window !== "undefined",
  });
  useEffect(() => {
    if (configApplied || !configQuery.data) return;
    setConfig(configQuery.data);
    setConfigApplied(true);
  }, [configApplied, configQuery.data]);
  const loading = !configApplied && !configQuery.isError;
  const unavailable = !configApplied && configQuery.isError;
  const hasInvalidValue = useMemo(
    () =>
      FIELDS.some(({ key }) => {
        const value = config[key];
        return !Number.isInteger(value) || value < 1 || value > 3650;
      }),
    [config],
  );

  async function handleSave() {
    if (hasInvalidValue || !configApplied) return;
    setSaving(true);
    try {
      const data = await requestAdminService<ScheduledTasksData>(
        "scheduled-tasks",
        { method: "PATCH", body: { retention: config } },
      );
      setConfig(data.retention);
      toast.success(copy.retentionSaved);
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : copy.retentionSaveFailed,
      );
    } finally {
      setSaving(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <RiDatabase2Line className="size-4" />
          {copy.retentionTitle}
        </CardTitle>
        <CardDescription>{copy.retentionDescription}</CardDescription>
      </CardHeader>
      <CardContent>
        <AutoResizer initial={false}>
          <AutoTransition
            initial={false}
            transitionKey={
              loading ? "loading" : unavailable ? "error" : "ready"
            }
            duration={0.2}
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
              <div>
                <div className="grid gap-4 sm:grid-cols-2">
                  {FIELDS.map(({ key, label }) => (
                    <div key={key} className="space-y-2">
                      <Label htmlFor={`retention-${key}`}>{copy[label]}</Label>
                      <Input
                        id={`retention-${key}`}
                        type="number"
                        min={1}
                        max={3650}
                        step={1}
                        value={config[key]}
                        onChange={(event) =>
                          setConfig((current) => ({
                            ...current,
                            [key]: Number(event.target.value),
                          }))
                        }
                      />
                    </div>
                  ))}
                </div>
                <p className="mt-3 text-xs text-muted-foreground">
                  {copy.retentionRangeHint}
                </p>
                <Button
                  type="button"
                  className="mt-5 gap-2"
                  disabled={saving || hasInvalidValue || !configApplied}
                  onClick={() => void handleSave()}
                >
                  {saving ? <Spinner /> : <RiSave3Line />}
                  {saving ? copy.retentionSaving : copy.retentionSave}
                </Button>
              </div>
            )}
          </AutoTransition>
        </AutoResizer>
      </CardContent>
    </Card>
  );
}
