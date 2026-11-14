import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import {
  technologyShareOverviewContract,
  TechnologyShareOverviewView,
  type TechnologyShareOverviewViewProps,
} from "@insightflare/product-ui/technology";
import { LayerManagerProvider } from "@insightflare/ui/layer-manager";
import { TooltipProvider } from "@insightflare/ui/tooltip";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { getMessages } from "@/lib/i18n/messages";
import { buildBrowserShareOverviewLabels } from "@/lib/product-ui-labels/technology";

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

async function render(props: TechnologyShareOverviewViewProps) {
  await act(async () => {
    root.render(withProviders(<TechnologyShareOverviewView {...props} />));
    await Promise.resolve();
  });
}

const fixtures = technologyShareOverviewContract.fixtures;
const props = (id: string) => {
  const fixture = fixtures.find((candidate) => candidate.id === id);
  if (!fixture) throw new Error(`Missing fixture ${id}`);
  return fixture.props;
};
const ready = props("technology-share-overview.state.ready");
const loading = props("technology-share-overview.state.loading");
const refreshing = props("technology-share-overview.state.refreshing");
const empty = props("technology-share-overview.state.empty");
const comparison = props("technology-share-overview.state.comparison");
const device = props("technology-share-overview.state.device");

describe("TechnologyShareOverviewView", () => {
  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
  });

  it("renders both section titles and their items", async () => {
    await render(ready);
    const text = container.textContent ?? "";
    expect(text).toContain(ready.labels.primaryTitle);
    expect(text).toContain(ready.labels.secondaryTitle);
    expect(text).toContain("Chrome");
    expect(text).toContain("Blink");
  });

  it("renders the device variant with its own titles", async () => {
    await render(device);
    const text = container.textContent ?? "";
    expect(text).toContain("Device share");
    expect(text).toContain("Desktop");
    expect(text).toContain("Windows");
  });

  it("hides items while the initial load is pending", async () => {
    await render(loading);
    expect(container.textContent).not.toContain("Chrome");
  });

  it("shows the empty label when there is no data", async () => {
    await render(empty);
    expect(container.textContent).toContain(empty.labels.emptyLabel);
  });

  it("does not show the refresh indicator when idle", async () => {
    await render(ready);
    expect(container.textContent).not.toContain(ready.labels.loadingLabel);
  });

  it("shows the refresh indicator while refreshing", async () => {
    await render(refreshing);
    expect(container.textContent).toContain(refreshing.labels.loadingLabel);
  });

  it("shows the refresh indicator for the device variant", async () => {
    await render({ ...device, refreshing: true });
    expect(container.textContent).toContain(device.labels.loadingLabel);
  });

  it("renders comparison items when a comparison label is given", async () => {
    await render(comparison);
    expect(container.textContent).toContain("Previous period");
  });

  it("renders localized labels built from the app messages", async () => {
    const labels = buildBrowserShareOverviewLabels(getMessages("zh"));
    await render({ ...ready, labels });
    expect(container.textContent).toContain(labels.primaryTitle);
    expect(container.textContent).not.toContain("Browser share");
  });

  it("renders each contract fixture", () => {
    for (const fixture of fixtures) {
      expect(
        technologyShareOverviewContract.renderFixture(fixture.id),
      ).not.toBeNull();
    }
    expect(technologyShareOverviewContract.renderFixture("missing")).toBeNull();
  });
});
