import { useMemo, useState } from "react";
import { RiDatabase2Line, RiSave3Line } from "@remixicon/react";
import { toast } from "sonner";

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
import type { SystemSettingsInitialData } from "@/lib/dashboard/management-data";
import type { AppMessages } from "@/lib/i18n/messages";
import type {
  ScheduledTaskRetentionConfig,
  ScheduledTasksData,
} from "@/lib/scheduled-tasks";

interface ScheduledTaskRetentionSettingsClientProps {
  messages: AppMessages;
  initialData?: SystemSettingsInitialData | null;
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

export function ScheduledTaskRetentionSettingsClient({
  messages,
  initialData = null,
}: ScheduledTaskRetentionSettingsClientProps) {
  const copy = messages.systemSettings;
  const [config, setConfig] = useState<ScheduledTaskRetentionConfig>(
    initialData?.scheduledTaskRetention ?? DEFAULTS,
  );
  const [saving, setSaving] = useState(false);
  const hasInvalidValue = useMemo(
    () =>
      FIELDS.some(({ key }) => {
        const value = config[key];
        return !Number.isInteger(value) || value < 1 || value > 3650;
      }),
    [config],
  );

  async function handleSave() {
    if (hasInvalidValue) return;
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
          disabled={saving || hasInvalidValue}
          onClick={() => void handleSave()}
        >
          {saving ? (
            <Spinner className="size-4" />
          ) : (
            <RiSave3Line className="size-4" />
          )}
          {saving ? copy.retentionSaving : copy.retentionSave}
        </Button>
      </CardContent>
    </Card>
  );
}
