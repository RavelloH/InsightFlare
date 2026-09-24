import {
  type CSSProperties,
  memo,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { RiArrowLeftLine } from "@remixicon/react";

import { LazyGeoCityBreadcrumbLabel } from "@/components/dashboard/geo/lazy-geo-location-label";
import {
  formatRelativeTime,
  VisitorAvatar,
  visitorDisplayName,
} from "@/components/dashboard/journeys/journey-display";
import { useDetailDrawerReady } from "@/components/dashboard/site-pages/common/detail-drawer";
import type { VisitorDetailMapTheme } from "@/components/dashboard/site-pages/visitors/visitor-detail-map-stage";
import { useTheme } from "@/components/theme-provider";
import { AutoTransition } from "@/components/ui/auto-transition";
import { Clickable } from "@/components/ui/clickable";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { zonedParts } from "@/lib/analytics/time-zone";
import { intlLocale, numberFormat } from "@/lib/dashboard/format";
import type {
  JourneySession,
  VisitorActivityDay,
} from "@/lib/dashboard-api/client/edge";
import {
  resolveCountryFlagCode,
  resolveCountryLabel,
} from "@/lib/i18n/code-labels";
import type { Locale } from "@/lib/i18n/config";
import type { AppMessages } from "@/lib/i18n/messages";
import Link from "@/lib/router";
import { cn } from "@/lib/utils";

import {
  DetailMapPlaceholder,
  type Labels,
  VISITOR_ACTIVITY_DAYS,
  type VisitorActivityCalendarCell,
  type VisitorActivityCalendarSection,
  type VisitorActivityDayItem,
  type VisitorDetail,
  VisitorDetailMapStage,
  visitorLocationPoints,
  type VisitorRow,
} from "./model";
export function VisitorGeoBreadcrumb({
  locale,
  messages,
  visitor,
}: {
  locale: Locale;
  messages: AppMessages;
  visitor: VisitorRow;
}) {
  const country = resolveCountryLabel(
    visitor.country ?? "",
    locale,
    messages.common.unknown,
  );
  const flagCode = resolveCountryFlagCode(country.code, locale);
  const regionLabel =
    (visitor.region ?? "").trim() ||
    (visitor.regionCode ?? "").trim() ||
    messages.common.unknown;
  const cityLabel = (visitor.city ?? "").trim() || messages.common.unknown;
  const hasRegion = Boolean(
    (visitor.region ?? "").trim() || (visitor.regionCode ?? "").trim(),
  );
  const hasCity = Boolean((visitor.city ?? "").trim());

  return (
    <LazyGeoCityBreadcrumbLabel
      locale={locale}
      countryLabel={country.label}
      countryIconName={flagCode ? `flagpack:${flagCode.toLowerCase()}` : null}
      regionLabel={regionLabel}
      cityLabel={cityLabel}
      countryCode={country.code ?? visitor.country ?? ""}
      stateCode={visitor.regionCode || visitor.region || ""}
      cityNameDefault={visitor.city ?? ""}
      hideRegion={!hasRegion}
      hideCity={!hasCity}
    />
  );
}
export const VisitorMapHero = memo(function VisitorMapHero({
  locale,
  labels,
  visitor,
  metrics,
  sessions,
  backHref,
  onBack,
  loading = false,
}: {
  locale: Locale;
  labels: Labels;
  visitor: VisitorRow;
  metrics: VisitorDetail["metrics"];
  sessions: JourneySession[];
  backHref: string;
  onBack?: () => void;
  loading?: boolean;
}) {
  const modalReady = useDetailDrawerReady();
  const { resolvedTheme } = useTheme();
  const effectiveTheme: VisitorDetailMapTheme =
    resolvedTheme === "dark" ? "dark" : "light";
  const displayName = visitorDisplayName(
    visitor.userName,
    visitor.userId,
    labels.anonymous,
  );
  const points = useMemo(
    () => (modalReady ? visitorLocationPoints(sessions) : []),
    [modalReady, sessions],
  );

  return (
    <div className="relative h-[17rem] overflow-hidden sm:h-[19rem]">
      {modalReady && !loading ? (
        <VisitorDetailMapStage
          locale={locale}
          theme={effectiveTheme}
          points={points}
        />
      ) : (
        <DetailMapPlaceholder />
      )}

      <div className="pointer-events-none absolute inset-x-0 bottom-0 h-36 bg-gradient-to-t from-background via-background/70 to-transparent" />

      <div className="absolute inset-x-4 top-4 z-10 flex items-center justify-between gap-4 sm:inset-x-5 sm:top-5">
        {onBack ? (
          <Clickable
            className="inline-flex items-center gap-1 text-xs text-foreground/80 hover:text-foreground"
            enableHoverScale={false}
            tapScale={0.98}
            aria-label={labels.back}
            onClick={onBack}
          >
            <RiArrowLeftLine className="size-3.5" />
            {labels.back}
          </Clickable>
        ) : (
          <Link
            href={backHref}
            className="inline-flex items-center gap-1 text-xs text-foreground/80 outline-none hover:text-foreground focus-visible:ring-1 focus-visible:ring-ring/60"
            aria-label={labels.back}
          >
            <RiArrowLeftLine className="size-3.5" />
            {labels.back}
          </Link>
        )}
        <div className="min-w-0 truncate text-right font-mono text-[11px] text-foreground/70">
          {labels.visitorId}: {visitor.visitorId}
        </div>
      </div>

      <AutoTransition
        initial={false}
        transitionKey={loading ? "loading" : "ready"}
        duration={0.18}
        type="fade"
        presenceMode="wait"
        className="absolute bottom-4 left-4 z-10 min-w-0 max-w-[calc(100%-2rem)] sm:bottom-5 sm:left-5"
      >
        {loading ? (
          <div key="loading" className="flex min-w-0 items-center gap-3">
            <Skeleton className="size-12 shrink-0 rounded-full bg-muted/80" />
            <div className="min-w-0 space-y-2">
              <Skeleton className="h-8 w-36 max-w-[64vw] bg-muted/80" />
              <Skeleton className="h-3 w-56 max-w-[72vw] bg-muted/80" />
            </div>
          </div>
        ) : (
          <div key="ready" className="flex min-w-0 items-center gap-3">
            <VisitorAvatar seed={visitor.visitorId} className="size-12" />
            <div className="min-w-0">
              <h1 className="min-w-0 truncate text-2xl font-semibold tracking-tight text-foreground">
                {displayName}
              </h1>
              <p className="mt-1 truncate font-mono text-[11px] text-foreground/70">
                {labels.lastSeen}:{" "}
                {formatRelativeTime(locale, metrics.lastSeenAt, Date.now())}
              </p>
            </div>
          </div>
        )}
      </AutoTransition>
    </div>
  );
});
export function activityDateKey(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}
export const ActivityGrid = memo(function ActivityGrid({
  activity,
  locale,
  timeZone,
  loading = false,
}: {
  activity: VisitorActivityDay[];
  locale: Locale;
  timeZone: string;
  loading?: boolean;
}) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [containerWidth, setContainerWidth] = useState(0);
  const { desktopSection, mobileSections, weekdayLabels, mobileWeekCount } =
    useMemo(() => {
      const monthFormatter = new Intl.DateTimeFormat(intlLocale(locale), {
        month: "short",
      });
      const dateFormatter = new Intl.DateTimeFormat(intlLocale(locale), {
        month: "short",
        day: "numeric",
      });
      const weekdayFormatter = new Intl.DateTimeFormat(intlLocale(locale), {
        weekday: "narrow",
      });
      const buildSection = (
        days: VisitorActivityDayItem[],
      ): VisitorActivityCalendarSection => {
        if (days.length === 0) {
          return {
            cells: [],
            monthLabels: [],
            weekCount: 0,
          };
        }

        const leadingEmptyDays = days[0]?.date.getDay() ?? 0;
        const cells: VisitorActivityCalendarCell[] = [
          ...Array.from({ length: leadingEmptyDays }, (_, index) => ({
            type: "empty" as const,
            key: `empty-${days[0]?.key ?? "section"}-${index}`,
          })),
          ...days.map((day) => ({ type: "day" as const, ...day })),
        ];
        const weekCount = Math.ceil(cells.length / 7);
        const seenMonthKeys = new Set<string>();
        const monthLabels = Array.from(
          { length: weekCount },
          (_, weekIndex) => {
            const weekCells = cells.slice(weekIndex * 7, weekIndex * 7 + 7);
            const firstMonthDay = weekCells.find((cell) => {
              if (cell.type !== "day") return false;
              const monthKey = `${cell.date.getFullYear()}-${cell.date.getMonth()}`;
              if (seenMonthKeys.has(monthKey)) return false;
              return weekIndex === 0 || cell.date.getDate() <= 7;
            });
            if (firstMonthDay?.type === "day") {
              seenMonthKeys.add(
                `${firstMonthDay.date.getFullYear()}-${firstMonthDay.date.getMonth()}`,
              );
            }
            return firstMonthDay?.type === "day"
              ? monthFormatter.format(firstMonthDay.date)
              : "";
          },
        );

        return {
          cells,
          monthLabels,
          weekCount,
        };
      };
      const byDate = new globalThis.Map(
        activity.map((item) => [item.date, item.count]),
      );
      const endParts = zonedParts(Date.now(), timeZone);
      const end = new Date(endParts.year, endParts.month - 1, endParts.day);
      const start = new Date(end);
      start.setDate(start.getDate() - (VISITOR_ACTIVITY_DAYS - 1));
      const dayItems: VisitorActivityDayItem[] = [];

      for (
        let cursor = new Date(start);
        cursor <= end;
        cursor.setDate(cursor.getDate() + 1)
      ) {
        const date = activityDateKey(cursor);
        const count = byDate.get(date) ?? 0;
        dayItems.push({
          date: new Date(cursor),
          key: date,
          count,
          title: `${dateFormatter.format(cursor)}: ${numberFormat(
            locale,
            count,
          )}`,
        });
      }

      const splitIndex = Math.ceil(dayItems.length / 2);
      const nextMobileSections = [
        buildSection(dayItems.slice(0, splitIndex)),
        buildSection(dayItems.slice(splitIndex)),
      ];
      const weekdayNames = Array.from({ length: 7 }, (_, index) => {
        const date = new Date(2024, 0, 7 + index);
        return weekdayFormatter.format(date);
      });

      return {
        desktopSection: buildSection(dayItems),
        mobileSections: nextMobileSections,
        weekdayLabels: weekdayNames,
        mobileWeekCount: Math.max(
          1,
          ...nextMobileSections.map((section) => section.weekCount),
        ),
      };
    }, [activity, locale, timeZone]);
  const max = Math.max(
    1,
    ...desktopSection.cells.map((cell) =>
      cell.type === "day" ? cell.count : 0,
    ),
  );
  const cellSizePx = useMemo(() => {
    if (containerWidth <= 0) return 8;
    const weekdayLabelWidth = 20;
    const labelGap = 8;
    const columnGap = 4;
    const available =
      containerWidth -
      weekdayLabelWidth -
      labelGap -
      Math.max(0, desktopSection.weekCount - 1) * columnGap;
    return Math.max(
      7,
      Math.min(16, available / Math.max(1, desktopSection.weekCount)),
    );
  }, [containerWidth, desktopSection.weekCount]);
  const mobileCellSizePx = useMemo(() => {
    if (containerWidth <= 0) return 10;
    const weekdayLabelWidth = 20;
    const labelGap = 8;
    const columnGap = 3;
    const available =
      containerWidth -
      weekdayLabelWidth -
      labelGap -
      Math.max(0, mobileWeekCount - 1) * columnGap;
    return Math.max(7, Math.min(14, available / Math.max(1, mobileWeekCount)));
  }, [containerWidth, mobileWeekCount]);
  const activityStyle = {
    scrollbarGutter: "stable",
    "--activity-cell-size": `${cellSizePx}px`,
    "--activity-mobile-cell-size": `${mobileCellSizePx}px`,
  } as CSSProperties;

  useEffect(() => {
    const node = containerRef.current;
    if (!node) return;

    const updateWidth = () => setContainerWidth(node.clientWidth);
    updateWidth();

    const observer = new ResizeObserver(updateWidth);
    observer.observe(node);
    return () => observer.disconnect();
  }, []);
  const renderActivityCells = (
    section: VisitorActivityCalendarSection,
    cellClassName: string,
  ) =>
    section.cells.map((cell) => {
      if (cell.type === "empty") {
        return <span key={cell.key} className={cellClassName} />;
      }
      const intensity = cell.count / max;
      return loading ? (
        <Skeleton
          key={cell.key}
          className={cn(cellClassName, "rounded-[2px] ring-1 ring-border/70")}
        />
      ) : (
        <Tooltip key={cell.key}>
          <TooltipTrigger asChild>
            <span
              className={cn(
                cellClassName,
                "rounded-[2px] ring-1 ring-border/70",
                cell.count === 0 && "bg-muted",
              )}
              style={
                cell.count > 0
                  ? {
                      backgroundColor: `rgba(16, 185, 129, ${
                        0.28 + intensity * 0.72
                      })`,
                    }
                  : undefined
              }
            />
          </TooltipTrigger>
          <TooltipContent>{cell.title}</TooltipContent>
        </Tooltip>
      );
    });
  const renderActivityMonthLabels = (
    section: VisitorActivityCalendarSection,
    gridAutoColumnClassName: string,
  ) => (
    <div
      className={cn(
        "ml-7 grid grid-flow-col grid-rows-1 gap-1",
        gridAutoColumnClassName,
      )}
    >
      {section.monthLabels.map((label, index) => (
        <span
          key={`${label}-${index}`}
          className="h-4 text-[10px] leading-4 text-muted-foreground"
        >
          {label}
        </span>
      ))}
    </div>
  );

  return (
    <div
      ref={containerRef}
      className="w-full max-w-full overflow-x-auto pb-1"
      style={activityStyle}
    >
      <div className="mx-auto hidden w-max min-w-max sm:block">
        {renderActivityMonthLabels(
          desktopSection,
          "[grid-auto-columns:var(--activity-cell-size)]",
        )}
        <div className="flex gap-2">
          <div className="grid grid-rows-7 gap-1">
            {weekdayLabels.map((label, index) => (
              <span
                key={`${label}-${index}`}
                className="flex h-[var(--activity-cell-size)] w-5 items-center justify-end text-[10px] leading-none text-muted-foreground"
              >
                {label}
              </span>
            ))}
          </div>
          <div className="grid grid-flow-col grid-rows-7 gap-1 [grid-auto-columns:var(--activity-cell-size)]">
            {renderActivityCells(
              desktopSection,
              "size-[var(--activity-cell-size)]",
            )}
          </div>
        </div>
      </div>

      <div className="space-y-4 sm:hidden">
        {mobileSections.map((section, sectionIndex) => (
          <div
            key={`activity-mobile-${sectionIndex}`}
            className="mx-auto w-max max-w-full"
          >
            {renderActivityMonthLabels(
              section,
              "[grid-auto-columns:var(--activity-mobile-cell-size)]",
            )}
            <div className="flex gap-2">
              <div className="grid grid-rows-7 gap-[3px]">
                {weekdayLabels.map((label, index) => (
                  <span
                    key={`${label}-${sectionIndex}-${index}`}
                    className="flex h-[var(--activity-mobile-cell-size)] w-5 items-center justify-end text-[10px] leading-none text-muted-foreground"
                  >
                    {index % 2 === 1 ? label : ""}
                  </span>
                ))}
              </div>
              <div className="grid grid-flow-col grid-rows-7 gap-[3px] [grid-auto-columns:var(--activity-mobile-cell-size)]">
                {renderActivityCells(
                  section,
                  "size-[var(--activity-mobile-cell-size)]",
                )}
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
});
