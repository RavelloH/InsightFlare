import {
  type FormEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  RiAddLine,
  RiArrowRightLine,
  RiCloseLine,
  RiDeleteBinLine,
  RiFilter2Line,
  RiSave3Line,
} from "@remixicon/react";
import {
  useInfiniteQuery,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { toast } from "sonner";

import { PageHeading } from "@/components/dashboard/page-heading";
import {
  DETAIL_QUERY_PARAM,
  DetailDrawer,
} from "@/components/dashboard/site-pages/detail-query-modal";
import { useDashboardQuery } from "@/components/dashboard/site-pages/use-dashboard-query";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
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
  ResponsiveDialog,
  ResponsiveDialogBody,
  ResponsiveDialogClose,
  ResponsiveDialogContent,
  ResponsiveDialogDescription,
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
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  pushUrlWithoutNavigation,
  replaceUrlWithoutNavigation,
  useLiveSearchParams,
} from "@/lib/client-history";
import {
  createFunnel,
  deleteFunnel,
  fetchEventTypesTab,
  fetchFunnelDetail,
  fetchFunnels,
  fetchOverviewPageCardTab,
} from "@/lib/dashboard/client-data";
import { filterQueryKey } from "@/lib/dashboard/filter-query-key";
import { serializeDashboardSearchParams } from "@/lib/dashboard/filter-state";
import {
  intlLocale,
  numberFormat,
  percentFormat,
} from "@/lib/dashboard/format";
import type { TimeWindow } from "@/lib/dashboard/query-state";
import type {
  FunnelAnalysisStep,
  FunnelDefinition,
  FunnelDetailData,
  FunnelStep,
} from "@/lib/edge-client";
import type { FilterDocument } from "@/lib/filter-contract";
import type { Locale } from "@/lib/i18n/config";
import type { AppMessages } from "@/lib/i18n/messages";
import { cn } from "@/lib/utils";

interface FunnelsClientPageProps {
  locale: Locale;
  messages: AppMessages;
  siteId: string;
  pathname: string;
}

type FunnelCopy = AppMessages["funnels"];

interface StepDraft {
  type: FunnelStep["type"];
  value: string;
}

interface FunnelCandidateState {
  pageviews: string[];
  events: string[];
}

const INITIAL_STEPS: StepDraft[] = [
  { type: "pageview", value: "" },
  { type: "event", value: "" },
];

function emptyCandidates(): FunnelCandidateState {
  return { pageviews: [], events: [] };
}

function detailQueryTarget(
  pathname: string,
  searchParams: URLSearchParams,
  funnelId: string,
): string {
  const params = new URLSearchParams(searchParams.toString());
  params.set(DETAIL_QUERY_PARAM, funnelId);
  params.delete("funnelId");
  const query = serializeDashboardSearchParams(params);
  return query ? `${pathname}?${query}` : pathname;
}

function updatedLabel(
  locale: Locale,
  labels: FunnelCopy,
  timestampSeconds: number,
): string {
  const date = new Date(timestampSeconds * 1000);
  if (!Number.isFinite(date.getTime())) return labels.updated;
  return `${labels.updated} ${new Intl.DateTimeFormat(intlLocale(locale), {
    month: "short",
    day: "numeric",
    year: "numeric",
  }).format(date)}`;
}

function stepTypeLabel(labels: FunnelCopy, type: FunnelStep["type"]): string {
  return type === "pageview" ? labels.stepTypePageview : labels.stepTypeEvent;
}

function normalizedDraftSteps(steps: StepDraft[]): FunnelStep[] {
  return steps
    .map((step) => ({
      type: step.type,
      value: step.value.trim(),
    }))
    .filter((step) => step.value.length > 0);
}

function isValidDraft(name: string, steps: StepDraft[]): boolean {
  return name.trim().length > 0 && normalizedDraftSteps(steps).length >= 2;
}

function FunnelStateCard({
  title,
  subtitle,
  action,
}: {
  title: string;
  subtitle: string;
  action?: ReactNode;
}) {
  return (
    <Card className="min-w-0">
      <CardContent className="flex min-h-56 flex-col items-center justify-center gap-4 text-center">
        <span className="inline-flex size-10 items-center justify-center border bg-muted/50 text-muted-foreground">
          <RiFilter2Line className="size-5" />
        </span>
        <div className="min-w-0 space-y-1">
          <p className="font-medium">{title}</p>
          <p className="max-w-md break-words text-muted-foreground">
            {subtitle}
          </p>
        </div>
        {action}
      </CardContent>
    </Card>
  );
}

