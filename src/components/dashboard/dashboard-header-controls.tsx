import type { CSSProperties } from "react";
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { type DateRange } from "react-day-picker";
import {
  RiArrowDownSLine,
  RiArrowLeftSLine,
  RiArrowRightSLine,
  RiCalendarLine,
  RiCheckLine,
  RiCloseLine,
  RiFilter3Line,
  RiTimeLine,
} from "@remixicon/react";

import { useDashboardQueryControls } from "@/components/dashboard/dashboard-query-provider";
import { FilterPanel } from "@/components/dashboard/filter-panel";
import {
  RealtimeStatusDot,
  realtimeStatusText,
} from "@/components/dashboard/realtime-status-indicator";
import { AnimatedNumber } from "@/components/ui/animated-number";
import { AutoResizer } from "@/components/ui/auto-resizer";
import { AutoTransition } from "@/components/ui/auto-transition";
import { Button } from "@/components/ui/button";
import { ButtonGroup } from "@/components/ui/button-group";
import { Calendar } from "@/components/ui/calendar";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Drawer,
  DrawerClose,
  DrawerContent,
  DrawerDescription,
  DrawerFooter,
  DrawerHeader,
  DrawerScrollArea,
  DrawerTitle,
  DrawerTrigger,
} from "@/components/ui/drawer";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Label } from "@/components/ui/label";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { useRealtimeChannelSelector } from "@/hooks/use-realtime-channel";
import {
  replaceUrlWithoutNavigation,
  useLiveSearchParams,
} from "@/lib/client-history";
import {
  serializeDashboardSearchParams,
  withDashboardFilterSearchParams,
} from "@/lib/dashboard/filter-state";
import { intlLocale } from "@/lib/dashboard/format";
import {
  type CustomTimeRange,
  type DashboardInterval,
  normalizeCustomDateRange,
  parseFilterDocumentFromSearchParams,
  parseFilterScopeFromSearchParams,
  type RangePreset,
  serializeFilterScopeToSearchParams,
} from "@/lib/dashboard/query-state";
import { zonedParts } from "@/lib/dashboard/time-zone";
import {
  analyticsFilterRegistry,
  attachFilterScopePreference,
  type FilterDocument,
  type FilterScope,
  type FilterScopePreference,
  filterScopePreferenceFromDocument,
  serializeFilterParams,
} from "@/lib/filter-contract";
import type { Locale } from "@/lib/i18n/config";
import type { AppMessages } from "@/lib/i18n/messages";
import { formatI18nTemplate } from "@/lib/i18n/template";
import { isRealtimeMockEnabled } from "@/lib/realtime/client";
import type {
  RealtimeChannelState,
  RealtimeConnectionState,
} from "@/lib/realtime/types";
import { usePathname } from "@/lib/router";
import { cn } from "@/lib/utils";

interface DashboardHeaderControlsProps {
  locale: Locale;
  messages: AppMessages;
  siteId?: string;
  showControls: boolean;
  showFilterSheet: boolean;
  filterDisabled?: boolean;
  filterAudience?: "private-dashboard" | "public-share";
  /** Concrete scope selected by the active dashboard page for Auto filters. */
  resolvedScope?: FilterScope;
  showRealtimeBadge?: boolean;
}

const INTERVAL_ORDER: readonly DashboardInterval[] = [
  "minute",
  "hour",
  "day",
  "week",
  "month",
] as const;
const ROLLING_RANGE_PRESETS = new Set<RangePreset>([
  "30m",
  "1h",
  "24h",
  "7d",
  "30d",
  "90d",
  "6m",
  "12m",
]);
const USE_REALTIME_MOCK = isRealtimeMockEnabled();

const selectRealtimeHeaderState = (state: RealtimeChannelState) => ({
  activeNow: state.activeNow,
  status: state.status,
  hasConnected: state.hasConnected,
});
type RealtimeHeaderState = ReturnType<typeof selectRealtimeHeaderState>;

const areRealtimeHeaderStatesEqual = (
  left: RealtimeHeaderState,
  right: RealtimeHeaderState,
) =>
  left.activeNow === right.activeNow &&
  left.status === right.status &&
  left.hasConnected === right.hasConnected;

