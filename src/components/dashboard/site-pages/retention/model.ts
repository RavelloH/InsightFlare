import { type CSSProperties } from "react";

import {
  addZonedInterval,
  startOfZonedInterval,
} from "@/lib/analytics/time-zone";
import { type RetentionGranularity } from "@/lib/dashboard/client/data/index";
import { intlLocale } from "@/lib/dashboard/format";
import type { TimeWindow } from "@/lib/dashboard/query-state";
import type { RetentionData } from "@/lib/dashboard-api/client/edge";
import type { FilterDocument } from "@/lib/filter-contract/index";
import { filterConditionCount } from "@/lib/filter-contract/index";
import type { Locale } from "@/lib/i18n/config";
import type { AppMessages } from "@/lib/i18n/messages";
import { formatI18nTemplate } from "@/lib/i18n/template";
const RETENTION_LOADING_MAX_ROWS = 36;
const RETENTION_LOADING_MAX_COLUMNS = 240;
export type RetentionCopy = AppMessages["retention"];
export interface RetentionCellView {
  index: number;
  visitors: number;
  rate: number;
  available: boolean;
}
export interface RetentionCohortView {
  bucket: number;
  label: string;
  size: number;
  cells: RetentionCellView[];
  averagePostRate: number | null;
}
export interface RetentionPeriodAverage {
  index: number;
  visitors: number;
  base: number;
  rate: number | null;
}
export interface RetentionSummary {
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
export interface RetentionViewModel {
  columns: number[];
  cohorts: RetentionCohortView[];
  periodAverages: RetentionPeriodAverage[];
  summary: RetentionSummary;
}
export interface RetentionComparisonRow {
  key: string;
  current: RetentionCohortView | null;
  comparison: RetentionCohortView | null;
}
export interface RetentionComparisonViewModel {
  current: RetentionViewModel;
  comparison: RetentionViewModel;
  columns: number[];
  rows: RetentionComparisonRow[];
}
export interface RetentionLoadingShape {
  rows: number;
  columns: number;
}
export function normalizeGranularity(value: string): RetentionGranularity {
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
export function formatCohortDate(
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
export function periodLabel(
  messages: AppMessages,
  labels: RetentionCopy,
  index: number,
): string {
  if (index === 0) return labels.periodZero;
  return formatI18nTemplate(messages.retention.periodLabel, { n: index });
}
export function retentionIntervalFallbackMs(
  granularity: RetentionGranularity,
): number {
  if (granularity === "minute") return 60 * 1000;
  if (granularity === "hour") return 60 * 60 * 1000;
  if (granularity === "day") return 24 * 60 * 60 * 1000;
  if (granularity === "week") return 7 * 24 * 60 * 60 * 1000;
  return 31 * 24 * 60 * 60 * 1000;
}
export function retentionBucketCount(
  window: TimeWindow,
  granularity: RetentionGranularity,
): number {
  if (!Number.isFinite(window.from)) return 1;
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
export function retentionActiveFilterCount(filters: FilterDocument): number {
  return filterConditionCount(filters);
}
export function retentionLoadingShape(
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
export function cohortMaxPeriodIndex(
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
export function buildRetentionViewModel(
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
export function retentionCohortPosition(
  window: TimeWindow,
  granularity: RetentionGranularity,
  bucket: number,
): number | null {
  const target = Number(bucket);
  if (!Number.isFinite(window.from)) return null;
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
export function retentionCohortRowKey(
  window: TimeWindow,
  granularity: RetentionGranularity,
  cohort: RetentionCohortView,
): string {
  const position = retentionCohortPosition(window, granularity, cohort.bucket);
  return position === null ? `bucket:${cohort.bucket}` : `position:${position}`;
}
export function retentionCohortRowSortKey(
  window: TimeWindow,
  granularity: RetentionGranularity,
  cohort: RetentionCohortView,
): number {
  return (
    retentionCohortPosition(window, granularity, cohort.bucket) ?? cohort.bucket
  );
}
export function buildRetentionComparisonViewModel(
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
export function retentionCellAt(
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
export function retentionAverageAt(
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
export function retentionComparisonChange(
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
export function formatRetentionChange(value: number | null): string | null {
  if (value === null || !Number.isFinite(value)) return null;
  return `${value >= 0 ? "+" : ""}${value.toFixed(1)}%`;
}
export function retentionChangeClass(value: number | null): string {
  if (value === null) return "text-muted-foreground";
  return value >= 0 ? "text-emerald-600" : "text-rose-600";
}
export function retentionCellStyle(
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
