import type { FormEvent } from "react";
import { useEffect, useRef, useState } from "react";
import { RiAddLine, RiCloseLine, RiSave3Line } from "@remixicon/react";
import { Reorder } from "motion/react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  ResponsiveDialog,
  ResponsiveDialogBody,
  ResponsiveDialogClose,
  ResponsiveDialogContent,
  ResponsiveDialogFooter,
  ResponsiveDialogHeader,
  ResponsiveDialogTitle,
} from "@/components/ui/responsive-dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Spinner } from "@/components/ui/spinner";
import type { TimeWindow } from "@/lib/dashboard/query-state";
import type { FunnelDefinition, FunnelStep } from "@/lib/edge-client";
import type { AppMessages } from "@/lib/i18n/messages";

import { FunnelStepFilterDialog } from "./funnel-step-filter-dialog";
import { FunnelStepRow } from "./funnel-step-row";

const MAX_STEPS = 10;
const HOUR_MS = 60 * 60 * 1_000;
const DEFAULT_VISITOR_WINDOW_MS = 7 * 24 * HOUR_MS;
const WINDOW_OPTIONS = [
  ["3600000", "oneHour"],
  ["86400000", "oneDay"],
  ["604800000", "sevenDays"],
  ["2592000000", "thirtyDays"],
] as const;

function newStep(index: number): FunnelStep {
  return {
    id: `step-${Date.now()}-${index}`,
    filterDsl: "",
  };
}

function windowValue(value: number | null): string {
  return value === null ? "custom" : String(value);
}

function isPresetWindow(value: number | null): boolean {
  return (
    value !== null &&
    WINDOW_OPTIONS.some(([preset]) => Number(preset) === value)
  );
}

function stepsFrom(funnel?: FunnelDefinition): FunnelStep[] {
  return funnel?.steps.map((step) => ({ ...step })) ?? [newStep(0), newStep(1)];
}

