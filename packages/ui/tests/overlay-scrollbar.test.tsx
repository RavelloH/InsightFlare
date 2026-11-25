import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";

import {
  OverlayScrollbar,
  SCROLLBAR_UPDATED_EVENT,
} from "../src/components/ui/overlay-scrollbar";

const mocks = vi.hoisted(() => {
  const instance = {
    on: vi.fn(),
    off: vi.fn(),
    destroy: vi.fn(),
    update: vi.fn(),
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