function FunnelListLoading() {
  return (
    <Card className="min-w-0">
      <CardHeader>
        <Skeleton className="h-4 w-36" />
        <Skeleton className="h-3 w-80 max-w-full" />
      </CardHeader>
      <CardContent className="divide-y px-0 py-0">
        {Array.from({ length: 4 }, (_, index) => (
          <div
            key={index}
            className="grid min-w-0 gap-3 p-4 md:grid-cols-[minmax(0,1fr)_auto]"
          >
            <div className="min-w-0 space-y-3">
              <Skeleton className="h-4 w-44" />
              <div className="flex flex-wrap gap-2">
                <Skeleton className="h-5 w-24" />
                <Skeleton className="h-5 w-28" />
                <Skeleton className="h-5 w-20" />
              </div>
            </div>
            <Skeleton className="h-8 w-24" />
          </div>
        ))}
      </CardContent>
    </Card>
  );
}

function FunnelList({
  locale,
  labels,
  funnels,
  selectedId,
  onOpen,
  onDelete,
}: {
  locale: Locale;
  labels: FunnelCopy;
  funnels: FunnelDefinition[];
  selectedId: string;
  onOpen: (funnelId: string) => void;
  onDelete: (funnel: FunnelDefinition) => void;
}) {
  return (
    <Card className="min-w-0">
      <CardHeader className="min-w-0 gap-1 md:grid-cols-[minmax(0,1fr)_auto]">
        <div className="min-w-0">
          <CardTitle className="inline-flex items-center gap-2">
            <RiFilter2Line className="size-4" />
            {labels.listTitle}
          </CardTitle>
          <CardDescription className="break-words">
            {labels.listSubtitle}
          </CardDescription>
        </div>
        <div className="hidden text-xs text-muted-foreground md:block">
          {numberFormat(locale, funnels.length)}
        </div>
      </CardHeader>
      <CardContent className="divide-y px-0 py-0">
        {funnels.map((funnel) => (
          <div
            key={funnel.id}
            className={cn(
              "grid min-w-0 gap-3 p-4 transition-colors md:grid-cols-[minmax(0,1fr)_auto]",
              selectedId === funnel.id && "bg-muted/45",
            )}
          >
            <button
              type="button"
              className="block w-full min-w-0 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring/60"
              onClick={() => onOpen(funnel.id)}
            >
              <div className="flex min-w-0 items-center gap-2">
                <p className="min-w-0 truncate font-medium">{funnel.name}</p>
                <Badge variant="outline" className="shrink-0">
                  {numberFormat(locale, funnel.steps.length)}
                </Badge>
              </div>
              <div className="mt-3 flex min-w-0 flex-wrap items-center gap-2 text-xs text-muted-foreground">
                {funnel.steps.map((step, index) => (
                  <span
                    key={`${funnel.id}-${index}`}
                    className="inline-flex min-w-0 max-w-full items-center gap-1 border bg-background px-2 py-1 sm:max-w-56"
                  >
                    <span className="shrink-0 text-[10px] uppercase">
                      {stepTypeLabel(labels, step.type)}
                    </span>
                    <span className="min-w-0 truncate font-mono text-foreground">
                      {step.value}
                    </span>
                  </span>
                ))}
              </div>
              <p className="mt-3 text-xs text-muted-foreground">
                {updatedLabel(locale, labels, funnel.updatedAt)}
              </p>
            </button>
            <div className="flex min-w-0 flex-wrap items-center gap-2 md:justify-end">
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => onOpen(funnel.id)}
              >
                <RiArrowRightLine />
                {labels.conversion}
              </Button>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    type="button"
                    variant="destructive"
                    size="icon-sm"
                    aria-label={`${labels.deleteTitle}: ${funnel.name}`}
                    onClick={() => onDelete(funnel)}
                  >
                    <RiDeleteBinLine />
                  </Button>
                </TooltipTrigger>
                <TooltipContent>
                  {`${labels.deleteTitle}: ${funnel.name}`}
                </TooltipContent>
              </Tooltip>
            </div>
          </div>
        ))}
      </CardContent>
    </Card>
  );
}

