import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";

import {
  observeScrollbarResize,
  OverlayScrollbar,
  SCROLLBAR_UPDATED_EVENT,
} from "../src/components/ui/overlay-scrollbar";
import { VerticalScrollMask } from "../src/components/ui/vertical-scroll-mask";

function resizeEntry(target: Element): ResizeObserverEntry {
  return {
    target,
    borderBoxSize: [],
    contentBoxSize: [],
    devicePixelContentBoxSize: [],
    contentRect: target.getBoundingClientRect(),
  };
}

const mocks = vi.hoisted(() => {
  const instance = {
    on: vi.fn(),
    off: vi.fn(),
    destroy: vi.fn(),
    update: vi.fn(),
    state: vi.fn(() => ({ overflowAmount: { x: 200, y: 200 } })),
  };
  return { instance, initialize: vi.fn(), getInstance: vi.fn(() => instance) };
});
vi.mock("overlayscrollbars", () => ({
  OverlayScrollbars: { valid: () => true },
}));
vi.mock("overlayscrollbars-react", () => ({
  useOverlayScrollbars: () => [mocks.initialize, mocks.getInstance],
}));

it.each(["success", "invalid", "throws", "native"] as const)(
  "keeps scrolling available without a native track before enhancement (%s)",
  (scenario) => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    mocks.initialize.mockClear();
    mocks.instance.destroy.mockClear();
    if (scenario === "invalid")
      mocks.getInstance.mockReturnValueOnce(null as never);
    if (scenario === "throws")
      mocks.initialize.mockImplementationOnce(() => {
        throw new Error("initialization failed");
      });
    document.documentElement.dataset.scrollbarMode =
      scenario === "native" ? "native" : "overlay";
    const frames: FrameRequestCallback[] = [];
    const idle = vi.fn();
    const tasks: Array<() => void> = [];
    const resize: Array<() => void> = [];
    const disconnect = vi.fn();
    vi.stubGlobal("requestAnimationFrame", (fn: FrameRequestCallback) =>
      frames.push(fn),
    );
    vi.stubGlobal("requestIdleCallback", idle);
    const nativeSetTimeout = window.setTimeout.bind(window);
    vi.spyOn(window, "setTimeout").mockImplementation((fn, delay, ...args) => {
      if (delay === 0 && typeof fn === "function") {
        tasks.push(() => fn(...args));
        return 1;
      }
      return nativeSetTimeout(fn, delay, ...args);
    });
    vi.stubGlobal(
      "ResizeObserver",
      class {
        constructor(fn: () => void) {
          resize.push(fn);
        }
        observe() {}
        unobserve() {}
        disconnect() {
          disconnect();
        }
      },
    );
    function flushEnhancement() {
      act(() => {
        frames.shift()?.(0);
        tasks.shift()?.();
      });
    }
    try {
      act(() =>
        root.render(
          <OverlayScrollbar axis="vertical">Content</OverlayScrollbar>,
        ),
      );
      const viewport = container.querySelector<HTMLDivElement>(
        ".os-scrollbar-viewport",
      )!;
      Object.defineProperties(viewport, {
        clientHeight: { configurable: true, value: 100 },
        scrollHeight: { configurable: true, value: 100 },
      });
      expect(viewport.hasAttribute("data-scrollbar-fallback")).toBe(false);
      expect(mocks.initialize).not.toHaveBeenCalled();
      flushEnhancement();
      expect(mocks.initialize).not.toHaveBeenCalled();
      Object.defineProperty(viewport, "scrollHeight", {
        configurable: true,
        value: 200,
      });
      const updated = vi.fn();
      viewport.addEventListener(SCROLLBAR_UPDATED_EVENT, updated);
      viewport.dispatchEvent(new Event("scroll"));
      expect(mocks.initialize).not.toHaveBeenCalled();
      flushEnhancement();
      expect(idle).not.toHaveBeenCalled();
      if (scenario === "native") {
        expect(mocks.initialize).not.toHaveBeenCalled();
        expect(updated).not.toHaveBeenCalled();
      } else {
        expect(mocks.initialize).toHaveBeenCalledTimes(1);
        expect(updated).toHaveBeenCalledTimes(1);
        expect(disconnect).toHaveBeenCalled();
      }
      expect(viewport.hasAttribute("data-scrollbar-fallback")).toBe(
        scenario === "invalid" || scenario === "throws",
      );
      viewport.dispatchEvent(new Event("scroll"));
      flushEnhancement();
      expect(mocks.initialize).toHaveBeenCalledTimes(
        scenario === "native" ? 0 : 1,
      );
    } finally {
      act(() => root.unmount());
      container.remove();
      delete document.documentElement.dataset.scrollbarMode;
      vi.restoreAllMocks();
      vi.unstubAllGlobals();
    }
    expect(mocks.instance.destroy).toHaveBeenCalledTimes(
      scenario === "success" ? 1 : 0,
    );
  },
);

