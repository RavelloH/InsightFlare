import { type CSSProperties, memo, useMemo } from "react";
import {
  type RemixiconComponentType,
  RiArrowDownLine,
  RiArrowUpLine,
  RiCalendarLine,
  RiGroupLine,
  RiPercentLine,
  RiPulseLine,
  RiRepeat2Line,
} from "@remixicon/react";
import { useQuery } from "@tanstack/react-query";

import {
  AnalyticsDetailsTooltipTarget,
  AnalyticsTimeTooltipProvider,
} from "@/components/dashboard/analytics-time-tooltip";
import { PageHeading } from "@/components/dashboard/page-heading";
import { useDashboardQuery } from "@/components/dashboard/site-pages/use-dashboard-query";
import {
  dashboardComparisonLabel,
  useDashboardComparisonQuery,
} from "@/components/dashboard/use-dashboard-comparison-query";
import { AutoResizer } from "@/components/ui/auto-resizer";
import { AutoTransition } from "@/components/ui/auto-transition";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { OverlayScrollbar } from "@/components/ui/overlay-scrollbar";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import {
  fetchRetention,
  type RetentionGranularity,
} from "@/lib/dashboard/client-data";
import { filterQueryKey } from "@/lib/dashboard/filter-query-key";
import {
  intlLocale,
  numberFormat,
  percentFormat,
} from "@/lib/dashboard/format";
import type { TimeWindow } from "@/lib/dashboard/query-state";
import {
  addZonedInterval,
  startOfZonedInterval,
} from "@/lib/dashboard/time-zone";
import type { RetentionData } from "@/lib/edge-client";
import type { FilterDocument } from "@/lib/filter-contract";
import { filterConditionCount } from "@/lib/filter-contract";
import type { Locale } from "@/lib/i18n/config";
import type { AppMessages } from "@/lib/i18n/messages";
import { formatI18nTemplate } from "@/lib/i18n/template";
import { cn } from "@/lib/utils";

interface RetentionClientPageProps {
  locale: Locale;
  messages: AppMessages;
  siteId: string;
  pathname: string;
}

type RetentionCopy = AppMessages["retention"];

interface RetentionCellView {
  index: number;
  visitors: number;
  rate: number;
  available: boolean;
}

interface RetentionCohortView {
  bucket: number;
  label: string;
  size: number;
  cells: RetentionCellView[];
  averagePostRate: number | null;
}

interface RetentionPeriodAverage {
  index: number;
  visitors: number;
  base: number;
  rate: number | null;
}

interface RetentionSummary {
  cohortCount: number;
  totalVisitors: number;
  periodOneRate: number | null;
  periodOneBase: number;
  averageReturnRate: number | null;
  analyzedPeriods: number;
  strongestCohort: {
    label: string;
    rate: number;
  } | null;
}

interface RetentionViewModel {
  columns: number[];
  cohorts: RetentionCohortView[];
  periodAverages: RetentionPeriodAverage[];
  summary: RetentionSummary;
}

interface RetentionComparisonRow {
  key: string;
  current: RetentionCohortView | null;
  comparison: RetentionCohortView | null;
}

interface RetentionComparisonViewModel {
  current: RetentionViewModel;
  comparison: RetentionViewModel;
  columns: number[];
  rows: RetentionComparisonRow[];
}

interface RetentionQueryData {
  current: RetentionData;
  comparison: RetentionData | null;
}

interface RetentionLoadingShape {
  rows: number;
  columns: number;
}

const RETENTION_TABLE_COLUMNS =
  "[--retention-cohort-width:6rem] [--retention-size-width:4rem] [--retention-period-width:4.5rem]";
const RETENTION_COHORT_COLUMN =
  "w-[var(--retention-cohort-width)] min-w-[var(--retention-cohort-width)] max-w-[var(--retention-cohort-width)]";
const RETENTION_SIZE_COLUMN =
  "w-[var(--retention-size-width)] min-w-[var(--retention-size-width)] max-w-[var(--retention-size-width)]";
const RETENTION_PERIOD_COLUMN =
  "w-[var(--retention-period-width)] min-w-[var(--retention-period-width)] max-w-[var(--retention-period-width)]";
const RETENTION_LOADING_MAX_ROWS = 36;
const RETENTION_LOADING_MAX_COLUMNS = 240;

function normalizeGranularity(value: string): RetentionGranularity {
  if (
    value === "minute" ||
    value === "hour" ||
    value === "day" ||
    value === "week" ||
    value === "month"
  ) {
    return value;
  }
  return "week";
}

function formatCohortDate(
  locale: Locale,
  granularity: RetentionGranularity,
  bucket: number,
  timeZone: string,
): string {
  const date = new Date(bucket);
  if (!Number.isFinite(date.getTime())) return "--";

  const options: Intl.DateTimeFormatOptions =
    granularity === "month"
      ? { month: "short", year: "numeric" }
      : granularity === "minute"
        ? { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }
        : granularity === "hour"
          ? { month: "short", day: "numeric", hour: "2-digit" }
          : granularity === "week"
            ? { month: "short", day: "numeric" }
            : { month: "short", day: "numeric" };

  return new Intl.DateTimeFormat(intlLocale(locale), {
    ...options,
    timeZone,
  }).format(date);
}

function periodLabel(
  messages: AppMessages,
  labels: RetentionCopy,
  index: number,
): string {
  if (index === 0) return labels.periodZero;
  return formatI18nTemplate(messages.retention.periodLabel, { n: index });
}

function retentionIntervalFallbackMs(
  granularity: RetentionGranularity,
): number {
  if (granularity === "minute") return 60 * 1000;
  if (granularity === "hour") return 60 * 60 * 1000;
  if (granularity === "day") return 24 * 60 * 60 * 1000;
  if (granularity === "week") return 7 * 24 * 60 * 60 * 1000;
  return 31 * 24 * 60 * 60 * 1000;
}

function retentionBucketCount(
  window: TimeWindow,
  granularity: RetentionGranularity,
): number {
  let current = startOfZonedInterval(window.from, granularity, window.timeZone);
  if (!Number.isFinite(current)) return 1;

  const hardLimit = 2000;
  let count = 0;
  for (; count < hardLimit && current <= window.to; count += 1) {
    let next = addZonedInterval(current, granularity, window.timeZone);
    if (!Number.isFinite(next) || next <= current) {
      next = current + retentionIntervalFallbackMs(granularity);
    }
    current = next;
  }

  return Math.max(1, count);
}