function CreateFunnelDialog({
  open,
  onOpenChange,
  locale,
  labels,
  candidates,
  submitting,
  onCreate,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  locale: Locale;
  labels: FunnelCopy;
  candidates: FunnelCandidateState;
  submitting: boolean;
  onCreate: (name: string, steps: FunnelStep[]) => Promise<void>;
}) {
  const [name, setName] = useState("");
  const [steps, setSteps] = useState<StepDraft[]>(INITIAL_STEPS);

  useEffect(() => {
    if (!open) return;
    setName("");
    setSteps(INITIAL_STEPS);
  }, [open]);

  const canSubmit = isValidDraft(name, steps) && !submitting;

  const updateStep = (index: number, patch: Partial<StepDraft>) => {
    setSteps((current) =>
      current.map((step, currentIndex) =>
        currentIndex === index ? { ...step, ...patch } : step,
      ),
    );
  };

  const removeStep = (index: number) => {
    setSteps((current) =>
      current.filter((_, currentIndex) => currentIndex !== index),
    );
  };

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const nextSteps = normalizedDraftSteps(steps);
    if (!isValidDraft(name, steps)) {
      toast.error(labels.invalidFunnel);
      return;
    }
    await onCreate(name.trim(), nextSteps);
  };

  return (
    <ResponsiveDialog open={open} onOpenChange={onOpenChange}>
      <ResponsiveDialogContent desktopClassName="max-w-2xl">
        <form onSubmit={submit} className="flex min-h-0 flex-1 flex-col gap-5">
          <ResponsiveDialogHeader>
            <ResponsiveDialogTitle icon={RiFilter2Line}>
              {labels.createTitle}
            </ResponsiveDialogTitle>
            <ResponsiveDialogDescription>
              {labels.createDescription}
            </ResponsiveDialogDescription>
          </ResponsiveDialogHeader>

          <ResponsiveDialogBody className="space-y-5">
            <div className="space-y-2">
              <Label htmlFor="funnel-name">{labels.nameLabel}</Label>
              <Input
                id="funnel-name"
                value={name}
                onChange={(event) => setName(event.target.value)}
                placeholder={labels.namePlaceholder}
              />
            </div>

            <div className="space-y-3">
              <div className="flex items-center justify-between gap-3">
                <Label>{labels.stepsLabel}</Label>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={() =>
                    setSteps((current) => [
                      ...current,
                      { type: "pageview", value: "" },
                    ])
                  }
                >
                  <RiAddLine />
                  {labels.addStep}
                </Button>
              </div>

              <div className="space-y-2">
                {steps.map((step, index) => {
                  const listId =
                    step.type === "pageview"
                      ? "funnel-pageview-options"
                      : "funnel-event-options";
                  return (
                    <div
                      key={index}
                      className="grid min-w-0 gap-2 border bg-muted/20 p-2 md:grid-cols-[2.2rem_9rem_minmax(0,1fr)_2rem]"
                    >
                      <div className="flex h-8 items-center justify-center border bg-background font-mono text-xs text-muted-foreground">
                        {numberFormat(locale, index + 1)}
                      </div>
                      <Select
                        value={step.type}
                        onValueChange={(value) =>
                          updateStep(index, {
                            type: value === "event" ? "event" : "pageview",
                            value: "",
                          })
                        }
                      >
                        <SelectTrigger className="w-full">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="pageview">
                            {labels.stepTypePageview}
                          </SelectItem>
                          <SelectItem value="event">
                            {labels.stepTypeEvent}
                          </SelectItem>
                        </SelectContent>
                      </Select>
                      <Input
                        className="min-w-0"
                        value={step.value}
                        onChange={(event) =>
                          updateStep(index, { value: event.target.value })
                        }
                        list={listId}
                        aria-label={labels.stepValueLabel}
                        placeholder={
                          step.type === "pageview"
                            ? labels.pageviewPlaceholder
                            : labels.eventPlaceholder
                        }
                      />
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <span
                            className="inline-flex"
                            tabIndex={steps.length <= 2 ? 0 : undefined}
                          >
                            <Button
                              type="button"
                              variant="ghost"
                              size="icon-sm"
                              aria-label={labels.removeStep}
                              disabled={steps.length <= 2}
                              onClick={() => removeStep(index)}
                            >
                              <RiDeleteBinLine />
                            </Button>
                          </span>
                        </TooltipTrigger>
                        <TooltipContent>{labels.removeStep}</TooltipContent>
                      </Tooltip>
                    </div>
                  );
                })}
              </div>
            </div>

            <datalist id="funnel-pageview-options">
              {candidates.pageviews.map((value) => (
                <option key={value} value={value} />
              ))}
            </datalist>
            <datalist id="funnel-event-options">
              {candidates.events.map((value) => (
                <option key={value} value={value} />
              ))}
            </datalist>
          </ResponsiveDialogBody>

          <ResponsiveDialogFooter>
            <ResponsiveDialogClose asChild>
              <Button type="button" variant="outline" disabled={submitting}>
                <RiCloseLine className="size-4" />
                <span>{labels.cancel}</span>
              </Button>
            </ResponsiveDialogClose>
            <Button type="submit" disabled={!canSubmit}>
              {submitting ? (
                <>
                  <Spinner className="size-4" />
                  <span>{labels.creating}</span>
                </>
              ) : (
                <>
                  <RiSave3Line className="size-4" />
                  <span>{labels.save}</span>
                </>
              )}
            </Button>
          </ResponsiveDialogFooter>
        </form>
      </ResponsiveDialogContent>
    </ResponsiveDialog>
  );
}

