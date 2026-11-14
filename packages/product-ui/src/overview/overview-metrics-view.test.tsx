import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { productUiLabels } from "../labels";
import {
  OverviewMetricsView,
  type OverviewMetricsViewProps,
} from "./overview-metrics-view";
import {
  overviewMetricsContract,
  overviewMetricsFixtures,
} from "./overview-metrics-view.contract";

// happy-dom cannot cancel native animations; motion falls back to JS animations without WAAPI.
vi.hoisted(() => {
  Reflect.deleteProperty(Element.prototype, "animate");
});

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

let container: HTMLDivElement;
let root: Root;

async function render(props: OverviewMetricsViewProps) {
  await act(async () => {
    root.render(<OverviewMetricsView {...props} />);
    await Promise.resolve();
  });
}

const ready = overviewMetricsFixtures[0].props;
const loading = overviewMetricsFixtures[1].props;

describe("OverviewMetricsView", () => {
  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
  });

  it("renders every metric label, value, and change rate", async () => {
    await render(ready);
    const text = container.textContent ?? "";
    for (const label of Object.values(ready.labels)) {
      expect(text).toContain(label);
    }
    expect(text).toContain("126,408");
    expect(text).toContain("+12.4%");
    expect(text).toContain("-3.2%");
  });

  it("treats a falling lower-is-better metric as an improvement", async () => {
    await render(ready);
    const changes = [...container.querySelectorAll("span.font-mono")].filter(
      (node) => /^[+-]\d/.test(node.textContent ?? ""),
    );
    const bounce = changes.find((node) => node.textContent === "-3.2%");
    const views = changes.find((node) => node.textContent === "+12.4%");
    expect(bounce?.className).toContain("text-emerald-600");
    expect(views?.className).toContain("text-emerald-600");
  });

  it("hides values while loading", async () => {
    await render(loading);
    expect(container.textContent).not.toContain("126,408");
    expect(container.textContent).toContain(ready.labels.views);
  });

  it("omits the change rate when the delta is unavailable", async () => {
    await render({
      ...ready,
      items: ready.items.map((item) => ({ ...item, delta: null })),
    });
    expect(container.textContent).toContain("126,408");
    expect(container.textContent).not.toContain("%+");
    expect(container.textContent).not.toContain("+12.4%");
  });

  it("renders localized labels supplied by the generated dictionary", async () => {
    await render({ ...ready, labels: productUiLabels.zh.overviewMetrics });
    expect(container.textContent).toContain("浏览量");
    expect(container.textContent).not.toContain("Views");
  });

  it("renders each contract fixture", async () => {
    for (const fixture of overviewMetricsFixtures) {
      expect(overviewMetricsContract.renderFixture(fixture.id)).not.toBeNull();
    }
    expect(overviewMetricsContract.renderFixture("missing")).toBeNull();
  });
});
