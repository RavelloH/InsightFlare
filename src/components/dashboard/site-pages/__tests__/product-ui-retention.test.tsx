import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import {
  createRetentionMetricItems,
  formatRetentionChange,
  retentionAverageAt,
  retentionCellAt,
  retentionCellStyle,
  retentionComparisonChange,
  RetentionMatrix,
  retentionMatrixContract,
  retentionMatrixFixtures,
  type RetentionMatrixProps,
  retentionPeriodLabel,
  RetentionStateCard,
} from "@insightflare/product-ui/retention";
import { LayerManagerProvider } from "@insightflare/ui/layer-manager";
import { RiRepeat2Line } from "@remixicon/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// happy-dom cannot cancel native animations; motion falls back to JS animations without WAAPI.
vi.hoisted(() => {
  Reflect.deleteProperty(Element.prototype, "animate");
});

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

let container: HTMLDivElement;
let root: Root;

async function render(element: React.ReactNode) {
  await act(async () => {
    root.render(<LayerManagerProvider>{element}</LayerManagerProvider>);
    await Promise.resolve();
  });
}

const ready = retentionMatrixFixtures[0].props;
const loading = retentionMatrixFixtures[1].props;
const comparison = retentionMatrixFixtures[2].props;
const UNAVAILABLE = ready.labels.unavailableCell;

describe("RetentionMatrix", () => {
  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
  });

  it("renders headers, cohorts, period columns, and legend", async () => {
    await render(<RetentionMatrix {...ready} />);
    const text = container.textContent ?? "";
    expect(text).toContain("Retention Matrix");
    expect(text).toContain("Cohort date");
    expect(text).toContain("Cohort size");
    expect(text).toContain("Initial");
    expect(text).toContain("Period 3");
    expect(text).toContain("Overall retention");
    expect(text).toContain("May 4");
    expect(text).toContain("100%");
    expect(text).toContain("Low");
    expect(text).toContain("High");
  });

  it("marks cohorts that have not reached a period as unavailable", async () => {
    await render(<RetentionMatrix {...ready} />);
    const unavailable = container.querySelectorAll(
      `div[aria-label="${UNAVAILABLE}"]`,
    );
    expect(unavailable.length).toBeGreaterThan(0);
    expect(unavailable[0]?.className).toContain("border-dashed");
  });

  it("describes a retention cell in its accessible label", async () => {
    await render(<RetentionMatrix {...ready} />);
    const firstCell = container.querySelector(
      'tbody button[aria-label^="Cohort date:"]',
    );
    const label = firstCell?.getAttribute("aria-label") ?? "";
    expect(label).toContain("Cohort date: May 4");
    expect(label).toContain("Cohort size:");
    expect(label).toContain("Retention:");
  });

  it("replaces the cohort rows with a skeleton while loading", async () => {
    await render(<RetentionMatrix {...loading} />);
    expect(container.textContent).toContain("Retention Matrix");
    expect(container.textContent).not.toContain("May 4");
    expect(
      container.querySelector("[aria-hidden='true'] table"),
    ).not.toBeNull();
  });

  it("renders paired current and comparison bands", async () => {
    await render(<RetentionMatrix {...comparison} />);
    expect(container.textContent).toContain("Previous period");
    expect(container.textContent).toContain("Current period");
    expect(
      container.querySelectorAll('button[aria-label^="Current period:"]')
        .length,
    ).toBeGreaterThan(0);
    expect(
      container.querySelectorAll('button[aria-label^="Previous period:"]')
        .length,
    ).toBeGreaterThan(0);
  });

  it("falls back to a generic comparison label", async () => {
    const props: RetentionMatrixProps = {
      ...comparison,
      comparisonLabel: undefined,
    };
    await render(<RetentionMatrix {...props} />);
    expect(container.textContent).toContain("Comparison");
  });

  it("renders localized labels supplied by the caller", async () => {
    await render(
      <RetentionMatrix
        {...ready}
        labels={{
          ...ready.labels,
          matrixTitle: "留存矩阵",
          legendLow: "低",
          periodZero: "初始",
          periodLabel: "第 {n} 期",
        }}
      />,
    );
    const text = container.textContent ?? "";
    expect(text).toContain("留存矩阵");
    expect(text).toContain("初始");
    expect(text).toContain("第 2 期");
    expect(text).not.toContain("Retention Matrix");
  });

  it("renders every contract fixture", () => {
    for (const fixture of retentionMatrixFixtures) {
      expect(retentionMatrixContract.renderFixture(fixture.id)).not.toBeNull();
    }
    expect(retentionMatrixContract.renderFixture("missing")).toBeNull();
  });
});

describe("RetentionStateCard", () => {
  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
  });

  it("renders the title, subtitle, and icon", async () => {
    await render(
      <RetentionStateCard
        title="Not enough data"
        subtitle="Use a wider range."
        icon={RiRepeat2Line}
      />,
    );
    expect(container.textContent).toContain("Not enough data");
    expect(container.textContent).toContain("Use a wider range.");
    expect(container.querySelector("svg")).not.toBeNull();
  });
});

