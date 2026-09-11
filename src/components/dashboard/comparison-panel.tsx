"use client";

import * as React from "react";
import {
  RiBarChartGroupedLine,
  RiCheckLine,
  RiCloseLine,
  RiFilter2Line,
} from "@remixicon/react";
import { useQuery } from "@tanstack/react-query";

import { FilterEditor } from "@/components/dashboard/filter-editor";
import { SavedFilterSelect } from "@/components/dashboard/filter-panel";
import { AutoResizer } from "@/components/ui/auto-resizer";
import { AutoTransition } from "@/components/ui/auto-transition";
import { Button } from "@/components/ui/button";
import {
  Field,
  FieldContent,
  FieldDescription,
  FieldLabel,
  FieldTitle,
} from "@/components/ui/field";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import {
  ResponsiveDialog,
  ResponsiveDialogBody,
  ResponsiveDialogContent,
  ResponsiveDialogDescription,
  ResponsiveDialogHeader,
  ResponsiveDialogTitle,
} from "@/components/ui/responsive-dialog";
import { fetchSavedFilters } from "@/lib/dashboard/client-data";
import type { TimeWindow } from "@/lib/dashboard/query-state";
import type { FilterScope } from "@/lib/filter-contract";
import type { AppMessages } from "@/lib/i18n/messages";
import { cn } from "@/lib/utils";

export type ComparisonPeriod = "same" | "previous";
export type ComparisonFilterMode = "current" | "custom";

export interface ComparisonSettings {
  readonly period: ComparisonPeriod;
  readonly filterMode: ComparisonFilterMode;
  readonly filterDsl: string;
}

interface ComparisonPanelProps {
  readonly currentFilterDsl: string;
  readonly initialSettings: ComparisonSettings;
  readonly messages: AppMessages;
  readonly onApply: (settings: ComparisonSettings) => void;
  readonly onCancel: () => void;
  readonly resolvedScope: FilterScope;
  readonly siteId?: string;
  readonly timeWindow: TimeWindow;
}

function ComparisonFilterDialog({
  filterDsl,
  messages,
  onApply,
  onOpenChange,
  open,
  resolvedScope,
  siteId,
  timeWindow,
}: {
  readonly filterDsl: string;
  readonly messages: AppMessages;
  readonly onApply: (filterDsl: string) => void;
  readonly onOpenChange: (open: boolean) => void;
  readonly open: boolean;
  readonly resolvedScope: FilterScope;
  readonly siteId?: string;
  readonly timeWindow: TimeWindow;
}) {
  const [draftFilterDsl, setDraftFilterDsl] = React.useState(filterDsl);
  const savedFiltersQuery = useQuery({
    queryKey: ["saved-filters", siteId],
    queryFn: ({ signal }: { signal: AbortSignal }) =>
      fetchSavedFilters(siteId!, { signal }),
    enabled: open && Boolean(siteId),
    staleTime: 60_000,
  });
  const savedFilters = savedFiltersQuery.data?.items ?? [];
  const matchedSavedFilter = React.useMemo(
    () => savedFilters.find((filter) => filter.filterDsl === draftFilterDsl),
    [draftFilterDsl, savedFilters],
  );
  const savedFilterTriggerLabel = savedFiltersQuery.isFetching
    ? messages.filterBuilder.savedFiltersLoading
    : (matchedSavedFilter?.name ?? messages.filterBuilder.noSavedFilter);
  const savedFilterTriggerKey = savedFiltersQuery.isFetching
    ? "loading"
    : matchedSavedFilter
      ? `saved:${matchedSavedFilter.id}`
      : "none";

  React.useEffect(() => {
    if (open) setDraftFilterDsl(filterDsl);
  }, [filterDsl, open]);

  return (
    <ResponsiveDialog open={open} onOpenChange={onOpenChange}>
      <ResponsiveDialogContent
        desktopClassName="max-w-xl"
        onPointerDown={(event) => event.stopPropagation()}
      >
        <ResponsiveDialogHeader>
          <ResponsiveDialogTitle icon={RiFilter2Line}>
            {messages.dashboardHeader.compareCustomFilter}
          </ResponsiveDialogTitle>
          <ResponsiveDialogDescription>
            {messages.dashboardHeader.compareCustomFilterDescription}
          </ResponsiveDialogDescription>
        </ResponsiveDialogHeader>
        <ResponsiveDialogBody
          scrollable={false}
          className="px-4 pb-2 md:px-0 md:pb-0"
        >
          <FilterEditor
            className="min-h-0 flex-1"
            audience="private-dashboard"
            initialFilterDsl={draftFilterDsl}
            messages={messages}
            observationOnly
            onApply={onApply}
            onCancel={() => onOpenChange(false)}
            applyLabel={messages.filterBuilder.apply}
            cancelLabel={messages.dashboardHeader.compareCancel}
            resolvedScope={resolvedScope}
            siteId={siteId}
            window={timeWindow}
            headerContent={
              <div className="mb-4 border-b border-border pb-4">
                <SavedFilterSelect
                  audience="private-dashboard"
                  matchedSavedFilter={matchedSavedFilter}
                  messages={messages}
                  savedFilterTriggerKey={savedFilterTriggerKey}
                  savedFilterTriggerLabel={savedFilterTriggerLabel}
                  savedFilters={savedFilters}
                  savedFiltersLoading={savedFiltersQuery.isFetching}
                  onApplySavedFilter={(filter) =>
                    setDraftFilterDsl(filter.filterDsl)
                  }
                  onApplySystemPreset={(preset) =>
                    setDraftFilterDsl(preset.filterDsl)
                  }
                  onClearSavedFilter={() => setDraftFilterDsl("")}
                />
              </div>
            }
          />
        </ResponsiveDialogBody>
      </ResponsiveDialogContent>
    </ResponsiveDialog>
  );
}

