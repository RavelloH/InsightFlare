import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useInfiniteTableSentinel } from "@/components/dashboard/use-infinite-table-sentinel";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

describe("useInfiniteTableSentinel", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      callback(0);
      return 1;
    });
    vi.stubGlobal("cancelAnimationFrame", vi.fn());
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  });

  it("loads when any sentinel row is intersecting", () => {
    let callback: IntersectionObserverCallback | undefined;
    const observe = vi.fn();
    vi.stubGlobal(
      "IntersectionObserver",
      class {
        constructor(next: IntersectionObserverCallback) {
          callback = next;
        }
        observe = observe;
        disconnect = vi.fn();
        unobserve = vi.fn();
        takeRecords = vi.fn(() => []);
        root = null;
        rootMargin = "360px 0px";
        thresholds = [];
      },
    );
    const onReachEnd = vi.fn();

    function Probe() {
      const sentinelRef = useInfiniteTableSentinel({
        enabled: true,
        onReachEnd,
      });
      return createElement(
        "table",
        null,
        createElement(
          "tbody",
          null,
          createElement("tr", { ref: sentinelRef }),
          createElement("tr", { ref: sentinelRef }),
        ),
      );
    }

    act(() => root.render(createElement(Probe)));
    expect(observe).toHaveBeenCalledTimes(2);

    act(() => {
      callback?.(
        [
          { isIntersecting: false },
          { isIntersecting: true },
        ] as IntersectionObserverEntry[],
        {} as IntersectionObserver,
      );
    });
    expect(onReachEnd).toHaveBeenCalled();
  });

  it("does not observe when disabled or unsupported", () => {
    vi.stubGlobal("IntersectionObserver", undefined);
    const onReachEnd = vi.fn();

    function Probe() {
      const sentinelRef = useInfiniteTableSentinel({
        enabled: false,
        onReachEnd,
      });
      return createElement(
        "table",
        null,
        createElement("tbody", null, createElement("tr", { ref: sentinelRef })),
      );
    }

    act(() => root.render(createElement(Probe)));
    expect(onReachEnd).not.toHaveBeenCalled();
  });
});