function FunnelMetric({
  label,
  value,
  detail,
  loading = false,
}: {
  label: string;
  value: string;
  detail: string;
  loading?: boolean;
}) {
  return (
    <div className="min-w-0 bg-card p-4">
      <p className="truncate text-[11px] uppercase text-muted-foreground">
        {label}
      </p>
      <AutoTransition
        initial={false}
        transitionKey={loading ? "loading" : value}
        duration={0.18}
        type="fade"
        presenceMode="wait"
        className="mt-3 h-7"
      >
        {loading ? (
          <Skeleton key="loading" className="h-7 w-20" />
        ) : (
          <p
            key="ready"
            className="truncate font-mono text-xl leading-7 font-semibold"
          >
            {value}
          </p>
        )}
      </AutoTransition>
      <AutoTransition
        initial={false}
        transitionKey={loading ? "loading" : detail}
        duration={0.18}
        type="fade"
        presenceMode="wait"
        className="mt-3 h-4"
      >
        {loading ? (
          <Skeleton key="loading" className="h-3 w-32" />
        ) : (
          <p key="ready" className="truncate text-[11px] text-muted-foreground">
            {detail}
          </p>
        )}
      </AutoTransition>
    </div>
  );
}

function FunnelStepRow({
  locale,
  labels,
  step,
  loading = false,
}: {
  locale: Locale;
  labels: FunnelCopy;
  step: FunnelAnalysisStep;
  loading?: boolean;
}) {
  const width = `${Math.max(2, Math.min(100, step.conversionRate * 100))}%`;

  return (
    <div className="grid min-w-0 gap-3 border-b p-4 last:border-b-0 lg:grid-cols-[2.5rem_minmax(0,1fr)_11rem_11rem]">
      <div className="flex size-8 items-center justify-center border bg-muted/40 font-mono text-xs text-muted-foreground">
        {numberFormat(locale, step.index + 1)}
      </div>
      <div className="min-w-0 space-y-2">
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <AutoTransition
            initial={false}
            transitionKey={loading ? "loading" : step.type}
            duration={0.18}
            type="fade"
            presenceMode="wait"
            className="h-5"
          >
            {loading ? (
              <Skeleton key="loading" className="h-5 w-20" />
            ) : (
              <Badge key="ready" variant="outline">
                {stepTypeLabel(labels, step.type)}
              </Badge>
            )}
          </AutoTransition>
          <AutoTransition
            initial={false}
            transitionKey={loading ? "loading" : step.label}
            duration={0.18}
            type="fade"
            presenceMode="wait"
            className="min-w-0 h-5 flex-1"
          >
            {loading ? (
              <Skeleton key="loading" className="h-5 w-[min(22rem,72%)]" />
            ) : (
              <p key="ready" className="min-w-0 truncate font-mono font-medium">
                {step.label}
              </p>
            )}
          </AutoTransition>
        </div>
        <AutoTransition
          initial={false}
          transitionKey={loading ? "loading" : width}
          duration={0.18}
          type="fade"
          presenceMode="wait"
          className="h-2"
        >
          {loading ? (
            <Skeleton key="loading" className="h-2 w-full" />
          ) : (
            <div key="ready" className="h-2 overflow-hidden bg-muted">
              <div
                className="h-full bg-primary transition-[width]"
                style={{ width }}
              />
            </div>
          )}
        </AutoTransition>
      </div>
      <div className="grid min-w-0 grid-cols-2 gap-3 text-xs">
        <div>
          <p className="text-muted-foreground">{labels.sessions}</p>
          <AutoTransition
            initial={false}
            transitionKey={loading ? "loading" : step.sessions}
            duration={0.18}
            type="fade"
            presenceMode="wait"
            className="mt-1 h-4"
          >
            {loading ? (
              <Skeleton key="loading" className="h-4 w-14" />
            ) : (
              <p key="ready" className="font-mono">
                {numberFormat(locale, step.sessions)}
              </p>
            )}
          </AutoTransition>
        </div>
        <div>
          <p className="text-muted-foreground">{labels.visitors}</p>
          <AutoTransition
            initial={false}
            transitionKey={loading ? "loading" : step.visitors}
            duration={0.18}
            type="fade"
            presenceMode="wait"
            className="mt-1 h-4"
          >
            {loading ? (
              <Skeleton key="loading" className="h-4 w-14" />
            ) : (
              <p key="ready" className="font-mono">
                {numberFormat(locale, step.visitors)}
              </p>
            )}
          </AutoTransition>
        </div>
      </div>
      <div className="grid min-w-0 grid-cols-2 gap-3 text-xs">
        <div>
          <p className="text-muted-foreground">{labels.stepConversion}</p>
          <AutoTransition
            initial={false}
            transitionKey={loading ? "loading" : step.stepConversionRate}
            duration={0.18}
            type="fade"
            presenceMode="wait"
            className="mt-1 h-4"
          >
            {loading ? (
              <Skeleton key="loading" className="h-4 w-14" />
            ) : (
              <p key="ready" className="font-mono">
                {percentFormat(locale, step.stepConversionRate)}
              </p>
            )}
          </AutoTransition>
        </div>
        <div>
          <p className="text-muted-foreground">{labels.dropOff}</p>
          <AutoTransition
            initial={false}
            transitionKey={loading ? "loading" : step.dropOffSessions}
            duration={0.18}
            type="fade"
            presenceMode="wait"
            className="mt-1 h-4"
          >
            {loading ? (
              <Skeleton key="loading" className="h-4 w-14" />
            ) : (
              <p key="ready" className="font-mono">
                {numberFormat(locale, step.dropOffSessions)}
              </p>
            )}
          </AutoTransition>
        </div>
      </div>
    </div>
  );
}

