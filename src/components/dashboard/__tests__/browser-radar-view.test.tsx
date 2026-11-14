import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import {
  browserRadarContract,
  BrowserRadarView,
  type BrowserRadarViewProps,
} from "@insightflare/product-ui/technology";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { getMessages } from "@/lib/i18n/messages";
import { buildBrowserRadarLabels } from "@/lib/product-ui-labels/technology";

// happy-dom cannot cancel native animations; motion falls back to JS animations without WAAPI.
vi.hoisted(() => {
  Reflect.deleteProperty(Element.prototype, "animate");
});

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

let container: HTMLDivElement;
let root: Root;

async function render(props: BrowserRadarViewProps) {
  await act(async () => {
    root.render(<BrowserRadarView {...props} />);
    await Promise.resolve();
  });
}

const fixtures = browserRadarContract.fixtures;
const props = (id: string) => {
  const fixture = fixtures.find((candidate) => candidate.id === id);
  if (!fixture) throw new Error(`Missing fixture ${id}`);
  return fixture.props;
};
const ready = props("browser-radar.state.ready");
const loading = props("browser-radar.state.loading");
const empty = props("browser-radar.state.empty");
const comparison = props("browser-radar.state.comparison");

describe("BrowserRadarView", () => {
  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
  });

  it("renders the heading and one entry per browser", async () => {
    await render(ready);
    const text = container.textContent ?? "";
    expect(text).toContain(ready.labels.title);
    expect(text).toContain(ready.labels.subtitle);
    for (const item of ready.items) {
      expect(text).toContain(item.browser);
    }
  });

  it("does not show the comparison legend without comparison data", async () => {
    await render(ready);
    expect(container.textContent).not.toContain(ready.comparisonLabel);
  });

  it("shows the comparison legend for browsers that have a comparison", async () => {
    await render(comparison);
    expect(container.textContent).toContain(comparison.comparisonLabel);
  });

  it("hides browser entries while loading", async () => {
    await render(loading);
    expect(container.textContent).not.toContain("Chrome");
  });

  it("shows the empty label when there are no browsers", async () => {
    await render(empty);
    expect(container.textContent).toContain(empty.labels.emptyLabel);
  });

  it("renders localized labels built from the app messages", async () => {
    const labels = buildBrowserRadarLabels(getMessages("zh"));
    await render({ ...ready, labels });
    expect(container.textContent).toContain(labels.title);
    expect(container.textContent).not.toContain(ready.labels.title);
  });

  it("renders each contract fixture", () => {
    for (const fixture of fixtures) {
      expect(browserRadarContract.renderFixture(fixture.id)).not.toBeNull();
    }
    expect(browserRadarContract.renderFixture("missing")).toBeNull();
  });
});
