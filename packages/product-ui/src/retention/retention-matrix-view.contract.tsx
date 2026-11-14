import {
  type ComponentFixture,
  defineComponentContract,
} from "@insightflare/ui/contracts";

import { createShowcaseRng, gaussian } from "../showcase/site-profile";
import {
  RetentionMatrix,
  type RetentionMatrixProps,
} from "./retention-matrix-view";
import type {
  RetentionCohortView,
  RetentionComparisonViewModel,
  RetentionLabels,
  RetentionPeriodAverage,
  RetentionViewModel,
} from "./retention-model";

const labels = {
  periodZero: "Initial",
  periodLabel: "Period {n}",
  cohortDate: "Cohort date",
  cohortSize: "Cohort size",
  matrixTitle: "Retention Matrix",
  matrixSubtitle:
    "Each row is a first-seen cohort; each column shows the share that returned in a later period.",
  legendLow: "Low",
  legendHigh: "High",
  overallRetention: "Overall retention",
  sizeDetail: "Cohort size",
  visitorsDetail: "Visitors",
  rateDetail: "Retention",
  unavailableCell: "This cohort has not reached this period yet.",
  compareCurrentPeriod: "Current period",
  cohortsMetric: "Cohorts",
  visitorsMetric: "Cohort Visitors",
  periodOneMetric: "First Return",
  averageReturnMetric: "Average Return",
  strongestCohortMetric: "Best Cohort",
  periodsAnalyzed: "Periods analyzed",
  cohortDetail: "Cohort date",
  eligibleVisitors: "Eligible visitors",
  noEligibleCohorts: "No eligible cohorts",
} as const satisfies RetentionLabels;

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
const START_MS = Date.UTC(2026, 4, 4);
const COHORT_LABELS = [
  "May 4",
  "May 11",
  "May 18",
  "May 25",
  "Jun 1",
  "Jun 8",
  "Jun 15",
  "Jun 22",
];

function cohort(
  index: number,
  total: number,
  size: number,
  curve: readonly number[],
  rateFor?: (cohortIndex: number, period: number) => number,
): RetentionCohortView {
  const reachable = total - index;
  const cells = Array.from({ length: total }, (_, period) => {
    const available = period < reachable;
    const rate = available
      ? period === 0
        ? 1
        : rateFor
          ? rateFor(index, period)
          : Math.max(0.02, (curve[period] ?? 0.04) - index * 0.004)
      : 0;
    return {
      index: period,
      visitors: available ? Math.round(size * rate) : 0,
      rate,
      available,
    };
  });
  const post = cells.filter((cell) => cell.available && cell.index > 0);
  return {
    bucket: START_MS + index * WEEK_MS,
    label: COHORT_LABELS[index] ?? `Week ${index + 1}`,
    size,
    cells,
    averagePostRate: post.length
      ? post.reduce((sum, cell) => sum + cell.rate, 0) / post.length
      : null,
  };
}

function viewModel(
  total: number,
  sizes: readonly number[],
  curve: readonly number[],
  rateFor?: (cohortIndex: number, period: number) => number,
): RetentionViewModel {
  const cohorts = sizes
    .slice(0, total)
    .map((size, index) => cohort(index, total, size, curve, rateFor));
  const columns = Array.from({ length: total }, (_, index) => index);
  const periodAverages: RetentionPeriodAverage[] = columns.map((index) => {
    const eligible = cohorts.filter((item) => item.cells[index]?.available);
    const base = eligible.reduce((sum, item) => sum + item.size, 0);
    const visitors = eligible.reduce(
      (sum, item) => sum + (item.cells[index]?.visitors ?? 0),
      0,
    );
    return {
      index,
      visitors,
      base,
      rate: base > 0 ? visitors / base : null,
    };
  });
  const strongest = cohorts
    .filter((item) => item.averagePostRate !== null)
    .sort(
      (left, right) =>
        (right.averagePostRate ?? 0) - (left.averagePostRate ?? 0),
    )[0];
  const postRates = periodAverages.filter(
    (average) => average.index > 0 && average.rate !== null,
  );
  return {
    columns,
    cohorts,
    periodAverages,
    summary: {
      cohortCount: cohorts.length,
      totalVisitors: cohorts.reduce((sum, item) => sum + item.size, 0),
      periodOneRate: periodAverages[1]?.rate ?? null,
      periodOneBase: periodAverages[1]?.base ?? 0,
      averageReturnRate: postRates.length
        ? postRates.reduce((sum, average) => sum + (average.rate ?? 0), 0) /
          postRates.length
        : null,
      analyzedPeriods: total,
      strongestCohort: strongest
        ? { label: strongest.label, rate: strongest.averagePostRate ?? 0 }
        : null,
    },
  };
}