function createFunnelDetailPlaceholder(
  siteId: string,
  funnelId: string,
): FunnelDetailData {
  const steps: FunnelStep[] = [
    { type: "pageview", value: "" },
    { type: "event", value: "" },
    { type: "event", value: "" },
    { type: "pageview", value: "" },
  ];

  return {
    ok: true,
    data: {
      funnel: {
        id: funnelId,
        siteId,
        name: "",
        steps,
        createdAt: 0,
        updatedAt: 0,
      },
      analysis: {
        steps: steps.map((step, index) => ({
          index,
          label: step.value,
          type: step.type,
          sessions: 0,
          visitors: 0,
          conversionRate: 0,
          stepConversionRate: 0,
          dropOffSessions: 0,
          dropOffRate: 0,
        })),
        summary: {
          totalSessions: 0,
          convertedSessions: 0,
          totalVisitors: 0,
          convertedVisitors: 0,
          overallConversionRate: 0,
          largestDropOffStepIndex: null,
        },
      },
    },
  };
}

function FunnelDetailContent({
  locale,
  labels,
  payload,
  onDelete,
  loading = false,
}: {
  locale: Locale;
  labels: FunnelCopy;
  payload: FunnelDetailData;
  onDelete: (funnel: FunnelDefinition) => void;
  loading?: boolean;
}) {
  const { funnel, analysis } = payload.data;
  const largestDropOffStep =
    analysis.summary.largestDropOffStepIndex === null
      ? null
      : analysis.steps[analysis.summary.largestDropOffStepIndex];

  return (
    <div className="min-w-0 space-y-6 p-4 md:p-6">
      <div className="grid min-w-0 gap-4 md:grid-cols-[minmax(0,1fr)_auto]">
        <div className="min-w-0 space-y-2">
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            <AutoTransition
              initial={false}
              transitionKey={loading ? "loading" : funnel.name}
              duration={0.18}
              type="fade"
              presenceMode="wait"
              className="h-7 min-w-0 flex-1"
            >
              {loading ? (
                <Skeleton key="loading" className="h-7 w-56 max-w-full" />
              ) : (
                <h2 key="ready" className="truncate text-xl font-semibold">
                  {funnel.name}
                </h2>
              )}
            </AutoTransition>
            <AutoTransition
              initial={false}
              transitionKey={loading ? "loading" : funnel.steps.length}
              duration={0.18}
              type="fade"
              presenceMode="wait"
              className="h-5"
            >
              {loading ? (
                <Skeleton key="loading" className="h-5 w-8 rounded-full" />
              ) : (
                <Badge key="ready" variant="outline">
                  {numberFormat(locale, funnel.steps.length)}
                </Badge>
              )}
            </AutoTransition>
          </div>
          <AutoTransition
            initial={false}
            transitionKey={loading ? "loading" : funnel.updatedAt}
            duration={0.18}
            type="fade"
            presenceMode="wait"
            className="h-5"
          >
            {loading ? (
              <Skeleton key="loading" className="h-4 w-44" />
            ) : (
              <p key="ready" className="text-sm text-muted-foreground">
                {updatedLabel(locale, labels, funnel.updatedAt)}
              </p>
            )}
          </AutoTransition>
        </div>
        <Button
          type="button"
          variant="destructive"
          className="w-full sm:w-auto md:justify-self-end"
          disabled={loading}
          onClick={() => onDelete(funnel)}
        >
          <RiDeleteBinLine />
          {labels.delete}
        </Button>
      </div>

      <Card className="min-w-0 py-0">
        <CardContent className="p-0">
          <div className="grid gap-px overflow-hidden bg-border/70 sm:grid-cols-2 xl:grid-cols-4">
            <FunnelMetric
              label={labels.overallConversion}
              value={percentFormat(
                locale,
                analysis.summary.overallConversionRate,
              )}
              detail={`${numberFormat(locale, analysis.summary.convertedSessions)} / ${numberFormat(
                locale,
                analysis.summary.totalSessions,
              )} ${labels.sessions}`}
              loading={loading}
            />
            <FunnelMetric
              label={labels.startedSessions}
              value={numberFormat(locale, analysis.summary.totalSessions)}
              detail={numberFormat(locale, analysis.summary.totalVisitors)}
              loading={loading}
            />
            <FunnelMetric
              label={labels.convertedSessions}
              value={numberFormat(locale, analysis.summary.convertedSessions)}
              detail={`${numberFormat(locale, analysis.summary.convertedVisitors)} ${labels.convertedVisitors}`}
              loading={loading}
            />
            <FunnelMetric
              label={labels.largestDropOff}
              value={
                largestDropOffStep
                  ? numberFormat(locale, largestDropOffStep.dropOffSessions)
                  : labels.noDropOff
              }
              detail={
                largestDropOffStep
                  ? `${largestDropOffStep.label} ${percentFormat(
                      locale,
                      largestDropOffStep.dropOffRate,
                    )}`
                  : labels.noDropOff
              }
              loading={loading}
            />
          </div>
        </CardContent>
      </Card>

      <Card className="min-w-0">
        <CardHeader>
          <CardTitle className="inline-flex items-center gap-2">
            <RiArrowRightLine className="size-4" />
            {labels.step}
          </CardTitle>
          <CardDescription>{labels.listSubtitle}</CardDescription>
        </CardHeader>
        <CardContent className="px-0 py-0">
          {analysis.steps.map((step) => (
            <FunnelStepRow
              key={step.index}
              locale={locale}
              labels={labels}
              step={step}
              loading={loading}
            />
          ))}
        </CardContent>
      </Card>
    </div>
  );
}

