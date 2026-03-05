"use client";

import { useMemo, useState } from "react";
import { type DateRange } from "react-day-picker";
import NumberFlow, { continuous } from "@number-flow/react";
import {
  RiArrowLeftSLine,
  RiArrowRightSLine,
  RiArrowDownSLine,
  RiCalendarLine,
  RiFilter3Line,
  RiTimeLine,
} from "@remixicon/react";
import { Button } from "@/components/ui/button";
import { ButtonGroup } from "@/components/ui/button-group";
import { Calendar } from "@/components/ui/calendar";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
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
  DrawerTitle,
  DrawerTrigger,
} from "@/components/ui/drawer";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@/components/ui/sheet";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { AutoTransition } from "@/components/ui/auto-transition";
import { useDashboardQueryControls } from "@/components/dashboard/dashboard-query-provider";
import { useRealtimeChannel } from "@/hooks/use-realtime-channel";
import { intlLocale } from "@/lib/dashboard/format";
import {
  normalizeCustomDateRange,
  type DashboardInterval,
  type RangePreset,
} from "@/lib/dashboard/query-state";
import { isRealtimeMockEnabled } from "@/lib/realtime/client";
import type { RealtimeConnectionState } from "@/lib/realtime/types";
import type { Locale } from "@/lib/i18n/config";
import type { AppMessages } from "@/lib/i18n/messages";
import { formatI18nTemplate } from "@/lib/i18n/template";

interface DashboardHeaderControlsProps {
  locale: Locale;
  messages: AppMessages;
  siteId?: string;
  showControls: boolean;
  showFilterSheet: boolean;
}

const INTERVAL_ORDER: readonly DashboardInterval[] = [
  "minute",
  "hour",
  "day",
  "week",
  "month",
] as const;
const USE_REALTIME_MOCK = isRealtimeMockEnabled();