function retentionActiveFilterCount(filters: FilterDocument): number {
  return filterConditionCount(filters);
}

function retentionLoadingShape(
  window: TimeWindow,
  granularity: RetentionGranularity,
  filters: FilterDocument,
): RetentionLoadingShape {
  const bucketCount = retentionBucketCount(window, granularity);
  const activeFilterCount = retentionActiveFilterCount(filters);
  const rowLimit = activeFilterCount > 0 ? 20 : RETENTION_LOADING_MAX_ROWS;

  return {
    rows: Math.max(4, Math.min(bucketCount, rowLimit)),
    columns: Math.max(1, Math.min(bucketCount, RETENTION_LOADING_MAX_COLUMNS)),
  };
}

function cohortMaxPeriodIndex(
  cohort: RetentionData["cohorts"][number],
  toMs: number,
  granularity: RetentionGranularity,
  timeZone: string,
): number {
  const start = Number(cohort.bucket ?? 0);
  if (!Number.isFinite(start) || start > toMs) return 0;
  const hardLimit = 2000;
  let index = 0;
  let current = start;
  for (; index < hardLimit; index += 1) {
    const next = addZonedInterval(current, granularity, timeZone);
    if (!Number.isFinite(next) || next <= current || next > toMs) {
      break;
    }
    current = next;
  }
  return index;
}

function buildRetentionViewModel(
  payload: RetentionData | null,
  locale: Locale,
  messages: AppMessages,
  labels: RetentionCopy,
  requestedGranularity: RetentionGranularity,
  window: TimeWindow,
): RetentionViewModel {
  const granularity = normalizeGranularity(
    String(payload?.granularity || requestedGranularity),
  );
  const sourceCohorts = Array.isArray(payload?.cohorts)
    ? payload.cohorts.filter((cohort) => Number(cohort.size ?? 0) > 0)
    : [];

  const maxObservedIndex = sourceCohorts.reduce(
    (maxIndex, cohort) =>
      Math.max(
        maxIndex,
        ...cohort.periods.map((period) => Number(period.index ?? 0)),
      ),
    0,
  );
  const maxAvailableIndex = sourceCohorts.reduce(
    (maxIndex, cohort) =>
      Math.max(
        maxIndex,
        cohortMaxPeriodIndex(cohort, window.to, granularity, window.timeZone),
      ),
    0,
  );
  const maxIndex = Math.max(0, maxObservedIndex, maxAvailableIndex);
  const columns = Array.from({ length: maxIndex + 1 }, (_, index) => index);

  const periodAverages = columns.map((index) => ({
    index,
    visitors: 0,
    base: 0,
    rate: null as number | null,
  }));

  let periodOneVisitors = 0;
  let periodOneBase = 0;
  let postPeriodVisitors = 0;
  let postPeriodBase = 0;
  let analyzedPeriods = 0;
  let strongestCohort: RetentionSummary["strongestCohort"] = null;

  const cohorts = sourceCohorts.map((cohort) => {
    const size = Math.max(0, Number(cohort.size ?? 0));
    const availableMaxIndex = cohortMaxPeriodIndex(
      cohort,
      window.to,
      granularity,
      window.timeZone,
    );
    const periodMap = new Map(
      cohort.periods.map((period) => [
        Number(period.index ?? 0),
        {
          visitors: Math.max(0, Number(period.visitors ?? 0)),
          rate: Math.max(0, Math.min(1, Number(period.rate ?? 0))),
        },
      ]),
    );

    let cohortPostVisitors = 0;
    let cohortPostBase = 0;
    const cells = columns.map((index) => {
      const available = index <= availableMaxIndex;
      if (!available) {
        return {
          index,
          visitors: 0,
          rate: 0,
          available: false,
        };
      }

      const period = periodMap.get(index);
      const visitors = period?.visitors ?? (index === 0 && size > 0 ? size : 0);
      const rate = period?.rate ?? (index === 0 && size > 0 ? 1 : 0);
      const average = periodAverages[index];
      if (average) {
        average.visitors += visitors;
        average.base += size;
      }

      if (index === 1) {
        periodOneVisitors += visitors;
        periodOneBase += size;
      }

      if (index > 0) {
        postPeriodVisitors += visitors;
        postPeriodBase += size;
        analyzedPeriods += 1;
        cohortPostVisitors += visitors;
        cohortPostBase += size;
      }

      return {
        index,
        visitors,
        rate,
        available: true,
      };
    });

    const label = formatCohortDate(
      locale,
      granularity,
      Number(cohort.bucket ?? 0),
      window.timeZone,
    );
    const averagePostRate =
      cohortPostBase > 0 ? cohortPostVisitors / cohortPostBase : null;
    if (
      averagePostRate !== null &&
      (!strongestCohort || averagePostRate > strongestCohort.rate)
    ) {
      strongestCohort = {
        label,
        rate: averagePostRate,
      };
    }

    return {
      bucket: Number(cohort.bucket ?? 0),
      label,
      size,
      cells,
      averagePostRate,
    };
  });

  for (const average of periodAverages) {
    average.rate = average.base > 0 ? average.visitors / average.base : null;
  }

  return {
    columns,
    cohorts,
    periodAverages,
    summary: {
      cohortCount: cohorts.length,
      totalVisitors: cohorts.reduce((sum, cohort) => sum + cohort.size, 0),
      periodOneRate:
        periodOneBase > 0 ? periodOneVisitors / periodOneBase : null,
      periodOneBase,
      averageReturnRate:
        postPeriodBase > 0 ? postPeriodVisitors / postPeriodBase : null,
      analyzedPeriods,
      strongestCohort,
    },
  };
}

function retentionCohortPosition(
  window: TimeWindow,
  granularity: RetentionGranularity,
  bucket: number,
): number | null {
  const target = Number(bucket);
  let current = startOfZonedInterval(window.from, granularity, window.timeZone);
  if (!Number.isFinite(target) || !Number.isFinite(current)) return null;

  for (let index = 0; index < 2000; index += 1) {
    if (current === target) return index;
    if (current > target) return null;
    let next = addZonedInterval(current, granularity, window.timeZone);
    if (!Number.isFinite(next) || next <= current) {
      next = current + retentionIntervalFallbackMs(granularity);
    }
    current = next;
  }
  return null;
}

function retentionCohortRowKey(
  window: TimeWindow,
  granularity: RetentionGranularity,
  cohort: RetentionCohortView,
): string {
  const position = retentionCohortPosition(window, granularity, cohort.bucket);
  return position === null ? `bucket:${cohort.bucket}` : `position:${position}`;
}

