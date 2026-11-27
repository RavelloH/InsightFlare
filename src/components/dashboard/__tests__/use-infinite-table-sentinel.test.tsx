import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { useInfiniteTableSentinel } from "@insightflare/product-ui/tables";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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

  it("uses initial observer geometry for prefetch without forcing row layout", () => {
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
      },
    );
    const onReachEnd = vi.fn();
    const measure = vi.spyOn(HTMLElement.prototype, "getBoundingClientRect");
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
    try {
      act(() => root.render(createElement(Probe)));
      const [first, second] = Array.from(container.querySelectorAll("tr"));
      const entry = (target: Element, top: number, isIntersecting = false) =>
        ({
          target,
          boundingClientRect: { top, bottom: top + 40 },
          isIntersecting,
        }) as IntersectionObserverEntry;
      const deliver = (...entries: IntersectionObserverEntry[]) =>
        act(() => callback?.(entries, {} as IntersectionObserver));
      expect(measure).not.toHaveBeenCalled();
      deliver(
        entry(first!, window.innerHeight + 481),
        entry(second!, window.innerHeight + 300),
      );
      expect(onReachEnd).toHaveBeenCalledTimes(1);
      deliver(
        entry(first!, window.innerHeight + 300),
        entry(second!, window.innerHeight + 300),
      );
      expect(onReachEnd).toHaveBeenCalledTimes(1);
      deliver(entry(first!, 50, true));
      expect(onReachEnd).toHaveBeenCalledTimes(2);
      expect(measure).not.toHaveBeenCalled();
    } finally {
      measure.mockRestore();
    }
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