function rangeLabel(messages: AppMessages, range: RangePreset): string {
  if (range === "30m") return messages.ranges.last30m;
  if (range === "1h") return messages.ranges.last1h;
  if (range === "today") return messages.ranges.today;
  if (range === "yesterday") return messages.ranges.yesterday;
  if (range === "thisWeek") return messages.ranges.thisWeek;
  if (range === "thisMonth") return messages.ranges.thisMonth;
  if (range === "thisYear") return messages.ranges.thisYear;
  if (range === "24h") return messages.ranges.last24h;
  if (range === "30d") return messages.ranges.last30d;
  if (range === "90d") return messages.ranges.last90d;
  if (range === "6m") return messages.ranges.last6m;
  if (range === "12m") return messages.ranges.last12m;
  if (range === "all") return messages.ranges.allTime;
  if (range === "custom") return messages.ranges.custom;
  return messages.ranges.last7d;
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

function toDateRange(from?: number, to?: number): DateRange | undefined {
  if (!Number.isFinite(from) || !Number.isFinite(to)) return undefined;
  return {
    from: new Date(from as number),
    to: new Date(to as number),
  };
}

function formatDateSpan(locale: Locale, from?: number, to?: number): string {
  if (!Number.isFinite(from) || !Number.isFinite(to)) return "";
  const formatter = new Intl.DateTimeFormat(intlLocale(locale), {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
  return `${formatter.format(new Date(from as number))} - ${formatter.format(new Date(to as number))}`;
}

function realtimeStatusText(
  messages: AppMessages,
  status: RealtimeConnectionState,
): string {
  if (status === "connected") return messages.realtime.connected;
  if (status === "connecting") return messages.realtime.connecting;
  if (status === "disconnected") return messages.realtime.reconnecting;
  return messages.realtime.failed;
}

function RealtimeStatusDot({ status }: { status: RealtimeConnectionState }) {
  return (
    <AutoTransition
      type="scale"
      duration={0.14}
      initial={false}
      className="relative inline-flex size-4 items-center justify-center"
    >
      {status === "connected" ? (
        <span key="connected" className="relative inline-flex size-4 items-center justify-center">
          <span className="absolute inline-flex size-3 rounded-full bg-emerald-500/70 dark:bg-emerald-400/70 animate-ping" />
          <span className="inline-flex size-2 rounded-full bg-emerald-500 dark:bg-emerald-400" />
        </span>
      ) : status === "connecting" ? (
        <span key="connecting" className="relative inline-flex size-4 items-center justify-center">
          <span className="inline-flex size-2 rounded-full bg-neutral-500 dark:bg-neutral-400 animate-pulse" />
        </span>
      ) : status === "disconnected" ? (
        <span key="disconnected" className="relative inline-flex size-4 items-center justify-center">
          <span className="absolute inline-flex size-3 rounded-full bg-amber-500/70 dark:bg-amber-400/70 animate-ping" />
          <span className="inline-flex size-2 rounded-full bg-amber-500 dark:bg-amber-400" />
        </span>
      ) : (
        <span key="failed" className="relative inline-flex size-4 items-center justify-center">
          <span className="absolute inline-flex size-3 rounded-full bg-rose-500/70 dark:bg-rose-400/70 animate-ping" />
          <span className="inline-flex size-2 rounded-full bg-rose-500 dark:bg-rose-400" />
        </span>
      )}
    </AutoTransition>
  );
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
                <NumberFlow
                  value={activeNow}
                  plugins={[continuous]}
                  className="font-mono tabular-nums"
                />
              </span>
            ) : (
              <span key="active-now-empty" className="inline-flex w-0 overflow-hidden" aria-hidden />
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

export function DashboardHeaderControls({
  locale,
  messages,
  siteId,
  showControls,
  showFilterSheet,
}: DashboardHeaderControlsProps) {
  const {
    range,
    window,
    customRange,
    uiFilters,
    setRange,
    setCustomRange,
    setInterval: setDashboardInterval,
    setUiFilters,
    clearUiFilters,
    allowedIntervals,
  } = useDashboardQueryControls();

  const selectedDateRange = useMemo(
    () => toDateRange(customRange?.from, customRange?.to),
    [customRange?.from, customRange?.to],
  );
  const [customDialogOpen, setCustomDialogOpen] = useState(false);
  const [mobileFilterDrawerOpen, setMobileFilterDrawerOpen] = useState(false);
  const [mobileTimeDrawerOpen, setMobileTimeDrawerOpen] = useState(false);
  const [pendingCustomRange, setPendingCustomRange] = useState<
    DateRange | undefined
  >(selectedDateRange);
  const realtimeSiteId = siteId || (USE_REALTIME_MOCK ? "local-mock-site" : undefined);
  const showRealtimeBadge = showFilterSheet && (Boolean(siteId) || USE_REALTIME_MOCK);
  const realtime = useRealtimeChannel(realtimeSiteId, {
    enabled: showControls && showRealtimeBadge,
  });
  const activeNow = realtime.activeNow;
  const realtimeStatus = realtime.status;
  const hasRealtimeConnected = realtime.hasConnected;

  const orderedAllowedIntervals = INTERVAL_ORDER.filter((value) =>
    allowedIntervals.includes(value),
  );
  const rangeLabelText = rangeLabel(messages, range);
  const intervalLabelText = intervalLabel(messages, window.interval);
  const pendingNormalized = normalizeCustomDateRange(pendingCustomRange);
  const previousPeriodRange = shiftTimeWindow(
    window.from,
    window.to,
    "previous",
  );
  const nextPeriodRange = shiftTimeWindow(window.from, window.to, "next");
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
    });
    const dayCount = Math.max(
      1,
      Math.round(
        (pendingNormalized.to - pendingNormalized.from) / (24 * 60 * 60 * 1000),
      ),
    );
    return formatI18nTemplate(
      messages.dashboardHeader.customSelectionSummary,
      {
        from: formatter.format(new Date(pendingNormalized.from)),
        to: formatter.format(new Date(pendingNormalized.to)),
        days: dayCount,
      },
    );
  }, [
    locale,
    messages.dashboardHeader.customSelectionSummary,
    messages.dashboardHeader.customHint,
    messages.dashboardHeader.customPendingEnd,
    pendingCustomRange?.from,
    pendingCustomRange?.to,
    pendingNormalized,
  ]);

  const handleRangeValueChange = (
    value: RangePreset,
    source: "desktop" | "mobile" = "desktop",
  ) => {
    setRange(value);
    if (value !== "custom") return;
    setPendingCustomRange(selectedDateRange);
    if (source === "mobile") {
      setMobileTimeDrawerOpen(false);
    }
    setCustomDialogOpen(true);
  };

  const handleIntervalValueChange = (value: DashboardInterval) => {
    if (!orderedAllowedIntervals.includes(value)) return;
    setDashboardInterval(value);
  };

  const handleShiftPeriod = (nextRange: { from: number; to: number } | null) => {
    if (!nextRange) return;
    setCustomRange(nextRange);
  };

  if (!showControls) return null;

  return (
    <>
      <div className="flex flex-wrap items-center justify-end gap-2">
        <div className="flex items-center justify-end gap-2 md:hidden">
          {showRealtimeBadge ? (
                <RealtimeActiveBadge
                  activeNow={activeNow}
                  status={realtimeStatus}
                  showValue={hasRealtimeConnected}
                  label={messages.realtime.activeNow}
                  messages={messages}
                />
              ) : null}
          <Drawer
            open={mobileFilterDrawerOpen}
            onOpenChange={setMobileFilterDrawerOpen}
          >
            <DrawerTrigger asChild disabled={!showFilterSheet}>
              <Button variant="outline" className="gap-2">
                <RiFilter3Line className="size-4" />
                {messages.dashboardHeader.filters}
              </Button>
            </DrawerTrigger>
            <DrawerContent>
              <DrawerHeader>
                <DrawerTitle>{messages.dashboardHeader.filterTitle}</DrawerTitle>
                <DrawerDescription>
                  {messages.dashboardHeader.filterSubtitle}
                </DrawerDescription>
              </DrawerHeader>

              <div className="space-y-4 overflow-y-auto px-4 pb-2">
                <div className="space-y-2">
                  <Label htmlFor="dashboard-filter-mobile-country">
                    {messages.filters.country}
                  </Label>
                  <Input
                    id="dashboard-filter-mobile-country"
                    value={uiFilters.country || ""}
                    onChange={(event) =>
                      setUiFilters({
                        ...uiFilters,
                        country: event.target.value,
                      })
                    }
                  />
                </div>

                <div className="space-y-2">
                  <Label htmlFor="dashboard-filter-mobile-device">
                    {messages.filters.device}
                  </Label>
                  <Input
                    id="dashboard-filter-mobile-device"
                    value={uiFilters.device || ""}
                    onChange={(event) =>
                      setUiFilters({
                        ...uiFilters,
                        device: event.target.value,
                      })
                    }
                  />
                </div>

                <div className="space-y-2">
                  <Label htmlFor="dashboard-filter-mobile-browser">
                    {messages.filters.browser}
                  </Label>
                  <Input
                    id="dashboard-filter-mobile-browser"
                    value={uiFilters.browser || ""}
                    onChange={(event) =>
                      setUiFilters({
                        ...uiFilters,
                        browser: event.target.value,
                      })
                    }
                  />
                </div>

                <div className="space-y-2">
                  <Label htmlFor="dashboard-filter-mobile-event">
                    {messages.filters.eventType}
                  </Label>
                  <Input
                    id="dashboard-filter-mobile-event"
                    value={uiFilters.eventType || ""}
                    onChange={(event) =>
                      setUiFilters({
                        ...uiFilters,
                        eventType: event.target.value,
                      })
                    }
                  />
                </div>
              </div>

              <DrawerFooter>
                <Button variant="outline" onClick={clearUiFilters}>
                  {messages.filters.clear}
                </Button>
                <DrawerClose asChild>
                  <Button>{closeLabel}</Button>
                </DrawerClose>
              </DrawerFooter>
            </DrawerContent>
          </Drawer>

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
            <DrawerContent>
              <DrawerHeader>
                <DrawerTitle>{mobileTimeLabel}</DrawerTitle>
                <DrawerDescription>
                  {rangeLabelText} / {intervalLabelText}
                </DrawerDescription>
              </DrawerHeader>

              <div className="space-y-4 overflow-y-auto px-4 pb-2">
                <div className="space-y-2">
                  <Label>{cycleLabel}</Label>
                  <ButtonGroup className="w-full">
                    <Button
                      type="button"
                      variant="outline"
                      className="flex-1 justify-center gap-1"
                      disabled={!previousPeriodRange}
                      onClick={() => {
                        handleShiftPeriod(previousPeriodRange);
                      }}
                    >
                      <RiArrowLeftSLine className="size-4" />
                      <span>{previousPeriodLabel}</span>
                    </Button>
                    <Button
                      type="button"
                      variant="outline"
                      className="flex-1 justify-center gap-1"
                      disabled={!nextPeriodRange}
                      onClick={() => {
                        handleShiftPeriod(nextPeriodRange);
                      }}
                    >
                      <span>{nextPeriodLabel}</span>
                      <RiArrowRightSLine className="size-4" />
                    </Button>
                  </ButtonGroup>
                </div>

                <div className="space-y-3">
                  <Label>{messages.dashboardHeader.range}</Label>
                  {RANGE_GROUPS.map((group) => (
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
                            {rangeLabel(messages, item)}
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
                          variant={window.interval === item ? "default" : "outline"}
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
                          {intervalLabel(messages, item)}
                        </Button>
                      );
                    })}
                  </div>
                </div>
              </div>

              <DrawerFooter>
                <DrawerClose asChild>
                  <Button>{closeLabel}</Button>
                </DrawerClose>
              </DrawerFooter>
            </DrawerContent>
          </Drawer>
        </div>

        <div className="hidden flex-wrap items-center justify-end gap-2 md:flex">
          {showRealtimeBadge ? (
                <RealtimeActiveBadge
                  activeNow={activeNow}
                  status={realtimeStatus}
                  showValue={hasRealtimeConnected}
                  label={messages.realtime.activeNow}
                  messages={messages}
                />
              ) : null}
          <Sheet modal={false}>
            <SheetTrigger asChild disabled={!showFilterSheet}>
              <Button variant="outline" className="gap-2">
                <RiFilter3Line className="size-4" />
                {messages.dashboardHeader.filters}
              </Button>
            </SheetTrigger>
            <SheetContent side="right" className="w-full sm:max-w-md">
              <SheetHeader>
                <SheetTitle>{messages.dashboardHeader.filterTitle}</SheetTitle>
                <SheetDescription>
                  {messages.dashboardHeader.filterSubtitle}
                </SheetDescription>
              </SheetHeader>

              <div className="space-y-4 px-4">
                <div className="space-y-2">
                  <Label htmlFor="dashboard-filter-desktop-country">
                    {messages.filters.country}
                  </Label>
                  <Input
                    id="dashboard-filter-desktop-country"
                    value={uiFilters.country || ""}
                    onChange={(event) =>
                      setUiFilters({
                        ...uiFilters,
                        country: event.target.value,
                      })
                    }
                  />
                </div>

                <div className="space-y-2">
                  <Label htmlFor="dashboard-filter-desktop-device">
                    {messages.filters.device}
                  </Label>
                  <Input
                    id="dashboard-filter-desktop-device"
                    value={uiFilters.device || ""}
                    onChange={(event) =>
                      setUiFilters({
                        ...uiFilters,
                        device: event.target.value,
                      })
                    }
                  />
                </div>

                <div className="space-y-2">
                  <Label htmlFor="dashboard-filter-desktop-browser">
                    {messages.filters.browser}
                  </Label>
                  <Input
                    id="dashboard-filter-desktop-browser"
                    value={uiFilters.browser || ""}
                    onChange={(event) =>
                      setUiFilters({
                        ...uiFilters,
                        browser: event.target.value,
                      })
                    }
                  />
                </div>

                <div className="space-y-2">
                  <Label htmlFor="dashboard-filter-desktop-event">
                    {messages.filters.eventType}
                  </Label>
                  <Input
                    id="dashboard-filter-desktop-event"
                    value={uiFilters.eventType || ""}
                    onChange={(event) =>
                      setUiFilters({
                        ...uiFilters,
                        eventType: event.target.value,
                      })
                    }
                  />
                </div>

                <Button variant="outline" onClick={clearUiFilters}>
                  {messages.filters.clear}
                </Button>
              </div>
            </SheetContent>
          </Sheet>

          <ButtonGroup>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  type="button"
                  variant="outline"
                  size="icon"
                  disabled={!previousPeriodRange}
                  aria-label={previousPeriodLabel}
                  onClick={() => {
                    handleShiftPeriod(previousPeriodRange);
                  }}
                >
                  <RiArrowLeftSLine className="size-4" />
                </Button>
              </TooltipTrigger>
              <TooltipContent side="bottom">{previousPeriodLabel}</TooltipContent>
            </Tooltip>

            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  type="button"
                  variant="outline"
                  size="icon"
                  disabled={!nextPeriodRange}
                  aria-label={nextPeriodLabel}
                  onClick={() => {
                    handleShiftPeriod(nextPeriodRange);
                  }}
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
              {RANGE_GROUPS.map((group, groupIndex) => (
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

      <Dialog
        modal={false}
        open={customDialogOpen}
        onOpenChange={setCustomDialogOpen}
      >
        <DialogContent className="w-fit">
          <DialogHeader>
            <DialogTitle>{messages.ranges.custom}</DialogTitle>
            <DialogDescription>
              {formatDateSpan(locale, customRange?.from, customRange?.to) ||
                messages.dashboardHeader.customRange}
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
                setCustomRange(pendingNormalized);
                setCustomDialogOpen(false);
              }}
              disabled={!pendingNormalized}
            >
              {messages.dashboardHeader.customApply}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
