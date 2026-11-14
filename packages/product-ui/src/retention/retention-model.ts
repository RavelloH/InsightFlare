import type { CSSProperties } from "react";

import { formatI18nTemplate } from "../charts/chart-format";

export interface RetentionLabels {
  readonly periodZero: string;
  readonly periodLabel: string;
  readonly cohortDate: string;
  readonly cohortSize: string;
  readonly matrixTitle: string;
  readonly matrixSubtitle: string;
  readonly legendLow: string;
  readonly legendHigh: string;
  readonly overallRetention: string;
  readonly sizeDetail: string;
  readonly visitorsDetail: string;
  readonly rateDetail: string;
  readonly unavailableCell: string;
  readonly compareCurrentPeriod: string;
  readonly cohortsMetric: string;
  readonly visitorsMetric: string;
  readonly periodOneMetric: string;
  readonly averageReturnMetric: string;
  readonly strongestCohortMetric: string;
  readonly periodsAnalyzed: string;
  readonly cohortDetail: string;
  readonly eligibleVisitors: string;
  readonly noEligibleCohorts: string;
}
export function retentionPeriodLabel(
  labels: Pick<RetentionLabels, "periodZero" | "periodLabel">,
  index: number,
): string {
  if (index === 0) return labels.periodZero;
  return formatI18nTemplate(labels.periodLabel, { n: index });
}
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