function rangeLabel(messages: AppMessages, range: RangePreset): string {
  if (range === "30m") return messages.ranges.last30m;
  if (range === "1h") return messages.ranges.last1h;
  if (range === "today") return messages.ranges.today;
  if (range === "yesterday") return messages.ranges.yesterday;
  if (range === "thisWeek") return messages.ranges.thisWeek;
  if (range === "thisMonth") return messages.ranges.thisMonth;
  if (range === "thisYear") return messages.ranges.thisYear;
  if (range === "24h") return messages.ranges.last24h;
  if (range === "7d") return messages.ranges.last7d;
  if (range === "30d") return messages.ranges.last30d;
  if (range === "90d") return messages.ranges.last90d;
  if (range === "6m") return messages.ranges.last6m;
  if (range === "12m") return messages.ranges.last12m;
  if (range === "all") return messages.ranges.allTime;
  if (range === "custom") return messages.ranges.custom;
  return messages.ranges.last30d;
}

function intervalLabel(
  messages: AppMessages,
  interval: DashboardInterval,
): string {
  if (interval === "minute") return messages.intervals.minute;
  if (interval === "hour") return messages.intervals.hour;
  if (interval === "day") return messages.intervals.day;
  if (interval === "week") return messages.intervals.week;
  return messages.intervals.month;
}

function toCalendarDate(timestampMs: number, timeZone: string): Date | null {
  if (!Number.isFinite(timestampMs)) return null;
  const parts = zonedParts(timestampMs, timeZone);
  return new Date(parts.year, parts.month - 1, parts.day);
}

function toDateRange(
  from: number | undefined,
  to: number | undefined,
  timeZone: string,
): DateRange | undefined {
  if (!Number.isFinite(from) || !Number.isFinite(to)) return undefined;
  const fromDate = toCalendarDate(from as number, timeZone);
  const toDate = toCalendarDate(to as number, timeZone);
  if (!fromDate || !toDate) return undefined;
  return {
    from: fromDate,
    to: toDate,
  };
}

function formatDateSpan(
  locale: Locale,
  timeZone: string,
  from?: number,
  to?: number,
): string {
  if (!Number.isFinite(from) || !Number.isFinite(to)) return "";
  const formatter = new Intl.DateTimeFormat(intlLocale(locale), {
    year: "numeric",
    month: "short",
    day: "numeric",
    timeZone,
  });
  return `${formatter.format(new Date(from as number))} - ${formatter.format(new Date(to as number))}`;
}

function shiftTimeWindow(
  from: number,
  to: number,
  direction: "previous" | "next",
  now = Date.now(),
): { from: number; to: number } | null {
  const normalizedFrom = Math.max(0, Math.floor(from));
  const normalizedTo = Math.max(normalizedFrom + 1, Math.floor(to));
  const span = Math.max(1, normalizedTo - normalizedFrom);

  if (direction === "previous") {
    const previousTo = Math.max(normalizedFrom - 1, 0);
    const previousFrom = Math.max(previousTo - span, 0);
    if (previousFrom >= previousTo) return null;
    return {
      from: previousFrom,
      to: previousTo,
    };
  }

  const currentNow = Math.max(1, Math.floor(now));
  if (normalizedTo >= currentNow) return null;

  const nextFromCandidate = normalizedTo + 1;
  const nextToCandidate = nextFromCandidate + span;
  const nextTo = Math.min(nextToCandidate, currentNow);
  const nextFrom = Math.max(0, nextTo - span);

  if (nextFrom >= nextTo) return null;
  if (nextFrom === normalizedFrom && nextTo === normalizedTo) return null;

  return {
    from: nextFrom,
    to: nextTo,
  };
}

const RANGE_GROUPS: ReadonlyArray<{
  key: "quick" | "calendar" | "rolling" | "advanced";
  items: ReadonlyArray<RangePreset>;
}> = [
  {
    key: "quick",
    items: ["30m", "1h", "today", "yesterday"],
  },
  {
    key: "calendar",
    items: ["thisWeek", "thisMonth", "thisYear"],
  },
  {
    key: "rolling",
    items: ["24h", "7d", "30d", "90d", "6m", "12m"],
  },
  {
    key: "advanced",
    items: ["all", "custom"],
  },
];

function rangeGroupLabel(
  messages: AppMessages,
  key: "quick" | "calendar" | "rolling" | "advanced",
): string {
  if (key === "quick") return messages.dashboardHeader.rangeGroupQuick;
  if (key === "calendar") return messages.dashboardHeader.rangeGroupCalendar;
  if (key === "rolling") return messages.dashboardHeader.rangeGroupRolling;
  return messages.dashboardHeader.rangeGroupAdvanced;
}