function retentionCohortRowSortKey(
  window: TimeWindow,
  granularity: RetentionGranularity,
  cohort: RetentionCohortView,
): number {
  return (
    retentionCohortPosition(window, granularity, cohort.bucket) ?? cohort.bucket
  );
}

function buildRetentionComparisonViewModel(
  current: RetentionViewModel,
  comparison: RetentionViewModel,
  currentWindow: TimeWindow,
  comparisonWindow: TimeWindow,
  granularity: RetentionGranularity,
): RetentionComparisonViewModel {
  const rows = new Map<string, RetentionComparisonRow & { sortKey: number }>();

  for (const cohort of current.cohorts) {
    const key = retentionCohortRowKey(currentWindow, granularity, cohort);
    rows.set(key, {
      key,
      current: cohort,
      comparison: null,
      sortKey: retentionCohortRowSortKey(currentWindow, granularity, cohort),
    });
  }

  for (const cohort of comparison.cohorts) {
    const key = retentionCohortRowKey(comparisonWindow, granularity, cohort);
    const existing = rows.get(key);
    if (existing) {
      existing.comparison = cohort;
    } else {
      rows.set(key, {
        key,
        current: null,
        comparison: cohort,
        sortKey: retentionCohortRowSortKey(
          comparisonWindow,
          granularity,
          cohort,
        ),
      });
    }
  }

  return {
    current,
    comparison,
    columns: Array.from(
      { length: Math.max(current.columns.length, comparison.columns.length) },
      (_, index) => index,
    ),
    rows: Array.from(rows.values())
      .sort((left, right) => left.sortKey - right.sortKey)
      .map(({ key, current: currentCohort, comparison: comparisonCohort }) => ({
        key,
        current: currentCohort,
        comparison: comparisonCohort,
      })),
  };
}

function retentionCellAt(
  cohort: RetentionCohortView | null,
  index: number,
): RetentionCellView {
  return (
    cohort?.cells[index] ?? {
      index,
      visitors: 0,
      rate: 0,
      available: false,
    }
  );
}

function retentionAverageAt(
  viewModel: RetentionViewModel,
  index: number,
): RetentionPeriodAverage {
  return (
    viewModel.periodAverages[index] ?? {
      index,
      visitors: 0,
      base: 0,
      rate: null,
    }
  );
}

function retentionComparisonChange(
  current: number | null,
  comparison: number | null,
): number | null {
  if (
    current === null ||
    comparison === null ||
    !Number.isFinite(current) ||
    !Number.isFinite(comparison) ||
    comparison === 0
  ) {
    return null;
  }
  return ((current - comparison) / comparison) * 100;
}

function formatRetentionChange(value: number | null): string | null {
  if (value === null || !Number.isFinite(value)) return null;
  return `${value >= 0 ? "+" : ""}${value.toFixed(1)}%`;
}

function retentionChangeClass(value: number | null): string {
  if (value === null) return "text-muted-foreground";
  return value >= 0 ? "text-emerald-600" : "text-rose-600";
}

function retentionCellStyle(
  rate: number,
  available: boolean,
  colorVariable = "var(--color-chart-4)",
): CSSProperties {
  if (!available) return {};
  const normalized = Math.max(0, Math.min(1, rate));
  const visibleDepth =
    normalized <= 0
      ? 0
      : normalized <= 0.08
        ? Math.pow(normalized / 0.08, 0.64)
        : 1 + Math.pow((normalized - 0.08) / 0.92, 0.58) * 0.36;
  const mix = Math.round(8 + Math.min(1.36, visibleDepth) * 34);
  return {
    backgroundColor:
      normalized <= 0
        ? "color-mix(in oklab, var(--color-muted) 82%, var(--color-background))"
        : `color-mix(in oklab, ${colorVariable} ${mix}%, var(--color-muted))`,
    color: mix >= 42 ? "oklch(0.985 0 0)" : "var(--color-foreground)",
  };
}

function RetentionChangeRate({ value }: { value: number | null }) {
  if (value === null) return null;
  const ChangeIcon = value >= 0 ? RiArrowUpLine : RiArrowDownLine;
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-end gap-0.5 font-mono text-xs leading-none tabular-nums",
        retentionChangeClass(value),
      )}
    >
      <ChangeIcon className="size-3.5" />
      {formatRetentionChange(value)}
    </span>
  );
}

const RetentionMetricCell = memo(function RetentionMetricCell({
  icon: Icon,
  label,
  value,
  detail,
  comparisonChange,
  comparisonLabel,
  comparisonValue,
  loading = false,
}: {
  icon: RemixiconComponentType;
  label: string;
  value: string;
  detail: string;
  comparisonChange?: number | null;
  comparisonLabel?: string;
  comparisonValue?: string | null;
  loading?: boolean;
}) {
  const contentKey = loading ? "loading" : `${value}:${comparisonChange ?? ""}`;
  const detailKey = loading
    ? "loading"
    : comparisonChange === undefined
      ? detail
      : `comparison:${comparisonChange ?? "unavailable"}:${comparisonLabel ?? ""}:${comparisonValue ?? "unavailable"}`;

  return (
    <div className="min-w-0 bg-card p-4">
      <div className="flex min-w-0 items-center gap-2">
        <span className="inline-flex shrink-0 items-center justify-center text-muted-foreground">
          <Icon className="size-[11px]" />
        </span>
        <p className="min-w-0 truncate text-[11px] uppercase text-muted-foreground">
          {label}
        </p>
      </div>
      <AutoResizer initial animateHeight={false} className="mt-3 h-7">
        <AutoTransition
          className="h-7"
          transitionKey={contentKey}
          initial={false}
          duration={0.2}
          type="fade"
          presenceMode="wait"
        >
          {loading ? (
            <div key="loading" className="flex h-7 items-center">
              <Spinner className="size-5" />
            </div>
          ) : (
            <div
              key={contentKey}
              className="flex h-7 min-w-0 items-end gap-1.5 leading-none"
            >
              <span className="min-w-0 truncate font-mono text-xl leading-none font-semibold text-foreground">
                {value}
              </span>
              {comparisonChange !== undefined ? (
                <RetentionChangeRate value={comparisonChange} />
              ) : null}
            </div>
          )}
        </AutoTransition>
      </AutoResizer>
      <AutoTransition
        initial={false}
        transitionKey={detailKey}
        className="mt-3 h-[14px]"
        duration={0.2}
        type="fade"
        presenceMode="wait"
      >
        {loading ? (
          <Skeleton
            key="loading"
            className="h-full w-[min(12rem,72%)] rounded-none"
          />
        ) : comparisonChange === undefined ? (
          <p
            key={detail}
            className="h-[14px] min-w-0 truncate text-[11px] leading-[14px] text-muted-foreground"
          >
            {detail}
          </p>
        ) : (
          <div
            key={detailKey}
            className="h-[14px] min-w-0 truncate font-mono text-[11px] leading-[14px] text-muted-foreground"
          >
            {comparisonLabel}: {comparisonValue ?? "--"}
          </div>
        )}
      </AutoTransition>
    </div>
  );
});