function FunnelDetailDrawer({
  locale,
  messages,
  siteId,
  funnelId,
  onDelete,
}: {
  locale: Locale;
  messages: AppMessages;
  siteId: string;
  funnelId: string;
  onDelete: (funnel: FunnelDefinition) => void;
}) {
  const labels = messages.funnels;
  const { filters, window: timeWindow } = useDashboardQuery() as {
    filters: FilterDocument;
    window: TimeWindow;
  };
  const filtersKey = useMemo(() => filterQueryKey(filters), [filters]);
  const {
    data: payload,
    isError: error,
    isPending,
  } = useQuery({
    queryKey: [
      "dashboard",
      "funnel-detail",
      siteId,
      funnelId,
      timeWindow.from,
      timeWindow.to,
      timeWindow.timeZone,
      filtersKey,
    ],
    queryFn: ({ signal }) =>
      fetchFunnelDetail(siteId, funnelId, timeWindow, filters, { signal }),
    enabled: typeof window !== "undefined" && Boolean(funnelId),
  });
  const loading = isPending && !payload;

  if (error && !payload) {
    return (
      <div className="p-4 md:p-6">
        <FunnelStateCard
          title={labels.detailLoadError}
          subtitle={messages.funnels.subtitle}
        />
      </div>
    );
  }

  return (
    <FunnelDetailContent
      locale={locale}
      labels={labels}
      payload={payload ?? createFunnelDetailPlaceholder(siteId, funnelId)}
      onDelete={onDelete}
      loading={loading}
    />
  );
}