export function FunnelEditor({
  open,
  funnel,
  labels,
  messages,
  siteId,
  window,
  submitting,
  onOpenChange,
  onSubmit,
}: {
  readonly open: boolean;
  readonly funnel?: FunnelDefinition | null;
  readonly labels: AppMessages["funnels"];
  readonly messages: AppMessages;
  readonly siteId: string;
  readonly window: TimeWindow;
  readonly submitting: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly onSubmit: (input: {
    name: string;
    progressionScope: "session" | "visitor";
    conversionWindowMs: number | null;
    steps: FunnelStep[];
  }) => Promise<void>;
}) {
  const [name, setName] = useState("");
  const [scope, setScope] = useState<"session" | "visitor">("session");
  const [conversionWindowMs, setConversionWindowMs] = useState<number | null>(
    null,
  );
  const [customWindowHours, setCustomWindowHours] = useState("168");
  const [steps, setSteps] = useState<FunnelStep[]>(stepsFrom());
  const [filterStepId, setFilterStepId] = useState<string | null>(null);
  const filterStepIdRef = useRef<string | null>(null);
  const filterDismissGuardRef = useRef(false);

  useEffect(() => {
    if (!open) return;
    setName(funnel?.name ?? "");
    setScope(funnel?.progressionScope ?? "session");
    setConversionWindowMs(funnel?.conversionWindowMs ?? null);
    if (
      funnel?.conversionWindowMs &&
      !isPresetWindow(funnel.conversionWindowMs)
    ) {
      setCustomWindowHours(String(funnel.conversionWindowMs / HOUR_MS));
    } else {
      setCustomWindowHours("168");
    }
    setSteps(stepsFrom(funnel ?? undefined));
    filterStepIdRef.current = null;
    filterDismissGuardRef.current = false;
    setFilterStepId(null);
  }, [funnel, open]);

  const closeFilterDialog = () => {
    filterDismissGuardRef.current = true;
    filterStepIdRef.current = null;
    setFilterStepId(null);
    globalThis.setTimeout(() => {
      filterDismissGuardRef.current = false;
    }, 0);
  };

  const valid =
    name.trim().length > 0 &&
    steps.length >= 2 &&
    steps.length <= MAX_STEPS &&
    steps.every((step) => step.filterDsl.trim().length > 0);

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!valid) return;
    await onSubmit({
      name: name.trim(),
      progressionScope: scope,
      conversionWindowMs: scope === "visitor" ? conversionWindowMs : null,
      steps,
    });
  };

  const activeFilterStep =
    steps.find((step) => step.id === filterStepId) ?? null;

  return (
    <>
      <ResponsiveDialog
        open={open}
        onOpenChange={(nextOpen) => {
          if (!nextOpen && (filterStepId || filterStepIdRef.current)) {
            return;
          }
          onOpenChange(nextOpen);
        }}
      >
        <ResponsiveDialogContent
          desktopClassName="max-w-xl"
          onPointerDownOutside={(event) => {
            if (
              filterStepId ||
              filterStepIdRef.current ||
              filterDismissGuardRef.current
            ) {
              event.preventDefault();
            }
          }}
          onInteractOutside={(event) => {
            if (
              filterStepId ||
              filterStepIdRef.current ||
              filterDismissGuardRef.current
            ) {
              event.preventDefault();
            }
          }}
        >
          <form
            onSubmit={submit}
            className="flex min-h-0 flex-1 flex-col gap-4"
          >
            <ResponsiveDialogHeader>
              <ResponsiveDialogTitle icon={RiSave3Line}>
                {funnel ? labels.editTitle : labels.createTitle}
              </ResponsiveDialogTitle>
            </ResponsiveDialogHeader>
            <ResponsiveDialogBody>
              <div className="min-h-max min-w-0 space-y-3">
                <div className="space-y-1.5">
                  <label htmlFor="funnel-name" className="text-sm font-medium">
                    {labels.nameLabel}
                  </label>
                  <Input
                    id="funnel-name"
                    value={name}
                    onChange={(event) => setName(event.target.value)}
                    placeholder={labels.namePlaceholder}
                  />
                </div>
                <div className="grid gap-3 sm:grid-cols-2">
                  <div className="min-w-0 space-y-1.5">
                    <label className="text-sm font-medium">
                      {labels.progression}
                    </label>
                    <Select
                      value={scope}
                      onValueChange={(value) => {
                        const nextScope = value as typeof scope;
                        setScope(nextScope);
                        if (
                          nextScope === "visitor" &&
                          conversionWindowMs === null
                        ) {
                          setConversionWindowMs(DEFAULT_VISITOR_WINDOW_MS);
                        }
                        if (nextScope === "session")
                          setConversionWindowMs(null);
                      }}
                    >
                      <SelectTrigger className="w-full">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="session">
                          {labels.sessions}
                        </SelectItem>
                        <SelectItem value="visitor">
                          {labels.visitors}
                        </SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                  {scope === "visitor" ? (
                    <div className="min-w-0 space-y-1.5">
                      <label className="text-sm font-medium">
                        {labels.conversionWindow}
                      </label>
                      <Select
                        value={windowValue(conversionWindowMs)}
                        onValueChange={(value) => {
                          if (value === "custom") {
                            const hours = Number(customWindowHours);
                            setConversionWindowMs(
                              Number.isFinite(hours) && hours > 0
                                ? hours * HOUR_MS
                                : null,
                            );
                          } else {
                            setConversionWindowMs(Number(value));
                          }
                        }}
                      >
                        <SelectTrigger className="w-full">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {WINDOW_OPTIONS.map(([value, key]) => (
                            <SelectItem key={value} value={value}>
                              {labels[key]}
                            </SelectItem>
                          ))}
                          <SelectItem value="custom">
                            {labels.custom}
                          </SelectItem>
                        </SelectContent>
                      </Select>
                      {conversionWindowMs !== null &&
                      !isPresetWindow(conversionWindowMs) ? (
                        <Input
                          type="number"
                          min="0.001"
                          step="0.001"
                          value={customWindowHours}
                          aria-label={labels.customWindowHours}
                          className="w-full"
                          placeholder={labels.customWindowHours}
                          onChange={(event) => {
                            const value = event.target.value;
                            setCustomWindowHours(value);
                            const hours = Number(value);
                            setConversionWindowMs(
                              Number.isFinite(hours) && hours > 0
                                ? hours * HOUR_MS
                                : null,
                            );
                          }}
                        />
                      ) : null}
                    </div>
                  ) : null}
                </div>
                <div className="space-y-3">
                  <div className="flex items-center justify-between gap-3">
                    <p className="text-sm font-medium">{labels.stepsLabel}</p>
                    <Button
                      type="button"
                      variant="outline"
                      disabled={steps.length >= MAX_STEPS}
                      onClick={() =>
                        setSteps((current) => [
                          ...current,
                          newStep(current.length),
                        ])
                      }
                    >
                      <RiAddLine /> {labels.addStep}
                    </Button>
                  </div>
                  <Reorder.Group axis="y" values={steps} onReorder={setSteps}>
                    {steps.map((step, index) => (
                      <FunnelStepRow
                        key={step.id}
                        step={step}
                        index={index}
                        total={steps.length}
                        onChange={(patch) =>
                          setSteps((current) =>
                            current.map((item) =>
                              item.id === step.id
                                ? { ...item, ...patch }
                                : item,
                            ),
                          )
                        }
                        onDelete={() =>
                          setSteps((current) =>
                            current.filter((item) => item.id !== step.id),
                          )
                        }
                        onFilter={() => {
                          filterStepIdRef.current = step.id;
                          filterDismissGuardRef.current = false;
                          setFilterStepId(step.id);
                        }}
                        labels={labels}
                      />
                    ))}
                  </Reorder.Group>
                </div>
              </div>
            </ResponsiveDialogBody>
            <ResponsiveDialogFooter>
              <ResponsiveDialogClose asChild>
                <Button type="button" variant="outline" disabled={submitting}>
                  <RiCloseLine /> {labels.cancel}
                </Button>
              </ResponsiveDialogClose>
              <Button type="submit" disabled={!valid || submitting}>
                {submitting ? <Spinner /> : <RiSave3Line />}
                {funnel ? labels.saveEdit : labels.save}
              </Button>
            </ResponsiveDialogFooter>
          </form>
        </ResponsiveDialogContent>
      </ResponsiveDialog>
      <FunnelStepFilterDialog
        open={Boolean(activeFilterStep)}
        filterDsl={activeFilterStep?.filterDsl ?? ""}
        onOpenChange={(nextOpen) => {
          if (!nextOpen) closeFilterDialog();
        }}
        onApply={(filterDsl) => {
          if (!activeFilterStep) return;
          setSteps((current) =>
            current.map((step) =>
              step.id === activeFilterStep.id ? { ...step, filterDsl } : step,
            ),
          );
          closeFilterDialog();
        }}
        labels={labels}
        messages={messages}
        siteId={siteId}
        window={window}
      />
    </>
  );
}