function ComparisonOption({
  description,
  id,
  label,
  selected,
  value,
}: {
  readonly description: string;
  readonly id: string;
  readonly label: string;
  readonly selected: boolean;
  readonly value: string;
}) {
  return (
    <FieldLabel htmlFor={id} className="cursor-pointer">
      <Field
        orientation="horizontal"
        className={cn(
          "border-border hover:bg-muted/20",
          selected && "border-foreground/30 bg-muted/30",
        )}
      >
        <FieldContent>
          <FieldTitle>{label}</FieldTitle>
          <FieldDescription>{description}</FieldDescription>
        </FieldContent>
        <RadioGroupItem id={id} value={value} className="mt-0.5" />
      </Field>
    </FieldLabel>
  );
}

export function ComparisonPanel({
  currentFilterDsl,
  initialSettings,
  messages,
  onApply,
  onCancel,
  resolvedScope,
  siteId,
  timeWindow,
}: ComparisonPanelProps) {
  const [customFilterDialogOpen, setCustomFilterDialogOpen] =
    React.useState(false);
  const [period, setPeriod] = React.useState<ComparisonPeriod>(
    initialSettings.period,
  );
  const [filterMode, setFilterMode] = React.useState<ComparisonFilterMode>(
    initialSettings.filterMode,
  );
  const [customFilterDsl, setCustomFilterDsl] = React.useState(
    initialSettings.filterDsl || currentFilterDsl,
  );
  const preserveCustomFilterDraftRef = React.useRef(false);

  React.useEffect(() => {
    if (customFilterDialogOpen) return;
    if (preserveCustomFilterDraftRef.current) {
      preserveCustomFilterDraftRef.current = false;
      return;
    }
    setPeriod(initialSettings.period);
    setFilterMode(initialSettings.filterMode);
    setCustomFilterDsl(initialSettings.filterDsl || currentFilterDsl);
  }, [
    currentFilterDsl,
    customFilterDialogOpen,
    initialSettings.filterDsl,
    initialSettings.filterMode,
    initialSettings.period,
  ]);

  const options = (
    <div className="flex flex-col gap-6 pb-4">
      <section className="flex flex-col gap-2">
        <Label>{messages.dashboardHeader.compareTimeLabel}</Label>
        <RadioGroup
          aria-label={messages.dashboardHeader.compareTimeLabel}
          value={period}
          onValueChange={(value) => setPeriod(value as ComparisonPeriod)}
          className="gap-2"
        >
          <ComparisonOption
            id="comparison-period-current"
            value="same"
            label={messages.dashboardHeader.compareCurrentPeriod}
            description={
              messages.dashboardHeader.compareCurrentPeriodDescription
            }
            selected={period === "same"}
          />
          <ComparisonOption
            id="comparison-period-previous"
            value="previous"
            label={messages.dashboardHeader.comparePreviousPeriod}
            description={
              messages.dashboardHeader.comparePreviousPeriodDescription
            }
            selected={period === "previous"}
          />
        </RadioGroup>
      </section>

      <section className="flex flex-col gap-2">
        <Label>{messages.dashboardHeader.compareFilterLabel}</Label>
        <RadioGroup
          aria-label={messages.dashboardHeader.compareFilterLabel}
          value={filterMode}
          onValueChange={(value) =>
            setFilterMode(value as ComparisonFilterMode)
          }
          className="gap-2"
        >
          <ComparisonOption
            id="comparison-filter-current"
            value="current"
            label={messages.dashboardHeader.compareFollowCurrentFilter}
            description={
              messages.dashboardHeader.compareFollowCurrentFilterDescription
            }
            selected={filterMode === "current"}
          />
          <ComparisonOption
            id="comparison-filter-custom"
            value="custom"
            label={messages.dashboardHeader.compareCustomFilter}
            description={
              messages.dashboardHeader.compareCustomFilterDescription
            }
            selected={filterMode === "custom"}
          />
        </RadioGroup>

        <AutoResizer initial={false} duration={0.24} ease={[0.22, 1, 0.36, 1]}>
          <AutoTransition
            initial={false}
            duration={0.2}
            transitionKey={filterMode}
          >
            {filterMode === "custom" ? (
              <div className="pt-2">
                <Button
                  type="button"
                  variant="outline"
                  className="w-full justify-start truncate text-left text-xs"
                  onPointerDown={(event) => event.stopPropagation()}
                  onClick={() => setCustomFilterDialogOpen(true)}
                >
                  <RiFilter2Line className="size-4" />
                  <span className="min-w-0 truncate">
                    {messages.dashboardHeader.compareCustomFilter}
                  </span>
                </Button>
              </div>
            ) : null}
          </AutoTransition>
        </AutoResizer>
      </section>
    </div>
  );

  return (
    <>
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden px-4">
        <div className="min-h-0 flex-1 overflow-y-auto">{options}</div>
        <div className="flex shrink-0 justify-end gap-2 border-t border-border bg-background pt-4 pb-[calc(1rem+env(safe-area-inset-bottom))]">
          <Button type="button" variant="outline" onClick={onCancel}>
            <RiCloseLine />
            <span>{messages.dashboardHeader.compareCancel}</span>
          </Button>
          <Button
            type="button"
            onClick={() =>
              onApply({
                period,
                filterMode,
                filterDsl:
                  filterMode === "custom" ? customFilterDsl : currentFilterDsl,
              })
            }
          >
            <RiCheckLine />
            <span>{messages.dashboardHeader.compareApply}</span>
          </Button>
        </div>
      </div>
      <ComparisonFilterDialog
        filterDsl={customFilterDsl}
        messages={messages}
        onApply={(filterDsl) => {
          preserveCustomFilterDraftRef.current = true;
          setCustomFilterDsl(filterDsl);
          setCustomFilterDialogOpen(false);
        }}
        onOpenChange={setCustomFilterDialogOpen}
        open={customFilterDialogOpen}
        resolvedScope={resolvedScope}
        siteId={siteId}
        timeWindow={timeWindow}
      />
    </>
  );
}

export function ComparisonPanelTitle({ messages }: { messages: AppMessages }) {
  return (
    <span className="inline-flex items-center gap-2">
      <RiBarChartGroupedLine className="size-4" />
      <span>{messages.dashboardHeader.compareTitle}</span>
    </span>
  );
}
