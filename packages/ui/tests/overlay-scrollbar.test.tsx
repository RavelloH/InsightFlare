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

it("keeps native overflow during hydration and enhances only when needed", () => {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  document.documentElement.dataset.scrollbarMode = "overlay";
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
      root.render(<OverlayScrollbar axis="vertical">Content</OverlayScrollbar>),
    );
    const viewport = container.querySelector<HTMLDivElement>(
      ".os-scrollbar-viewport",
    )!;
    Object.defineProperties(viewport, {
      clientHeight: { configurable: true, value: 100 },
      scrollHeight: { configurable: true, value: 100 },
    });
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
    expect(mocks.initialize).toHaveBeenCalledTimes(1);
    expect(updated).toHaveBeenCalledTimes(1);
    expect(disconnect).toHaveBeenCalled();
  } finally {
    act(() => root.unmount());
    container.remove();
    delete document.documentElement.dataset.scrollbarMode;
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  }
  expect(mocks.instance.destroy).toHaveBeenCalledTimes(1);
});