describe("createRetentionMetricItems", () => {
  const { viewModel, labels } = ready;
  const number = new Intl.NumberFormat("en-US");

  it("builds the four summary metrics", () => {
    const items = createRetentionMetricItems({
      locale: "en-US",
      labels,
      viewModel,
      comparisonLabel: "Previous period",
    });
    expect(items.map((item) => item.id)).toEqual([
      "cohorts",
      "visitors",
      "period-one",
      "average-return",
    ]);
    expect(items[0]?.value).toBe(number.format(viewModel.summary.cohortCount));
    expect(items[1]?.value).toBe(
      number.format(viewModel.summary.totalVisitors),
    );
    expect(items[1]?.detail).toBe(labels.cohortDetail);
    expect(items[2]?.detail).toContain(labels.eligibleVisitors);
    expect(items[3]?.detail).toContain(`${labels.strongestCohortMetric}: `);
    expect(items.every((item) => item.change === undefined)).toBe(true);
    expect(items.every((item) => item.loading === false)).toBe(true);
  });

  it("shows comparison values and change rates when comparing", () => {
    const comparisonModel = comparison.comparisonViewModel?.comparison;
    const items = createRetentionMetricItems({
      locale: "en-US",
      labels,
      viewModel,
      comparisonViewModel: comparisonModel,
      comparisonLabel: "Previous period",
      loading: true,
    });
    expect(items[0]?.detail).toBe(
      `Previous period: ${number.format(comparisonModel?.summary.cohortCount ?? 0)}`,
    );
    expect(items[1]?.change?.direction).toBeDefined();
    expect(items.every((item) => item.loading === true)).toBe(true);
  });

  it("marks missing rates and empty cohorts", () => {
    const empty = {
      ...viewModel,
      summary: {
        ...viewModel.summary,
        periodOneRate: null,
        periodOneBase: 0,
        averageReturnRate: null,
        strongestCohort: null,
      },
    };
    const items = createRetentionMetricItems({
      locale: "en-US",
      labels,
      viewModel: empty,
      comparisonViewModel: {
        ...empty,
        summary: { ...empty.summary, periodOneRate: null },
      },
      comparisonLabel: "Previous period",
    });
    expect(items[2]?.value).toBe("--");
    expect(items[3]?.value).toBe("--");
    expect(items[2]?.detail).toBe("Previous period: --");
    expect(items[2]?.change).toBeUndefined();
  });

  it("uses the empty-cohort detail when there is no eligible base", () => {
    const empty = {
      ...viewModel,
      summary: {
        ...viewModel.summary,
        periodOneRate: null,
        periodOneBase: 0,
        averageReturnRate: null,
        strongestCohort: null,
      },
    };
    const items = createRetentionMetricItems({
      locale: "en-US",
      labels,
      viewModel: empty,
      comparisonLabel: "Previous period",
    });
    expect(items[2]?.detail).toBe(labels.noEligibleCohorts);
    expect(items[3]?.detail).toBe(labels.noEligibleCohorts);
  });
});

describe("retention model helpers", () => {
  it("formats period labels", () => {
    const labels = { periodZero: "Initial", periodLabel: "Period {n}" };
    expect(retentionPeriodLabel(labels, 0)).toBe("Initial");
    expect(retentionPeriodLabel(labels, 4)).toBe("Period 4");
  });

  it("falls back to unavailable cells and empty averages", () => {
    expect(retentionCellAt(null, 3)).toEqual({
      index: 3,
      visitors: 0,
      rate: 0,
      available: false,
    });
    expect(retentionAverageAt(ready.viewModel, 99)).toEqual({
      index: 99,
      visitors: 0,
      base: 0,
      rate: null,
    });
  });

  it("computes and formats comparison changes", () => {
    expect(retentionComparisonChange(0.3, 0.2)).toBeCloseTo(50);
    expect(retentionComparisonChange(null, 0.2)).toBeNull();
    expect(retentionComparisonChange(0.3, 0)).toBeNull();
    expect(formatRetentionChange(12.34)).toBe("+12.3%");
    expect(formatRetentionChange(-5)).toBe("-5.0%");
    expect(formatRetentionChange(null)).toBeNull();
    expect(formatRetentionChange(Number.NaN)).toBeNull();
  });

  it("styles cells by rate and leaves unavailable cells unstyled", () => {
    expect(retentionCellStyle(0.5, false)).toEqual({});
    expect(retentionCellStyle(0, true).backgroundColor).toContain("82%");
    expect(retentionCellStyle(0.05, true).backgroundColor).toContain(
      "color-mix",
    );
    expect(retentionCellStyle(1, true).color).toBe("oklch(0.985 0 0)");
    expect(retentionCellStyle(0.02, true).color).toBe(
      "var(--color-foreground)",
    );
    expect(retentionCellStyle(0.4, true, "var(--x)").backgroundColor).toContain(
      "var(--x)",
    );
  });
});