export function FunnelsClientPage({
  locale,
  messages,
  siteId,
  pathname,
}: FunnelsClientPageProps) {
  const labels = messages.funnels;
  const { filters, window: timeWindow } = useDashboardQuery() as {
    filters: FilterDocument;
    window: TimeWindow;
  };
  const searchParams = useLiveSearchParams();
  const detailFunnelId = searchParams.get(DETAIL_QUERY_PARAM)?.trim() || "";
  const openedDetailFromListRef = useRef(false);
  const queryClient = useQueryClient();
  const [createOpen, setCreateOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<FunnelDefinition | null>(
    null,
  );
  const [deleting, setDeleting] = useState(false);
  const filtersKey = useMemo(() => filterQueryKey(filters), [filters]);
  const funnelsQueryKey = useMemo(
    () => ["dashboard", "funnels", siteId] as const,
    [siteId],
  );
  const {
    data: funnelsData,
    isError: error,
    isPending: loading,
  } = useInfiniteQuery({
    queryKey: funnelsQueryKey,
    initialPageParam: null as string | null,
    queryFn: ({ signal, pageParam }) =>
      fetchFunnels(siteId, { limit: 50, cursor: pageParam, signal }),
    enabled: typeof window !== "undefined",
    getNextPageParam: (lastPage) =>
      lastPage.data?.pagination?.hasMore
        ? lastPage.data.pagination.nextCursor
        : undefined,
  });
  const funnels = funnelsData?.pages.flatMap((page) => page.data.items) ?? [];

  useEffect(() => {
    if (!detailFunnelId) openedDetailFromListRef.current = false;
  }, [detailFunnelId]);

  const candidatesQuery = useQuery({
    queryKey: [
      "dashboard",
      "funnel-candidates",
      siteId,
      timeWindow.from,
      timeWindow.to,
      timeWindow.timeZone,
      filtersKey,
    ],
    queryFn: async ({ signal }) => {
      const [pageviews, events] = await Promise.all([
        fetchOverviewPageCardTab(siteId, timeWindow, "path", filters, {
          limit: 100,
          signal,
        }),
        fetchEventTypesTab(siteId, timeWindow, filters, { limit: 100, signal }),
      ]);
      return {
        pageviews: pageviews.items.map((row) => row.label).filter(Boolean),
        events: events.items.map((row) => row.label).filter(Boolean),
      };
    },
    enabled: typeof window !== "undefined" && createOpen,
  });
  const candidates = candidatesQuery.data ?? emptyCandidates();

  const openFunnelDetail = useCallback(
    (funnelId: string) => {
      openedDetailFromListRef.current = true;
      pushUrlWithoutNavigation(
        detailQueryTarget(pathname, searchParams, funnelId),
      );
    },
    [pathname, searchParams],
  );

  const closeFunnelDetail = useCallback(() => {
    const params = new URLSearchParams(window.location.search);
    if (!params.has(DETAIL_QUERY_PARAM)) return;

    if (openedDetailFromListRef.current) {
      openedDetailFromListRef.current = false;
      window.history.back();
      return;
    }

    params.delete(DETAIL_QUERY_PARAM);
    const query = serializeDashboardSearchParams(params);
    replaceUrlWithoutNavigation(query ? `${pathname}?${query}` : pathname);
  }, [pathname]);

  const handleCreate = useCallback(
    async (name: string, steps: FunnelStep[]) => {
      setCreating(true);
      try {
        const payload = await createFunnel(siteId, name, steps);
        await queryClient.invalidateQueries({ queryKey: funnelsQueryKey });
        setCreateOpen(false);
        toast.success(labels.created);
        openFunnelDetail(payload.data.funnel.id);
      } catch (error) {
        const message =
          error instanceof Error && error.message
            ? error.message
            : labels.createFailed;
        toast.error(message);
      } finally {
        setCreating(false);
      }
    },
    [
      funnelsQueryKey,
      labels.createFailed,
      labels.created,
      openFunnelDetail,
      queryClient,
      siteId,
    ],
  );

  const handleDelete = useCallback(async () => {
    const target = deleteTarget;
    if (!target) return;
    setDeleting(true);
    try {
      await deleteFunnel(siteId, target.id);
      await queryClient.invalidateQueries({ queryKey: funnelsQueryKey });
      if (detailFunnelId === target.id) closeFunnelDetail();
      setDeleteTarget(null);
      toast.success(labels.deleted);
    } catch (error) {
      const message =
        error instanceof Error && error.message
          ? error.message
          : labels.deleteFailed;
      toast.error(message);
    } finally {
      setDeleting(false);
    }
  }, [
    closeFunnelDetail,
    deleteTarget,
    detailFunnelId,
    funnelsQueryKey,
    labels.deleteFailed,
    labels.deleted,
    queryClient,
    siteId,
  ]);

  const bodyState = loading
    ? "loading"
    : error
      ? "error"
      : funnels.length === 0
        ? "empty"
        : "ready";

  return (
    <div className="min-w-0 max-w-full space-y-6">
      <div className="grid min-w-0 gap-4 md:grid-cols-[minmax(0,1fr)_auto] md:items-start">
        <PageHeading
          title={messages.funnels.title}
          subtitle={messages.funnels.subtitle}
        />
        <Button
          type="button"
          className="w-full sm:w-auto md:justify-self-end"
          onClick={() => setCreateOpen(true)}
        >
          <RiAddLine />
          {labels.create}
        </Button>
      </div>

      <AutoTransition
        transitionKey={bodyState}
        duration={0.18}
        type="fade"
        presenceMode="wait"
      >
        {loading ? (
          <FunnelListLoading />
        ) : error ? (
          <FunnelStateCard
            title={labels.loadError}
            subtitle={messages.funnels.subtitle}
          />
        ) : funnels.length === 0 ? (
          <FunnelStateCard
            title={labels.empty}
            subtitle={labels.emptyHint}
            action={
              <Button type="button" onClick={() => setCreateOpen(true)}>
                <RiAddLine />
                {labels.create}
              </Button>
            }
          />
        ) : (
          <FunnelList
            locale={locale}
            labels={labels}
            funnels={funnels}
            selectedId={detailFunnelId}
            onOpen={openFunnelDetail}
            onDelete={setDeleteTarget}
          />
        )}
      </AutoTransition>

      <CreateFunnelDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        locale={locale}
        labels={labels}
        candidates={candidates}
        submitting={creating}
        onCreate={handleCreate}
      />

      {detailFunnelId ? (
        <DetailDrawer
          ariaLabel={messages.funnels.title}
          drawerKey={`funnel:${detailFunnelId}`}
          open={Boolean(detailFunnelId)}
          onOpenChange={(nextOpen) => {
            if (!nextOpen) closeFunnelDetail();
          }}
        >
          <FunnelDetailDrawer
            locale={locale}
            messages={messages}
            siteId={siteId}
            funnelId={detailFunnelId}
            onDelete={setDeleteTarget}
          />
        </DetailDrawer>
      ) : null}

      <AlertDialog
        open={Boolean(deleteTarget)}
        onOpenChange={(open) => {
          if (!open && !deleting) setDeleteTarget(null);
        }}
      >
        <AlertDialogContent size="sm">
          <AlertDialogHeader>
            <AlertDialogTitle icon={RiDeleteBinLine}>
              {labels.deleteTitle}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {labels.deleteDescription}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deleting}>
              <RiCloseLine className="size-4" />
              <span>{labels.cancel}</span>
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
                <>
                  <Spinner className="size-4" />
                  <span>{labels.deleting}</span>
                </>
              ) : (
                <>
                  <RiDeleteBinLine className="size-4" />
                  <span>{labels.deleteConfirm}</span>
                </>
              )}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
