import { act } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vitest";

import { TabbedScrollMaskCard } from "@/components/dashboard/common/tabbed-scroll-mask-card";

// Model the third-party integration contract: initialization reparents every
// direct host child into a generated viewport. React must still be able to
// replace content when an asynchronous tab request finishes.
vi.mock("overlayscrollbars", () => ({
  OverlayScrollbars: (host: HTMLElement, options?: unknown) => {
    if (options === undefined) return undefined;
    const viewport = document.createElement("div");
    viewport.dataset.testScrollbarViewport = "";
    for (const child of Array.from(host.childNodes))
      viewport.appendChild(child);
    host.appendChild(viewport);
    return {
      elements: () => ({ viewport }),
      on: () => undefined,
      off: () => undefined,
      destroy: () => {
        for (const child of Array.from(viewport.childNodes))
          host.appendChild(child);
        viewport.remove();
      },
    };
  },
}));
vi.mock("@/components/ui/overlay-scrollbar", () => ({
  prepareNativeScrollbarHost: () => false,
  useNativeScrollbars: () => false,
}));
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

describe("TabbedScrollMaskCard scrollbar integration", () => {
  it("replaces asynchronously loaded tab content after the scrollbar reparents it", async () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const errors: unknown[] = [];
    const root = createRoot(container, {
      onUncaughtError: (error) => errors.push(error),
    });
    const render = (loaded: boolean) =>
      root.render(
        <TabbedScrollMaskCard
          value="pages"
          onValueChange={() => undefined}
          tabs={[]}
          headerHidden
          syncKey={loaded}
        >
          {loaded ? (
            <table>
              <tbody>
                <tr>
                  <td>Loaded page</td>
                </tr>
              </tbody>
            </table>
          ) : (
            <div>Loading</div>
          )}
        </TabbedScrollMaskCard>,
      );
    try {
      await act(async () => render(false));
      expect(container.textContent).toContain("Loading");
      await act(async () => render(true));
      expect(errors).toEqual([]);
      expect(
        container.querySelector("[data-test-scrollbar-viewport] table")
          ?.textContent,
      ).toBe("Loaded page");
      expect(container.textContent).not.toContain("Loading");
      await act(async () => render(false));
      expect(errors).toEqual([]);
      expect(container.textContent).toContain("Loading");
      expect(container.querySelector("table")).toBeNull();
    } finally {
      await act(async () => root.unmount());
      container.remove();
    }
  });
});