const RetentionSummaryGrid = memo(function RetentionSummaryGrid({
  locale,
  labels,
  viewModel,
  comparisonViewModel,
  comparisonLabel,
  loading = false,
}: {
  locale: Locale;
  labels: RetentionCopy;
  viewModel: RetentionViewModel;
  comparisonViewModel?: RetentionViewModel | null;
  comparisonLabel: string;
  loading?: boolean;
}) {
  const { summary } = viewModel;
  const comparisonSummary = comparisonViewModel?.summary;

  return (
    <Card className="py-0">
      <CardContent className="p-0">
        <div className="grid gap-px overflow-hidden bg-border/70 sm:grid-cols-2 xl:grid-cols-4">
          <RetentionMetricCell
            icon={RiCalendarLine}
            label={labels.cohortsMetric}
            loading={loading}
            value={numberFormat(locale, summary.cohortCount)}
            detail={`${numberFormat(locale, viewModel.columns.length)} ${labels.periodsAnalyzed}`}
            comparisonLabel={comparisonLabel}
            comparisonValue={
              comparisonSummary
                ? numberFormat(locale, comparisonSummary.cohortCount)
                : undefined
            }
            comparisonChange={
              comparisonSummary
                ? retentionComparisonChange(
                    summary.cohortCount,
                    comparisonSummary.cohortCount,
                  )
                : undefined
            }
          />
          <RetentionMetricCell
            icon={RiGroupLine}
            label={labels.visitorsMetric}
            loading={loading}
            value={numberFormat(locale, summary.totalVisitors)}
            detail={labels.cohortDetail}
            comparisonLabel={comparisonLabel}
            comparisonValue={
              comparisonSummary
                ? numberFormat(locale, comparisonSummary.totalVisitors)
                : undefined
            }
            comparisonChange={
              comparisonSummary
                ? retentionComparisonChange(
                    summary.totalVisitors,
                    comparisonSummary.totalVisitors,
                  )
                : undefined
            }
          />
          <RetentionMetricCell
            icon={RiPercentLine}
            label={labels.periodOneMetric}
            loading={loading}
            value={
              summary.periodOneRate === null
                ? "--"
                : percentFormat(locale, summary.periodOneRate)
            }
            detail={
              summary.periodOneBase > 0
                ? `${numberFormat(locale, summary.periodOneBase)} ${labels.eligibleVisitors}`
                : labels.noEligibleCohorts
            }
            comparisonLabel={comparisonLabel}
            comparisonValue={
              comparisonSummary
                ? comparisonSummary.periodOneRate === null
                  ? null
                  : percentFormat(locale, comparisonSummary.periodOneRate)
                : undefined
            }
            comparisonChange={
              comparisonSummary
                ? retentionComparisonChange(
                    summary.periodOneRate,
                    comparisonSummary.periodOneRate,
                  )
                : undefined
            }
          />
          <RetentionMetricCell
            icon={RiRepeat2Line}
            label={labels.averageReturnMetric}
            loading={loading}
            value={
              summary.averageReturnRate === null
                ? "--"
                : percentFormat(locale, summary.averageReturnRate)
            }
            detail={
              summary.strongestCohort
                ? `${labels.strongestCohortMetric}: ${summary.strongestCohort.label} ${percentFormat(
                    locale,
                    summary.strongestCohort.rate,
                  )}`
                : labels.noEligibleCohorts
            }
            comparisonLabel={comparisonLabel}
            comparisonValue={
              comparisonSummary
                ? comparisonSummary.averageReturnRate === null
                  ? null
                  : percentFormat(locale, comparisonSummary.averageReturnRate)
                : undefined
            }
            comparisonChange={
              comparisonSummary
                ? retentionComparisonChange(
                    summary.averageReturnRate,
                    comparisonSummary.averageReturnRate,
                  )
                : undefined
            }
          />
        </div>
      </CardContent>
    </Card>
  );
});

const RetentionStateCard = memo(function RetentionStateCard({
  title,
  subtitle,
  icon: Icon,
}: {
  title: string;
  subtitle: string;
  icon: RemixiconComponentType;
}) {
  return (
    <Card>
      <CardContent className="flex min-h-48 flex-col items-center justify-center gap-3 text-center">
        <span className="inline-flex size-10 items-center justify-center border bg-muted/50 text-muted-foreground">
          <Icon className="size-5" />
        </span>
        <div className="space-y-1">
          <p className="font-medium">{title}</p>
          <p className="max-w-md text-muted-foreground">{subtitle}</p>
        </div>
      </CardContent>
    </Card>
  );
});