function intervalDisabledReason(
  messages: AppMessages,
  interval: DashboardInterval,
): string {
  if (interval === "minute")
    return messages.dashboardHeader.intervalDisabledMinute;
  if (interval === "hour") return messages.dashboardHeader.intervalDisabledHour;
  if (interval === "day") return messages.dashboardHeader.intervalDisabledDay;
  if (interval === "week") return messages.dashboardHeader.intervalDisabledWeek;
  return "";
}

function RealtimeActiveBadge({
  activeNow,
  status,
  showValue,
  label,
  messages,
}: {
  activeNow: number;
  status: RealtimeConnectionState;
  showValue: boolean;
  label: string;
  messages: AppMessages;
}) {
  const statusText = realtimeStatusText(messages, status);
  const valueText = showValue ? String(activeNow) : "--";

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <div className="inline-flex h-9 items-center px-1 text-xs font-medium text-foreground/90">
          <AutoTransition
            type="fade"
            duration={0.16}
            initial={false}
            presenceMode="wait"
            className="inline-flex items-center"
          >
            {showValue ? (
              <span key="active-now-value" className="inline-flex items-center">
                <AnimatedNumber
                  value={activeNow}
                  continuous
                  className="font-mono tabular-nums"
                />
              </span>
            ) : (
              <span
                key="active-now-empty"
                className="inline-flex w-0 overflow-hidden"
                aria-hidden
              />
            )}
          </AutoTransition>
          <span className={showValue ? "ml-2" : ""}>
            <RealtimeStatusDot status={status} />
          </span>
        </div>
      </TooltipTrigger>
      <TooltipContent side="bottom">{`${label}: ${valueText} · ${statusText}`}</TooltipContent>
    </Tooltip>
  );
}

function FilterActiveCountBadge({ count }: { count: number }) {
  const hasCount = count > 0;

  return (
    <AutoResizer
      initial
      animateWidth
      animateHeight={false}
      className="inline-flex shrink-0 items-center"
    >
      <AutoTransition
        className="inline-block"
        duration={0.2}
        type="fade"
        initial={false}
        presenceMode="wait"
        customVariants={{
          initial: { opacity: 0 },
          animate: { opacity: 1 },
          exit: { opacity: 0 },
        }}
      >
        {hasCount ? (
          <span
            key={`active-filter-count-${count}`}
            className="inline-flex min-w-5 items-center justify-center rounded-full border border-primary/40 bg-primary/15 px-1.5 text-[11px] leading-4 font-semibold text-primary"
          >
            {count}
          </span>
        ) : (
          <span
            key="active-filter-count-empty"
            className="inline-flex w-0 overflow-hidden"
            aria-hidden
          />
        )}
      </AutoTransition>
    </AutoResizer>
  );
}

function FilterTrigger({
  activeFilterCount,
  className,
  disabled,
  messages,
  onClick,
  scopePreference,
  style,
}: {
  activeFilterCount: number;
  className: string;
  disabled: boolean;
  messages: AppMessages;
  onClick: () => void;
  scopePreference: FilterScopePreference;
  style?: CSSProperties;
}) {
  const filterButtonLabel =
    scopePreference === "event"
      ? messages.dashboardHeader.filterButtonEvent
      : scopePreference === "session"
        ? messages.dashboardHeader.filterButtonSession
        : scopePreference === "visitor"
          ? messages.dashboardHeader.filterButtonVisitor
          : messages.dashboardHeader.filterButton;

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span tabIndex={disabled ? 0 : undefined} className="inline-flex">
          <Button
            type="button"
            variant="outline"
            className={className}
            disabled={disabled}
            onClick={onClick}
            style={style}
          >
            <RiFilter3Line
              className={cn(
                "size-4",
                activeFilterCount === 0 && "text-muted-foreground",
              )}
            />
            <AutoResizer
              initial
              animateWidth
              animateHeight={false}
              className="inline-flex min-w-0 items-center"
            >
              <AutoTransition
                as="span"
                className="inline-block whitespace-nowrap"
                duration={0.2}
                initial={false}
                presenceMode="wait"
                transitionKey={scopePreference}
                type="fade"
              >
                {filterButtonLabel}
              </AutoTransition>
            </AutoResizer>
            <FilterActiveCountBadge count={activeFilterCount} />
          </Button>
        </span>
      </TooltipTrigger>
      {disabled ? (
        <TooltipContent side="bottom">
          {messages.dashboardHeader.filterDisabledRealtime}
        </TooltipContent>
      ) : null}
    </Tooltip>
  );
}

