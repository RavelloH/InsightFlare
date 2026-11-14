import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import {
  goalTimeseriesContract,
  goalTimeseriesFixtures,
  GoalTimeseriesView,
  type GoalTimeseriesViewProps,
  GoalVisualization,
  goalVisualizationContract,
  goalVisualizationFixtures,
  withGoalVisualizationLabels,
} from "@insightflare/product-ui/goals";
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
    root.render(element);
    await Promise.resolve();
  });
}

const ready = goalTimeseriesFixtures[0].props;
const loading = goalTimeseriesFixtures[1].props;

describe("GoalTimeseriesView", () => {
  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
  });

  it("renders the chart surface without a spinner when ready", async () => {
    await render(<GoalTimeseriesView {...ready} />);
    const chart = container.querySelector("[data-goal-series]");
    expect(chart?.getAttribute("data-goal-series")).toBe("visitors,sessions");
    expect(chart?.className).toContain("brightness-100");
    expect(chart?.className).not.toContain("brightness-50");
    expect(container.querySelector("[aria-hidden='true'] svg")).toBeNull();
  });

  it("dims the chart and shows a spinner while loading", async () => {
    await render(<GoalTimeseriesView {...loading} />);
    const chart = container.querySelector("[data-goal-series]");
    expect(chart?.className).toContain("brightness-50");
    expect(container.querySelector("[aria-hidden='false'] svg")).not.toBeNull();
  });

  it("accepts comparison data without a comparison label", async () => {
    const props: GoalTimeseriesViewProps = {
      ...goalTimeseriesFixtures[2].props,
      comparisonLabel: undefined,
    };
    await render(<GoalTimeseriesView {...props} />);
    expect(container.querySelector("[data-goal-series]")).not.toBeNull();
  });

  it("renders every contract fixture", () => {
    for (const fixture of goalTimeseriesFixtures) {
      expect(goalTimeseriesContract.renderFixture(fixture.id)).not.toBeNull();
    }
    expect(goalTimeseriesContract.renderFixture("missing")).toBeNull();
  });
});

describe("GoalVisualization contract and labels", () => {
  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
  });

  const labels = {
    visitors: "访客",
    sessions: "会话",
    visitorConversion: "访客 转化",
    visitorConversionComparison: "访客 转化 comparison",
  } as const;

  it("replaces every visible label, including the comparison progress label", () => {
    const showcase = goalVisualizationFixtures[3].props;
    const localized = withGoalVisualizationLabels(showcase, labels);
    expect(localized.visitors.label).toBe("访客");
    expect(localized.sessions.label).toBe("会话");
    expect(localized.visitorConversion.label).toBe("访客 转化");
    expect(localized.visitorConversion.comparison?.label).toBe(
      "访客 转化 comparison",
    );
    expect(localized.visitors.conversionRate).toBe(
      showcase.visitors.conversionRate,
    );
  });

  it("keeps a missing comparison progress as null", () => {
    const localized = withGoalVisualizationLabels(
      goalVisualizationFixtures[0].props,
      labels,
    );
    expect(localized.visitorConversion.comparison).toBeNull();
  });

  it("renders localized labels in the view", async () => {
    await render(
      <GoalVisualization
        {...withGoalVisualizationLabels(
          goalVisualizationFixtures[3].props,
          labels,
        )}
      />,
    );
    expect(container.textContent).toContain("访客");
    expect(container.textContent).toContain(
      goalVisualizationFixtures[3].props.visitors.conversionRate,
    );
  });

  it("renders every contract fixture", () => {
    for (const fixture of goalVisualizationFixtures) {
      expect(
        goalVisualizationContract.renderFixture(fixture.id),
      ).not.toBeNull();
    }
  });
});