const RetentionLoading = memo(function RetentionLoading({
  shape,
}: {
  shape: RetentionLoadingShape;
}) {
  const rows = Array.from({ length: shape.rows }, (_, index) => index);
  const columns = Array.from({ length: shape.columns }, (_, index) => index);

  return (
    <OverlayScrollbar className="pb-1" aria-hidden="true">
      <table
        className={cn(
          RETENTION_TABLE_COLUMNS,
          "w-max min-w-full table-fixed border-separate border-spacing-0 text-left text-xs",
        )}
      >
        <colgroup>
          <col className={RETENTION_COHORT_COLUMN} />
          <col className={RETENTION_SIZE_COLUMN} />
          {columns.map((index) => (
            <col key={index} className={RETENTION_PERIOD_COLUMN} />
          ))}
        </colgroup>
        <thead>
          <tr>
            <th
              className={cn(
                RETENTION_COHORT_COLUMN,
                "sticky left-0 z-40 border-b bg-card py-2 pr-2 pl-3",
              )}
            >
              <Skeleton className="h-3 w-16" />
            </th>
            <th
              className={cn(
                RETENTION_SIZE_COLUMN,
                "sticky left-[var(--retention-cohort-width)] z-40 border-r border-b bg-card px-2 py-2",
              )}
            >
              <Skeleton className="ml-auto h-3 w-8" />
            </th>
            {columns.map((index) => (
              <th
                key={index}
                className={cn(RETENTION_PERIOD_COLUMN, "border-b px-1 py-2")}
              >
                <Skeleton className="mx-auto h-3 w-10" />
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((rowIndex) => (
            <tr key={rowIndex}>
              <th
                className={cn(
                  RETENTION_COHORT_COLUMN,
                  "sticky left-0 z-30 border-b bg-card py-2 pr-2 pl-3",
                )}
              >
                <Skeleton className="h-4 w-14" />
              </th>
              <td
                className={cn(
                  RETENTION_SIZE_COLUMN,
                  "sticky left-[var(--retention-cohort-width)] z-30 border-r border-b bg-card px-2 py-2",
                )}
              >
                <Skeleton className="ml-auto h-4 w-9" />
              </td>
              {columns.map((cellIndex) => (
                <td
                  key={`${rowIndex}-${cellIndex}`}
                  className={cn(
                    RETENTION_PERIOD_COLUMN,
                    "border-r border-b p-1 align-middle",
                  )}
                >
                  <Skeleton className="h-8 w-full" />
                </td>
              ))}
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr>
            <th
              className={cn(
                RETENTION_COHORT_COLUMN,
                "sticky left-0 z-30 border-t bg-card py-2 pr-2 pl-3",
              )}
            >
              <Skeleton className="h-4 w-16" />
            </th>
            <td
              className={cn(
                RETENTION_SIZE_COLUMN,
                "sticky left-[var(--retention-cohort-width)] z-30 border-r border-t bg-card px-2 py-2",
              )}
            >
              <Skeleton className="ml-auto h-4 w-9" />
            </td>
            {columns.map((index) => (
              <td
                key={index}
                className={cn(
                  RETENTION_PERIOD_COLUMN,
                  "border-t border-r p-1 align-middle",
                )}
              >
                <Skeleton className="h-8 w-full" />
              </td>
            ))}
          </tr>
        </tfoot>
      </table>
    </OverlayScrollbar>
  );
});

const RetentionCell = memo(function RetentionCell({
  locale,
  labels,
  messages,
  cohort,
  cell,
}: {
  locale: Locale;
  labels: RetentionCopy;
  messages: AppMessages;
  cohort: RetentionCohortView;
  cell: RetentionCellView;
}) {
  const tooltipItems = cell.available
    ? [
        { label: messages.retention.cohortDate, value: cohort.label },
        { label: labels.sizeDetail, value: numberFormat(locale, cohort.size) },
        {
          label: labels.visitorsDetail,
          value: numberFormat(locale, cell.visitors),
        },
        {
          label: labels.rateDetail,
          value: percentFormat(locale, cell.rate),
        },
      ]
    : [{ label: labels.unavailableCell, value: "" }];
  const tooltip = cell.available
    ? tooltipItems.map((item) => `${item.label}: ${item.value}`).join("\n")
    : labels.unavailableCell;

  return (
    <td
      className={cn(
        RETENTION_PERIOD_COLUMN,
        "border-b border-r p-1 align-middle",
      )}
    >
      <AnalyticsDetailsTooltipTarget
        className="block"
        locale={locale}
        request={{
          key: `retention-cell:${cohort.bucket}:${cell.index}:${cell.available}`,
          items: tooltipItems,
        }}
      >
        {cell.available ? (
          <button
            type="button"
            className="flex h-8 w-full items-center justify-center font-mono text-[11px] tabular-nums outline-none ring-0 transition-transform hover:scale-[1.035] focus-visible:ring-2 focus-visible:ring-ring/70"
            style={retentionCellStyle(cell.rate, cell.available)}
            aria-label={tooltip}
          >
            {percentFormat(locale, cell.rate)}
          </button>
        ) : (
          <div
            className="h-8 w-full border border-dashed border-border/70 bg-muted/20"
            aria-label={tooltip}
          />
        )}
      </AnalyticsDetailsTooltipTarget>
    </td>
  );
});

const RetentionComparisonCell = memo(function RetentionComparisonCell({
  locale,
  labels,
  messages,
  current,
  comparison,
  currentCell,
  comparisonCell,
  currentTooltipDetail,
  comparisonTooltipDetail,
  comparisonLabel,
  tooltipKey,
}: {
  locale: Locale;
  labels: RetentionCopy;
  messages: AppMessages;
  current: RetentionCohortView | null;
  comparison: RetentionCohortView | null;
  currentCell: RetentionCellView;
  comparisonCell: RetentionCellView;
  currentTooltipDetail?: string;
  comparisonTooltipDetail?: string;
  comparisonLabel: string;
  tooltipKey: string;
}) {
  const currentLabel = messages.dashboardHeader.compareCurrentPeriod;
  const currentTooltipValue = currentCell.available
    ? (currentTooltipDetail ??
      `${messages.retention.cohortDate}: ${current?.label ?? "--"} · ${labels.sizeDetail}: ${numberFormat(locale, current?.size ?? 0)} · ${labels.visitorsDetail}: ${numberFormat(locale, currentCell.visitors)} · ${labels.rateDetail}: ${percentFormat(locale, currentCell.rate)}`)
    : labels.unavailableCell;
  const comparisonTooltipValue = comparisonCell.available
    ? (comparisonTooltipDetail ??
      `${messages.retention.cohortDate}: ${comparison?.label ?? "--"} · ${labels.sizeDetail}: ${numberFormat(locale, comparison?.size ?? 0)} · ${labels.visitorsDetail}: ${numberFormat(locale, comparisonCell.visitors)} · ${labels.rateDetail}: ${percentFormat(locale, comparisonCell.rate)}`)
    : labels.unavailableCell;
  const tooltipItems = [
    { label: currentLabel, value: currentTooltipValue },
    {
      label: comparisonLabel,
      value: comparisonTooltipValue,
    },
  ];
  const tooltip = tooltipItems
    .map((item) => `${item.label}: ${item.value}`)
    .join("\n");

  const renderBand = (
    cell: RetentionCellView,
    colorVariable: string,
    key: string,
  ) =>
    cell.available ? (
      <button
        key={key}
        type="button"
        className="flex h-full min-h-0 w-full flex-1 items-center justify-center font-mono text-[10px] tabular-nums outline-none ring-0 focus-visible:ring-2 focus-visible:ring-ring/70"
        style={retentionCellStyle(cell.rate, true, colorVariable)}
        aria-label={`${key === "current" ? currentLabel : comparisonLabel}: ${percentFormat(locale, cell.rate)}`}
      >
        {percentFormat(locale, cell.rate)}
      </button>
    ) : (
      <div
        key={key}
        className="h-full min-h-0 w-full flex-1 border border-dashed border-border/70 bg-muted/20"
        aria-label={labels.unavailableCell}
      />
    );

  return (
    <td
      className={cn(
        RETENTION_PERIOD_COLUMN,
        "relative border-b border-r p-0 align-middle",
      )}
    >
      <div className="absolute inset-1">
        <AnalyticsDetailsTooltipTarget
          className="block h-full"
          locale={locale}
          request={{
            key: tooltipKey,
            items: tooltipItems,
          }}
        >
          <div
            className="flex h-full flex-col gap-px transition-transform hover:scale-[1.035]"
            aria-label={tooltip}
          >
            {renderBand(currentCell, "var(--color-chart-4)", "current")}
            {renderBand(
              comparisonCell,
              "var(--color-compare-chart-4)",
              "comparison",
            )}
          </div>
        </AnalyticsDetailsTooltipTarget>
      </div>
    </td>
  );
});

const RetentionMatrix = memo(function RetentionMatrix({
  locale,
  messages,
  labels,
  viewModel,
  comparisonViewModel,
  comparisonLabel,
  loading = false,
  loadingShape,
}: {
  locale: Locale;
  messages: AppMessages;
  labels: RetentionCopy;
  viewModel: RetentionViewModel;
  comparisonViewModel?: RetentionComparisonViewModel | null;
  comparisonLabel?: string;
  loading?: boolean;
  loadingShape: RetentionLoadingShape;
}) {
  const columns = comparisonViewModel?.columns ?? viewModel.columns;
  const hasComparison = Boolean(comparisonViewModel);
  const resolvedComparisonLabel = comparisonLabel ?? "Comparison";
  const renderPairValue = (
    currentValue: number | null,
    comparisonValue: number | null,
  ) => (
    <div className="grid h-8 grid-rows-2 items-center text-right font-mono tabular-nums">
      <span className="truncate">
        {currentValue === null ? "--" : numberFormat(locale, currentValue)}
      </span>
      <span className="truncate text-muted-foreground">
        {comparisonValue === null
          ? "--"
          : numberFormat(locale, comparisonValue)}
      </span>
    </div>
  );

  return (
    <Card>
      <CardHeader className="gap-3 md:grid-cols-[1fr_auto]">
        <div className="space-y-1">
          <CardTitle className="inline-flex items-center gap-2">
            <RiRepeat2Line className="size-4" />
            {labels.matrixTitle}
          </CardTitle>
          <CardDescription>{labels.matrixSubtitle}</CardDescription>
        </div>
        <div className="flex flex-wrap items-center justify-end gap-x-3 gap-y-1 text-[11px] text-muted-foreground md:justify-self-end">
          {hasComparison ? (
            <>
              <span className="inline-flex items-center gap-1">
                <span className="size-2 bg-chart-4" aria-hidden="true" />
                {messages.dashboardHeader.compareCurrentPeriod}
              </span>
              <span className="inline-flex items-center gap-1">
                <span
                  className="size-2 bg-compare-chart-4"
                  aria-hidden="true"
                />
                {resolvedComparisonLabel}
              </span>
            </>
          ) : null}
          <span>{labels.legendLow}</span>
          <span
            aria-hidden="true"
            className="relative h-2 w-28 overflow-hidden border bg-muted"
          >
            <span
              className="absolute inset-y-0 right-0 w-[76%]"
              style={{
                background:
                  "linear-gradient(90deg, var(--color-muted) 0%, color-mix(in oklab, var(--color-chart-4) 16%, var(--color-muted)) 22%, color-mix(in oklab, var(--color-chart-4) 28%, var(--color-muted)) 46%, color-mix(in oklab, var(--color-chart-4) 42%, var(--color-muted)) 72%, color-mix(in oklab, var(--color-chart-4) 54%, var(--color-muted)) 100%)",
              }}
            />
          </span>
          <span>{labels.legendHigh}</span>
        </div>
      </CardHeader>
      <CardContent className="px-0">
        <AutoTransition
          transitionKey={loading ? "loading" : "ready"}
          initial={false}
          duration={0.18}
          type="fade"
          presenceMode="wait"
        >
          {loading ? (
            <RetentionLoading shape={loadingShape} />
          ) : (
            <AnalyticsTimeTooltipProvider messages={messages}>
              <OverlayScrollbar className="pb-1">
                <table
                  className={cn(
                    RETENTION_TABLE_COLUMNS,
                    "w-max min-w-full table-fixed border-separate border-spacing-0 text-left text-xs",
                  )}
                >
                  <colgroup>
                    <col className={RETENTION_COHORT_COLUMN} />
                    <col className={RETENTION_SIZE_COLUMN} />
                    {columns.map((index) => (
                      <col key={index} className={RETENTION_PERIOD_COLUMN} />
                    ))}
                  </colgroup>
                  <thead>
                    <tr>
                      <th
                        className={cn(
                          RETENTION_COHORT_COLUMN,
                          "sticky left-0 z-40 truncate border-b bg-card py-2 pr-2 pl-3 font-medium text-muted-foreground",
                        )}
                      >
                        {messages.retention.cohortDate}
                      </th>
                      <th
                        className={cn(
                          RETENTION_SIZE_COLUMN,
                          "sticky left-[var(--retention-cohort-width)] z-40 border-r border-b bg-card px-2 py-2 text-right font-medium whitespace-nowrap text-muted-foreground",
                        )}
                      >
                        {messages.retention.cohortSize}
                      </th>
                      {columns.map((index) => (
                        <th
                          key={index}
                          className={cn(
                            RETENTION_PERIOD_COLUMN,
                            "border-b px-1 py-2 text-center font-medium text-muted-foreground",
                          )}
                        >
                          <span className="inline-block w-16 truncate">
                            {periodLabel(messages, labels, index)}
                          </span>
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {hasComparison && comparisonViewModel ? (
                      <>
                        <tr>
                          <th
                            className={cn(
                              RETENTION_COHORT_COLUMN,
                              "sticky left-0 z-30 truncate border-b bg-card py-2 pr-2 pl-3 font-medium text-muted-foreground",
                            )}
                          >
                            {labels.overallRetention}
                          </th>
                          <td
                            className={cn(
                              RETENTION_SIZE_COLUMN,
                              "sticky left-[var(--retention-cohort-width)] z-30 border-r border-b bg-card px-2 py-2 text-right font-mono whitespace-nowrap text-muted-foreground",
                            )}
                          >
                            {renderPairValue(
                              viewModel.summary.totalVisitors,
                              comparisonViewModel.comparison.summary
                                .totalVisitors,
                            )}
                          </td>
                          {columns.map((index) => {
                            const currentAverage = retentionAverageAt(
                              viewModel,
                              index,
                            );
                            const comparisonAverage = retentionAverageAt(
                              comparisonViewModel.comparison,
                              index,
                            );
                            return (
                              <RetentionComparisonCell
                                key={index}
                                locale={locale}
                                labels={labels}
                                messages={messages}
                                current={null}
                                comparison={null}
                                currentCell={{
                                  index,
                                  visitors: currentAverage.visitors,
                                  rate: currentAverage.rate ?? 0,
                                  available: currentAverage.rate !== null,
                                }}
                                comparisonCell={{
                                  index,
                                  visitors: comparisonAverage.visitors,
                                  rate: comparisonAverage.rate ?? 0,
                                  available: comparisonAverage.rate !== null,
                                }}
                                currentTooltipDetail={
                                  currentAverage.rate === null
                                    ? labels.unavailableCell
                                    : `${periodLabel(messages, labels, index)} · ${numberFormat(locale, currentAverage.visitors)} · ${percentFormat(locale, currentAverage.rate)}`
                                }
                                comparisonTooltipDetail={
                                  comparisonAverage.rate === null
                                    ? labels.unavailableCell
                                    : `${periodLabel(messages, labels, index)} · ${numberFormat(locale, comparisonAverage.visitors)} · ${percentFormat(locale, comparisonAverage.rate)}`
                                }
                                comparisonLabel={resolvedComparisonLabel}
                                tooltipKey={`retention-overall:${index}:${currentAverage.rate ?? "unavailable"}:${comparisonAverage.rate ?? "unavailable"}`}
                              />
                            );
                          })}
                        </tr>
                        {comparisonViewModel.rows.map((row) => (
                          <tr key={row.key} className="group">
                            <th
                              className={cn(
                                RETENTION_COHORT_COLUMN,
                                "sticky left-0 z-30 border-b bg-card py-2 pr-2 pl-3 font-mono font-medium group-hover:bg-muted",
                              )}
                            >
                              <div className="grid h-8 grid-rows-2 items-center overflow-hidden leading-4">
                                <span className="truncate">
                                  {row.current?.label ?? "--"}
                                </span>
                                <span className="truncate text-muted-foreground">
                                  {row.comparison?.label ?? "--"}
                                </span>
                              </div>
                            </th>
                            <td
                              className={cn(
                                RETENTION_SIZE_COLUMN,
                                "sticky left-[var(--retention-cohort-width)] z-30 border-r border-b bg-card px-2 py-2 text-right font-mono tabular-nums whitespace-nowrap text-muted-foreground group-hover:bg-muted",
                              )}
                            >
                              {renderPairValue(
                                row.current?.size ?? null,
                                row.comparison?.size ?? null,
                              )}
                            </td>
                            {columns.map((index) => (
                              <RetentionComparisonCell
                                key={`${row.key}-${index}`}
                                locale={locale}
                                labels={labels}
                                messages={messages}
                                current={row.current}
                                comparison={row.comparison}
                                currentCell={retentionCellAt(
                                  row.current,
                                  index,
                                )}
                                comparisonCell={retentionCellAt(
                                  row.comparison,
                                  index,
                                )}
                                comparisonLabel={resolvedComparisonLabel}
                                tooltipKey={`retention-cell:${row.key}:${index}`}
                              />
                            ))}
                          </tr>
                        ))}
                      </>
                    ) : (
                      <>
                        <tr>
                          <th
                            className={cn(
                              RETENTION_COHORT_COLUMN,
                              "sticky left-0 z-30 truncate border-b bg-card py-2 pr-2 pl-3 font-medium text-muted-foreground",
                            )}
                          >
                            {labels.overallRetention}
                          </th>
                          <td
                            className={cn(
                              RETENTION_SIZE_COLUMN,
                              "sticky left-[var(--retention-cohort-width)] z-30 border-r border-b bg-card px-2 py-2 text-right font-mono whitespace-nowrap text-muted-foreground",
                            )}
                          >
                            {numberFormat(
                              locale,
                              viewModel.summary.totalVisitors,
                            )}
                          </td>
                          {viewModel.periodAverages.map((average) => {
                            const tooltipItems =
                              average.rate === null
                                ? [
                                    {
                                      label: periodLabel(
                                        messages,
                                        labels,
                                        average.index,
                                      ),
                                      value: labels.unavailableCell,
                                    },
                                  ]
                                : [
                                    {
                                      label: labels.overallRetention,
                                      value: periodLabel(
                                        messages,
                                        labels,
                                        average.index,
                                      ),
                                    },
                                    {
                                      label: labels.visitorsDetail,
                                      value: numberFormat(
                                        locale,
                                        average.visitors,
                                      ),
                                    },
                                    {
                                      label: labels.rateDetail,
                                      value: percentFormat(
                                        locale,
                                        average.rate,
                                      ),
                                    },
                                  ];
                            const tooltip = tooltipItems
                              .map((item) => `${item.label}: ${item.value}`)
                              .join("\n");
                            return (
                              <td
                                key={average.index}
                                className={cn(
                                  RETENTION_PERIOD_COLUMN,
                                  "border-b border-r p-1 align-middle",
                                )}
                              >
                                <AnalyticsDetailsTooltipTarget
                                  className="block"
                                  locale={locale}
                                  request={{
                                    key: `retention-overall:${average.index}:${average.rate ?? "unavailable"}`,
                                    items: tooltipItems,
                                  }}
                                >
                                  <button
                                    type="button"
                                    className={cn(
                                      "flex h-8 w-full items-center justify-center font-mono text-[11px] tabular-nums outline-none ring-0 transition-transform hover:scale-[1.035] focus-visible:ring-2 focus-visible:ring-ring/70",
                                      average.rate === null &&
                                        "text-muted-foreground",
                                    )}
                                    style={retentionCellStyle(
                                      average.rate ?? 0,
                                      average.rate !== null,
                                    )}
                                    aria-label={tooltip}
                                  >
                                    {average.rate === null
                                      ? "--"
                                      : percentFormat(locale, average.rate)}
                                  </button>
                                </AnalyticsDetailsTooltipTarget>
                              </td>
                            );
                          })}
                        </tr>
                        {viewModel.cohorts.map((cohort) => (
                          <tr key={cohort.bucket} className="group">
                            <th
                              className={cn(
                                RETENTION_COHORT_COLUMN,
                                "sticky left-0 z-30 truncate border-b bg-card py-2 pr-2 pl-3 font-mono font-medium group-hover:bg-muted",
                              )}
                            >
                              {cohort.label}
                            </th>
                            <td
                              className={cn(
                                RETENTION_SIZE_COLUMN,
                                "sticky left-[var(--retention-cohort-width)] z-30 border-r border-b bg-card px-2 py-2 text-right font-mono tabular-nums whitespace-nowrap text-muted-foreground group-hover:bg-muted",
                              )}
                            >
                              {numberFormat(locale, cohort.size)}
                            </td>
                            {cohort.cells.map((cell) => (
                              <RetentionCell
                                key={`${cohort.bucket}-${cell.index}`}
                                locale={locale}
                                labels={labels}
                                messages={messages}
                                cohort={cohort}
                                cell={cell}
                              />
                            ))}
                          </tr>
                        ))}
                      </>
                    )}
                  </tbody>
                </table>
              </OverlayScrollbar>
            </AnalyticsTimeTooltipProvider>
          )}
        </AutoTransition>
      </CardContent>
    </Card>
  );
});

export function RetentionClientPage({
  locale,
  messages,
  siteId,
}: RetentionClientPageProps) {
  const labels = messages.retention;
  const { filters, window: timeWindow } = useDashboardQuery() as {
    filters: FilterDocument;
    window: TimeWindow;
  };
  const filtersKey = useMemo(() => filterQueryKey(filters), [filters]);
  const comparisonQuery = useDashboardComparisonQuery(timeWindow, filters);
  const comparisonLabel = dashboardComparisonLabel(messages, comparisonQuery);
  const comparisonFiltersKey = useMemo(
    () => (comparisonQuery ? filterQueryKey(comparisonQuery.filters) : "none"),
    [comparisonQuery],
  );
  const granularity = timeWindow.interval;
  const loadingShape = useMemo(
    () => retentionLoadingShape(timeWindow, granularity, filters),
    [
      filters,
      filtersKey,
      granularity,
      timeWindow.from,
      timeWindow.timeZone,
      timeWindow.to,
    ],
  );

  const {
    data: queryData,
    isError: error,
    isFetching: loading,
    isPending,
  } = useQuery<RetentionQueryData>({
    queryKey: [
      "dashboard",
      "retention",
      siteId,
      timeWindow.from,
      timeWindow.to,
      timeWindow.interval,
      timeWindow.timeZone,
      granularity,
      filtersKey,
      comparisonQuery?.mode ?? "none",
      comparisonQuery?.window.from ?? null,
      comparisonQuery?.window.to ?? null,
      comparisonQuery?.window.timeZone ?? null,
      comparisonFiltersKey,
    ],
    queryFn: async ({ signal }) => {
      const currentRequest = fetchRetention(siteId, timeWindow, filters, {
        granularity,
        signal,
      });
      if (!comparisonQuery) {
        return {
          current: await currentRequest,
          comparison: null,
        };
      }

      const [current, comparison] = await Promise.all([
        currentRequest,
        fetchRetention(
          siteId,
          comparisonQuery.window,
          comparisonQuery.filters,
          { granularity, signal },
        ),
      ]);
      return { current, comparison };
    },
    enabled: typeof window !== "undefined",
  });
  const initialLoading = isPending && queryData === undefined;
  const resolvedLoading = loading || initialLoading;

  const viewModel = useMemo(
    () =>
      buildRetentionViewModel(
        queryData?.current ?? null,
        locale,
        messages,
        labels,
        granularity,
        timeWindow,
      ),
    [queryData?.current, locale, messages, labels, granularity, timeWindow],
  );
  const comparisonViewModel = useMemo(() => {
    if (!comparisonQuery || !queryData?.comparison) return null;
    const comparison = buildRetentionViewModel(
      queryData.comparison,
      locale,
      messages,
      labels,
      granularity,
      comparisonQuery.window,
    );
    return buildRetentionComparisonViewModel(
      viewModel,
      comparison,
      timeWindow,
      comparisonQuery.window,
      granularity,
    );
  }, [
    comparisonQuery,
    granularity,
    labels,
    locale,
    messages,
    queryData?.comparison,
    timeWindow,
    viewModel,
  ]);
  const isEmpty = !resolvedLoading && !error && viewModel.cohorts.length === 0;
  const bodyState = resolvedLoading
    ? "loading"
    : error
      ? "error"
      : isEmpty
        ? "empty"
        : "ready";

  return (
    <div className="space-y-6">
      <PageHeading
        title={messages.retention.title}
        subtitle={messages.retention.subtitle}
      />

      {resolvedLoading || (!error && !isEmpty) ? (
        <RetentionSummaryGrid
          locale={locale}
          labels={labels}
          viewModel={viewModel}
          comparisonViewModel={comparisonViewModel?.comparison ?? null}
          comparisonLabel={comparisonLabel}
          loading={resolvedLoading}
        />
      ) : null}

      {resolvedLoading || (!error && !isEmpty) ? (
        <div className="space-y-4">
          <RetentionMatrix
            locale={locale}
            messages={messages}
            labels={labels}
            viewModel={viewModel}
            comparisonViewModel={comparisonViewModel}
            comparisonLabel={comparisonLabel}
            loading={resolvedLoading}
            loadingShape={loadingShape}
          />
        </div>
      ) : (
        <AutoTransition
          transitionKey={bodyState}
          duration={0.18}
          type="fade"
          presenceMode="wait"
        >
          {error ? (
            <RetentionStateCard
              title={labels.loadError}
              subtitle={messages.retention.subtitle}
              icon={RiPulseLine}
            />
          ) : (
            <RetentionStateCard
              title={labels.empty}
              subtitle={labels.emptyHint}
              icon={RiRepeat2Line}
            />
          )}
        </AutoTransition>
      )}
    </div>
  );
}
