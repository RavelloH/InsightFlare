import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import {
  browserVersionBreakdownContract,
  BrowserVersionBreakdownView,
  type BrowserVersionBreakdownViewProps,
} from "@insightflare/product-ui/technology";
import { LayerManagerProvider } from "@insightflare/ui/layer-manager";
import { TooltipProvider } from "@insightflare/ui/tooltip";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { getMessages } from "@/lib/i18n/messages";
import { buildBrowserVersionBreakdownLabels } from "@/lib/product-ui-labels/technology";

// happy-dom cannot cancel native animations; motion falls back to JS animations without WAAPI.
vi.hoisted(() => {
  Reflect.deleteProperty(Element.prototype, "animate");
});

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

let container: HTMLDivElement;
let root: Root;

function withProviders(children: ReactNode) {
  return (
    <LayerManagerProvider>
      <TooltipProvider>{children}</TooltipProvider>
    </LayerManagerProvider>
  );
}

async function render(props: BrowserVersionBreakdownViewProps) {
  await act(async () => {
    root.render(withProviders(<BrowserVersionBreakdownView {...props} />));
    await Promise.resolve();
  });
}

const fixtures = browserVersionBreakdownContract.fixtures;
const props = (id: string) => {
  const fixture = fixtures.find((candidate) => candidate.id === id);
  if (!fixture) throw new Error(`Missing fixture ${id}`);
  return fixture.props;
};
const ready = props("browser-version-breakdown.state.ready");
const loading = props("browser-version-breakdown.state.loading");
const refreshing = props("browser-version-breakdown.state.refreshing");
const empty = props("browser-version-breakdown.state.empty");
const comparison = props("browser-version-breakdown.state.comparison");

describe("BrowserVersionBreakdownView", () => {
  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
  });

  it("renders the heading and a card per browser with its version rows", async () => {
    await render(ready);
    const text = container.textContent ?? "";
    expect(text).toContain(ready.labels.title);
    expect(text).toContain("Chrome 131");
    expect(text).toContain("Safari 18.1");
    expect(text).toContain(ready.labels.visitorsLabel);
  });

  it("omits the period legend without a comparison", async () => {
    await render(ready);
    expect(container.textContent).not.toContain(
      ready.labels.currentPeriodLabel,
    );
  });

  it("shows period labels and change rates with a comparison", async () => {
    await render(comparison);
    const text = container.textContent ?? "";
    expect(text).toContain(comparison.labels.currentPeriodLabel);
    expect(text).toContain("Previous period");
    expect(container.querySelector("span.text-emerald-600")).not.toBeNull();
    expect(container.querySelector("span.text-rose-600")).not.toBeNull();
  });

  it("lists browsers that exist only in the comparison period", async () => {
    await render({
      ...comparison,
      browsers: comparison.browsers.slice(0, 1),
    });
    expect(container.textContent).toContain("Safari");
  });

  it("shows the loading label while loading", async () => {
    await render(loading);
    expect(container.textContent).toContain(loading.labels.loadingLabel);
    expect(container.textContent).not.toContain("Chrome 131");
  });

  it("does not show the refresh overlay when idle", async () => {
    await render(ready);
    expect(container.textContent).not.toContain(ready.labels.loadingLabel);
  });

  it("shows the refresh overlay while refreshing", async () => {
    await render(refreshing);
    expect(container.textContent).toContain(refreshing.labels.loadingLabel);
  });

  it("shows the empty label when there are no browsers", async () => {
    await render(empty);
    expect(container.textContent).toContain(empty.labels.emptyLabel);
  });

  it("renders localized labels built from the app messages", async () => {
    const labels = buildBrowserVersionBreakdownLabels(getMessages("zh"));
    await render({ ...ready, labels });
    expect(container.textContent).toContain(labels.title);
  });

  it("renders each contract fixture", () => {
    for (const fixture of fixtures) {
      expect(
        browserVersionBreakdownContract.renderFixture(fixture.id),
      ).not.toBeNull();
    }
    expect(browserVersionBreakdownContract.renderFixture("missing")).toBeNull();
  });
});