export const DashboardHeaderControls = memo(function DashboardHeaderControls({
  locale,
  messages,
  siteId,
  showControls,
  showFilterSheet,
  filterDisabled = false,
  filterAudience = "private-dashboard",
  resolvedScope,
  showRealtimeBadge: shouldShowRealtimeBadge = true,
}: DashboardHeaderControlsProps) {
  const searchParams = useLiveSearchParams();
  const livePathname = usePathname() || "/";
  const {
    range,
    window,
    customRange,
    setRange,
    setCustomRange,
    setInterval: setDashboardInterval,
    setUiFilters,
    scopePreference,
    setScopePreference,
    uiFilterDsl,
    allowedIntervals,
    timeZone,
    maxRangeDays,
  } = useDashboardQueryControls();
  const searchParamsKey = searchParams.toString();
  const queryDocument = useMemo(
    () =>
      parseFilterDocumentFromSearchParams(new URLSearchParams(searchParamsKey)),
    [searchParamsKey],
  );
  const urlScopePreference = useMemo(
    () =>
      parseFilterScopeFromSearchParams(new URLSearchParams(searchParamsKey)),
    [searchParamsKey],
  );
  const activeFilterCount = useMemo(
    () => serializeFilterParams(queryDocument, analyticsFilterRegistry).size,
    [queryDocument],
  );
  const filterSuggestionScope =
    resolvedScope ?? (filterDisabled ? undefined : "event");
  const hasActiveFilters = activeFilterCount > 0;
  const filterTriggerClassName = cn(
    "gap-2 transition-[color,background-color,border-color,opacity]",
    hasActiveFilters &&
      "!border-primary/60 !bg-primary/10 !text-primary hover:!bg-primary/15 hover:!text-primary aria-expanded:!bg-primary/15 dark:!border-primary/60 dark:!bg-primary/20 dark:hover:!bg-primary/25",
  );
  const filterTriggerStyle = hasActiveFilters
    ? {
        borderColor: "hsl(var(--primary) / 0.6)",
        backgroundColor: "hsl(var(--primary) / 0.12)",
        color: "hsl(var(--primary))",
      }
    : undefined;

  const selectedDateRange = useMemo(
    () => toDateRange(customRange?.from, customRange?.to, timeZone),
    [customRange?.from, customRange?.to, timeZone],
  );
  const [customDialogOpen, setCustomDialogOpen] = useState(false);
  const [mobileFilterDrawerOpen, setMobileFilterDrawerOpen] = useState(false);
  const [desktopFilterSheetOpen, setDesktopFilterSheetOpen] = useState(false);
  const [mobileTimeDrawerOpen, setMobileTimeDrawerOpen] = useState(false);
  const [periodForwardStack, setPeriodForwardStack] = useState<
    CustomTimeRange[]
  >([]);
  const openCustomDialogTimeoutRef = useRef<ReturnType<
    typeof globalThis.setTimeout
  > | null>(null);
  const [pendingCustomRange, setPendingCustomRange] = useState<
    DateRange | undefined
  >(selectedDateRange);
  const realtimeSiteId =
    siteId || (USE_REALTIME_MOCK ? "local-mock-site" : undefined);
  const showRealtimeBadge =
    shouldShowRealtimeBadge &&
    showFilterSheet &&
    (Boolean(siteId) || USE_REALTIME_MOCK);
  const realtimeEnabled = showControls && showRealtimeBadge;
  const realtimeHeaderState = useRealtimeChannelSelector(
    realtimeSiteId,
    selectRealtimeHeaderState,
    areRealtimeHeaderStatesEqual,
    { enabled: realtimeEnabled },
  );
  const {
    activeNow,
    status: realtimeStatus,
    hasConnected: hasRealtimeConnected,
  } = realtimeHeaderState;

  const orderedAllowedIntervals = INTERVAL_ORDER.filter((value) =>
    allowedIntervals.includes(value),
  );
  const rangeGroups = useMemo(
    () =>
      RANGE_GROUPS.map((group) => ({
        ...group,
        items: group.items.filter((item) => {
          if (!maxRangeDays) return true;
          if (item === "all") return false;
          if (maxRangeDays <= 90) {
            return item !== "6m" && item !== "12m";
          }
          return true;
        }),
      })).filter((group) => group.items.length > 0),
    [maxRangeDays],
  );
  const rangeLabelText = rangeLabel(messages, range);
  const intervalLabelText = intervalLabel(messages, window.interval);
  const pendingNormalized = normalizeCustomDateRange(
    pendingCustomRange,
    timeZone,
  );
  const previousPeriodRange = shiftTimeWindow(
    window.from,
    window.to,
    "previous",
  );
  const inferredNextPeriodRange = shiftTimeWindow(
    window.from,
    window.to,
    "next",
  );
  const canShiftToNextPeriod = !ROLLING_RANGE_PRESETS.has(range);
  const nextPeriodRange = canShiftToNextPeriod
    ? (periodForwardStack[0] ?? inferredNextPeriodRange)
    : null;
  const previousPeriodLabel = messages.dashboardHeader.previousPeriod;
  const nextPeriodLabel = messages.dashboardHeader.nextPeriod;
  const mobileTimeLabel = messages.common.time;
  const cycleLabel = messages.common.cycle;
  const closeLabel = messages.common.close;
  const naturalSelectionText = useMemo(() => {
    if (!pendingCustomRange?.from && !pendingCustomRange?.to) {
      return messages.dashboardHeader.customHint;
    }
    if (pendingCustomRange?.from && !pendingCustomRange?.to) {
      return messages.dashboardHeader.customPendingEnd;
    }
    if (!pendingNormalized) {
      return messages.dashboardHeader.customHint;
    }

    const formatter = new Intl.DateTimeFormat(intlLocale(locale), {
      year: "numeric",
      month: "long",
      day: "numeric",
      timeZone,
    });
    const dayCount = Math.max(
      1,
      Math.round(
        (pendingNormalized.to - pendingNormalized.from) / (24 * 60 * 60 * 1000),
      ),
    );
    return formatI18nTemplate(messages.dashboardHeader.customSelectionSummary, {
      from: formatter.format(new Date(pendingNormalized.from)),
      to: formatter.format(new Date(pendingNormalized.to)),
      days: dayCount,
    });
  }, [
    locale,
    messages.dashboardHeader.customSelectionSummary,
    messages.dashboardHeader.customHint,
    messages.dashboardHeader.customPendingEnd,
    pendingCustomRange?.from,
    pendingCustomRange?.to,
    pendingNormalized,
    timeZone,
  ]);

  useEffect(() => {
    return () => {
      if (openCustomDialogTimeoutRef.current !== null) {
        globalThis.clearTimeout(openCustomDialogTimeoutRef.current);
      }
    };
  }, []);

  useEffect(() => {
    if (scopePreference !== urlScopePreference) {
      setScopePreference(urlScopePreference);
    }
  }, [scopePreference, setScopePreference, urlScopePreference]);

  const handleScopeChange = useCallback(
    (next: FilterScopePreference) => {
      setScopePreference(next);
      const params = serializeFilterScopeToSearchParams(searchParams, next);
      const updated = serializeDashboardSearchParams(params);
      const current = serializeDashboardSearchParams(searchParams);
      if (updated !== current) {
        const target = updated ? `${livePathname}?${updated}` : livePathname;
        replaceUrlWithoutNavigation(target);
      }
    },
    [livePathname, searchParams, setScopePreference],
  );

  useEffect(() => {
    setPeriodForwardStack([]);
  }, [siteId]);

  const applyFilterDocument = useCallback(
    (
      nextDocument: FilterDocument,
      rawDsl?: string,
      options?: { readonly closePanel?: boolean },
    ) => {
      const nextScope =
        filterScopePreferenceFromDocument(nextDocument) ?? scopePreference;
      const scopedDocument = attachFilterScopePreference(
        nextDocument,
        nextScope,
      );
      setUiFilters(scopedDocument, rawDsl);
      const params = serializeFilterScopeToSearchParams(
        withDashboardFilterSearchParams(searchParams, scopedDocument),
        nextScope,
      );
      const updated = serializeDashboardSearchParams(params);
      const current = serializeDashboardSearchParams(searchParams);
      if (updated !== current) {
        const target = updated ? `${livePathname}?${updated}` : livePathname;
        replaceUrlWithoutNavigation(target);
      }
      if (options?.closePanel !== false) {
        setMobileFilterDrawerOpen(false);
        setDesktopFilterSheetOpen(false);
      }
    },
    [livePathname, scopePreference, searchParams, setUiFilters],
  );

  const queueOpenCustomDialog = () => {
    if (openCustomDialogTimeoutRef.current !== null) {
      globalThis.clearTimeout(openCustomDialogTimeoutRef.current);
    }
    openCustomDialogTimeoutRef.current = globalThis.setTimeout(() => {
      openCustomDialogTimeoutRef.current = null;
      setCustomDialogOpen(true);
    }, 0);
  };

  const handleRangeValueChange = (
    value: RangePreset,
    source: "desktop" | "mobile" = "desktop",
  ) => {
    setPeriodForwardStack([]);
    setRange(value);
    if (value !== "custom") return;
    setPendingCustomRange(selectedDateRange);
    if (source === "mobile") {
      setMobileTimeDrawerOpen(false);
    }
    queueOpenCustomDialog();
  };

  const handleIntervalValueChange = (value: DashboardInterval) => {
    if (!orderedAllowedIntervals.includes(value)) return;
    setDashboardInterval(value);
  };

  const handleShiftToPreviousPeriod = () => {
    if (!previousPeriodRange) return;
    setPeriodForwardStack((current) => [
      {
        from: window.from,
        to: window.to,
      },
      ...current,
    ]);
    setCustomRange(previousPeriodRange);
  };

  const handleShiftToNextPeriod = () => {
    if (!canShiftToNextPeriod) return;
    if (periodForwardStack.length > 0) {
      const [nextRange, ...rest] = periodForwardStack;
      setPeriodForwardStack(rest);
      setCustomRange(nextRange);
      return;
    }
    if (!inferredNextPeriodRange) return;
    setCustomRange(inferredNextPeriodRange);
  };

  if (!showControls) return null;

  return (
    <>
      <div className="flex min-w-0 max-w-full flex-wrap items-center justify-end gap-2">
        <div className="flex items-center justify-end gap-2 lg:hidden">
          {showRealtimeBadge ? (
            <RealtimeActiveBadge
              activeNow={activeNow}
              status={realtimeStatus}
              showValue={hasRealtimeConnected}
              label={messages.realtime.activeNow}
              messages={messages}
            />
          ) : null}
          {showFilterSheet ? (
            <Drawer
              open={mobileFilterDrawerOpen}
              onOpenChange={setMobileFilterDrawerOpen}
            >
              <FilterTrigger
                activeFilterCount={activeFilterCount}
                className={filterTriggerClassName}
                disabled={filterDisabled}
                messages={messages}
                onClick={() => setMobileFilterDrawerOpen(true)}
                scopePreference={scopePreference}
                style={filterTriggerStyle}
              />
              <DrawerContent className="h-[80dvh] max-h-[80dvh] flex flex-col overflow-hidden">
                <DrawerHeader>
                  <DrawerTitle>
                    {messages.dashboardHeader.filterTitle}
                  </DrawerTitle>
                  <DrawerDescription>
                    {messages.dashboardHeader.filterSubtitle}
                  </DrawerDescription>
                </DrawerHeader>
                <DrawerScrollArea
                  className="overflow-hidden"
                  contentClassName="px-4"
                >
                  <FilterPanel
                    audience={filterAudience}
                    document={queryDocument}
                    expressionText={uiFilterDsl}
                    messages={messages}
                    open={mobileFilterDrawerOpen}
                    resolvedScope={filterSuggestionScope}
                    siteId={siteId}
                    scopePreference={scopePreference}
                    window={window}
                    onApply={applyFilterDocument}
                    onScopeChange={handleScopeChange}
                  />
                </DrawerScrollArea>
              </DrawerContent>
            </Drawer>
          ) : null}

          <Drawer
            open={mobileTimeDrawerOpen}
            onOpenChange={setMobileTimeDrawerOpen}
          >
            <DrawerTrigger asChild>
              <Button variant="outline" className="gap-2">
                <RiTimeLine className="size-4" />
                {mobileTimeLabel}
              </Button>
            </DrawerTrigger>
            <DrawerContent className="max-h-[80dvh]">
              <DrawerHeader>
                <DrawerTitle>{mobileTimeLabel}</DrawerTitle>
                <DrawerDescription>
                  {rangeLabelText} / {intervalLabelText}
                </DrawerDescription>
              </DrawerHeader>

              <DrawerScrollArea contentClassName="space-y-4 px-4 pb-2">
                <div className="space-y-2">
                  <Label>{cycleLabel}</Label>
                  <ButtonGroup className="w-full">
                    <Button
                      type="button"
                      variant="outline"
                      className="flex-1 justify-center gap-1"
                      disabled={!previousPeriodRange}
                      onClick={handleShiftToPreviousPeriod}
                    >
                      <RiArrowLeftSLine className="size-4" />
                      <span>{previousPeriodLabel}</span>
                    </Button>
                    <Button
                      type="button"
                      variant="outline"
                      className="flex-1 justify-center gap-1"
                      disabled={!nextPeriodRange}
                      onClick={handleShiftToNextPeriod}
                    >
                      <span>{nextPeriodLabel}</span>
                      <RiArrowRightSLine className="size-4" />
                    </Button>
                  </ButtonGroup>
                </div>

                <div className="space-y-3">
                  <Label>{messages.dashboardHeader.range}</Label>
                  {rangeGroups.map((group) => (
                    <div key={group.key} className="space-y-2">
                      <p className="text-[11px] text-muted-foreground">
                        {rangeGroupLabel(messages, group.key)}
                      </p>
                      <div className="grid grid-cols-2 gap-2">
                        {group.items.map((item) => (
                          <Button
                            key={item}
                            type="button"
                            size="sm"
                            variant={range === item ? "default" : "outline"}
                            className="justify-start truncate px-2"
                            onClick={() => {
                              handleRangeValueChange(item, "mobile");
                            }}
                          >
                            <RiCalendarLine className="size-3.5" />
                            <span>{rangeLabel(messages, item)}</span>
                          </Button>
                        ))}
                      </div>
                    </div>
                  ))}
                </div>

                <div className="space-y-2">
                  <Label>{messages.dashboardHeader.interval}</Label>
                  <div className="grid grid-cols-3 gap-2">
                    {INTERVAL_ORDER.map((item) => {
                      const enabled = orderedAllowedIntervals.includes(item);
                      return (
                        <Button
                          key={item}
                          type="button"
                          size="sm"
                          variant={
                            window.interval === item ? "default" : "outline"
                          }
                          className="justify-start px-2"
                          disabled={!enabled}
                          title={
                            enabled
                              ? undefined
                              : intervalDisabledReason(messages, item)
                          }
                          onClick={() => {
                            handleIntervalValueChange(item);
                          }}
                        >
                          <RiTimeLine className="size-3.5" />
                          <span>{intervalLabel(messages, item)}</span>
                        </Button>
                      );
                    })}
                  </div>
                </div>
              </DrawerScrollArea>

              <DrawerFooter>
                <DrawerClose asChild>
                  <Button>
                    <RiCloseLine className="size-4" />
                    <span>{closeLabel}</span>
                  </Button>
                </DrawerClose>
              </DrawerFooter>
            </DrawerContent>
          </Drawer>
        </div>

        <div className="hidden min-w-0 max-w-full flex-wrap items-center justify-end gap-2 lg:flex">
          {showRealtimeBadge ? (
            <RealtimeActiveBadge
              activeNow={activeNow}
              status={realtimeStatus}
              showValue={hasRealtimeConnected}
              label={messages.realtime.activeNow}
              messages={messages}
            />
          ) : null}
          {showFilterSheet ? (
            <Sheet
              modal={false}
              open={desktopFilterSheetOpen}
              onOpenChange={setDesktopFilterSheetOpen}
            >
              <FilterTrigger
                activeFilterCount={activeFilterCount}
                className={filterTriggerClassName}
                disabled={filterDisabled}
                messages={messages}
                onClick={() => setDesktopFilterSheetOpen(true)}
                scopePreference={scopePreference}
                style={filterTriggerStyle}
              />
              <SheetContent
                side="right"
                className="flex h-full max-h-screen w-full flex-col sm:max-w-md"
              >
                <SheetHeader>
                  <SheetTitle>
                    {messages.dashboardHeader.filterTitle}
                  </SheetTitle>
                  <SheetDescription>
                    {messages.dashboardHeader.filterSubtitle}
                  </SheetDescription>
                </SheetHeader>

                <div className="min-h-0 flex-1 px-4">
                  <FilterPanel
                    audience={filterAudience}
                    document={queryDocument}
                    expressionText={uiFilterDsl}
                    messages={messages}
                    open={desktopFilterSheetOpen}
                    resolvedScope={filterSuggestionScope}
                    siteId={siteId}
                    scopePreference={scopePreference}
                    window={window}
                    onApply={applyFilterDocument}
                    onScopeChange={handleScopeChange}
                  />
                </div>
              </SheetContent>
            </Sheet>
          ) : null}

          <ButtonGroup>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  type="button"
                  variant="outline"
                  size="icon"
                  disabled={!previousPeriodRange}
                  aria-label={previousPeriodLabel}
                  onClick={handleShiftToPreviousPeriod}
                >
                  <RiArrowLeftSLine className="size-4" />
                </Button>
              </TooltipTrigger>
              <TooltipContent side="bottom">
                {previousPeriodLabel}
              </TooltipContent>
            </Tooltip>

            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  type="button"
                  variant="outline"
                  size="icon"
                  disabled={!nextPeriodRange}
                  aria-label={nextPeriodLabel}
                  onClick={handleShiftToNextPeriod}
                >
                  <RiArrowRightSLine className="size-4" />
                </Button>
              </TooltipTrigger>
              <TooltipContent side="bottom">{nextPeriodLabel}</TooltipContent>
            </Tooltip>
          </ButtonGroup>

          <DropdownMenu modal={false}>
            <DropdownMenuTrigger asChild>
              <Button
                variant="outline"
                className="min-w-[156px] justify-between bg-background"
              >
                <span className="inline-flex items-center gap-2">
                  <RiCalendarLine className="size-4 text-muted-foreground" />
                  <span>{rangeLabelText}</span>
                </span>
                <RiArrowDownSLine className="size-4 text-muted-foreground" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-64">
              {rangeGroups.map((group, groupIndex) => (
                <div key={group.key}>
                  {groupIndex > 0 ? <DropdownMenuSeparator /> : null}
                  <DropdownMenuLabel>
                    {rangeGroupLabel(messages, group.key)}
                  </DropdownMenuLabel>
                  <DropdownMenuRadioGroup
                    value={range}
                    onValueChange={(value) => {
                      handleRangeValueChange(value as RangePreset, "desktop");
                    }}
                  >
                    {group.items.map((item) => (
                      <DropdownMenuRadioItem key={item} value={item}>
                        {rangeLabel(messages, item)}
                      </DropdownMenuRadioItem>
                    ))}
                  </DropdownMenuRadioGroup>
                </div>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>

          <DropdownMenu modal={false}>
            <DropdownMenuTrigger asChild>
              <Button
                variant="outline"
                className="min-w-[96px] justify-between bg-background"
              >
                <span className="inline-flex items-center gap-2">
                  <RiTimeLine className="size-4 text-muted-foreground" />
                  <span>{intervalLabelText}</span>
                </span>
                <RiArrowDownSLine className="size-4 text-muted-foreground" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-52">
              <DropdownMenuLabel>
                {messages.dashboardHeader.interval}
              </DropdownMenuLabel>
              <DropdownMenuSeparator />
              <DropdownMenuRadioGroup
                value={window.interval}
                onValueChange={(value) => {
                  handleIntervalValueChange(value as DashboardInterval);
                }}
              >
                {INTERVAL_ORDER.map((item) =>
                  orderedAllowedIntervals.includes(item) ? (
                    <DropdownMenuRadioItem key={item} value={item}>
                      {intervalLabel(messages, item)}
                    </DropdownMenuRadioItem>
                  ) : (
                    <Tooltip key={item}>
                      <TooltipTrigger asChild>
                        <DropdownMenuItem
                          onSelect={(event) => {
                            event.preventDefault();
                          }}
                          className="cursor-not-allowed text-muted-foreground/80 opacity-60 focus:bg-transparent focus:text-muted-foreground/80"
                        >
                          {intervalLabel(messages, item)}
                        </DropdownMenuItem>
                      </TooltipTrigger>
                      <TooltipContent side="left" sideOffset={8}>
                        {intervalDisabledReason(messages, item)}
                      </TooltipContent>
                    </Tooltip>
                  ),
                )}
              </DropdownMenuRadioGroup>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>

      <Dialog open={customDialogOpen} onOpenChange={setCustomDialogOpen}>
        <DialogContent className="w-fit">
          <DialogHeader>
            <DialogTitle icon={RiCalendarLine}>
              {messages.ranges.custom}
            </DialogTitle>
            <DialogDescription>
              {formatDateSpan(
                locale,
                timeZone,
                customRange?.from,
                customRange?.to,
              ) || messages.dashboardHeader.customRange}
            </DialogDescription>
          </DialogHeader>
          <Calendar
            mode="range"
            captionLayout="dropdown"
            numberOfMonths={2}
            selected={pendingCustomRange}
            onSelect={(value) => {
              setPendingCustomRange(value);
            }}
          />
          <p className="px-1 text-xs text-muted-foreground">
            {naturalSelectionText}
          </p>
          <DialogFooter>
            <Button
              onClick={() => {
                if (!pendingNormalized) return;
                setPeriodForwardStack([]);
                setCustomRange(pendingNormalized);
                setCustomDialogOpen(false);
              }}
              disabled={!pendingNormalized}
            >
              <RiCheckLine className="size-4" />
              <span>{messages.dashboardHeader.customApply}</span>
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
});
