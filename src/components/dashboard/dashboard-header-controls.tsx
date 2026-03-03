"use client";

import { useMemo, useState } from "react";
import { type DateRange } from "react-day-picker";
import {
  RiArrowDownSLine,
  RiCalendarLine,
  RiFilter3Line,
  RiTimeLine,
} from "@remixicon/react";
import { Button } from "@/components/ui/button";
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
import { useDashboardQueryControls } from "@/components/dashboard/dashboard-query-provider";
import { intlLocale } from "@/lib/dashboard/format";
import {
  normalizeCustomDateRange,
  type DashboardInterval,
  type RangePreset,
} from "@/lib/dashboard/query-state";
import type { Locale } from "@/lib/i18n/config";
import type { AppMessages } from "@/lib/i18n/messages";

interface DashboardHeaderControlsProps {
  locale: Locale;
  messages: AppMessages;
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

export function DashboardHeaderControls({
  locale,
  messages,
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
    setInterval,
    setUiFilters,
    clearUiFilters,
    allowedIntervals,
  } = useDashboardQueryControls();

  const selectedDateRange = useMemo(
    () => toDateRange(customRange?.from, customRange?.to),
    [customRange?.from, customRange?.to],
  );
  const [customDialogOpen, setCustomDialogOpen] = useState(false);
  const [pendingCustomRange, setPendingCustomRange] = useState<
    DateRange | undefined
  >(selectedDateRange);

  if (!showControls) return null;

  const orderedAllowedIntervals = INTERVAL_ORDER.filter((value) =>
    allowedIntervals.includes(value),
  );
  const rangeLabelText = rangeLabel(messages, range);
  const intervalLabelText = intervalLabel(messages, window.interval);
  const pendingNormalized = normalizeCustomDateRange(pendingCustomRange);
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
    if (locale === "zh") {
      return `当前选择：${formatter.format(new Date(pendingNormalized.from))} 至 ${formatter.format(new Date(pendingNormalized.to))}（共 ${dayCount} 天）`;
    }
    return `Selected range: ${formatter.format(new Date(pendingNormalized.from))} to ${formatter.format(new Date(pendingNormalized.to))} (${dayCount} days)`;
  }, [
    locale,
    messages.dashboardHeader.customHint,
    messages.dashboardHeader.customPendingEnd,
    pendingCustomRange?.from,
    pendingCustomRange?.to,
    pendingNormalized,
  ]);

  return (
    <div className="flex flex-wrap items-center justify-end gap-2">
      <Sheet>
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
              <Label htmlFor="dashboard-filter-country">
                {messages.filters.country}
              </Label>
              <Input
                id="dashboard-filter-country"
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
              <Label htmlFor="dashboard-filter-device">
                {messages.filters.device}
              </Label>
              <Input
                id="dashboard-filter-device"
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
              <Label htmlFor="dashboard-filter-browser">
                {messages.filters.browser}
              </Label>
              <Input
                id="dashboard-filter-browser"
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
              <Label htmlFor="dashboard-filter-event">
                {messages.filters.eventType}
              </Label>
              <Input
                id="dashboard-filter-event"
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
      <DropdownMenu>
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
                  setRange(value as RangePreset);
                  if (value === "custom") {
                    setPendingCustomRange(selectedDateRange);
                    setCustomDialogOpen(true);
                  }
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

      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="outline"
            className="min-w-[118px] justify-between bg-background"
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
              const next = value as DashboardInterval;
              if (!orderedAllowedIntervals.includes(next)) return;
              setInterval(next);
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

      <Dialog open={customDialogOpen} onOpenChange={setCustomDialogOpen}>
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
            numberOfMonths={3}
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
    </div>
  );
}
