import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import {
  browserCrossBreakdownCardContract,
  BrowserCrossBreakdownCardView,
  type BrowserCrossBreakdownCardViewProps,
  deviceCrossBreakdownCardContract,
  DeviceCrossBreakdownCardView,
  type DeviceCrossBreakdownCardViewProps,
} from "@insightflare/product-ui/technology";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// happy-dom cannot cancel native animations; motion falls back to JS animations without WAAPI.
vi.hoisted(() => {
  Reflect.deleteProperty(Element.prototype, "animate");
});

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

async function renderBrowser(props: BrowserCrossBreakdownCardViewProps) {
  await act(async () => {
    root.render(<BrowserCrossBreakdownCardView {...props} />);
    await Promise.resolve();
  });
}

async function renderDevice(props: DeviceCrossBreakdownCardViewProps) {
  await act(async () => {
    root.render(<DeviceCrossBreakdownCardView {...props} />);
    await Promise.resolve();
  });
}

const browserProps = (id: string) => {
  const fixture = browserCrossBreakdownCardContract.fixtures.find(
    (candidate) => candidate.id === id,
  );
  if (!fixture) throw new Error(`Missing fixture ${id}`);
  return fixture.props;
};
const deviceProps = (id: string) => {
  const fixture = deviceCrossBreakdownCardContract.fixtures.find(
    (candidate) => candidate.id === id,
  );
  if (!fixture) throw new Error(`Missing fixture ${id}`);
  return fixture.props;
};

const browserReady = browserProps("browser-cross-breakdown-card.state.ready");
const browserLoading = browserProps(
  "browser-cross-breakdown-card.state.loading",
);
const browserRefreshing = browserProps(
  "browser-cross-breakdown-card.state.refreshing",
);
const browserEmpty = browserProps("browser-cross-breakdown-card.state.empty");
const deviceReady = deviceProps("device-cross-breakdown-card.state.ready");
const deviceLoading = deviceProps("device-cross-breakdown-card.state.loading");
const deviceEmpty = deviceProps("device-cross-breakdown-card.state.empty");

describe("BrowserCrossBreakdownCardView", () => {
  it("renders the title when data is present", async () => {
    await renderBrowser(browserReady);
    expect(container.textContent).toContain(browserReady.title);
    expect(container.textContent).not.toContain(browserReady.labels.emptyLabel);
  });

  it("shows the loading label before the first load completes", async () => {
    await renderBrowser(browserLoading);
    expect(container.textContent).toContain(browserLoading.labels.loadingLabel);
  });

  it("does not show the refresh overlay when idle", async () => {
    await renderBrowser(browserReady);
    expect(container.textContent).not.toContain(
      browserReady.labels.loadingLabel,
    );
  });

  it("shows the refresh overlay once hydrated and refetching", async () => {
    await renderBrowser(browserRefreshing);
    expect(container.textContent).toContain(
      browserRefreshing.labels.loadingLabel,
    );
  });

  it("shows the empty label when there is no data", async () => {
    await renderBrowser(browserEmpty);
    expect(container.textContent).toContain(browserEmpty.labels.emptyLabel);
  });

  it("renders each contract fixture", () => {
    for (const fixture of browserCrossBreakdownCardContract.fixtures) {
      expect(
        browserCrossBreakdownCardContract.renderFixture(fixture.id),
      ).not.toBeNull();
    }
    expect(
      browserCrossBreakdownCardContract.renderFixture("missing"),
    ).toBeNull();
  });
});

describe("DeviceCrossBreakdownCardView", () => {
  it("renders the title when data is present", async () => {
    await renderDevice(deviceReady);
    expect(container.textContent).toContain(deviceReady.title);
    expect(container.textContent).not.toContain(deviceReady.labels.emptyLabel);
  });

  it("shows the loading label while loading", async () => {
    await renderDevice(deviceLoading);
    expect(container.textContent).toContain(deviceLoading.labels.loadingLabel);
  });

  it("shows the empty label when there is no data", async () => {
    await renderDevice(deviceEmpty);
    expect(container.textContent).toContain(deviceEmpty.labels.emptyLabel);
  });

  it("renders each contract fixture", () => {
    for (const fixture of deviceCrossBreakdownCardContract.fixtures) {
      expect(
        deviceCrossBreakdownCardContract.renderFixture(fixture.id),
      ).not.toBeNull();
    }
    expect(
      deviceCrossBreakdownCardContract.renderFixture("missing"),
    ).toBeNull();
  });
});