it.each(["horizontal", "vertical", "native"] as const)(
  "coalesces mask measurements and preserves edge visibility (%s)",
  (scenario) => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    document.documentElement.dataset.scrollbarMode =
      scenario === "native" ? "native" : "overlay";
    const frames = new Map<number, FrameRequestCallback>();
    let frameId = 0;
    const tasks: Array<() => void> = [];
    const resize: Array<(entries: ResizeObserverEntry[]) => void> = [];
    vi.stubGlobal("requestAnimationFrame", (fn: FrameRequestCallback) => {
      frames.set(++frameId, fn);
      return frameId;
    });
    vi.stubGlobal("cancelAnimationFrame", (id: number) => frames.delete(id));
    const nativeSetTimeout = window.setTimeout.bind(window);
    vi.spyOn(window, "setTimeout").mockImplementation((fn, delay, ...args) => {
      if (delay === 0 && typeof fn === "function") {
        tasks.push(() => fn(...args));
        return 1;
      }
      return nativeSetTimeout(fn, delay, ...args);
    });
    vi.stubGlobal(
      "ResizeObserver",
      class {
        constructor(fn: (entries: ResizeObserverEntry[]) => void) {
          resize.push(fn);
        }
        observe() {}
        unobserve() {}
        disconnect() {}
      },
    );
    const flush = () =>
      act(() => {
        const current = [...frames.values()];
        frames.clear();
        current.forEach((fn) => fn(0));
        tasks.splice(0).forEach((fn) => fn());
      });
    try {
      mocks.instance.state.mockClear();
      act(() =>
        root.render(
          scenario === "vertical" ? (
            <VerticalScrollMask>Content</VerticalScrollMask>
          ) : (
            <OverlayScrollbar axis="horizontal" showEdgeMasks>
              Content
            </OverlayScrollbar>
          ),
        ),
      );
      const viewport = container.querySelector<HTMLDivElement>(
        ".os-scrollbar-viewport",
      )!;
      const width = vi.fn(() => 300);
      const height = vi.fn(() => 300);
      Object.defineProperties(viewport, {
        clientWidth: { configurable: true, value: 100 },
        clientHeight: { configurable: true, value: 100 },
        scrollWidth: { configurable: true, get: width },
        scrollHeight: { configurable: true, get: height },
      });
      flush();
      flush();
      flush();
      const masks = [
        ...container.querySelectorAll('[aria-hidden="true"]'),
      ].filter((e) => e.classList.contains("pointer-events-none"));
      expect(masks).toHaveLength(2);
      expect(masks[0]?.classList.contains("opacity-0")).toBe(true);
      expect(masks[1]?.classList.contains("opacity-100")).toBe(true);
      width.mockClear();
      height.mockClear();
      mocks.instance.state.mockClear();
      act(() => {
        viewport.scrollLeft = 200;
        viewport.scrollTop = 200;
        viewport.dispatchEvent(new Event("scroll"));
        viewport.dispatchEvent(new Event(SCROLLBAR_UPDATED_EVENT));
        resize.forEach((fn) => fn([resizeEntry(viewport)]));
        viewport.dispatchEvent(new Event("scroll"));
      });
      expect(frames.size).toBe(1);
      flush();
      expect(masks[0]?.classList.contains("opacity-100")).toBe(true);
      expect(masks[1]?.classList.contains("opacity-0")).toBe(true);
      expect(viewport.scrollLeft).toBe(200);
      expect(viewport.scrollTop).toBe(200);
      expect(height).not.toHaveBeenCalled();
      if (scenario === "native") {
        expect(width).toHaveBeenCalledTimes(1);
        expect(mocks.instance.state).not.toHaveBeenCalled();
      } else {
        expect(width).not.toHaveBeenCalled();
        expect(mocks.instance.state).toHaveBeenCalledTimes(1);
      }
    } finally {
      act(() => root.unmount());
      container.remove();
      delete document.documentElement.dataset.scrollbarMode;
      vi.restoreAllMocks();
      vi.unstubAllGlobals();
    }
  },
);

it("shares viewport/content observation while preserving independent subscribers and cleanup", () => {
  const viewport = document.createElement("div");
  const content = document.createElement("div");
  const other = document.createElement("div");
  const observe = vi.fn();
  const unobserve = vi.fn();
  const disconnect = vi.fn();
  let deliver!: (entries: ResizeObserverEntry[]) => void;
  const create = vi.fn();
  vi.stubGlobal(
    "ResizeObserver",
    class {
      constructor(fn: typeof deliver) {
        create();
        deliver = fn;
      }
      observe = observe;
      unobserve = unobserve;
      disconnect = disconnect;
    },
  );
  const init = vi.fn();
  const mask = vi.fn();
  const next = vi.fn();
  const stopInit = observeScrollbarResize(viewport, content, init);
  const stopMask = observeScrollbarResize(viewport, content, mask);
  const stopNext = observeScrollbarResize(other, null, next);
  try {
    expect(create).toHaveBeenCalledTimes(1);
    expect(observe.mock.calls).toEqual([[viewport], [content], [other]]);
    deliver([viewport, content, other].map((target) => resizeEntry(target)));
    expect(init).toHaveBeenCalledTimes(1);
    expect(mask).toHaveBeenCalledTimes(1);
    expect(next).toHaveBeenCalledTimes(1);
    stopInit();
    expect(unobserve).not.toHaveBeenCalled();
    deliver([viewport, content].map((target) => resizeEntry(target)));
    expect(init).toHaveBeenCalledTimes(1);
    expect(mask).toHaveBeenCalledTimes(2);
    stopMask();
    expect(unobserve.mock.calls).toEqual([[viewport], [content]]);
    expect(disconnect).not.toHaveBeenCalled();
  } finally {
    stopInit();
    stopMask();
    stopNext();
    vi.unstubAllGlobals();
  }
  expect(unobserve.mock.calls).toEqual([[viewport], [content], [other]]);
  expect(disconnect).toHaveBeenCalledTimes(1);
});