const SIZES = [4210, 4580, 4390, 4720, 4960, 5130, 5340, 5510] as const;
const CURRENT_CURVE = [1, 0.34, 0.24, 0.19, 0.16, 0.14, 0.125, 0.11] as const;
const PREVIOUS_CURVE = [1, 0.3, 0.21, 0.17, 0.14, 0.12, 0.105, 0.095] as const;

// One cohort (Jun 8) came from a spike of curious first visits and returns less.
const SHOWCASE_SIZES = [
  3180, 3420, 3290, 7240, 3860, 4120, 4410, 4690,
] as const;
const COHORT_QUALITY = [1.04, 0.99, 1.02, 0.78, 1.06, 1, 1.08, 1.05] as const;

function showcaseRates(): number[][] {
  const rng = createShowcaseRng(5260);
  return SHOWCASE_SIZES.map((_, cohortIndex) => {
    const rates: number[] = [1];
    for (let period = 1; period < 8; period += 1) {
      const target =
        (CURRENT_CURVE[period] ?? 0.1) *
        (COHORT_QUALITY[cohortIndex] ?? 1) *
        (1 + gaussian(rng) * 0.045);
      const ceiling = (rates[period - 1] ?? 1) - 0.006;
      rates.push(Math.max(0.03, Math.min(target, ceiling)));
    }
    return rates;
  });
}

const SHOWCASE_RATES = showcaseRates();
const showcaseCurrent = viewModel(
  8,
  SHOWCASE_SIZES,
  CURRENT_CURVE,
  (cohortIndex, period) => SHOWCASE_RATES[cohortIndex]?.[period] ?? 0.05,
);

const current = viewModel(8, SIZES, CURRENT_CURVE);
const previous = viewModel(
  8,
  SIZES.map((size) => Math.round(size * 0.92)),
  PREVIOUS_CURVE,
);

const comparison: RetentionComparisonViewModel = {
  current,
  comparison: previous,
  columns: current.columns,
  rows: current.cohorts.map((item, index) => ({
    key: `row-${index}`,
    current: item,
    comparison: previous.cohorts[index] ?? null,
  })),
};

const loadingShape = { rows: 6, columns: 6 } as const;

export const retentionMatrixFixtures = [
  {
    id: "retention.state.ready",
    title: "Ready",
    presentation: { kind: "scenario", scenario: "ready" },
    props: {
      locale: "en-US",
      labels,
      viewModel: viewModel(6, SIZES, CURRENT_CURVE),
      loadingShape,
    } satisfies RetentionMatrixProps,
  },
  {
    id: "retention.state.loading",
    title: "Loading",
    presentation: { kind: "scenario", scenario: "loading" },
    props: {
      locale: "en-US",
      labels,
      viewModel: viewModel(6, SIZES, CURRENT_CURVE),
      loading: true,
      loadingShape,
    } satisfies RetentionMatrixProps,
  },
  {
    id: "retention.state.with-comparison",
    title: "With comparison",
    presentation: { kind: "scenario", scenario: "comparison" },
    props: {
      locale: "en-US",
      labels,
      viewModel: current,
      comparisonViewModel: comparison,
      comparisonLabel: "Previous period",
      loadingShape,
    } satisfies RetentionMatrixProps,
  },
  {
    id: "retention.showcase",
    title: "Showcase",
    description: "Realistic data for marketing and documentation pages.",
    presentation: { kind: "scenario", scenario: "showcase" },
    props: {
      locale: "en-US",
      labels,
      viewModel: showcaseCurrent,
      loadingShape,
    } satisfies RetentionMatrixProps,
  },
] as const satisfies readonly ComponentFixture<RetentionMatrixProps>[];

export const retentionMatrixContract =
  defineComponentContract<RetentionMatrixProps>({
    id: "retention",
    title: "Retention matrix",
    category: "Product UI / Analytics",
    categoryId: "product-analytics",
    description:
      "A props-only cohort retention matrix with loading skeleton and period comparison.",
    fixtures: retentionMatrixFixtures,
    render: (props) => <RetentionMatrix {...props} />,
  });
