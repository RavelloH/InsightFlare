import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import {
  FunnelVisualization,
  funnelVisualizationContract,
  funnelVisualizationFixtures,
} from "@insightflare/product-ui/funnel";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// happy-dom cannot cancel native animations; motion falls back to JS animations without WAAPI.
vi.hoisted(() => {
  Reflect.deleteProperty(Element.prototype, "animate");
});

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

let container: HTMLDivElement;
let root: Root;

describe("FunnelVisualization fixtures", () => {
  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
  });

  it("renders the showcase funnel with steps and summary", async () => {
    const showcase = funnelVisualizationFixtures.find(
      (fixture) => fixture.id === "funnel.showcase",
    );
    expect(showcase).toBeDefined();
    if (!showcase) return;
    await act(async () => {
      root.render(<FunnelVisualization {...showcase.props} />);
      await Promise.resolve();
    });
    const text = container.textContent ?? "";
    expect(text).toContain("Visited the docs");
    expect(text).toContain("Viewed the setup checklist");
    expect(text).toContain("Overall conversion");
    expect(text).toContain("converted sessions");
  });

  it("renders every contract fixture", () => {
    for (const fixture of funnelVisualizationFixtures) {
      expect(
        funnelVisualizationContract.renderFixture(fixture.id),
      ).not.toBeNull();
    }
  });
});
